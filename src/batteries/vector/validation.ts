/**
 * Runtime validation schemas and throwing wrappers for the vector battery.
 *
 * @module @nhtio/adk/batteries/vector/validation
 */

import { vectorFilterSchema } from './filters'
import { validator, ValidationError } from '@nhtio/validation'
import { implementsVectorStoreConstructor } from './vector_store_constructor'
import { E_INVALID_VECTOR_STORE_CONFIG, E_INVALID_VECTOR_RECORD } from './exceptions'
import type { VectorRecord } from './types'

const detail = (e: ValidationError): string => e.details.map((d) => d.message).join('; ')

export const baseVectorStoreOptionsSchema = validator
  .object({
    metric: validator.string().valid('cosine', 'dot', 'euclidean').optional(),
    encoder: validator
      .custom((value, helpers) => {
        if (value === undefined) return value
        if (typeof value === 'function') return value
        return helpers.error('any.invalid')
      })
      .optional(),
    dimensions: validator.number().integer().min(1).optional(),
    defaultCollection: validator.string().optional(),
    consistency: validator.string().valid('strong', 'best-effort', 'eventual').optional(),
  })
  .unknown(true)

export const vectorRecordSchema = validator
  .object({
    id: validator.string().min(1).required(),
    vector: validator.array().items(validator.number()).optional(),
    document: validator.string().optional(),
    metadata: validator.object().unknown(true).optional(),
  })
  .unknown(false)

export { vectorFilterSchema }

/**
 * `client` accepts three forms, validated as alternatives:
 *   1. the adapter class itself           — a BaseVectorStore subclass constructor
 *   2. a sync resolver `() => Class`       — returns the class
 *   3. an async resolver `() => import(…)` — resolves to the class (e.g. a dynamic import)
 * Forms 2 and 3 are both plain functions that are NOT store constructors; the factory awaits
 * them and re-validates the resolved value (see resolveClientCtor).
 */
const clientSchema = validator.alternatives(
  // form 1: an actual adapter class
  validator.custom((v, h) => (implementsVectorStoreConstructor(v) ? v : h.error('any.invalid'))),
  // forms 2 & 3: a (sync or async) resolver function that is not itself a store class
  validator.custom((v, h) =>
    typeof v === 'function' && !implementsVectorStoreConstructor(v) ? v : h.error('any.invalid')
  )
)

export const validateCreateConfig = (input: unknown): void => {
  const schema = validator
    .object({
      client: clientSchema.required(),
      options: validator.object().unknown(true).required(),
    })
    .unknown(true)
  const { error } = schema.validate(input, { abortEarly: false, convert: false })
  if (error) throw new E_INVALID_VECTOR_STORE_CONFIG([detail(error)])
}

/**
 * Resolve the `client` (class | sync resolver | async resolver) down to the adapter constructor,
 * then validate the resolved value is a BaseVectorStore subclass — throwing the same
 * E_INVALID_VECTOR_STORE_CONFIG if a resolver hands back something that isn't one.
 */
export const resolveClientCtor = async (client: unknown): Promise<new (options: any) => any> => {
  let resolved: unknown = client
  // A resolver is a plain function that is not itself a store class; call it (it may be async).
  // A bare non-store class is also a function — invoking it throws "cannot invoke without new";
  // we catch that and fall through to the not-a-store rejection below rather than leaking it.
  if (typeof client === 'function' && !implementsVectorStoreConstructor(client)) {
    try {
      resolved = await (client as () => unknown)()
    } catch {
      resolved = undefined
    }
    // A resolver may return a module namespace; unwrap a `.default` export if present.
    if (resolved && typeof resolved === 'object' && 'default' in (resolved as object)) {
      const def = (resolved as { default?: unknown }).default
      if (implementsVectorStoreConstructor(def)) resolved = def
    }
  }
  if (!implementsVectorStoreConstructor(resolved)) {
    throw new E_INVALID_VECTOR_STORE_CONFIG([
      'client must be, or resolve to, a vector store constructor (a BaseVectorStore subclass)',
    ])
  }
  return resolved as new (options: any) => any
}

export const validateRecords = (records: VectorRecord[]): void => {
  for (const [i, record] of records.entries()) {
    const { error } = vectorRecordSchema.validate(record, { abortEarly: false, convert: false })
    if (error) throw new E_INVALID_VECTOR_RECORD([i, detail(error)])
    const vec = record.vector
    if (vec && !vec.every((n) => Number.isFinite(n))) {
      throw new E_INVALID_VECTOR_RECORD([i, 'vector contains a non-finite number'])
    }
  }
}
