/**
 * Ollama Embeddings adapter battery — the environment-neutral embeddings battery for Ollama.
 *
 * @module @nhtio/adk/batteries/embeddings/ollama
 *
 * @remarks
 * Re-exports the adapter class, every option / wire-shape type alias (including the shared
 * {@link @nhtio/adk/batteries/embeddings/openai/types!BaseEmbeddingsAdapterOptions},
 * {@link @nhtio/adk/batteries/embeddings/openai/types!EmbeddingKind},
 * {@link @nhtio/adk/batteries/embeddings/openai/types!EmbedOptions}), the validation schema +
 * `validateOptions` wrapper, and the battery-scoped exceptions.
 */

export { OllamaEmbeddingsAdapter } from './adapter'

export { ollamaEmbeddingsOptionsSchema, validateOptions } from './validation'

export type {
  EmbeddingKind,
  EmbedOptions,
  BaseEmbeddingsAdapterOptions,
  OllamaEmbeddingsAdapterOptions,
  OllamaEmbeddingsRuntimeOptions,
  OllamaEmbeddingsRequestBody,
  OllamaEmbeddingsResponseBody,
} from './types'

export {
  E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS,
  E_OLLAMA_EMBEDDINGS_HTTP_ERROR,
  E_OLLAMA_EMBEDDINGS_REQUEST_TIMEOUT,
  E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE,
} from './exceptions'
