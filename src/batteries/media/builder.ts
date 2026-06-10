/**
 * The chainable, thenable media builder — the implementor-facing front-end that compiles to
 * the same {@link MediaPlan} as the pipe string and JSON ops.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. The knex lessons applied:
 * `mp(input)` opens a fresh immutable builder; every verb returns a new builder; awaiting the
 * builder executes the chain (no `.execute()`). Domain verbs hang off typed namespaces
 * (`.sheet`, `.slides`, `.image`, `.audio`); shared transforms live on the root.
 *
 * Each verb method appends an op and revalidates lazily — the full plan validates (verb table,
 * arg schemas, engine narrowing) when the chain executes, so building is cheap and the same
 * validator serves all three front-ends.
 */

import { toPipe } from './plan'
import type { PlanResult, StepPayload } from './runtime'
import type { MediaPlan, MediaOp, MediaArgValue, MediaArgJson, MediaRef } from './plan'

/** The function a builder calls to execute its accumulated ops. Bound by the pipeline. */
export type ChainExecutor = (ops: MediaOp[]) => Promise<PlanResult>

/** Options accepted by image resize. */
export interface ResizeOptions {
  /** Target width in pixels. */
  width?: number
  /** Target height in pixels. */
  height?: number
  /** Resize fit mode (default cover). */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
}

/** A cell update for `sheet.updateCells`. */
export interface CellUpdate {
  /** A1-notation address, e.g. `B2`. Alternative to row/col. */
  address?: string
  /** One-based row index. Pair with `col`. */
  row?: number
  /** One-based column index, or a column letter. Pair with `row`. */
  col?: number | string
  /** The value to set. A leading `=` writes a formula. */
  value: string | number | boolean | null
}

const refOf = (other: MediaChainRef): MediaRef =>
  typeof other === 'string' ? { kind: 'id', id: other } : { kind: 'id', id: other.mediaId }

/** How other media are referenced from builder verbs: an id string or `{ mediaId }`. */
export type MediaChainRef = string | { mediaId: string }

/**
 * The chainable builder. Immutable — every verb returns a new instance sharing the executor.
 * Thenable — `await` runs the chain and resolves to the terminal step's natural type.
 */
export class MediaChain implements PromiseLike<unknown> {
  readonly #ops: MediaOp[]
  readonly #exec: ChainExecutor

  constructor(exec: ChainExecutor, ops: MediaOp[] = []) {
    this.#exec = exec
    this.#ops = ops
  }

  #with(verb: string, args: Record<string, MediaArgValue>): MediaChain {
    return new MediaChain(this.#exec, [...this.#ops, { verb, args }])
  }

  // ── root transforms ─────────────────────────────────────────────────────────

  /** Convert to another format (requires a convert engine). */
  convert(to: string): MediaChain {
    return this.#with('convert', { to })
  }

  /** Keep only the listed 1-based pages. */
  select(options: { pages: number[] }): MediaChain {
    return this.#with('select', { pages: options.pages })
  }

  /** Split by page (optionally grouped `[[start,end], …]`). Terminal: resolves to media list. */
  split(options: { by?: 'page' | 'section'; ranges?: number[][] } = {}): MediaChain {
    const args: Record<string, MediaArgValue> = {}
    if (options.by) args.by = options.by
    if (options.ranges) args.ranges = options.ranges as MediaArgJson
    return this.#with('split', args)
  }

  /** Merge other media into this one, in order. */
  merge(...others: MediaChainRef[]): MediaChain {
    return this.#with('merge', { with: others.map(refOf) })
  }

  /** Reorder pages by 1-based index. */
  reorder(order: number[]): MediaChain {
    return this.#with('reorder', { order })
  }

  /** Redact matching text (literals or RegExp). */
  redact(options: {
    match: Array<string | RegExp> | string | RegExp
    replace?: string
  }): MediaChain {
    const list = Array.isArray(options.match) ? options.match : [options.match]
    const match = list.map((m) =>
      typeof m === 'string' ? m : { source: m.source, flags: Array.from(m.flags).sort().join('') }
    )
    const args: Record<string, MediaArgValue> = { match }
    if (options.replace !== undefined) args.replace = options.replace
    return this.#with('redact', args)
  }

