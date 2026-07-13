/**
 * transformers.js Generation battery — dual-environment, EXPERIMENTAL on-device Janus text→image.
 *
 * @module @nhtio/adk/batteries/generation/transformers_js
 *
 * @remarks
 * Environment-neutral (Node + browser, ONNX Runtime auto-selected). Re-exports the adapter class, the
 * validation schema + `validateOptions` wrapper, every option / model / processor type alias, and the
 * battery-scoped exceptions.
 */

export { TransformersJsGenerationAdapter } from './adapter'

export { transformersJsGenerationOptionsSchema, validateOptions } from './validation'

export type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
  GeneratedMediaOutput,
  TransformersJsGenerationAdapterOptions,
  TransformersJsGenerateOptions,
  TransformersJsGenerationDataType,
  TransformersJsGenerationDeviceType,
  TransformersJsGenerationProgressCallback,
  TransformersJsRawImageLike,
  TransformersJsGenerationModel,
  TransformersJsGenerationProcessor,
  TransformersJsGenerationModelSource,
  CreateTransformersJsGenerationModel,
  CreateTransformersJsGenerationProcessor,
  EncodeRawImageFn,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export {
  E_INVALID_TRANSFORMERS_JS_GENERATION_OPTIONS,
  E_TRANSFORMERS_JS_GENERATION_ENGINE_ERROR,
  E_TRANSFORMERS_JS_GENERATION_UNSUPPORTED_OPERATION,
} from './exceptions'
