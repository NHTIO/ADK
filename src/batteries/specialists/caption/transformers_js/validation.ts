/**
 * Runtime validation schema and wrapper for transformers.js Caption adapter options.
 *
 * @module @nhtio/adk/batteries/specialists/caption/transformers_js/validation
 *
 * @remarks
 * Validates `TransformersJsCaptionAdapterOptions` at construction time. Throws
 * `E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS` on failure. `model` is required; unknown top-level keys
 * are rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS } from './exceptions'
import type { TransformersJsCaptionAdapterOptions } from './types'

/** Validator schema for `TransformersJsCaptionAdapterOptions`. Rejects unknown top-level keys. */
export const transformersJsCaptionOptionsSchema = validator
  .object<TransformersJsCaptionAdapterOptions>({
    model: validator.string().min(1).required(),
    // Pipeline knobs (the transformers.js pipeline is a callable object — accept function or object)
    pipeline: validator
      .alternatives(validator.function(), validator.object().unknown(true))
      .optional(),
    createPipeline: validator.function().optional(),
    device: validator.string().optional(),
    dtype: validator.string().optional(),
    modelSource: validator.function().optional(),
    onInitProgress: validator.function().optional(),
    isAvailable: validator.function().optional(),
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
 * Validates an arbitrary input against `transformersJsCaptionOptionsSchema`.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): TransformersJsCaptionAdapterOptions => {
  const { value, error } = transformersJsCaptionOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as TransformersJsCaptionAdapterOptions
}
