/**
 * Types for the transformers.js LLM adapter — options, pipeline aliases, and the parser option types.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/types
 *
 * @remarks
 * transformers.js (`@huggingface/transformers`) is **dual-environment**: its package `exports` map
 * auto-selects `onnxruntime-node` (native, plain Node) vs `onnxruntime-web` (WASM + WebGPU). `device`
 * and `dtype` pick the backend. So this battery is **environment-neutral** — it does NOT gate on
 * `navigator.gpu`.
 *
 * The pipeline/streamer/message shapes are **local aliases** of `@huggingface/transformers` types
 * (`export type X = Y`), never direct re-exports of the externalized peer (which breaks the bundler).
 */

import type { TokenEncoding } from '@nhtio/adk'
import type { DispatchContext } from '@nhtio/adk/types'
import type { BatteryLifecycleHooks } from '../chat_common'
import type { SpoolStore, ToolRegistry } from '@nhtio/adk/common'
import type {
  ChatCompletionsBucketOrder,
  ChatCompletionsHelpers,
  DescriptionLike,
  JsonSchema,
  ReasoningFieldPrecedence,
  UnsupportedMediaPolicy,
} from '../openai_chat_completions/types'
import type {
  ToolCallParserName,
  ToolCallParserFn,
  ReasoningParserName,
  ReasoningParserFn,
  ChatSampler,
  MediaOutputExtractorFn,
  RawGenerationObserverFn,
  PromptAssembledObserverFn,
} from '../chat_common'
import type {
  Message as TransformersMessage,
  DataType as TransformersDataType,
  DeviceType as TransformersDeviceType,
  TextGenerationPipeline,
  TextStreamer,
  ProgressCallback,
  Processor,
  PreTrainedModel,
} from '@huggingface/transformers'

// ── transformers.js wire shapes (local aliases — the source of truth) ─────────────────────────────────

/** A chat message: `{ role, content }` (content is a string for text models). */
export type TransformersJsMessage = TransformersMessage
/** The text-generation pipeline instance the adapter drives. */
export type TransformersJsPipeline = TextGenerationPipeline
/** The callback-based token streamer. */
export type TransformersJsTextStreamer = TextStreamer
/** Quantization/precision dtype: `'auto'|'fp32'|'fp16'|'q8'|'q4'|'q4f16'|…`. */
export type TransformersJsDataType = TransformersDataType
/** Inference device: `'auto'|'webgpu'|'wasm'|'cpu'|'gpu'|…`. */
export type TransformersJsDeviceType = TransformersDeviceType
/** Model-load progress callback. */
export type TransformersJsProgressCallback = ProgressCallback
/** A loaded multimodal model instance (`AutoModelForImageTextToText` output). */
export type TransformersJsModel = PreTrainedModel
/** A loaded multimodal processor instance (`AutoProcessor` output). */
export type TransformersJsProcessor = Processor
/**
 * ONNX Runtime session options forwarded verbatim to transformers.js's `session_options` loader arg.
 *
 * @remarks
 * A REACHABLE LEVER, never auto-applied by the battery (surface, don't impose). Kept structurally open
 * (`Record<string, unknown>`) rather than aliasing `onnxruntime-common`'s `InferenceSession.SessionOptions`
 * directly: that type is not a peer of this battery, and a hard re-export of an external type breaks the
 * bundler (the same reason the wire shapes above are local aliases). Useful keys for the WebGPU EP:
 * `preferredOutputLocation` (`'gpu-buffer'` to keep outputs on GPU for IO-binding), `graphOptimizationLevel`,
 * `enableGraphCapture`. Note `freeDimensionOverrides` cannot pin a KV-cached decoder's dynamic dims.
 */
export type TransformersJsSessionOptions = Record<string, unknown>

/**
 * `device`/`dtype` for a multimodal model: a single value (all submodules) OR a `Record` keyed by ONNX
 * submodule filename (`vision_encoder` / `audio_encoder` / `embed_tokens` / `decoder_model_merged`) —
 * the way to configure each modality's precision/backend separately.
 */
