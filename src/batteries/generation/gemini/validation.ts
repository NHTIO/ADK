/**
 * Runtime validation schema and wrapper for Gemini media generation adapter options.
 *
 * @module @nhtio/adk/batteries/generation/gemini/validation
 *
 * @remarks
 * Validates `GeminiGenerationAdapterOptions` at construction time. Throws
 * `E_INVALID_GEMINI_GENERATION_OPTIONS` on failure — the same hard-fail policy as every other ADK
 * contract. `model` is required; unknown top-level keys are rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_GEMINI_GENERATION_OPTIONS } from './exceptions'
import type { GeminiGenerationAdapterOptions } from './types'

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
 * Validator schema for `GeminiGenerationAdapterOptions`. Rejects unknown top-level keys.
 */
export const geminiGenerationOptionsSchema = validator
  .object<GeminiGenerationAdapterOptions>({
    // Shared base
    model: validator.string().min(1).required(),
    // HTTP transport
    apiKey: validator.string().optional(),
    baseURL: validator.string().optional(),
    headers: validator.object().pattern(validator.string(), validator.string()).optional(),
    fetch: validator.function().optional(),
    retry: retrySchema.optional(),
    requestTimeoutMs: validator.number().integer().min(0).default(0),
    // Gemini generation knobs
    responseModalities: validator
      .array()
      .items(validator.string().valid('TEXT', 'IMAGE'))
      .default(['TEXT', 'IMAGE']),
    aspectRatio: validator.string().optional(),
  })
  .unknown(false)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `geminiGenerationOptionsSchema` and returns the resolved
 * options shape. Throws `E_INVALID_GEMINI_GENERATION_OPTIONS` (carrying the validator's report on
 * `cause`) on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): GeminiGenerationAdapterOptions => {
  const { value, error } = geminiGenerationOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_GEMINI_GENERATION_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as GeminiGenerationAdapterOptions
}

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

void isValidationError
