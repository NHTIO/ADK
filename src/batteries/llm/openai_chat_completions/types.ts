/**
 * TypeScript wire shapes, helper contracts, and option types for the Chat Completions battery.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions/types
 *
 * @remarks
 * Shared TypeScript type aliases for the OpenAI Chat Completions adapter — wire shapes,
 * helper input/output shapes, and the adapter's options shape. These are documentation-level
 * types only; runtime validation lives in `validation.ts` (`openAIChatCompletionsOptionsSchema`).
 */

import type { TokenEncoding } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { SpooledArtifact, Media, SpoolStore } from '@nhtio/adk/common'
import type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'
import type {
  Tokenizable,
  Memory,
  Message,
  Thought,
  ToolCall,
  Retrievable,
  Tool,
  ArtifactTool,
  ToolRegistry,
} from '@nhtio/adk/common'
import type {
  JsonSchema,
  ChatCompletionsBucketOrder,
  ChatCompletionsTool,
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
  RawGenerationObserverFn,
  PromptAssembledObserverFn,
  ToolCallIdFilterFn,
} from '../chat_common/types'

// ─── Re-exported shared (wire-shape-agnostic) types ───────────────────────────
// These moved to `../chat_common/types` so the OpenAI battery and the native Ollama battery
// share one definition. They are re-exported here under their original names so every existing
// `@nhtio/adk/batteries/llm/openai_chat_completions` import keeps resolving unchanged.
export type {
  DescriptionLike,
  JsonSchema,
  UntrustedContentAttrs,
  TrustedContentAttrs,
  StandingInstructionAttrs,
  MemoryAttrs,
  RetrievableAttrs,
  ThoughtAttrs,
  ChatCompletionsBucketLabel,
  ChatCompletionsBucketOrder,
  ChatCompletionsTool,
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
} from '../chat_common/types'
export type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'
export type { ToolCallIdFilterFn } from '../chat_common/types'

// ─── Reasoning field precedence ───────────────────────────────────────────────

/**
 * A wire field name that may carry model reasoning/thinking output on an OpenAI-compatible
 * Chat Completions response.
 *
 * @remarks
 * Neither name is part of OpenAI's official Chat Completions spec (OpenAI hides reasoning on Chat
 * Completions and surfaces it only on the Responses API). They are de-facto, provider-specific
 * conventions: `reasoning_content` originates with legacy vLLM (≤0.8) and the DeepSeek API, while
 * `reasoning` is what Ollama's `/v1` and current vLLM (post-rename) emit.
 */
export type ReasoningField = 'reasoning' | 'reasoning_content'

/**
 * Ordered precedence list of reasoning wire fields. See
 * {@link OpenAIChatCompletionsAdapterOptions.reasoningFieldPrecedence}.
 */
export type ReasoningFieldPrecedence = ReadonlyArray<ReasoningField>

/**
 * A single reasoning trace extracted from a response message or stream delta — the wire `field` it
 * came from and its `content`. Returned by `extractReasoningFields`.
 */
export interface ReasoningExtract {
  /**
   * The reasoning field name.
   */
  field: ReasoningField
  /**
   * The content of the reasoning block.
   */
  content: string
}

// ─── Wire shapes ──────────────────────────────────────────────────────────────

/**
 * Wire representation of a tool call in a chat completion response or request.
 */
export interface ChatCompletionsToolCallWire {
  /**
   * Unique identifier for the tool call.
   */
  id: string
  /**
   * Type of the tool call, typically 'function'.
   */
  type?: 'function'
  /**
   * Function detail payload.
   */
  function?: {
    name?: string
    arguments?: string
  }
}

/**
 * Discriminated union of content block shapes accepted by the OpenAI Chat Completions wire
 * format for a content-array message body.
 *
 * @remarks
 * `text` is the trust-envelope-wrapped string body. `image_url` carries either an inline
 * `data:` URI or a remote URL. `input_audio` carries base64-encoded audio plus a format hint.
 * `file` carries either a previously-uploaded `file_id` or an inline `file_data` blob with
 * a `filename`.
 */
export type ChatCompletionsContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }
  | { type: 'file'; file: { file_id?: string; filename?: string; file_data?: string } }

/**
 * Chat completion message wire object.
 */
