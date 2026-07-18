/**
 * Runtime validation schema and wrapper for transformers.js TTS adapter options.
 *
 * @module @nhtio/adk/batteries/tts/transformers_js/validation
 *
 * @remarks
 * Validates `TransformersJsTtsAdapterOptions` at construction time. Throws
 * `E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS` on failure. `model` is required; unknown top-level keys are
 * rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { isInstanceOf } from '../../../lib/utils/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS } from './exceptions'
import type { TransformersJsTtsAdapterOptions } from './types'

/** Validator schema for `TransformersJsTtsAdapterOptions`. Rejects unknown top-level keys. */
export const transformersJsTtsOptionsSchema = validator
  .object<TransformersJsTtsAdapterOptions>({
    model: validator.string().min(1).required(),
    // Pipeline knobs (the transformers.js pipeline is a callable object — accept function or object)
    pipeline: validator
      .alternatives(validator.function(), validator.object().unknown(true))
      .optional(),
    createPipeline: validator.function().optional(),
    device: validator.string().optional(),
    dtype: validator.string().optional(),
    speakerEmbeddings: validator
      .alternatives(
        validator.string(),
        validator
          .any()
          .custom((value, helpers) =>
            isInstanceOf(value, 'Float32Array', Float32Array) ? value : helpers.error('any.invalid')
          )
          .required(),
        validator
          .any()
          .custom((value, helpers) =>
            isInstanceOf(value, 'URL', URL) ? value : helpers.error('any.invalid')
          )
          .required()
      )
      .optional(),
    numInferenceSteps: validator.number().positive().optional(),
    modelSource: validator.function().optional(),
    onInitProgress: validator.function().optional(),
    isAvailable: validator.function().optional(),
    // Shared TTS defaults
    voice: validator.string().optional(),
    rate: validator.number().positive().optional(),
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
 * Validates an arbitrary input against `transformersJsTtsOptionsSchema`.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): TransformersJsTtsAdapterOptions => {
  const { value, error } = transformersJsTtsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as TransformersJsTtsAdapterOptions
}
