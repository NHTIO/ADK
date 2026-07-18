/**
 * Pure protocol constants, frame parsing, and byte-safe line framing for local diffusion backends.
 *
 * @remarks
 * The line framer is **byte-oriented**: it retains raw bytes (never a decoded string), enforces the
 * `maxLineBytes` cap while consuming input (so an unbounded no-newline write cannot balloon memory),
 * discards the remainder of an over-sized physical line up to its next newline before resuming, and
 * decodes each bounded, complete line with a fatal UTF-8 decoder (invalid encoding → a `malformed`
 * frame, never a silent mis-parse). {@link parseFrame} is total — it classifies every line as a typed
 * frame and never throws.
 *
 * @module @nhtio/adk/batteries/generation/local_diffusion/protocol
 */

import { isObject } from '@nhtio/adk/guards'

/** The configurable wire tags used by a local diffusion backend. */
export type ProtocolConfig = {
  /** Leading tag on every host→backend command line (DiffusionBee: `b2py`). */
  commandPrefix: string
  /** Leading tag on every backend→host event line (DiffusionBee: `sdbk`). */
  eventPrefix: string
  /** Operation sub-tags for the two request commands. */
  ops: {
    /** text→image generate op sub-tag (DiffusionBee: `t2im`). */
    generate: string
    /** image+text→image edit op sub-tag (DiffusionBee: `im2im`). */
    edit: string
  }
  /** Control-command sub-tags (no request payload). */
  control: {
    /** Advisory cancel of the current request (DiffusionBee: `__stop__`). */
    stop: string
    /** Graceful backend shutdown request (DiffusionBee: `__shutdown__`). */
    shutdown: string
  }
  /** Backend→host event sub-tags. */
  events: {
    /** Startup model-load progress event (DiffusionBee: `mdld`). */
    modelLoad: string
    /** Backend-ready event that resolves preload (DiffusionBee: `rdy`). */
    ready: string
    /** Per-step generation progress event (DiffusionBee: `dnpr`). */
    progress: string
    /** One finished image result event (DiffusionBee: `nwim`). */
    image: string
    /** Request-complete terminal event (DiffusionBee: `done`). */
    done: string
    /** Request-error terminal event (DiffusionBee: `err`). */
    error: string
  }
}

/** The DiffusionBee-compatible default local diffusion protocol configuration. */
export const DEFAULT_PROTOCOL: ProtocolConfig = {
  commandPrefix: 'b2py',
  eventPrefix: 'sdbk',
  ops: { generate: 't2im', edit: 'im2im' },
  control: { stop: '__stop__', shutdown: '__shutdown__' },
  events: {
    modelLoad: 'mdld',
    ready: 'rdy',
    progress: 'dnpr',
    image: 'nwim',
    done: 'done',
    error: 'err',
  },
}

/** A parsed startup model-loading progress frame. */
export type ModelLoadFrame = {
  /** Discriminant. */
  kind: 'modelLoad'
  /** Normalized model-load progress in `0..1`. */
  progress: number
}
/** A parsed backend-ready frame. */
export type ReadyFrame = {
  /** Discriminant. */
  kind: 'ready'
}
/** A parsed request progress frame. */
export type ProgressFrame = {
  /** Discriminant. */
  kind: 'progress'
  /** The request id this progress belongs to. */
  rid: number
  /** Normalized per-step generation progress in `0..1`. */
  progress: number
}
/** A parsed image result frame. */
export type ImageFrame = {
  /** Discriminant. */
  kind: 'image'
  /** The request id this image belongs to. */
  rid: number
  /** The image payload: either an inline base64 blob or a backend-written file path, plus its MIME. */
  payload: {
    /** Backend-written output file path (mutually exclusive with `b64`). */
    path?: string
    /** Inline base64-encoded image bytes (mutually exclusive with `path`). */
    b64?: string
    /** Concrete image MIME type, e.g. `image/png`. */
    mimeType: string
  }
}
/** A parsed request completion frame. */
export type DoneFrame = {
  /** Discriminant. */
  kind: 'done'
  /** The request id that completed. */
  rid: number
}
/** A parsed request error frame. */
export type ErrorFrame = {
  /** Discriminant. */
  kind: 'error'
  /** The request id that errored. */
  rid: number
  /** The backend-reported error message. */
  message: string
}
/** A frame with a tag this protocol version does not understand. */
export type UnknownFrame = {
  /** Discriminant. */
  kind: 'unknown'
  /** The original, unrecognized line. */
  raw: string
}
/** A prefix-matched frame whose fields or JSON do not satisfy the protocol. */
export type MalformedFrame = {
  /** Discriminant. */
  kind: 'malformed'
  /** The original line that failed validation (best-effort, lossy decode for invalid UTF-8). */
  raw: string
  /** Why the line was rejected. */
  detail: string
}
/** A stream-level protocol problem, such as an over-sized line. */
export type ProtocolErrorFrame = {
  /** Discriminant. */
  kind: 'protocolError'
  /** Why the stream framing failed. */
  detail: string
}

