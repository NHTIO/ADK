/**
 * OpenAI Chat Completions adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions
 *
 * @remarks
 * Opinionated OpenAI Chat Completions LLM battery. Ships an `OpenAIChatCompletionsAdapter` that
 * targets any OpenAI-Chat-Completions-compatible endpoint (OpenAI proper, OpenRouter, Together,
 * Groq, Ollama's `/v1`, vLLM, LM Studio, llama.cpp's `/v1`, Azure OpenAI behind a proxy,
 * LiteLLM, custom gateways, etc.) and translates the ADK's primitives into the Chat
 * Completions wire shape.
 *
 * Re-exports the adapter class, every translation helper (each under its unprefixed name AND a
 * `default*`-prefixed alias so consumers can compose partial overrides against the bundled
 * defaults), every option / wire-shape type alias, the validation schema + `validateOptions`
 * wrapper, and the six battery-scoped exception classes.
 *
 * See the project README for the design-decisions block governing this battery (trust-framed
 * envelopes, per-tool trust, swappable translation helpers, per-dispatch override channel via
 * `stash`, trust-tier-distinct envelopes, multi-identity rendering, opaque-reasoning
 * round-trips, etc.).
 */

export { OpenAIChatCompletionsAdapter } from './adapter'

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
  renderRetrievables,
  defaultRenderRetrievables,
  renderRetrievableSafetyDirective,
  defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  renderTimelineMessage,
  defaultRenderTimelineMessage,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  renderChatCompletionsToolCallResult,
  defaultRenderChatCompletionsToolCallResult,
  buildChatCompletionsHistory,
  defaultBuildChatCompletionsHistory,
  createChatCompletionsToolCallDeltaAccumulator,
  defaultCreateChatCompletionsToolCallDeltaAccumulator,
  extractReasoningFields,
} from './helpers'

export type {
  JsonSchema,
  ChatCompletionsTool,
  ChatCompletionsMessage,
  ChatCompletionsToolCallDelta,
  ChatCompletionsChunk,
  ChatCompletionsResponse,
  AssembledToolCall,
  ChatCompletionsToolCallDeltaAccumulator,
  ChatCompletionsBucketLabel,
  ChatCompletionsBucketOrder,
  ReasoningField,
  ReasoningFieldPrecedence,
  ReasoningExtract,
  UntrustedContentAttrs,
  TrustedContentAttrs,
  StandingInstructionAttrs,
  MemoryAttrs,
  RetrievableAttrs,
  ThoughtAttrs,
  ChatCompletionsRetryConfig,
  OpenAIChatCompletionsAdapterOptions,
  OpenAIChatCompletionsRequestBody,
  DescriptionLike,
  ChatCompletionsHelpers,
} from './types'

// Shared wire-observability contract (the TO/FROM taps) — surfaced on the barrel so consumers can type
// their observers.
export { deCollideToolCallIds } from '../chat_common'

export type {
  ToolCallIdFilterFn,
  RawGenerationObservation,
  RawGenerationObserverFn,
  PromptAssembledObservation,
  PromptAssembledObserverFn,
} from '../chat_common'

export { openAIChatCompletionsOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS,
  E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
  E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR,
  E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR,
  E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED,
  E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT,
  E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS,
} from './exceptions'
