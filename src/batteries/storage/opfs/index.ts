/**
 * Browser-only Origin Private File System storage for spooled artifacts.
 *
 * @module @nhtio/adk/batteries/storage/opfs
 *
 * @remarks
 * Opt-in **browser-only** storage battery backed by the
 * [Origin Private File System](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system)
 * (OPFS). Provides {@link OpfsSpoolReader} (a {@link @nhtio/adk!SpoolReader} over a `OpfsFileHandle`)
 * and {@link OpfsSpoolStore} (a `write(callId, bytes) → reader` persistence layer that wraps an
 * OPFS directory).
 *
 * The reader has two modes selected lazily on first method invocation based on the size of the
 * underlying file:
 *
 * - **Eager mode** — when `file.size` is below `streamThresholdBytes` (default 10 MiB), the
 *   reader calls `file.text()` once, splits the content on `\n`, and caches lines + byte count.
 *   All subsequent calls resolve from memory.
 * - **Streaming mode** — when `file.size` meets or exceeds the threshold, the reader streams the
 *   file once via `file.stream().getReader()` to build a line-offset index (`number[]` of byte
 *   offsets per line), then serves each `line(i)` request by slicing the underlying `Blob` —
 *   `Blob.slice(start, end).text()` decodes only the requested range, no head-of-file scan.
 *   Caps RAM at one index + one line buffer regardless of file size.
 *
 * The store auto-selects its write API by execution scope:
 *
 * - In **worker scopes** (`self instanceof WorkerGlobalScope`), it acquires a
 *   `FileSystemSyncAccessHandle` and writes synchronously. Sync handles are the only API
 *   available in workers and the fastest path for the spool-write hot path.
 * - On the **main thread**, it uses `OpfsFileHandle.createWritable()` and the async
 *   stream API. Sync access handles are not exposed on the main thread.
 *
 * This module assumes a browser-equivalent runtime — `navigator.storage`,
 * `OpfsFileHandle`, `TextEncoder`/`TextDecoder`, and `Blob` must all exist. It must not
 * be imported from Node code; do so and you will fail at resolve time when `navigator` is
 * referenced.
 *
 * @example
 * ```ts
 * import { OpfsSpoolStore } from '@nhtio/adk/batteries/storage/opfs'
 *
 * const store = new OpfsSpoolStore({ keyPrefix: 'agent-runs/' })
 * const reader = await store.write(callId, bytes)
 * const Ctor = tool.artifactConstructor?.() ?? SpooledArtifact
 * const artifact = new Ctor(reader)
 * ```
 */

import { isInstanceOf } from '@nhtio/adk/guards'
import type { SpoolReader } from '@nhtio/adk/common'

// The project's tsconfig limits `lib` to `ESNext`, so the DOM and File System Access types
// referenced below are not in scope by default — neither `tsc --noEmit` nor the downstream dts
// pipeline (api-extractor) can see them. Re-declare here the **minimum** surface this module
// touches via a local handle-shape interface. Public API uses `OpfsFileHandle` /
// `OpfsDirectoryHandle` instead of the DOM globals so the published `.d.ts` is self-contained
// and consumers do not have to chase the lib graph.

/**
 * Minimal subset of the
 * [File System Access](https://developer.mozilla.org/docs/Web/API/File_System_API)
 * `OpfsFileHandle` interface that this module touches at runtime. Structurally compatible
 * with the DOM-lib `OpfsFileHandle` — at call sites you pass real OPFS handles directly.
 */
export interface OpfsFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<OpfsFile>
  createWritable(): Promise<OpfsWritableFileStream>
}

/**
 * Minimal subset of the
 * [File System Access](https://developer.mozilla.org/docs/Web/API/File_System_API)
 * `OpfsDirectoryHandle` interface that this module touches at runtime. Structurally
 * compatible with the DOM-lib `OpfsDirectoryHandle` — at call sites you pass real OPFS
 * handles directly.
 */
export interface OpfsDirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
}

