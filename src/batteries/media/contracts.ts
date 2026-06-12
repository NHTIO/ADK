/**
 * Generic engine contracts for the media pipeline battery — the seams every implementation
 * (bundled or BYO) plugs into.
 *
 * @module @nhtio/adk/batteries/media/contracts
 *
 * @remarks
 * Engines are seams, not policies. An engine is a self-declaring capability provider: it
 * states exactly which transforms it supports — {@link ConvertCapability} edges (input MIME
 * patterns to output format tokens), {@link MutateCapability} groups (same-format content
 * transforms), and {@link EditCapability} groups (structural document operations) — and the
 * pipeline dispatches against those declarations. There are only three capability shapes
 * because there are only three things a media engine ever does: change the format, change the
 * content, or restructure the document. OCR is a convert (image to text). Transcription is a
 * convert (PCM to text). Decoding audio is a convert (container to PCM). Generating a blank
 * file is a convert (from {@link EMPTY_MIME} — the source format happens to be nothing).
 * Resizing is a mutate. Inserting a worksheet row is an edit. A new capability is a new edge
 * in the data, never a new contract.
 *
 * Engines are supplied to `createMediaPipeline` as a flat ordered array and resolved eagerly
 * at construction (declarations drive verb narrowing, so they must be known up front).
 * Bundled engines stay cheap to resolve: their heavy peer dependencies load lazily inside
 * the capability methods, on first actual use.
 *
 * All contracts are duck-typed: validation guards check structure, not class identity, so a
 * consumer can implement an interface from scratch or adapt an existing client. Contracts are
 * enforced at runtime — construction validates every engine and every declared capability and
 * throws `E_INVALID_MEDIA_PIPELINE_CONFIG` naming the offending index when a value fails.
 *
 * Two further contracts exist so that even "run a binary" and "give a binary a file" are
 * movable seams rather than Node assumptions:
 *
 * - {@link BinaryExecutor} — how an invocation runs. The bundled `execa_executor` wraps execa;
 *   a browser/remote/sandbox executor satisfies the same contract.
 * - {@link ScratchWorkspace} — bytes ⇄ executor-visible paths. A sibling of `ByteStore`, NOT a
 *   `ByteStore`: byte stores promise in-process readers, while binaries are foreign processes
 *   that need real paths. The bundled `fs_workspace` uses `node:fs/promises` via an async
 *   resolver; any implementation whose paths the chosen executor can see is valid — that
 *   compatibility is the consumer's composition decision.
 */

import { isObject } from '@nhtio/adk/guards'

// ── shared helper shapes ─────────────────────────────────────────────────────

/**
 * A value-or-resolver: the canonical way to supply an engine. Resolvers may be sync or async
 * (dynamic import) and may resolve to the value directly or a `{ default: value }` module
 * namespace. Engine resolvers run eagerly at pipeline construction — the engine module itself
 * is cheap; heavy peer dependencies load lazily inside capability methods.
 */
export type EngineResolver<T = MediaEngine> =
  | T
  | (() => T | { default: T } | Promise<T | { default: T }>)

/** Common result shape for engines that transform bytes to bytes. */
export interface EngineBytesResult {
  /** The output bytes. */
  bytes: Uint8Array
  /** The output MIME type. */
  mimeType: string
}

// ── process execution + scratch filesystem ──────────────────────────────────

/** A single binary invocation handed to a {@link BinaryExecutor}. */
export interface BinaryInvocation {
  /** The command to run (an absolute path or a name the executor can resolve). */
  cmd: string
  /** Arguments, exec-style (no shell interpolation). */
  args: string[]
  /** Wall-clock timeout in milliseconds. */
  timeoutMs?: number
  /** Abort signal to cancel the invocation. */
  signal?: AbortSignal
}

/** The settled result of a {@link BinaryExecutor.exec} call. */
export interface BinaryExecResult {
  /** The process exit code (or -1 when the process failed to start). */
  exitCode: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
  /** `true` when the invocation failed (non-zero exit, spawn failure, timeout, abort). */
  failed: boolean
}

/**
 * Runs a binary invocation to completion. How and where it runs — local child process, remote
 * runner, sandbox, container, a browser-side WASI shim — is the implementation's business.
 */
export interface BinaryExecutor {
  /**
   * Run one invocation to completion and report the result. Implementations must not throw on
   * non-zero exits — report via `failed`/`exitCode` so callers map failures to readable errors.
   *
   * @param invocation - The command, args, and limits to run.
   * @returns The settled result.
   */
  exec(invocation: BinaryInvocation): Promise<BinaryExecResult>
}

/**
 * Bytes ⇄ executor-visible paths. The seam that lets binary-backed engines exchange files
 * with the process (or remote runner) that executes them.
 */
