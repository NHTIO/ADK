/**
 * Runtime validation schema and wrapper for transformers.js Generation adapter options.
 *
 * @module @nhtio/adk/batteries/generation/transformers_js/validation
 *
 * @remarks
 * Validates `TransformersJsGenerationAdapterOptions` at construction time. Throws
 * `E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS` on failure. `model` is required; unknown top-level
 * keys are rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS } from './exceptions'
import type { TransformersJsGenerationAdapterOptions } from './types'

/** Validator schema for `TransformersJsGenerationAdapterOptions`. Rejects unknown top-level keys. */
export const transformersJsGenerationOptionsSchema = validator
  .object<TransformersJsGenerationAdapterOptions>({
    model: validator.string().min(1).required(),
    // Model/processor knobs (structural duck-types — accept function or object).
    janusModel: validator.object().unknown(true).optional(),
    processor: validator
      .alternatives(validator.function(), validator.object().unknown(true))
      .optional(),
    createModel: validator.function().optional(),
    createProcessor: validator.function().optional(),
    device: validator.string().optional(),
    dtype: validator.string().optional(),
    modelSource: validator.function().optional(),
    onInitProgress: validator.function().optional(),
    isAvailable: validator.function().optional(),
    encodeImage: validator.function().optional(),
    // Sampling defaults.
    doSample: validator.boolean().optional(),
    temperature: validator.number().optional(),
    topK: validator.number().optional(),
    guidanceScale: validator.number().optional(),
    repetitionPenalty: validator.number().optional(),
    chatTemplate: validator.string().optional(),
    role: validator.string().optional(),
    // ── Lifecycle hooks (opt-in, normalized phase machine; additive over onInitProgress) ──
    onLifecycle: validator.function().optional(),
    onLoading: validator.function().optional(),
    onCompiling: validator.function().optional(),
    onReady: validator.function().optional(),
    onGenerating: validator.function().optional(),
    onComplete: validator.function().optional(),
    onError: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `transformersJsGenerationOptionsSchema`.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): TransformersJsGenerationAdapterOptions => {
  const { value, error } = transformersJsGenerationOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as TransformersJsGenerationAdapterOptions
}
