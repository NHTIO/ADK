/**
 * Ingest-depth step extensions: the unified `extract.text` format dispatch (PDF text layer,
 * DOCX via mammoth, XLSX via ExcelJS, ODT/ODS via ODF XML, PPTX via slide XML, images via the
 * OCR engine) and format-aware `extract.metadata`.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Ported from the source server's
 * four extractors, collapsed into one verb that routes on the resolved media's format family
 * (the single biggest order-out-of-chaos win — the model says `extract text` and doesn't care
 * what the container is). OCR runs through the configured `ocr` engine when the input is an
 * image, or when a PDF has no text layer with `ocr=auto`, or always with `ocr=force`.
 */

import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { MIME, familyOf } from '../formats'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { isTextual } from '@nhtio/adk/lib/mime/is_textual'
import { decodeText } from '@nhtio/adk/lib/text/decode_text'
import type { default as JSZipNS } from 'jszip'
import type { default as ExcelJSNS } from 'exceljs'
import type { StepImpl, StepContext } from '../runtime'

type JSZipModule = typeof JSZipNS

let zipPromise: Promise<JSZipModule> | undefined
const jszip = (): Promise<JSZipModule> => {
  zipPromise ??= import('jszip').then((m) => ('default' in m ? m.default : m) as JSZipModule)
  return zipPromise
}

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

const VERB = 'extract text'

// ── per-format extraction ────────────────────────────────────────────────────

const extractPdfText = async (ctx: StepContext): Promise<string> => {
  const { PDFParse } = await import('pdf-parse')
  try {
    const parser = new PDFParse({ data: ctx.payload.bytes })
    const result = await parser.getText()
    return result.text ?? ''
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(VERB, `could not read the PDF: ${detail}`)
    /* unreachable */ throw err
  }
}

const extractDocxText = async (ctx: StepContext): Promise<string> => {
  const mod = await import('mammoth')
  const mammoth = ('extractRawText' in mod ? mod : (mod as { default: unknown }).default) as {
    extractRawText: (input: Record<string, unknown>) => Promise<{ value: string }>
  }
  const bytes = ctx.payload.bytes
  // mammoth's Node entry expects { buffer: Buffer }; its browser entry expects { arrayBuffer }.
  const input =
    typeof globalThis.Buffer !== 'undefined'
      ? { buffer: globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
      : {
          arrayBuffer: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer,
        }
  const result = await mammoth.extractRawText(input)
  return result.value
}

const extractXlsxText = async (ctx: StepContext): Promise<string> => {
  const mod = await import('exceljs')
  const ExcelJS = ('default' in mod ? mod.default : mod) as typeof ExcelJSNS
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(
    ctx.payload.bytes.buffer.slice(
      ctx.payload.bytes.byteOffset,
      ctx.payload.bytes.byteOffset + ctx.payload.bytes.byteLength
    ) as ArrayBuffer
  )
  const lines: string[] = []
  for (const ws of wb.worksheets) {
    lines.push(`# ${ws.name}`)
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: false }, (cell) => {
        cells.push(String(cell.value ?? ''))
      })
      lines.push(cells.join('\t'))
    })
  }
  return lines.join('\n')
}

/** ODF content.xml → visible text (ported transformation order). */
const extractOdfXmlText = (xml: string): string =>
  xml
    .replace(/<\/text:p>/g, '\n')
    .replace(/<\/text:h>/g, '\n')
    .replace(/<\/table:table-row>/g, '\n')
    .replace(/<text:tab[^>]*\/>/g, '\t')
    .replace(/<text:line-break[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const extractOdfText = async (ctx: StepContext): Promise<string> => {
  const JSZip = await jszip()
  const zip = await JSZip.loadAsync(ctx.payload.bytes)
  const content = zip.file('content.xml')
  if (!content) fail(VERB, 'the ODF archive is missing content.xml (corrupt file?)')
  return extractOdfXmlText(await content!.async('text'))
}

const extractPptxText = async (ctx: StepContext): Promise<string> => {
  const JSZip = await jszip()
  const zip = await JSZip.loadAsync(ctx.payload.bytes)
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)?.[1] ?? 0)
      const nb = Number(b.match(/slide(\d+)/)?.[1] ?? 0)
      return na - nb
    })
  if (slideNames.length === 0) fail(VERB, 'the presentation has no slides')
  const parts: string[] = []
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('text')
    const texts = (xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((t) =>
      t
        .replace(/<[^>]+>/g, '')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
    )
    parts.push(texts.join('\n'))
  }
  return parts.join('\n\n')
}

