/**
 * Flydrive-backed spooled artifact storage for Node and server runtimes.
 *
 * @module @nhtio/adk/batteries/storage/flydrive
 *
 * @remarks
 * **Requires Node 24+.** `flydrive` uses the `node:stream` `ReadableStream` web API which is
 * only available from Node 24. This battery does not work in the browser or earlier Node versions.
 *
 * Opt-in storage battery backed by [flydrive](https://flydrive.dev). Provides
 * {@link FlydriveSpoolReader} (a {@link @nhtio/adk!SpoolReader} over a flydrive key) and
 * {@link FlydriveSpoolStore} (a `write(callId, bytes) → reader` persistence layer that wraps an
 * existing `Disk`).
 *
 * The reader has two modes selected at construction time based on the size of the underlying
 * object:
 *
 * - **Eager mode** — when the object's `contentLength` is below `streamThresholdBytes` (default
 *   10 MiB), the reader calls `disk.get(key)` once, splits the content on `\n`, and caches
 *   lines + byte count. All subsequent `line() / byteLength() / lineCount()` calls resolve from
 *   memory.
 * - **Streaming mode** — when `contentLength` meets or exceeds the threshold, the reader
 *   streams the file once via `disk.getStream(key)` to build a line-offset index (`number[]`
 *   of byte offsets per line), then serves each `line(i)` request by streaming the byte range
 *   `[offsets[i], offsets[i+1])`. Caps RAM at one index + one line buffer regardless of file
 *   size.
 *
 * Set `streamThresholdBytes: 0` to force streaming mode; set it to `Infinity` to force eager
 * mode. The default of 10 MiB matches typical tool output sizes — tune it for your workload.
 *
 * The store and reader are pure-flydrive: they don't know about S3, GCS, or filesystem
 * specifically — they delegate to whatever `Disk` you construct.
 */

import { Disk } from 'flydrive'
import { Readable } from 'node:stream'
import { isInstanceOf } from '@nhtio/adk/guards'
import type { ReaderDescriptor, SpoolReader, SpoolStore } from '@nhtio/adk/common'

/**
 * Resolver tag for the flydrive spool reader handle. The locator carries the flydrive `key`; the live
 * `Disk` binding is re-injected by the consumer-registered resolver on decode (the key alone cannot
 * re-open the object store).
 */
export const SPOOL_READER_TAG_FLYDRIVE = 'spool:flydrive'

const DEFAULT_STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024 // 10 MiB

const LF = 0x0a // '\n'

/**
 * Constructor options for {@link FlydriveSpoolReader}.
 */
export interface FlydriveSpoolReaderOptions {
  /**
   * Byte-length threshold that switches between eager and streaming modes.
   *
   * @remarks
   * - Below the threshold → eager (whole-file in memory).
   * - At or above the threshold → streaming (line-offset index + per-line streaming reads).
   *
   * Set to `0` to force streaming mode; set to `Number.POSITIVE_INFINITY` to force eager mode.
   *
   * @defaultValue `10 * 1024 * 1024` (10 MiB)
   */
  streamThresholdBytes?: number
}

interface EagerState {
  mode: 'eager'
  lines: string[]
  bytes: number
  content: string
}

interface StreamingState {
  mode: 'streaming'
  /**
   * Byte offsets where each line *starts*. Length equals lineCount + 1; the final entry equals
   * the total byte length. So `offsets[i + 1] - offsets[i]` is the byte length of line `i`
   * including any trailing `\n`.
   */
  offsets: number[]
  bytes: number
}

type ReaderState = EagerState | StreamingState

const isNonNegativeFiniteNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * Reads a flydrive-backed file as a {@link @nhtio/adk!SpoolReader}.
 *
 * @remarks
 * Constructor is **not** async — but the first method call awaits a private readiness promise
 * that fetches the object's metadata (and in eager mode, its contents). Subsequent calls reuse
 * the cached state. This keeps construction call sites synchronous while still doing real I/O
 * lazily.
 *
 * Implementations of {@link @nhtio/adk!SpoolReader.line}, {@link @nhtio/adk!SpoolReader.byteLength}, and
 * {@link @nhtio/adk!SpoolReader.lineCount} all return promises. The `SpoolReader` contract supports both
 * sync and async return; consumers of `SpooledArtifact` handle either.
 */