export interface ScratchWorkspace {
  /**
   * Write `bytes` into the workspace under `filename` and return the absolute path the
   * paired executor can open.
   *
   * @param bytes - The content to materialize.
   * @param filename - The basename to use (extension matters to format-sniffing binaries).
   * @returns The absolute path.
   */
  materialize(bytes: Uint8Array, filename: string): Promise<string>
  /**
   * Read a file the executor produced inside the workspace.
   *
   * @param path - The absolute path to read.
   * @returns The file bytes.
   */
  read(path: string): Promise<Uint8Array>
  /** The workspace root directory, for `--outdir`-style binary arguments. */
  dir(): string
  /** List the files currently in the workspace root (basenames). */
  list(): Promise<string[]>
  /** Remove the workspace and everything in it. Engines call this in `finally`. */
  dispose(): Promise<void>
}

/**
 * A factory for per-execution scratch workspaces. Engines mint one workspace per invocation
 * so concurrent executions never share a directory.
 */
export type ScratchWorkspaceFactory = () => ScratchWorkspace | Promise<ScratchWorkspace>

// ── the format vocabulary ────────────────────────────────────────────────────

/**
 * An input-matching pattern: an exact MIME type (`application/pdf`), a family wildcard
 * (`image/*`), or a virtual MIME such as {@link PCM_MIME}.
 */
export type MimePattern = string

/**
 * The virtual MIME type for decoded mono PCM audio — the intermediate between an audio
 * container and a transcription. Bytes are little-endian Float32 samples in `[-1, 1]`;
 * a {@link ConvertOutput} carrying PCM must set `meta.sampleRate` (Hz).
 */
export const PCM_MIME = 'audio/x-adk-pcm'

/**
 * The virtual source MIME type for media generation — the single seam through which new media
 * comes into existence. An engine that can mint a blank/seed file declares
 * `converts: [{ from: [EMPTY_MIME], to: [...] }]` and receives a {@link ConvertRequest} with
 * zero bytes; the format token in `to` names what gets created.
 *
 * @remarks
 * Generating an .xlsx, a blank canvas, or a second of silence IS media generation — it is
 * *deterministic* generation (same inputs, same bytes). *Model-based semantic* generation
 * (diffusion, TTS) is the same edge with different machinery: a BYO engine declares
 * `from: [EMPTY_MIME]` and consumes a prompt from `request.options`. Both kinds ride one
 * declaration shape, which is exactly why this is a MIME and not a special API. `EMPTY_MIME`
 * can never become a conversion intermediate: no engine declares `to: 'empty'`, so the
 * pathfinder only ever sees it as a source.
 */
export const EMPTY_MIME = 'application/x-adk-empty'

/**
 * Pack PCM samples into transport bytes for a {@link ConvertOutput}.
 *
 * @remarks
 * A `Float32Array` view over arbitrary `Uint8Array` bytes requires 4-byte alignment, which
 * sliced buffers do not guarantee — this helper (and {@link bytesToPcm}) copy-normalize so
 * neither side has to think about alignment.
 *
 * @param pcm - Mono PCM samples in `[-1, 1]`.
 * @returns The samples as little-endian Float32 bytes.
 */
export const pcmToBytes = (pcm: Float32Array): Uint8Array => {
  const copy = new Float32Array(pcm)
  return new Uint8Array(copy.buffer, 0, copy.byteLength)
}

/**
 * Read PCM samples back out of transport bytes.
 *
 * @param bytes - Little-endian Float32 bytes (as produced by {@link pcmToBytes}).
 * @returns The mono PCM samples.
 */
export const bytesToPcm = (bytes: Uint8Array): Float32Array => {
  const aligned = new Uint8Array(bytes.length)
  aligned.set(bytes)
  return new Float32Array(aligned.buffer, 0, Math.floor(bytes.length / 4))
}

// ── convert options (typed, augmentable) ─────────────────────────────────────

/** Options understood by OCR-flavored converts (`image/*` → `txt`/`hocr`/`json`). */
export interface OcrConvertOptions {
  /** Recognition language hints (e.g. `['eng','deu']`). */
  languages?: readonly string[]
}

/** Options understood by transcription-flavored converts ({@link PCM_MIME} → `txt`/`srt`/`vtt`/`json`). */
export interface AsrConvertOptions {
  /** Source-language hint (BCP-47-ish). */
  lang?: string
  /** Translate the transcription to English. */
  translate?: boolean
}

/** Options understood by embedded-image extraction converts (`application/pdf` → `images`). */
export interface ImagesConvertOptions {
  /**
   * Preferred output encoding token (`jpg`, `png`, …). An extractor that can emit it natively
   * should; outputs in other encodings are re-encoded downstream by the requesting step.
   */
  format?: string
}