const runOcr = async (ctx: StepContext): Promise<string> => {
  const out = (argOf<string>(ctx.step, 'ocr_out') ?? 'txt') as 'txt' | 'hocr' | 'json'
  if (!ctx.engines.hasConvert(ctx.payload.mimeType, out)) {
    fail(
      VERB,
      `this input requires OCR, and no engine that converts ${ctx.payload.mimeType} to "${out}" is configured. Do not retry this verb on this media in this deployment.`
    )
  }
  const langArg = ctx.step.args.lang as string[] | string | undefined
  const languages = langArg === undefined ? undefined : Array.isArray(langArg) ? langArg : [langArg]
  const result = await ctx.engines.convert({
    bytes: ctx.payload.bytes,
    mimeType: ctx.payload.mimeType,
    filename: ctx.payload.filename,
    to: out,
    options: { languages },
    signal: ctx.signal,
  })
  const output = result.outputs[0]
  if (!output) fail(VERB, 'OCR produced no output')
  return new TextDecoder().decode(output!.bytes)
}

// ── the unified step ─────────────────────────────────────────────────────────

/**
 * `extract.text` — full format dispatch. Routes by MIME, with OCR engine fallback for images
 * and force-OCR for any input via `ocr=force`.
 */
export const extractTextDeepStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  const ocrMode = argOf<string>(ctx.step, 'ocr') ?? 'auto'

  const asData = (text: string): { kind: 'data'; data: string; asText: string } => ({
    kind: 'data',
    data: text,
    asText: text,
  })

  if (isTextual(mime) && ocrMode !== 'force') return asData(decodeText(ctx.payload.bytes))

  if (mime.startsWith('image/')) return asData(await runOcr(ctx))

  if (ocrMode === 'force') return asData(await runOcr(ctx))

  if (mime === MIME.PDF) {
    const text = await extractPdfText(ctx)
    if (text.trim().length === 0 && ocrMode === 'auto') {
      // Scanned PDF: no text layer. OCR-from-PDF is engine territory (the engine must accept
      // application/pdf); surface the actionable path instead of silently returning nothing.
      if (!ctx.engines.hasConvert(mime, 'txt')) {
        fail(
          VERB,
          'this PDF has no text layer (scanned?). An engine that converts application/pdf to text (OCR) is required to read it, and none is configured. Do not retry this verb on this media in this deployment.'
        )
      }
      return asData(await runOcr(ctx))
    }
    return asData(text)
  }
  if (mime === MIME.DOCX || mime === MIME.DOC) return asData(await extractDocxText(ctx))
  if (mime === MIME.XLSX) return asData(await extractXlsxText(ctx))
  if (mime === MIME.ODT || mime === MIME.ODS || mime === MIME.ODP) {
    return asData(await extractOdfText(ctx))
  }
  if (mime === MIME.PPTX) return asData(await extractPptxText(ctx))
  fail(
    VERB,
    `text extraction for ${mime} is not supported in this build. For PPT/legacy formats: convert to=pptx | extract text (requires a convert engine).`
  )
  /* unreachable */ throw new Error('unreachable')
}

/** `extract.metadata` — format-aware metadata (page counts, sheet/slide inventories). */
export const extractMetadataDeepStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  const meta: Record<string, unknown> = {
    filename: ctx.payload.filename,
    mime_type: ctx.payload.mimeType,
    size_bytes: ctx.payload.bytes.byteLength,
    family: familyOf(ctx.payload.mimeType),
  }
  try {
    if (mime === MIME.PDF) {
      const { PDFDocument } = await import('pdf-lib')
      const doc = await PDFDocument.load(ctx.payload.bytes, { ignoreEncryption: true })
      meta.page_count = doc.getPageCount()
      meta.title = doc.getTitle() ?? undefined
      meta.author = doc.getAuthor() ?? undefined
    } else if (mime === MIME.XLSX) {
      const mod = await import('exceljs')
      const ExcelJS = ('default' in mod ? mod.default : mod) as typeof ExcelJSNS
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(
        ctx.payload.bytes.buffer.slice(
          ctx.payload.bytes.byteOffset,
          ctx.payload.bytes.byteOffset + ctx.payload.bytes.byteLength
        ) as ArrayBuffer
      )
      meta.sheets = wb.worksheets.map((ws) => ({ name: ws.name, rows: ws.rowCount }))
    } else if (mime === MIME.PPTX) {
      const JSZip = await jszip()
      const zip = await JSZip.loadAsync(ctx.payload.bytes)
      meta.slide_count = Object.keys(zip.files).filter((n) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(n)
      ).length
    }
  } catch {
    // Metadata enrichment is best-effort; the basics above always report.
  }
  return { kind: 'data', data: meta, asText: JSON.stringify(meta) }
}

/** The ingest step registry fragment (overrides the Phase 0 native-text-only versions). */
export const INGEST_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['extract.text', extractTextDeepStep],
  ['extract.metadata', extractMetadataDeepStep],
]
