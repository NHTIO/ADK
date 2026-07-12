/**
 * transformers.js STT adapter battery — dual-environment ONNX Whisper transcription.
 *
 * @module @nhtio/adk/batteries/specialists/stt/transformers_js
 *
 * @remarks
 * Environment-neutral (Node + browser, ONNX Runtime auto-selected) — so, like the transformers.js
 * Embeddings battery, it is re-exported from the environment-neutral
 * `@nhtio/adk/batteries/specialists/stt` barrel. Re-exports the adapter class, the validation schema +
 * `validateOptions` wrapper, every option / pipeline type alias, and the battery-scoped exceptions.
 */

export { TransformersJsSttAdapter } from './adapter'

export { transformersJsSttAdapterOptionsSchema, validateOptions } from './validation'

export type {
  SttSegment,
  TranscribeResult,
  TranscribeOptions,
  TransformersJsSttAdapterOptions,
  TransformersJsSttPipeline,
  TransformersJsSttDataType,
  TransformersJsSttDeviceType,
  TransformersJsSttProgressCallback,
  TransformersJsSttModelSource,
  CreateTransformersJsSttPipeline,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export {
  E_INVALID_TRANSFORMERS_JS_STT_OPTIONS,
  E_TRANSFORMERS_JS_STT_ENGINE_ERROR,
} from './exceptions'
