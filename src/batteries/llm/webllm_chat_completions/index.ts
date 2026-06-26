/**
 * WebLLM Chat Completions adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/webllm_chat_completions
 *
 * @remarks
 * Opinionated WebLLM Chat Completions LLM battery. Ships a `WebLLMChatCompletionsAdapter` that
 * targets WebLLM's in-process OpenAI-style Chat Completions API and translates the ADK's
 * primitives into that wire shape.
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

export { WebLLMChatCompletionsAdapter } from './adapter'

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
  WebLLMEngine,
  WebLLMChatCompletionsEngine,
  CreateWebLLMChatCompletionsEngine,
  WebLLMInitProgressReport,
  WebLLMChatCompletionsAdapterOptions,
  WebLLMChatCompletionsRequestBody,
  DescriptionLike,
  ChatCompletionsHelpers,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export { webLLMChatCompletionsOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS,
  E_WEBLLM_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
  E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR,
  E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS,
  E_UNSUPPORTED_MEDIA_MODALITY,
} from './exceptions'
