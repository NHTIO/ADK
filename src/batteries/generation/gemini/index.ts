/**
 * Gemini media generation adapter battery.
 *
 * @module @nhtio/adk/batteries/generation/gemini
 *
 * @remarks
 * Re-exports the adapter class, every option / wire-shape type alias (including the shared
 * {@link @nhtio/adk/batteries/generation/openai/types!BaseGenerationAdapterOptions},
 * {@link @nhtio/adk/batteries/generation/openai/types!GenerateOptions},
 * {@link @nhtio/adk/batteries/generation/openai/types!EditOptions}, and
 * {@link @nhtio/adk/batteries/generation/openai/types!GenerationRetryConfig} owned by the OpenAI
 * Generation battery), the validation schema + `validateOptions` wrapper, and the battery-scoped
 * exceptions.
 */

export { GeminiGenerationAdapter } from './adapter'

export { geminiGenerationOptionsSchema, validateOptions } from './validation'

export type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
  GeneratedMediaOutput,
  GeminiResponseModality,
  GeminiGenerationAdapterOptions,
  GeminiGenerateOptions,
  GeminiEditOptions,
  GeminiRequestPart,
  GeminiContent,
  GeminiGenerationConfig,
  GeminiGenerateContentRequestBody,
  GeminiResponsePart,
  GeminiGenerateContentResponse,
} from './types'

export {
  E_INVALID_GEMINI_GENERATION_OPTIONS,
  E_GEMINI_GENERATION_HTTP_ERROR,
  E_GEMINI_GENERATION_REQUEST_TIMEOUT,
  E_GEMINI_GENERATION_MALFORMED_RESPONSE,
} from './exceptions'
