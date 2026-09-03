/**
 * Native Gemini `generateContent` adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content
 *
 * @remarks
 * Targets Google's NATIVE `POST {baseURL}/models/{model}:generateContent` surface — not an
 * OpenAI-compatible façade in front of it. For that, point `openai_chat_completions` at the
 * gateway's `/v1`.
 *
 * The native surface differs from Chat Completions structurally, not cosmetically: turns are
 * `contents[]` with role `model` (never `assistant`), there is no `system` role (system text goes
 * to a top-level `systemInstruction`), a turn's payload is a heterogeneous `parts[]`, a tool call
 * is a `functionCall` part on a `model` turn whose result comes back as a `functionResponse` part
 * on a **`user`** turn, correlation is by DECLARED TOOL NAME rather than a call id, and Gemini 3+
 * hard-rejects a historical `functionCall` that carries no `thoughtSignature`.
 *
 * Speaking it natively matters whenever you need to reason about what the VENDOR received rather
 * than what a translator sent on your behalf — an ordering guard, a wire-shape audit, a bug report
 * against Google. See the validation battery's "Which API surface a rule applies to" guide.
 *
 * Re-exports the adapter, every translation helper (with `default*` aliases), the option and wire
 * types, the validation schema plus `validateOptions`, and the battery-scoped exceptions.
 */

export { GeminiGenerateContentAdapter } from './adapter'

export {
  // Gemini-specific
  DEFAULT_GEMINI_BUCKET_ORDER,
  sanitizeGeminiSchema,
  defaultSanitizeGeminiSchema,
  toolsToGeminiTools,
  defaultToolsToGeminiTools,
  renderGeminiToolResult,
  defaultRenderGeminiToolResult,
  mediaToGeminiInlineData,
  defaultMediaToGeminiInlineData,
  buildGeminiRequest,
  defaultBuildGeminiRequest,
  extractGeminiGeneration,
  defaultExtractGeminiGeneration,
  // Shared, wire-agnostic (re-exported under their original names)
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
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
} from './helpers'

export { geminiGenerateContentOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS,
  E_GEMINI_REQUEST_FAILED,
  E_GEMINI_MISSING_THOUGHT_SIGNATURE,
  E_GEMINI_STREAM_ERROR,
  E_GEMINI_INVALID_TOOL_CALL_ARGS,
} from './exceptions'

export type {
  GeminiRole,
  GeminiInlineData,
  GeminiFunctionCall,
  GeminiFunctionResponse,
  GeminiPart,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiTool,
  GeminiToolConfig,
  GeminiThinkingConfig,
  GeminiGenerationConfig,
  GeminiSafetySetting,
  GeminiGenerateContentRequest,
  GeminiUsageMetadata,
  GeminiCandidate,
  GeminiGenerateContentResponse,
  GeminiGenerateContentHelpers,
  GeminiRequestBuildInput,
  GeminiGenerateContentAdapterOptions,
  // Shared type surface
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
  RawGenerationObserverFn,
  PromptAssembledObserverFn,
  ToolCallParserName,
  ToolCallParserFn,
} from './types'
