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
import type { SpoolStore } from '@nhtio/adk/common'
import type {
  ToolCallParserName,
  ToolCallParserFn,
  ReasoningParserName,
  ReasoningParserFn,
} from '../chat_common'
import type {
  ChatCompletionsBucketOrder,
  ChatCompletionsHelpers,
  DescriptionLike,
  JsonSchema,
  ReasoningFieldPrecedence,
  UnsupportedMediaPolicy,
} from '../openai_chat_completions/types'
import type {
  Message as TransformersMessage,
  DataType as TransformersDataType,
  DeviceType as TransformersDeviceType,
  TextGenerationPipeline,
  TextStreamer,
  ProgressCallback,
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

/** Re-export the parser option types so consumers import everything from this battery's barrel. */
export type {
  ToolCallParserName,
  ToolCallParserFn,
  ReasoningParserName,
  ReasoningParserFn,
} from '../chat_common'

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
  device?: TransformersJsDeviceType
  dtype?: TransformersJsDataType
  onInitProgress?: TransformersJsProgressCallback
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
export interface TransformersJsAdapterOptions {
  // ── Engine ──────────────────────────────────────────────────────────────────────────────────────
  /** The model id (e.g. `onnx-community/gemma-4-E2B-it-ONNX`). Required; no default. */
  model: string
  /** A pre-built text-generation pipeline to drive; mutually exclusive with `createPipeline`. */
  pipeline?: TransformersJsPipeline
  /** Custom pipeline factory; overrides the default `pipeline('text-generation', …)` loader. */
  createPipeline?: CreateTransformersJsPipeline
  /** Custom streaming-sink factory; overrides the default `TextStreamer` (avoids importing the peer). */
  createStreamer?: CreateTransformersJsStreamer
  /** Inference device forwarded to `pipeline()`. Default: transformers.js environment default. */
  device?: TransformersJsDeviceType
  /** Quantization/precision dtype forwarded to `pipeline()` (e.g. `'q4f16'`). */
  dtype?: TransformersJsDataType
  /** Called with model-load progress reports while weights download/compile. */
  onInitProgress?: TransformersJsProgressCallback
  /** Override the availability probe. Default: `true` whenever the peer is importable (env-neutral). */
  isAvailable?: () => boolean

  // ── Generation (transformers.js `generate` kwargs) ──────────────────────────────────────────────
  /** Max tokens to generate this turn (`max_new_tokens`). */
  maxNewTokens?: number
  /** Whether to sample (`do_sample`); `false` = greedy/deterministic. */
  doSample?: boolean
  /** Sampling temperature. */
  temperature?: number
  /** Top-K cutoff. */
  topK?: number
  /** Top-P (nucleus) cutoff. */
  topP?: number
  /** Repetition penalty. */
  repetitionPenalty?: number
  /** Stop strings that halt generation. */
  stopStrings?: ReadonlyArray<string>

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
   * How to parse reasoning/thinking out of the model's text output. A family name, `'auto'` (the
   * default), `'none'`, or a custom {@link ReasoningParserFn}. Extracted reasoning becomes ADK Thoughts.
   */
  reasoningParser?: ReasoningParserName | ReasoningParserFn
}

/** The JSON-schema-shaped value used for a tool's `parameters` field (re-export for convenience). */
export type TransformersJsJsonSchema = JsonSchema
/** The description envelope a joi schema produces, consumed by the JSON-schema converter. */
export type TransformersJsDescriptionLike = DescriptionLike