  /** Remove potentially unsafe embedded content. */
  sanitize(): MediaChain {
    return this.#with('sanitize', {})
  }

  /** Normalize structure/encoding. */
  normalize(): MediaChain {
    return this.#with('normalize', {})
  }

  /** Replace the first occurrence of anchor text. */
  updateText(anchor: string, replace: string): MediaChain {
    return this.#with('update_text', { anchor, replace })
  }

  /** Compare against another media. Terminal: resolves to a structured diff. */
  diff(other: MediaChainRef): MediaChain {
    return this.#with('diff', { with: refOf(other) })
  }

  /** Apply a unified-diff patch. */
  applyPatch(patch: string, options: { with?: MediaChainRef[] } = {}): MediaChain {
    const args: Record<string, MediaArgValue> = { patch }
    if (options.with) args.with = options.with.map(refOf)
    return this.#with('apply_patch', args)
  }

  /** Extract text (routes by format; OCR engine used when needed). Terminal: resolves to text. */
  extractText(
    options: {
      ocr?: 'off' | 'auto' | 'force'
      ocrOut?: 'txt' | 'hocr' | 'json'
      lang?: string[]
    } = {}
  ): MediaChain {
    const args: Record<string, MediaArgValue> = {}
    if (options.ocr) args.ocr = options.ocr
    if (options.ocrOut) args.ocr_out = options.ocrOut
    if (options.lang) args.lang = options.lang
    return this.#with('extract.text', args)
  }

  /** Extract metadata. Terminal: resolves to a metadata object. */
  extractMetadata(): MediaChain {
    return this.#with('extract.metadata', {})
  }

  /** Extract embedded assets. Terminal: resolves to a media list. */
  extractAssets(
    options: { types?: Array<'image' | 'font' | 'attachment' | 'all'> } = {}
  ): MediaChain {
    const args: Record<string, MediaArgValue> = {}
    if (options.types) args.types = options.types
    return this.#with('extract.assets', args)
  }

  /** Chunk extracted text. Terminal: resolves to a chunk array. */
  chunk(
    options: { strategy?: 'sentence' | 'paragraph' | 'fixed'; size?: number; overlap?: number } = {}
  ): MediaChain {
    const args: Record<string, MediaArgValue> = {}
    if (options.strategy) args.by = options.strategy
    if (options.size !== undefined) args.size = options.size
    if (options.overlap !== undefined) args.overlap = options.overlap
    return this.#with('chunk', args)
  }

  // ── domain namespaces ───────────────────────────────────────────────────────

  /** Spreadsheet mutations. */
  get sheet(): SheetNamespace {
    return new SheetNamespace(this)
  }

  /** Presentation mutations. */
  get slides(): SlidesNamespace {
    return new SlidesNamespace(this)
  }

  /** Image transforms. */
  get image(): ImageNamespace {
    return new ImageNamespace(this)
  }

  /** Audio operations. */
  get audio(): AudioNamespace {
    return new AudioNamespace(this)
  }

  // ── serialization + execution ───────────────────────────────────────────────

  /** The accumulated ops (a copy). */
  toOps(): MediaOp[] {
    return this.#ops.map((op) => ({ verb: op.verb, args: { ...op.args } }))
  }

  /** The canonical pipe form of the accumulated chain. */
  toPipe(): string {
    const plan: MediaPlan = { steps: this.#ops.map((op) => ({ verb: op.verb, args: op.args })) }
    return toPipe(plan)
  }

  /** Internal — used by namespaces to append. */
  withOp(verb: string, args: Record<string, MediaArgValue>): MediaChain {
    return this.#with(verb, args)
  }

  /** Thenable: awaiting the chain executes it. */
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.#exec(this.toOps()).then(unwrapResult).then(onfulfilled, onrejected)
  }

