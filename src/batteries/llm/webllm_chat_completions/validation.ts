/**
 * Runtime validation schema and wrapper for WebLLM Chat Completions adapter options.
 *
 * @module @nhtio/adk/batteries/llm/webllm_chat_completions/validation
 */

import { isError } from '@nhtio/adk/guards'
import { byteStoreSchema } from '@nhtio/adk/common'
import { validator, ValidationError } from '@nhtio/validation'
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

const tokenEncodingSchema = validator
  .alternatives(
    validator
      .string()
      .valid(
        'gpt2',
        'r50k_base',
        'p50k_base',
        'p50k_edit',
        'cl100k_base',
        'o200k_base',
        'gemini',
        'llama2',
        'claude'
      ),
    validator.any().valid(null)
  )
  .default(null)

const helperSchema = validator.function()

const helpersSchema = validator
  .object({
    descriptionToChatCompletionsJsonSchema: helperSchema.optional(),
    renderUntrustedContent: helperSchema.optional(),
    renderTrustedContent: helperSchema.optional(),
    renderStandingInstructions: helperSchema.optional(),
    renderMemories: helperSchema.optional(),
    renderRetrievables: helperSchema.optional(),
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

export const webLLMChatCompletionsOptionsSchema = validator
  .object<WebLLMChatCompletionsAdapterOptions>({
    engine: validator.object().unknown(true).optional(),
    createEngine: validator.function().optional(),
    onInitProgress: validator.function().optional(),
    isWebGPUAvailable: validator.function().optional(),
    engineConfig: validator.object().unknown(true).optional(),
    chatOptions: validator
      .alternatives(
        validator.object().unknown(true),
        validator.array().items(validator.object().unknown(true))
      )
      .optional(),
    stream: validator.boolean().default(true),
    bucketOrder: bucketOrderSchema,
    contextWindow: validator.number().integer().min(1).optional(),
    selfIdentity: validator.string().min(1).default('assistant'),
    thoughtSurfacing: validator
      .string()
      .valid('all-self', 'latest-self', 'all')
      .default('all-self'),
    tokenEncoding: tokenEncodingSchema,
    replayCompatibility: validator.array().items(validator.string().min(1)).default([]),
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
    max_tokens: validator.number().integer().min(1).optional(),
    n: validator.number().integer().min(1).optional(),
    presence_penalty: validator.number().min(-2).max(2).optional(),
    response_format: responseFormatSchema.optional(),
    seed: validator.number().integer().optional(),
    stop: validator
      .alternatives(validator.string(), validator.array().items(validator.string()))
      .optional(),
    stream_options: validator.object().unknown(true).optional(),
    temperature: validator.number().min(0).max(2).optional(),
    tool_choice: toolChoiceSchema.optional(),
    top_logprobs: validator.number().integer().min(0).optional(),
    top_p: validator.number().min(0).max(1).optional(),
    user: validator.string().optional(),
    repetition_penalty: validator.number().optional(),
    ignore_eos: validator.boolean().optional(),
    extra_body: validator.object().unknown(true).optional(),
    max_completion_tokens: validator.number().integer().min(1).optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

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
