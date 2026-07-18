/**
 * transformers.js TTS adapter battery — dual-environment ONNX text-to-speech.
 *
 * @module @nhtio/adk/batteries/tts/transformers_js
 *
 * @remarks
 * Environment-neutral (Node + browser, ONNX Runtime auto-selected) — so, like the transformers.js
 * STT and Embeddings batteries, it is re-exported from the environment-neutral
 * `@nhtio/adk/batteries/tts` barrel. Re-exports the adapter class, the validation schema +
 * `validateOptions` wrapper, every option / pipeline type alias, and the battery-scoped exceptions.
 */

export { TransformersJsTtsAdapter } from './adapter'

export { transformersJsTtsOptionsSchema, validateOptions } from './validation'

export type {
  TransformersJsTtsAdapterOptions,
  TransformersJsTtsPipeline,
  TransformersJsTtsDataType,
  TransformersJsTtsDeviceType,
  TransformersJsTtsProgressCallback,
  TransformersJsTtsModelSource,
  CreateTransformersJsTtsPipeline,
  TransformersJsTtsSpeakerEmbeddings,
  TransformersJsSynthesizeOptions,
  BaseTtsAdapterOptions,
  SynthesizeOptions,
  RawAudioLike,
  GeneratedMediaOutput,
  TtsSynthesisResult,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export {
  E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS,
  E_TRANSFORMERS_JS_TTS_ENGINE_ERROR,
} from './exceptions'
