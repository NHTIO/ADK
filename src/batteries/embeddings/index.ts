/**
 * Environment-neutral aggregate barrel for bundled embeddings batteries.
 *
 * @module @nhtio/adk/batteries/embeddings
 *
 * @remarks
 * Aggregate barrel for the embeddings batteries. Re-exports the **environment-neutral** embeddings
 * batteries — the OpenAI battery (raw `fetch`, runs anywhere) and the transformers.js battery (ONNX
 * Runtime, auto-selecting native Node vs WASM/WebGPU in the browser) — so consumers can import this
 * barrel from either Node or the browser without dragging in environment-specific runtime
 * requirements.
 *
 * The browser/WebGPU-only WebLLM embeddings battery is reachable only through its own subpath:
 *
 * - `@nhtio/adk/batteries/embeddings/webllm` — browser-only (uses WebGPU via `@mlc-ai/web-llm`).
 *
 * Deep-import that subpath when you need it; don't expect it to be re-exported here. All batteries
 * share one option base and an identical method surface — see
 * {@link @nhtio/adk/batteries/embeddings/openai/types!BaseEmbeddingsAdapterOptions}.
 */

export { OpenAIEmbeddingsAdapter } from './openai'

export { applyEmbeddingPrefix } from './openai'

export { openAIEmbeddingsOptionsSchema } from './openai'
export { validateOptions as validateOpenAIEmbeddingsOptions } from './openai'

export { TransformersJsEmbeddingsAdapter } from './transformers_js'
export { transformersJsEmbeddingsOptionsSchema } from './transformers_js'
export { validateOptions as validateTransformersJsEmbeddingsOptions } from './transformers_js'

export type {
  TransformersJsEmbeddingsAdapterOptions,
  TransformersJsEmbeddingsPipeline,
  TransformersJsEmbeddingsDataType,
  TransformersJsEmbeddingsDeviceType,
  TransformersJsEmbeddingsProgressCallback,
  TransformersJsPooling,
  CreateTransformersJsEmbeddingsPipeline,
} from './transformers_js'

export {
  E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS,
  E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR,
} from './transformers_js'

export type {
  EmbeddingKind,
  EmbedOptions,
  EmbeddingsRetryConfig,
  BaseEmbeddingsAdapterOptions,
  OpenAIEmbeddingsAdapterOptions,
  OpenAIEmbeddingsRequestBody,
  OpenAIEmbeddingsResponseBody,
} from './openai'

export {
  E_INVALID_OPENAI_EMBEDDINGS_OPTIONS,
  E_OPENAI_EMBEDDINGS_HTTP_ERROR,
  E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT,
  E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE,
} from './openai'
