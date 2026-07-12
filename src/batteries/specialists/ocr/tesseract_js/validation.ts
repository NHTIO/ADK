/**
 * Runtime validation schema and wrapper for tesseract.js OCR adapter options.
 *
 * @module @nhtio/adk/batteries/specialists/ocr/tesseract_js/validation
 *
 * @remarks
 * Validates `TesseractJsOcrAdapterOptions` at construction time. Throws
 * `E_INVALID_TESSERACT_JS_OCR_OPTIONS` on failure. `languages` is required and must be a non-empty
 * array of strings — language packs download on first use, so a missing/empty value fails loud
 * rather than silently picking a default; unknown top-level keys are rejected so typos fail loud.
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TESSERACT_JS_OCR_OPTIONS } from './exceptions'
import type { TesseractJsOcrAdapterOptions } from './types'

/** Validator schema for `TesseractJsOcrAdapterOptions`. Rejects unknown top-level keys. */
export const tesseractJsOcrOptionsSchema = validator
  .object<TesseractJsOcrAdapterOptions>({
    languages: validator.array().items(validator.string().min(1)).min(1).required(),
    langPath: validator.string().optional(),
    cachePath: validator.string().optional(),
    workerOptions: validator.object().unknown(true).optional(),
    tesseract: validator.function().optional(),
    createWorker: validator.function().optional(),
    isAvailable: validator.function().optional(),
    // ── Lifecycle hooks (opt-in, normalized phase machine) ──
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
 * Validates an arbitrary input against `tesseractJsOcrOptionsSchema`.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TESSERACT_JS_OCR_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): TesseractJsOcrAdapterOptions => {
  const { value, error } = tesseractJsOcrOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TESSERACT_JS_OCR_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as TesseractJsOcrAdapterOptions
}
