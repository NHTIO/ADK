/**
 * Doc-domain step extensions: format-preserving text mutation for DOCX/PPTX/ODF, PDF visual
 * redaction, asset extraction from OOXML/ODF archives and PDFs, and format conversion via the
 * convert engine.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Ported from the source server's
 * doc adapters; the format-dispatch contract follows the server's green e2e suite: DOCX and
 * PPTX redact/sanitize/normalize/update_text mutate text in place inside the container
 * (preserving the source format); ODT/ODS/ODP redact/update_text mutate `content.xml` the
 * same way; text-like inputs mutate as text. PDF redact is VISUAL (pdf-lib draw-over +
 * metadata strip — content streams keep the text); the result carries that warning verbatim
 * because it is a trust boundary, not a footnote.
 */

import { MIME } from '../formats'
import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { redactStep as textRedactStep, updateTextStep as textUpdateTextStep } from './text'
import type { default as JSZipNS } from 'jszip'
import type { RegExpRef, MediaArgScalar } from '../plan'
import type { StepImpl, StepContext, StepResult, StepPayload } from '../runtime'

type JSZipModule = typeof JSZipNS

let zipPromise: Promise<JSZipModule> | undefined
const jszip = (): Promise<JSZipModule> => {
  zipPromise ??= import('jszip').then((m) => ('default' in m ? m.default : m) as JSZipModule)
  return zipPromise
}

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const unescapeXml = (value: string): string =>
  value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')

// ── OOXML text mutation (ported run-aggregation semantics) ───────────────────

/**
 * Replace matches inside text nodes of OOXML, aggregating runs per paragraph so patterns
 * spanning split runs still match (Word splits text across `w:t` runs on formatting changes).
 */
