/**
 * Runtime validation schema and wrapper for Ollama Embeddings adapter options.
 *
 * @module @nhtio/adk/batteries/embeddings/ollama/validation
 *
 * @remarks
 * Validates `OllamaEmbeddingsAdapterOptions` at construction time. Throws
 * `E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS` on failure — the same hard-fail policy as every other ADK
 * contract. `model` is required; unknown top-level keys are rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS } from './exceptions'
import type { OllamaEmbeddingsAdapterOptions, OllamaEmbeddingsRuntimeOptions } from './types'

const runtimeOptionsSchema = validator
  .object<OllamaEmbeddingsRuntimeOptions>({
    num_ctx: validator.number().integer().min(1).optional(),
    num_thread: validator.number().integer().min(1).optional(),
  })
  .unknown(false)

const retrySchema = validator
  .object({
    maxAttempts: validator.number().integer().min(1).default(1),
    baseDelayMs: validator.number().integer().min(0).default(500),
    maxDelayMs: validator.number().integer().min(1).default(30_000),
    retriableStatuses: validator
      .array()
      .items(validator.number().integer().min(100).max(599))
      .default([429, 500, 502, 503, 504]),
    honorRetryAfter: validator.boolean().default(true),
  })
  .unknown(false)

/**
 * Validator schema for `OllamaEmbeddingsAdapterOptions`. Rejects unknown top-level keys.
 */
export const ollamaEmbeddingsOptionsSchema = validator
  .object<OllamaEmbeddingsAdapterOptions>({
    // Shared base
    model: validator.string().min(1).required(),
    queryPrefix: validator.string().optional(),
    documentPrefix: validator.string().optional(),
    dimensions: validator.number().integer().min(1).optional(),
    // HTTP transport
    apiKey: validator.string().optional(),
    baseURL: validator.string().optional(),
    headers: validator.object().pattern(validator.string(), validator.string()).optional(),
    fetch: validator.function().optional(),
    retry: retrySchema.optional(),
    requestTimeoutMs: validator.number().integer().min(0).default(0),
    // Ollama-specific. `truncate` is optional with NO default: only sent on the wire when the
    // caller explicitly sets it, leaving Ollama's server-side default in force otherwise.
    truncate: validator.boolean().optional(),
    keepAlive: validator.alternatives(validator.string(), validator.number()).optional(),
    options: runtimeOptionsSchema.optional(),
  })
  .unknown(false)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `ollamaEmbeddingsOptionsSchema` and returns the resolved
 * options shape. Throws `E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS` (carrying the validator's report on
 * `cause`) on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): OllamaEmbeddingsAdapterOptions => {
  const { value, error } = ollamaEmbeddingsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as OllamaEmbeddingsAdapterOptions
}

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

void isValidationError
