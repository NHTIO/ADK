/**
 * Runtime validation schema and wrapper for native Ollama adapter options.
 *
 * @module @nhtio/adk/batteries/llm/ollama/validation
 *
 * @remarks
 * Schema and call-site wrapper for validating `OllamaAdapterOptions`. Used at construction time
 * and at the start of every iteration against the merged options shape (stash > executor >
 * constructor). Throws `E_INVALID_OLLAMA_OPTIONS` on failure — same hard-fail policy as every other
 * ADK contract.
 *
 * Note the deliberate `.unknown(...)` asymmetry: the TOP level is `.unknown(false)` so option typos
 * fail loud, but the nested `options` (runtime/sampling) block is `.unknown(true)` so new llama.cpp
 * parameters pass through without a library bump.
 */

import { isError } from '@nhtio/adk/guards'
import { E_INVALID_OLLAMA_OPTIONS } from './exceptions'
import { validator, ValidationError } from '@nhtio/validation'
import { byteStoreSchema, TokenEncoding } from '@nhtio/adk/common'
import type { OllamaAdapterOptions } from './types'

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

const tokenEncodingSchema = validator
  .alternatives(
    // Derive from the canonical TokenEncoding array (single source of truth) so newly-added encodings
    // (e.g. 'gemma') are accepted without drift between the counter and this validator.
    validator.string().valid(...TokenEncoding),
    // `tokenEncoding?: TokenEncoding | null` — OPTIONAL: a valid encoding string, explicit null, or
    // absent (undefined = "no token counting"). `.optional()` makes the null/undefined disposition
    // explicit per adk/require-validator-any-required, without rejecting the legitimate "omitted"
    // case.
    validator.any().valid(null).optional()
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

// Optional fallback tool-call parser (see OllamaAdapterOptions.localToolCallParser). A bundled family
// name, 'auto' (try-all), 'none', or a custom ToolCallParserFn. `.optional()` — absent = disabled =
// native-only behaviour. Names mirror chat_common's ToolCallParserName union.
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
    renderThought: helperSchema.optional(),
    filterThoughts: helperSchema.optional(),
    toolsToChatCompletionsTools: helperSchema.optional(),
    renderChatCompletionsSystemPrompt: helperSchema.optional(),
    renderOllamaTimelineMessage: helperSchema.optional(),
    renderOllamaToolCallResult: helperSchema.optional(),
    buildOllamaHistory: helperSchema.optional(),
  })
  .unknown(false)

// ─── Native request-body sub-schemas ──────────────────────────────────────────

const thinkSchema = validator.alternatives(
  validator.boolean(),
  validator.string().valid('low', 'medium', 'high')
)

const formatSchema = validator.alternatives(validator.string().valid('json'), jsonSchemaSchema)

const keepAliveSchema = validator.alternatives(validator.string(), validator.number())

const stopSchema = validator.alternatives(
  validator.string(),
  validator.array().items(validator.string())
)

// Nested runtime/sampling options block. `.unknown(true)` — the ONLY place unknown keys are
// allowed — so new llama.cpp parameters pass through without a library bump.
const runtimeOptionsSchema = validator
  .object({
    num_ctx: validator.number().integer().min(1).optional(),
    temperature: validator.number().min(0).optional(),
    top_p: validator.number().min(0).max(1).optional(),
    top_k: validator.number().integer().min(0).optional(),
    min_p: validator.number().min(0).max(1).optional(),
    typical_p: validator.number().min(0).max(1).optional(),
    seed: validator.number().integer().optional(),
    stop: stopSchema.optional(),
    num_predict: validator.number().integer().optional(),
    num_keep: validator.number().integer().min(0).optional(),
    repeat_penalty: validator.number().optional(),
    repeat_last_n: validator.number().integer().optional(),
    presence_penalty: validator.number().optional(),
    frequency_penalty: validator.number().optional(),
    penalize_newline: validator.boolean().optional(),
    num_batch: validator.number().integer().min(1).optional(),
    num_gpu: validator.number().integer().min(0).optional(),
    main_gpu: validator.number().integer().min(0).optional(),
    num_thread: validator.number().integer().min(1).optional(),
    numa: validator.boolean().optional(),
    use_mmap: validator.boolean().optional(),
  })
  .unknown(true)

// ─── Top-level schema ─────────────────────────────────────────────────────────

/**
 * Validator schema for `OllamaAdapterOptions`. Used by `validateOptions` at construction time and
 * again at the start of every iteration after options have been merged (stash > executor >
 * constructor). Rejects unknown top-level keys so typos fail loud.
 */
export const ollamaOptionsSchema = validator
  .object<OllamaAdapterOptions>({
    // ADK control
    apiKey: validator.string().optional(),
    baseURL: validator.string().optional(),
    headers: validator.object().pattern(validator.string(), validator.string()).optional(),
    fetch: validator.function().optional(),
    stream: validator.boolean().default(true),
    streamIdleTimeoutMs: validator.number().integer().min(0).default(0),
    requestTimeoutMs: validator.number().integer().min(0).default(0),
    retry: retrySchema.optional(),
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
    // Opt-in: the executor only self-acks tool-call-free responses when true. Default false hands
    // turn-completion control to the implementor's output pipeline.
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

    // Native /api/chat request body
    model: validator.string().required(),
    think: thinkSchema.optional(),
    format: formatSchema.optional(),
    options: runtimeOptionsSchema.optional(),
    keep_alive: keepAliveSchema.optional(),
    onRawGeneration: validator.function().optional(),
    onPromptAssembled: validator.function().optional(),
    localToolCallParser: localToolCallParserSchema,
    toolCallIdFilter: validator.function().optional(),
    forgeToolsFilter: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `ollamaOptionsSchema` and returns the resolved options
 * shape. Throws `E_INVALID_OLLAMA_OPTIONS` (carrying the validator's error report on `cause`) on
 * failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): OllamaAdapterOptions => {
  const { value, error } = ollamaOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_OLLAMA_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  return value as OllamaAdapterOptions
}

// suppress unused import warning when the alias isn't referenced
void isValidationError