/**
 * Minimal subset of the DOM `FileSystemWritableFileStream` interface used by the OPFS battery's
 * main-thread write path.
 */
export interface OpfsWritableFileStream {
  write(data: Uint8Array | ArrayBufferView | ArrayBuffer | string): Promise<void>
  close(): Promise<void>
}

/**
 * Minimal subset of the DOM `Blob` interface used by {@link OpfsSpoolReader} streaming-mode
 * random-access reads. Real OPFS handles return a `File` here; we narrow to the methods we
 * actually call.
 */
export interface OpfsBlob {
  readonly size: number
  slice(start?: number, end?: number, contentType?: string): OpfsBlob
  text(): Promise<string>
  stream(): OpfsReadableStream
}

/**
 * Minimal subset of the DOM `File` interface used by {@link OpfsSpoolReader}.
 */
export interface OpfsFile extends OpfsBlob {
  readonly name: string
}

/**
 * Minimal subset of the DOM `ReadableStream<Uint8Array>` interface used by streaming-mode
 * index construction.
 */
export interface OpfsReadableStream {
  getReader(): OpfsReadableStreamReader
}

/**
 * Minimal subset of the DOM `ReadableStreamDefaultReader<Uint8Array>` interface used by
 * streaming-mode index construction.
 */
export interface OpfsReadableStreamReader {
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value: undefined }>
  releaseLock(): void
}

declare const navigator: {
  storage: { getDirectory(): Promise<OpfsDirectoryHandle> }
}
declare class TextEncoder {
  encode(input?: string): Uint8Array
}
declare const self: unknown
declare const WorkerGlobalScope: { new (): unknown } | undefined

interface FileSystemSyncAccessHandle {
  truncate(newSize: number): void
  write(buffer: Uint8Array | ArrayBuffer | ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
}
interface OpfsFileHandleWithSyncAccess extends OpfsFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
}

const DEFAULT_STREAM_THRESHOLD_BYTES = 10 * 1024 * 1024 // 10 MiB

const LF = 0x0a // '\n'

const isNonNegativeFiniteNumber = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * Constructor options for {@link OpfsSpoolReader}.
 */
export interface OpfsSpoolReaderOptions {
  /**
   * Byte-length threshold that switches between eager and streaming modes.
   *
   * @remarks
   * - Below the threshold → eager (whole-file in memory).
   * - At or above the threshold → streaming (line-offset index + per-line slice reads).
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
  file: OpfsFile
  /**
   * Byte offsets where each line *starts*. Length equals lineCount + 1; the final entry equals
   * the total byte length. So `offsets[i + 1] - offsets[i]` is the byte length of line `i`
   * including any trailing `\n`.
   */
  offsets: number[]
  bytes: number
}

type ReaderState = EagerState | StreamingState

/**
 * Returns `true` when the current global scope is a Web Worker (`DedicatedWorkerGlobalScope`,
 * `SharedWorkerGlobalScope`, or `ServiceWorkerGlobalScope` all inherit from `WorkerGlobalScope`).
 *
 * @remarks
 * The check is needed at runtime because `FileSystemSyncAccessHandle` is only exposed in worker
 * scopes — calling it from the main thread throws. We pick the write strategy based on the
 * answer here.
 *
 * @internal
 */
const isWorkerScope = (): boolean => {
  if (typeof WorkerGlobalScope === 'undefined') return false
  // eslint-disable-next-line adk/use-is-instance-of -- native built-in narrowing on `self`; no cross-realm risk
  return self instanceof WorkerGlobalScope
}

/**
 * Reads an OPFS-backed file as a {@link @nhtio/adk!SpoolReader}.
 *
 * @remarks
 * Constructor is **not** async — but the first method call awaits a private readiness promise
 * that fetches the underlying `File` (and in eager mode, its contents). Subsequent calls reuse
 * the cached state. This keeps construction call sites synchronous while still doing real I/O
 * lazily.
 *
 * All four `SpoolReader` methods on this reader return promises. The `SpoolReader` contract
 * supports both sync and async return; consumers of `SpooledArtifact` handle either.
 */