const replaceInOoxml = (
  xml: string,
  paragraphTag: 'w:p' | 'a:p',
  textTag: 'w:t' | 'a:t',
  pattern: RegExp,
  replacement: string
): { xml: string; matchCount: number } => {
  let totalMatches = 0
  const pRegex = new RegExp(`<${paragraphTag}\\b[^>]*>[\\s\\S]*?</${paragraphTag}>`, 'g')
  const result = xml.replace(pRegex, (pXml) => {
    const tElements: Array<{ start: number; end: number; content: string }> = []
    const tRegex = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>`, 'g')
    let tMatch: RegExpExecArray | null
    while ((tMatch = tRegex.exec(pXml))) {
      tElements.push({
        start: tMatch.index,
        end: tMatch.index + tMatch[0].length,
        content: unescapeXml(tMatch[1]),
      })
    }
    if (tElements.length === 0) return pXml
    const aggregated = tElements.map((t) => t.content).join('')
    const p = new RegExp(pattern.source, pattern.flags)
    const replaced = aggregated.replace(p, replacement)
    if (replaced === aggregated) return pXml
    const counter = new RegExp(pattern.source, pattern.flags)
    while (counter.exec(aggregated)) {
      totalMatches += 1
      if (!counter.global) break
    }
    let out = pXml
    for (let i = tElements.length - 1; i >= 0; i--) {
      const el = tElements[i]
      const space = textTag === 'w:t' && i === 0 ? ' xml:space="preserve"' : ''
      const content = i === 0 ? escapeXml(replaced) : ''
      out =
        out.slice(0, el.start) + `<${textTag}${space}>${content}</${textTag}>` + out.slice(el.end)
    }
    return out
  })
  return { xml: result, matchCount: totalMatches }
}

/** Map text-node mutation over every relevant part of a DOCX or PPTX archive. */
const mutateOoxmlText = async (
  ctx: StepContext,
  verb: string,
  mutateXml: (xml: string, kind: 'docx' | 'pptx') => string
): Promise<StepResult> => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  const kind = mime === MIME.DOCX ? 'docx' : 'pptx'
  const JSZip = await jszip()
  let zip: JSZipNS
  try {
    zip = await JSZip.loadAsync(ctx.payload.bytes)
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(verb, `could not open the document container: ${detail}`)
    /* unreachable */ throw err
  }
  const parts =
    kind === 'docx'
      ? Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
      : Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  if (parts.length === 0) fail(verb, 'the container has no text parts to mutate (corrupt file?)')
  for (const part of parts) {
    const xml = await zip.file(part)!.async('text')
    const next = mutateXml(xml, kind)
    if (next !== xml) zip.file(part, next)
  }
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { kind: 'media', payload: { ...ctx.payload, bytes } }
}

const toGlobalRegex = (value: MediaArgScalar): RegExp => {
  if (typeof value === 'string') {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped, 'g')
  }
  const ref = value as RegExpRef
  return new RegExp(ref.source, ref.flags.includes('g') ? ref.flags : `${ref.flags}g`)
}

// ── ODF (content.xml) text mutation — ported from the server's odf_xml.ts ───

const ODF_MIMES: ReadonlySet<string> = new Set([MIME.ODT, MIME.ODS, MIME.ODP])

/**
 * Replace matches inside the text nodes of ODF `content.xml`, aggregating per paragraph so
 * patterns spanning `<text:span>` formatting splits still match.
 */
const replaceTextInContentXml = (
  xml: string,
  pattern: RegExp,
  replacement: string
): { xml: string; matchCount: number } => {
  let totalMatches = 0
  const result = xml.replace(/<text:(?:p|h)\b[^>]*>[\s\S]*?<\/text:(?:p|h)>/g, (paragraphXml) => {
    const textNodes: Array<{ content: string; start: number; end: number }> = []
    const textRegex = />([^<]+)</g
    let match: RegExpExecArray | null
    while ((match = textRegex.exec(paragraphXml))) {
      const content = unescapeXml(match[1])
      if (content.trim() === '') continue
      textNodes.push({ content, start: match.index, end: match.index + match[0].length })
    }
    if (textNodes.length === 0) return paragraphXml
    const aggregated = textNodes.map((n) => n.content).join('')
    const p = new RegExp(pattern.source, pattern.flags)
    const replaced = aggregated.replace(p, replacement)
    if (replaced === aggregated) return paragraphXml
    const counter = new RegExp(pattern.source, pattern.flags)
    while (counter.exec(aggregated)) {
      totalMatches += 1
      if (!counter.global) break
    }
    // Put all content in the first text node, empty the rest.
    let out = paragraphXml
    for (let i = textNodes.length - 1; i >= 0; i--) {
      const node = textNodes[i]
      const newContent = i === 0 ? escapeXml(replaced) : ''
      out = out.slice(0, node.start) + `>${newContent}<` + out.slice(node.end)
    }
    return out
  })
  return { xml: result, matchCount: totalMatches }
}

/** Map a `content.xml` mutation over an ODF container (ODT/ODS/ODP). */
const mutateOdfText = async (
  ctx: StepContext,
  verb: string,
  mutateXml: (xml: string) => string
): Promise<StepResult> => {
  const JSZip = await jszip()
  let zip: JSZipNS
  try {
    zip = await JSZip.loadAsync(ctx.payload.bytes)
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(verb, `could not open the document container: ${detail}`)
    /* unreachable */ throw err
  }
  const part = zip.file('content.xml')
  if (!part) fail(verb, 'the ODF container has no content.xml (corrupt file?)')
  const xml = await part!.async('text')
  const next = mutateXml(xml)
  if (next !== xml) zip.file('content.xml', next)
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return { kind: 'media', payload: { ...ctx.payload, bytes } }
}

// ── PDF visual redaction — ported from the server's pdf_mutation.ts ─────────

/**
 * The honest caveat every PDF redaction result must carry. Visual redaction draws over
 * matched pages and strips metadata; the content streams still contain the original text.
 */
export const PDF_REDACTION_WARNING =
  'PDF redaction applies visual annotations. Content streams are not modified. For full content-level redaction, convert to text first.'

/** Visual page-level redaction: draw-over banner on matching pages + metadata strip. */
const redactPdf = async (
  ctx: StepContext,
  verb: string,
  patterns: RegExp[]
): Promise<StepResult> => {
  const { PDFDocument, PDFName, PDFString, rgb, StandardFonts } = await import('pdf-lib')
  let doc: Awaited<ReturnType<typeof PDFDocument.load>>
  try {
    doc = await PDFDocument.load(ctx.payload.bytes, { ignoreEncryption: true })
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(verb, `could not parse the PDF: ${detail}`)
    /* unreachable */ throw err
  }

  // Per-page text via the same extractor the ingest steps use.
  let pageTexts: string[] = []
  try {
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: ctx.payload.bytes })
    const result = await parser.getText()
    pageTexts = result.pages.map((p: { text?: string }) => p.text ?? '')
  } catch {
    pageTexts = []
  }

  const pages = doc.getPages()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  let pagesRedacted = 0
  for (const [i, page] of pages.entries()) {
    const pageText = pageTexts[i] ?? ''
    const hasMatch = patterns.some((pattern) =>
      new RegExp(pattern.source, pattern.flags).test(pageText)
    )
    if (!hasMatch) continue
    const { width } = page.getSize()
    page.drawRectangle({ x: 0, y: 0, width, height: 14, color: rgb(1, 1, 0.9) })
    page.drawText(`[Page ${i + 1}: content redacted]`, {
      x: 4,
      y: 2,
      size: 8,
      font,
      color: rgb(0.5, 0, 0),
    })
    pagesRedacted += 1
  }

  // Metadata strip (sanitizePdfMetadata, ported): blank the Info fields + drop XMP.
  const metadataFields = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']
  for (const field of metadataFields) {
    try {
      const infoDict = doc.context.lookup(doc.context.trailerInfo.Info) as
        | { get?: (n: unknown) => unknown; set?: (n: unknown, v: unknown) => void }
        | undefined
      if (infoDict && typeof infoDict.get === 'function' && typeof infoDict.set === 'function') {
        if (infoDict.get(PDFName.of(field))) infoDict.set(PDFName.of(field), PDFString.of(''))
      }
    } catch {
      // Field doesn't exist or can't be modified — skip.
    }
  }
  try {
    const catalog = doc.context.lookup(doc.context.trailerInfo.Root) as
      | { get?: (n: unknown) => unknown; delete?: (n: unknown) => void }
      | undefined
    if (catalog && typeof catalog.get === 'function' && typeof catalog.delete === 'function') {
      if (catalog.get(PDFName.of('Metadata'))) catalog.delete(PDFName.of('Metadata'))
    }
  } catch {
    // No metadata stream — skip.
  }

  if (pagesRedacted === 0) {
    fail(verb, 'no page text matched the redaction pattern(s) — nothing was redacted')
  }
  const bytes = new Uint8Array(await doc.save())
  return { kind: 'media', payload: { ...ctx.payload, bytes } }
}

// ── doc-aware step dispatch ──────────────────────────────────────────────────

/**
 * `redact` — format dispatch: text media → text path; DOCX/PPTX/ODF → in-place container
 * edit; PDF → visual redaction (draw-over + metadata strip — see {@link PDF_REDACTION_WARNING}).
 */
export const docRedactStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (mime.startsWith('text/')) return textRedactStep(ctx)
  const raw = ctx.step.args.match
  const patterns = (Array.isArray(raw) ? raw : [raw]) as MediaArgScalar[]
  const replacement = argOf<string>(ctx.step, 'replace') ?? '█'
  if (mime === MIME.DOCX || mime === MIME.PPTX) {
    return mutateOoxmlText(ctx, 'redact', (xml, kind) => {
      let out = xml
      for (const p of patterns) {
        out = replaceInOoxml(
          out,
          kind === 'docx' ? 'w:p' : 'a:p',
          kind === 'docx' ? 'w:t' : 'a:t',
          toGlobalRegex(p),
          replacement
        ).xml
      }
      return out
    })
  }
  if (ODF_MIMES.has(mime)) {
    return mutateOdfText(ctx, 'redact', (xml) => {
      let out = xml
      for (const p of patterns) {
        out = replaceTextInContentXml(out, toGlobalRegex(p), replacement).xml
      }
      return out
    })
  }
  if (mime === MIME.PDF) {
    return redactPdf(ctx, 'redact', patterns.map(toGlobalRegex))
  }
  fail(
    'redact',
    `redaction for ${mime} is not supported in this build (text, DOCX, PPTX, ODT/ODS/ODP, and PDF are).`
  )
  /* unreachable */ throw new Error('unreachable')
}

const BLOCKED_CONTROL = (code: number): boolean =>
  (code >= 0 && code <= 8) ||
  code === 11 ||
  code === 12 ||
  (code >= 14 && code <= 31) ||
  code === 127

const stripControlChars = (text: string): string => {
  let out = ''
  for (const ch of text) {
    if (BLOCKED_CONTROL(ch.charCodeAt(0))) continue
    out += ch
  }
  return out
}

const sanitizeTextNodes = (xml: string, textTag: 'w:t' | 'a:t'): string =>
  xml.replace(
    new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>`, 'g'),
    (full, content: string) => {
      const cleaned = stripControlChars(unescapeXml(content))
      if (cleaned === unescapeXml(content)) return full
      return full.replace(content, escapeXml(cleaned))
    }
  )

/** `sanitize` — strip blocked control characters from text nodes / text media. */
export const docSanitizeStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (mime.startsWith('text/')) {
    const text = new TextDecoder().decode(ctx.payload.bytes)
    const cleaned = stripControlChars(text)
    return { kind: 'media', payload: { ...ctx.payload, bytes: new TextEncoder().encode(cleaned) } }
  }
  if (mime === MIME.DOCX || mime === MIME.PPTX) {
    return mutateOoxmlText(ctx, 'sanitize', (xml, kind) =>
      sanitizeTextNodes(xml, kind === 'docx' ? 'w:t' : 'a:t')
    )
  }
  fail('sanitize', `sanitize for ${mime} is not supported in this build (text, DOCX, PPTX are)`)
  /* unreachable */ throw new Error('unreachable')
}

