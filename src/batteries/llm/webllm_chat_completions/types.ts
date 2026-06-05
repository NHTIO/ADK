import type {
  ChatOptions,
  InitProgressReport,
  MLCEngineConfig,
  MLCEngineInterface,
} from '@mlc-ai/web-llm'
import type {
  OpenAIChatCompletionsAdapterOptions,
  OpenAIChatCompletionsRequestBody,
} from '../openai_chat_completions/types'

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
  OpenAIChatCompletionsAdapterOptions,
  OpenAIChatCompletionsRequestBody,
  DescriptionLike,
  ChatCompletionsHelpers,
  UnsupportedMediaPolicy,
  ChatCompletionsContentBlock,
} from '../openai_chat_completions/types'

export type WebLLMChatCompletionsRequestBody = Omit<OpenAIChatCompletionsRequestBody, 'model'> & {
  model?: string
}

export type WebLLMEngine = MLCEngineInterface
export type WebLLMChatCompletionsEngine = WebLLMEngine
export type WebLLMInitProgressReport = InitProgressReport
export type CreateWebLLMChatCompletionsEngine = (input: {
  model: string
  engineConfig?: MLCEngineConfig
  chatOptions?: ChatOptions | ChatOptions[]
  onInitProgress?: (report: InitProgressReport) => void
}) => Promise<WebLLMEngine>

export interface WebLLMChatCompletionsAdapterOptions extends Omit<
  OpenAIChatCompletionsAdapterOptions,
  'apiKey' | 'baseURL' | 'headers' | 'fetch' | 'retry' | 'requestTimeoutMs'
> {
  repetition_penalty?: number
  ignore_eos?: boolean
  extra_body?: Record<string, unknown>
  engine?: WebLLMEngine
  engineConfig?: MLCEngineConfig
  chatOptions?: ChatOptions | ChatOptions[]
  createEngine?: (input: {
    model: string
    engineConfig?: MLCEngineConfig
    chatOptions?: ChatOptions | ChatOptions[]
    onInitProgress?: (report: InitProgressReport) => void
  }) => Promise<WebLLMEngine>
  onInitProgress?: (report: InitProgressReport) => void
  isWebGPUAvailable?: () => boolean
}
