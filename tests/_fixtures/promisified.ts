import type { SpoolReader } from '../../src/lib/contracts/spool_reader'

/**
 * Wraps a synchronous {@link SpoolReader} so every method returns a promise.
 *
 * @remarks
 * Useful for exercising the async branch of `SpooledArtifact`'s logic without needing a real
 * async backing store. Each call resolves immediately on the microtask queue — there is no
 * artificial delay.
 *
 * The wrapper is duck-typed: any object exposing `line`, `byteLength`, `lineCount`, and
 * `readAll` as callable properties qualifies; the helper does not check
 * `instanceof InMemorySpoolReader` or similar. This lets it wrap any future `SpoolReader`
 * implementation without modification.
 */
export const promisify = (reader: SpoolReader): SpoolReader => ({
  line: async (index: number) => reader.line(index),
  byteLength: async () => reader.byteLength(),
  lineCount: async () => reader.lineCount(),
  readAll: async () => reader.readAll(),
})