export class FlydriveSpoolReader implements SpoolReader {
  readonly #disk: Disk
  readonly #key: string
  readonly #threshold: number
  #ready: Promise<ReaderState> | undefined

  constructor(disk: Disk, key: string, opts: FlydriveSpoolReaderOptions = {}) {
    this.#disk = disk
    this.#key = key
    const raw = opts.streamThresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES
    // Allow `Infinity` (forces eager) but reject anything non-finite-negative.
    if (typeof raw !== 'number' || Number.isNaN(raw) || raw < 0) {
      throw new TypeError(
        `FlydriveSpoolReader: streamThresholdBytes must be a non-negative number or Infinity, got ${String(raw)}`
      )
    }
    this.#threshold = raw
  }

  async line(index: number): Promise<string | undefined> {
    const state = await this.#load()
    if (state.mode === 'eager') return state.lines[index]
    if (index < 0 || index >= state.offsets.length - 1) return undefined
    return this.#readRange(state.offsets[index], state.offsets[index + 1])
  }

  async byteLength(): Promise<number> {
    const state = await this.#load()
    return state.bytes
  }

  async lineCount(): Promise<number> {
    const state = await this.#load()
    return state.mode === 'eager' ? state.lines.length : state.offsets.length - 1
  }

  /**
   * Returns the full underlying content as a single decoded string, byte-faithful to the source.
   *
   * @remarks
   * In **eager mode** the content is already cached at construction-time load and this method is
   * effectively a property access. In **streaming mode** there is no cache: the file is
   * re-streamed and concatenated on every call. Use {@link @nhtio/adk!SpooledArtifact.asString} judiciously
   * on large streaming-mode artifacts.
   */
  async readAll(): Promise<string> {
    const state = await this.#load()
    if (state.mode === 'eager') return state.content
    const stream = await this.#disk.getStream(this.#key)
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      // eslint-disable-next-line adk/use-is-instance-of -- native built-in narrowing on stream chunks; cross-realm fragility does not apply here
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      chunks.push(view)
      total += view.length
    }
    const concat = new Uint8Array(total)
    let offset = 0
    for (const view of chunks) {
      concat.set(view, offset)
      offset += view.length
    }
    return new TextDecoder().decode(concat)
  }

  describe(): ReaderDescriptor {
    // The flydrive key is the re-openable locator. The live `Disk` is NOT serialised — the
    // consumer-registered resolver re-injects it on decode (see registerSpoolReaderResolver).
    return {
      tag: SPOOL_READER_TAG_FLYDRIVE,
      locator: { key: this.#key, streamThresholdBytes: this.#threshold },
    }
  }

  /**
   * Lazily initialise the reader's mode-specific state. Called by every public method; the
   * promise is cached so the work runs at most once.
   */
  #load(): Promise<ReaderState> {
    if (!this.#ready) this.#ready = this.#init()
    return this.#ready
  }

  async #init(): Promise<ReaderState> {
    const meta = await this.#disk.getMetaData(this.#key)
    const bytes = meta.contentLength
    if (!isNonNegativeFiniteNumber(bytes)) {
      // Defensive — flydrive's contract types this as `number`, but cloud drivers occasionally
      // return NaN/Infinity if the backing store omits the size header.
      throw new Error(
        `FlydriveSpoolReader: disk returned a non-finite contentLength (${String(bytes)}) for key "${this.#key}"`
      )
    }
    if (bytes < this.#threshold) {
      // Eager — pull the whole thing into memory.
      const content = await this.#disk.get(this.#key)
      const lines = content === '' ? [] : content.split('\n')
      return { mode: 'eager', lines, bytes, content }
    }
    // Streaming — build a line-offset index by scanning bytes once.
    return this.#buildStreamingIndex(bytes)
  }

  async #buildStreamingIndex(bytes: number): Promise<StreamingState> {
    // Edge case first — an empty file is one offset (the EOF), zero lines.
    if (bytes === 0) return { mode: 'streaming', offsets: [0], bytes }

    const stream = await this.#disk.getStream(this.#key)
    // offsets[i] is the byte position where line `i` starts. offsets[lineCount] is one-past-end.
    // For "a\nb\nc" → offsets=[0, 2, 4, 5] (3 lines).
    // For "a\nb\n"  → offsets=[0, 2, 4, 4] (3 lines, last is the trailing empty line). This
    // mirrors `String.prototype.split('\n')` semantics so streaming and eager agree.
    const offsets: number[] = [0]
    let position = 0
    let lastByte = -1
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      // eslint-disable-next-line adk/use-is-instance-of -- native built-in narrowing on stream chunks; cross-realm fragility does not apply here
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      for (const byte of view) {
        position++
        if (byte === LF) offsets.push(position)
        lastByte = byte
      }
    }
    // If the file ends on a newline, the byte after the LF is the start of an empty trailing
    // line — record it. If it doesn't, the final line's end is the EOF and we need to push
    // it so line(N-1) can read up to bytes.
    if (lastByte === LF) offsets.push(position)
    else if (offsets[offsets.length - 1] !== position) offsets.push(position)
    return { mode: 'streaming', offsets, bytes }
  }

  /**
   * Streams the byte range `[start, end)` from the backing disk and returns it as a UTF-8
   * string, stripping a trailing `\n` if present.
   *
   * @remarks
   * flydrive doesn't expose native byte-range reads, so we open a fresh stream and skip until
   * we reach the requested start offset, then collect until we reach `end`. This is O(end)
   * per call — fine for occasional reads but worth profiling if a workload performs many
   * sequential `line()` calls on a large file.
   */
  async #readRange(start: number, end: number): Promise<string> {
    if (start === end) return ''
    const stream = await this.#disk.getStream(this.#key)
    const out: number[] = []
    let position = 0
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      // eslint-disable-next-line adk/use-is-instance-of -- native built-in narrowing on stream chunks; cross-realm fragility does not apply here
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      // Past the range entirely → stop early
      if (position >= end) {
        // Destroy the stream if it's a Node Readable; otherwise the for-await will naturally
        // continue, costing extra reads we don't need.
        // eslint-disable-next-line adk/use-is-instance-of -- native Node built-in; flydrive returns a real Readable, no cross-realm risk
        if (stream instanceof Readable) stream.destroy()
        break
      }
      // Fully before the range → skip the whole chunk
      if (position + view.length <= start) {
        position += view.length
        continue
      }
      // Partial overlap — copy the bytes that fall inside [start, end)
      const localStart = Math.max(0, start - position)
      const localEnd = Math.min(view.length, end - position)
      for (let i = localStart; i < localEnd; i++) out.push(view[i])
      position += view.length
    }
    // Strip the trailing newline if the range ended on one. The line-offset index ends each
    // line *after* its terminating LF (so offsets[i+1] points to the start of the next line),
    // and the SpoolReader contract returns lines *without* their trailing newline.
    if (out.length > 0 && out[out.length - 1] === LF) out.pop()
    return new TextDecoder().decode(new Uint8Array(out))
  }
}