export type TransformersJsDevice =
  | TransformersJsDeviceType
  | Record<string, TransformersJsDeviceType>
/** Per-submodule dtype override (see {@link TransformersJsDevice}). */
export type TransformersJsDtype = TransformersJsDataType | Record<string, TransformersJsDataType>

/**
 * Custom model-source resolver — the seam for OPFS / separate-source / per-submodule loading. Called
 * once per model file (`req.filename` distinguishes `vision_encoder.onnx` from `decoder_model_merged.onnx`).
 * Return bytes, a path/URL string, a `Response`, or `undefined` to fall through to the default HF fetch.
 */
export type TransformersJsModelSource = (req: {
  repo: string
  filename: string
}) =>
  | Promise<Uint8Array | string | Response | undefined>
  | Uint8Array
  | string
  | Response
  | undefined

/** Re-export shared format-agnostic helper/policy types. */
export type {
  JsonSchema,
  DescriptionLike,
  ChatCompletionsHelpers as TransformersJsHelpers,
  ChatCompletionsBucketOrder as TransformersJsBucketOrder,
  UnsupportedMediaPolicy,
} from '../openai_chat_completions/types'

/**
 * Factory that loads a text-generation pipeline and resolves it ready to use.
 *
 * @remarks
 * The default factory dynamically imports `@huggingface/transformers` and calls
 * `pipeline('text-generation', model, { device, dtype, … })`. Supply a custom factory to control
 * loading, inject a pre-warmed pipeline, or mock it in tests.
 */
export type CreateTransformersJsPipeline = (input: {
  model: string
  device?: TransformersJsDevice
  dtype?: TransformersJsDtype
  onInitProgress?: TransformersJsProgressCallback
  /** ONNX Runtime session options forwarded verbatim to `pipeline(...)` as `session_options`. */
  sessionOptions?: TransformersJsSessionOptions
}) => Promise<TransformersJsPipeline>

/**
 * Factory for the streaming token sink passed to the pipeline's `streamer` generate-kwarg.
 *
 * @remarks
 * The default factory dynamically imports `@huggingface/transformers`'s `TextStreamer` and wires its
 * `callback_function` to `onText`. Override to inject a lightweight streamer (e.g. in tests, to avoid
 * importing the heavy peer) — any object the pipeline accepts as `streamer` and that calls `onText`
 * with each decoded text delta works.
 */
export type CreateTransformersJsStreamer = (input: {
  pipeline: TransformersJsPipeline
  onText: (text: string) => void
}) => Promise<unknown> | unknown

/**
 * Factory for the multimodal model+processor pair (used when `multimodal` is enabled instead of the
 * text-generation pipeline). Default: `AutoModelForImageTextToText.from_pretrained(model, {device,dtype})`
 * + `AutoProcessor.from_pretrained(model)`. Override to inject pre-built instances or mock in tests.
 */
export type CreateTransformersJsMultimodal = (input: {
  model: string
  device?: TransformersJsDevice
  dtype?: TransformersJsDtype
  onInitProgress?: TransformersJsProgressCallback
  /** ONNX Runtime session options forwarded verbatim to `from_pretrained(...)` as `session_options`. */
  sessionOptions?: TransformersJsSessionOptions
}) => Promise<{ model: TransformersJsModel; processor: TransformersJsProcessor }>

// ── Adapter options ───────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the transformers.js LLM adapter.
 *
 * @remarks
 * Three groups: **engine** (model + loading), **generation** (transformers.js `generate` kwargs), and
 * **ADK-control** (shared with the other LLM batteries), the last including the two **text-parser
 * selectors** that make this battery work: transformers.js does NOT return structured tool calls or
 * reasoning — the model emits them as family-specific text, and `toolCallParser` / `reasoningParser`
 * choose how that text is parsed.
 */
