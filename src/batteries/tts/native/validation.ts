/**
 * Runtime validation schema and wrapper for OS-native TTS adapter options.
 *
 * @module @nhtio/adk/batteries/tts/native/validation
 *
 * @remarks
 * Validates `NativeTtsAdapterOptions` at construction time. Throws
 * {@link @nhtio/adk/batteries/tts/native!E_INVALID_NATIVE_TTS_OPTIONS} on failure. Every field is
 * optional — a zero-config `new NativeTtsAdapter()` is valid and auto-detects the platform — but
 * unknown top-level keys are rejected (`.unknown(false)`) so typos fail loud. The seam functions
 * (`executor`/`fs`/`tmpdir`/`randomName`/`isAvailable`) are accepted as bare functions (or, for
 * `fs`/`executor`, an object whose members are functions) so unit tests can inject fakes.
 */

import { isError } from '@nhtio/adk/guards'
import { E_INVALID_NATIVE_TTS_OPTIONS } from './exceptions'
import { validator, ValidationError } from '@nhtio/validation'
import type { NativeTtsAdapterOptions } from './types'

/**
 * Validator schema for `NativeTtsAdapterOptions`. Every field is optional; unknown top-level keys
 * are rejected. Seam functions are accepted as-is.
 */
export const nativeTtsOptionsSchema = validator
  .object<NativeTtsAdapterOptions>({
    // Shared TTS base
    voice: validator.string().optional(),
    rate: validator.number().optional(),
    // Native transport / engine knobs
    platform: validator.string().valid('darwin', 'linux', 'win32').optional(),
    command: validator.string().optional(),
    extraArgs: validator.array().items(validator.string()).optional(),
    wordsPerMinute: validator.number().integer().positive().optional(),
    pitch: validator.number().integer().min(0).max(99).optional(),
    timeoutMs: validator.number().integer().positive().optional(),
    // BYO seams: executor is an object with an `exec` function; fs is an object with two function
    // members; tmpdir/randomName/isAvailable are bare functions. All accepted as-is.
    executor: validator.object({ exec: validator.function() }).unknown(true).optional(),
    fs: validator
      .object({ readFile: validator.function(), unlink: validator.function() })
      .unknown(true)
      .optional(),
    tmpdir: validator.function().optional(),
    randomName: validator.function().optional(),
    isAvailable: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against {@link nativeTtsOptionsSchema}.
 *
 * @param input - The raw options object to validate (pass `{}` for zero-config).
 * @returns The resolved options object (typed as {@link NativeTtsAdapterOptions}).
 * @throws {@link @nhtio/adk/batteries/tts/native!E_INVALID_NATIVE_TTS_OPTIONS} when invalid.
 */
export const validateOptions = (input: unknown): NativeTtsAdapterOptions => {
  const { value, error } = nativeTtsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_NATIVE_TTS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as NativeTtsAdapterOptions
}