export interface ChatCompletionsMessage {
  /**
   * The role of the author of this message.
   */
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  /**
   * The contents of the message.
   */
  content: string | ChatCompletionsContentBlock[] | null
  /**
   * An optional name for the participant.
   */
  name?: string
  /**
   * Tool call identifier if responding to a tool call.
   */
  tool_call_id?: string
  /**
   * The tool calls generated by the model.
   */
  tool_calls?: ChatCompletionsToolCallWire[]
}

/**
 * Part of a tool call in a streaming response.
 */
export interface ChatCompletionsToolCallDelta {
  /**
   * The index of the tool call in the stream.
   */
  index: number
  /**
   * The identifier of the tool call.
   */
  id?: string
  /**
   * The tool type, typically 'function'.
   */
  type?: 'function'
  /**
   * The partial function name or arguments.
   */
  function?: {
    name?: string
    arguments?: string
  }
}

/**
 * An assembled tool call ready for execution.
 */
export interface AssembledToolCall {
  /**
   * Unique identifier for the tool call.
   */
  id: string
  /**
   * Type of tool call, typically 'function'.
   */
  type: 'function'
  /**
   * Name of the function to call.
   */
  name: string
  /**
   * Stringified JSON arguments for the function.
   */
  args: string
}

/**
 * Accumulator for stitching together streaming tool call deltas into fully-assembled tool calls.
 */
export interface ChatCompletionsToolCallDeltaAccumulator {
  /**
   * Feeds a tool call delta into the accumulator.
   */
  feed(delta: ChatCompletionsToolCallDelta): void
  /**
   * Drains and returns the completed assembled tool calls.
   */
  drain(): AssembledToolCall[]
}

/**
 * Stream delta payload for a chat completion choice chunk.
 */
export interface ChatCompletionsChunkDelta {
  /**
   * Optional role of the message author.
   */
  role?: 'assistant'
  /**
   * The content block text fragment.
   */
  content?: string | null
  /**
   * De-facto field for model reasoning output.
   */
  reasoning_content?: string | null
  /**
   * Non-spec, provider-specific reasoning channel. Emitted by Ollama's `/v1` and current vLLM
   * (which renamed `reasoning_content` → `reasoning`); see {@link OpenAIChatCompletionsAdapterOptions.reasoningFieldPrecedence}.
   */
  reasoning?: string | null
  /**
   * Partial stream deltas for tool calls.
   */
  tool_calls?: ChatCompletionsToolCallDelta[]
}

/**
 * A choice option in a streaming chat completions chunk.
 */
export interface ChatCompletionsChunkChoice {
  /**
   * Index of the choice in the completions list.
   */
  index?: number
  /**
   * The stream delta object.
   */
  delta?: ChatCompletionsChunkDelta
  /**
   * The reason the generation stopped.
   */
  finish_reason?: string | null
}

/**
 * Streaming chunk response from a chat completion API.
 */
export interface ChatCompletionsChunk {
  /**
   * Unique identifier for the chunk.
   */
  id?: string
  /**
   * The object type, typically 'chat.completion.chunk'.
   */
  object?: string
  /**
   * Unix timestamp when the chunk was created.
   */
  created?: number
  /**
   * The model name used for generation.
   */
  model?: string
  /**
   * List of chunk choice options.
   */
  choices?: ChatCompletionsChunkChoice[]
  /**
   * Token usage statistics if requested.
   */
  usage?: Record<string, unknown>
}

/**
 * A message response in non-streaming chat completions.
 */
export interface ChatCompletionsResponseMessage {
  /**
   * Role of the message author.
   */
  role?: 'assistant'
  /**
   * Text contents of the response.
   */
  content?: string | null
  /**
   * De-facto field for model reasoning output.
   */
  reasoning_content?: string | null
  /**
   * Non-spec, provider-specific reasoning channel. Emitted by Ollama's `/v1` and current vLLM
   * (which renamed `reasoning_content` → `reasoning`); see {@link OpenAIChatCompletionsAdapterOptions.reasoningFieldPrecedence}.
   */
  reasoning?: string | null
  /**
   * The tool calls returned by the model.
   */
  tool_calls?: ChatCompletionsToolCallWire[]
}

