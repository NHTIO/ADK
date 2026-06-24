import { validator } from '@nhtio/validation'
import { passesSchema } from '../utils/validation'
import type { ReaderDescriptor } from './reader_descriptor'

/**
 * Backing store contract for a {@link @nhtio/adk!SpooledArtifact}.
 *
 * @remarks
 * Implementations may read from memory, a file handle, a network stream, or any other byte
 * source. The interface is intentionally minimal — the artifact layer handles all higher-level
 * operations (`head`, `tail`, `grep`, etc.) by composing calls to these three primitives.
 *
 * Line indexing is 0-based. Implementations must return `undefined` from {@link SpoolReader.line}
 * when the index is out of range rather than throwing.
 *
 * All three methods may be synchronous or asynchronous to accommodate both in-memory and I/O-
 * backed implementations without forcing unnecessary promise overhead on simple cases.
 */
export interface SpoolReader {
  /**
   * Returns the line at the given 0-based index, or `undefined` when out of range.
   *
   * @param index - 0-based line index.
   * @returns The raw line string (without trailing newline), or `undefined`.
   */
  line(index: number): string | undefined | Promise<string | undefined>

  /**
   * Returns the total number of bytes in the underlying data.
   *
   * @remarks
   * Used for reporting and token-estimation purposes. Byte length is distinct from character
   * length for multi-byte encodings.
   *
   * @returns The byte length of the underlying data.
   */
  byteLength(): number | Promise<number>

  /**
   * Returns the total number of lines in the underlying data.
   *
   * @remarks
   * Required so consumers know when to stop iterating; the line count must remain stable for the
   * lifetime of the reader.
   *
   * @returns The total line count.
   */
  lineCount(): number | Promise<number>

  /**
   * Returns the full underlying content as a single decoded string, byte-faithful to the source.
   *
   * @remarks
   * Unlike {@link SpoolReader.line}, this method preserves trailing newlines and any non-`\n`
   * line terminators (e.g. `\r\n`) present in the original bytes. It is the primitive that
   * powers `SpooledArtifact.asString()` — the round-trip-faithful alternative to assembling
   * the artifact body from per-line reads.
   *
   * Implementations should make this O(n) in the size of the underlying data and may cache the
   * result if the read source is durable. Streaming implementations may choose not to cache.
   *
   * @returns The full underlying content as a single string.
   */
  readAll(): string | Promise<string>

  /**
   * Optionally emit a serialisable {@link ReaderDescriptor} so a {@link @nhtio/adk!SpooledArtifact}
   * backed by this reader can round-trip through `encode()`/`decode()` as a **handle**.
   *
   * @remarks
   * Synchronous by contract — the encoder's `[ENCODE_METHOD]()` is synchronous and cannot await. The
   * descriptor describes *where the bytes live* (a spool key, or an inlined string for in-memory
   * readers) — never the live binding (`Disk`, OPFS root), which the matching resolver re-injects on
   * decode. A reader that omits this method is treated as non-describable: line/text reads still work at
   * runtime, the `SpooledArtifact` simply cannot be serialised, and encoding it throws
   * {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE}.
   *
   * @returns A tagged, serialisable handle, or `undefined`/absent when the reader cannot describe itself.
   */
  describe?(): ReaderDescriptor | undefined
}

/**
 * Validator schema used to validate a {@link SpoolReader} value.
 *
 * @remarks
 * Because `SpoolReader` is a structural interface with no associated constructor, validation is
 * duck-typed: the value must be an object, class instance, or function with `line`, `byteLength`,
 * and `lineCount` present as callable properties. Arity is not enforced — implementations may add
 * optional parameters beyond the contract.
 */
export const spoolReaderSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).line === 'function' &&
      typeof (value as any).byteLength === 'function' &&
      typeof (value as any).lineCount === 'function' &&
      typeof (value as any).readAll === 'function'
    ) {
      return value as SpoolReader
    }
    return helpers.error('any.invalid')
  })

/**
 * Returns `true` if `value` implements the {@link SpoolReader} interface.
 *
 * @remarks
 * Duck-typed: checks that `value` is non-null with `line`, `byteLength`, `lineCount`, and
 * `readAll` as callable functions. Does not use `instanceof` — there is no `SpoolReader`
 * constructor.
 *
 * @param value - The value to test.
 * @returns `true` when `value` conforms to the {@link SpoolReader} interface.
 */
export const implementsSpoolReader = (value: unknown): value is SpoolReader => {
  return passesSchema(spoolReaderSchema, value)
}
