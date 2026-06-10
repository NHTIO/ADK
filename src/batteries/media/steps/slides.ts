/**
 * `slides.*` step implementations: native PPTX container mutation via JSZip + targeted XML
 * edits, on in-memory bytes.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Ported from the source server's
 * slides adapters (regex-over-zip XML surgery — no XML parser dependency). PPTX is mutated
 * natively; ODP inputs are normalized to PPTX through the configured `convert` engine first,
 * degrading to a readable failure when none is configured. All implementations are
 * cross-environment (jszip operates on Uint8Array).
 */

import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { MIME, replaceExtension, unsupportedForMutationReason } from '../formats'
import type { default as JSZipNS } from 'jszip'
import type { MediaRef, MediaArgJson } from '../plan'
import type { StepImpl, StepContext, StepPayload } from '../runtime'

type JSZipModule = typeof JSZipNS

let zipPromise: Promise<JSZipModule> | undefined
const jszip = (): Promise<JSZipModule> => {
  zipPromise ??= import('jszip').then((m) => ('default' in m ? m.default : m) as JSZipModule)
  return zipPromise
}

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

// ── XML helpers (ported verbatim semantics) ──────────────────────────────────

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Pure posix-style path resolution for zip entries (no node:path). */
const resolveZipPath = (basePart: string, relTarget: string): string => {
  const baseDir = basePart.split('/').slice(0, -1)
  const parts = [...baseDir, ...relTarget.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

interface SlideEntry {
  rid: string
  slideId: number
  sldIdTag: string
  target: string
  title?: string
}

interface ParsedPresentation {
  presentationXml: string
  relsXml: string
  entries: SlideEntry[]
}

const readZipText = async (verb: string, zip: JSZipNS, path: string): Promise<string> => {
  const file = zip.file(path)
  if (!file) fail(verb, `the presentation is missing an expected part: ${path}`)
  return file!.async('text')
}

const parseRelationshipTarget = (relsXml: string, relId: string): string | null => {
  const re = new RegExp(
    `<Relationship\\b[^>]*Id="${escapeRegex(relId)}"[^>]*Target="([^"]+)"[^>]*>`,
    'i'
  )
  return relsXml.match(re)?.[1] ?? null
}

const parsePresentation = async (verb: string, zip: JSZipNS): Promise<ParsedPresentation> => {
  const presentationXml = await readZipText(verb, zip, 'ppt/presentation.xml')
  const relsXml = await readZipText(verb, zip, 'ppt/_rels/presentation.xml.rels')
  const sldIdListMatch = presentationXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)
  if (!sldIdListMatch) fail(verb, 'the presentation has no slide list (corrupt PPTX?)')
  const sldIdTags = sldIdListMatch![1].match(/<p:sldId\b[^>]*\/>/g) ?? []
  const entries: SlideEntry[] = []
  for (const tag of sldIdTags) {
    const rid = tag.match(/r:id="([^"]+)"/)?.[1]
    const idText = tag.match(/\bid="(\d+)"/)?.[1]
    if (!rid || !idText) continue
    const target = parseRelationshipTarget(relsXml, rid)
    if (!target) continue
    const slidePath = resolveZipPath('ppt/presentation.xml', target)
    let title: string | undefined
    const slideFile = zip.file(slidePath)
    if (slideFile) {
      const slideXml = await slideFile.async('text')
      title = slideXml.match(/<p:cSld\b[^>]*\bname="([^"]*)"/)?.[1]
    }
    entries.push({ rid, slideId: Number(idText), sldIdTag: tag, target, title })
  }
  return { presentationXml, relsXml, entries }
}

