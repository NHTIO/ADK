/**
 * TypeScript wire shapes, helper contracts, and option types for the Anthropic Messages battery.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/types
 *
 * @remarks
 * Type aliases for the Anthropic Messages adapter, the adapter's options shape, and the
 * {@link AnthropicMessagesHelpers} contract. Runtime validation lives in `validation.ts`.
 *
 * SDK-owned wire shapes are surfaced as local aliases only. Do not replace these with named
 * re-exports from `@anthropic-ai/sdk`: the package is an external optional peer, and direct named
 * re-exports through it fail the generated package build even when TypeScript type-checking passes.
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
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
  RawGenerationObserverFn,
  PromptAssembledObserverFn,
} from '../chat_common/types'
import type {
  CacheControlEphemeral,
  ContentBlock,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  JSONOutputFormat,
  Message as SdkMessage,
  MessageCountTokensParams,
  MessageCreateParams,
  MessageCreateParamsBase,
  MessageDeltaUsage,
  MessageParam,
  MessageTokensCount,
  Model,
  OutputConfig,
  RawContentBlockDelta,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawContentBlockStopEvent,
  RawMessageDeltaEvent,
  RawMessageStartEvent,
  RawMessageStopEvent,
  RawMessageStreamEvent,
  RedactedThinkingBlock,
  RedactedThinkingBlockParam,
  RefusalStopDetails,
  StopReason,
  TextBlockParam,
  ThinkingBlock,
  ThinkingBlockParam,
  ThinkingConfigParam,
  Tool as SdkTool,
  ToolChoice,
  ToolResultBlockParam,
  ToolUseBlock,
  ToolUseBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages'

// ─── Re-exported shared types ────────────────────────────────────────────────
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
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
} from '../chat_common/types'
export type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'

// ─── SDK wire aliases ────────────────────────────────────────────────────────

/** Anthropic SDK model identifier type. */
export type AnthropicModel = Model
/** Anthropic SDK create-request union. */
export type AnthropicMessageCreateParams = MessageCreateParams
/** Anthropic SDK create-request base shape. */
export type AnthropicMessageCreateParamsBase = MessageCreateParamsBase
/** Anthropic SDK input message shape. */
export type AnthropicMessageParam = MessageParam
/** Anthropic SDK response message shape. */
export type AnthropicMessage = SdkMessage
/** Anthropic SDK content block union returned by the model. */
export type AnthropicContentBlock = ContentBlock
/** Anthropic SDK input content block union. */
export type AnthropicContentBlockParam = ContentBlockParam
/** Anthropic SDK text block input shape. */
export type AnthropicTextBlockParam = TextBlockParam
/** Anthropic SDK image block input shape. */
export type AnthropicImageBlockParam = ImageBlockParam
/** Anthropic SDK document block input shape. */
export type AnthropicDocumentBlockParam = DocumentBlockParam
/** Anthropic SDK tool-result block input shape. */
export type AnthropicToolResultBlockParam = ToolResultBlockParam
/** Anthropic SDK tool-use block response shape. */
export type AnthropicToolUseBlock = ToolUseBlock
/** Anthropic SDK tool-use block input shape. */
export type AnthropicToolUseBlockParam = ToolUseBlockParam
/** Anthropic SDK client tool definition shape. */
export type AnthropicTool = SdkTool
/** Anthropic SDK tool-choice union. */
export type AnthropicToolChoice = ToolChoice
/** Anthropic SDK thinking configuration union. */
export type AnthropicThinkingConfigParam = ThinkingConfigParam
/** Anthropic SDK signed thinking block response shape. */
export type AnthropicThinkingBlock = ThinkingBlock
/** Anthropic SDK signed thinking block input shape. */
export type AnthropicThinkingBlockParam = ThinkingBlockParam
/** Anthropic SDK redacted thinking block response shape. */
export type AnthropicRedactedThinkingBlock = RedactedThinkingBlock
/** Anthropic SDK redacted thinking block input shape. */
export type AnthropicRedactedThinkingBlockParam = RedactedThinkingBlockParam
/** Anthropic SDK stream-event union. */
export type AnthropicRawMessageStreamEvent = RawMessageStreamEvent
/** Anthropic SDK message-start stream event. */
export type AnthropicRawMessageStartEvent = RawMessageStartEvent
/** Anthropic SDK message-delta stream event. */
export type AnthropicRawMessageDeltaEvent = RawMessageDeltaEvent
/** Anthropic SDK message-stop stream event. */
export type AnthropicRawMessageStopEvent = RawMessageStopEvent
/** Anthropic SDK content-block-start stream event. */
export type AnthropicRawContentBlockStartEvent = RawContentBlockStartEvent
/** Anthropic SDK content-block-delta stream event. */
export type AnthropicRawContentBlockDeltaEvent = RawContentBlockDeltaEvent
/** Anthropic SDK content-block-stop stream event. */
export type AnthropicRawContentBlockStopEvent = RawContentBlockStopEvent
/** Anthropic SDK content-block delta union. */
export type AnthropicRawContentBlockDelta = RawContentBlockDelta
/** Anthropic SDK usage shape for completed messages. */
export type AnthropicUsage = Usage
/** Anthropic SDK streaming usage snapshot shape. */
export type AnthropicMessageDeltaUsage = MessageDeltaUsage
/** Anthropic SDK stop-reason union. */
export type AnthropicStopReason = StopReason
/** Anthropic SDK refusal details shape. */
export type AnthropicRefusalStopDetails = RefusalStopDetails
/** Anthropic SDK output-configuration shape. */
export type AnthropicOutputConfig = OutputConfig
/** Anthropic SDK JSON structured-output format shape. */
export type AnthropicJSONOutputFormat = JSONOutputFormat
/** Anthropic SDK cache-control breakpoint shape. */
export type AnthropicCacheControlEphemeral = CacheControlEphemeral
/** Anthropic SDK token-count request shape. */
export type AnthropicMessageCountTokensParams = MessageCountTokensParams
/** Anthropic SDK token-count response shape. */
export type AnthropicMessageTokensCount = MessageTokensCount