export class OpfsSpoolReader implements SpoolReader {
  readonly #handle: OpfsFileHandle
  readonly #threshold: number
  #ready: Promise<ReaderState> | undefined

  constructor(handle: OpfsFileHandle, opts: OpfsSpoolReaderOptions = {}) {
    this.#handle = handle
    const raw = opts.streamThresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES
    // Allow `Infinity` (forces eager) but reject anything non-finite-negative.
    if (typeof raw !== 'number' || Number.isNaN(raw) || raw < 0) {
      throw new TypeError(
        `OpfsSpoolReader: streamThresholdBytes must be a non-negative number or Infinity, got ${String(raw)}`
      )
    }
    this.#threshold = raw
  }

  /**
   * Returns `true` if `value` is an {@link OpfsSpoolReader} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an {@link OpfsSpoolReader} instance.
   */
  public static isOpfsSpoolReader(value: unknown): value is OpfsSpoolReader {
    return isInstanceOf(value, 'OpfsSpoolReader', OpfsSpoolReader)
  }

  async line(index: number): Promise<string | undefined> {
    const state = await this.#load()
    if (state.mode === 'eager') return state.lines[index]
    if (index < 0 || index >= state.offsets.length - 1) return undefined
    return this.#readRange(state.file, state.offsets[index], state.offsets[index + 1])
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
   * In **eager mode** the content is already cached at first-call load and this method is
   * effectively a property access. In **streaming mode** there is no cache: the file is re-read
   * (as a single `File.text()` call) on every invocation. Use `SpooledArtifact.asString()`
   * judiciously on large streaming-mode artifacts.
   */
  async readAll(): Promise<string> {
    const state = await this.#load()
    if (state.mode === 'eager') return state.content
    return state.file.text()
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
    const file = await this.#handle.getFile()
    const bytes = file.size
    if (!isNonNegativeFiniteNumber(bytes)) {
      throw new Error(`OpfsSpoolReader: file handle returned a non-finite size (${String(bytes)})`)
    }
    if (bytes < this.#threshold) {
      // Eager — pull the whole thing into memory.
      const content = await file.text()
      const lines = content === '' ? [] : content.split('\n')
      return { mode: 'eager', lines, bytes, content }
    }
    // Streaming — build a line-offset index by scanning bytes once.
    return this.#buildStreamingIndex(file, bytes)
  }

  async #buildStreamingIndex(file: OpfsFile, bytes: number): Promise<StreamingState> {
    // Edge case first — an empty file is one offset (the EOF), zero lines.
    if (bytes === 0) return { mode: 'streaming', file, offsets: [0], bytes }

    // offsets[i] is the byte position where line `i` starts. offsets[lineCount] is one-past-end.
    // For "a\nb\nc" → offsets=[0, 2, 4, 5] (3 lines).
    // For "a\nb\n"  → offsets=[0, 2, 4, 4] (3 lines, last is the trailing empty line). This
    // mirrors `String.prototype.split('\n')` semantics so streaming and eager agree.
    const offsets: number[] = [0]
    let position = 0
    let lastByte = -1
    const reader = file.stream().getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const byte of value) {
          position++
          if (byte === LF) offsets.push(position)
          lastByte = byte
        }
      }
    } finally {
      reader.releaseLock()
    }
    // If the file ends on a newline, the byte after the LF is the start of an empty trailing
    // line — record it. If it doesn't, the final line's end is the EOF and we need to push
    // it so line(N-1) can read up to bytes.
    if (lastByte === LF) offsets.push(position)
    else if (offsets[offsets.length - 1] !== position) offsets.push(position)
    return { mode: 'streaming', file, offsets, bytes }
  }

  /**
   * Slices the byte range `[start, end)` from the backing file and returns it as a UTF-8
   * string, stripping a trailing `\n` if present.
   *
   * @remarks
   * `Blob.slice` is O(1) metadata; `Blob.text()` only decodes the slice. The line-offset index
   * brackets each line *with* its trailing LF (so `offsets[i+1]` points at the start of the
   * next line) and the `SpoolReader` contract returns lines *without* their trailing newline,
   * so we strip a single trailing LF if present.
   */
  async #readRange(file: OpfsFile, start: number, end: number): Promise<string> {
    if (start === end) return ''
    const slice = file.slice(start, end)
    const text = await slice.text()
    if (text.length > 0 && text.charCodeAt(text.length - 1) === LF) {
      return text.slice(0, -1)
    }
    return text
  }
}

