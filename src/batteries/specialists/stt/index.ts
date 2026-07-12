/**
 * Environment-neutral aggregate barrel for bundled STT (speech-to-text) specialist batteries.
 *
 * @module @nhtio/adk/batteries/specialists/stt
 *
 * @remarks
 * Aggregate barrel for the STT specialist batteries. Currently re-exports the transformers.js
 * battery — environment-neutral (Node + browser, ONNX Runtime auto-selected, no WebGPU requirement) —
 * mirroring `@nhtio/adk/batteries/embeddings`'s aggregate barrel, which re-exports only its
 * environment-neutral engines and leaves browser/WebGPU-only engines reachable exclusively through
 * their own subpath. Should a browser-only STT engine be added later, it would stay off this barrel
 * for the same reason.
 */

export { TransformersJsSttAdapter } from './transformers_js'
export { transformersJsSttAdapterOptionsSchema } from './transformers_js'
export { validateOptions as validateTransformersJsSttOptions } from './transformers_js'

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
} from './transformers_js'

export {
  E_INVALID_TRANSFORMERS_JS_STT_OPTIONS,
  E_TRANSFORMERS_JS_STT_ENGINE_ERROR,
} from './transformers_js'