/**
 * Constructor options for {@link FlydriveSpoolStore}.
 */
export interface FlydriveSpoolStoreOptions {
  /**
   * Optional key prefix prepended to every `callId`. Useful for namespacing tool-call artifacts
   * inside a shared bucket (e.g. `"tool-calls/"`).
   *
   * @defaultValue `""`
   */
  keyPrefix?: string

  /**
   * Default `streamThresholdBytes` for readers produced by `write()` and `read()`. Individual
   * calls may override via their own `opts` argument.
   *
   * @defaultValue `10 * 1024 * 1024` (10 MiB)
   */
  streamThresholdBytes?: number
}

/**
 * "Give bytes, get a reader" persistence layer over a flydrive {@link Disk}.
 *
 * @remarks
 * `write(callId, bytes)` calls `disk.put(key, bytes)` where `key = keyPrefix + callId`, then
 * returns a fresh {@link FlydriveSpoolReader} pointed at the same key. `read(callId)` returns
 * a reader without re-writing; `delete(callId)` calls `disk.delete(key)`.
 *
 * The store is stateless — it owns no in-memory cache of writes. Multiple `FlydriveSpoolStore`
 * instances sharing the same disk + key prefix see the same data.
 *
 * @example
 * ```ts
 * import { Disk } from 'flydrive'
 * import { FSDriver } from 'flydrive/drivers/fs'
 * import { FlydriveSpoolStore } from '@nhtio/adk/batteries/storage/flydrive'
 *
 * const disk = new Disk(new FSDriver({ location: './tmp', visibility: 'public' }))
 * const store = new FlydriveSpoolStore(disk)
 *
 * const bytes = await tool.executor(ctx)(args)
 * const reader = await store.write(callId, bytes)
 * const Ctor = tool.artifactConstructor?.() ?? SpooledArtifact
 * const artifact = new Ctor(reader)
 * ```
 */
