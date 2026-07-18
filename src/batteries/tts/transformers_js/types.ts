/**
 * Option, result, and pipeline types for the transformers.js TTS (text-to-speech) adapter.
 *
 * @module @nhtio/adk/batteries/tts/transformers_js/types
 *
 * @remarks
 * `TransformersJsTtsAdapterOptions` extends the shared {@link BaseTtsAdapterOptions} (from
 * `../_shared`) with the transformers.js engine's own knobs, plus the shared
 * {@link BatteryLifecycleHooks} boot-progress contract used by every other bundled on-device battery.
 * transformers.js is **environment-neutral** (Node + browser, ONNX Runtime auto-selected) — no
 * WebGPU requirement — matching the transformers.js embeddings/STT batteries this adapter is modeled
 * on.
 *
 * Pipeline/dtype/device shapes are **local aliases** of `@huggingface/transformers` types, never
 * direct re-exports of the externalized peer (CONTRIBUTING.md Design Decision #13, tier 1).
 *
 * **Verified against `@huggingface/transformers` 4.2.0** (the pinned minimum): the
 * `pipeline('text-to-speech')` task aliases the internal `text-to-audio` task and resolves to a
 * `TextToAudioPipeline` whose single-string result is a `RawAudio` exposing `toBlob(): Blob`
 * (WAV, Node-safe).
 */

import type { BatteryLifecycleHooks } from '../../llm/chat_common'
import type { BaseTtsAdapterOptions, SynthesizeOptions } from '../_shared'
import type {
  TextToAudioPipeline,
  DataType as TransformersDataType,
  DeviceType as TransformersDeviceType,
  ProgressCallback,
} from '@huggingface/transformers'

// Re-export the shared TTS base + result + lifecycle contracts so consumers import them from this
// engine barrel.
export type {
  BaseTtsAdapterOptions,
  SynthesizeOptions,
  RawAudioLike,
  GeneratedMediaOutput,
  TtsSynthesisResult,
} from '../_shared'
export type {
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from '../../llm/chat_common'

/**
 * A speaker-embedding reference for models that require one (e.g. SpeechT5).
 *
 * @remarks
 * `@huggingface/transformers` 4.2.0 accepts `Tensor | Float32Array | string | URL` for
 * `speaker_embeddings`. This adapter exposes `Float32Array | string | URL` via local aliases; the
 * peer's `Tensor` value type is deliberately not re-exported (it would couple this module to the
 * externalized peer). A `string`/`URL` is the documented way to point at a hosted speaker-embedding
 * file.
 */
export type TransformersJsTtsSpeakerEmbeddings = Float32Array | string | URL

/** The transformers.js text-to-audio pipeline this battery drives. */
export type TransformersJsTtsPipeline = TextToAudioPipeline
/** Quantization/precision dtype: `'auto'|'fp32'|'fp16'|'q8'|'q4'|…`. */
export type TransformersJsTtsDataType = TransformersDataType
/** Inference device: `'auto'|'webgpu'|'wasm'|'cpu'|'gpu'|…`. */
export type TransformersJsTtsDeviceType = TransformersDeviceType
/** Model-load progress callback. */
export type TransformersJsTtsProgressCallback = ProgressCallback

/**
 * Custom model-source resolver — the dual-environment seam for serving model files from OPFS, a
 * different source, or bundled bytes (see the LLM battery's `model_source` module). Called once per
 * file; return bytes / a path-or-URL string / a `Response`, or `undefined` to fall through to HF.
 */
export type TransformersJsTtsModelSource = (req: {
  repo: string
  filename: string
}) =>
  | Promise<Uint8Array | string | Response | undefined>
  | Uint8Array
  | string
  | Response
  | undefined

/**
 * Factory for lazily creating a text-to-audio pipeline. Defaults to a dynamic import of
 * `@huggingface/transformers` + `pipeline('text-to-speech', …)`; override to inject a pre-built
 * pipeline or a test double.
 */
export type CreateTransformersJsTtsPipeline = (input: {
  model: string
  device?: TransformersJsTtsDeviceType
  dtype?: TransformersJsTtsDataType
  onInitProgress?: TransformersJsTtsProgressCallback
}) => Promise<TransformersJsTtsPipeline>

/**
 * Constructor options for the transformers.js TTS adapter.
 *
 * @remarks
 * `model` is required — no default, since TTS models are multi-hundred-megabyte downloads and this
 * battery never triggers one silently (the loud-config rule shared with every on-device battery).
 * Extends the shared {@link BaseTtsAdapterOptions} (`voice`/`rate`) — see that base for the
 * normalization semantics.
 */
export interface TransformersJsTtsAdapterOptions
  extends BaseTtsAdapterOptions, BatteryLifecycleHooks {
  /**
   * The TTS model id, e.g. `Xenova/mms-tts-eng` (MMS-VITS) or `Xenova/speecht5_tts` (SpeechT5,
   * which additionally requires {@link speakerEmbeddings}). Required.
   */
  model: string
  /** A pre-built pipeline. When provided, the battery uses it directly and skips lazy creation. */
  pipeline?: TransformersJsTtsPipeline
  /** Override the pipeline factory. Default: `pipeline('text-to-speech', …)` via dynamic import. */
  createPipeline?: CreateTransformersJsTtsPipeline
  /** Inference device forwarded to `pipeline()`. Default: transformers.js environment default. */
  device?: TransformersJsTtsDeviceType
  /** Quantization/precision dtype forwarded to `pipeline()`. */
  dtype?: TransformersJsTtsDataType
  /**
   * Default speaker-embedding reference, applied when a `synthesize` call omits its own. **Required
   * by SpeechT5-family models**; ignored by models that do not use speaker embeddings (e.g. MMS-VITS).
   */
  speakerEmbeddings?: TransformersJsTtsSpeakerEmbeddings
  /** Default denoising step count for models that support it, applied when a call omits its own. */
  numInferenceSteps?: number
  /**
   * Custom model-source resolver (OPFS / separate source / bundled bytes). When set, model files load
   * through it behind the global-`env` mutex; otherwise straight from HF (unchanged). See
   * {@link TransformersJsTtsModelSource}.
   */
  modelSource?: TransformersJsTtsModelSource
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsTtsProgressCallback
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean
}

/**
 * Per-call options for {@link TransformersJsTtsAdapter.synthesize}. Extends the shared
 * {@link SynthesizeOptions} (`voice`/`rate`) with the transformers.js per-call knobs; each field
 * overrides the constructor default of the same name for this one call.
 */
export interface TransformersJsSynthesizeOptions extends SynthesizeOptions {
  /** Speaker-embedding reference for this call; overrides the constructor `speakerEmbeddings`. */
  speakerEmbeddings?: TransformersJsTtsSpeakerEmbeddings
  /** Denoising step count for this call; overrides the constructor `numInferenceSteps`. */
  numInferenceSteps?: number
}
