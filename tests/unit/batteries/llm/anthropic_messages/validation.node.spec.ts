import { describe, expect, it } from 'vitest'
import { E_INVALID_ANTHROPIC_MESSAGES_OPTIONS } from '@nhtio/adk/batteries/llm/anthropic_messages'
import {
  AnthropicMessagesAdapter,
  anthropicMessagesOptionsSchema,
  validateOptions,
} from '@nhtio/adk/batteries/llm/anthropic_messages'

describe('Anthropic validation', () => {
  it('rejects budget_tokens below 1024', () => {
    expect(() =>
      validateOptions({
        model: 'claude-opus-5',
        maxTokens: 64,
        thinking: { type: 'enabled', budget_tokens: 1000 },
      })
    ).toThrow(E_INVALID_ANTHROPIC_MESSAGES_OPTIONS)
  })

  it('rejects unknown top-level keys', () => {
    expect(() =>
      validateOptions({
        model: 'claude-opus-5',
        maxTokens: 64,
        totallyUnknown: true,
      })
    ).toThrow(E_INVALID_ANTHROPIC_MESSAGES_OPTIONS)
  })

  it('fills nested retry defaults including upstream 529 when retry is provided', () => {
    const value = validateOptions({
      model: 'claude-opus-5',
      maxTokens: 64,
      retry: { maxAttempts: 2 },
    })
    expect(value.retry).toMatchObject({
      maxAttempts: 2,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      honorRetryAfter: true,
      retriableStatuses: [429, 502, 503, 504, 529],
    })
  })

  it('adapter construction uses the same validation wrapper', () => {
    expect(() => new AnthropicMessagesAdapter({})).toThrow(E_INVALID_ANTHROPIC_MESSAGES_OPTIONS)
  })

  it('schema resolves valid defaults with no unknown leakage', () => {
    const { value, error } = anthropicMessagesOptionsSchema.validate(
      { model: 'claude-opus-5', maxTokens: 64 },
      { abortEarly: false, convert: false }
    )
    expect(error).toBeUndefined()
    expect(value).toMatchObject({
      stream: true,
      requestTimeoutMs: 0,
      streamIdleTimeoutMs: 0,
      cacheBreakpoints: 'auto',
      dangerouslyAllowBrowser: false,
    })
  })
})