/**
 * The options bag carried by a {@link ConvertRequest} — one typed, augmentable interface
 * merging every documented convention.
 *
 * @remarks
 * Consumers add their own keys via declaration merging against this module:
 *
 * ```ts
 * declare module '@nhtio/adk/batteries/media/contracts' {
 *   interface ConvertOptions {
 *     watermark?: { text: string }
 *   }
 * }
 * ```
 *
 * Typo'd keys become excess-property compile errors at literal call sites; the runtime stays
 * open — engines must ignore keys they don't understand (multi-hop conversion forwards one
 * bag to every hop). The namespace is flat and globally merged, so BYO keys should be named
 * to avoid collisions (prefix by engine where ambiguous).
 */
export interface ConvertOptions
  extends OcrConvertOptions, AsrConvertOptions, ImagesConvertOptions {}

// ── the three capabilities ───────────────────────────────────────────────────

/** A format-changing request handed to a {@link ConvertCapability}. */
export interface ConvertRequest {
  /** The input content bytes. */
  bytes: Uint8Array
  /** The input MIME type. */
  mimeType: string
  /** The input filename (extension informs format sniffing). */
  filename: string
  /** The target format token (`pdf`, `docx`, `txt`, `pcm`, `images`, …). */
  to: string
  /** Capability-specific options — see {@link ConvertOptions}. */
  options?: ConvertOptions
  /** Abort signal threaded from the pipeline execution. */
  signal?: AbortSignal
}

/** One output of a convert — most converts yield exactly one; `images` yields many. */
export interface ConvertOutput {
  /** The output bytes. */
  bytes: Uint8Array
  /** The output MIME type (honest — native encoding, no silent re-encode). */
  mimeType: string
  /** Output metadata (e.g. `{ sampleRate: 44100 }` on {@link PCM_MIME} outputs). */
  meta?: Record<string, unknown>
}

/** The settled result of a convert. */
export interface ConvertResult {
  /** The outputs, in source order. */
  outputs: readonly ConvertOutput[]
}

/**
 * One uniform block of an engine's conversion matrix: every format token in `to` is
 * producible from every input matching `from`.
 *
 * @remarks
 * Declarations are plain data — the registry reads them without calling engine code. An
 * input-dependent matrix (LibreOffice: docx→pdf yes, docx→xlsx no, ods→xlsx yes) is expressed
 * as several capability groups, each a uniform from×to block.
 */
export interface ConvertCapability {
  /** Input patterns this block accepts. */
  from: readonly MimePattern[]
  /** Format tokens producible from every `from` member. */
  to: readonly string[]
  /**
   * Perform the conversion.
   *
   * @param request - The input bytes, target token, and options.
   * @returns The conversion outputs.
   */
  convert(request: ConvertRequest): Promise<ConvertResult>
}

/**
 * A same-format content transform handed to a {@link MutateCapability} — the fused image
 * request: adjacent `image.*` steps fold into ONE request so a resize→rotate→format chain
 * costs a single decode/encode.
 */
export interface MutateRequest {
  /** The input bytes. */
  bytes: Uint8Array
  /** The input MIME type. */
  mimeType: string
  /** Resize, when requested. */
  resize?: {
    width?: number
    height?: number
    fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  }
  /** Clockwise rotation in degrees. */
  rotate?: 90 | 180 | 270
  /** Flip axes. */
  flip?: { horizontal?: boolean; vertical?: boolean }
  /** Remove EXIF/ICC metadata. */
  stripMetadata?: boolean
  /** Re-encode target, when requested (rides the same fused call). */
  format?: { to: string; quality?: number }
  /** Abort signal threaded from the pipeline execution. */
  signal?: AbortSignal
}

/** A same-format content-transform capability group. */
export interface MutateCapability {
  /** Input patterns this block mutates. */
  over: readonly MimePattern[]
  /** Content operations supported (`resize`, `rotate`, `flip`, `strip_metadata`). */
  ops: readonly string[]
  /** Format tokens reachable via `request.format` in the same fused call. */
  encodes: readonly string[]
  /**
   * Apply the fused transform.
   *
   * @param request - The folded operations and input bytes.
   * @returns The transformed bytes.
   */
  mutate(request: MutateRequest): Promise<EngineBytesResult>
}

/**
 * A structural document operation handed to an {@link EditCapability}: one named op with its
 * verb-table args, applied to in-memory bytes. Unlike the fused {@link MutateRequest} (which
 * folds adjacent image transforms into one decode/encode), edits run one op per request — a
 * worksheet splice is not a pixel pass and gains nothing from fusion.
 */
export interface EditRequest {
  /** The input bytes. */
  bytes: Uint8Array
  /** The input MIME type. */
  mimeType: string
  /** The operation name, namespaced as in the verb table (`sheet.update_cells`, …). */
  op: string
  /** The op's arguments, in the verb table's declared shapes. */
  args: Record<string, unknown>
  /** Abort signal threaded from the pipeline execution. */
  signal?: AbortSignal
}

