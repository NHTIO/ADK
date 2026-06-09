import { describe, expect, it } from 'vitest'
import {
  validateOptions,
  openAIChatCompletionsOptionsSchema,
  E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS,
  OpenAIChatCompletionsAdapter,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'

const baseValid = { model: 'gpt-4o-mini' }

const expectAccept = (input: unknown) => expect(() => validateOptions(input)).not.toThrow()

const expectReject = (input: unknown) => {
  let thrown: unknown
  try {
    validateOptions(input)
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS)
}

describe('OpenAI Chat Completions option validation', () => {
  describe('schema is exported', () => {
    it('exports the schema object', () => {
      expect(openAIChatCompletionsOptionsSchema).toBeDefined()
      expect(typeof openAIChatCompletionsOptionsSchema.validate).toBe('function')
    })
  })

  // ── 1. Acceptance ──────────────────────────────────────────────────────────
  describe('acceptance: every documented field accepts a representative valid value', () => {
    it('accepts minimal valid options', () => {
      expectAccept(baseValid)
    })

    it('accepts audio', () => {
      expectAccept({ ...baseValid, audio: { voice: 'alloy', format: 'mp3' } })
    })

    it('accepts frequency_penalty positive', () => {
      expectAccept({ ...baseValid, frequency_penalty: 0.5 })
    })

    it('accepts presence_penalty negative', () => {
      expectAccept({ ...baseValid, presence_penalty: -0.5 })
    })

    it('accepts logit_bias', () => {
      expectAccept({ ...baseValid, logit_bias: { '50256': -100 } })
    })

    it('accepts logprobs', () => {
      expectAccept({ ...baseValid, logprobs: true })
    })

    it('accepts top_logprobs', () => {
      expectAccept({ ...baseValid, top_logprobs: 5 })
    })

    it('accepts max_completion_tokens', () => {
      expectAccept({ ...baseValid, max_completion_tokens: 100 })
    })

    it('accepts max_tokens (deprecated)', () => {
      expectAccept({ ...baseValid, max_tokens: 100 })
    })

    it('accepts metadata', () => {
      expectAccept({ ...baseValid, metadata: { key: 'value' } })
    })

    it('accepts modalities', () => {
      expectAccept({ ...baseValid, modalities: ['text', 'audio'] })
    })

    it('accepts n=1', () => {
      expectAccept({ ...baseValid, n: 1 })
    })

    it('accepts parallel_tool_calls', () => {
      expectAccept({ ...baseValid, parallel_tool_calls: true })
    })

    it('accepts prediction (string content)', () => {
      expectAccept({
        ...baseValid,
        prediction: { type: 'content', content: 'hello' },
      })
    })

    it('accepts prompt_cache_key', () => {
      expectAccept({ ...baseValid, prompt_cache_key: 'abc' })
    })

    it('accepts prompt_cache_retention 24h', () => {
      expectAccept({ ...baseValid, prompt_cache_retention: '24h' })
    })

    it('accepts reasoning_effort medium', () => {
      expectAccept({ ...baseValid, reasoning_effort: 'medium' })
    })

    it('accepts reasoning_effort none (Ollama: disables thinking) and round-trips', () => {
      expectAccept({ ...baseValid, reasoning_effort: 'none' })
      const resolved = validateOptions({ ...baseValid, reasoning_effort: 'none' })
      expect(resolved.reasoning_effort).toBe('none')
    })

    it('accepts response_format text', () => {
      expectAccept({ ...baseValid, response_format: { type: 'text' } })
    })

    it('accepts response_format json_object', () => {
      expectAccept({ ...baseValid, response_format: { type: 'json_object' } })
    })

    it('accepts response_format json_schema', () => {
      expectAccept({
        ...baseValid,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'X', schema: { type: 'object' } },
        },
      })
    })

    it('accepts safety_identifier', () => {
      expectAccept({ ...baseValid, safety_identifier: 'x' })
    })

    it('accepts seed', () => {
      expectAccept({ ...baseValid, seed: 42 })
    })

    it.each(['auto', 'default', 'flex', 'priority', 'scale'])('accepts service_tier %s', (tier) => {
      expectAccept({ ...baseValid, service_tier: tier })
    })

    it('accepts stop as string', () => {
      expectAccept({ ...baseValid, stop: 'STOP' })
    })

    it('accepts stop as array', () => {
      expectAccept({ ...baseValid, stop: ['END'] })
    })

    it('accepts store', () => {
      expectAccept({ ...baseValid, store: true })
    })

    it('accepts stream_options', () => {
      expectAccept({ ...baseValid, stream_options: { include_usage: true } })
    })

    it('accepts temperature', () => {
      expectAccept({ ...baseValid, temperature: 1.0 })
    })

    it('accepts tool_choice none', () => {
      expectAccept({ ...baseValid, tool_choice: 'none' })
    })

    it('accepts tool_choice auto', () => {
      expectAccept({ ...baseValid, tool_choice: 'auto' })
    })

    it('accepts tool_choice required', () => {
      expectAccept({ ...baseValid, tool_choice: 'required' })
    })

    it('accepts tool_choice function object', () => {
      expectAccept({
        ...baseValid,
        tool_choice: { type: 'function', function: { name: 'x' } },
      })
    })

    it('accepts top_p', () => {
      expectAccept({ ...baseValid, top_p: 0.9 })
    })

    it('accepts user (deprecated)', () => {
      expectAccept({ ...baseValid, user: 'legacy' })
    })

    it.each(['low', 'medium', 'high'])('accepts verbosity %s', (v) => {
      expectAccept({ ...baseValid, verbosity: v })
    })

    it('accepts web_search_options', () => {
      expectAccept({
        ...baseValid,
        web_search_options: { search_context_size: 'high' },
      })
    })

    it('accepts functions (deprecated)', () => {
      expectAccept({ ...baseValid, functions: [{ name: 'f' }] })
    })

    it('accepts function_call auto (deprecated)', () => {
      expectAccept({ ...baseValid, function_call: 'auto' })
    })
  })

  // ── 2. Range rejection ─────────────────────────────────────────────────────
  describe('range rejection', () => {
    it('rejects temperature too high', () => {
      expectReject({ ...baseValid, temperature: 3 })
    })

    it('rejects temperature negative', () => {
      expectReject({ ...baseValid, temperature: -1 })
    })

    it('rejects temperature non-number', () => {
      expectReject({ ...baseValid, temperature: 'high' })
    })

    it('rejects top_p > 1', () => {
      expectReject({ ...baseValid, top_p: 1.5 })
    })

    it('rejects top_p negative', () => {
      expectReject({ ...baseValid, top_p: -0.1 })
    })

    it('rejects frequency_penalty too low', () => {
      expectReject({ ...baseValid, frequency_penalty: -3 })
    })

    it('rejects frequency_penalty too high', () => {
      expectReject({ ...baseValid, frequency_penalty: 3 })
    })

    it('rejects presence_penalty too high', () => {
      expectReject({ ...baseValid, presence_penalty: 5 })
    })

    it('rejects n=0', () => {
      expectReject({ ...baseValid, n: 0 })
    })

    it('rejects n negative', () => {
      expectReject({ ...baseValid, n: -1 })
    })

    it('rejects top_logprobs > 20', () => {
      expectReject({ ...baseValid, top_logprobs: 21 })
    })

    it('rejects top_logprobs negative', () => {
      expectReject({ ...baseValid, top_logprobs: -1 })
    })
  })

  // ── 3. Enum rejection ──────────────────────────────────────────────────────
  describe('enum rejection', () => {
    it('rejects service_tier unknown', () => {
      expectReject({ ...baseValid, service_tier: 'gold' })
    })

    it('rejects reasoning_effort unknown', () => {
      expectReject({ ...baseValid, reasoning_effort: 'extreme' })
    })

    it('rejects verbosity unknown', () => {
      expectReject({ ...baseValid, verbosity: 'max' })
    })

    it('rejects response_format unknown type', () => {
      expectReject({ ...baseValid, response_format: { type: 'foo' } })
    })

    it('rejects prompt_cache_retention unknown', () => {
      expectReject({ ...baseValid, prompt_cache_retention: '7d' })
    })

    it('rejects audio.format unknown', () => {
      expectReject({ ...baseValid, audio: { voice: 'alloy', format: 'aac' } })
    })
  })

  // ── 4. Shape rejection ─────────────────────────────────────────────────────
  describe('shape rejection', () => {
    it('rejects response_format json_schema missing json_schema', () => {
      expectReject({ ...baseValid, response_format: { type: 'json_schema' } })
    })

    it('rejects tool_choice function missing function.name', () => {
      expectReject({ ...baseValid, tool_choice: { type: 'function' } })
    })

    it('rejects audio missing format', () => {
      expectReject({ ...baseValid, audio: { voice: 'alloy' } })
    })
  })

  // ── 5. Unknown top-level keys ──────────────────────────────────────────────
  describe('unknown top-level keys', () => {
    it('rejects unknown field foo', () => {
      expectReject({ model: 'x', foo: 'bar' })
    })

    it('rejects bucketBudgets (regression)', () => {
      expectReject({ ...baseValid, bucketBudgets: { memories: 0.5 } })
    })

    it('rejects maxInlineToolResultFraction (regression)', () => {
      expectReject({ ...baseValid, maxInlineToolResultFraction: 0.05 })
    })

    it('rejects trustedTools (regression)', () => {
      expectReject({ ...baseValid, trustedTools: ['qa'] })
    })
  })

  // ── 6. Credentials & required model ────────────────────────────────────────
  describe('credentials and required model', () => {
    it('rejects apiKey non-string', () => {
      expectReject({ ...baseValid, apiKey: 123 })
    })

    it('rejects headers with non-string value', () => {
      expectReject({ ...baseValid, headers: { Authorization: 123 } })
    })

    it('rejects empty options (missing required model)', () => {
      expectReject({})
    })

    it('accepts minimal { model: "x" }', () => {
      expectAccept({ model: 'x' })
    })
  })

  // ── 7. bucketOrder ─────────────────────────────────────────────────────────
  describe('bucketOrder', () => {
    const labels = ['standingInstructions', 'memories', 'retrievables', 'timeline'] as const
    // All 6 permutations
    const permutations: string[][] = [
      ['standingInstructions', 'memories', 'timeline'],
      ['standingInstructions', 'timeline', 'memories'],
      ['memories', 'standingInstructions', 'timeline'],
      ['memories', 'timeline', 'standingInstructions'],
      ['timeline', 'standingInstructions', 'memories'],
      ['timeline', 'memories', 'standingInstructions'],
    ]

    it.each(permutations)('accepts permutation %j', (...perm) => {
      expectAccept({ ...baseValid, bucketOrder: perm })
    })

    it.each([
      [['timeline']],
      [['standingInstructions', 'timeline']],
      [['memories']],
      [['memories', 'timeline']],
      [['standingInstructions']],
      [['timeline', 'memories']],
      [['timeline', 'standingInstructions']],
    ])('accepts subset %j', (subset) => {
      expectAccept({ ...baseValid, bucketOrder: subset })
    })

    it('accepts empty array', () => {
      expectAccept({ ...baseValid, bucketOrder: [] })
    })

    it('rejects duplicates [memories, memories, timeline]', () => {
      expectReject({ ...baseValid, bucketOrder: ['memories', 'memories', 'timeline'] })
    })

    it('rejects duplicates [standingInstructions, standingInstructions]', () => {
      expectReject({
        ...baseValid,
        bucketOrder: ['standingInstructions', 'standingInstructions'],
      })
    })

    it('rejects unknown label thoughts', () => {
      expectReject({
        ...baseValid,
        bucketOrder: ['standingInstructions', 'memories', 'thoughts'],
      })
    })

    it('rejects unknown label tools', () => {
      expectReject({ ...baseValid, bucketOrder: ['tools'] })
    })

    it('accepts the new default order [standingInstructions, memories, retrievables, timeline]', () => {
      expectAccept({
        ...baseValid,
        bucketOrder: ['standingInstructions', 'memories', 'retrievables', 'timeline'],
      })
    })

    it('accepts subset containing only retrievables', () => {
      expectAccept({ ...baseValid, bucketOrder: ['retrievables'] })
    })

    it('rejects duplicate retrievables entries', () => {
      expectReject({ ...baseValid, bucketOrder: ['retrievables', 'retrievables'] })
    })

    it('rejects unknown label rag (regression guard)', () => {
      expectReject({
        ...baseValid,
        bucketOrder: ['standingInstructions', 'memories', 'rag', 'timeline'],
      })
    })

    it('rejects non-array string', () => {
      expectReject({ ...baseValid, bucketOrder: 'standingInstructions' })
    })

    it('rejects non-array object', () => {
      expectReject({ ...baseValid, bucketOrder: {} })
    })

    it('rejects non-array null', () => {
      expectReject({ ...baseValid, bucketOrder: null })
    })

    it('defaults to [standingInstructions, memories, retrievables, timeline] when omitted', () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.bucketOrder).toEqual([...labels])
    })
  })

  // ── 8. selfIdentity ────────────────────────────────────────────────────────
  describe('selfIdentity', () => {
    it("defaults to 'assistant' when omitted", () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.selfIdentity).toBe('assistant')
    })

    it("accepts 'executor_agent'", () => {
      expectAccept({ ...baseValid, selfIdentity: 'executor_agent' })
    })

    it('accepts namespaced identity', () => {
      expectAccept({ ...baseValid, selfIdentity: 'customer:alice@acme.com' })
    })

    it('rejects empty string', () => {
      expectReject({ ...baseValid, selfIdentity: '' })
    })

    it('rejects number', () => {
      expectReject({ ...baseValid, selfIdentity: 123 })
    })

    it('rejects null', () => {
      expectReject({ ...baseValid, selfIdentity: null })
    })
  })

  // ── 9. contextWindow ───────────────────────────────────────────────────────
  // Note: the cross-field invariant (`tokenEncoding` non-null without `contextWindow`)
  // is enforced at the adapter (runtime), not in the schema. That case is covered in
  // adapter.cross.spec.ts.
  describe('contextWindow', () => {
    it('accepts positive integer', () => {
      expectAccept({ ...baseValid, contextWindow: 128_000 })
    })

    it('rejects 0', () => {
      expectReject({ ...baseValid, contextWindow: 0 })
    })

    it('rejects negative', () => {
      expectReject({ ...baseValid, contextWindow: -1 })
    })

    it('rejects non-integer', () => {
      expectReject({ ...baseValid, contextWindow: 128_000.5 })
    })

    it('rejects string', () => {
      expectReject({ ...baseValid, contextWindow: '128k' })
    })

    it('accepts when omitted while tokenEncoding is default (null)', () => {
      expectAccept({ model: 'x' })
    })
  })

  // ── 10. tokenEncoding ──────────────────────────────────────────────────────
  describe('tokenEncoding', () => {
    it('omitted accepts (defaults to null)', () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.tokenEncoding).toBeNull()
    })

    it('explicit null accepts', () => {
      expectAccept({ ...baseValid, tokenEncoding: null })
    })

    it.each([
      'gpt2',
      'r50k_base',
      'p50k_base',
      'p50k_edit',
      'cl100k_base',
      'o200k_base',
      'gemini',
      'llama2',
      'claude',
    ])('accepts %s', (enc) => {
      expectAccept({ ...baseValid, tokenEncoding: enc })
    })

    it('rejects unknown bpe', () => {
      expectReject({ ...baseValid, tokenEncoding: 'bpe' })
    })

    it('rejects unknown tiktoken', () => {
      expectReject({ ...baseValid, tokenEncoding: 'tiktoken' })
    })

    it('rejects number', () => {
      expectReject({ ...baseValid, tokenEncoding: 123 })
    })

    it('rejects boolean', () => {
      expectReject({ ...baseValid, tokenEncoding: true })
    })

    it('rejects object', () => {
      expectReject({ ...baseValid, tokenEncoding: {} })
    })
  })

  // ── 11. streamIdleTimeoutMs ────────────────────────────────────────────────
  describe('streamIdleTimeoutMs', () => {
    it('omitted defaults to 0', () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.streamIdleTimeoutMs).toBe(0)
    })

    it('accepts 0', () => {
      expectAccept({ ...baseValid, streamIdleTimeoutMs: 0 })
    })

    it('accepts 30_000', () => {
      expectAccept({ ...baseValid, streamIdleTimeoutMs: 30_000 })
    })

    it('accepts 120_000', () => {
      expectAccept({ ...baseValid, streamIdleTimeoutMs: 120_000 })
    })

    it('rejects -1', () => {
      expectReject({ ...baseValid, streamIdleTimeoutMs: -1 })
    })

    it('rejects non-integer 200.5', () => {
      expectReject({ ...baseValid, streamIdleTimeoutMs: 200.5 })
    })

    it("rejects string '200ms'", () => {
      expectReject({ ...baseValid, streamIdleTimeoutMs: '200ms' })
    })

    it('rejects boolean true', () => {
      expectReject({ ...baseValid, streamIdleTimeoutMs: true })
    })
  })

  // ── 12. requestTimeoutMs ───────────────────────────────────────────────────
  describe('requestTimeoutMs', () => {
    it('omitted defaults to 0', () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.requestTimeoutMs).toBe(0)
    })

    it('accepts 0', () => {
      expectAccept({ ...baseValid, requestTimeoutMs: 0 })
    })

    it('accepts 30_000', () => {
      expectAccept({ ...baseValid, requestTimeoutMs: 30_000 })
    })

    it('accepts 120_000', () => {
      expectAccept({ ...baseValid, requestTimeoutMs: 120_000 })
    })

    it('rejects -1', () => {
      expectReject({ ...baseValid, requestTimeoutMs: -1 })
    })

    it('rejects non-integer 200.5', () => {
      expectReject({ ...baseValid, requestTimeoutMs: 200.5 })
    })

    it("rejects string '200ms'", () => {
      expectReject({ ...baseValid, requestTimeoutMs: '200ms' })
    })

    it('rejects boolean true', () => {
      expectReject({ ...baseValid, requestTimeoutMs: true })
    })
  })

  // ── 13. retry ──────────────────────────────────────────────────────────────
  describe('retry', () => {
    it('omitted accepts', () => {
      expectAccept({ ...baseValid })
    })

    it('empty object accepts', () => {
      expectAccept({ ...baseValid, retry: {} })
    })

    it('partial { maxAttempts: 3 } accepts', () => {
      expectAccept({ ...baseValid, retry: { maxAttempts: 3 } })
    })

    it('rejects maxAttempts 0', () => {
      expectReject({ ...baseValid, retry: { maxAttempts: 0 } })
    })

    it('rejects maxAttempts 1.5', () => {
      expectReject({ ...baseValid, retry: { maxAttempts: 1.5 } })
    })

    it('rejects baseDelayMs -1', () => {
      expectReject({ ...baseValid, retry: { baseDelayMs: -1 } })
    })

    it('rejects maxDelayMs 0', () => {
      expectReject({ ...baseValid, retry: { maxDelayMs: 0 } })
    })

    it('accepts retriableStatuses [429, 503]', () => {
      expectAccept({ ...baseValid, retry: { retriableStatuses: [429, 503] } })
    })

    it("rejects retriableStatuses ['429'] (string in array)", () => {
      expectReject({ ...baseValid, retry: { retriableStatuses: ['429'] } })
    })

    it('rejects retriableStatuses [600] (above 599)', () => {
      expectReject({ ...baseValid, retry: { retriableStatuses: [600] } })
    })

    it('rejects retriableStatuses [99] (below 100)', () => {
      expectReject({ ...baseValid, retry: { retriableStatuses: [99] } })
    })

    it("rejects honorRetryAfter 'yes'", () => {
      expectReject({ ...baseValid, retry: { honorRetryAfter: 'yes' } })
    })

    it('rejects unknown nested key', () => {
      expectReject({ ...baseValid, retry: { foo: 1 } })
    })

    it('rejects non-object retry value', () => {
      expectReject({ ...baseValid, retry: 3 })
    })
  })

  // ── 14. helpers ────────────────────────────────────────────────────────────
  describe('helpers', () => {
    it('omitted accepts', () => {
      expectAccept({ ...baseValid })
    })

    it('helpers: {} accepts', () => {
      expectAccept({ ...baseValid, helpers: {} })
    })

    it('helpers with valid function accepts', () => {
      expectAccept({
        ...baseValid,
        helpers: { renderUntrustedContent: () => '' },
      })
    })

    it('rejects non-function helper value', () => {
      expectReject({
        ...baseValid,
        helpers: { renderUntrustedContent: 'not a function' },
      })
    })

    it('rejects unknown helper subkey', () => {
      expectReject({
        ...baseValid,
        helpers: { unknownHelper: () => {} },
      })
    })
  })

  // ── 15. thoughtSurfacing ───────────────────────────────────────────────────
  describe('thoughtSurfacing', () => {
    it("omitted defaults to 'all-self'", () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.thoughtSurfacing).toBe('all-self')
    })

    it.each(['all-self', 'latest-self', 'all'])('accepts %s', (mode) => {
      expectAccept({ ...baseValid, thoughtSurfacing: mode })
    })

    it("rejects 'everything'", () => {
      expectReject({ ...baseValid, thoughtSurfacing: 'everything' })
    })

    it('rejects 123', () => {
      expectReject({ ...baseValid, thoughtSurfacing: 123 })
    })
  })

  // ── 16. replayCompatibility ────────────────────────────────────────────────
  describe('replayCompatibility', () => {
    it('omitted defaults to []', () => {
      const resolved = validateOptions({ model: 'x' })
      expect(resolved.replayCompatibility).toEqual([])
    })

    it('[] accepts', () => {
      expectAccept({ ...baseValid, replayCompatibility: [] })
    })

    it("['anthropic-thinking-v1'] accepts", () => {
      expectAccept({ ...baseValid, replayCompatibility: ['anthropic-thinking-v1'] })
    })

    it('rejects string (not array)', () => {
      expectReject({ ...baseValid, replayCompatibility: 'anthropic-thinking-v1' })
    })

    it("rejects [''] (empty string item)", () => {
      expectReject({ ...baseValid, replayCompatibility: [''] })
    })

    it('rejects [123] (non-string item)', () => {
      expectReject({ ...baseValid, replayCompatibility: [123] })
    })
  })

  // ── 17. Validator report attached to thrown exception ─────────────────────
  describe('exception payload', () => {
    it('carries the underlying ValidationError on cause for an invalid temperature', () => {
      let thrown: unknown
      try {
        validateOptions({ ...baseValid, temperature: 3 })
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS)
      const err = thrown as Error & { cause?: unknown }
      // The validator's report is attached via `cause`. The message should mention temperature.
      expect(err.message).toMatch(/temperature/i)
      expect(err.cause).toBeDefined()
      const cause = err.cause as { details?: Array<{ message: string }> }
      expect(Array.isArray(cause.details)).toBe(true)
    })
  })

  // ── 18. Static STASH_KEY ─────────────────────────────────────────────
  describe('OpenAIChatCompletionsAdapter.STASH_KEY', () => {
    it("equals 'openaiChatCompletions'", () => {
      expect(OpenAIChatCompletionsAdapter.STASH_KEY).toBe('openaiChatCompletions')
    })
  })
})