/**
 * Constructor options for {@link OpfsSpoolStore}.
 */
export interface OpfsSpoolStoreOptions {
  /**
   * Optional thunk that resolves the {@link OpfsDirectoryHandle} used as the store root.
   *
   * @remarks
   * When omitted, the store resolves the root via `navigator.storage.getDirectory()` on its
   * first filesystem call. Override for tests (to point at a per-suite subdirectory) or to
   * scope the store to a nested directory inside OPFS.
   *
   * The thunk is invoked at most once per store; the returned handle is memoised.
   */
  directory?: () => Promise<OpfsDirectoryHandle>

  /**
   * Optional filename prefix prepended to every `callId`.
   *
   * @remarks
   * Prefix is a **filename prefix**, not a subdirectory — `keyPrefix: 'agent-runs/'` produces
   * a file literally named `agent-runs/<callId>` at the root, not a nested directory. (OPFS
   * filenames may not contain `/`, so use a non-`/` separator like `-` if you want a flat
   * namespace.) This mirrors the `keyPrefix` semantics in the flydrive and in-memory batteries.
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
 * "Give bytes, get a reader" persistence layer over an OPFS directory.
 *
 * @remarks
 * `write(callId, bytes)` resolves the root directory (lazily, on first call), opens or creates
 * the file named `keyPrefix + callId`, then writes via the API matching the current scope:
 * a `FileSystemSyncAccessHandle` in worker scopes, `OpfsFileHandle.createWritable()` on
 * the main thread. A fresh {@link OpfsSpoolReader} pointed at the same file is returned.
 *
 * `read(callId)` returns a reader without re-writing; `delete(callId)` removes the entry.
 *
 * The store is otherwise stateless — it owns no in-memory cache of writes. Multiple
 * `OpfsSpoolStore` instances sharing the same root directory and key prefix see the same data.
 *
 * @example
 * ```ts
 * import { OpfsSpoolStore } from '@nhtio/adk/batteries/storage/opfs'
 *
 * const store = new OpfsSpoolStore({ keyPrefix: 'agent-runs/' })
 *
 * const bytes = await tool.executor(ctx)(args)
 * const reader = await store.write(callId, bytes)
 * const Ctor = tool.artifactConstructor?.() ?? SpooledArtifact
 * const artifact = new Ctor(reader)
 * ```
 */
export class OpfsSpoolStore {
  readonly #resolveRoot: () => Promise<OpfsDirectoryHandle>
  readonly #prefix: string
  readonly #defaultThreshold: number
  #root: OpfsDirectoryHandle | undefined

  constructor(opts: OpfsSpoolStoreOptions = {}) {
    this.#resolveRoot = opts.directory ?? (() => navigator.storage.getDirectory())
    this.#prefix = opts.keyPrefix ?? ''
    this.#defaultThreshold = opts.streamThresholdBytes ?? DEFAULT_STREAM_THRESHOLD_BYTES
  }

  /**
   * Returns `true` if `value` is an {@link OpfsSpoolStore} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an {@link OpfsSpoolStore} instance.
   */
  public static isOpfsSpoolStore(value: unknown): value is OpfsSpoolStore {
    return isInstanceOf(value, 'OpfsSpoolStore', OpfsSpoolStore)
  }

