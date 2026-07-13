/**
 * OpenAI media generation adapter battery — the environment-neutral generation battery and owner
 * of the shared generation option base.
 *
 * @module @nhtio/adk/batteries/generation/openai
 *
 * @remarks
 * Re-exports the adapter class, the multipart edit-image field-name constant, every option /
 * wire-shape type alias (including the shared {@link BaseGenerationAdapterOptions},
 * {@link GenerateOptions}, {@link EditOptions}, and {@link GenerationRetryConfig} that future
 * generation batteries build on), the validation schema + `validateOptions` wrapper, and the
 * battery-scoped exceptions.
 */

export { OpenAIGenerationAdapter, EDIT_IMAGE_FIELD_NAME } from './adapter'

export { openAIGenerationOptionsSchema, validateOptions } from './validation'

export type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
  GeneratedMediaOutput,
  OpenAIGenerationAdapterOptions,
  OpenAIGenerateOptions,
  OpenAIEditOptions,
  OpenAIImagesGenerationRequestBody,
  OpenAIImagesResponse,
} from './types'

export {
  E_INVALID_OPENAI_GENERATION_OPTIONS,
  E_OPENAI_GENERATION_HTTP_ERROR,
  E_OPENAI_GENERATION_REQUEST_TIMEOUT,
  E_OPENAI_GENERATION_MALFORMED_RESPONSE,
} from './exceptions'
