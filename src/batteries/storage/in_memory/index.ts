/**
 * In-memory spool readers and stores for tests, scripts, and non-durable prototypes.
 *
 * @module @nhtio/adk/batteries/storage/in_memory
 *
 * @remarks
 * Opt-in in-memory persistence battery. Provides {@link InMemorySpoolReader} (a sync
 * {@link @nhtio/adk!SpoolReader} over a string) plus {@link InMemorySpoolStore} (a `Map<callId, bytes>`
 * with a `write()` method that returns a fresh reader bound to the stored bytes).
 *
 * Use this when:
 *
 * - Writing unit or functional tests that need a real `SpoolReader` over known bytes.
 * - Running a REPL or one-shot script where persistence beyond the process lifetime is not
 *   needed.
 * - Prototyping an agent before deciding on a real disk/object-store-backed persistence layer.
 *
 * Do **not** use this for production agents that need durability across process restarts —
 * everything lives in process memory and is lost on exit.
 */

import { isInstanceOf } from '@nhtio/adk/guards'
import type { SpoolReader, SpoolStore } from '@nhtio/adk/common'

/**
 * Sync in-memory {@link @nhtio/adk!SpoolReader} over a byte-faithful `Uint8Array` body.
 *
 * @remarks
 * Stores the raw bytes and decodes them as UTF-8 once at construction, then splits the decoded
 * string on `\n` and caches the resulting line array. All four `SpoolReader` methods resolve
 * synchronously from the cache — no I/O happens after construction. `byteLength()` reports the
 * true stored byte count (not the decoded character count), so it stays correct for multi-byte
 * content; `line()`/`readAll()` operate on the decoded text.
 *
 * The reader accepts a `string` or a `Uint8Array`. A `string` is encoded as UTF-8 for the byte
 * count; a `Uint8Array` is held byte-faithfully (no lossy re-encode) and decoded for text reads.
 *
 * Empty input yields a reader with `lineCount() === 0` and `byteLength() === 0`. A trailing
 * newline produces a final empty line: `"a\nb\n".split('\n') === ['a', 'b', '']`. This matches
 * the JavaScript `String.prototype.split` contract and lets a `lineCount()` consumer
 * distinguish "two lines, no trailing newline" from "two lines, trailing newline".
 */
export class InMemorySpoolReader implements SpoolReader {
  readonly #content: string
  readonly #lines: string[]
  readonly #bytes: number

  constructor(content: string | Uint8Array) {
    if (typeof content === 'string') {
      this.#content = content
      this.#bytes = new TextEncoder().encode(content).length
    } else {
      this.#content = new TextDecoder().decode(content)
      this.#bytes = content.byteLength
    }
    this.#lines = this.#content === '' ? [] : this.#content.split('\n')
  }

  line(index: number): string | undefined {
    return this.#lines[index]
  }

  byteLength(): number {
    return this.#bytes
  }

  lineCount(): number {
    return this.#lines.length
  }

  readAll(): string {
    return this.#content
  }
}

/**
 * Drains a `ReadableStream<Uint8Array>` into a single concatenated `Uint8Array`.
 *
 * @remarks
 * In-memory storage cannot stream-to-disk, so a stream input is buffered fully — the documented
 * trade-off for {@link InMemorySpoolStore}. Use {@link @nhtio/adk/batteries/storage/opfs!OpfsSpoolStore}
 * or a Flydrive-backed store when true streaming persistence is required.
 */
