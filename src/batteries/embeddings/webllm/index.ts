/**
 * WebLLM Embeddings adapter battery — WebGPU/in-process embeddings via `@mlc-ai/web-llm`.
 *
 * @module @nhtio/adk/batteries/embeddings/webllm
 *
 * @remarks
 * Browser/WebGPU-only, so reachable solely through this subpath (never re-exported from the
 * environment-neutral `@nhtio/adk/batteries/embeddings` barrel). Re-exports the adapter class, the
 * validation schema + `validateOptions` wrapper, every option / engine type alias (including the
 * shared base shapes re-exported from the OpenAI battery), and the battery-scoped exceptions.
 */

export { WebLLMEmbeddingsAdapter } from './adapter'

export { webLLMEmbeddingsOptionsSchema, validateOptions } from './validation'

export type {
  EmbeddingKind,
  EmbedOptions,
  BaseEmbeddingsAdapterOptions,
  WebLLMEmbeddingsAdapterOptions,
  WebLLMEmbeddingsEngine,
  WebLLMEmbeddingsInitProgressReport,
  CreateWebLLMEmbeddingsEngine,
} from './types'

export { E_INVALID_WEBLLM_EMBEDDINGS_OPTIONS, E_WEBLLM_EMBEDDINGS_ENGINE_ERROR } from './exceptions'
