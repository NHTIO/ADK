/**
 * Option and model/processor seam types for the transformers.js (on-device Janus) Generation
 * adapter.
 *
 * @module @nhtio/adk/batteries/generation/transformers_js/types
 *
 * @remarks
 * Builds on the **shared** generation option base owned by the OpenAI Generation battery
 * ({@link @nhtio/adk/batteries/generation/openai/types!BaseGenerationAdapterOptions}), mirroring the
 * transformers.js Embeddings/Caption batteries in shape: a lazily-imported, environment-neutral
 * `@huggingface/transformers` peer, injectable model/processor factory seams, a `modelSource`
 * resolver, and the shared lifecycle-hooks contract.
 *
 * **Engine (EXPERIMENTAL):** DeepSeek Janus (`onnx-community/Janus-Pro-1B-ONNX` et al.) via
 * `MultiModalityCausalLM.generate_images()` — the *only* image-generation surface transformers.js
 * exposes (there is no `pipeline('text-to-image')` task; verified against the installed
 * `@huggingface/transformers` source, `src/models/multi_modality/modeling_multi_modality.js`).
 * `MultiModalityCausalLM` and `VLChatProcessor` are both exported from the package root, but this
 * module types them **structurally** (duck-typed local interfaces) rather than importing either as a
 * value or a hard type — consistent with every other transformers.js battery in this codebase — so
 * fake-model/fake-processor unit tests never load the real ~2GB peer.
 *
 * **Real, verified knobs only** (no invented options), cross-checked against three sources: the
 * installed `GenerationConfig` defaults (`src/generation/configuration_utils.js`), the sampler's
 * actual field reads (`src/generation/logits_sampler.js`, `_get_logits_processor` in
 * `src/models/modeling_utils.js`), and the official `onnx-community/Janus-Pro-1B-ONNX` model-card
 * usage example:
 * - `doSample` → `do_sample` — gates greedy vs. multinomial sampling (`getSampler`); the model card's
 *   own example passes `do_sample: true` for image generation.
 * - `temperature` → `temperature` — read by `TemperatureLogitsWarper` when `do_sample` is set
 *   (`modeling_utils.js` `_get_logits_processor`).
 * - `topK` → `top_k` — read directly inside `MultinomialSampler.sample()` (`logits_sampler.js`), the
 *   sampler `generate_images` actually drives (top_p is NOT read there — the `TopPLogitsWarper` branch
 *   is dead/commented-out code in the installed build, so `top_p` is deliberately **not** exposed here).
 * - `guidanceScale` → `guidance_scale` — read by `_get_logits_processor` to push a
 *   `ClassifierFreeGuidanceLogitsProcessor` (`generation_config.guidance_scale > 1`); Janus's own
 *   `prepare_inputs_for_generation` branches on it explicitly for the negative/unconditional prompt
 *   pass CFG requires.
 * - `repetitionPenalty` → `repetition_penalty` — read by `_get_logits_processor`.
 * - `numImageTokens`/`minNewTokens`/`maxNewTokens` → `min_new_tokens`/`max_new_tokens` — the model
 *   card's example passes both equal to `processor.num_image_tokens` (the fixed image-token budget);
 *   surfaced as an override so a caller need not special-case parsing `processor.num_image_tokens`.
 */

import type { BatteryLifecycleHooks } from '../../llm/chat_common'
import type { BaseGenerationAdapterOptions, GenerateOptions } from '../openai/types'

// Re-export the shared base shapes so consumers can import everything generation-related from this
// battery's barrel without reaching into the OpenAI battery.
export type {
  GenerationRetryConfig,
  GenerateOptions,
  EditOptions,
  BaseGenerationAdapterOptions,
  GeneratedMediaOutput,
} from '../openai/types'