const drainStream = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * In-memory "give bytes, get a reader" persistence layer keyed by `callId`.
 *
 * @remarks
 * Stores each value byte-faithfully as a `Uint8Array`. `string` inputs are encoded as UTF-8;
 * `Uint8Array` inputs are held verbatim (no lossy text round-trip, so binary payloads survive
 * intact); `ReadableStream<Uint8Array>` inputs are drained fully into a buffer — in-memory storage
 * cannot stream to disk, so the stream form resolves asynchronously and is the documented
 * trade-off for this battery.
 *
 * Each `write()` and each `read()` returns a *fresh* {@link InMemorySpoolReader} — the store
 * owns the bytes, the reader is a view. Mutating the store after handing out a reader does not
 * invalidate the reader.
 *
 * Implements {@link @nhtio/adk!SpoolStore} (i.e. `ByteStore<SpoolReader>`).
 *
 * @example
 * ```ts
 * const store = new InMemorySpoolStore()
 * const bytes = await tool.executor(ctx)(args)
 * const reader = await store.write(callId, bytes)
 * const Ctor = tool.artifactConstructor?.() ?? SpooledArtifact
 * const artifact = new Ctor(reader)
 * ```
 */
export class InMemorySpoolStore implements SpoolStore {
  readonly #entries = new Map<string, Uint8Array>()

  /**
   * Persists `bytes` under `callId` and returns a reader over them.
   *
   * @remarks
   * `string` input is encoded as UTF-8; `Uint8Array` is stored byte-faithfully;
   * `ReadableStream<Uint8Array>` is drained fully (and `write` returns a `Promise`). Re-writing the
   * same `callId` replaces the prior entry; readers handed out before the rewrite continue to view
   * the old bytes (they hold their own snapshot via the `InMemorySpoolReader` constructor).
   *
   * @param callId - Identifier used to retrieve the bytes via {@link InMemorySpoolStore.read}.
   * @param bytes - The bytes to store, as a `string`, `Uint8Array`, or `ReadableStream<Uint8Array>`.
   * @returns A fresh {@link InMemorySpoolReader} bound to the stored bytes — a `Promise` for stream
   *   input, synchronous otherwise.
   */
  write(callId: string, bytes: string): InMemorySpoolReader
  write(callId: string, bytes: Uint8Array): InMemorySpoolReader
  write(callId: string, bytes: ReadableStream<Uint8Array>): Promise<InMemorySpoolReader>
  write(
    callId: string,
    bytes: string | Uint8Array | ReadableStream<Uint8Array>
  ): InMemorySpoolReader | Promise<InMemorySpoolReader>
  write(
    callId: string,
    bytes: string | Uint8Array | ReadableStream<Uint8Array>
  ): InMemorySpoolReader | Promise<InMemorySpoolReader> {
    if (isInstanceOf(bytes, 'ReadableStream', ReadableStream)) {
      return drainStream(bytes).then((buffer) => {
        this.#entries.set(callId, buffer)
        return new InMemorySpoolReader(buffer)
      })
    }
    const buffer = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
    this.#entries.set(callId, buffer)
    return new InMemorySpoolReader(buffer)
  }

  /**
   * Returns a reader over the bytes previously written under `callId`, or `undefined` if the
   * entry has not been written or has been deleted.
   *
   * @param callId - Identifier supplied to a prior {@link InMemorySpoolStore.write} call.
   * @returns A fresh {@link InMemorySpoolReader} bound to the stored bytes, or `undefined`.
   */
  read(callId: string): InMemorySpoolReader | undefined {
    const buffer = this.#entries.get(callId)
    if (buffer === undefined) return undefined
    return new InMemorySpoolReader(buffer)
  }

  /**
   * Removes the entry under `callId`.
   *
   * @param callId - Identifier whose entry should be removed.
   * @returns `true` if an entry existed and was removed; `false` otherwise.
   */
  delete(callId: string): boolean {
    return this.#entries.delete(callId)
  }

  /**
   * Removes every entry from the store.
   *
   * @remarks
   * Existing readers handed out by prior `write()` / `read()` calls remain valid — they hold
   * their own snapshot.
   */
  clear(): void {
    this.#entries.clear()
  }

  /**
   * Returns the number of entries currently in the store.
   */
  get size(): number {
    return this.#entries.size
  }
}