/** The total, discriminated result of parsing one backend stdout line. */
export type ParsedFrame =
  | ModelLoadFrame
  | ReadyFrame
  | ProgressFrame
  | ImageFrame
  | DoneFrame
  | ErrorFrame
  | UnknownFrame
  | MalformedFrame
  | ProtocolErrorFrame

const malformed = (raw: string, detail: string): MalformedFrame => ({
  kind: 'malformed',
  raw,
  detail,
})

const validRid = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const rid = Number(value)
  return Number.isSafeInteger(rid) && rid >= 0 ? rid : undefined
}

/**
 * Strictly parse a normalized-unit-interval token (`0..1`). Rejects `undefined`, empty/whitespace-only
 * strings, and anything that is not a plain non-negative decimal — closing the `Number('')===0`
 * coercion hole (a blank progress field would otherwise be accepted as zero) AND the negative-signed
 * `-0` spelling, which contradicts the non-negative wire representation. Scientific/hex notation is
 * likewise rejected; only plain decimals (optionally `+`-signed) are accepted.
 */
const parseUnitInterval = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || !/^\+?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

const json = (raw: string): unknown => JSON.parse(raw) as unknown

/**
 * Structural check that a runtime-supplied `config` carries the string tags this parser dereferences:
 * `eventPrefix` plus all six `events` members must be strings. `parseFrame` promises to never throw;
 * a JS caller passing `null`, `{events:null}`, or a partial `{events:{}}` must get a typed frame, not
 * a `TypeError` (terra v2 #5 / v3 #5). A hostile accessor/proxy that throws on read is caught by the
 * top-level `try/catch` in {@link parseFrame} — this guard is the fast structural gate, the wrapper is
 * the belt.
 */
const isUsableConfig = (config: ProtocolConfig): boolean => {
  if (!isObject(config) || typeof config.eventPrefix !== 'string' || !isObject(config.events)) {
    return false
  }
  const { events } = config
  return (
    typeof events.modelLoad === 'string' &&
    typeof events.ready === 'string' &&
    typeof events.progress === 'string' &&
    typeof events.image === 'string' &&
    typeof events.done === 'string' &&
    typeof events.error === 'string'
  )
}

/**
 * Parse one already-split backend stdout line into a typed {@link ParsedFrame}. Total by contract —
 * it never throws: malformed input yields a `malformed`/`unknown` frame, and a runtime-invalid or
 * hostile `config` (null, partial, or a throwing accessor) is caught and reported as `malformed`.
 *
 * @param line - One already-newline-split backend stdout line.
 * @param config - Protocol tag configuration; defaults to {@link DEFAULT_PROTOCOL}.
 * @returns The discriminated parse result.
 */
export const parseFrame = (
  line: string,
  config: ProtocolConfig = DEFAULT_PROTOCOL
): ParsedFrame => {
  try {
    return parseFrameChecked(line, config)
  } catch {
    // A hostile config (throwing getter/proxy) or any unforeseen runtime error must not escape:
    // parseFrame is total by contract.
    return malformed(line, 'invalid protocol config')
  }
}

