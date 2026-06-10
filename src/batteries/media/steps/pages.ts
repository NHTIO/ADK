/**
 * Pure page-operation step implementations for PDFs: select, split, merge, reorder.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Implemented with `pdf-lib`
 * (optional peer, lazily imported) on in-memory bytes — no binaries, cross-environment.
 * Phase 0 covers PDF inputs; PPTX slide operations and DOCX section operations join in the
 * sheet/slides/doc phases, sharing these verb ids with format dispatch.
 */

import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { MIME, replaceExtension } from '../formats'
import type { MediaRef } from '../plan'
import type * as PdfLibModule from 'pdf-lib'
import type { StepImpl, StepPayload } from '../runtime'

type PdfLib = typeof PdfLibModule
type PDFDocumentType = PdfLibModule.PDFDocument

let pdfLibPromise: Promise<PdfLib> | undefined
const pdfLib = (): Promise<PdfLib> => {
  pdfLibPromise ??= import('pdf-lib')
  return pdfLibPromise
}

const requirePdf = (verb: string, payload: StepPayload): void => {
  if (payload.mimeType.toLowerCase().split(';')[0].trim() !== MIME.PDF) {
    throw new E_MEDIA_STEP_FAILED([
      verb,
      `page operations for ${payload.mimeType} are not yet implemented in this build (PDF is supported)`,
    ])
  }
}

const loadPdf = async (verb: string, bytes: Uint8Array): Promise<PDFDocumentType> => {
  const { PDFDocument } = await pdfLib()
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false })
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    throw new E_MEDIA_STEP_FAILED([verb, `could not read the PDF: ${detail}`], { cause: err })
  }
}

const checkIndices = (verb: string, indices: number[], pageCount: number): void => {
  for (const i of indices) {
    if (i < 1 || i > pageCount) {
      throw new E_MEDIA_STEP_FAILED([
        verb,
        `page ${i} is out of range — the document has ${pageCount} pages (pages are 1-based)`,
      ])
    }
  }
}

/** `select` — keep only the listed 1-based pages, producing one document. */
export const selectStep: StepImpl = async (ctx) => {
  requirePdf('select', ctx.payload)
  const pages = argOf<number[]>(ctx.step, 'pages') as number[]
  const source = await loadPdf('select', ctx.payload.bytes)
  checkIndices('select', pages, source.getPageCount())
  const { PDFDocument } = await pdfLib()
  const out = await PDFDocument.create()
  const copied = await out.copyPages(
    source,
    pages.map((p) => p - 1)
  )
  for (const page of copied) out.addPage(page)
  const bytes = await out.save()
  return { kind: 'media', payload: { ...ctx.payload, bytes: new Uint8Array(bytes) } }
}

/** `split` — split into multiple documents by page (optionally grouped by JSON ranges). */
export const splitStep: StepImpl = async (ctx) => {
  requirePdf('split', ctx.payload)
  const by = argOf<string>(ctx.step, 'by') ?? 'page'
  if (by !== 'page') {
    throw new E_MEDIA_STEP_FAILED([
      'split',
      `split by=${by} is not yet implemented in this build (page is supported)`,
    ])
  }
  const source = await loadPdf('split', ctx.payload.bytes)
  const pageCount = source.getPageCount()
  const rawRanges = ctx.step.args.ranges as number[][] | undefined
  const groups: number[][] =
    rawRanges !== undefined
      ? rawRanges.map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2) {
            throw new E_MEDIA_STEP_FAILED([
              'split',
              `ranges must be [start,end] pairs, e.g. ranges='[[1,3],[5,7]]'`,
            ])
          }
          const [start, end] = pair
          const pages: number[] = []
          for (let p = start; p <= end; p++) pages.push(p)
          return pages
        })
      : Array.from({ length: pageCount }, (_, i) => [i + 1])
  const { PDFDocument } = await pdfLib()
  const payloads: StepPayload[] = []
  let part = 1
  for (const group of groups) {
    checkIndices('split', group, pageCount)
    const out = await PDFDocument.create()
    const copied = await out.copyPages(
      source,
      group.map((p) => p - 1)
    )
    for (const page of copied) out.addPage(page)
    const bytes = new Uint8Array(await out.save())
    payloads.push({
      bytes,
      mimeType: MIME.PDF,
      filename: replaceExtension(ctx.payload.filename, '').replace(/\.$/, '') + `.part${part}.pdf`,
    })
    part += 1
  }
  return { kind: 'media-list', payloads }
}

/** `merge` — append the referenced media's pages, in order. */
export const mergeStep: StepImpl = async (ctx) => {
  requirePdf('merge', ctx.payload)
  const raw = ctx.step.args.with
  const refs = (Array.isArray(raw) ? raw : [raw]) as MediaRef[]
  const { PDFDocument } = await pdfLib()
  const out = await PDFDocument.create()
  const appendAll = async (doc: PDFDocumentType): Promise<void> => {
    const copied = await out.copyPages(doc, doc.getPageIndices())
    for (const page of copied) out.addPage(page)
  }
  await appendAll(await loadPdf('merge', ctx.payload.bytes))
  for (const ref of refs) {
    if (ref.kind !== 'id') {
      throw new E_MEDIA_STEP_FAILED(['merge', 'builder refs are not yet supported here'])
    }
    const other = await ctx.resolveRef(ref.id)
    requirePdf('merge', other)
    await appendAll(await loadPdf('merge', other.bytes))
  }
  const bytes = new Uint8Array(await out.save())
  return { kind: 'media', payload: { ...ctx.payload, bytes } }
}

/** `reorder` — rebuild the document with pages in the given 1-based order. */
export const reorderStep: StepImpl = async (ctx) => {
  requirePdf('reorder', ctx.payload)
  const order = argOf<number[]>(ctx.step, 'order') as number[]
  const source = await loadPdf('reorder', ctx.payload.bytes)
  const pageCount = source.getPageCount()
  checkIndices('reorder', order, pageCount)
  if (order.length !== pageCount) {
    throw new E_MEDIA_STEP_FAILED([
      'reorder',
      `order lists ${order.length} pages but the document has ${pageCount} — list every page exactly once`,
    ])
  }
  const { PDFDocument } = await pdfLib()
  const out = await PDFDocument.create()
  const copied = await out.copyPages(
    source,
    order.map((p) => p - 1)
  )
  for (const page of copied) out.addPage(page)
  const bytes = new Uint8Array(await out.save())
  return { kind: 'media', payload: { ...ctx.payload, bytes } }
}