/**
 * A choice returned in non-streaming chat completions.
 */
export interface ChatCompletionsResponseChoice {
  /**
   * Index of the choice in the list.
   */
  index?: number
  /**
   * Message response payload.
   */
  message?: ChatCompletionsResponseMessage
  /**
   * Reason why the model finished generating.
   */
  finish_reason?: string | null
}

/**
 * Non-streaming chat completion response payload.
 */
export interface ChatCompletionsResponse {
  /**
   * Unique identifier for the response.
   */
  id?: string
  /**
   * Object type, typically 'chat.completion'.
   */
  object?: string
  /**
   * Unix timestamp when the response was created.
   */
  created?: number
  /**
   * Model used for completion.
   */
  model?: string
  /**
   * List of choices generated by the model.
   */
  choices?: ChatCompletionsResponseChoice[]
  /**
   * Token usage statistics.
   */
  usage?: Record<string, unknown>
}

// ─── Helpers bag ──────────────────────────────────────────────────────────────

/**
 * Full translation-helper contract for the OpenAI Chat Completions battery.
 *
 * @remarks
 * Extends the wire-shape-agnostic {@link ChatHelpersCommon} (the string/JSON-Schema/tool-definition
 * renderers shared with the Ollama battery) and adds the OpenAI-wire-specific members: timeline
 * message rendering (content blocks), tool-call-result rendering (content blocks), full-history
 * assembly (synthetic `assistant.tool_calls` + `tool.tool_call_id` shape), and the streaming
 * tool-call delta accumulator. The `deps` parameters reference {@link ChatHelpersCommon} member
 * types, so this interface carries no self-referential typing for the shared helpers.
 */
