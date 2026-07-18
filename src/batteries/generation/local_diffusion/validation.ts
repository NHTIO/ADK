/** Runtime validation for local diffusion options.
 * @module @nhtio/adk/batteries/generation/local_diffusion/validation
 */
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_LOCAL_DIFFUSION_OPTIONS } from './exceptions'
import type { LocalDiffusionGenerationAdapterOptions } from './types'

/** Validator schema for local diffusion adapter options. */
export const localDiffusionOptionsSchema = validator
  .object<LocalDiffusionGenerationAdapterOptions>({
    model: validator.string().min(1).required(),
    command: validator.string().min(1).required(),
    args: validator.array().items(validator.string()).optional(),
    spawn: validator.function().optional(),
    fs: validator
      .object({
        readFile: validator.function().required(),
        unlink: validator.function().required(),
      })
      .unknown(false)
      .optional(),
    outputDir: validator.string().optional(),
    maxDecodedBytes: validator
      .number()
      .integer()
      .min(1)
      .default(50 * 1024 * 1024),
    maxLineBytes: validator
      .number()
      .integer()
      .min(1)
      .default(1024 * 1024),
    protocol: validator.object().unknown(false).optional(),
    commandPrefix: validator.string().optional(),
    eventPrefix: validator.string().optional(),
    ops: validator.object().unknown(false).optional(),
    control: validator.object().unknown(false).optional(),
    events: validator.object().unknown(false).optional(),
    startupTimeoutMs: validator.number().integer().min(1).default(30_000),
    requestTimeoutMs: validator.number().integer().min(0).default(0),
    abortGraceMs: validator.number().integer().min(0).default(5000),
    disposeGraceMs: validator.number().integer().min(0).default(5000),
    negativePrompt: validator.string().optional(),
    steps: validator.number().integer().min(1).optional(),
    cfgScale: validator.number().min(0).optional(),
    sampler: validator.string().optional(),
    seed: validator.number().integer().optional(),
    width: validator.number().integer().min(1).optional(),
    height: validator.number().integer().min(1).optional(),
    isAvailable: validator.function().optional(),
    onLifecycle: validator.function().optional(),
    onLoading: validator.function().optional(),
    onCompiling: validator.function().optional(),
    onReady: validator.function().optional(),
    onGenerating: validator.function().optional(),
    onComplete: validator.function().optional(),
    onError: validator.function().optional(),
  })
  .unknown(false)

const formatDetails = (error: ValidationError): string =>
  error.details.map((detail) => detail.message).join(' and ')

/** Validate and resolve adapter options. */
export const validateOptions = (input: unknown): LocalDiffusionGenerationAdapterOptions => {
  const result = localDiffusionOptionsSchema.validate(input, { abortEarly: false, convert: false })
  if (result.error) {
    throw new E_INVALID_LOCAL_DIFFUSION_OPTIONS([formatDetails(result.error)])
  }
  return result.value as LocalDiffusionGenerationAdapterOptions
}