/** Counts an edit reports back for result summaries. */
export interface EditSummary {
  /** Items added (rows, columns, sheets…). */
  added?: number
  /** Items removed. */
  removed?: number
  /** Items modified. */
  modified?: number
  /** Non-fatal notes surfaced to the model. */
  warnings?: string[]
}

/** The settled result of an edit: the restructured bytes plus optional change counts. */
export interface EditResult extends EngineBytesResult {
  /** Change counts for result summaries. */
  summary?: EditSummary
}

/**
 * A structural document-editing capability group: every op in `ops` is applicable to every
 * input matching `over`.
 *
 * @remarks
 * Two engines may declare the same ops over the same patterns with different fidelity — e.g.
 * an ExcelJS-backed editor preserves styling while a SheetJS CE-backed one strips it. The
 * registry does not rank fidelity; supply order (or selection middleware) decides, which makes
 * the trade-off the consumer's visible composition decision.
 */
export interface EditCapability {
  /** Input patterns this block edits. */
  over: readonly MimePattern[]
  /** Operation names supported (`sheet.update_cells`, `sheet.add_rows`, …). */
  ops: readonly string[]
  /**
   * Apply one structural operation.
   *
   * @param request - The op, its args, and the input bytes.
   * @returns The restructured bytes plus optional change counts.
   */
  edit(request: EditRequest): Promise<EditResult>
}

/**
 * A self-declaring media engine: an id for error messages plus the capabilities it provides.
 * At least one capability entry is required.
 */
export interface MediaEngine {
  /** Stable identifier used in config and dispatch error messages (`jimp`, `soffice`, …). */
  readonly id: string
  /** Format-changing capability groups. */
  readonly converts?: readonly ConvertCapability[]
  /** Same-format content-transform capability groups. */
  readonly mutates?: readonly MutateCapability[]
  /** Structural document-editing capability groups. */
  readonly edits?: readonly EditCapability[]
}

// ── duck-typed guards ────────────────────────────────────────────────────────

const hasFns = (value: unknown, names: readonly string[]): boolean =>
  isObject(value) && names.every((n) => typeof (value as Record<string, unknown>)[n] === 'function')

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')

/** `true` when `value` structurally implements {@link BinaryExecutor}. */
export const implementsBinaryExecutor = (value: unknown): value is BinaryExecutor =>
  hasFns(value, ['exec'])

/** `true` when `value` structurally implements {@link ScratchWorkspace}. */
export const implementsScratchWorkspace = (value: unknown): value is ScratchWorkspace =>
  hasFns(value, ['materialize', 'read', 'dir', 'list', 'dispose'])

/** `true` when `value` structurally implements {@link ConvertCapability}. */
export const implementsConvertCapability = (value: unknown): value is ConvertCapability =>
  hasFns(value, ['convert']) &&
  isStringArray((value as ConvertCapability).from) &&
  isStringArray((value as ConvertCapability).to)

/** `true` when `value` structurally implements {@link MutateCapability}. */
export const implementsMutateCapability = (value: unknown): value is MutateCapability =>
  hasFns(value, ['mutate']) &&
  isStringArray((value as MutateCapability).over) &&
  isStringArray((value as MutateCapability).ops) &&
  isStringArray((value as MutateCapability).encodes)

/** `true` when `value` structurally implements {@link EditCapability}. */
export const implementsEditCapability = (value: unknown): value is EditCapability =>
  hasFns(value, ['edit']) &&
  isStringArray((value as EditCapability).over) &&
  isStringArray((value as EditCapability).ops)

/**
 * `true` when `value` structurally implements {@link MediaEngine}: a string id plus at least
 * one well-formed capability entry. Every declared entry must pass its capability guard.
 */
export const implementsMediaEngine = (value: unknown): value is MediaEngine => {
  if (!isObject(value)) return false
  const engine = value as unknown as MediaEngine
  if (typeof engine.id !== 'string' || engine.id.length === 0) return false
  const converts = engine.converts
  const mutates = engine.mutates
  const edits = engine.edits
  if (converts !== undefined) {
    if (!Array.isArray(converts) || !converts.every(implementsConvertCapability)) return false
  }
  if (mutates !== undefined) {
    if (!Array.isArray(mutates) || !mutates.every(implementsMutateCapability)) return false
  }
  if (edits !== undefined) {
    if (!Array.isArray(edits) || !edits.every(implementsEditCapability)) return false
  }
  const convertCount = Array.isArray(converts) ? converts.length : 0
  const mutateCount = Array.isArray(mutates) ? mutates.length : 0
  const editCount = Array.isArray(edits) ? edits.length : 0
  return convertCount + mutateCount + editCount > 0
}
