/**
 * Runtime validation schema and wrapper for WebLLM Chat Completions adapter options.
 *
 * @module @nhtio/adk/batteries/llm/webllm_chat_completions/validation
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { byteStoreSchema, TokenEncoding } from '@nhtio/adk/common'
import { E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS } from './exceptions'
import type { WebLLMChatCompletionsAdapterOptions } from './types'

const bucketLabelSchema = validator
  .string()
  .valid('standingInstructions', 'memories', 'retrievables', 'timeline')

const bucketOrderSchema = validator
  .array()
  .items(bucketLabelSchema)
  .unique()
  .default(['standingInstructions', 'memories', 'retrievables', 'timeline'])

const reasoningFieldPrecedenceSchema = validator
  .array()
  .items(validator.string().valid('reasoning', 'reasoning_content'))
  .unique()
  .min(1)
  .default(['reasoning', 'reasoning_content'])

const tokenEncodingSchema = validator
  .alternatives(
    // Derive from the canonical TokenEncoding array (single source of truth) so newly-added encodings
    // (e.g. 'gemma') are accepted without drift between the counter and this validator.
    validator.string().valid(...TokenEncoding),
    // tokenEncoding is OPTIONAL: a valid encoding string, explicit null, or absent (undefined =
    // "no token counting"). `.optional()` makes the null/undefined disposition explicit (both
    // allowed) per adk/require-validator-any-required, without rejecting the omitted case.
    validator.any().valid(null).optional()
  )
  .default(null)

// Optional fallback tool-call parser (see WebLLMChatCompletionsAdapterOptions.localToolCallParser,
// inherited from the OpenAI options). A bundled family name, 'auto' (try-all), 'none', or a custom
// ToolCallParserFn. `.optional()` — absent = disabled. Names mirror chat_common's ToolCallParserName union.
const localToolCallParserSchema = validator
  .alternatives(
    validator
      .string()
      .valid(
        'auto',
        'hermes',
        'gemma',
        'gpt_oss',
        'pythonic',
        'bare_pythonic',
        'loose_keyed',
        'llama3_json',
        'mistral',
        'qwen3_coder',
        'phi',
        'none'
      ),
    validator.function()
  )
  .optional()

const helperSchema = validator.function()

const helpersSchema = validator
  .object({
    descriptionToChatCompletionsJsonSchema: helperSchema.optional(),
    renderUntrustedContent: helperSchema.optional(),
    renderTrustedContent: helperSchema.optional(),
    renderStandingInstructions: helperSchema.optional(),
    renderMemories: helperSchema.optional(),
    renderRetrievables: helperSchema.optional(),
    renderRetrievableHandleBody: helperSchema.optional(),
    renderRetrievableSafetyDirective: helperSchema.optional(),
    renderFirstPartyRetrievables: helperSchema.optional(),
    renderThirdPartyPublicRetrievables: helperSchema.optional(),
    renderThirdPartyPrivateRetrievables: helperSchema.optional(),
    renderTimelineMessage: helperSchema.optional(),
    renderThought: helperSchema.optional(),
    filterThoughts: helperSchema.optional(),
    toolsToChatCompletionsTools: helperSchema.optional(),
    renderChatCompletionsSystemPrompt: helperSchema.optional(),
    renderChatCompletionsToolCallResult: helperSchema.optional(),
    buildChatCompletionsHistory: helperSchema.optional(),
    createChatCompletionsToolCallDeltaAccumulator: helperSchema.optional(),
  })
  .unknown(false)

const jsonSchemaSchema = validator.object().unknown(true)

const responseFormatSchema = validator.alternatives(
  validator.object({ type: validator.string().valid('text').required() }).unknown(false),
  validator.object({ type: validator.string().valid('json_object').required() }).unknown(false),
  validator
    .object({
      type: validator.string().valid('json_schema').required(),
      json_schema: validator
        .object({
          name: validator.string().required(),
          schema: jsonSchemaSchema.required(),
          strict: validator.boolean().optional(),
          description: validator.string().optional(),
        })
        .unknown(false)
        .required(),
    })
    .unknown(false)
)

const toolChoiceItemSchema = validator.alternatives(
  validator
    .object({
      type: validator.string().valid('function').required(),
      function: validator.object({ name: validator.string().required() }).unknown(false).required(),
    })
    .unknown(false),
  validator
    .object({
      type: validator.string().valid('custom').required(),
      custom: validator.object({ name: validator.string().required() }).unknown(false).required(),
    })
    .unknown(false)
)

const toolChoiceSchema = validator.alternatives(
  validator.string().valid('none', 'auto', 'required'),
  toolChoiceItemSchema,
  validator
    .object({
      type: validator.string().valid('allowed_tools').required(),
      allowed_tools: validator
        .object({
          mode: validator.string().valid('auto', 'required').required(),
          tools: validator.array().items(toolChoiceItemSchema).required(),
        })
        .unknown(false)
        .required(),
    })
    .unknown(false)
)

/**
 * Validator schema for {@link WebLLMChatCompletionsAdapterOptions}. Rejects unknown keys
 * (`.unknown(false)`) so typos and removed fields fail loud, and fills in defaults.
 */