  /** Execute and return the raw {@link PlanResult} (no unwrapping). */
  async run(): Promise<PlanResult> {
    return this.#exec(this.toOps())
  }
}

/** Resolve a plan result to its natural awaited type. */
const unwrapResult = (result: PlanResult): unknown => {
  if (result.kind === 'media') return result.payload
  if (result.kind === 'media-list') return result.payloads
  return result.data
}

/** `sheet.*` verbs, mirrored from the verb table. */
export class SheetNamespace {
  readonly #chain: MediaChain
  constructor(chain: MediaChain) {
    this.#chain = chain
  }
  /** Insert rows. */
  addRows(
    rows: Array<Array<string | number | boolean | null>>,
    options: { sheet?: string | number; before?: number; after?: number } = {}
  ): MediaChain {
    return this.#chain.withOp(
      'sheet.add_rows',
      compact({
        rows: rows as MediaArgJson,
        ...targetArgs(options),
        before: options.before,
        after: options.after,
      })
    )
  }
  /** Insert columns. */
  addColumns(options: {
    sheet?: string | number
    headers?: string[]
    columns?: Array<{ header: string; values?: Array<string | number | boolean | null> }>
    before?: number
    after?: number
  }): MediaChain {
    return this.#chain.withOp(
      'sheet.add_columns',
      compact({
        ...targetArgs(options),
        headers: options.headers,
        columns: options.columns as MediaArgJson,
        before: options.before,
        after: options.after,
      })
    )
  }
  /** Update cells. */
  updateCells(updates: CellUpdate[], options: { sheet?: string | number } = {}): MediaChain {
    return this.#chain.withOp(
      'sheet.update_cells',
      compact({ updates: updates as unknown as MediaArgJson, ...targetArgs(options) })
    )
  }
  /** Delete rows by 1-based index. */
  deleteRows(rows: number[], options: { sheet?: string | number } = {}): MediaChain {
    return this.#chain.withOp('sheet.delete_rows', compact({ rows, ...targetArgs(options) }))
  }
  /** Delete columns by 1-based index. */
  deleteColumns(columns: number[], options: { sheet?: string | number } = {}): MediaChain {
    return this.#chain.withOp('sheet.delete_columns', compact({ columns, ...targetArgs(options) }))
  }
  /** Rename a worksheet (name-targeted). */
  renameSheet(sheet: string, to: string): MediaChain {
    return this.#chain.withOp('sheet.rename_sheet', { sheet, to })
  }
  /** Add a worksheet. */
  addSheet(name: string, options: { at?: number } = {}): MediaChain {
    return this.#chain.withOp('sheet.add_sheet', compact({ name, at: options.at }))
  }
  /** Remove a worksheet (name-targeted). */
  removeSheet(sheet: string): MediaChain {
    return this.#chain.withOp('sheet.remove_sheet', { sheet })
  }
  /** Reorder worksheets by names and/or 1-based indices. */
  reorderSheets(order: Array<string | number>): MediaChain {
    return this.#chain.withOp('sheet.reorder_sheets', { order: order as MediaArgJson })
  }
  /** Table transforms by header name. */
  transformTable(options: {
    sheet?: string | number
    headerRow?: number
    select?: string[]
    drop?: string[]
    rename?: Array<{ from: string; to: string }>
  }): MediaChain {
    return this.#chain.withOp(
      'sheet.transform_table',
      compact({
        ...targetArgs(options),
        header_row: options.headerRow,
        select: options.select,
        drop: options.drop,
        rename: options.rename as MediaArgJson,
      })
    )
  }
}

