/**
 * Runtime option validation for the native Bedrock Converse battery.
 *
 * @module @nhtio/adk/batteries/llm/bedrock_converse/validation
 */

import { validator } from '@nhtio/validation'
import { E_INVALID_BEDROCK_CONVERSE_OPTIONS } from './exceptions'
import type { BedrockConverseAdapterOptions } from './types'

/** Schema for {@link BedrockConverseAdapterOptions}. */
export const bedrockConverseOptionsSchema = validator.object({
  model: validator.string().min(1).required(),
  apiKey: validator.string().optional(),
  region: validator.string().optional(),
  baseURL: validator.string().optional(),
  stream: validator.boolean().optional(),
  maxTokens: validator.number().integer().positive().optional(),
  temperature: validator.number().min(0).max(1).optional(),
  topP: validator.number().min(0).max(1).optional(),
  stopSequences: validator.array().items(validator.string()).optional(),
  toolChoice: validator.object().unknown(true).optional(),
  additionalModelRequestFields: validator.object().unknown(true).optional(),
  alternationPolicy: validator.string().valid('merge', 'filler', 'reject').optional(),
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
  toolCallIdFilter: validator.function().optional(),
  onRawGeneration: validator.function().optional(),
  onPromptAssembled: validator.function().optional(),
  helpers: validator.object().unknown(true).optional(),
  forgeToolsFilter: validator.function().optional(),
})

/**
 * Validate and normalise adapter options.
 *
 * @throws {@link E_INVALID_BEDROCK_CONVERSE_OPTIONS} when validation fails.
 */
export const validateOptions = (input: unknown): BedrockConverseAdapterOptions => {
  const { error, value } = bedrockConverseOptionsSchema.validate(input, {
    allowUnknown: false,
    stripUnknown: false,
  })
  if (error) {
    throw new E_INVALID_BEDROCK_CONVERSE_OPTIONS([
      error.details.map((detail: { message: string }) => detail.message).join(' '),
    ])
  }
  return value as BedrockConverseAdapterOptions
}
