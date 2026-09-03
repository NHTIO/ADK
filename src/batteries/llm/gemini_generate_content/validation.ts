/**
 * Runtime option validation for the native Gemini `generateContent` battery.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content/validation
 */

import { validator } from '@nhtio/validation'
import { E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS } from './exceptions'
import type { GeminiGenerateContentAdapterOptions } from './types'

/** Schema for {@link GeminiGenerateContentAdapterOptions}. */
export const geminiGenerateContentOptionsSchema = validator.object({
  model: validator.string().min(1).required(),
  apiKey: validator.string().optional(),
  useBearerAuth: validator.boolean().optional(),
  baseURL: validator.string().optional(),
  stream: validator.boolean().optional(),
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
  tokenEncoding: validator.any().optional(),
  spoolStore: validator.any().optional(),
  bucketOrder: validator.any().optional(),
  thoughtSurfacing: validator.string().valid('all-self', 'latest-self', 'all').optional(),
  unsupportedMediaPolicy: validator.string().optional(),
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
