/**
 * Runtime validation schema and wrapper for transformers.js STT adapter options.
 *
 * @remarks
 * Validates `TransformersJsSttAdapterOptions` at construction time. Throws
 * `E_INVALID_TRANSFORMERS_JS_STT_OPTIONS` on failure. `model` is required; unknown top-level keys are
 * rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TRANSFORMERS_JS_STT_OPTIONS } from './exceptions'
import type { TransformersJsSttAdapterOptions } from './types'

/** Validator schema for `TransformersJsSttAdapterOptions`. Rejects unknown top-level keys. */
export const transformersJsSttAdapterOptionsSchema = validator
  .object<TransformersJsSttAdapterOptions>({
    model: validator.string().min(1).required(),
    // Pipeline knobs (the transformers.js pipeline is a callable object — accept function or object)
    pipeline: validator
      .alternatives(validator.function(), validator.object().unknown(true))
      .optional(),
    createPipeline: validator.function().optional(),
    device: validator.string().optional(),
    dtype: validator.string().optional(),
    chunkLengthS: validator.number().positive().default(30),
    decodeAudio: validator.function().optional(),
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
 * Validates an arbitrary input against `transformersJsSttAdapterOptionsSchema`.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_STT_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): TransformersJsSttAdapterOptions => {
  const { value, error } = transformersJsSttAdapterOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TRANSFORMERS_JS_STT_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as TransformersJsSttAdapterOptions
}
