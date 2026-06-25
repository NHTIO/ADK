/**
 * Runtime validation schema and wrapper for transformers.js Embeddings adapter options.
 *
 * @module @nhtio/adk/batteries/embeddings/transformers_js/validation
 *
 * @remarks
 * Validates `TransformersJsEmbeddingsAdapterOptions` at construction time. Throws
 * `E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS` on failure. `model` is required; unknown top-level
 * keys are rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS } from './exceptions'
import type { TransformersJsEmbeddingsAdapterOptions } from './types'

/** Validator schema for `TransformersJsEmbeddingsAdapterOptions`. Rejects unknown top-level keys. */
export const transformersJsEmbeddingsOptionsSchema = validator
  .object<TransformersJsEmbeddingsAdapterOptions>({
    // Shared base
    model: validator.string().min(1).required(),
    queryPrefix: validator.string().optional(),
    documentPrefix: validator.string().optional(),
    dimensions: validator.number().integer().min(1).optional(),
    // Pipeline knobs (the transformers.js pipeline is a callable object — accept function or object)
    pipeline: validator
      .alternatives(validator.function(), validator.object().unknown(true))
      .optional(),
    createPipeline: validator.function().optional(),
    device: validator.string().optional(),
    dtype: validator.string().optional(),
    pooling: validator
      .string()
      .valid('none', 'mean', 'cls', 'first_token', 'eos', 'last_token')
      .default('mean'),
    normalize: validator.boolean().default(true),
    onInitProgress: validator.function().optional(),
    isAvailable: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `transformersJsEmbeddingsOptionsSchema`.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): TransformersJsEmbeddingsAdapterOptions => {
  const { value, error } = transformersJsEmbeddingsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as TransformersJsEmbeddingsAdapterOptions
}
