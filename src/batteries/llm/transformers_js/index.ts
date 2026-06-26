/**
 * transformers.js LLM adapter battery — dual-environment (Node + browser) on-device text generation.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js
 *
 * @remarks
 * Opinionated LLM battery wrapping `@huggingface/transformers` (transformers.js) — on-device inference
 * via ONNX Runtime, auto-selecting `onnxruntime-node` (native, plain Node) or `onnxruntime-web`
 * (WASM + WebGPU). Environment-neutral: NO WebGPU gate.
 *
 * **transformers.js is text-in / text-out** — it injects tool definitions into the chat template but
 * does NOT return structured tool calls or reasoning. This battery parses them out of the model's text
 * via the shared, configurable parser layer (`toolCallParser` / `reasoningParser`, both `'auto'` by
 * default), mirroring how vLLM/SGLang/Ollama do post-hoc, per-family parsing. The bundled defaults
 * target the small ONNX models that run in transformers.js (Gemma 4 E2B/E4B, gpt-oss:20b,
 * Qwen3-Instruct, Llama 3.2, SmolLM); a custom parser function is the escape hatch for anything else.
 *
 * Re-exports the adapter class, every translation helper (each with its `default*` alias), the shared
 * tool-call + reasoning parser layer (family parsers, `auto` drivers, resolvers, contract types), the
 * option/wire types, the validation schema + `validateOptions`, and the battery-scoped exceptions.
 */

export { TransformersJsAdapter } from './adapter'

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
  // transformers.js-native mappers
  toolsToTransformersJsTools,
  defaultToolsToTransformersJsTools,
  renderTransformersJsToolResult,
  defaultRenderTransformersJsToolResult,
  buildTransformersJsMessages,
  defaultBuildTransformersJsMessages,
  mediaToTransformersInput,
  defaultMediaToTransformersInput,
  createTransformersJsStreamAccumulator,
  defaultCreateTransformersJsStreamAccumulator,
  // shared tool-call parser layer
  hermesToolCallParser,
  defaultHermesToolCallParser,
  gemmaToolCallParser,
  defaultGemmaToolCallParser,
  gptOssToolCallParser,
  defaultGptOssToolCallParser,
  pythonicToolCallParser,
  defaultPythonicToolCallParser,
  llama3JsonToolCallParser,
  defaultLlama3JsonToolCallParser,
  mistralToolCallParser,
  defaultMistralToolCallParser,
  qwen3CoderToolCallParser,
  defaultQwen3CoderToolCallParser,
  phiToolCallParser,
  defaultPhiToolCallParser,
  noneToolCallParser,
  defaultNoneToolCallParser,
  createAutoToolCallParser,
  defaultCreateAutoToolCallParser,
  resolveToolCallParser,
  defaultResolveToolCallParser,
  BUNDLED_TOOL_CALL_PARSERS,
  DEFAULT_TOOL_CALL_PARSER_ORDER,
  // shared reasoning parser layer
  thinkTagReasoningParser,
  defaultThinkTagReasoningParser,
  harmonyAnalysisReasoningParser,
  defaultHarmonyAnalysisReasoningParser,
  gemmaChannelReasoningParser,
  defaultGemmaChannelReasoningParser,
  makeThinkTagReasoningParser,
  makeHarmonyAnalysisReasoningParser,
  makeGemmaChannelReasoningParser,
  buildBundledReasoningParsers,
  noneReasoningParser,
  defaultNoneReasoningParser,
  createAutoReasoningParser,
  defaultCreateAutoReasoningParser,
  resolveReasoningParser,
  defaultResolveReasoningParser,
  BUNDLED_REASONING_PARSERS,
  DEFAULT_REASONING_PARSER_ORDER,
  // shared lifecycle/boot-progress contract
  emitLifecycle,
  defaultEmitLifecycle,
  // shared portable generation contract
  resolveGenerationOptions,
  defaultResolveGenerationOptions,
  GENERATION_DEFAULTS,
} from './helpers'

export type { TransformersJsStreamAccumulator, TransformersJsTool } from './helpers'

export type { ChatGenerationOptions, ChatSampler, ResolvedGenerationOptions } from './helpers'

export type {
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './helpers'

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
  JsonValue,
} from './helpers'

// Media-output seam types (shared, defined in chat_common/types).
export type { GeneratedMediaOutput, MediaOutputExtractorFn } from '../chat_common'

export type {
  TransformersJsAdapterOptions,
  CreateTransformersJsPipeline,
  CreateTransformersJsStreamer,
  CreateTransformersJsMultimodal,
  TransformersJsMessage,
  TransformersJsPipeline,
  TransformersJsTextStreamer,
  TransformersJsProcessor,
  TransformersJsModel,
  TransformersJsModelSource,
  TransformersJsDataType,
  TransformersJsDeviceType,
  TransformersJsDevice,
  TransformersJsDtype,
  TransformersJsProgressCallback,
  TransformersJsHelpers,
  TransformersJsBucketOrder,
  TransformersJsJsonSchema,
  TransformersJsDescriptionLike,
  JsonSchema,
  DescriptionLike,
  UnsupportedMediaPolicy,
} from './types'

export {
  installModelSource,
  withModelSource,
  modelSourceToCache,
  parseResourceKey,
} from './model_source'

export { transformersJsOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_TRANSFORMERS_JS_OPTIONS,
  E_TRANSFORMERS_JS_CONTEXT_OVERFLOW,
  E_TRANSFORMERS_JS_STREAM_ERROR,
  E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS,
  E_TRANSFORMERS_JS_TOOL_PARSE_FAILED,
  E_UNSUPPORTED_MEDIA_MODALITY,
} from './exceptions'
