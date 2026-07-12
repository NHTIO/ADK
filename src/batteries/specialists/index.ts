/**
 * Environment-neutral aggregate barrel for bundled specialist batteries.
 *
 * @module @nhtio/adk/batteries/specialists
 *
 * @remarks
 * Aggregate barrel for the specialists domain: on-device specialist models — speech-to-text
 * (STT), OCR, and image captioning — that run *alongside* the LLM in the same runtime, Node
 * **and** browser, rather than delegating to a cloud endpoint. There is no cloud-hosted specialist
 * engine by design: the whole point of this domain is local media understanding a BYO executor can
 * run without another network hop, mirroring how `@nhtio/adk/batteries/embeddings` favors
 * environment-neutral, locally-runnable engines.
 *
 * This barrel re-exports each modality's own aggregate barrel in full:
 *
 * - `@nhtio/adk/batteries/specialists/stt` — speech-to-text (transformers.js/Whisper today).
 * - `@nhtio/adk/batteries/specialists/ocr` — optical character recognition (tesseract.js today).
 * - `@nhtio/adk/batteries/specialists/caption` — image captioning (transformers.js today).
 * - `@nhtio/adk/batteries/specialists/_shared` — the structural contracts and normalization helpers
 *   (`SpecialistMediaLike`, `isPcmInput`, `toBytes`, `defaultDecodeAudio`, etc.) shared across all
 *   three modalities.
 *
 * Unlike `@nhtio/adk/batteries/embeddings`, which excludes its browser/WebGPU-only WebLLM engine
 * from this level of barrel (reachable only via its own subpath), **every** specialist engine today
 * is environment-neutral — Node and browser both, no WebGPU requirement — so all three modality
 * barrels are re-exported here in full with nothing held back. Should a browser-only specialist
 * engine be added later, it would be excluded from this barrel for the same reason WebLLM is
 * excluded from the embeddings one, and reachable only through its own subpath.
 *
 * Each adapter class mirrors the embeddings adapters' shape and lifecycle: constructed with
 * options validated by that engine's own Zod schema, exposing the modality's single-purpose method
 * (`transcribe`, `recognize`, `describe`), and reporting model-load progress through the shared
 * {@link @nhtio/adk/batteries/specialists/ocr!BatteryLifecycleHooks} contract.
 */

export * from './stt'
export * from './ocr'
export * from './_shared'

// The `caption` modality barrel re-exports its transformers.js battery's `validateOptions` under
// its own bare name (`export * from './transformers_js'`), unlike the `stt`/`ocr` modality barrels,
// which already rename their own `validateOptions` (`validateTransformersJsSttOptions` /
// `validateTesseractJsOcrOptions`) to stay collision-free with every other battery's identically
// named `validateOptions` export (every battery validation module exports one). A blanket
// `export * from './caption'` here would collide with `@nhtio/adk/batteries/llm`'s own
// `validateOptions` re-export (from `openai_chat_completions`) once this barrel is aggregated into
// `@nhtio/adk/batteries`, so — mirroring the embeddings aggregate's explicit-rename pattern — caption
// is re-exported by name instead of `export *`, renaming `validateOptions` the same way its sibling
// modalities do.
export { TransformersJsCaptionAdapter } from './caption'
export { transformersJsCaptionOptionsSchema } from './caption'
export { validateOptions as validateTransformersJsCaptionOptions } from './caption'

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
} from './caption'

export {
  E_INVALID_TRANSFORMERS_JS_CAPTION_OPTIONS,
  E_TRANSFORMERS_JS_CAPTION_ENGINE_ERROR,
} from './caption'
