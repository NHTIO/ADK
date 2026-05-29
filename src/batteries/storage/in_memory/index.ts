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

import type { SpoolReader } from '@nhtio/adk/common'

/**
 * Sync in-memory {@link @nhtio/adk!SpoolReader} over a `string` body.
 *
 * @remarks
 * Splits the supplied content on `\n` at construction time and caches the resulting line array
 * plus the UTF-8 byte length. All three `SpoolReader` methods resolve synchronously from the
 * cache — no I/O happens after construction.
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

  constructor(content: string) {
    this.#content = content
    this.#lines = content === '' ? [] : content.split('\n')
    this.#bytes = new TextEncoder().encode(content).length
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
 * In-memory "give bytes, get a reader" persistence layer keyed by `callId`.
 *
 * @remarks
 * Stores the canonical UTF-8 string form of each value. `Uint8Array` inputs are decoded via
 * `TextDecoder` once at write time — subsequent `read()` calls return a reader over the cached
 * string with no further decoding.
 *
 * Each `write()` and each `read()` returns a *fresh* {@link InMemorySpoolReader} — the store
 * owns the bytes, the reader is a view. Mutating the store after handing out a reader does not
 * invalidate the reader.
 *
 * @example
 * ```ts
 * const store = new InMemorySpoolStore()
 * const bytes = await tool.executor(ctx)(args)
 * const reader = store.write(callId, bytes)
 * const Ctor = tool.artifactConstructor?.() ?? SpooledArtifact
 * const artifact = new Ctor(reader)
 * ```
 */
export class InMemorySpoolStore {
  readonly #entries = new Map<string, string>()
  readonly #decoder = new TextDecoder()

  /**
   * Persists `bytes` under `callId` and returns a reader over them.
   *
   * @remarks
   * `Uint8Array` inputs are decoded as UTF-8. Re-writing the same `callId` replaces the prior
   * entry; readers handed out before the rewrite continue to view the old bytes (they hold their
   * own snapshot via the `InMemorySpoolReader` constructor).
   *
   * @param callId - Identifier used to retrieve the bytes via {@link InMemorySpoolStore.read}.
   * @param bytes - The bytes to store, as a `string` or `Uint8Array`.
   * @returns A fresh {@link InMemorySpoolReader} bound to the stored bytes.
   */
  write(callId: string, bytes: string | Uint8Array): InMemorySpoolReader {
    const text = typeof bytes === 'string' ? bytes : this.#decoder.decode(bytes)
    this.#entries.set(callId, text)
    return new InMemorySpoolReader(text)
  }

  /**
   * Returns a reader over the bytes previously written under `callId`, or `undefined` if the
   * entry has not been written or has been deleted.
   *
   * @param callId - Identifier supplied to a prior {@link InMemorySpoolStore.write} call.
   * @returns A fresh {@link InMemorySpoolReader} bound to the stored bytes, or `undefined`.
   */
  read(callId: string): InMemorySpoolReader | undefined {
    const text = this.#entries.get(callId)
    if (text === undefined) return undefined
    return new InMemorySpoolReader(text)
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
