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

export { LiteRtLmAdapter, isEngineContextOverflowMessage } from './adapter'

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
  renderToolsAsPromptText,
  defaultRenderToolsAsPromptText,
  renderMediaToLiteRtContent,
  renderLiteRtToolResult,
  defaultRenderLiteRtToolResult,
  // The shared artifact-handle renderer + the spooled-result structural check — exported so a host
  // (e.g. the docs showcase) can render a tool-call chip with the EXACT handle text the model saw,
  // instead of approximating it. Same function the executor uses → byte-identical to the model's view.
  renderArtifactHandleBody,
  looksLikeSpooledArtifact,
  buildLiteRtConversationInput,
  defaultBuildLiteRtConversationInput,
  createLiteRtStreamAccumulator,
  defaultCreateLiteRtStreamAccumulator,
  // shared tool-call parser layer (LiteRT-LM is text-only — calls arrive as text)
  hermesToolCallParser,
  gemmaToolCallParser,
  gptOssToolCallParser,
  pythonicToolCallParser,
  llama3JsonToolCallParser,
  mistralToolCallParser,
  qwen3CoderToolCallParser,
  phiToolCallParser,
  noneToolCallParser,
  createAutoToolCallParser,
  resolveToolCallParser,
  BUNDLED_TOOL_CALL_PARSERS,
  DEFAULT_TOOL_CALL_PARSER_ORDER,
  // shared reasoning parser layer
  thinkTagReasoningParser,
  harmonyAnalysisReasoningParser,
  gemmaChannelReasoningParser,
  makeThinkTagReasoningParser,
  makeHarmonyAnalysisReasoningParser,
  makeGemmaChannelReasoningParser,
  buildBundledReasoningParsers,
  noneReasoningParser,
  createAutoReasoningParser,
  resolveReasoningParser,
  BUNDLED_REASONING_PARSERS,
  DEFAULT_REASONING_PARSER_ORDER,
  // shared lifecycle/boot-progress contract
  emitLifecycle,
  defaultEmitLifecycle,
  // shared portable generation contract
  resolveGenerationOptions,
  defaultResolveGenerationOptions,
  GENERATION_DEFAULTS,
  // shared WebGPU memory observability (surface, don't impose)
  isGpuOutOfMemoryError,
  probeGpuBudget,
  instrumentGpuBuffers,
} from './helpers'

export type { LiteRtStreamAccumulator } from './helpers'

export type { GpuBudget, GpuBufferSample, GpuBufferInstrument } from './helpers'

export type { ChatGenerationOptions, ChatSampler, ResolvedGenerationOptions } from './helpers'

// Media-output seam types (shared, defined in chat_common/types).
export type {
  GeneratedMediaOutput,
  MediaOutputExtractorFn,
  RawGenerationObservation,
  RawGenerationObserverFn,
  PromptAssembledObservation,
  PromptAssembledObserverFn,
} from '../chat_common'

export type {
  ParsedToolCall,
  ToolCallParseResult,
  ToolCallParserContext,
  ToolCallParserFn,
  ToolCallParserName,
  ReasoningParseResult,
  ReasoningParserFn,
  ReasoningParserName,
  ReasoningParserOptions,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './helpers'

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

// Shared on-device WebGPU OOM exception (surfaced so consumers can `isInstanceOf` it structurally).
export { E_LLM_GPU_OUT_OF_MEMORY } from '../chat_common/exceptions'
