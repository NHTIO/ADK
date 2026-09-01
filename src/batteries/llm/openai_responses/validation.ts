/**
 * Runtime validation schema and wrapper for OpenAI Responses adapter options.
 *
 * @module @nhtio/adk/batteries/llm/openai_responses/validation
 *
 * @remarks
 * Schema and call-site wrapper for validating `OpenAIResponsesAdapterOptions`. Used at
 * construction time and at the start of every iteration against the merged options shape
 * (stash > executor > constructor). Throws `E_INVALID_OPENAI_RESPONSES_OPTIONS` on failure — same
 * hard-fail policy as every other ADK contract.
 *
 * Notable divergences from the sibling `openai_chat_completions`/`anthropic_messages` schemas:
 * - NO `instructions` key and NO `store` key at all — both are exclusively adapter-owned (see
 *   the battery's design notes). `.unknown(false)` rejects them the same way it rejects
 *   `previous_response_id`/`conversation`/`prompt`/`context_management` — ADK owns history and the
 *   system prompt on every battery; this one simply has no escape hatch for either.
 * - `max_output_tokens` carries `.min(16)` — an undocumented API minimum (`400 Invalid
 *   'max_output_tokens'... Expected a value >= 16`) enforced at config time instead of dispatch
 *   time.
 * - `background` only accepts `false`/undefined — `true` is rejected, since this adapter has no
 *   polling/resumption logic for a queued/in_progress background response (see the option's own
 *   doc comment in types.ts).
 */

import { isError } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_OPENAI_RESPONSES_OPTIONS } from './exceptions'
import { byteStoreSchema, TokenEncoding } from '@nhtio/adk/common'
import type { OpenAIResponsesAdapterOptions } from './types'

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

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
    validator.string().valid(...TokenEncoding),
    // `tokenEncoding?: TokenEncoding | null` — OPTIONAL: a valid encoding string, explicit null, or
    // absent (undefined = "no token counting"). `.optional()` makes the null/undefined disposition
    // explicit per adk/require-validator-any-required, without rejecting "omitted".
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

// Optional fallback tool-call parser — mirrors chat_common's ToolCallParserName union.
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
    renderArtifactHandleBody: helperSchema.optional(),
    renderOpenAIResponsesMediaBlocks: helperSchema.optional(),
    renderOpenAIResponsesTimelineMessage: helperSchema.optional(),
    renderOpenAIResponsesToolCallResult: helperSchema.optional(),
    toolsToOpenAIResponsesTools: helperSchema.optional(),
    fingerprintOpenAIResponsesPrefix: helperSchema.optional(),
    renderOpenAIResponsesReasoningItem: helperSchema.optional(),
    buildOpenAIResponsesInput: helperSchema.optional(),
    createResponsesOutputSlotMachine: helperSchema.optional(),
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

// ─── Responses request-body sub-schemas ───────────────────────────────────────

const includeItemSchema = validator.string().min(1)

const reasoningSchema = validator
  .object({
    effort: validator
      .string()
      .valid('none', 'minimal', 'low', 'medium', 'high', 'xhigh')
      .optional(),
    summary: validator.string().valid('auto', 'concise', 'detailed').optional(),
  })
  .unknown(false)

const toolChoiceSchema = validator.alternatives(
  validator.string().valid('none', 'auto', 'required'),
  validator
    .object({
      type: validator.string().valid('function').required(),
      name: validator.string().required(),
    })
    .unknown(false)
)

const textFormatSchema = validator.object().unknown(true)

const textSchema = validator
  .object({
    format: textFormatSchema.optional(),
    verbosity: validator.string().valid('low', 'medium', 'high').optional(),
  })
  .unknown(false)

const streamOptionsSchema = validator
  .object({
    include_obfuscation: validator.boolean().optional(),
  })
  .unknown(false)

// ─── Top-level schema ─────────────────────────────────────────────────────────

/**
 * Validator schema for `OpenAIResponsesAdapterOptions`.
 *
 * @remarks
 * Used by `validateOptions` at construction time and again at the start of every iteration after
 * options have been merged (stash > executor > constructor). Rejects unknown top-level keys so
 * typos, removed fields, and every server-side-conversation-state key
 * (`previous_response_id`/`conversation`/`prompt`/`context_management`) fail loud — as does
 * `instructions`/`store`, which are simply not part of this options interface at all (see the
 * module remarks above).
 */
export const openAIResponsesOptionsSchema = validator
  .object<OpenAIResponsesAdapterOptions>({
    // ADK control
    apiKey: validator.string().optional(),
    baseURL: validator.string().optional(),
    organization: validator.string().optional(),
    project: validator.string().optional(),
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
    helpers: helpersSchema.optional(),
    spoolStore: byteStoreSchema.optional(),
    strictToolChoice: validator.boolean().default(false),
    autoAck: validator.boolean().default(false),
    unsupportedMediaPolicy: unsupportedMediaPolicySchema,

    // Responses-specific ADK control
    systemPromptChannel: validator
      .string()
      .valid('instructions', 'developer-item', 'system-item')
      .default('instructions'),
    reasoningReplay: validator.string().valid('off', 'encrypted', 'summary-only').default('off'),
    strict: validator.boolean().optional(),

    // Responses request body
    model: validator.string().required(),
    include: validator.array().items(includeItemSchema).optional(),
    reasoning: reasoningSchema.optional(),
    // Undocumented API minimum of 16 — see the module remarks and Known Gotcha #2.
    max_output_tokens: validator.number().integer().min(16).optional(),
    parallel_tool_calls: validator.boolean().optional(),
    temperature: validator.number().min(0).max(2).optional(),
    top_p: validator.number().min(0).max(1).optional(),
    top_logprobs: validator.number().integer().min(0).max(20).optional(),
    truncation: validator.string().valid('auto', 'disabled').optional(),
    service_tier: validator
      .string()
      .valid('auto', 'default', 'flex', 'scale', 'priority')
      .optional(),
    prompt_cache_key: validator.string().optional(),
    prompt_cache_retention: validator.string().valid('in_memory', '24h').optional(),
    safety_identifier: validator.string().optional(),
    metadata: validator.object().pattern(validator.string(), validator.string()).optional(),
    tool_choice: toolChoiceSchema.optional(),
    text: textSchema.optional(),
    // `true` is rejected — no polling/resumption logic exists for a queued/in_progress background
    // response (see the option's own doc comment in types.ts). `false`/undefined pass through.
    background: validator.boolean().valid(false).optional(),
    stream_options: streamOptionsSchema.optional(),
    onRawGeneration: validator.function().optional(),
    onPromptAssembled: validator.function().optional(),
    localToolCallParser: localToolCallParserSchema,
    forgeToolsFilter: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `openAIResponsesOptionsSchema` and returns the resolved
 * options shape. Throws `E_INVALID_OPENAI_RESPONSES_OPTIONS` (carrying the validator's error report
 * on `cause`) on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): OpenAIResponsesAdapterOptions => {
  const { value, error } = openAIResponsesOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_OPENAI_RESPONSES_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as OpenAIResponsesAdapterOptions
}

// suppress unused import warning when the alias isn't referenced
void isValidationError
