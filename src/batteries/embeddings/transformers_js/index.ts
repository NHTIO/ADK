/**
 * transformers.js Embeddings adapter battery — dual-environment ONNX feature-extraction.
 *
 * @module @nhtio/adk/batteries/embeddings/transformers_js
 *
 * @remarks
 * Environment-neutral (Node + browser, ONNX Runtime auto-selected) — so, unlike the WebLLM embeddings
 * battery, it IS re-exported from the environment-neutral `@nhtio/adk/batteries/embeddings` barrel.
 * Re-exports the adapter class, the validation schema + `validateOptions` wrapper, every option /
 * pipeline type alias (including the shared base shapes re-exported from the OpenAI battery), and the
 * battery-scoped exceptions.
 */

export { TransformersJsEmbeddingsAdapter } from './adapter'

export { transformersJsEmbeddingsOptionsSchema, validateOptions } from './validation'

export { poolAndNormalize, defaultPoolAndNormalize, l2Normalize } from './pooling'

export type { TokenStates3D, Pooled2D } from './pooling'

export type {
  EmbeddingKind,
  EmbedOptions,
  BaseEmbeddingsAdapterOptions,
  TransformersJsEmbeddingsAdapterOptions,
  TransformersJsEmbeddingsPipeline,
  TransformersJsEmbeddingsDataType,
  TransformersJsEmbeddingsDeviceType,
  TransformersJsEmbeddingsProgressCallback,
  TransformersJsPooling,
  TransformersJsPoolingOwner,
  TransformersJsEmbeddingsModelSource,
  CreateTransformersJsEmbeddingsPipeline,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export {
  E_INVALID_TRANSFORMERS_JS_EMBEDDINGS_OPTIONS,
  E_TRANSFORMERS_JS_EMBEDDINGS_ENGINE_ERROR,
} from './exceptions'