export interface TransformersJsAdapterOptions extends BatteryLifecycleHooks {
  // ── Engine ──────────────────────────────────────────────────────────────────────────────────────
  /** The model id (e.g. `onnx-community/gemma-4-E2B-it-ONNX`). Required; no default. */
  model: string
  /** A pre-built text-generation pipeline to drive; mutually exclusive with `createPipeline`. */
  pipeline?: TransformersJsPipeline
  /** Custom pipeline factory; overrides the default `pipeline('text-generation', …)` loader. */
  createPipeline?: CreateTransformersJsPipeline
  /** Custom streaming-sink factory; overrides the default `TextStreamer` (avoids importing the peer). */
  createStreamer?: CreateTransformersJsStreamer
  /**
   * Inference device. A single value, or — for a multimodal model — a `Record` keyed by submodule
   * filename (`vision_encoder`/`audio_encoder`/`embed_tokens`/`decoder_model_merged`) to configure each
   * separately. Default: transformers.js environment default.
   */
  device?: TransformersJsDevice
  /** Quantization/precision dtype (e.g. `'q4f16'`), or a per-submodule `Record` (see {@link device}). */
  dtype?: TransformersJsDtype
  /**
   * ONNX Runtime session options forwarded verbatim to the loader's `session_options` arg (both the
   * pipeline and multimodal paths). A REACHABLE LEVER for advanced WebGPU memory/perf control —
   * surfaced, never auto-applied. See {@link TransformersJsSessionOptions} for useful keys. The battery
   * sets no default here; whatever you pass is what the runtime gets.
   */
  sessionOptions?: TransformersJsSessionOptions
  /**
   * Pin the autoregressive KV cache (`present.*` outputs) to GPU buffers on the WebGPU EP, keeping it
   * OFF the ONNX-Runtime-Web **wasm32 linear-memory heap** (hard-capped at 4 GiB). **Default `true`.**
   *
   * @remarks
   * This is the battery's headline in-browser memory default: the wasm32 heap is the wall hit first when
   * running on the WASM/JSEP WebGPU path, and the KV cache is its largest growing consumer across a
   * multi-generate turn. transformers.js is *supposed* to pin this automatically, but its auto-pin
   * silently no-ops on models with nested config (e.g. Gemma-4's `text_config`) — leaving the KV cache
   * on the wasm heap. We apply the pin explicitly by default so the common case "just works".
   *
   * The ESCAPE HATCH: set `false` to disable entirely, or set your own
   * `sessionOptions.preferredOutputLocation` — an explicit value ALWAYS wins and is never overwritten.
   * No effect off the WebGPU EP (there is no `'gpu-buffer'` location on the wasm/cpu backend).
   */
  pinKvCacheToGpu?: boolean
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsProgressCallback
  /**
   * Enable multimodal (image/audio) input. Default off → the text-only path is byte-for-byte unchanged.
   * When on, the model loads via `AutoModelForImageTextToText` + `AutoProcessor` (not the text-generation
   * pipeline), and `Media` attachments on a `Message` are fed to the model. `true` = both modalities the
   * model supports; `{image?,audio?}` restricts which `Media` kinds are sent natively (others degrade via
   * `unsupportedMediaPolicy`). Output is still text → the tool-call/reasoning parsers are unaffected.
   */
  multimodal?: boolean | { image?: boolean; audio?: boolean }
  /** A pre-built multimodal model+processor pair; mutually exclusive with `createMultimodal`. */
  multimodalEngine?: { model: TransformersJsModel; processor: TransformersJsProcessor }
  /** Custom multimodal model+processor factory; overrides the default Auto* loaders. */
  createMultimodal?: CreateTransformersJsMultimodal
  /**
   * Custom model-source resolver (OPFS / separate-source / per-submodule loading). Wraps transformers.js's
   * `env.customCache`; serves each model file from any source. Dual-environment (Node + browser).
   */
  modelSource?: TransformersJsModelSource
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean

