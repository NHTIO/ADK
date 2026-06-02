/**
 * Runtime validation schema and wrapper for WebLLM Embeddings adapter options.
 *
 * @module @nhtio/adk/batteries/embeddings/webllm/validation
 *
 * @remarks
 * Validates `WebLLMEmbeddingsAdapterOptions` at construction time. Throws
 * `E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS` on failure. `model` is required; unknown top-level keys
 * are rejected so typos fail loud. WebGPU availability is checked at engine-resolution time (not
 * here), since an `engine` may be injected for tests/non-WebGPU paths.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS } from './exceptions'
import type { WebLLMEmbeddingsAdapterOptions } from './types'

/**
 * Validator schema for `WebLLMEmbeddingsAdapterOptions`. Rejects unknown top-level keys.
 */
export const webLLMEmbeddingsOptionsSchema = validator
  .object<WebLLMEmbeddingsAdapterOptions>({
    // Shared base
    model: validator.string().min(1).required(),
    queryPrefix: validator.string().optional(),
    documentPrefix: validator.string().optional(),
    dimensions: validator.number().integer().min(1).optional(),
    // Engine knobs
    engine: validator.object().unknown(true).optional(),
    createEngine: validator.function().optional(),
    engineConfig: validator.object().unknown(true).optional(),
    chatOptions: validator
      .alternatives(
        validator.object().unknown(true),
        validator.array().items(validator.object().unknown(true))
      )
      .optional(),
    onInitProgress: validator.function().optional(),
    isWebGPUAvailable: validator.function().optional(),
  })
  .unknown(false)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `webLLMEmbeddingsOptionsSchema` and returns the resolved
 * options shape. Throws `E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS` (carrying the validator's report on
 * `cause`) on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): WebLLMEmbeddingsAdapterOptions => {
  const { value, error } = webLLMEmbeddingsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as WebLLMEmbeddingsAdapterOptions
}

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

void isValidationError