const normalizeText = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+$/gm, '')

/** `normalize` — CRLF→LF + trailing-whitespace removal in text nodes / text media. */
export const docNormalizeStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (mime.startsWith('text/')) {
    const text = new TextDecoder().decode(ctx.payload.bytes)
    return {
      kind: 'media',
      payload: { ...ctx.payload, bytes: new TextEncoder().encode(normalizeText(text)) },
    }
  }
  if (mime === MIME.DOCX || mime === MIME.PPTX) {
    return mutateOoxmlText(ctx, 'normalize', (xml, kind) => {
      const tag = kind === 'docx' ? 'w:t' : 'a:t'
      return xml.replace(
        new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'),
        (full, content: string) => {
          const normalized = normalizeText(unescapeXml(content))
          if (normalized === unescapeXml(content)) return full
          return full.replace(content, escapeXml(normalized))
        }
      )
    })
  }
  fail('normalize', `normalize for ${mime} is not supported in this build (text, DOCX, PPTX are)`)
  /* unreachable */ throw new Error('unreachable')
}

/** `update_text` — anchor replacement; DOCX/PPTX/ODF in-place, TARGET_NOT_FOUND when absent. */
export const docUpdateTextStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (mime.startsWith('text/')) return textUpdateTextStep(ctx)
  const anchor = argOf<string>(ctx.step, 'anchor') as string
  const replace = argOf<string>(ctx.step, 'replace') ?? ''
  const escapedAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (mime === MIME.DOCX || mime === MIME.PPTX) {
    let found = 0
    const result = await mutateOoxmlText(ctx, 'update_text', (xml, kind) => {
      if (found > 0) return xml
      const { xml: next, matchCount } = replaceInOoxml(
        xml,
        kind === 'docx' ? 'w:p' : 'a:p',
        kind === 'docx' ? 'w:t' : 'a:t',
        new RegExp(escapedAnchor),
        replace
      )
      found += matchCount
      return next
    })
    if (found === 0) {
      fail('update_text', `anchor text not found: "${anchor.slice(0, 80)}"`)
    }
    return result
  }
  if (ODF_MIMES.has(mime)) {
    let found = 0
    const result = await mutateOdfText(ctx, 'update_text', (xml) => {
      const { xml: next, matchCount } = replaceTextInContentXml(
        xml,
        new RegExp(escapedAnchor),
        replace
      )
      found += matchCount
      return next
    })
    if (found === 0) {
      fail('update_text', `anchor text not found: "${anchor.slice(0, 80)}"`)
    }
    return result
  }
  fail(
    'update_text',
    `text update for ${mime} is not supported (text, DOCX, PPTX, ODT/ODS/ODP are; PDF text is not reliably editable)`
  )
  /* unreachable */ throw new Error('unreachable')
}