  // ── Generation: PORTABLE canonical contract (shared with LiteRT-LM) ──────────────────────────────
  // The cross-battery vocabulary (see {@link ChatGenerationOptions}). Prefer these for portable config:
  // `maxTokens`, `sampler`, `temperature`, `topK`, `topP`, `seed`, `enableThinking`, `multimodal`. When a
  // canonical field AND its transformers.js-native equivalent below are both set, the CANONICAL one wins.
  /** Portable max generation length (canonical spelling of {@link maxNewTokens}). Default `1024`. */
  maxTokens?: number
  /** Portable sampler strategy (`'greedy'` default). `'greedy'`→`do_sample:false`; `'top-k'`/`'top-p'`→
   * `do_sample:true`+the matching cutoff. Canonical spelling of {@link doSample}. */
  sampler?: ChatSampler
  /** RNG seed for reproducible sampling (best-effort). */
  seed?: number

  // ── Generation (transformers.js-NATIVE escape hatches) ───────────────────────────────────────────
  // Every knob is ALWAYS passed to `generate` with an explicit, deterministic-friendly default — the
  // library never falls back to its own guess. These remain as low-level overrides; a canonical field
  // above takes precedence when both are set.
  /** Native max tokens (`max_new_tokens`). Prefer {@link maxTokens}. Default `1024`. */
  maxNewTokens?: number
  /** Native sample flag (`do_sample`); `false` = greedy. Prefer {@link sampler}. */
  doSample?: boolean
  /** Sampling temperature. Default `0.7`. */
  temperature?: number
  /** Top-K cutoff. Default `40`. */
  topK?: number
  /** Top-P (nucleus) cutoff. Default `0.95`. */
  topP?: number
  /** Repetition penalty (always sent). Default `1.1`. */
  repetitionPenalty?: number
  /** Stop strings that halt generation. */
  stopStrings?: ReadonlyArray<string>
  /**
   * Whether to enable the model's "thinking"/reasoning mode, passed EXPLICITLY to the chat template as
   * `enable_thinking`. Defaults to `false` — many reasoning templates (Qwen3, DeepSeek-R1) default
   * thinking ON, which silently burns the token budget inside `<think>` and leaves empty prose. We pin
   * it off unless you opt in. (Independent of `reasoningParser`, which only parses thinking that IS
   * emitted.) Part of the shared {@link ChatGenerationOptions} contract.
   */
  enableThinking?: boolean