const replaceSlideIdList = (presentationXml: string, tags: string[]): string =>
  presentationXml.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${tags.join('')}</p:sldIdLst>`
  )

/** Resolve a slide by the frozen `slide=` rule: digits = 1-based index, otherwise title. */
const resolveSlide = (
  verb: string,
  entries: SlideEntry[],
  slideArg: string | number | undefined
): SlideEntry => {
  if (slideArg === undefined) {
    const first = entries[0]
    if (!first) fail(verb, 'the presentation has no slides')
    return first
  }
  // Frozen 0.11: bare number targets by 1-based index; quoted string targets by title.
  if (typeof slideArg === 'number') {
    const found = entries[slideArg - 1]
    if (!found) {
      fail(verb, `slide index ${slideArg} is out of range (1-based; ${entries.length} slides)`)
    }
    return found!
  }
  const byTitle = entries.find((e) => e.title === slideArg)
  if (!byTitle) fail(verb, `no slide titled "${slideArg}"`)
  return byTitle!
}

const getMaxRidNumber = (relsXml: string): number => {
  let max = 0
  for (const match of relsXml.matchAll(/\bId="rId(\d+)"/g)) max = Math.max(max, Number(match[1]))
  return max
}

const getMaxSlideNumber = (zip: JSZipNS): number => {
  let max = 0
  for (const name of Object.keys(zip.files)) {
    const match = name.match(/^ppt\/slides\/slide(\d+)\.xml$/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

const getMaxSlideId = (entries: SlideEntry[]): number =>
  entries.reduce((max, e) => Math.max(max, e.slideId), 255)

const ensureSlideContentType = (contentTypesXml: string, slideNumber: number): string => {
  const partName = `/ppt/slides/slide${slideNumber}.xml`
  if (contentTypesXml.includes(`PartName="${partName}"`)) return contentTypesXml
  const override =
    `<Override PartName="${partName}" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  return contentTypesXml.replace('</Types>', `${override}</Types>`)
}

const setSlideTitle = (slideXml: string, title: string): string => {
  if (/<p:cSld\b[^>]*\bname="[^"]*"/.test(slideXml)) {
    return slideXml.replace(/(<p:cSld\b[^>]*\bname=")[^"]*(")/, `$1${escapeXml(title)}$2`)
  }
  return slideXml
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Acquire pptx bytes, converting ODP to PPTX via the engine registry. */
const acquirePptx = async (ctx: StepContext, verb: string): Promise<Uint8Array> => {
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (mime === MIME.PPTX) return ctx.payload.bytes
  if (mime === MIME.ODP) {
    if (!ctx.engines.hasConvert(mime, 'pptx')) {
      fail(
        verb,
        'this input is ODP — an engine that converts it to PPTX is required first, and none is configured. Do not retry this verb on this media in this deployment.'
      )
    }
    const result = await ctx.engines.convert({
      bytes: ctx.payload.bytes,
      mimeType: mime,
      filename: ctx.payload.filename,
      to: 'pptx',
      signal: ctx.signal,
    })
    const output = result.outputs[0]
    if (!output) fail(verb, 'normalizing the presentation to PPTX produced no output')
    return output!.bytes
  }
  const reason = unsupportedForMutationReason(mime)
  if (reason) fail(verb, reason)
  fail(verb, `slides operations expect a presentation; the media is ${mime}`)
  /* unreachable */ throw new Error('unreachable')
}

const withPresentation = async (
  ctx: StepContext,
  verb: string,
  mutate: (zip: JSZipNS, parsed: ParsedPresentation) => Promise<void>
): Promise<{ kind: 'media'; payload: StepPayload }> => {
  const bytes = await acquirePptx(ctx, verb)
  const JSZip = await jszip()
  let zip: JSZipNS
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(verb, `could not open the presentation: ${detail}`)
    /* unreachable */ throw err
  }
  const parsed = await parsePresentation(verb, zip)
  await mutate(zip, parsed)
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return {
    kind: 'media',
    payload: {
      bytes: out,
      mimeType: MIME.PPTX,
      filename: replaceExtension(ctx.payload.filename, 'pptx'),
    },
  }
}

// ── step implementations ─────────────────────────────────────────────────────

/** `slides.add` — clone the last slide as a template, optionally retitle/position it. */
export const slidesAddStep: StepImpl = async (ctx) => {
  const verb = 'slides add'
  const at = argOf<number>(ctx.step, 'at')
  const title = argOf<string>(ctx.step, 'title')
  return withPresentation(ctx, verb, async (zip, parsed) => {
    if (parsed.entries.length === 0) fail(verb, 'the presentation has no slides to clone from')
    const template = parsed.entries[parsed.entries.length - 1]
    const templatePath = resolveZipPath('ppt/presentation.xml', template.target)
    const templateXml = await readZipText(verb, zip, templatePath)
    const newSlideNumber = getMaxSlideNumber(zip) + 1
    const newSlidePath = `ppt/slides/slide${newSlideNumber}.xml`
    zip.file(newSlidePath, title ? setSlideTitle(templateXml, title) : templateXml)
    const templateNum = templatePath.match(/slide(\d+)\.xml$/)?.[1]
    const templateRels = templateNum
      ? zip.file(`ppt/slides/_rels/slide${templateNum}.xml.rels`)
      : null
    if (templateRels) {
      const relsXml = await templateRels.async('text')
      zip.file(
        `ppt/slides/_rels/slide${newSlideNumber}.xml.rels`,
        relsXml.replace(/<Relationship\b[^>]*Type="[^"]*notesSlide"[^>]*\/>/g, '')
      )
    }
    const newRid = `rId${getMaxRidNumber(parsed.relsXml) + 1}`
    const newSldTag = `<p:sldId id="${getMaxSlideId(parsed.entries) + 1}" r:id="${newRid}"/>`
    const relNode = `<Relationship Id="${newRid}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${newSlideNumber}.xml"/>`
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      parsed.relsXml.replace('</Relationships>', `${relNode}</Relationships>`)
    )
    const insertAt =
      at !== undefined
        ? Math.min(Math.max(1, at), parsed.entries.length + 1)
        : parsed.entries.length + 1
    const tags = parsed.entries.map((e) => e.sldIdTag)
    tags.splice(insertAt - 1, 0, newSldTag)
    zip.file('ppt/presentation.xml', replaceSlideIdList(parsed.presentationXml, tags))
    const contentTypes = await readZipText(verb, zip, '[Content_Types].xml')
    zip.file('[Content_Types].xml', ensureSlideContentType(contentTypes, newSlideNumber))
  })
}