const parseFrameChecked = (line: string, config: ProtocolConfig): ParsedFrame => {
  const raw = line
  if (!isUsableConfig(config)) return malformed(raw, 'invalid protocol config')
  const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(line)
  if (!match || match[1] !== config.eventPrefix) return { kind: 'unknown', raw }
  const tag = match[2]
  if (!tag) return malformed(raw, 'missing event tag')
  const { events } = config
  if (tag === events.modelLoad) {
    const progress = parseUnitInterval(match[3])
    return progress !== undefined
      ? { kind: 'modelLoad', progress }
      : malformed(raw, 'progress must be a finite number in 0..1')
  }
  if (tag === events.ready) {
    // The wire contract is `<EVT> rdy` with no payload; a trailing token means a corrupt line.
    return match[3] === undefined ? { kind: 'ready' } : malformed(raw, 'ready has no payload')
  }
  if (
    tag === events.progress ||
    tag === events.image ||
    tag === events.done ||
    tag === events.error
  ) {
    const parts = match[3]?.match(/^(\S+)(?:\s+([\s\S]*))?$/)
    const rid = validRid(parts?.[1])
    if (rid === undefined) return malformed(raw, 'rid must be a non-negative integer')
    const remainder = parts?.[2]
    if (tag === events.progress) {
      const progress = parseUnitInterval(remainder)
      return progress !== undefined
        ? { kind: 'progress', rid, progress }
        : malformed(raw, 'progress must be a finite number in 0..1')
    }
    if (tag === events.done)
      return remainder === undefined ? { kind: 'done', rid } : malformed(raw, 'done has no payload')
    if (remainder === undefined) return malformed(raw, 'missing JSON payload')
    try {
      const value = json(remainder)
      if (tag === events.error) {
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as { message?: unknown }).message !== 'string'
        ) {
          return malformed(raw, 'error payload requires a message string')
        }
        return { kind: 'error', rid, message: (value as { message: string }).message }
      }
      if (typeof value !== 'object' || value === null)
        return malformed(raw, 'image payload must be an object')
      const obj = value as Record<string, unknown>
      const mimeType = obj.mimeType
      // Exactly one of the `path`/`b64` KEYS may be present (regardless of value type), and the
      // selected field must be a string — an object carrying both keys, or a non-string in the
      // present key, is malformed even if the other key holds a valid string (terra v2 #1).
      const pathPresent = 'path' in obj
      const b64Present = 'b64' in obj
      if (typeof mimeType !== 'string' || pathPresent === b64Present)
        return malformed(raw, 'image requires mimeType and exactly one of path or b64')
      if (pathPresent) {
        if (typeof obj.path !== 'string') return malformed(raw, 'image path must be a string')
        return { kind: 'image', rid, payload: { mimeType, path: obj.path } }
      }
      if (typeof obj.b64 !== 'string') return malformed(raw, 'image b64 must be a string')
      return { kind: 'image', rid, payload: { mimeType, b64: obj.b64 } }
    } catch {
      return malformed(raw, 'invalid JSON payload')
    }
  }
  return { kind: 'unknown', raw }
}

/** Assert a request id satisfies the parser's rid contract (a non-negative safe integer). */
const assertRid = (rid: number): void => {
  if (!Number.isSafeInteger(rid) || rid < 0)
    throw new RangeError(`request id must be a non-negative safe integer, received ${String(rid)}`)
}

/** Serialize command arguments, rejecting values JSON cannot represent (which would emit `undefined`). */
const encodeArgs = (args: Record<string, unknown>): string => {
  const encoded = JSON.stringify(args)
  if (encoded === undefined) throw new TypeError('command arguments must be JSON-serializable')
  return encoded
}

/** Build a generate command frame, including its terminating newline. */
export const buildGenerateCommand = (
  rid: number,
  args: Record<string, unknown>,
  config: ProtocolConfig = DEFAULT_PROTOCOL
): string => {
  assertRid(rid)
  return `${config.commandPrefix} ${config.ops.generate} ${rid} ${encodeArgs(args)}\n`
}
/** Build an edit command frame, including its terminating newline. */
export const buildEditCommand = (
  rid: number,
  args: Record<string, unknown>,
  config: ProtocolConfig = DEFAULT_PROTOCOL
): string => {
  assertRid(rid)
  return `${config.commandPrefix} ${config.ops.edit} ${rid} ${encodeArgs(args)}\n`
}
/** Build a best-effort stop command frame, including its terminating newline. */
export const buildStopCommand = (
  rid: number,
  config: ProtocolConfig = DEFAULT_PROTOCOL
): string => {
  assertRid(rid)
  return `${config.commandPrefix} ${config.control.stop} ${rid}\n`
}
/** Build a backend shutdown command frame, including its terminating newline. */
export const buildShutdownCommand = (config: ProtocolConfig = DEFAULT_PROTOCOL): string =>
  `${config.commandPrefix} ${config.control.shutdown}\n`

const LF = 0x0a
const CR = 0x0d

