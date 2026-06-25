/**
 * Types for the LiteRT-LM adapter — options, engine/conversation aliases, and the LiteRT wire
 * shapes re-exported from `@litert-lm/core`.
 *
 * @module @nhtio/adk/batteries/llm/litert_lm/types
 *
 * @remarks
 * **The published `@litert-lm/core` JS guide lags the library.** The shapes below mirror the
 * installed package's type declarations (the source of truth), which expose tool use, channels
 * ("thinking"), sampler controls, and multimodality that the public docs omit. Verify against the
 * installed `.d.ts` when upgrading — the dependency is young and volatile.
 */

import type { TokenEncoding } from '@nhtio/adk'
import type { SpoolStore } from '@nhtio/adk/common'
import type {
  ChatCompletionsBucketOrder,
  ChatCompletionsHelpers,
  DescriptionLike,
  JsonSchema,
  ReasoningFieldPrecedence,
  UnsupportedMediaPolicy,
} from '../openai_chat_completions/types'
import type {
  Engine as LiteRtEngineClass,
  Conversation as LiteRtConversationClass,
  EngineSettings,
  LlmExecutorSettings,
  Message,
  MessageLike,
  MessageContentItem,
  Tool,
  ToolParameters,
  ToolCall,
  ToolCallFunction,
  ToolResponseValue,
  Preface,
  ConversationConfig,
  SessionConfig,
  SamplerParameters,
  SamplerType as LiteRtSamplerTypeEnum,
  Backend as LiteRtBackendEnum,
} from '@litert-lm/core'

// ── LiteRT wire shapes (local aliases of the provider's types — the source of truth) ─────────────────
//
// These are LOCAL aliases (`export type X = Y`), NOT direct `export … from '@litert-lm/core'`
// re-exports. The provider is an externalized optional peer; the bundler (rolldown) cannot resolve a
// star/named re-export through an external module at build time, but a local alias type-checks against
// the installed `.d.ts` and erases cleanly. Mirrors how the WebLLM battery aliases `@mlc-ai/web-llm`.

/** A message in a LiteRT conversation: `{ role, content?, channels?, tool_calls? }`. */
export type LiteRtMessage = Message
/** A string or {@link LiteRtMessage}. */
export type LiteRtMessageLike = MessageLike
/** An item in a message's content array (`{ type, text?, path?, tool_response? }`). */
export type LiteRtMessageContentItem = MessageContentItem
/** A tool definition exposed to the model (`{ name, description?, parameters? }`). */
export type LiteRtTool = Tool
/** Parameters for a {@link LiteRtTool}, following JSON Schema. */
export type LiteRtToolParameters = ToolParameters
/** A tool call predicted by the model (`{ type, function: { name, arguments } }`). */
export type LiteRtToolCall = ToolCall
/** The function payload of a {@link LiteRtToolCall} (`{ name, arguments: object }`). */
export type LiteRtToolCallFunction = ToolCallFunction
/** A tool response value fed back to the model. */
export type LiteRtToolResponseValue = ToolResponseValue
/** Initial messages, tools, and context the conversation begins with. */
export type LiteRtPreface = Preface
/** Configuration for an {@link LiteRtLmConversation}. */
export type LiteRtConversationConfig = ConversationConfig
/** Per-session generation configuration (sampler, modality flags, output limits). */
export type LiteRtSessionConfig = SessionConfig
/** Sampler configuration (`{ type, k, p, temperature, seed }`). */
export type LiteRtSamplerParameters = SamplerParameters
/** Engine-construction settings (`{ model, backend?, mainExecutorSettings? }`). */
export type LiteRtEngineSettings = EngineSettings
/** Per-executor settings (context length, backend config, sampler backend). */
export type LiteRtLlmExecutorSettings = LlmExecutorSettings
/** Sampler-type enum value: `TOP_K`, `TOP_P`, `GREEDY`. */
export type SamplerType = LiteRtSamplerTypeEnum
/** Inference-backend enum value: `CPU`, `GPU`, etc. */
export type Backend = LiteRtBackendEnum

/** The LiteRT-LM engine instance the adapter drives. */
export type LiteRtLmEngine = LiteRtEngineClass
/** Alias of {@link LiteRtLmEngine}. */
export type LiteRtLmChatEngine = LiteRtLmEngine
/** A live LiteRT conversation created from an engine for one dispatch. */
export type LiteRtLmConversation = LiteRtConversationClass

/** Progress report emitted while a LiteRT model loads. Provider-opaque; passed through verbatim. */
export type LiteRtLmInitProgressReport = unknown

/**
 * Factory that loads a `.litertlm` model and resolves a ready-to-use {@link LiteRtLmEngine}.
 *
 * @remarks
 * The default factory (when this option is omitted) dynamically imports `@litert-lm/core` and calls
 * `Engine.create(engineSettings)`. Supply a custom factory to control the WebGPU/worker setup, to
 * inject a pre-warmed engine, or to mock the engine in tests without WebGPU.
 */