/** `slides.update_text` — replace text in the first node or a named placeholder shape. */
export const slidesUpdateTextStep: StepImpl = async (ctx) => {
  const verb = 'slides update_text'
  const text = argOf<string>(ctx.step, 'text') as string
  const placeholder = argOf<string>(ctx.step, 'placeholder')
  return withPresentation(ctx, verb, async (zip, parsed) => {
    const target = resolveSlide(verb, parsed.entries, argOf<string | number>(ctx.step, 'slide'))
    const slidePath = resolveZipPath('ppt/presentation.xml', target.target)
    const slideXml = await readZipText(verb, zip, slidePath)
    let updated = slideXml
    let changed = false
    if (placeholder) {
      let placeholderFound = false
      updated = slideXml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shapeXml) => {
        if (
          !new RegExp(`<p:cNvPr\\b[^>]*\\bname="${escapeRegex(placeholder)}"[^>]*>`, 'i').test(
            shapeXml
          )
        ) {
          return shapeXml
        }
        placeholderFound = true
        return shapeXml.replace(/<a:t>[\s\S]*?<\/a:t>/, () => {
          changed = true
          return `<a:t>${escapeXml(text)}</a:t>`
        })
      })
      if (!placeholderFound)
        fail(verb, `no placeholder named "${placeholder}" on the selected slide`)
    } else {
      updated = slideXml.replace(/<a:t>[\s\S]*?<\/a:t>/, () => {
        changed = true
        return `<a:t>${escapeXml(text)}</a:t>`
      })
    }
    if (!changed) fail(verb, 'no text node found on the selected slide')
    zip.file(slidePath, updated)
  })
}

