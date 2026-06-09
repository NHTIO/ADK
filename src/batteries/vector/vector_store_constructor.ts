/**
 * @module @nhtio/adk/batteries/vector/vector_store_constructor
 */

import { validator } from '@nhtio/validation'
import type { BaseVectorStore } from './contract'
import type { BaseVectorStoreOptions } from './types'

/**
 * Constructor signature for any {@link BaseVectorStore} adapter (the class itself or a subclass).
 *
 * @remarks
 * Re-declared at the contract level so the factory's `client` resolver can recognise a valid
 * adapter constructor without value-importing {@link BaseVectorStore} into modules where that
 * would be awkward, mirroring `SpooledArtifactConstructorLike`.
 */
export type VectorStoreConstructorLike<O extends BaseVectorStoreOptions = BaseVectorStoreOptions> =
  new (options: O) => BaseVectorStore

/**
 * The instance methods every {@link BaseVectorStore} subclass carries on its prototype — the
 * data plane (execute*), the schema plane, the connection lifecycle, and `asCallable` (which the
 * factory invokes to build the callable store). A duck-typed value is a valid adapter when its
 * prototype provides all of them.
 */
const VECTOR_STORE_METHODS = [
  'isAvailable',
  'connect',
  'close',
  'executeSearch',
  'executeUpsert',
  'executeDelete',
  'createCollection',
  'dropCollection',
  'hasCollection',
  'renameCollection',
  'asCallable',
] as const

/**
 * Validator schema for a {@link VectorStoreConstructorLike} value.
 *
 * @remarks
 * Invoked at validate-time, so inspecting the constructor's prototype is safe. The check is
 * duck-typed: the value must be a function whose `prototype` carries every canonical adapter
 * instance method. This mirrors `spooledArtifactConstructorSchema`'s cross-realm-safe
 * pattern — `instanceof BaseVectorStore` would be tighter but would couple this contract to the
 * class value and reject structurally-valid (e.g. cross-realm) adapters.
 */
export const vectorStoreConstructorSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (typeof value !== 'function') return helpers.error('any.invalid')
    const proto = (value as { prototype?: unknown }).prototype
    if (proto === undefined || proto === null) return helpers.error('any.invalid')
    if (
      VECTOR_STORE_METHODS.every((m) => typeof (proto as Record<string, unknown>)[m] === 'function')
    ) {
      return value
    }
    return helpers.error('any.invalid')
  })

/**
 * Returns `true` if `value` is a constructor whose prototype carries every canonical
 * {@link BaseVectorStore} instance method. Duck-typed; does not use `instanceof`.
 */
export const implementsVectorStoreConstructor = (
  value: unknown
): value is VectorStoreConstructorLike => {
  // `.required()` on the schema makes the validator reject undefined/null itself (without it,
  // `validator.any()` skips `.custom()` for an "absent" value and would wrongly pass).
  const { error } = vectorStoreConstructorSchema.validate(value, { abortEarly: true })
  return !error
}