  /**
   * Persists `bytes` under `callId` and returns a reader bound to the stored key.
   *
   * @param callId - Identifier used to retrieve the bytes via {@link OpfsSpoolStore.read}.
   * @param bytes - The bytes to store, as a `string` or `Uint8Array`.
   * @param opts - Per-call override for `streamThresholdBytes`.
   * @returns An {@link OpfsSpoolReader} over the stored bytes.
   */
  async write(
    callId: string,
    bytes: string | Uint8Array,
    opts?: OpfsSpoolReaderOptions
  ): Promise<OpfsSpoolReader> {
    const name = this.#keyFor(callId)
    const root = await this.#getRoot()
    const handle = await root.getFileHandle(name, { create: true })
    const payload = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    if (isWorkerScope()) {
      await this.#writeViaSyncHandle(handle, payload)
    } else {
      await this.#writeViaWritable(handle, payload)
    }
    return new OpfsSpoolReader(handle, {
      streamThresholdBytes: opts?.streamThresholdBytes ?? this.#defaultThreshold,
    })
  }

  /**
   * Returns a reader over the bytes previously written under `callId`.
   *
   * @remarks
   * Returns `undefined` if the file does not exist.
   *
   * @param callId - Identifier supplied to a prior {@link OpfsSpoolStore.write} call.
   * @param opts - Per-call override for `streamThresholdBytes`.
   * @returns An {@link OpfsSpoolReader}, or `undefined` if the key is missing.
   */
  async read(callId: string, opts?: OpfsSpoolReaderOptions): Promise<OpfsSpoolReader | undefined> {
    const name = this.#keyFor(callId)
    const root = await this.#getRoot()
    let handle: OpfsFileHandle
    try {
      handle = await root.getFileHandle(name)
    } catch (err) {
      if (this.#isNotFoundError(err)) return undefined
      throw err
    }
    return new OpfsSpoolReader(handle, {
      streamThresholdBytes: opts?.streamThresholdBytes ?? this.#defaultThreshold,
    })
  }

  /**
   * Removes the entry under `callId`.
   *
   * @param callId - Identifier whose entry should be removed.
   * @returns `true` if the entry existed and was removed; `false` if it didn't exist.
   */
  async delete(callId: string): Promise<boolean> {
    const name = this.#keyFor(callId)
    const root = await this.#getRoot()
    try {
      await root.removeEntry(name)
      return true
    } catch (err) {
      if (this.#isNotFoundError(err)) return false
      throw err
    }
  }

  /**
   * Returns `true` if a file is present under `callId`.
   *
   * @param callId - Identifier to test.
   * @returns `true` when the file exists, `false` otherwise.
   */
  async has(callId: string): Promise<boolean> {
    const name = this.#keyFor(callId)
    const root = await this.#getRoot()
    try {
      await root.getFileHandle(name)
      return true
    } catch (err) {
      if (this.#isNotFoundError(err)) return false
      throw err
    }
  }

  /**
   * Returns the full filename for a given `callId` (i.e. `keyPrefix + callId`).
   *
   * @remarks
   * Useful for tests or for callers that want to interact with the underlying OPFS directory
   * directly.
   */
  keyFor(callId: string): string {
    return this.#keyFor(callId)
  }

  #keyFor(callId: string): string {
    return this.#prefix + callId
  }

  async #getRoot(): Promise<OpfsDirectoryHandle> {
    if (!this.#root) this.#root = await this.#resolveRoot()
    return this.#root
  }

  async #writeViaSyncHandle(handle: OpfsFileHandle, payload: Uint8Array): Promise<void> {
    const sync = await (handle as OpfsFileHandleWithSyncAccess).createSyncAccessHandle()
    try {
      sync.truncate(0)
      sync.write(payload, { at: 0 })
      sync.flush()
    } finally {
      sync.close()
    }
  }

  async #writeViaWritable(handle: OpfsFileHandle, payload: Uint8Array): Promise<void> {
    const writable = await handle.createWritable()
    try {
      await writable.write(payload)
    } finally {
      await writable.close()
    }
  }

  #isNotFoundError(err: unknown): boolean {
    if (err === null || typeof err !== 'object') return false
    const name = (err as { name?: unknown }).name
    return name === 'NotFoundError'
  }
}