// ─── ADK-specific Anthropic helper shapes ────────────────────────────────────

/**
 * Opaque payload stored on a replayable Anthropic thinking `Thought`.
 */
export type AnthropicThinkingReplayPayload =
  | {
      /** Payload variant for a signed thinking block. */
      variant: 'thinking'
      /** Thinking text exactly as emitted by Anthropic. */
      thinking: string
      /** Signature exactly as emitted by Anthropic. */
      signature: string
      /** Stable fingerprint of the signed conversation prefix. */
      prefixFingerprint: string
    }
  | {
      /** Payload variant for a redacted thinking block. */
      variant: 'redacted_thinking'
      /** Redacted thinking data exactly as emitted by Anthropic. */
      data: string
      /** Stable fingerprint of the signed conversation prefix. */
      prefixFingerprint: string
    }

/** Cache-breakpoint placement mode for Anthropic prompt caching. */
export type AnthropicCacheBreakpoints = 'auto' | 'system-only' | 'off'

/** Optional TTL value for Anthropic prompt-cache breakpoints. */
export type AnthropicCacheTtl = '5m' | '1h'

/**
 * Full translation-helper contract for the Anthropic Messages battery.
 */
export interface AnthropicMessagesHelpers extends ChatHelpersCommon {
  /** Translates the ADK tool registry into Anthropic client-tool definitions. */
  anthropicToolsFromTools: (
    tools: ReadonlyArray<Tool | ArtifactTool>,
    deps: {
      descriptionToChatCompletionsJsonSchema: (d: unknown) => JsonSchema
    }
  ) => AnthropicTool[]
  /** Renders an ADK timeline message into an Anthropic input message. */
  renderAnthropicTimelineMessage: (input: {
    message: Message
    selfIdentity: string
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderAnthropicMediaBlocks: AnthropicMessagesHelpers['renderAnthropicMediaBlocks']
    warn?: (msg: string) => void
  }) => Promise<AnthropicMessageParam | null>
  /** Renders one ADK media value into Anthropic content blocks. */
  renderAnthropicMediaBlocks: (input: {
    media: Media
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<AnthropicContentBlockParam[]>
  /** Renders the directions-bearing handle body for a non-inlined spooled artifact. */
  renderArtifactHandleBody?: ChatHelpersCommon['renderArtifactHandleBody']
  /** Renders a tool call's result into Anthropic tool-result content blocks. */
  renderAnthropicToolCallResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    renderAnthropicMediaBlocks: AnthropicMessagesHelpers['renderAnthropicMediaBlocks']
    renderArtifactHandleBody?: AnthropicMessagesHelpers['renderArtifactHandleBody']
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<AnthropicToolResultBlockParam>
  /** Renders the system prompt as segmented Anthropic text blocks for cache breakpoints. */
  renderAnthropicSegmentedSystemPrompt: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    bucketOrder: ChatCompletionsBucketOrder
    cacheBreakpoints: AnthropicCacheBreakpoints
    cacheTtl?: AnthropicCacheTtl
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    warn?: (msg: string) => void
  }) => Promise<AnthropicTextBlockParam[]>
  /** Converts a replayable Anthropic thinking `Thought` into wire content blocks. */
  renderAnthropicThinkingBlocks: (input: {
    thought: Thought
    model: string
    prefixFingerprint: string
    replayCompatibility: ReadonlyArray<string>
    warn?: (msg: string) => void
  }) => AnthropicContentBlockParam[]
  /** Assembles the full Anthropic Messages history, system prompt, tools, and thinking replay. */
  buildAnthropicMessagesHistory: (input: {
    model: string
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    messages: Iterable<Message>
    thoughts: Iterable<Thought>
    toolCalls: Iterable<ToolCall>
    tools: ToolRegistry
    renderedToolCallResults: Map<string, AnthropicToolResultBlockParam>
    bucketOrder: ChatCompletionsBucketOrder
    selfIdentity: string
    thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
    replayCompatibility: ReadonlyArray<string>
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    cacheBreakpoints: AnthropicCacheBreakpoints
    cacheTtl?: AnthropicCacheTtl
    renderAnthropicToolCallResult: AnthropicMessagesHelpers['renderAnthropicToolCallResult']
    renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
    renderAnthropicSegmentedSystemPrompt: AnthropicMessagesHelpers['renderAnthropicSegmentedSystemPrompt']
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderAnthropicTimelineMessage: AnthropicMessagesHelpers['renderAnthropicTimelineMessage']
    renderThought: ChatHelpersCommon['renderThought']
    filterThoughts: ChatHelpersCommon['filterThoughts']
    renderAnthropicThinkingBlocks: AnthropicMessagesHelpers['renderAnthropicThinkingBlocks']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<{
    system?: string | AnthropicTextBlockParam[]
    messages: AnthropicMessageParam[]
    tools?: AnthropicTool[]
  }>
}

/**
 * Input handed to an {@link AnthropicMessagesErrorStatusResolver}.
 */
export interface AnthropicMessagesErrorStatusInput {
  /** The raw SDK error being classified — an `APIError` instance. */
  error: unknown
  /**
   * The error body as text: `JSON.stringify(err.error)` when the SDK parsed an object, else its
   * string form. Empty string when the SDK captured no body.
   */
  bodyText: string
  /**
   * The status the SDK reported, already coerced: `err.status` when numeric, otherwise `0`.
   * A resolver typically returns `undefined` immediately unless this is `0`.
   */
  sdkStatus: number
}

/**
 * Recovers an HTTP status the Anthropic SDK could not observe.
 *
 * @remarks
 * See {@link AnthropicMessagesAdapterOptions.resolveErrorStatus} for when this is called, why the
 * ADK ships no default implementation, and the contract for declining. Return an HTTP status
 * (100–599) to classify against, or `undefined` to leave `sdkStatus` in force.
 *
 * @param input - The error, its body text, and the SDK-reported status.
 * @returns An HTTP status to classify against, or `undefined` to decline.
 */
export type AnthropicMessagesErrorStatusResolver = (
  input: AnthropicMessagesErrorStatusInput
) => number | undefined

/**
 * Configuration options for the Anthropic Messages adapter.
 */
export interface AnthropicMessagesAdapterOptions {
  /** API key used by the Anthropic SDK. Omit only when another SDK credential source is intended. */
  apiKey?: string
  /** Endpoint base URL. Defaults to the Anthropic SDK default unless overridden. */
  baseURL?: string
  /** Custom HTTP headers sent with every request. */
  headers?: Record<string, string>
  /** Custom fetch implementation, used for tests, proxies, or custom transports. */
  fetch?: typeof globalThis.fetch
  /** Whether to stream the response as Anthropic stream events. */
  stream?: boolean
  /** Idle timeout in milliseconds for the stream before aborting. */
  streamIdleTimeoutMs?: number
  /** Request timeout in milliseconds for API calls. */
  requestTimeoutMs?: number
  /** Configures ADK-owned request retry behavior. */
  retry?: ChatCompletionsRetryConfig
  /**
   * Recovers an HTTP status the Anthropic SDK could not observe, so retry classification can see it.
   *
   * @remarks
   * Unlike the Ollama and OpenAI batteries — which read `response.status` off a raw `fetch` and
   * therefore always see the real code — this battery classifies from the SDK's `APIError`. When a
   * gateway terminates the HTTP request itself and reports the upstream failure *inside the response
   * body*, `err.status` is absent, is coerced to `0`, matches nothing in
   * {@link @nhtio/adk/batteries/llm/chat_common!ChatCompletionsRetryConfig.retriableStatuses}, and the
   * error is classified fatal — so a transient upstream `529 overloaded_error` fails on first
   * occurrence with retry never consulted.
   *
   * The ADK deliberately ships **no** body parser: the shape of a gateway's error envelope is the
   * consumer's knowledge, not the ADK's, and guessing it with a built-in regex risks reading a
   * three-digit request id — or a genuine deterministic `4xx` — as a retriable status. This hook is
   * the seam for a consumer who *does* know their gateway.
   *
   * Called only for SDK `APIError`s, before retriable/fatal classification and before the
   * context-overflow body-text check. Return an HTTP status to classify against, or `undefined` to
   * decline — declining leaves `sdkStatus` in force, so a resolver that does not recognise a body is
   * a no-op rather than a hazard. A returned value outside 100–599 is ignored with a warning. The
   * resolved status is what reaches `retriableStatuses`, the `E_ANTHROPIC_MESSAGES_HTTP_ERROR`
   * payload, and the log line — so a recovered `529` is reported as `529`, not `0`.
   *
   * Must not throw; a throwing resolver is caught, warned about, and treated as declining.
   *
   * @example
   * ```ts
   * new AnthropicMessagesAdapter({
   *   model, maxTokens,
   *   retry: { maxAttempts: 4 },
   *   // This gateway reports the upstream status in the body and nowhere else.
   *   resolveErrorStatus: ({ bodyText, sdkStatus }) => {
   *     if (sdkStatus !== 0) return undefined
   *     const m = /upstream returned (\d{3})/.exec(bodyText)
   *     return m ? Number(m[1]) : undefined
   *   },
   * })
   * ```
   *
   * @defaultValue `undefined` — no recovery; a statusless `APIError` stays fatal, preserving the
   *   behaviour of adapters built before this hook existed.
   */
  resolveErrorStatus?: AnthropicMessagesErrorStatusResolver
  /** Determines order of system-prompt content buckets in history assembly. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Size of the model's token context window for the ADK guard. */
  contextWindow?: number
  /** Unique identity label for the assistant instance. */
  selfIdentity?: string
  /** Determines which thoughts are surfaced back to the model. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** Tokenizer encoding configuration for token counting. */
  tokenEncoding?: TokenEncoding | null
  /** List of replay labels supported by this adapter. */
  replayCompatibility?: ReadonlyArray<string>
  /** Optional overrides for Anthropic translation helpers. */
  helpers?: Partial<AnthropicMessagesHelpers>
  /** Backing store for string or bytes tool returns. */
  spoolStore?: SpoolStore
  /** Whether the executor acks automatically on a tool-call-free terminal answer. */
  autoAck?: boolean
  /** Policy for media whose modality the Anthropic Messages wire cannot represent. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Required Anthropic model identifier. */
  model: AnthropicModel
  /** Required maximum number of output tokens to request from Anthropic. */
  maxTokens: number
  /** Custom stop sequences sent as `stop_sequences`. */
  stopSequences?: string[]
  /** Extended or adaptive thinking configuration sent to Anthropic. */
  thinking?: AnthropicThinkingConfigParam
  /** Structured-output and effort configuration sent to Anthropic. */
  outputConfig?: AnthropicOutputConfig
  /** Tool-choice directive sent to Anthropic. */
  toolChoice?: AnthropicToolChoice
  /** Allows Anthropic SDK use in browser-like runtimes despite API-key exposure risk. */
  dangerouslyAllowBrowser?: boolean
  /** Prompt-cache breakpoint placement mode. */
  cacheBreakpoints?: AnthropicCacheBreakpoints
  /** Optional TTL applied to emitted prompt-cache breakpoints. */
  cacheTtl?: AnthropicCacheTtl
  /** Anthropic request metadata. */
  metadata?: AnthropicMessageCreateParamsBase['metadata']
  /** Anthropic service-tier selector. */
  serviceTier?: AnthropicMessageCreateParamsBase['service_tier']
  /** Anthropic container identifier for container-capable tools. */
  container?: string | null
  /** Anthropic inference geography selector. */
  inferenceGeo?: string | null
  /** Anthropic user-profile request parameter (SDK maps this header param on the wire). */
  userProfileId?: string
  /**
   * Deprecated Anthropic temperature sampling parameter.
   *
   * @deprecated Models released after Claude Opus 4.6 reject most values with a 400. The adapter
   * never supplies this unless the caller sets it.
   */
  temperature?: number
  /**
   * Deprecated Anthropic nucleus-sampling parameter.
   *
   * @deprecated Models released after Claude Opus 4.6 reject lower values with a 400. The adapter
   * never supplies this unless the caller sets it.
   */
  topP?: number
  /**
   * Deprecated Anthropic top-k sampling parameter.
   *
   * @deprecated Models released after Claude Opus 4.6 reject every value with a 400. The adapter
   * never supplies this unless the caller sets it.
   */
  topK?: number
  /** Observe the model's raw response for each completed generation. */
  onRawGeneration?: RawGenerationObserverFn
  /** Observe the fully assembled Anthropic request before dispatch. */
  onPromptAssembled?: PromptAssembledObserverFn
  /** Optional fallback parser for non-structural local tool-call text. */
  localToolCallParser?: ToolCallParserName | ToolCallParserFn
}

/**
 * Constructor-compatible shape for future count-token helpers.
 */
export interface AnthropicMessagesCountTokensInput {
  /** Optional dispatch context whose prompt should be assembled before counting. */
  context?: DispatchContext
  /** Optional pre-built Anthropic input messages to count. */
  messages?: AnthropicMessageParam[]
  /** Optional pre-built Anthropic system prompt to count. */
  system?: string | AnthropicTextBlockParam[]
  /** Optional pre-built Anthropic tools to count. */
  tools?: AnthropicTool[]
}
