/**
 * LiteRT-LM adapter battery — browser/WebGPU on-device inference with swappable translation helpers.
 *
 * @module @nhtio/adk/batteries/llm/litert_lm
 *
 * @remarks
 * Opinionated LLM battery wrapping Google's `@litert-lm/core` — on-device inference in the browser via
 * WebGPU + a bundled wasm runtime, driving `.litertlm` models. Ships a `LiteRtLmAdapter` that targets
 * LiteRT-LM's native `Engine → Conversation` API and translates the ADK's primitives into LiteRT's
 * `Message` / `Tool` / `tool_response` / `Preface` wire shapes.
 *
 * Unlike the WebLLM battery (a thin extension of the OpenAI Chat Completions wire shape), this is a
 * **standalone** battery: it reuses the format-agnostic render helpers but maps history, tools, and
 * results to LiteRT's own shapes, where tool-call `arguments` arrive as a parsed object (not a JSON
 * string) and "thinking" surfaces via `Message.channels`.
 *
 * **The published `@litert-lm/core` docs lag the library.** Every wire field here is mapped against the
 * installed package's type declarations — the source of truth. The dependency is young (pinned exact);
 * re-verify on upgrade.
 *
 * Re-exports the adapter class, every translation helper (each under its unprefixed name AND a
 * `default*`-prefixed alias so consumers can compose partial overrides against the bundled defaults),
 * the LiteRT-native mappers, every option / wire-shape type alias, the validation schema +
 * `validateOptions` wrapper, and the five battery-scoped exception classes.
 */

export { LiteRtLmAdapter } from './adapter'

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
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  extractReasoningFields,
  // LiteRT-native mappers
  toolsToLiteRtTools,
  defaultToolsToLiteRtTools,
  renderMediaToLiteRtContent,
  renderLiteRtToolResult,
  defaultRenderLiteRtToolResult,
  buildLiteRtConversationInput,
  defaultBuildLiteRtConversationInput,
  createLiteRtStreamAccumulator,
  defaultCreateLiteRtStreamAccumulator,
} from './helpers'

export type { LiteRtStreamAccumulator } from './helpers'

export type {
  // Adapter options + engine aliases
  LiteRtLmAdapterOptions,
  LiteRtSamplerParametersOption,
  LiteRtLmEngine,
  LiteRtLmChatEngine,
  LiteRtLmConversation,
  CreateLiteRtLmEngine,
  LiteRtLmInitProgressReport,
  // LiteRT wire shapes (re-exported from the provider)
  LiteRtMessage,
  LiteRtMessageLike,
  LiteRtMessageContentItem,
  LiteRtTool,
  LiteRtToolParameters,
  LiteRtToolCall,
  LiteRtToolCallFunction,
  LiteRtToolResponseValue,
  LiteRtPreface,
  LiteRtConversationConfig,
  LiteRtSessionConfig,
  LiteRtSamplerParameters,
  LiteRtEngineSettings,
  LiteRtLlmExecutorSettings,
  SamplerType,
  Backend,
  // Shared format-agnostic helper/policy types
  JsonSchema,
  DescriptionLike,
  LiteRtLmHelpers,
  LiteRtLmBucketOrder,
  UnsupportedMediaPolicy,
  LiteRtLmJsonSchema,
  LiteRtLmDescriptionLike,
} from './types'

export { liteRtLmOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_LITERT_LM_OPTIONS,
  E_LITERT_LM_CONTEXT_OVERFLOW,
  E_LITERT_LM_STREAM_ERROR,
  E_LITERT_LM_INVALID_TOOL_CALL_ARGS,
  E_UNSUPPORTED_MEDIA_MODALITY,
} from './exceptions'