/**
 * Create an incremental, **byte-oriented** line reader. Raw bytes are retained (never a decoded
 * string), the `maxLineBytes` cap is enforced while consuming so an unbounded no-newline write cannot
 * balloon memory, an over-sized physical line reports exactly one `protocolError` and is then discarded
 * through its next newline (its continuation is NOT re-parsed as a fresh frame), and each bounded,
 * complete line is decoded with a fatal UTF-8 decoder — invalid encoding yields a `malformed` frame.
 * Malformed protocol lines are reported as `malformed` rather than thrown.
 *
 * Pending bytes of an in-progress line are held as a queue of chunk SEGMENTS with a running byte
 * count, and concatenated exactly once when the line's terminator arrives — so many small fragments of
 * one line cost O(line length) total, not O(line length²) (terra v2 #4).
 *
 * @throws RangeError if `maxLineBytes` is provided but is not a positive, finite, safe integer — an
 *   unvalidated `Infinity`/`NaN`/negative would silently defeat the bounded-memory guarantee (terra v2 #3).
 */
export const createFrameReader = (opts: {
  onFrame(frame: ParsedFrame): void
  config?: ProtocolConfig
  maxLineBytes?: number
}): { push(chunk: Uint8Array): void; end(): void } => {
  const config = opts.config ?? DEFAULT_PROTOCOL
  if (
    opts.maxLineBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxLineBytes) || opts.maxLineBytes < 1)
  ) {
    throw new RangeError(
      `maxLineBytes must be a positive safe integer, received ${String(opts.maxLineBytes)}`
    )
  }
  const cap = opts.maxLineBytes ?? 1_048_576
  const segments: Uint8Array[] = [] // retained segments of the current, not-yet-terminated line
  let pending = 0 // total retained bytes across `segments`
  let discarding = false // dropping bytes until the next newline (recovering from an over-sized line)
  let ended = false

  const resetLine = (): void => {
    segments.length = 0
    pending = 0
  }

  /** Assemble the retained segments plus `chunk[start..end]` into one contiguous line buffer. */
  const assemble = (chunk: Uint8Array, start: number, end: number): Uint8Array => {
    const tail = end - start
    if (segments.length === 0) return chunk.subarray(start, end)
    const line = new Uint8Array(pending + tail)
    let at = 0
    for (const seg of segments) {
      line.set(seg, at)
      at += seg.length
    }
    if (tail > 0) line.set(chunk.subarray(start, end), at)
    return line
  }

  const decodeLine = (bytes: Uint8Array): void => {
    let end = bytes.length
    if (end > 0 && bytes[end - 1] === CR) end -= 1 // strip a CRLF's CR
    if (end === 0) return // blank line — skip
    const slice = bytes.subarray(0, end)
    try {
      // Each complete line is a whole UTF-8 byte sequence (a newline can't split a code point), so a
      // fresh non-streaming fatal decode is correct and immune to any reuse-after-throw state.
      opts.onFrame(parseFrame(new TextDecoder('utf-8', { fatal: true }).decode(slice), config))
    } catch {
      opts.onFrame(malformed(new TextDecoder().decode(slice), 'invalid UTF-8 in line'))
    }
  }

  const consume = (chunk: Uint8Array): void => {
    let pos = 0
    if (discarding) {
      const nl = chunk.indexOf(LF, pos)
      if (nl === -1) return // still inside the over-sized line — drop the whole chunk
      discarding = false
      pos = nl + 1
    }
    while (pos < chunk.length) {
      const nl = chunk.indexOf(LF, pos)
      if (nl === -1) {
        // No terminator in the remainder: retain it, but only if it keeps the line within the cap.
        if (pending + (chunk.length - pos) > cap) {
          opts.onFrame({ kind: 'protocolError', detail: 'line exceeded maxLineBytes' })
          resetLine()
          discarding = true
        } else if (chunk.length > pos) {
          const seg = chunk.subarray(pos, chunk.length)
          segments.push(seg)
          pending += seg.length
        }
        return
      }
      // A complete line spans the retained segments + chunk[pos..nl]; its terminator is this newline.
      if (pending + (nl - pos) > cap) {
        opts.onFrame({ kind: 'protocolError', detail: 'line exceeded maxLineBytes' })
        resetLine() // the line is already terminated here — no discard state needed
      } else {
        const line = assemble(chunk, pos, nl)
        resetLine()
        decodeLine(line)
      }
      pos = nl + 1
    }
  }

  return {
    push(chunk) {
      if (!ended) consume(chunk)
    },
    end() {
      if (ended) return
      ended = true
      if (!discarding && pending > 0) {
        opts.onFrame({
          kind: 'malformed',
          raw: new TextDecoder().decode(assemble(new Uint8Array(0), 0, 0)),
          detail: 'unterminated line at EOF',
        })
      }
      resetLine()
      discarding = false
    },
  }
}
