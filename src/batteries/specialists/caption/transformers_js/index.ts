/**
 * transformers.js Caption specialist battery — dual-environment ONNX image-to-text.
 *
 * @module @nhtio/adk/batteries/specialists/caption/transformers_js
 *
 * @remarks
 * Environment-neutral (Node + browser, ONNX Runtime auto-selected). Re-exports the adapter class, the
 * validation schema + `validateOptions` wrapper, every option / pipeline type alias, and the
 * battery-scoped exceptions.
 */

export { TransformersJsCaptionAdapter } from './adapter'

export { transformersJsCaptionOptionsSchema, validateOptions } from './validation'

export type {
  DescribeOptions,
  DescribeResult,
  TransformersJsCaptionAdapterOptions,
  TransformersJsCaptionPipeline,
  TransformersJsCaptionDataType,
  TransformersJsCaptionDeviceType,
  TransformersJsCaptionProgressCallback,
  TransformersJsCaptionModelSource,
  CreateTransformersJsCaptionPipeline,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export {
  E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS,
  E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR,
} from './exceptions'
