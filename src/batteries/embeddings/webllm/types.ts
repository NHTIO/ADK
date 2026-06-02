/**
 * Option and engine types for the WebLLM Embeddings adapter.
 *
 * @module @nhtio/adk/batteries/embeddings/webllm/types
 *
 * @remarks
 * Builds on the **shared** embeddings option base owned by the OpenAI Embeddings battery
 * ({@link @nhtio/adk/batteries/embeddings/openai/types!BaseEmbeddingsAdapterOptions}). The two
 * batteries differ only in their engine: this one `Omit`s nothing from the base (the base carries
 * no HTTP fields) and adds the WebGPU/MLC engine knobs — exactly how the WebLLM Chat Completions
 * battery extends the OpenAI Chat Completions option type.
 */

import type { BaseEmbeddingsAdapterOptions } from '../openai/types'
import type {
  ChatOptions,
  InitProgressReport,
  MLCEngineConfig,
  MLCEngineInterface,
} from '@mlc-ai/web-llm'

// Re-export the shared base shapes so consumers can import everything embeddings-related from
// this battery's barrel without reaching into the OpenAI battery.
export type { EmbeddingKind, EmbedOptions, BaseEmbeddingsAdapterOptions } from '../openai/types'

/** The WebLLM engine handle this battery drives. Alias of `MLCEngineInterface`. */
export type WebLLMEmbeddingsEngine = MLCEngineInterface

/** Progress report emitted while the engine loads weights. Alias of `InitProgressReport`. */
export type WebLLMEmbeddingsInitProgressReport = InitProgressReport

/**
 * Factory for lazily creating a WebLLM engine. Defaults to `CreateMLCEngine` from
 * `@mlc-ai/web-llm`; override to inject a pre-configured engine, a web-worker engine, or a test
 * double.
 */
export type CreateWebLLMEmbeddingsEngine = (input: {
  model: string
  engineConfig?: MLCEngineConfig
  chatOptions?: ChatOptions | ChatOptions[]
  onInitProgress?: (report: InitProgressReport) => void
}) => Promise<WebLLMEmbeddingsEngine>

/**
 * Constructor options for {@link @nhtio/adk/batteries/embeddings/webllm/adapter!WebLLMEmbeddingsAdapter}.
 *
 * @remarks
 * Extends the shared {@link BaseEmbeddingsAdapterOptions} (carrying the required `model` and the
 * shared prefix options) with WebGPU/MLC engine fields. `model` accepts any MLC embedding model id
 * (e.g. `snowflake-arctic-embed-m-q0f32-MLC`) — there is no default; the caller names it.
 */
export interface WebLLMEmbeddingsAdapterOptions extends BaseEmbeddingsAdapterOptions {
  /** A pre-loaded engine. When provided, the battery uses it directly and skips lazy creation. */
  engine?: WebLLMEmbeddingsEngine
  /** Override the engine factory. Default: `CreateMLCEngine` via a lazy dynamic import. */
  createEngine?: CreateWebLLMEmbeddingsEngine
  /** Passed to `CreateMLCEngine` as the engine config (app config, cache, log level, etc.). */
  engineConfig?: MLCEngineConfig
  /** Passed to `CreateMLCEngine` as chat options (model-specific knobs). */
  chatOptions?: ChatOptions | ChatOptions[]
  /** Called with load-progress reports while weights download/compile. */
  onInitProgress?: (report: InitProgressReport) => void
  /** Override the WebGPU availability probe. Default: checks `navigator.gpu`. */
  isWebGPUAvailable?: () => boolean
}