/** `slides.update_table` — set table cell text by 1-based row/col. */
export const slidesUpdateTableStep: StepImpl = async (ctx) => {
  const verb = 'slides update_table'
  const updates = ctx.step.args.updates as MediaArgJson
  if (!Array.isArray(updates) || updates.length === 0) {
    fail(verb, `updates must be a JSON array: updates='[{"row":1,"col":2,"value":"x"}]'`)
  }
  return withPresentation(ctx, verb, async (zip, parsed) => {
    const target = resolveSlide(verb, parsed.entries, argOf<string | number>(ctx.step, 'slide'))
    const slidePath = resolveZipPath('ppt/presentation.xml', target.target)
    let slideXml = await readZipText(verb, zip, slidePath)
    const tableMatch = slideXml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/)
    if (!tableMatch) fail(verb, 'no table found on the selected slide')
    let tableXml = tableMatch![0]
    const rowMatches = tableXml.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? []
    for (const raw of updates as Array<Record<string, unknown>>) {
      const row = Number(raw.row)
      const col = Number(raw.col)
      const value = String(raw.value ?? '')
      const rowIndex = row - 1
      const colIndex = col - 1
      if (rowIndex < 0 || colIndex < 0 || rowIndex >= rowMatches.length) {
        fail(verb, `table cell out of range: r${row}c${col} (1-based)`)
      }
      const rowXml = rowMatches[rowIndex]
      const cellMatches = rowXml.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) ?? []
      if (colIndex >= cellMatches.length)
        fail(verb, `table cell out of range: r${row}c${col} (1-based)`)
      const cellXml = cellMatches[colIndex]
      if (!/<a:t>/.test(cellXml)) fail(verb, `cell r${row}c${col} has no text node`)
      cellMatches[colIndex] = cellXml.replace(
        /<a:t>[\s\S]*?<\/a:t>/,
        `<a:t>${escapeXml(value)}</a:t>`
      )
      rowMatches[rowIndex] = rowXml.replace(/<a:tc\b[\s\S]*?<\/a:tc>/g, () => cellMatches.shift()!)
    }
    tableXml = tableXml.replace(/<a:tr\b[\s\S]*?<\/a:tr>/g, () => rowMatches.shift()!)
    slideXml = slideXml.replace(/<a:tbl>[\s\S]*?<\/a:tbl>/, tableXml)
    zip.file(slidePath, slideXml)
  })
}

