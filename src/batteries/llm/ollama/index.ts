/**
 * Native Ollama `/api/chat` adapter battery with swappable translation helpers and wire types.
 *
 * @module @nhtio/adk/batteries/llm/ollama
 *
 * @remarks
 * Opinionated native Ollama LLM battery. Ships an `OllamaAdapter` that targets Ollama's NATIVE
 * `/api/chat` endpoint (NOT the OpenAI-compat `/v1` layer — for that, point the
 * `openai_chat_completions` battery at `<host>/v1`). Works with both local Ollama
 * (`http://localhost:11434`, no auth) and cloud Ollama (`https://ollama.com`, `Authorization:
 * Bearer <apiKey>`); the only difference is `baseURL` plus the auth header. Native Ollama is
 * HTTP-only — a Unix-socket deployment is reached via a custom `fetch` or an external bridge.
 *
 * Native `/api/chat` unlocks capabilities the `/v1` compat layer cannot express: per-request
 * context size (`options.num_ctx`), native reasoning (`think` + `message.thinking`), structured
 * output (`format`), model lifecycle (`keep_alive`), object-form tool-call arguments, NDJSON
 * streaming, and native generation stats (surfaced via the runner's `generationStats` observability
 * channel).
 *
 * Re-exports the adapter class, every translation helper (wire-shape-agnostic helpers are shared
 * with the OpenAI battery via the internal `chat_common` submodule and re-exported here under their
 * original names, each with a `default*` alias), the option / wire-shape types, the validation
 * schema + `validateOptions` wrapper, and the battery-scoped exception classes.
 */

export { OllamaAdapter } from './adapter'
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
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  ollamaToolsFromTools,
  defaultOllamaToolsFromTools,
  renderOllamaTimelineMessage,
  defaultRenderOllamaTimelineMessage,
  renderOllamaToolCallResult,
  defaultRenderOllamaToolCallResult,
  buildOllamaHistory,
  defaultBuildOllamaHistory,
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
  ChatCompletionsTool,
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
  ToolCallIdFilterFn,
  OllamaThink,
  OllamaFormat,
  OllamaRuntimeOptions,
  OllamaToolCall,
  OllamaMessage,
  OllamaTool,
  OllamaChatRequestBody,
  OllamaChatStreamChunk,
  OllamaChatResponse,
  OllamaHelpers,
  OllamaAdapterOptions,
} from './types'

export { ollamaOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_OLLAMA_OPTIONS,
  E_OLLAMA_CONTEXT_OVERFLOW,
  E_OLLAMA_HTTP_ERROR,
  E_OLLAMA_STREAM_ERROR,
  E_OLLAMA_STREAM_STALLED,
  E_OLLAMA_REQUEST_TIMEOUT,
  E_OLLAMA_INVALID_TOOL_CALL_ARGS,
  E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY,
} from './exceptions'
