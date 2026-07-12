/**
 * Option, result, and pipeline types for the transformers.js STT (speech-to-text) adapter.
 *
 * @remarks
 * `TransformersJsSttAdapterOptions` builds on the shared {@link BatteryLifecycleHooks} contract (the
 * same normalized `loading → compiling → ready → generating → complete`/`error` phase machine used by
 * every other bundled LLM/embeddings battery). transformers.js is **environment-neutral** (Node +
 * browser, ONNX Runtime auto-selected) — no WebGPU requirement, matching the transformers.js embeddings
 * battery this adapter is modeled on.
 *
 * Pipeline/dtype/device shapes are **local aliases** of `@huggingface/transformers` types, never direct
 * re-exports of the externalized peer (CONTRIBUTING.md Design Decision #13, tier 1).
 */

import type { DecodeAudioFn } from '../../_shared'
import type { BatteryLifecycleHooks } from '../../../llm/chat_common'
import type {
  AutomaticSpeechRecognitionPipeline,
  DataType as TransformersDataType,
  DeviceType as TransformersDeviceType,
  ProgressCallback,
} from '@huggingface/transformers'

// Re-export the shared lifecycle/boot-progress contract so consumers import it from this barrel.
export type {
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from '../../../llm/chat_common'

/** A single recognized speech segment with its time bounds and text. */
export interface SttSegment {
  /** The segment's start time, in seconds. */
  start: number
  /** The segment's end time, in seconds, or `null` when the engine did not report one. */
  end: number | null
  /** The segment's recognized text. */
  text: string
}

/** The result of a {@link TranscribeOptions | transcribe} call. */
export interface TranscribeResult {
  /** The full recognized transcript. */
  text: string
  /** Per-segment timing breakdown, present only when {@link TranscribeOptions.timestamps} was set. */
  segments?: SttSegment[]
}

/** Per-call options for {@link TransformersJsSttAdapter.transcribe}. */
export interface TranscribeOptions {
  /** The source language (e.g. `'english'`), improving accuracy when known. Default: auto-detect. */
  language?: string
  /** Translate the recognized speech to English rather than transcribing it verbatim. Default: `false`. */
  translate?: boolean
  /** Request per-segment timestamps, populating {@link TranscribeResult.segments}. Default: `false`. */
  timestamps?: boolean
}

/** The transformers.js automatic-speech-recognition pipeline this battery drives. */
export type TransformersJsSttPipeline = AutomaticSpeechRecognitionPipeline
/** Quantization/precision dtype: `'auto'|'fp32'|'fp16'|'q8'|'q4'|…`. */
export type TransformersJsSttDataType = TransformersDataType
/** Inference device: `'auto'|'webgpu'|'wasm'|'cpu'|'gpu'|…`. */
export type TransformersJsSttDeviceType = TransformersDeviceType
/** Model-load progress callback. */
export type TransformersJsSttProgressCallback = ProgressCallback

/**
 * Custom model-source resolver — the dual-environment seam for serving model files from OPFS, a
 * different source, or bundled bytes (see the LLM battery's `model_source` module). Called once per
 * file; return bytes / a path-or-URL string / a `Response`, or `undefined` to fall through to HF.
 */
export type TransformersJsSttModelSource = (req: {
  repo: string
  filename: string
}) =>
  | Promise<Uint8Array | string | Response | undefined>
  | Uint8Array
  | string
  | Response
  | undefined

/**
 * Factory for lazily creating an automatic-speech-recognition pipeline. Defaults to a dynamic import
 * of `@huggingface/transformers` + `pipeline('automatic-speech-recognition', …)`; override to inject a
 * pre-built pipeline or a test double.
 */
export type CreateTransformersJsSttPipeline = (input: {
  model: string
  device?: TransformersJsSttDeviceType
  dtype?: TransformersJsSttDataType
  onInitProgress?: TransformersJsSttProgressCallback
}) => Promise<TransformersJsSttPipeline>

/**
 * Constructor options for the transformers.js STT adapter.
 *
 * @remarks
 * `model` is required — no default, since Whisper-family models are multi-hundred-megabyte downloads
 * and this battery never triggers one silently (the loud-config rule shared with every on-device
 * battery).
 */
export interface TransformersJsSttAdapterOptions extends BatteryLifecycleHooks {
  /** The Whisper (or compatible) ASR model id, e.g. `onnx-community/whisper-base`. Required. */
  model: string
  /** A pre-built pipeline. When provided, the battery uses it directly and skips lazy creation. */
  pipeline?: TransformersJsSttPipeline
  /**
   * Override the pipeline factory. Default: `pipeline('automatic-speech-recognition', …)` via dynamic
   * import.
   */
  createPipeline?: CreateTransformersJsSttPipeline
  /** Inference device forwarded to `pipeline()`. Default: transformers.js environment default. */
  device?: TransformersJsSttDeviceType
  /** Quantization/precision dtype forwarded to `pipeline()`. */
  dtype?: TransformersJsSttDataType
  /** The length of audio chunks to process, in seconds, forwarded to the pipeline call. Default `30`. */
  chunkLengthS?: number
  /**
   * Override the audio-decode step (encoded container bytes → mono PCM). Default:
   * {@link @nhtio/adk/batteries/specialists/_shared!defaultDecodeAudio}.
   */
  decodeAudio?: DecodeAudioFn
  /**
   * Custom model-source resolver (OPFS / separate source / bundled bytes). When set, model files load
   * through it behind the global-`env` mutex; otherwise straight from HF (unchanged). See
   * {@link TransformersJsSttModelSource}.
   */
  modelSource?: TransformersJsSttModelSource
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsSttProgressCallback
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean
}
