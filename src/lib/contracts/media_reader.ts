import { validator } from '@nhtio/validation'
import { passesSchema } from '../utils/validation'
import type { ReaderDescriptor } from './reader_descriptor'

/**
 * Re-openable byte source contract for a Media instance.
 *
 * @remarks
 * Peer to {@link @nhtio/adk!SpoolReader} but tuned for binary streaming rather than line-indexed text.
 * Each `stream()` call must return a fresh, drainable `ReadableStream` over the same underlying
 * bytes — implementations model replay: in-memory readers reconstitute the stream from the
 * buffer, file-backed readers reopen the file handle, HTTP-backed readers re-issue the fetch,
 * cloud blob readers re-issue the GET. The implementor owns the storage and the cost of keeping
 * the underlying source addressable. Implementors whose underlying source is genuinely
 * non-replayable (a raw HTTP body they were handed once) are responsible for caching locally
 * before constructing the Media.
 *
 * Both methods may be synchronous or asynchronous to accommodate both in-memory and I/O-backed
 * implementations without forcing unnecessary promise overhead on simple cases.
 */
export interface MediaReader {
  /**
   * Re-opens the underlying byte source and returns a fresh ReadableStream.
   *
   * @remarks
   * Each call yields a new, drainable stream over the same bytes. Render code that needs the
   * full buffer (e.g. base64-encoding an inline image_url) drains the stream; render code that
   * can forward the stream (e.g. multipart upload) passes the stream through without buffering.
   *
   * @returns A drainable ReadableStream of Uint8Array chunks over the underlying bytes.
   */
  stream(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>

  /**
   * Returns the total number of bytes in the underlying data, or `undefined` if unknown.
   *
   * @remarks
   * Used for telemetry, budget checks, and pre-flight provider size validation without forcing
   * a stream drain. Sources of unknown length may return `undefined` — absence is treated as
   * "unknown", not "zero".
   *
   * @returns The byte length of the underlying data, or `undefined` when unknown.
   */
  byteLength(): number | undefined | Promise<number | undefined>

  /**
   * Optionally emit a serialisable {@link ReaderDescriptor} so a {@link @nhtio/adk!Media} backed by this
   * reader can round-trip through `encode()`/`decode()` as a **handle**.
   *
   * @remarks
   * Synchronous by contract — the encoder's `[ENCODE_METHOD]()` is synchronous and cannot await, so a
   * reader whose handle is only obtainable asynchronously (e.g. draining a `Blob`) must NOT implement
   * this method; encoding such a `Media` throws {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE}. The
   * descriptor describes *where the bytes live* (a key, a URL, or an inlined buffer) — never the live
   * binding (`Disk`, OPFS root, `fetch`), which the matching resolver re-injects on decode.
   *
   * A reader that omits this method is treated as non-describable: the bytes still stream normally at
   * runtime, the `Media` simply cannot be serialised.
   *
   * @returns A tagged, serialisable handle, or `undefined`/absent when the reader cannot describe itself.
   */
  describe?(): ReaderDescriptor | undefined
}

/**
 * Validator schema used to validate a MediaReader value.
 *
 * @remarks
 * Because MediaReader is a structural interface with no associated constructor, validation is
 * duck-typed: the value must be an object, class instance, or function with `stream` and
 * `byteLength` present as callable properties. Arity is not enforced.
 */
export const mediaReaderSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).stream === 'function' &&
      typeof (value as any).byteLength === 'function'
    ) {
      return value as MediaReader
    }
    return helpers.error('any.invalid')
  })

/**
 * Returns `true` if `value` implements the MediaReader interface.
 *
 * @remarks
 * Duck-typed: checks that `value` is non-null with `stream` and `byteLength` as callable
 * functions. Does not use `instanceof` — there is no MediaReader constructor.
 *
 * @param value - The value to test.
 * @returns `true` when `value` conforms to the MediaReader interface.
 */
export const implementsMediaReader = (value: unknown): value is MediaReader => {
  return passesSchema(mediaReaderSchema, value)
}
