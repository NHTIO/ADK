import type { BatteryLifecycleHooks } from '../chat_common'
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
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from '../chat_common'

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
  ToolCallIdFilterFn,
} from '../openai_chat_completions/types'

/**
 * The request-body shape for the WebLLM adapter — the OpenAI Chat Completions body with `model`
 * relaxed to optional, since the model is fixed at engine-load time rather than per request.
 */
export type WebLLMChatCompletionsRequestBody = Omit<OpenAIChatCompletionsRequestBody, 'model'> & {
  model?: string
}

/** The in-browser MLC engine instance the adapter drives. */
export type WebLLMEngine = MLCEngineInterface
/** Alias of {@link WebLLMEngine}. */
export type WebLLMChatCompletionsEngine = WebLLMEngine
/** Progress report emitted while a WebLLM model loads/initializes. */
export type WebLLMInitProgressReport = InitProgressReport
/** Factory that loads a model and resolves a ready-to-use {@link WebLLMEngine}. */
export type CreateWebLLMChatCompletionsEngine = (input: {
  model: string
  engineConfig?: MLCEngineConfig
  chatOptions?: ChatOptions | ChatOptions[]
  onInitProgress?: (report: InitProgressReport) => void
}) => Promise<WebLLMEngine>

/**
 * Configuration options for the in-browser WebLLM Chat Completions adapter — the OpenAI options
 * minus the network-transport fields (no HTTP is involved), plus WebLLM-specific engine controls.
 */
export interface WebLLMChatCompletionsAdapterOptions
  extends
    Omit<
      OpenAIChatCompletionsAdapterOptions,
      'apiKey' | 'baseURL' | 'headers' | 'fetch' | 'retry' | 'requestTimeoutMs'
    >,
    BatteryLifecycleHooks {
  /** Penalty applied to repeated tokens (WebLLM/MLC sampling parameter). */
  repetition_penalty?: number
  /** When `true`, the model ignores end-of-sequence tokens and keeps generating. */
  ignore_eos?: boolean
  /** Additional WebLLM/MLC request fields passed through verbatim. */
  extra_body?: Record<string, unknown>
  /** A pre-constructed engine to drive; mutually exclusive with {@link WebLLMChatCompletionsAdapterOptions.createEngine}. */
  engine?: WebLLMEngine
  /** MLC engine configuration used when the adapter creates the engine itself. */
  engineConfig?: MLCEngineConfig
  /** MLC chat option(s) applied to the loaded model. */
  chatOptions?: ChatOptions | ChatOptions[]
  /** Custom engine factory; overrides the default WebLLM engine loader. */
  createEngine?: (input: {
    model: string
    engineConfig?: MLCEngineConfig
    chatOptions?: ChatOptions | ChatOptions[]
    onInitProgress?: (report: InitProgressReport) => void
  }) => Promise<WebLLMEngine>
  /** Callback invoked with model-load progress reports. */
  onInitProgress?: (report: InitProgressReport) => void
  /** Override for the WebGPU-availability probe (defaults to a real `navigator.gpu` check). */
  isWebGPUAvailable?: () => boolean
  /**
   * Whether to enable the model's "thinking"/reasoning mode, threaded EXPLICITLY into the request as
   * `extra_body.enable_thinking`. Defaults to `false` — many reasoning chat templates (Qwen3,
   * DeepSeek-R1) default thinking ON, which silently burns the token budget inside `<think>`. Pinned off
   * unless you opt in. (Independent of `reasoningFieldPrecedence`/parsing, which only handle thinking
   * that IS emitted.)
   */
  enableThinking?: boolean
}
