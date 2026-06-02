/**
 * OpenAI Embeddings adapter battery — the environment-neutral embeddings battery and owner of the
 * shared embeddings option base.
 *
 * @module @nhtio/adk/batteries/embeddings/openai
 *
 * @remarks
 * Re-exports the adapter class, the shared prefix helper, every option / wire-shape type alias
 * (including the shared {@link BaseEmbeddingsAdapterOptions}, {@link EmbeddingKind},
 * {@link EmbedOptions}, and {@link EmbeddingsRetryConfig} that the WebLLM Embeddings battery builds
 * on), the validation schema + `validateOptions` wrapper, and the battery-scoped exceptions.
 */

export { OpenAIEmbeddingsAdapter } from './adapter'

export { applyEmbeddingPrefix } from './helpers'

export { openAIEmbeddingsOptionsSchema, validateOptions } from './validation'

export type {
  EmbeddingKind,
  EmbedOptions,
  EmbeddingsRetryConfig,
  BaseEmbeddingsAdapterOptions,
  OpenAIEmbeddingsAdapterOptions,
  OpenAIEmbeddingsRequestBody,
  OpenAIEmbeddingsResponseBody,
} from './types'

export {
  E_INVALID_OPENAI_EMBEDDINGS_OPTIONS,
  E_OPENAI_EMBEDDINGS_HTTP_ERROR,
  E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT,
  E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE,
} from './exceptions'
