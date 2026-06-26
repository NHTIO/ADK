/**
 * Runtime validation schema and wrapper for LiteRT-LM adapter options.
 *
 * @module @nhtio/adk/batteries/llm/litert_lm/validation
 */

import { isError } from '@nhtio/adk/guards'
import { byteStoreSchema } from '@nhtio/adk/common'
import { E_INVALID_LITERT_LM_OPTIONS } from './exceptions'
import { validator, ValidationError } from '@nhtio/validation'
import type { LiteRtLmAdapterOptions } from './types'

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
    // OPTIONAL: a valid encoding string, explicit null, or absent (undefined = "no token counting").
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

// `model` accepts a URL string, a ReadableStream<Uint8Array>, or a Blob. The two object forms are
// runtime instances Joi cannot introspect, so accept any non-string object and let `Engine.create`
// reject a genuinely wrong shape — validating the *adapter* contract, not the provider's.
const modelSchema = validator
  .alternatives(validator.string().min(1), validator.object().unknown(true))
  .required()

// NATIVE escape hatch — optional, no defaults (the shared generation resolver owns the defaults and
// builds the effective samplerParams from the canonical `sampler`/`temperature`/`topK`/`topP`). When a
// caller DOES pass samplerParams directly, the GREEDY/k<=1 invariant is still enforced here so a bad
// combo fails at validation rather than exploding in the wasm runtime (`Top-K value N must be <= 1`).
const samplerParamsSchema = validator
  .object({
    // 1=TOP_K, 2=TOP_P, 3=GREEDY (0=TYPE_UNSPECIFIED lets the runtime guess — disallowed here).
    type: validator.number().integer().valid(1, 2, 3).optional(),
    // CONDITIONAL on `type`: the LiteRT GREEDY sampler is argmax/top-1 and the runtime REQUIRES `k <= 1`.
    k: validator
      .number()
      .integer()
      .when('type', {
        is: 3,
        then: validator.number().valid(1),
        otherwise: validator.number().integer().min(1),
      })
      .optional(),
    p: validator.number().min(0).max(1).optional(),
    temperature: validator.number().min(0).optional(),
    seed: validator.number().integer().optional(),
  })
  .unknown(false)
  .optional()

/**
 * Validator schema for {@link LiteRtLmAdapterOptions}. Rejects unknown keys (`.unknown(false)`) so
 * typos and removed fields fail loud, and fills in defaults.
 */
export const liteRtLmOptionsSchema = validator
  .object<LiteRtLmAdapterOptions>({
    // ── Engine ──
    model: modelSchema,
    engine: validator.object().unknown(true).optional(),
    createEngine: validator.function().optional(),
    onInitProgress: validator.function().optional(),
    isWebGPUAvailable: validator.function().optional(),
    inputPromptAsHint: validator.string().optional(),
    // ── Generation: PORTABLE canonical contract (shared with transformers.js) ──
    // Optional — the shared resolver fills deterministic defaults (greedy, temp 0.7, k 40, p 0.95, max
    // 1024) and applies canonical-wins precedence over the LiteRT-native fields below.
    maxTokens: validator.number().integer().min(1).optional(),
    sampler: validator.string().valid('greedy', 'top-k', 'top-p').optional(),
    temperature: validator.number().min(0).optional(),
    topK: validator.number().integer().min(1).optional(),
    topP: validator.number().min(0).max(1).optional(),
    seed: validator.number().integer().optional(),
    multimodal: validator
      .object({ image: validator.boolean().optional(), audio: validator.boolean().optional() })
      .unknown(false)
      .optional(),
    // ── Generation (LiteRT-NATIVE escape hatches) ── consulted only when the canonical field is unset.
    // `maxNumTokens` (the engine's total context budget) is LiteRT-only and pinned to a safe 4096.
    samplerParams: samplerParamsSchema,
    maxOutputTokens: validator.number().integer().min(1).optional(),
    maxNumTokens: validator.number().integer().min(1).default(4096),
    // Backend enum: 0..6 (UNSPECIFIED, CPU_ARTISAN, GPU_ARTISAN, CPU, GPU, GOOGLE_TENSOR_ARTISAN, NPU)
    backend: validator.number().integer().min(0).max(6).optional(),
    audioModalityEnabled: validator.boolean().optional(),
    visionModalityEnabled: validator.boolean().optional(),
    enableConstrainedDecoding: validator.boolean().optional(),
    filterChannelContentFromKvCache: validator.boolean().optional(),
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
    // ── Lifecycle hooks (opt-in, normalized phase machine) ──
    onLifecycle: validator.function().optional(),
    onLoading: validator.function().optional(),
    onCompiling: validator.function().optional(),
    onReady: validator.function().optional(),
    onGenerating: validator.function().optional(),
    onComplete: validator.function().optional(),
    onError: validator.function().optional(),
    toolCallParser: validator
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
            'phi',
            'none'
          ),
        validator.function()
      )
      .default('auto'),
    reasoningParser: validator
      .alternatives(
        validator.string().valid('auto', 'think_tag', 'harmony_analysis', 'gemma_channel', 'none'),
        validator.function()
      )
      .default('auto'),
    toolDelivery: validator.string().valid('prompt', 'native').default('prompt'),
    enableThinking: validator.boolean().default(false),
    reasoningOrphanRecovery: validator.boolean().default(true),
    extractMediaOutputs: validator.function().optional(),
  })
  .unknown(false)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates raw adapter options against {@link liteRtLmOptionsSchema}, filling in defaults.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults applied.
 * @throws {@link @nhtio/adk/batteries!E_INVALID_LITERT_LM_OPTIONS} when `input` is invalid.
 */
export const validateOptions = (input: unknown): LiteRtLmAdapterOptions => {
  const { value, error } = liteRtLmOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_LITERT_LM_OPTIONS([formatValidationDetails(error)], {
      cause: error,
    })
  }
  return value as LiteRtLmAdapterOptions
}