export type CreateLiteRtLmEngine = (input: {
  engineSettings: EngineSettings
  onInitProgress?: (report: LiteRtLmInitProgressReport) => void
}) => Promise<LiteRtLmEngine>

// ── Re-export the format-agnostic helper/policy types shared with the chat-completions batteries ──

export type {
  JsonSchema,
  DescriptionLike,
  ChatCompletionsHelpers as LiteRtLmHelpers,
  ChatCompletionsBucketOrder as LiteRtLmBucketOrder,
  UnsupportedMediaPolicy,
} from '../openai_chat_completions/types'

// ── Adapter options ───────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the in-browser LiteRT-LM adapter.
 *
 * @remarks
 * Splits into three groups: **engine** controls (model + injection/loading), **generation** controls
 * (LiteRT-native sampler/limits — NOT OpenAI sampling params), and **ADK-control** options shared with
 * the other LLM batteries (history shaping, trust, storage, media policy).
 */
export interface LiteRtLmAdapterOptions {
  // ── Engine ──────────────────────────────────────────────────────────────────────────────────────
  /**
   * The `.litertlm` model to load: a URL string, a `ReadableStream<Uint8Array>`, or a `Blob`.
   * Required. The model is fixed at engine-load time, not per request.
   */
  model: string | ReadableStream<Uint8Array> | Blob
  /** A pre-constructed engine to drive; mutually exclusive with {@link LiteRtLmAdapterOptions.createEngine}. */
  engine?: LiteRtLmEngine
  /** Custom engine factory; overrides the default `Engine.create(...)` loader. */
  createEngine?: CreateLiteRtLmEngine
  /** Callback invoked with model-load progress reports (provider-opaque). */
  onInitProgress?: (report: LiteRtLmInitProgressReport) => void
  /** Override for the WebGPU-availability probe (defaults to a real `navigator.gpu` check). */
  isWebGPUAvailable?: () => boolean
  /** Optional hint prompt passed to `Engine.create(settings, inputPromptAsHint)` to warm the cache. */
  inputPromptAsHint?: string

  // ── Generation (LiteRT-native) ────────────────────────────────────────────────────────────────────
  /** Sampler configuration: `{ type, k, p, temperature, seed }`. Maps to `SessionConfig.samplerParams`. */
  samplerParams?: LiteRtSamplerParametersOption
  /** Maximum tokens to generate per turn. Maps to `SessionConfig.maxOutputTokens`. */
  maxOutputTokens?: number
  /** Context length. Maps to `EngineSettings.mainExecutorSettings.maxNumTokens`. */
  maxNumTokens?: number
  /** Inference backend (`CPU` / `GPU` / …). Maps to `EngineSettings.backend`. */
  backend?: number
  /** Enable audio input for models that support it. Maps to `SessionConfig.audioModalityEnabled`. */
  audioModalityEnabled?: boolean
  /** Enable vision input for models that support it. Maps to `SessionConfig.visionModalityEnabled`. */
  visionModalityEnabled?: boolean
  /** Enable constrained decoding (channels). Maps to `ConversationConfig.enableConstrainedDecoding`. */
  enableConstrainedDecoding?: boolean
  /** Drop channel ("thinking") content from the KV cache. Maps to `ConversationConfig.filterChannelContentFromKvCache`. */
  filterChannelContentFromKvCache?: boolean

  // ── ADK control (shared with the chat-completions batteries) ──────────────────────────────────────
  /** Stream tokens (default `true`). When `false`, a single completed message is returned. */
  stream?: boolean
  /** Order in which the leading/trailing context buckets are rendered. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Hard context-window token budget; enforced only when {@link LiteRtLmAdapterOptions.tokenEncoding} is non-null. */
  contextWindow?: number
  /** The assistant identity this adapter speaks as (default `'assistant'`). */
  selfIdentity?: string
  /** Which thoughts are surfaced into history. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** Token encoding used for context-window accounting, or `null` to disable accounting (default `null`). */
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
}

/** Sampler-parameters option shape (the `type` field accepts the numeric {@link SamplerType} value). */
export interface LiteRtSamplerParametersOption {
  /** Sampler strategy: `SamplerType.TOP_K | TOP_P | GREEDY`. */
  type?: number
  /** Top-K cutoff. */
  k?: number
  /** Top-P (nucleus) cutoff. */
  p?: number
  /** Sampling temperature. */
  temperature?: number
  /** RNG seed for reproducible sampling. */
  seed?: number
}

/** The JSON-schema-shaped value used for a tool's `parameters` field (re-export for convenience). */
export type LiteRtLmJsonSchema = JsonSchema
/** The description envelope a joi schema produces, consumed by the JSON-schema converter. */
export type LiteRtLmDescriptionLike = DescriptionLike
