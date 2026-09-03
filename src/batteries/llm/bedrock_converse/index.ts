/**
 * Native AWS Bedrock Converse adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/bedrock_converse
 *
 * @remarks
 * Targets Bedrock's NATIVE `POST {baseURL}/model/{modelId}/converse` surface over plain HTTPS with
 * a Bedrock API key (`Authorization: Bearer ABSK…`) — no AWS SDK, no SigV4 signer, so the battery
 * stays cross-environment and dependency-light.
 *
 * Converse is a content-BLOCK protocol and differs from Chat Completions structurally: a turn's
 * payload is a typed `content[]` (`{text}`, `{image}`, `{toolUse}`, `{toolResult}`) so one
 * assistant turn can carry prose and a tool call together; a tool result rides a **`user`** turn;
 * system text is a top-level `system[]`; roles must strictly alternate; and `toolConfig` is
 * REQUIRED whenever any tool block appears, including pure history replay.
 *
 * That last pair is why this battery exists. A gateway fronting Converse has to repair
 * non-alternating history on your behalf — typically by merging consecutive same-role turns — and
 * that repair is invisible in the response, which makes a gateway's fix indistinguishable from
 * vendor tolerance. {@link BedrockConverseAdapterOptions.alternationPolicy} exposes the choice:
 * `'merge'` (default, lossless), `'filler'`, or `'reject'` to let Converse's own error surface when
 * you are auditing what the vendor actually enforces. See the validation battery's "Which API
 * surface a rule applies to" guide.
 */

export { BedrockConverseAdapter } from './adapter'

export {
  // Converse-specific
  DEFAULT_CONVERSE_BUCKET_ORDER,
  sanitizeConverseSchema,
  defaultSanitizeConverseSchema,
  sanitizeToolUseId,
  defaultSanitizeToolUseId,
  toolsToConverseTools,
  defaultToolsToConverseTools,
  renderConverseToolResult,
  defaultRenderConverseToolResult,
  mediaToConverseImage,
  defaultMediaToConverseImage,
  enforceConverseAlternation,
  defaultEnforceConverseAlternation,
  buildConverseRequest,
  defaultBuildConverseRequest,
  extractConverseGeneration,
  defaultExtractConverseGeneration,
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

export { bedrockConverseOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_BEDROCK_CONVERSE_OPTIONS,
  E_CONVERSE_REQUEST_FAILED,
  E_CONVERSE_MISSING_TOOL_CONFIG,
  E_CONVERSE_ALTERNATION_VIOLATION,
  E_CONVERSE_STREAM_ERROR,
  E_CONVERSE_INVALID_TOOL_INPUT,
} from './exceptions'

export type {
  ConverseRole,
  ConverseImageBlock,
  ConverseToolUse,
  ConverseToolResult,
  ConverseContentBlock,
  ConverseMessage,
  ConverseSystemBlock,
  ConverseToolSpec,
  ConverseToolChoice,
  ConverseToolConfig,
  ConverseInferenceConfig,
  ConverseRequest,
  ConverseUsage,
  ConverseResponse,
  BedrockConverseHelpers,
  ConverseRequestBuildInput,
  BedrockConverseAdapterOptions,
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
