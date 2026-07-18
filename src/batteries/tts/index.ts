/**
 * Environment-neutral aggregate barrel for bundled TTS (text-to-speech) batteries.
 *
 * @module @nhtio/adk/batteries/tts
 *
 * @remarks
 * The TTS domain is the inverse of the specialists domain: where specialists turn a modality INTO
 * text (STT/OCR/caption), a TTS engine turns text INTO audio. Each engine normalizes an existing
 * text-to-speech API behind one contract — `synthesize(text, opts?)` → a single
 * {@link @nhtio/adk/batteries/tts/transformers_js!GeneratedMediaOutput} (`kind: 'audio'`,
 * `mimeType: 'audio/wav'`, WAV bytes).
 *
 * This barrel re-exports only the **environment-neutral** transformers.js engine (Node + browser,
 * ONNX Runtime auto-selected — no WebGPU requirement), so it imports cleanly from either Node or the
 * browser. The **node-only** OS-native engine is reachable only through its own subpath:
 *
 * - `@nhtio/adk/batteries/tts/native` — node-only (shells out to macOS `say` / Linux `espeak-ng` /
 *   Windows PowerShell `System.Speech`; imports `node:*` builtins).
 *
 * Deep-import that subpath when you need it; don't expect it to be re-exported here — the same reason
 * the embeddings aggregate excludes its browser-only WebLLM engine.
 *
 * The shared option base is intentionally model-LESS ({@link BaseTtsAdapterOptions} carries only
 * `voice`/`rate`) because the native engine has no model concept; each model-backed engine adds its
 * own required `model`. See `@nhtio/adk/batteries/tts/_shared`.
 */

export { TransformersJsTtsAdapter } from './transformers_js'
export { transformersJsTtsOptionsSchema } from './transformers_js'
export { validateOptions as validateTransformersJsTtsOptions } from './transformers_js'

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
} from './transformers_js'

export {
  E_INVALID_TRANSFORMERS_JS_TTS_OPTIONS,
  E_TRANSFORMERS_JS_TTS_ENGINE_ERROR,
} from './transformers_js'

// The shared TTS contract (base options, per-call options, result shapes), owned by `_shared` and
// re-exported here so consumers get the whole domain surface from one import.
export type {
  BaseTtsAdapterOptions,
  SynthesizeOptions,
  RawAudioLike,
  GeneratedMediaOutput,
  TtsSynthesisResult,
} from './_shared'
