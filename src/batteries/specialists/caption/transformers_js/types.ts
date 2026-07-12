/**
 * Option and pipeline types for the transformers.js Caption (image-to-text) specialist adapter.
 *
 * @module @nhtio/adk/batteries/specialists/caption/transformers_js/types
 *
 * @remarks
 * Mirrors `src/batteries/embeddings/transformers_js/types.ts` in shape and style: a lazily-imported,
 * environment-neutral `@huggingface/transformers` peer, an injectable pipeline/factory seam, a
 * `modelSource` resolver, and the shared lifecycle-hooks contract. `device`/`dtype`/`modelSource`/
 * `onInitProgress` are **local aliases** of `@huggingface/transformers` types, never direct re-exports
 * of the externalized peer.
 */

import type { BatteryLifecycleHooks } from '../../../llm/chat_common'
import type {
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

/** Quantization/precision dtype: `'auto'|'fp32'|'fp16'|'q8'|'q4'|…`. */
export type TransformersJsCaptionDataType = TransformersDataType
/** Inference device: `'auto'|'webgpu'|'wasm'|'cpu'|'gpu'|…`. */
export type TransformersJsCaptionDeviceType = TransformersDeviceType
/** Model-load progress callback. */
export type TransformersJsCaptionProgressCallback = ProgressCallback

/**
 * The transformers.js `image-to-text` pipeline this battery drives.
 *
 * @remarks
 * Locally shaped (not a re-export of `ImageToTextPipeline`) so this module never imports
 * `@huggingface/transformers` as a value — only as a type, resolved lazily at runtime. Accepts
 * whatever image value the adapter builds (a `Blob`, per {@link TransformersJsCaptionAdapterOptions}'s
 * adapter — see the adapter module remarks for why a `Blob` needs no peer import) and an options bag;
 * returns either a single-result array, a nested array (batch of images), or a bare single-result
 * object, each shaped `{ generated_text: string }`.
 */
export type TransformersJsCaptionPipeline = (
  image: unknown,
  options?: { max_new_tokens?: number }
) => Promise<
  { generated_text: string }[] | { generated_text: string }[][] | { generated_text: string }
>

/**
 * Custom model-source resolver — the dual-environment seam for serving model files from OPFS, a
 * different source, or bundled bytes (see the LLM battery's `model_source` module). Called once per
 * file; return bytes / a path-or-URL string / a `Response`, or `undefined` to fall through to HF.
 */
export type TransformersJsCaptionModelSource = (req: {
  repo: string
  filename: string
}) =>
  | Promise<Uint8Array | string | Response | undefined>
  | Uint8Array
  | string
  | Response
  | undefined

/**
 * Factory for lazily creating an image-to-text pipeline. Defaults to a dynamic import of
 * `@huggingface/transformers` + `pipeline('image-to-text', …)`; override to inject a pre-built
 * pipeline or a test double.
 */
export type CreateTransformersJsCaptionPipeline = (input: {
  model: string
  device?: TransformersJsCaptionDeviceType
  dtype?: TransformersJsCaptionDataType
  onInitProgress?: TransformersJsCaptionProgressCallback
}) => Promise<TransformersJsCaptionPipeline>

/**
 * Constructor options for the transformers.js Caption (image-to-text) adapter.
 *
 * @remarks
 * `model` is required — there is no default. The documented reference model is
 * `Xenova/vit-gpt2-image-captioning`.
 */
export interface TransformersJsCaptionAdapterOptions extends BatteryLifecycleHooks {
  /** The image-to-text model id, e.g. `Xenova/vit-gpt2-image-captioning`. Required — no default. */
  model: string
  /** A pre-built pipeline. When provided, the battery uses it directly and skips lazy creation. */
  pipeline?: TransformersJsCaptionPipeline
  /** Override the pipeline factory. Default: `pipeline('image-to-text', …)` via dynamic import. */
  createPipeline?: CreateTransformersJsCaptionPipeline
  /** Inference device forwarded to `pipeline()`. Default: transformers.js environment default. */
  device?: TransformersJsCaptionDeviceType
  /** Quantization/precision dtype forwarded to `pipeline()`. */
  dtype?: TransformersJsCaptionDataType
  /**
   * Custom model-source resolver (OPFS / separate source / bundled bytes). When set, model files load
   * through it behind the global-`env` mutex; otherwise straight from HF (unchanged). See
   * {@link TransformersJsCaptionModelSource}.
   */
  modelSource?: TransformersJsCaptionModelSource
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsCaptionProgressCallback
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean
}

/** Per-call options for {@link @nhtio/adk/batteries/specialists/caption/transformers_js!TransformersJsCaptionAdapter.describe}. */
export interface DescribeOptions {
  /** Generation budget forwarded to the pipeline as `max_new_tokens`. Omitted when unset. */
  maxNewTokens?: number
}

/** The normalized result of a caption request. */
export interface DescribeResult {
  /** The generated caption text. */
  text: string
}
