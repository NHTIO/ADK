/**
 * Native OpenAI Responses API adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/openai_responses
 *
 * @remarks
 * Opinionated cross-environment OpenAI Responses battery. Ships an `OpenAIResponsesAdapter` that
 * targets the Responses API's flat `input: Item[]` wire shape via a hand-rolled `fetch` + SSE
 * transport — no `openai` SDK dependency, mirroring `openai_chat_completions`'s transport
 * approach.
 *
 * Unlocks capabilities the Chat Completions wire cannot express as directly: native reasoning-item
 * replay (signed `encrypted_content`, prefix-fingerprinted and adjacency-enforced per the
 * reasoning/output-item pairing constraint), document (`input_file`) media, and hosted server-side
 * tool awareness.
 *
 * Re-exports the adapter class, every translation helper (wire-shape-agnostic helpers are shared
 * with the sibling Chat-family batteries via the internal `chat_common` submodule and re-exported
 * here under their original names, each with a `default*` alias, plus this battery's own
 * Responses-specific helpers), the option / wire-shape types, the validation schema +
 * `validateOptions` wrapper, and the battery-scoped exception classes.
 */

export { OpenAIResponsesAdapter } from './adapter'
export { deCollideToolCallIds } from '../chat_common'

export {
  descriptionToChatCompletionsJsonSchema,
  defaultDescriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  defaultRenderUntrustedContent,
  renderTrustedContent,
  defaultRenderTrustedContent,
  renderStandingInstructions,
  defaultRenderStandingInstructions,
  neutraliseDeveloperRulesTag,
  stripEnvelopeSpecialTokens,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  floorTrustTier,
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
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  canonicalFingerprint,
  defaultCanonicalFingerprint,
  renderOpenAIResponsesMediaBlocks,
  defaultRenderOpenAIResponsesMediaBlocks,
  renderOpenAIResponsesTimelineMessage,
  defaultRenderOpenAIResponsesTimelineMessage,
  renderOpenAIResponsesToolCallResult,
  defaultRenderOpenAIResponsesToolCallResult,
  toolsToOpenAIResponsesTools,
  defaultToolsToOpenAIResponsesTools,
  fingerprintOpenAIResponsesPrefix,
  renderOpenAIResponsesReasoningItem,
  defaultRenderOpenAIResponsesReasoningItem,
  buildOpenAIResponsesInput,
  defaultBuildOpenAIResponsesInput,
  createResponsesOutputSlotMachine,
  defaultCreateResponsesOutputSlotMachine,
  normalizeOpenAIResponsesItemId,
  deCollideOpenAIResponsesToolCallIds,
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
  ToolCallIdFilterFn,
  ToolCallParserName,
  ToolCallParserFn,
  OpenAIResponsesInputContentBlock,
  OpenAIResponsesMessageItem,
  OpenAIResponsesOutputMessageContentPart,
  OpenAIResponsesOutputMessageItem,
  OpenAIResponsesFunctionCallItem,
  OpenAIResponsesFunctionCallOutputItem,
  OpenAIResponsesReasoningSummaryPart,
  OpenAIResponsesReasoningContentPart,
  OpenAIResponsesReasoningItem,
  OpenAIResponsesOpaqueOutputItem,
  OpenAIResponsesInputItem,
  OpenAIResponsesOutputItem,
  OpenAIResponsesTool,
  OpenAIResponsesToolChoice,
  OpenAIResponsesUsage,
  OpenAIResponsesResponseObject,
  OpenAIResponsesOutputItemAddedEvent,
  OpenAIResponsesOutputItemDoneEvent,
  OpenAIResponsesOutputTextDeltaEvent,
  OpenAIResponsesOutputTextDoneEvent,
  OpenAIResponsesRefusalDeltaEvent,
  OpenAIResponsesRefusalDoneEvent,
  OpenAIResponsesReasoningSummaryTextDeltaEvent,
  OpenAIResponsesReasoningSummaryTextDoneEvent,
  OpenAIResponsesReasoningTextDeltaEvent,
  OpenAIResponsesReasoningTextDoneEvent,
  OpenAIResponsesFunctionCallArgumentsDeltaEvent,
  OpenAIResponsesFunctionCallArgumentsDoneEvent,
  OpenAIResponsesCompletedEvent,
  OpenAIResponsesIncompleteEvent,
  OpenAIResponsesFailedEvent,
  OpenAIResponsesErrorEvent,
  OpenAIResponsesStreamEvent,
  ResponsesTextSlot,
  ResponsesThinkingSlot,
  ResponsesToolCallSlot,
  ResponsesOutputSlot,
  ResponsesOutputSlotMachine,
  OpenAIResponsesReasoningReplayPayload,
  ReasoningReplayMode,
  SystemPromptChannel,
  OpenAIResponsesIncludable,
  OpenAIResponsesRequestBody,
  OpenAIResponsesHelpers,
  OpenAIResponsesAdapterOptions,
} from './types'

export { openAIResponsesOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_OPENAI_RESPONSES_OPTIONS,
  E_OPENAI_RESPONSES_CONTEXT_OVERFLOW,
  E_OPENAI_RESPONSES_HTTP_ERROR,
  E_OPENAI_RESPONSES_STREAM_ERROR,
  E_OPENAI_RESPONSES_STREAM_STALLED,
  E_OPENAI_RESPONSES_REQUEST_TIMEOUT,
  E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS,
  E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY,
  E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED,
} from './exceptions'
