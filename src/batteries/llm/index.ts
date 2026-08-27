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

export { AnthropicMessagesAdapter } from './anthropic_messages'
export { anthropicMessagesOptionsSchema } from './anthropic_messages'
export { validateOptions as validateAnthropicMessagesOptions } from './anthropic_messages'
export {
  E_INVALID_ANTHROPIC_MESSAGES_OPTIONS,
  E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW,
  E_ANTHROPIC_MESSAGES_HTTP_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_STALLED,
  E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT,
  E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS,
  E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY,
} from './anthropic_messages'
export type {
  AnthropicModel,
  AnthropicMessageCreateParams,
  AnthropicMessageCreateParamsBase,
  AnthropicMessageParam,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicContentBlockParam,
  AnthropicTextBlockParam,
  AnthropicImageBlockParam,
  AnthropicDocumentBlockParam,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlock,
  AnthropicToolUseBlockParam,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicThinkingConfigParam,
  AnthropicThinkingBlock,
  AnthropicThinkingBlockParam,
  AnthropicRedactedThinkingBlock,
  AnthropicRedactedThinkingBlockParam,
  AnthropicRawMessageStreamEvent,
  AnthropicRawMessageStartEvent,
  AnthropicRawMessageDeltaEvent,
  AnthropicRawMessageStopEvent,
  AnthropicRawContentBlockStartEvent,
  AnthropicRawContentBlockDeltaEvent,
  AnthropicRawContentBlockStopEvent,
  AnthropicRawContentBlockDelta,
  AnthropicUsage,
  AnthropicMessageDeltaUsage,
  AnthropicStopReason,
  AnthropicRefusalStopDetails,
  AnthropicOutputConfig,
  AnthropicJSONOutputFormat,
  AnthropicCacheControlEphemeral,
  AnthropicMessageCountTokensParams,
  AnthropicMessageTokensCount,
  AnthropicThinkingReplayPayload,
  AnthropicCacheBreakpoints,
  AnthropicCacheTtl,
  AnthropicMessagesHelpers,
  AnthropicMessagesAdapterOptions,
  AnthropicMessagesCountTokensInput,
  AnthropicMessagesCountTokensRequestInput,
  AnthropicMessagesCountTokensDeps,
} from './anthropic_messages'

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

export { ClaudeCodeCliAdapter } from './claude_code_cli'
export { claudeCodeCliOptionsSchema } from './claude_code_cli'
export { validateOptions as validateClaudeCodeCliOptions } from './claude_code_cli'
export {
  E_INVALID_CLAUDE_CODE_CLI_OPTIONS,
  E_CLAUDE_CODE_CLI_BINARY_NOT_FOUND,
  E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR,
  E_CLAUDE_CODE_CLI_WRAPPER_CRASHED,
  E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO,
  E_CLAUDE_CODE_CLI_STREAM_ERROR,
  E_CLAUDE_CODE_CLI_STREAM_STALLED,
  E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT,
  E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED,
  E_CLAUDE_CODE_CLI_TURN_FAILED,
  E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY,
} from './claude_code_cli'
export type {
  ClaudeCodeCliHelpers,
  ClaudeCodeCliAdapterOptions,
  ClaudeCodeCliExtraArg,
  WrapperBridgedTool,
  WrapperAuth,
  WrapperRunCommand,
  WrapperToolResultContentBlock,
  WrapperToolCallResponseCommand,
  WrapperShutdownCommand,
  WrapperCommand,
  WrapperReadyEvent,
  WrapperInitEvent,
  WrapperMessageDeltaEvent,
  WrapperThoughtDeltaEvent,
  WrapperToolCallRequestEvent,
  WrapperRetryEvent,
  WrapperResultEvent,
  WrapperErrorEvent,
  WrapperLogEvent,
  WrapperShutdownCompleteEvent,
  WrapperEvent,
} from './claude_code_cli'
