/**
 * Runtime validation schema and wrapper for OpenAI Chat Completions adapter options.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions/validation
 *
 * @remarks
 * Schema and call-site wrapper for validating `OpenAIChatCompletionsAdapterOptions`. Used at
 * construction time and at the start of every iteration against the merged options shape
 * (stash > executor > constructor). Throws `E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS` on
 * failure — same hard-fail policy as every other ADK contract.
 */

import { isError } from '@nhtio/adk/guards'
import { byteStoreSchema } from '@nhtio/adk/common'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS } from './exceptions'
import type { OpenAIChatCompletionsAdapterOptions } from './types'

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const jsonSchemaSchema = validator.object().unknown(true)

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

const retrySchema = validator
  .object({
    maxAttempts: validator.number().integer().min(1).default(1),
    baseDelayMs: validator.number().integer().min(0).default(500),
    maxDelayMs: validator.number().integer().min(1).default(30_000),
    retriableStatuses: validator
      .array()
      .items(validator.number().integer().min(100).max(599))
      .default([429, 502, 503, 504]),
    honorRetryAfter: validator.boolean().default(true),
  })
  .unknown(false)

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

// ─── Chat Completions request-body sub-schemas ────────────────────────────────

const audioSchema = validator
  .object({
    voice: validator.string().required(),
    format: validator.string().valid('wav', 'mp3', 'flac', 'opus', 'pcm16').required(),
  })
  .unknown(false)

const functionCallSchema = validator.alternatives(
  validator.string().valid('none', 'auto'),
  validator.object({ name: validator.string().required() }).unknown(false)
)

const functionsItemSchema = validator
  .object({
    name: validator.string().required(),
    description: validator.string().optional(),
    parameters: jsonSchemaSchema.optional(),
  })
  .unknown(false)

const predictionSchema = validator
  .object({
    type: validator.string().valid('content').required(),
    content: validator
      .alternatives(
        validator.string(),
        validator.array().items(
          validator
            .object({
              type: validator.string().valid('text').required(),
              text: validator.string().required(),
            })
            .unknown(false)
        )
      )
      .required(),
  })
  .unknown(false)

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

const streamOptionsSchema = validator
  .object({
    include_usage: validator.boolean().optional(),
    include_obfuscation: validator.boolean().optional(),
  })
  .unknown(false)

const webSearchOptionsSchema = validator
  .object({
    search_context_size: validator.string().valid('low', 'medium', 'high').optional(),
    user_location: validator
      .object({
        type: validator.string().valid('approximate').required(),
        approximate: validator
          .object({
            city: validator.string().optional(),
            country: validator.string().optional(),
            region: validator.string().optional(),
            timezone: validator.string().optional(),
          })
          .unknown(false)
          .required(),
      })
      .unknown(false)
      .optional(),
  })
  .unknown(false)

// ─── Top-level schema ─────────────────────────────────────────────────────────

/**
 * Validator schema for `OpenAIChatCompletionsAdapterOptions`.
 *
 * @remarks
 * Used by `validateOptions` at construction time and again at the start of every iteration after
 * options have been merged (stash > executor > constructor). Rejects unknown top-level keys
 * so typos and removed fields (`bucketBudgets`, `maxInlineToolResultFraction`, `trustedTools`)
 * fail loud.
 */
export const openAIChatCompletionsOptionsSchema = validator
  .object<OpenAIChatCompletionsAdapterOptions>({
    // ADK control
    apiKey: validator.string().optional(),
    baseURL: validator.string().optional(),
    headers: validator.object().pattern(validator.string(), validator.string()).optional(),
    stream: validator.boolean().default(true),
    streamIdleTimeoutMs: validator.number().integer().min(0).default(0),
    requestTimeoutMs: validator.number().integer().min(0).default(0),
    retry: retrySchema.optional(),
    fetch: validator.function().optional(),
    bucketOrder: bucketOrderSchema,
    contextWindow: validator.number().integer().min(1).optional(),
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
    // Opt-in: the executor only self-acks tool-call-free responses when true.
    // Default false hands turn-completion control to the implementor's output
    // pipeline (see OpenAIChatCompletionsAdapterOptions.autoAck).
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

    // Chat Completions request body
    model: validator.string().required(),
    audio: audioSchema.optional(),
    frequency_penalty: validator.number().min(-2).max(2).optional(),
    function_call: functionCallSchema.optional(),
    functions: validator.array().items(functionsItemSchema).optional(),
    logit_bias: validator.object().pattern(validator.string(), validator.number()).optional(),
    logprobs: validator.boolean().optional(),
    max_completion_tokens: validator.number().integer().min(1).optional(),
    max_tokens: validator.number().integer().min(1).optional(),
    metadata: validator.object().pattern(validator.string(), validator.string()).optional(),
    modalities: validator.array().items(validator.string().valid('text', 'audio')).optional(),
    n: validator.number().integer().min(1).optional(),
    parallel_tool_calls: validator.boolean().optional(),
    prediction: predictionSchema.optional(),
    presence_penalty: validator.number().min(-2).max(2).optional(),
    prompt_cache_key: validator.string().optional(),
    prompt_cache_retention: validator.string().valid('in_memory', '24h').optional(),
    reasoning_effort: validator.string().valid('minimal', 'low', 'medium', 'high').optional(),
    response_format: responseFormatSchema.optional(),
    safety_identifier: validator.string().optional(),
    seed: validator.number().integer().optional(),
    service_tier: validator
      .string()
      .valid('auto', 'default', 'flex', 'priority', 'scale')
      .optional(),
    stop: validator
      .alternatives(validator.string(), validator.array().items(validator.string()))
      .optional(),
    store: validator.boolean().optional(),
    stream_options: streamOptionsSchema.optional(),
    temperature: validator.number().min(0).max(2).optional(),
    tool_choice: toolChoiceSchema.optional(),
    top_logprobs: validator.number().integer().min(0).max(20).optional(),
    top_p: validator.number().min(0).max(1).optional(),
    user: validator.string().optional(),
    verbosity: validator.string().valid('low', 'medium', 'high').optional(),
    web_search_options: webSearchOptionsSchema.optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `openAIChatCompletionsOptionsSchema` and returns the
 * resolved options shape. Throws `E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS` (carrying the
 * validator's error report on `cause`) on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): OpenAIChatCompletionsAdapterOptions => {
  const { value, error } = openAIChatCompletionsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as OpenAIChatCompletionsAdapterOptions
}

// suppress unused import warning when the alias isn't referenced
void isValidationError
