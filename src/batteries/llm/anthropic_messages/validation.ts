/**
 * Runtime validation schema and wrapper for Anthropic Messages adapter options.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/validation
 *
 * @remarks
 * Schema and call-site wrapper for validating `AnthropicMessagesAdapterOptions`. Used at
 * construction time and at the start of every iteration against the merged options shape. Throws
 * `E_INVALID_ANTHROPIC_MESSAGES_OPTIONS` on failure, matching the hard-fail policy of the sibling
 * HTTP batteries.
 *
 * Note the deliberate `.unknown(...)` asymmetry: the top level is `.unknown(false)` so option typos
 * fail loud, but provider-owned passthrough blocks are `.unknown(true)` so SDK-supported additions
 * can pass through without a library bump.
 */

import { validator, ValidationError } from '@nhtio/validation'
import { byteStoreSchema, TokenEncoding } from '@nhtio/adk/common'
import { E_INVALID_ANTHROPIC_MESSAGES_OPTIONS } from './exceptions'
import type { AnthropicMessagesAdapterOptions } from './types'

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const providerObjectSchema = validator.object().unknown(true)

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
    // Derive from the canonical TokenEncoding array as the accepted CONTRIBUTING number 13 carve-out.
    validator.string().valid(...TokenEncoding),
    // `tokenEncoding?: TokenEncoding | null` accepts a valid encoding string, explicit null, or
    // absence. `.optional()` makes the null disposition explicit for adk/require-validator-any-required.
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
      .default([429, 502, 503, 504, 529]),
    honorRetryAfter: validator.boolean().default(true),
  })
  .unknown(false)

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
    renderRetrievableSafetyDirective: helperSchema.optional(),
    renderFirstPartyRetrievables: helperSchema.optional(),
    renderThirdPartyPublicRetrievables: helperSchema.optional(),
    renderThirdPartyPrivateRetrievables: helperSchema.optional(),
    renderThought: helperSchema.optional(),
    filterThoughts: helperSchema.optional(),
    toolsToChatCompletionsTools: helperSchema.optional(),
    renderChatCompletionsSystemPrompt: helperSchema.optional(),
    anthropicToolsFromTools: helperSchema.optional(),
    renderAnthropicTimelineMessage: helperSchema.optional(),
    renderAnthropicMediaBlocks: helperSchema.optional(),
    renderAnthropicToolCallResult: helperSchema.optional(),
    renderAnthropicSegmentedSystemPrompt: helperSchema.optional(),
    renderAnthropicThinkingBlocks: helperSchema.optional(),
    buildAnthropicMessagesHistory: helperSchema.optional(),
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

const thinkingSchema = validator
  .alternatives(
    validator
      .object({
        type: validator.string().valid('enabled').required(),
        // The wire requires at least 1024 (SDK: "Must be 1024 or more and less than max_tokens").
        // Rejecting a smaller value here is not request repair — it is refusing to send a request the
        // API is guaranteed to reject, with a validation error the caller can act on instead of a 400.
        budget_tokens: validator.number().integer().min(1024).required(),
        display: validator.string().valid('summarized', 'omitted').allow(null).optional(),
      })
      .unknown(true),
    validator
      .object({
        type: validator.string().valid('disabled').required(),
      })
      .unknown(true),
    validator
      .object({
        type: validator.string().valid('adaptive').required(),
        display: validator.string().valid('summarized', 'omitted').allow(null).optional(),
      })
      .unknown(true)
  )
  .optional()

const toolChoiceSchema = validator
  .alternatives(
    validator
      .object({
        type: validator.string().valid('auto').required(),
        disable_parallel_tool_use: validator.boolean().optional(),
      })
      .unknown(true),
    validator
      .object({
        type: validator.string().valid('any').required(),
        disable_parallel_tool_use: validator.boolean().optional(),
      })
      .unknown(true),
    validator
      .object({
        type: validator.string().valid('tool').required(),
        name: validator.string().min(1).required(),
        disable_parallel_tool_use: validator.boolean().optional(),
      })
      .unknown(true),
    validator
      .object({
        type: validator.string().valid('none').required(),
      })
      .unknown(true)
  )
  .optional()

const outputConfigSchema = validator
  .object({
    effort: validator
      .string()
      .valid('low', 'medium', 'high', 'xhigh', 'max')
      .allow(null)
      .optional(),
    format: providerObjectSchema.allow(null).optional(),
  })
  .unknown(true)

const headersSchema = validator.object().pattern(validator.string(), validator.string())

// ─── Top-level schema ─────────────────────────────────────────────────────────

/**
 * Validator schema for `AnthropicMessagesAdapterOptions`. Used by `validateOptions` at construction
 * time and again at the start of every iteration after options have been merged. Rejects unknown
 * top-level keys so typos fail loud.
 */
export const anthropicMessagesOptionsSchema = validator
  .object<AnthropicMessagesAdapterOptions>({
    // ADK control and HTTP transport
    apiKey: validator.string().optional(),
    baseURL: validator.string().optional(),
    headers: headersSchema.optional(),
    fetch: validator.function().optional(),
    stream: validator.boolean().default(true),
    streamIdleTimeoutMs: validator.number().integer().min(0).default(0),
    requestTimeoutMs: validator.number().integer().min(0).default(0),
    retry: retrySchema.default({}),
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
    autoAck: validator.boolean().default(false),
    unsupportedMediaPolicy: unsupportedMediaPolicySchema,

    // Anthropic Messages request surface
    model: validator.string().required(),
    maxTokens: validator.number().integer().min(0).required(),
    stopSequences: validator.array().items(validator.string()).optional(),
    thinking: thinkingSchema,
    outputConfig: outputConfigSchema.optional(),
    toolChoice: toolChoiceSchema,
    dangerouslyAllowBrowser: validator.boolean().default(false),
    cacheBreakpoints: validator.string().valid('auto', 'system-only', 'off').default('auto'),
    cacheTtl: validator.string().valid('5m', '1h').optional(),
    metadata: providerObjectSchema.optional(),
    serviceTier: validator.string().valid('auto', 'standard_only').optional(),
    container: validator
      .alternatives(validator.string(), validator.any().valid(null).optional())
      .optional(),
    inferenceGeo: validator
      .alternatives(validator.string(), validator.any().valid(null).optional())
      .optional(),
    userProfileId: validator.string().optional(),
    // Deprecated sampling parameters are intentionally optional and never defaulted.
    temperature: validator.number().optional(),
    topP: validator.number().optional(),
    topK: validator.number().optional(),
    onRawGeneration: validator.function().optional(),
    onPromptAssembled: validator.function().optional(),
    localToolCallParser: localToolCallParserSchema,
  })
  .unknown(false)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates arbitrary input against `anthropicMessagesOptionsSchema` and returns resolved options.
 * Throws `E_INVALID_ANTHROPIC_MESSAGES_OPTIONS` with validator details on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): AnthropicMessagesAdapterOptions => {
  const { value, error } = anthropicMessagesOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_ANTHROPIC_MESSAGES_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as AnthropicMessagesAdapterOptions
}
