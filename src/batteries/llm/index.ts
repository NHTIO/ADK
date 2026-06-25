/**
 * Aggregate barrel for bundled LLM adapters and their helper, option, and exception exports.
 *
 * @module @nhtio/adk/batteries/llm
 */

export * from './openai_chat_completions'

export { WebLLMChatCompletionsAdapter } from './webllm_chat_completions'
export { webLLMChatCompletionsOptionsSchema } from './webllm_chat_completions'
export { validateOptions as validateWebLLMChatCompletionsOptions } from './webllm_chat_completions'
export {
  E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS,
  E_WEBLLM_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
  E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR,
  E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS,
} from './webllm_chat_completions'
export type {
  WebLLMChatCompletionsAdapterOptions,
  WebLLMChatCompletionsRequestBody,
  WebLLMEngine,
  WebLLMInitProgressReport,
} from './webllm_chat_completions'

export { OllamaAdapter } from './ollama'
export { ollamaOptionsSchema } from './ollama'
export { validateOptions as validateOllamaOptions } from './ollama'
export {
  E_INVALID_OLLAMA_OPTIONS,
  E_OLLAMA_CONTEXT_OVERFLOW,
  E_OLLAMA_HTTP_ERROR,
  E_OLLAMA_STREAM_ERROR,
  E_OLLAMA_STREAM_STALLED,
  E_OLLAMA_REQUEST_TIMEOUT,
  E_OLLAMA_INVALID_TOOL_CALL_ARGS,
  E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY,
} from './ollama'
export type {
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
} from './ollama'

export { LiteRtLmAdapter } from './litert_lm'
export { liteRtLmOptionsSchema } from './litert_lm'
export { validateOptions as validateLiteRtLmOptions } from './litert_lm'
export {
  E_INVALID_LITERT_LM_OPTIONS,
  E_LITERT_LM_CONTEXT_OVERFLOW,
  E_LITERT_LM_STREAM_ERROR,
  E_LITERT_LM_INVALID_TOOL_CALL_ARGS,
} from './litert_lm'
export type { LiteRtLmAdapterOptions, LiteRtLmEngine, LiteRtLmConversation } from './litert_lm'

export { TransformersJsAdapter } from './transformers_js'
export { transformersJsOptionsSchema } from './transformers_js'
export { validateOptions as validateTransformersJsOptions } from './transformers_js'
export {
  E_INVALID_TRANSFORMERS_JS_OPTIONS,
  E_TRANSFORMERS_JS_CONTEXT_OVERFLOW,
  E_TRANSFORMERS_JS_STREAM_ERROR,
  E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS,
  E_TRANSFORMERS_JS_TOOL_PARSE_FAILED,
} from './transformers_js'
export type {
  TransformersJsAdapterOptions,
  TransformersJsPipeline,
  TransformersJsMessage,
  ToolCallParserName,
  ToolCallParserFn,
  ReasoningParserName,
  ReasoningParserFn,
} from './transformers_js'