// Re-export the shared lifecycle/boot-progress contract so consumers import it from this barrel.
export type {
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from '../../llm/chat_common'

/** Quantization/precision dtype forwarded to `from_pretrained()` — a local alias, never a re-export of the externalized peer's `DataType`. */
export type TransformersJsGenerationDataType = string
/** Inference device forwarded to `from_pretrained()` — a local alias of the peer's `DeviceType`. */
export type TransformersJsGenerationDeviceType = string
/** Model-load progress callback — locally shaped, structurally compatible with the peer's `ProgressCallback`. */
export type TransformersJsGenerationProgressCallback = (info: unknown) => void

/**
 * Structural duck-type of the transformers.js `RawImage` values `generate_images()` resolves with:
 * exactly what {@link @nhtio/adk/batteries/generation/transformers_js/helpers!rawImageToEncodedBytes}
 * reads off each result to encode PNG bytes (env-branched `toBlob`/`toSharp`).
 */
export interface TransformersJsRawImageLike {
  /** Browser-only: encodes the image to a `Blob` of the given MIME type. Throws outside a web env. */
  toBlob?: (type?: string, quality?: number) => Promise<Blob>
  /** Node-only: wraps the raw pixel data in a `sharp.Sharp` instance. Throws inside a web env. */
  toSharp?: () => { png: () => { toBuffer: () => Promise<Buffer> } }
}

/**
 * Structural duck-type of `MultiModalityCausalLM` — exactly the one method this battery drives.
 * Verified against the installed `@huggingface/transformers` source
 * (`src/models/multi_modality/modeling_multi_modality.js`): `generate_images(options)` runs a normal
 * causal-LM `generate()` internally, then decodes the newly generated image tokens into
 * `RawImage[]` via the model's `image_decode` session.
 */
export interface TransformersJsGenerationModel {
  /**
   * Runs a normal causal-LM `generate()` internally, then decodes the newly generated image tokens
   * into `RawImage[]` via the model's `image_decode` session. `options` is the merged
   * processor-inputs + sampling-knobs bag this battery builds per call (see the adapter's `generate`).
   */
  generate_images: (options: Record<string, unknown>) => Promise<TransformersJsRawImageLike[]>
}

/**
 * Structural duck-type of `VLChatProcessor` (or `AutoProcessor.from_pretrained`'s resolved instance)
 * — a callable that builds the `input_ids`/`attention_mask`/image-mask tensors `generate_images`
 * expects, plus the model's fixed per-image token budget it exposes after construction.
 *
 * @remarks
 * Verified against the installed `@huggingface/transformers` source
 * (`src/models/janus/processing_janus.js`): `_call(conversation, { images, chat_template })` returns
 * `{ input_ids, attention_mask, images_seq_mask, images_emb_mask, ... }`; `num_image_tokens` is read
 * off `this.config.num_image_tokens` at construction (the fixed per-image token budget the official
 * model-card example forwards as both `min_new_tokens` and `max_new_tokens`).
 */
export interface TransformersJsGenerationProcessor {
  (
    conversation: Array<{ role: string; content: string }>,
    options?: { chat_template?: string }
  ): Promise<Record<string, unknown>>
  /** The model's fixed per-image token budget (`config.num_image_tokens`). */
  num_image_tokens?: number
}

/**
 * Custom model-source resolver — the dual-environment seam for serving model files from OPFS, a
 * different source, or bundled bytes (see the LLM battery's `model_source` module). Called once per
 * file; return bytes / a path-or-URL string / a `Response`, or `undefined` to fall through to HF.
 */
export type TransformersJsGenerationModelSource = (req: {
  repo: string
  filename: string
}) =>
  | Promise<Uint8Array | string | Response | undefined>
  | Uint8Array
  | string
  | Response
  | undefined

/**
 * Factory for lazily creating the Janus model. Defaults to a dynamic import of
 * `@huggingface/transformers` + `MultiModalityCausalLM.from_pretrained(model, …)`; override to inject
 * a pre-built model or a test double.
 */
export type CreateTransformersJsGenerationModel = (input: {
  model: string
  device?: TransformersJsGenerationDeviceType
  dtype?: TransformersJsGenerationDataType
  onInitProgress?: TransformersJsGenerationProgressCallback
}) => Promise<TransformersJsGenerationModel>

/**
 * Factory for lazily creating the Janus chat/image processor. Defaults to a dynamic import of
 * `@huggingface/transformers` + `AutoProcessor.from_pretrained(model, …)`; override to inject a
 * pre-built processor or a test double.
 */
export type CreateTransformersJsGenerationProcessor = (input: {
  model: string
  onInitProgress?: TransformersJsGenerationProgressCallback
}) => Promise<TransformersJsGenerationProcessor>

/**
 * Test/runtime seam that overrides how a resolved `RawImage`-like value is encoded to PNG bytes,
 * short-circuiting the env-branch (`toBlob`/`toSharp`) entirely. See
 * {@link @nhtio/adk/batteries/generation/transformers_js/helpers!rawImageToEncodedBytes}.
 */
export type EncodeRawImageFn = (image: TransformersJsRawImageLike) => Promise<Uint8Array>

/**
 * Constructor options for {@link @nhtio/adk/batteries/generation/transformers_js/adapter!TransformersJsGenerationAdapter}.
 *
 * @remarks
 * Extends {@link BaseGenerationAdapterOptions} (required `model`, e.g.
 * `onnx-community/Janus-Pro-1B-ONNX` — no default) with the transformers.js Janus knobs.
 *
 * **EXPERIMENTAL:** this engine downloads/runs a ~2GB multimodal model and takes minutes per image on
 * WASM/CPU. There is no WebGPU requirement (transformers.js auto-selects the ONNX Runtime execution
 * provider), but expect this to be materially slower than the OpenAI/Gemini engines.
 */
export interface TransformersJsGenerationAdapterOptions
  extends BaseGenerationAdapterOptions, BatteryLifecycleHooks {
  /**
   * A pre-built Janus model. When provided, the battery uses it directly and skips lazy creation.
   * Named `janusModel` (not `model`) because `model` (from {@link BaseGenerationAdapterOptions}) is
   * already the model **id** string.
   */
  janusModel?: TransformersJsGenerationModel
  /** A pre-built Janus processor. When provided, the battery uses it directly and skips lazy creation. */
  processor?: TransformersJsGenerationProcessor
  /** Override the model factory. Default: `MultiModalityCausalLM.from_pretrained(model, …)` via dynamic import. */
  createModel?: CreateTransformersJsGenerationModel
  /** Override the processor factory. Default: `AutoProcessor.from_pretrained(model, …)` via dynamic import. */
  createProcessor?: CreateTransformersJsGenerationProcessor
  /** Inference device forwarded to `from_pretrained()`. Default: transformers.js environment default. */
  device?: TransformersJsGenerationDeviceType
  /** Quantization/precision dtype forwarded to `from_pretrained()`. */
  dtype?: TransformersJsGenerationDataType
  /**
   * Custom model-source resolver (OPFS / separate source / bundled bytes). When set, model files load
   * through it behind the global-`env` mutex; otherwise straight from HF (unchanged). See
   * {@link TransformersJsGenerationModelSource}.
   */
  modelSource?: TransformersJsGenerationModelSource
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsGenerationProgressCallback
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean
  /**
   * Test/runtime seam overriding how a resolved `RawImage`-like value is encoded to PNG bytes — see
   * {@link EncodeRawImageFn}. Short-circuits the env-branch (`toBlob`/`toSharp`) entirely; the primary
   * hermetic-test seam for `generate()`.
   */
  encodeImage?: EncodeRawImageFn
  /**
   * Default sampling knobs applied when a `generate()` call omits its own — see
   * {@link TransformersJsGenerateOptions} for the per-knob provenance/verification notes.
   */
  doSample?: boolean
  /** Default sampling temperature (`temperature`), applied when a call omits its own. */
  temperature?: number
  /** Default top-k cutoff (`top_k`), applied when a call omits its own. */
  topK?: number
  /** Default classifier-free-guidance scale (`guidance_scale`; CFG activates when `> 1`), applied when a call omits its own. */
  guidanceScale?: number
  /** Default repetition penalty (`repetition_penalty`), applied when a call omits its own. */
  repetitionPenalty?: number
  /** Default Janus chat template name forwarded to the processor call (e.g. `'text_to_image'`), applied when a call omits its own. */
  chatTemplate?: string
  /** Default conversation role used to build the single-turn prompt (Janus convention: `'<|User|>'`). */
  role?: string
}

/**
 * Per-call options accepted by
 * {@link @nhtio/adk/batteries/generation/transformers_js/adapter!TransformersJsGenerationAdapter.generate}.
 *
 * @remarks
 * Every field here overrides the adapter-level default of the same name when present. See the module
 * remarks for the source-verified provenance of each knob (`do_sample`/`temperature`/`top_k`/
 * `guidance_scale`/`repetition_penalty`/`min_new_tokens`/`max_new_tokens`).
 */
export interface TransformersJsGenerateOptions extends GenerateOptions {
  /** Enables multinomial sampling (`do_sample`). The official model-card example sets this `true`. */
  doSample?: boolean
  /** Sampling temperature (`temperature`), applied only when `doSample` is truthy. */
  temperature?: number
  /** Top-k cutoff (`top_k`), read directly by `MultinomialSampler.sample()`. */
  topK?: number
  /** Classifier-free-guidance scale (`guidance_scale`); CFG activates when `> 1`. */
  guidanceScale?: number
  /** Repetition penalty (`repetition_penalty`). */
  repetitionPenalty?: number
  /**
   * Minimum new tokens (`min_new_tokens`). Defaults to the processor's `num_image_tokens` (the model's
   * fixed per-image token budget) when omitted — mirroring the official model-card example.
   */
  minNewTokens?: number
  /**
   * Maximum new tokens (`max_new_tokens`). Defaults to the processor's `num_image_tokens` when omitted
   * — mirroring the official model-card example.
   */
  maxNewTokens?: number
  /** Janus chat template name forwarded to the processor call (e.g. `'text_to_image'`). */
  chatTemplate?: string
  /** Conversation role used to build the single-turn prompt (Janus convention: `'<|User|>'`). */
  role?: string
}
