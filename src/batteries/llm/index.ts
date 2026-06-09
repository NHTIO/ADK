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