/** `slides.*` verbs. */
export class SlidesNamespace {
  readonly #chain: MediaChain
  constructor(chain: MediaChain) {
    this.#chain = chain
  }
  /** Add a slide. */
  add(options: { at?: number; title?: string; layout?: string } = {}): MediaChain {
    return this.#chain.withOp(
      'slides.add',
      compact({ at: options.at, title: options.title, layout: options.layout })
    )
  }
  /** Update text on a slide. */
  updateText(
    text: string,
    options: { slide?: string | number; placeholder?: string } = {}
  ): MediaChain {
    return this.#chain.withOp(
      'slides.update_text',
      compact({ text, slide: slideArg(options.slide), placeholder: options.placeholder })
    )
  }
  /** Update table cells on a slide. */
  updateTable(
    updates: Array<{ row: number; col: number; value: string }>,
    options: { slide?: string | number } = {}
  ): MediaChain {
    return this.#chain.withOp(
      'slides.update_table',
      compact({ updates: updates as unknown as MediaArgJson, slide: slideArg(options.slide) })
    )
  }
  /** Replace an image on a slide with another media. */
  updateImage(
    withMedia: MediaChainRef,
    options: { slide?: string | number; placeholder?: string } = {}
  ): MediaChain {
    return this.#chain.withOp(
      'slides.update_image',
      compact({
        with: refOf(withMedia),
        slide: slideArg(options.slide),
        placeholder: options.placeholder,
      })
    )
  }
  /** Update chart data on a slide. */
  updateChart(data: unknown[][], options: { slide?: string | number } = {}): MediaChain {
    return this.#chain.withOp(
      'slides.update_chart',
      compact({ data: data as MediaArgJson, slide: slideArg(options.slide) })
    )
  }
  /** Delete slides by 1-based index. */
  delete(slides: number[]): MediaChain {
    return this.#chain.withOp('slides.delete', { slides })
  }
  /** Reorder slides. */
  reorder(order: number[]): MediaChain {
    return this.#chain.withOp('slides.reorder', { order })
  }
  /** Duplicate a slide. */
  duplicate(slide: number, options: { at?: number } = {}): MediaChain {
    return this.#chain.withOp('slides.duplicate', compact({ slide, at: options.at }))
  }
}

/** `image.*` verbs (the runtime fuses adjacent image steps into one engine pass). */
export class ImageNamespace {
  readonly #chain: MediaChain
  constructor(chain: MediaChain) {
    this.#chain = chain
  }
  /** Resize. */
  resize(options: ResizeOptions): MediaChain {
    return this.#chain.withOp(
      'image.resize',
      compact({ width: options.width, height: options.height, fit: options.fit })
    )
  }
  /** Re-encode to another format. */
  format(to: string, options: { quality?: number; stripMetadata?: boolean } = {}): MediaChain {
    return this.#chain.withOp(
      'image.format',
      compact({ to, quality: options.quality, strip_metadata: options.stripMetadata })
    )
  }
  /** Rotate clockwise. */
  rotate(deg: 90 | 180 | 270): MediaChain {
    return this.#chain.withOp('image.rotate', { deg: String(deg) })
  }
  /** Flip. */
  flip(axis: 'horizontal' | 'vertical' | 'both'): MediaChain {
    return this.#chain.withOp('image.flip', { axis })
  }
  /** Strip EXIF/ICC metadata. */
  stripMetadata(): MediaChain {
    return this.#chain.withOp('image.strip_metadata', {})
  }
}

/** `audio.*` verbs. */
export class AudioNamespace {
  readonly #chain: MediaChain
  constructor(chain: MediaChain) {
    this.#chain = chain
  }
  /** Transcribe speech. Terminal: resolves to text (or srt/vtt/json per `out`). */
  transcribe(
    options: { language?: string; out?: 'txt' | 'srt' | 'vtt' | 'json'; translate?: boolean } = {}
  ): MediaChain {
    return this.#chain.withOp(
      'audio.transcribe',
      compact({ lang: options.language, out: options.out, translate: options.translate })
    )
  }
}

const targetArgs = (options: { sheet?: string | number }): Record<string, MediaArgValue> =>
  options.sheet === undefined ? {} : { sheet: options.sheet }

const slideArg = (slide: string | number | undefined): string | number | undefined => slide

const compact = (
  args: Record<string, MediaArgValue | undefined>
): Record<string, MediaArgValue> => {
  const out: Record<string, MediaArgValue> = {}
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** The input shapes `mp(...)` accepts. */
export type ChainInput = StepPayload