export class FlydriveSpoolStore implements SpoolStore {
  readonly #disk: Disk
  readonly #prefix: string
  readonly #defaultThreshold: number

  constructor(disk: Disk, opts: FlydriveSpoolStoreOptions = {}) {
    this.#disk = disk
    this.#prefix = opts.keyPrefix ?? ''
    this.#defaultThreshold = opts.streamThresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES
  }

  /**
   * Persists `bytes` under `callId` and returns a reader bound to the stored key.
   *
   * @remarks
   * `string`/`Uint8Array` input goes through `disk.put`; `ReadableStream<Uint8Array>` is forwarded
   * to `disk.putStream` (via `Readable.fromWeb`) so the payload streams straight to the backing
   * driver — to disk for `FSDriver`, to the object store for S3/GCS — without being materialized
   * in memory first.
   *
   * @param callId - Identifier used to retrieve the bytes via {@link FlydriveSpoolStore.read}.
   * @param bytes - The bytes to store, as a `string`, `Uint8Array`, or `ReadableStream<Uint8Array>`.
   * @param opts - Per-call override for `streamThresholdBytes`.
   * @returns A {@link FlydriveSpoolReader} over the stored bytes.
   */
  async write(
    callId: string,
    bytes: string | Uint8Array | ReadableStream<Uint8Array>,
    opts?: FlydriveSpoolReaderOptions
  ): Promise<FlydriveSpoolReader> {
    const key = this.#prefix + callId
    if (isInstanceOf(bytes, 'ReadableStream', ReadableStream)) {
      await this.#disk.putStream(
        key,
        Readable.fromWeb(bytes as Parameters<typeof Readable.fromWeb>[0])
      )
    } else {
      await this.#disk.put(key, bytes)
    }
    return new FlydriveSpoolReader(this.#disk, key, {
      streamThresholdBytes: opts?.streamThresholdBytes ?? this.#defaultThreshold,
    })
  }

  /**
   * Returns a reader over the bytes previously written under `callId`.
   *
   * @remarks
   * Returns `undefined` if the underlying key does not exist. Existence is checked via
   * `disk.exists(key)` before the reader is returned, so callers can rely on a defined return
   * value pointing at a real object.
   *
   * @param callId - Identifier supplied to a prior {@link FlydriveSpoolStore.write} call.
   * @param opts - Per-call override for `streamThresholdBytes`.
   * @returns A {@link FlydriveSpoolReader}, or `undefined` if the key is missing.
   */
  async read(
    callId: string,
    opts?: FlydriveSpoolReaderOptions
  ): Promise<FlydriveSpoolReader | undefined> {
    const key = this.#prefix + callId
    if (!(await this.#disk.exists(key))) return undefined
    return new FlydriveSpoolReader(this.#disk, key, {
      streamThresholdBytes: opts?.streamThresholdBytes ?? this.#defaultThreshold,
    })
  }

  /**
   * Removes the entry under `callId`.
   *
   * @param callId - Identifier whose entry should be removed.
   * @returns `true` if the key existed and was removed; `false` if it didn't exist.
   */
  async delete(callId: string): Promise<boolean> {
    const key = this.#prefix + callId
    const existed = await this.#disk.exists(key)
    if (!existed) return false
    await this.#disk.delete(key)
    return true
  }

  /**
   * Returns the full disk key for a given `callId` (i.e. `keyPrefix + callId`).
   *
   * @remarks
   * Useful for tests or for callers that want to interact with the underlying disk directly.
   */
  keyFor(callId: string): string {
    return this.#prefix + callId
  }
}