// ── extract.assets ───────────────────────────────────────────────────────────

const ASSET_PATTERNS: Record<string, RegExp> = {
  image: /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|webp)$/i,
  font: /\.(ttf|otf|woff2?|odttf)$/i,
  attachment: /\.(bin|ole|docx?|xlsx?|pptx?|pdf|txt|csv)$/i,
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  emf: 'image/emf',
  wmf: 'image/wmf',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/**
 * `extract.assets` — enumerate embedded assets. OOXML/ODF archives are walked natively
 * (cross-env); PDF inputs use the pdfImages engine.
 */
export const extractAssetsStep: StepImpl = async (ctx) => {
  const verb = 'extract assets'
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  const requested = (ctx.step.args.types as string[] | undefined) ?? ['all']
  const wantAll = requested.includes('all')
  const want = (kind: string): boolean => wantAll || requested.includes(kind)

  if (mime === MIME.PDF) {
    if (!want('image')) {
      fail(verb, 'PDF asset extraction currently supports images (types=image or all)')
    }
    if (!ctx.engines.hasConvert(mime, 'images')) {
      fail(
        verb,
        'PDF asset extraction requires an engine that converts application/pdf to "images", and none is configured. Do not retry this verb on PDFs in this deployment.'
      )
    }
    const format = argOf<string>(ctx.step, 'format')
    const result = await ctx.engines.convert({
      bytes: ctx.payload.bytes,
      mimeType: mime,
      filename: ctx.payload.filename,
      to: 'images',
      options: format ? { format } : undefined,
      signal: ctx.signal,
    })
    if (result.outputs.length === 0) fail(verb, 'no embedded images were found in the PDF')
    const wantedMime = format ? (EXT_MIME[format] ?? `image/${format}`) : undefined
    const payloads: StepPayload[] = []
    for (const [i, img] of result.outputs.entries()) {
      let bytes = img.bytes
      let mimeType = img.mimeType
      // Two-tier encoding: outputs already in the requested format pass through (native
      // collapse); the rest re-encode via an ordinary registry dispatch.
      if (wantedMime && mimeType.toLowerCase() !== wantedMime) {
        const reencoded = await ctx.engines.mutate({
          bytes,
          mimeType,
          format: { to: format! },
          signal: ctx.signal,
        })
        bytes = reencoded.bytes
        mimeType = reencoded.mimeType
      }
      payloads.push({
        bytes,
        mimeType,
        filename: `asset-${i + 1}.${mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'}`,
      })
    }
    return { kind: 'media-list', payloads }
  }

  // Archive formats: OOXML + ODF are zip containers.
  const isArchive = [MIME.DOCX, MIME.XLSX, MIME.PPTX, MIME.ODT, MIME.ODS, MIME.ODP].includes(
    mime as never
  )
  if (!isArchive) {
    fail(verb, `asset extraction for ${mime} is not supported (OOXML/ODF archives and PDF are)`)
  }
  const JSZip = await jszip()
  const zip = await JSZip.loadAsync(ctx.payload.bytes)
  const payloads: StepPayload[] = []
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const basename = name.split('/').pop() ?? name
    const matchKind = Object.entries(ASSET_PATTERNS).find(([, re]) => re.test(basename))?.[0]
    if (!matchKind || !want(matchKind)) continue
    // Only media/embeddings/fonts directories carry real assets in these containers.
    if (!/(^|\/)(media|embeddings|fonts|Pictures|ObjectReplacements)\//i.test(name)) continue
    const ext = basename.split('.').pop()?.toLowerCase() ?? 'bin'
    payloads.push({
      bytes: await entry.async('uint8array'),
      mimeType: EXT_MIME[ext] ?? 'application/octet-stream',
      filename: basename,
    })
  }
  if (payloads.length === 0) fail(verb, 'no embedded assets matched the requested types')
  return { kind: 'media-list', payloads }
}

