/**
 * Runtime option validation for the native Gemini `generateContent` battery.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content/validation
 */

import { validator } from '@nhtio/validation'
import { TokenEncoding } from '@nhtio/adk/common'
import { E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS } from './exceptions'
import type { GeminiGenerateContentAdapterOptions } from './types'

/** Schema for {@link GeminiGenerateContentAdapterOptions}. */
const tokenEncodingSchema = validator
  .alternatives(
    // Known values are suggestions from the canonical list, not a whitelist: consumers may provide
    // a custom or newer tokenizer name. The field accepts any non-empty string, explicit null, or
    // absent (undefined = "no token counting"). `.optional()` preserves the null/undefined
    // disposition required by adk/require-validator-any-required.
    validator
      .string()
      .min(1)
      .description(`Known encodings: ${TokenEncoding.join(', ')}`),
    validator.any().valid(null).optional()
  )
  .default(null)

/** Schema for {@link GeminiGenerateContentAdapterOptions}. */
export const geminiGenerateContentOptionsSchema = validator.object({
  model: validator.string().min(1).required(),
  apiKey: validator.string().optional(),
  useBearerAuth: validator.boolean().optional(),
  baseURL: validator.string().optional(),
  stream: validator.boolean().optional(),
  contextWindow: validator.number().integer().min(1).optional(),
  autoAck: validator.boolean().default(true),
  maxOutputTokens: validator.number().integer().positive().optional(),
  temperature: validator.number().min(0).max(2).optional(),
  topP: validator.number().min(0).max(1).optional(),
  topK: validator.number().integer().positive().optional(),
  stopSequences: validator.array().items(validator.string()).optional(),
  thinkingConfig: validator
    .object({
      thinkingBudget: validator.number().integer().optional(),
      includeThoughts: validator.boolean().optional(),
    })
    .optional(),
  safetySettings: validator
    .array()
    .items(
      validator.object({
        category: validator.string().required(),
        threshold: validator.string().required(),
      })
    )
    .optional(),
  toolConfig: validator
    .object({
      functionCallingConfig: validator
        .object({
          mode: validator.string().valid('AUTO', 'ANY', 'NONE').required(),
          allowedFunctionNames: validator.array().items(validator.string()).optional(),
        })
        .required(),
    })
    .optional(),
  // `false` opts out of the sentinel entirely and surfaces Gemini's own rejection instead.
  thoughtSignatureSentinel: validator
    .alternatives(validator.string().min(1), validator.boolean().valid(false))
    .optional(),
  timeoutMs: validator.number().integer().positive().optional(),
  retry: validator
    .object({
      maxAttempts: validator.number().integer().positive().optional(),
      baseDelayMs: validator.number().integer().positive().optional(),
      maxDelayMs: validator.number().integer().positive().optional(),
      retriableStatuses: validator.array().items(validator.number()).optional(),
      honorRetryAfter: validator.boolean().optional(),
    })
    .optional(),
  fetch: validator.function().optional(),
  tokenEncoding: tokenEncodingSchema,
  spoolStore: validator.any().optional(),
  bucketOrder: validator.any().optional(),
  thoughtSurfacing: validator.string().valid('all-self', 'latest-self', 'all').optional(),
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
  localToolCallParser: validator.any().optional(),
  onRawGeneration: validator.function().optional(),
  onPromptAssembled: validator.function().optional(),
  helpers: validator.object().unknown(true).optional(),
  forgeToolsFilter: validator.function().optional(),
})

/**
 * Validate and normalise adapter options.
 *
 * @throws {@link E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS} when validation fails.
 */
export const validateOptions = (input: unknown): GeminiGenerateContentAdapterOptions => {
  const { error, value } = geminiGenerateContentOptionsSchema.validate(input, {
    allowUnknown: false,
    stripUnknown: false,
  })
  if (error) {
    throw new E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS([
      error.details.map((detail: { message: string }) => detail.message).join(' '),
    ])
  }
  return value as GeminiGenerateContentAdapterOptions
}