export const webLLMChatCompletionsOptionsSchema = validator
  .object<WebLLMChatCompletionsAdapterOptions>({
    engine: validator.object().unknown(true).optional(),
    createEngine: validator.function().optional(),
    onInitProgress: validator.function().optional(),
    isWebGPUAvailable: validator.function().optional(),
    // ── Lifecycle hooks (opt-in, normalized phase machine; additive over onInitProgress) ──
    onLifecycle: validator.function().optional(),
    onLoading: validator.function().optional(),
    onCompiling: validator.function().optional(),
    onReady: validator.function().optional(),
    onGenerating: validator.function().optional(),
    onComplete: validator.function().optional(),
    onError: validator.function().optional(),
    engineConfig: validator.object().unknown(true).optional(),
    chatOptions: validator
      .alternatives(
        validator.object().unknown(true),
        validator.array().items(validator.object().unknown(true))
      )
      .optional(),
    stream: validator.boolean().default(true),
    bucketOrder: bucketOrderSchema,
    // Safe context budget (enforced only when `tokenEncoding` is non-null — counting is opt-in, but the
    // ceiling is pinned so once enabled it never silently exceeds a small on-device model's window).
    contextWindow: validator.number().integer().min(1).default(4096),
    selfIdentity: validator.string().min(1).default('assistant'),
    thoughtSurfacing: validator
      .string()
      .valid('all-self', 'latest-self', 'all')
      .default('all-self'),
    tokenEncoding: tokenEncodingSchema,
    replayCompatibility: validator.array().items(validator.string().min(1)).default([]),
    reasoningFieldPrecedence: reasoningFieldPrecedenceSchema,
    helpers: helpersSchema.optional(),
    spoolStore: byteStoreSchema.optional(),
    strictToolChoice: validator.boolean().default(false),
    // Opt-in: executor self-acks tool-call-free responses only when true.
    // Default false hands turn completion to the implementor (see
    // OpenAIChatCompletionsAdapterOptions.autoAck — inherited here).
    autoAck: validator.boolean().default(false),
    unsupportedMediaPolicy: validator
      .alternatives(
        validator.string().valid('throw', 'fallback-stash', 'synthetic-description'),
        validator
          .object({
            mode: validator.string().valid('fallback-stash').required(),
            stashKeys: validator.array().items(validator.string().min(1)).required(),
          })
          .unknown(false)
      )
      .default('throw'),

    model: validator.string().required(),
    frequency_penalty: validator.number().min(-2).max(2).optional(),
    logit_bias: validator.object().pattern(validator.string(), validator.number()).optional(),
    logprobs: validator.boolean().optional(),
    // Generation knobs are pinned with explicit deterministic-friendly defaults so the MLC engine never
    // falls back to a model-config guess (the source of per-model surprises). temperature 0 = greedy.
    max_tokens: validator.number().integer().min(1).default(1024),
    n: validator.number().integer().min(1).optional(),
    presence_penalty: validator.number().min(-2).max(2).optional(),
    response_format: responseFormatSchema.optional(),
    seed: validator.number().integer().optional(),
    stop: validator
      .alternatives(validator.string(), validator.array().items(validator.string()))
      .optional(),
    stream_options: validator.object().unknown(true).optional(),
    temperature: validator.number().min(0).max(2).default(0),
    tool_choice: toolChoiceSchema.optional(),
    top_logprobs: validator.number().integer().min(0).optional(),
    top_p: validator.number().min(0).max(1).default(0.95),
    user: validator.string().optional(),
    repetition_penalty: validator.number().optional(),
    ignore_eos: validator.boolean().optional(),
    extra_body: validator.object().unknown(true).optional(),
    max_completion_tokens: validator.number().integer().min(1).optional(),
    // Explicit thinking flag (default OFF). Threaded into the request as extra_body.enable_thinking by
    // the adapter so the underlying chat template never decides for itself (Qwen3/DeepSeek default ON).
    enableThinking: validator.boolean().default(false),
    onRawGeneration: validator.function().optional(),
    onPromptAssembled: validator.function().optional(),
    toolCallIdFilter: validator.function().optional(),
    localToolCallParser: localToolCallParserSchema,
    forgeToolsFilter: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates raw adapter options against {@link webLLMChatCompletionsOptionsSchema}, filling in
 * defaults.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults applied.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS} when `input` is invalid.
 */
export const validateOptions = (input: unknown): WebLLMChatCompletionsAdapterOptions => {
  const { value, error } = webLLMChatCompletionsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as WebLLMChatCompletionsAdapterOptions
}

void isValidationError