export interface ChatCompletionsHelpers extends ChatHelpersCommon {
  /**
   * Renders a timeline message into a wire-formatted message.
   */
  renderTimelineMessage: (input: {
    message: Message
    selfIdentity: string
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<ChatCompletionsMessage>
  /**
   * Renders tool call result payloads into the corresponding wire-formatted message content blocks or text.
   */
  renderChatCompletionsToolCallResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<string | ChatCompletionsContentBlock[]>
  /**
   * Builds the entire chat history (system prompts, memories, retrievables, timeline, and thoughts) into wire format.
   */
  buildChatCompletionsHistory: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    messages: Iterable<Message>
    thoughts: Iterable<Thought>
    toolCalls: Iterable<ToolCall>
    tools: ToolRegistry
    renderedToolCallResults: Map<ToolCall, string | ChatCompletionsContentBlock[]>
    bucketOrder: ChatCompletionsBucketOrder
    selfIdentity: string
    thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
    replayCompatibility: ReadonlyArray<string>
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderChatCompletionsToolCallResult: ChatCompletionsHelpers['renderChatCompletionsToolCallResult']
    renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderTimelineMessage: ChatCompletionsHelpers['renderTimelineMessage']
    renderThought: ChatHelpersCommon['renderThought']
    filterThoughts: ChatHelpersCommon['filterThoughts']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<{
    messages: ChatCompletionsMessage[]
    reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  }>
  /**
   * Instantiates a new tool call delta accumulator for streaming responses.
   */
  createChatCompletionsToolCallDeltaAccumulator: () => ChatCompletionsToolCallDeltaAccumulator
}

// ─── Request body ─────────────────────────────────────────────────────────────

/**
 * Request body structure for the OpenAI Chat Completions API.
 */
export interface OpenAIChatCompletionsRequestBody {
  /**
   * ID of the model to use.
   */
  model: string
  /**
   * A list of messages comprising the conversation history so far.
   */
  messages: ChatCompletionsMessage[]
  /**
   * If set, partial message deltas will be sent as server-sent events.
   */
  stream: boolean
  /**
   * A list of tools the model may call.
   */
  tools?: ChatCompletionsTool[]
  /**
   * Side-channel for opaque vendor reasoning payloads. Forwarded to gateways that understand
   * them; stripped by gateways that don't.
   */
  _adk_reasoning_payloads?: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  [key: string]: unknown
}

// ─── Adapter options ──────────────────────────────────────────────────────────

/**
 * Configuration options for the OpenAI Chat Completions adapter.
 */
export interface OpenAIChatCompletionsAdapterOptions {
  // ADK control
  /** API key for authenticating requests to the OpenAI-compatible service. */
  apiKey?: string
  /** Base URL for the OpenAI-compatible API endpoint. */
  baseURL?: string
  /** Extra HTTP headers to include with each request. */
  headers?: Record<string, string>
  /** Whether to stream the completion response chunk by chunk. */
  stream?: boolean
  /** Idle timeout in milliseconds for the stream before aborting. */
  streamIdleTimeoutMs?: number
  /** Request timeout in milliseconds for API calls. */
  requestTimeoutMs?: number
  /** Configures request retry behavior. */
  retry?: ChatCompletionsRetryConfig
  /** Custom fetch implementation to use for HTTP requests. */
  fetch?: typeof globalThis.fetch
  /** Determines order of memory and retrievable buckets in history assembly. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Size of the model's token context window. */
  contextWindow?: number
  /** Unique identity label for the assistant instance. */
  selfIdentity?: string
  /** Determines which thoughts are surfaced back to the model. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** Tokenizer encoding configuration for token counting. */
  tokenEncoding?: TokenEncoding | null
  /** List of replay labels supported by the assistant. */
  replayCompatibility?: ReadonlyArray<string>

  /**
   * Ordered precedence of the wire fields the adapter reads for model reasoning/thinking output.
   *
   * @remarks
   * Reasoning is not part of OpenAI's official Chat Completions spec, so OpenAI-compatible providers
   * disagree on the field name: Ollama's `/v1` and current vLLM emit `reasoning`, while legacy vLLM
   * (≤0.8) and the DeepSeek API emit `reasoning_content`. The adapter reads every field in this list
   * that is present on the response.
   *
   * Precedence governs two things. When more than one listed field is present with **identical**
   * content (or only one is present), the adapter emits a single thought attributed to the
   * highest-precedence field. When listed fields are present with **divergent** content, each
   * surfaces as its own thought (ordered by precedence) rather than silently dropping one — a thought
   * stream is the wrong place to lose data.
   *
   * @defaultValue `['reasoning', 'reasoning_content']`
   */
  reasoningFieldPrecedence?: ReasoningFieldPrecedence
  /** Optional overrides for OpenAI chat completions helpers. */
  helpers?: Partial<ChatCompletionsHelpers>

  /**
   * Backing store for `string` / `Uint8Array` tool returns. Tool output bytes are written under the
   * tool call's id; the resulting {@link @nhtio/adk!SpooledArtifact} (or the tool's configured
   * subclass) is the model-visible handle for the rest of the turn.
   *
   * @remarks
   * Defaults to a fresh, ephemeral per-dispatch {@link @nhtio/adk/batteries/storage/in_memory!InMemorySpoolStore}.
   * Inject an {@link @nhtio/adk/batteries/storage/opfs!OpfsSpoolStore} or a Flydrive-backed store to
   * persist artifacts to durable storage (and to stream large/binary tool output to disk rather than
   * buffering it in memory).
   *
   * **Lifetime / namespacing:** the default store is per-dispatch, so tool-call ids only need to be
   * unique within a dispatch. An injected durable store persists across turns and dispatches, so the
   * tool-call ids used as keys must be globally unique for that store (or the store must apply its
   * own `keyPrefix`); the adapter does not namespace keys for you, and it does not delete entries —
   * lifetime and cleanup of an injected store are the consumer's responsibility.
   *
   * @defaultValue a new `InMemorySpoolStore` per dispatch
   */
  spoolStore?: SpoolStore
  /**
   * When `tool_choice` (or the `allowed_tools` variant) forces the model onto a specific tool
   * name, and that name resolves to an ephemeral, forged artifact-query tool (one produced by
   * `<Subclass>.forgeTools(ctx)` — i.e. `tool.ephemeral === true`), this flag controls how the
   * adapter reacts:
   *
   *   - `false` (default): emit a single `helpers.log.warn({ kind: 'tool-choice-forged-artifact', ... })`
   *     record and continue. Forging an artifact-query tool by name is almost always a
   *     misconfiguration — the tool may not exist in the next iteration once the artifact ages
   *     out — but the call still goes through.
   *   - `true`: hard-fail with `E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS`. Use this in
   *     production deployments where forcing a forged tool indicates a real bug.
   *
   * @defaultValue `false`
   */
  strictToolChoice?: boolean

  /**
   * Policy for how the adapter handles a {@link @nhtio/adk!Media} instance whose modality the OpenAI Chat
   * Completions wire format does not natively support (today: video). See
   * {@link UnsupportedMediaPolicy}.
   *
   * @defaultValue `'throw'`
   */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy

  /**
   * Whether the executor should call {@link @nhtio/adk!DispatchContext.ack | ctx.ack()} itself when a
   * generation completes with no tool calls (a terminal text answer).
   *
   * @remarks
   * `ack()` is terminal and one-shot: once called, the dispatch loop exits after the current
   * iteration. When the executor acks automatically, it seizes turn-completion control from the
   * implementor — a `dispatchOutputPipeline` quality gate can never run, because the signal is
   * already set before the output pipeline executes.
   *
   * This option therefore defaults to **`false`** (opt-in). With `autoAck: false`, a tool-call-free
   * response leaves the context unsignalled and the executor returns; the implementor's output
   * pipeline (or a later iteration) is responsible for calling `ctx.ack()` / `ctx.nack()`. This is
   * the seam that makes output-side quality gates (citation enforcement, schema validation,
   * regenerate-on-reject) possible.
   *
   * Set `autoAck: true` to restore single-shot behavior: the executor acks the moment a
   * tool-call-free answer finishes, terminating the turn without giving the output pipeline a vote.
   * The tool-call path is unaffected by this flag — it always withholds ack so the runner can
   * iterate and execute the calls. Error paths always {@link @nhtio/adk!DispatchContext.nack | nack}
   * regardless of this flag.
   *
   * @defaultValue `false`
   */
  autoAck?: boolean

  // Chat Completions request body
  /** Name of the model to use for completion. */
  model: string
  /** Parameters for audio output if requested. */
  audio?: { voice: string; format: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16' }
  /** Frequency penalty wire field to discourage repeating words. */
  frequency_penalty?: number
  /** Deprecated wire field to control which function is called. */
  function_call?: 'none' | 'auto' | { name: string }
  /** Deprecated list of functions available to the model. */
  functions?: Array<{ name: string; description?: string; parameters?: JsonSchema }>
  /** Bias logits to control token generation likelihood. */
  logit_bias?: Record<string, number>
  /** Request log probabilities for generated tokens. */
  logprobs?: boolean
  /** Hard limit on token count for model reasoning/completion. */
  max_completion_tokens?: number
  /** Maximum number of generated tokens. */
  max_tokens?: number
  /** Metadata key-value pairs forwarded to the provider. */
  metadata?: Record<string, string>
  /** Desired modalities for model output, such as text and audio. */
  modalities?: Array<'text' | 'audio'>
  /** Number of completions to generate for each request. */
  n?: number
  /** Allow the model to emit multiple tool calls in one turn. */
  parallel_tool_calls?: boolean
  /** Prediction helper to accelerate latency of known content. */
  prediction?: {
    type: 'content'
    content: string | Array<{ type: 'text'; text: string }>
  }
  /** Presence penalty wire field to encourage new topics. */
  presence_penalty?: number
  /** Vendor cache key for caching system prompts. */
  prompt_cache_key?: string
  /** Cache retention strategy for cached system prompts. */
  prompt_cache_retention?: 'in_memory' | '24h'
  /** Target reasoning depth/effort for reasoning models. */
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  /** Enforces a specific output format, e.g. JSON schema. */
  response_format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | {
        type: 'json_schema'
        json_schema: {
          name: string
          schema: JsonSchema
          strict?: boolean
          description?: string
        }
      }
  /** Unique safety system identifier or configuration ID. */
  safety_identifier?: string
  /** Deterministic random seed for generation. */
  seed?: number
  /** Service reliability tier for processing the request. */
  service_tier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale'
  /** Custom stop sequence strings. */
  stop?: string | string[]
  /** Request the provider to store the completed trace. */
  store?: boolean
  /** Configuration options for response streaming. */
  stream_options?: { include_usage?: boolean; include_obfuscation?: boolean }
  /** Sampling temperature control. */
  temperature?: number
  /** Enforce or disable tool execution selection. */
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | { type: 'custom'; custom: { name: string } }
    | {
        type: 'allowed_tools'
        allowed_tools: {
          mode: 'auto' | 'required'
          tools: Array<
            | { type: 'function'; function: { name: string } }
            | { type: 'custom'; custom: { name: string } }
          >
        }
      }
  /** Top log probability tokens limit. */
  top_logprobs?: number
  /** Nucleus sampling probability threshold. */
  top_p?: number
  /** End-user identifier for abuse monitoring. */
  user?: string
  /** Diagnostics verbosity level. */
  verbosity?: 'low' | 'medium' | 'high'
  /** Configuration for built-in web search. */
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high'
    user_location?: {
      type: 'approximate'
      approximate: {
        city?: string
        country?: string
        region?: string
        timezone?: string
      }
    }
  }
  /**
   * Observe the model's RAW response for each completed generation — fired once per terminal generation,
   * after the provider's reply is parsed but before the result is persisted, with the returned assistant
   * content (`rawText`), the residual `cleanedText`, and the extracted `reasoning` / `toolCalls`. Purely
   * observational (return value ignored, errors swallowed). Default absent. An ADK-control key — stripped
   * from the wire request body, never sent to the provider. See {@link RawGenerationObserverFn}.
   */
  onRawGeneration?: RawGenerationObserverFn
  /**
   * Observe the fully-assembled request this battery is about to POST TO the provider — fired once per
   * terminal generation, the instant the body is built and BEFORE the fetch, with the wire `messages`,
   * `tools`, and the complete `requestBody`. The mirror of {@link onRawGeneration}. Purely observational
   * (return value ignored, errors swallowed). Default absent. An ADK-control key — stripped from the wire
   * request body, never sent to the provider. The request is handed back AS-IS — no redaction — so treat
   * it as potentially sensitive (it may contain auth material that rode the body) if you persist it. See
   * {@link PromptAssembledObserverFn}.
   */
  onPromptAssembled?: PromptAssembledObserverFn
  /**
   * OPTIONAL fallback parser for tool calls the provider did NOT return structurally.
   *
   * @remarks
   * The Chat Completions `message.tool_calls` array is authoritative: when the provider returns tool
   * calls, those are used and this option is never consulted. But some models — especially small local
   * ones served through an OpenAI-compatible endpoint — emit a tool call in a surface form the endpoint
   * does not lift into `tool_calls`: `<call:name{…}`, a fenced ```` ```json ```` block, `<tool_code…>`, or
   * bare `name\nkey: value`. Those land as plain assistant `content` with `tool_calls` empty, silently
   * dropping the call. This is a cross-model, cross-weight reality, not a single-endpoint quirk.
   *
   * Set this to a parser family name (e.g. `'gemma'`), `'auto'` (try every bundled parser in priority
   * order), or a custom {@link ToolCallParserFn} to recover such calls from `content` ONLY when the
   * provider returned none. Recovered calls execute exactly like native ones. Default absent = disabled =
   * today's native-only behaviour (fully backward-compatible). Mirrors the on-device batteries'
   * `toolCallParser`, which parse from text unconditionally because those runtimes never return structured
   * calls.
   */
  localToolCallParser?: ToolCallParserName | ToolCallParserFn
  /** Optional ingress hook for adapting provider tool-call ids; absent preserves the vendor id. */
  toolCallIdFilter?: ToolCallIdFilterFn
  /**
   * OPTIONAL hook to SHAPE the artifact-query tools forged from prior-turn SpooledArtifact results, before
   * they merge into the visible tool set. Receives the merged forged registry + dispatch context; returns a
   * (possibly narrowed) registry, applied BEFORE the merge with `ctx.tools`. Lets the assembler keep only the
   * core readers on a tight window (the rest reachable via tool_catalog/call_a_tool). Default absent =
   * identity (all forged tools) = backward-compatible. The battery stays budget-agnostic (per the CONTRIBUTING
   * size-threshold rule) — it applies the supplied filter without measuring context; budget logic lives in the
   * caller's filter.
   */
  forgeToolsFilter?: (forged: ToolRegistry, ctx: DispatchContext) => ToolRegistry
}
