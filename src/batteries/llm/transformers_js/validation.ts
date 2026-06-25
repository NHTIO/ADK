/**
 * Runtime validation schema and wrapper for transformers.js LLM adapter options.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/validation
 */

import { isError } from '@nhtio/adk/guards'
import { byteStoreSchema } from '@nhtio/adk/common'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_TRANSFORMERS_JS_OPTIONS } from './exceptions'
import type { TransformersJsAdapterOptions } from './types'

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
    validator.any().valid(null).optional()
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

const unsupportedMediaPolicySchema = validator
  .alternatives(
    validator.string().valid('throw', 'fallback-stash', 'synthetic-description'),
    validator
      .object({
        mode: validator.string().valid('fallback-stash').required(),
        stashKeys: validator.array().items(validator.string().min(1)).required(),
      })
      .unknown(false)
  )
  .default('throw')

const toolCallParserSchema = validator
  .alternatives(
    validator
      .string()
      .valid(
        'auto',
        'hermes',
        'gemma',
        'gpt_oss',
        'pythonic',
        'llama3_json',
        'mistral',
        'qwen3_coder',
        'none'
      ),
    validator.function()
  )
  .default('auto')

const reasoningParserSchema = validator
  .alternatives(
    validator.string().valid('auto', 'think_tag', 'harmony_analysis', 'gemma_channel', 'none'),
    validator.function()
  )
  .default('auto')

/**
 * Validator schema for {@link TransformersJsAdapterOptions}. Rejects unknown keys (`.unknown(false)`)
 * and fills in defaults.
 */
export const transformersJsOptionsSchema = validator
  .object<TransformersJsAdapterOptions>({
    // ── Engine ──
    model: validator.string().min(1).required(),
    // The transformers.js pipeline is a callable object — accept either a function or an object.
    pipeline: validator
      .alternatives(validator.function(), validator.object().unknown(true))
      .optional(),
    createPipeline: validator.function().optional(),
    createStreamer: validator.function().optional(),
    device: validator.string().optional(),
    dtype: validator.string().optional(),
    onInitProgress: validator.function().optional(),
    isAvailable: validator.function().optional(),
    // ── Generation ──
    maxNewTokens: validator.number().integer().min(1).optional(),
    doSample: validator.boolean().optional(),
    temperature: validator.number().min(0).optional(),
    topK: validator.number().integer().min(1).optional(),
    topP: validator.number().min(0).max(1).optional(),
    repetitionPenalty: validator.number().min(0).optional(),
    stopStrings: validator.array().items(validator.string()).optional(),
    // ── ADK control ──
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
    reasoningFieldPrecedence: reasoningFieldPrecedenceSchema,
    helpers: helpersSchema.optional(),
    spoolStore: byteStoreSchema.optional(),
    unsupportedMediaPolicy: unsupportedMediaPolicySchema,
    autoAck: validator.boolean().default(false),
    toolCallParser: toolCallParserSchema,
    reasoningParser: reasoningParserSchema,
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates raw adapter options against {@link transformersJsOptionsSchema}, filling in defaults.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults applied.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_OPTIONS} when `input` is invalid.
 */
export const validateOptions = (input: unknown): TransformersJsAdapterOptions => {
  const { value, error } = transformersJsOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_TRANSFORMERS_JS_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  return value as TransformersJsAdapterOptions
}
