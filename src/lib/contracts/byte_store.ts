import { validator } from '@nhtio/validation'
import { passesSchema } from '../utils/validation'
import type { SpoolReader } from './spool_reader'
import type { MediaReader } from './media_reader'

/**
 * Unified "give bytes, get a reader" persistence contract.
 *
 * @remarks
 * For the purposes of storage there is no meaningful distinction between text and binary — bytes
 * are bytes. `ByteStore` is the single low-level shape every ADK storage layer implements: hand it
 * bytes under an `id`, get back a replayable reader `R`; read or delete by the same `id` later. The
 * generic `R` is the reader the store hands out — different reader contracts (line-indexed
 * {@link @nhtio/adk!SpoolReader} vs binary-streamed {@link @nhtio/adk!MediaReader}) are
 * distinguished by the `R` instantiation, not by separate store interfaces. See the {@link SpoolStore}
 * and {@link MediaStore} aliases for the two concrete semantics.
 *
 * `write` accepts a `string`, a `Uint8Array`, or a `ReadableStream<Uint8Array>`. The stream form is
 * the point of the contract: a durable store can persist an arbitrarily large payload straight to
 * disk/object storage without first materializing it in memory. **String input is encoded as
 * UTF-8.** The returned reader is only guaranteed readable once the `write` result has resolved.
 *
 * All three methods may be synchronous or asynchronous so that in-memory implementations are not
 * forced to pay promise overhead while I/O-backed implementations stay async. Note that any
 * implementation accepting a `ReadableStream` must return a `Promise` for that input — draining a
 * stream cannot be synchronous.
 */
export interface ByteStore<R> {
  /**
   * Persists `bytes` under `id` and returns a reader over them.
   *
   * @remarks
   * Re-writing the same `id` replaces the prior entry. `string` input is encoded as UTF-8;
   * `Uint8Array` and `ReadableStream<Uint8Array>` are stored byte-faithfully. Stream input
   * necessarily resolves asynchronously.
   *
   * @param id - Identifier used to retrieve or delete the bytes later.
   * @param bytes - The payload, as a `string`, `Uint8Array`, or `ReadableStream<Uint8Array>`.
   * @returns A reader over the stored bytes (or a `Promise` of one).
   */
  write(id: string, bytes: string | Uint8Array | ReadableStream<Uint8Array>): R | Promise<R>

  /**
   * Returns a reader over the bytes previously written under `id`, or `undefined` if no entry
   * exists.
   *
   * @param id - Identifier supplied to a prior {@link ByteStore.write} call.
   * @returns A reader over the stored bytes, `undefined`, or a `Promise` of either.
   */
  read(id: string): R | undefined | Promise<R | undefined>

  /**
   * Removes the entry under `id`.
   *
   * @param id - Identifier whose entry should be removed.
   * @returns `true` if an entry existed and was removed; `false` otherwise (or a `Promise` of one).
   */
  delete(id: string): boolean | Promise<boolean>
}

/**
 * A {@link ByteStore} that hands out line-indexed text readers ({@link @nhtio/adk!SpoolReader}).
 *
 * @remarks
 * The store backing tool-output artifacts. Stored bytes are decoded as UTF-8 text for line-oriented
 * reads; binary input is stored byte-faithfully but `SpoolReader.readAll()` interprets it as text,
 * so opaque binary belongs in a {@link MediaStore} / `Media`, not here.
 */
export type SpoolStore = ByteStore<SpoolReader>

/**
 * A {@link ByteStore} that hands out binary-streamed readers ({@link @nhtio/adk!MediaReader}).
 *
 * @remarks
 * The store backing persisted media bytes. Stored bytes are opaque and replayable via
 * `MediaReader.stream()`; no text decoding is implied.
 */
export type MediaStore = ByteStore<MediaReader>

/**
 * Validator schema used to validate a {@link ByteStore} value.
 *
 * @remarks
 * Because `ByteStore` is a structural interface with no associated constructor, validation is
 * duck-typed: the value must be non-null with `write`, `read`, and `delete` present as callable
 * properties. Arity is not enforced — implementations may add optional parameters beyond the
 * contract. The reader type `R` cannot be checked structurally here; conformance of the reader is
 * the caller's concern at the point of use.
 */
export const byteStoreSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).write === 'function' &&
      typeof (value as any).read === 'function' &&
      typeof (value as any).delete === 'function'
    ) {
      return value
    }
    return helpers.error('any.invalid')
  })

/**
 * Returns `true` if `value` implements the {@link ByteStore} interface.
 *
 * @remarks
 * Duck-typed: checks that `value` is non-null with `write`, `read`, and `delete` as callable
 * functions. Does not use `instanceof` — there is no `ByteStore` constructor.
 *
 * @param value - The value to test.
 * @returns `true` when `value` conforms to the {@link ByteStore} interface.
 */
export const implementsByteStore = <R = unknown>(value: unknown): value is ByteStore<R> => {
  return passesSchema(byteStoreSchema, value)
}