  // ── ADK control (shared with the other LLM batteries) ──────────────────────────────────────────
  /** Stream tokens (default `true`). When `false`, a single completed message is returned. */
  stream?: boolean
  /** Order in which the leading/trailing context buckets are rendered. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Hard context-window token budget; enforced only when `tokenEncoding` is non-null. */
  contextWindow?: number
  /** The assistant identity this adapter speaks as (default `'assistant'`). */
  selfIdentity?: string
  /** Which thoughts are surfaced into history. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** Token encoding used for context-window accounting, or `null` to disable (default `null`). */
  tokenEncoding?: TokenEncoding | null
  /** Replay-compatibility tags whose opaque reasoning payloads may be replayed. */
  replayCompatibility?: ReadonlyArray<string>
  /** Precedence order for reasoning/thought fields. */
  reasoningFieldPrecedence?: ReasoningFieldPrecedence
  /** Pluggable per-function overrides for the rendering/translation helpers. */
  helpers?: Partial<ChatCompletionsHelpers>
  /** Byte store for spooling raw tool output (defaults to a per-dispatch in-memory store). */
  spoolStore?: SpoolStore
  /** How to handle media the model cannot natively consume (default `'throw'`). */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Automatically `ctx.ack()` when generation completes with no tool calls (default `false`). */
  autoAck?: boolean
  /**
   * How to parse tool calls out of the model's text output (transformers.js does not return them
   * structured). A family name, `'auto'` (try-all in priority order — the default), `'none'` (disable),
   * or a custom {@link ToolCallParserFn}.
   */
  toolCallParser?: ToolCallParserName | ToolCallParserFn
  /**
   * OPTIONAL hook to SHAPE the artifact-query tools forged from prior-turn SpooledArtifact results, before
   * they merge into the visible tool set. Receives the merged forged registry + dispatch context; returns a
   * (possibly narrowed) registry, applied BEFORE the merge with `ctx.tools`. Lets the assembler keep only the
   * core readers on a tight window (the rest reachable via tool_catalog/call_a_tool). Default absent =
   * identity = backward-compatible. The battery stays budget-agnostic (per the CONTRIBUTING size-threshold
   * rule) — it applies the supplied filter without measuring context; budget logic lives in the caller.
   */
  forgeToolsFilter?: (forged: ToolRegistry, ctx: DispatchContext) => ToolRegistry
  /**
   * How to parse reasoning/thinking out of the model's text output. A family name, `'auto'` (the
   * default), `'none'`, or a custom {@link ReasoningParserFn}. Extracted reasoning becomes ADK Thoughts.
   */
  reasoningParser?: ReasoningParserName | ReasoningParserFn
  /**
   * Recover UNPAIRED reasoning markers (a lone `</think>`, a truncated `<think>`) by inferring the
   * missing half from the pseudo-streaming order, instead of leaking the stray marker into the visible
   * answer. Defaults to `true`. Set `false` for strict pair-only parsing. Ignored when `reasoningParser`
   * is a custom function. Motivated by real gemma-4-E4B WebGPU "randomly emits `</think>`" drift.
   */
  reasoningOrphanRecovery?: boolean
  /**
   * Extract GENERATED media (audio/image/…) from the raw generation result and surface it as
   * attachments on the assistant {@link @nhtio/adk!Message}. Default absent → text-only output, byte-for-byte
   * unchanged. The tested open-weight chat checkpoints emit only text; supply this when wrapping a
   * media-emitting model. Receives the raw transformers.js generation object (the `model.generate` /
   * pipeline output); each returned {@link MediaOutputExtractorFn} descriptor is persisted via
   * `ctx.storeMediaBytes` and attached as a `Media.toolGenerated(...)`.
   */
  extractMediaOutputs?: MediaOutputExtractorFn
  /**
   * Observe the model's RAW text output for each completed generation — fired once per terminal
   * generation, after envelope-stripping + reasoning/tool-call parsing but before the result is
   * persisted, with the complete `rawText`, the residual `cleanedText`, and the extracted
   * `reasoning` / `toolCalls`. Purely observational (return value ignored, errors swallowed). Default
   * absent. This is the supported seam for parser bring-up against a new model, live "why did it
   * abstain?" debugging, and ground-truth fixture capture — the job that previously needed a temporary
   * hook patched into the adapter. See {@link RawGenerationObserverFn}.
   */
  onRawGeneration?: RawGenerationObserverFn
  /**
   * Observe the fully-assembled prompt this battery is about to send TO the model — fired once per
   * terminal generation, the instant assembly completes and BEFORE the pipeline/generate dispatch, with
   * the per-turn `messages` and the `tools` handed to `apply_chat_template`. The mirror of
   * {@link onRawGeneration}. Purely observational (return value ignored, errors swallowed). Default absent.
   * The request is handed back AS-IS — no redaction — so treat it as potentially sensitive if you persist
   * it. See {@link PromptAssembledObserverFn}.
   */
  onPromptAssembled?: PromptAssembledObserverFn
}

/** The JSON-schema-shaped value used for a tool's `parameters` field (re-export for convenience). */
export type TransformersJsJsonSchema = JsonSchema
/** The description envelope a joi schema produces, consumed by the JSON-schema converter. */
export type TransformersJsDescriptionLike = DescriptionLike