/** `slides.update_image` — replace an image part's bytes with another media (`with=@id`). */
export const slidesUpdateImageStep: StepImpl = async (ctx) => {
  const verb = 'slides update_image'
  const ref = ctx.step.args.with as MediaRef
  const placeholder = argOf<string>(ctx.step, 'placeholder')
  if (ref.kind !== 'id') fail(verb, 'builder refs are not supported here; use an @id ref')
  const replacement = await ctx.resolveRef((ref as { kind: 'id'; id: string }).id)
  return withPresentation(ctx, verb, async (zip, parsed) => {
    const target = resolveSlide(verb, parsed.entries, argOf<string | number>(ctx.step, 'slide'))
    const slidePath = resolveZipPath('ppt/presentation.xml', target.target)
    const slideXml = await readZipText(verb, zip, slidePath)
    const slideNum = slidePath.match(/slide(\d+)\.xml$/)?.[1]
    if (!slideNum) fail(verb, 'unable to resolve the slide number (corrupt PPTX?)')
    const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`
    const relsXml = await readZipText(verb, zip, relsPath)
    let imagePartPath: string | null = null
    if (placeholder) {
      for (const picXml of slideXml.match(/<p:pic\b[\s\S]*?<\/p:pic>/g) ?? []) {
        if (
          !new RegExp(`<p:cNvPr\\b[^>]*\\bname="${escapeRegex(placeholder)}"[^>]*>`, 'i').test(
            picXml
          )
        ) {
          continue
        }
        const rid = picXml.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/i)?.[1]
        if (rid) {
          const relTarget = parseRelationshipTarget(relsXml, rid)
          if (relTarget) imagePartPath = resolveZipPath(relsPath, relTarget)
        }
        break
      }
      if (!imagePartPath)
        fail(verb, `no image placeholder named "${placeholder}" on the selected slide`)
    } else {
      const fallback = relsXml.match(
        /<Relationship\b[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"[^>]*>/i
      )
      if (fallback) imagePartPath = resolveZipPath(relsPath, fallback[1])
    }
    if (!imagePartPath) fail(verb, 'no image relationship found on the selected slide')
    zip.file(imagePartPath!, replacement.bytes)
  })
}

/** `slides.update_chart` — overwrite the chart's cached values in document order. */
export const slidesUpdateChartStep: StepImpl = async (ctx) => {
  const verb = 'slides update_chart'
  const data = ctx.step.args.data as MediaArgJson
  if (!Array.isArray(data) || data.length === 0) {
    fail(verb, `data must be a non-empty JSON array of arrays: data='[["Q1",10]]'`)
  }
  return withPresentation(ctx, verb, async (zip, parsed) => {
    const target = resolveSlide(verb, parsed.entries, argOf<string | number>(ctx.step, 'slide'))
    const slidePath = resolveZipPath('ppt/presentation.xml', target.target)
    const slideNum = slidePath.match(/slide(\d+)\.xml$/)?.[1]
    if (!slideNum) fail(verb, 'unable to resolve the slide number (corrupt PPTX?)')
    const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`
    const relsXml = await readZipText(verb, zip, relsPath)
    const chartRel = relsXml.match(
      /<Relationship\b[^>]*Type="[^"]*\/chart"[^>]*Target="([^"]+)"[^>]*>/i
    )
    if (!chartRel) fail(verb, 'no chart found on the selected slide')
    const chartPath = resolveZipPath(relsPath, chartRel![1])
    let chartXml = await readZipText(verb, zip, chartPath)
    const values = (data as unknown[][]).flat().map((v) => String(v))
    let replaced = 0
    chartXml = chartXml.replace(/<c:v>[\s\S]*?<\/c:v>/g, (full) => {
      if (replaced >= values.length) return full
      const next = `<c:v>${escapeXml(values[replaced])}</c:v>`
      replaced += 1
      return next
    })
    if (replaced === 0) fail(verb, 'the chart has no cached values to update')
    zip.file(chartPath, chartXml)
  })
}

/** `slides.delete` — remove slides by 1-based index (cannot remove all). */
export const slidesDeleteStep: StepImpl = async (ctx) => {
  const verb = 'slides delete'
  const slides = ctx.step.args.slides as number[]
  return withPresentation(ctx, verb, async (zip, parsed) => {
    const unique = [...new Set(slides)]
    for (const index of unique) {
      if (!Number.isInteger(index) || index < 1 || index > parsed.entries.length) {
        fail(
          verb,
          `slide index ${index} is out of range (1-based; ${parsed.entries.length} slides)`
        )
      }
    }
    const toDelete = new Set(unique)
    const kept = parsed.entries.filter((_, idx) => !toDelete.has(idx + 1))
    if (kept.length === 0) fail(verb, 'cannot delete every slide in the presentation')
    zip.file(
      'ppt/presentation.xml',
      replaceSlideIdList(
        parsed.presentationXml,
        kept.map((e) => e.sldIdTag)
      )
    )
    let relsXml = parsed.relsXml
    parsed.entries.forEach((entry, idx) => {
      if (!toDelete.has(idx + 1)) return
      const targetPath = resolveZipPath('ppt/presentation.xml', entry.target)
      zip.remove(targetPath)
      const slideNum = targetPath.match(/slide(\d+)\.xml$/)?.[1]
      if (slideNum) zip.remove(`ppt/slides/_rels/slide${slideNum}.xml.rels`)
      relsXml = relsXml.replace(
        new RegExp(`<Relationship\\b[^>]*Id="${entry.rid}"[^>]*/>`, 'g'),
        ''
      )
    })
    zip.file('ppt/_rels/presentation.xml.rels', relsXml)
  })
}

/** `slides.reorder` — every slide exactly once, by 1-based index. */
export const slidesReorderStep: StepImpl = async (ctx) => {
  const verb = 'slides reorder'
  const order = ctx.step.args.order as number[]
  return withPresentation(ctx, verb, async (zip, parsed) => {
    if (order.length !== parsed.entries.length) {
      fail(verb, `order must list all ${parsed.entries.length} slides exactly once`)
    }
    const seen = new Set<number>()
    const reordered: SlideEntry[] = []
    for (const index of order) {
      if (!Number.isInteger(index) || index < 1 || index > parsed.entries.length) {
        fail(verb, `slide index ${index} is out of range (1-based)`)
      }
      if (seen.has(index)) fail(verb, `duplicate slide index: ${index}`)
      seen.add(index)
      reordered.push(parsed.entries[index - 1])
    }
    zip.file(
      'ppt/presentation.xml',
      replaceSlideIdList(
        parsed.presentationXml,
        reordered.map((e) => e.sldIdTag)
      )
    )
  })
}

/** `slides.duplicate` — copy a slide, optionally inserting at a position. */
export const slidesDuplicateStep: StepImpl = async (ctx) => {
  const verb = 'slides duplicate'
  const slide = argOf<number>(ctx.step, 'slide') as number
  const at = argOf<number>(ctx.step, 'at')
  return withPresentation(ctx, verb, async (zip, parsed) => {
    if (!Number.isInteger(slide) || slide < 1 || slide > parsed.entries.length) {
      fail(verb, `slide index ${slide} is out of range (1-based; ${parsed.entries.length} slides)`)
    }
    const source = parsed.entries[slide - 1]
    const sourcePath = resolveZipPath('ppt/presentation.xml', source.target)
    const sourceXml = await readZipText(verb, zip, sourcePath)
    const newSlideNumber = getMaxSlideNumber(zip) + 1
    zip.file(`ppt/slides/slide${newSlideNumber}.xml`, sourceXml)
    const sourceNum = sourcePath.match(/slide(\d+)\.xml$/)?.[1]
    if (sourceNum) {
      const sourceRels = zip.file(`ppt/slides/_rels/slide${sourceNum}.xml.rels`)
      if (sourceRels) {
        const relsXml = await sourceRels.async('text')
        zip.file(
          `ppt/slides/_rels/slide${newSlideNumber}.xml.rels`,
          relsXml.replace(/<Relationship\b[^>]*Type="[^"]*notesSlide"[^>]*\/>/g, '')
        )
      }
    }
    const newRid = `rId${getMaxRidNumber(parsed.relsXml) + 1}`
    const newTag = `<p:sldId id="${getMaxSlideId(parsed.entries) + 1}" r:id="${newRid}"/>`
    const relNode = `<Relationship Id="${newRid}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${newSlideNumber}.xml"/>`
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      parsed.relsXml.replace('</Relationships>', `${relNode}</Relationships>`)
    )
    const targetPos =
      at !== undefined ? Math.min(Math.max(1, at), parsed.entries.length + 1) : slide + 1
    const tags = parsed.entries.map((e) => e.sldIdTag)
    tags.splice(targetPos - 1, 0, newTag)
    zip.file('ppt/presentation.xml', replaceSlideIdList(parsed.presentationXml, tags))
    const contentTypes = await readZipText(verb, zip, '[Content_Types].xml')
    zip.file('[Content_Types].xml', ensureSlideContentType(contentTypes, newSlideNumber))
  })
}

/** Count slides in pptx bytes — exported for spec assertions. */
export const countSlides = async (bytes: Uint8Array): Promise<number> => {
  const JSZip = await jszip()
  const zip = await JSZip.loadAsync(bytes)
  const parsed = await parsePresentation('slides', zip)
  return parsed.entries.length
}

/** The slides step registry fragment, keyed by canonical verb id. */
export const SLIDES_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['slides.add', slidesAddStep],
  ['slides.update_text', slidesUpdateTextStep],
  ['slides.update_table', slidesUpdateTableStep],
  ['slides.update_image', slidesUpdateImageStep],
  ['slides.update_chart', slidesUpdateChartStep],
  ['slides.delete', slidesDeleteStep],
  ['slides.reorder', slidesReorderStep],
  ['slides.duplicate', slidesDuplicateStep],
]