// ── convert ──────────────────────────────────────────────────────────────────

/** `convert` — dispatch through the engine registry (direct edge or computed path). */
export const convertStep: StepImpl = async (ctx) => {
  const verb = 'convert'
  const to = argOf<string>(ctx.step, 'to') as string
  const supported = ctx.engines.convertTargets(ctx.payload.mimeType)
  if (!supported.includes(to)) {
    fail(
      verb,
      `no configured engine (or computed path) can produce "${to}" from ${ctx.payload.mimeType}; reachable targets: ${supported.join(', ') || '(none)'}`
    )
  }
  const result = await ctx.engines.convert({
    bytes: ctx.payload.bytes,
    mimeType: ctx.payload.mimeType,
    filename: ctx.payload.filename,
    to,
    signal: ctx.signal,
  })
  const output = result.outputs[0]
  if (!output) fail(verb, 'the conversion produced no output')
  const dot = ctx.payload.filename.lastIndexOf('.')
  const base = dot > 0 ? ctx.payload.filename.slice(0, dot) : ctx.payload.filename
  return {
    kind: 'media',
    payload: { bytes: output!.bytes, mimeType: output!.mimeType, filename: `${base}.${to}` },
  }
}

/** The doc step registry fragment (overrides the Phase 0 text-only redact/update_text). */
export const DOC_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['redact', docRedactStep],
  ['sanitize', docSanitizeStep],
  ['normalize', docNormalizeStep],
  ['update_text', docUpdateTextStep],
  ['extract.assets', extractAssetsStep],
  ['convert', convertStep],
]
