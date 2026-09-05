/**
 * Native Anthropic Messages API adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages
 *
 * @remarks
 * Opinionated native Anthropic Messages battery. Ships an `AnthropicMessagesAdapter` that targets
 * `client.messages.create` from `@anthropic-ai/sdk` (a hard static dependency of this battery).
 * Node-first: an Anthropic API key in a browser bundle is unacceptably exposed, so browser is
 * deliberately not a target for this adapter — `dangerouslyAllowBrowser` exists only for the
 * caller who accepts that risk knowingly.
 *
 * Unlocks capabilities the OpenAI-compat wire cannot express: native extended thinking (signed
 * `thinking`/`redacted_thinking` blocks with replay-safe signature verification), prompt caching
 * via `cache_control` breakpoints, the native four-shape `tool_choice`, and native stop-reason
 * fidelity (`pause_turn`, `refusal`, `model_context_window_exceeded`).
 *
 * Re-exports the adapter class, every translation helper (wire-shape-agnostic helpers are shared
 * with the sibling Chat-family batteries via the internal `chat_common` submodule and re-exported
 * here under their original names, each with a `default*` alias, plus this battery's own
 * Anthropic-specific helpers), the option / wire-shape types, the validation schema +
 * `validateOptions` wrapper, and the battery-scoped exception classes.
 */

export { AnthropicMessagesAdapter } from './adapter'
export {
  countAnthropicMessagesTokens,
  countAnthropicMessagesTokensWithResolvedOptions,
} from './count_tokens'

export {
  descriptionToChatCompletionsJsonSchema,
  defaultDescriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  defaultRenderUntrustedContent,
  renderTrustedContent,
  defaultRenderTrustedContent,
  renderStandingInstructions,
  defaultRenderStandingInstructions,
  renderMemories,
  defaultRenderMemories,
  renderRetrievableSafetyDirective,
  defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  renderRetrievables,
  defaultRenderRetrievables,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  anthropicToolsFromTools,
  defaultAnthropicToolsFromTools,
  renderAnthropicMediaBlocks,
  defaultRenderAnthropicMediaBlocks,
  renderAnthropicToolCallResult,
  defaultRenderAnthropicToolCallResult,
  renderAnthropicSegmentedSystemPrompt,
  defaultRenderAnthropicSegmentedSystemPrompt,
  fingerprintAnthropicMessagesPrefix,
  renderAnthropicThinkingBlocks,
  defaultRenderAnthropicThinkingBlocks,
  renderAnthropicTimelineMessage,
  defaultRenderAnthropicTimelineMessage,
  buildAnthropicMessagesHistory,
  defaultBuildAnthropicMessagesHistory,
} from './helpers'

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
  ToolCallParserName,
  ToolCallParserFn,
  AnthropicModel,
  AnthropicMessageCreateParams,
  AnthropicMessageCreateParamsBase,
  AnthropicMessageParam,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicContentBlockParam,
  AnthropicTextBlockParam,
  AnthropicImageBlockParam,
  AnthropicDocumentBlockParam,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlock,
  AnthropicToolUseBlockParam,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicThinkingConfigParam,
  AnthropicThinkingBlock,
  AnthropicThinkingBlockParam,
  AnthropicRedactedThinkingBlock,
  AnthropicRedactedThinkingBlockParam,
  AnthropicRawMessageStreamEvent,
  AnthropicRawMessageStartEvent,
  AnthropicRawMessageDeltaEvent,
  AnthropicRawMessageStopEvent,
  AnthropicRawContentBlockStartEvent,
  AnthropicRawContentBlockDeltaEvent,
  AnthropicRawContentBlockStopEvent,
  AnthropicRawContentBlockDelta,
  AnthropicUsage,
  AnthropicMessageDeltaUsage,
  AnthropicStopReason,
  AnthropicRefusalStopDetails,
  AnthropicOutputConfig,
  AnthropicJSONOutputFormat,
  AnthropicCacheControlEphemeral,
  AnthropicMessageCountTokensParams,
  AnthropicMessageTokensCount,
  AnthropicThinkingReplayPayload,
  AnthropicCacheBreakpoints,
  AnthropicCacheTtl,
  AnthropicMessagesHelpers,
  AnthropicMessagesAdapterOptions,
  AnthropicMessagesCountTokensInput,
  AnthropicMessagesErrorStatusInput,
  AnthropicMessagesErrorStatusResolver,
} from './types'
export type { ToolCallIdFilterFn } from '../chat_common/types'
export type {
  AnthropicMessagesCountTokensRequestInput,
  AnthropicMessagesCountTokensDeps,
} from './count_tokens'

export { anthropicMessagesOptionsSchema, validateOptions } from './validation'
export { deCollideToolCallIds } from '../chat_common'

export { translateAnthropicError, CONTEXT_OVERFLOW_PHRASE } from './error_translation'
export type { AnthropicErrorClassification } from './error_translation'

export {
  E_INVALID_ANTHROPIC_MESSAGES_OPTIONS,
  E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW,
  E_ANTHROPIC_MESSAGES_HTTP_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_STALLED,
  E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT,
  E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS,
  E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY,
} from './exceptions'
