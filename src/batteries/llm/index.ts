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
