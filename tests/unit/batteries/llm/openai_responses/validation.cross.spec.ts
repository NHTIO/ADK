/**
 * Validation coverage for the OpenAI Responses battery: schema accept/reject; `.unknown(false)`
 * rejects `previous_response_id`/`conversation`/`prompt`/`context_management`/`instructions`/
 * `store`; `max_output_tokens` min 16; `tokenEncoding`↔`contextWindow` cross-field invariant (at the
 * adapter, per the same convention as the sibling batteries); three-layer merge precedence.
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { cassetteFetch } from '../../../../_fixtures/cassette'
import { singleResponsesResponseCassette } from '../../../../_fixtures/cassette'
import { Tokenizable, Message, ToolRegistry, Registry } from '@nhtio/adk/common'
import {
  validateOptions,
  openAIResponsesOptionsSchema,
  E_INVALID_OPENAI_RESPONSES_OPTIONS,
  OpenAIResponsesAdapter,
} from '@nhtio/adk/batteries/llm/openai_responses'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const baseValid = { model: 'gpt-x-responses' }

const expectAccept = (input: unknown) => expect(() => validateOptions(input)).not.toThrow()

const expectReject = (input: unknown) => {
  let thrown: unknown
  try {
    validateOptions(input)
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(E_INVALID_OPENAI_RESPONSES_OPTIONS)
}

describe('OpenAI Responses option validation', () => {
  describe('schema is exported', () => {
    it('exports the schema object', () => {
      expect(openAIResponsesOptionsSchema).toBeDefined()
      expect(typeof openAIResponsesOptionsSchema.validate).toBe('function')
    })
  })

  // ── model (required) ──────────────────────────────────────────────────────
  describe('model', () => {
    it('accepts minimal valid options', () => {
      expectAccept(baseValid)
    })

    it('rejects when omitted', () => {
      expectReject({})
    })

    it('rejects empty string', () => {
      expectReject({ model: '' })
    })

    it('rejects non-string', () => {
      expectReject({ model: 123 })
    })
  })

  // ── server-side-conversation-state keys: hard-rejected, ADK owns history ───
  describe('.unknown(false) rejects server-side conversation-state keys', () => {
    it('rejects previous_response_id', () => {
      expectReject({ ...baseValid, previous_response_id: 'resp_123' })
    })

    it('rejects conversation', () => {
      expectReject({ ...baseValid, conversation: 'conv_123' })
    })

    it('rejects prompt', () => {
      expectReject({ ...baseValid, prompt: { id: 'pmpt_123' } })
    })

    it('rejects context_management', () => {
      expectReject({ ...baseValid, context_management: { strategy: 'auto' } })
    })
  })

  // ── instructions/store: hard-rejected, adapter-owned, NOT settable options ─
  describe('.unknown(false) rejects instructions/store — both are exclusively adapter-owned', () => {
    it('rejects an explicit instructions string', () => {
      expectReject({ ...baseValid, instructions: 'you are a helpful assistant' })
    })

    it('rejects store:true', () => {
      expectReject({ ...baseValid, store: true })
    })

    it('rejects store:false too — there is no settable `store` key at all', () => {
      expectReject({ ...baseValid, store: false })
    })
  })

  describe('background — no polling/resumption logic exists, so true is rejected', () => {
    it('rejects background:true', () => {
      expectReject({ ...baseValid, background: true })
    })

    it('accepts background:false', () => {
      expectAccept({ ...baseValid, background: false })
    })

    it('accepts omission', () => {
      expectAccept(baseValid)
    })
  })

  describe('other unknown top-level keys still fail loud', () => {
    it('rejects an arbitrary unknown key (typo protection)', () => {
      expectReject({ ...baseValid, modle: 'typo' })
    })
  })

  // ── max_output_tokens: undocumented API minimum of 16 ──────────────────────
  describe('max_output_tokens', () => {
    it('accepts 16 (the documented minimum)', () => {
      expectAccept({ ...baseValid, max_output_tokens: 16 })
    })

    it('accepts a large value', () => {
      expectAccept({ ...baseValid, max_output_tokens: 128_000 })
    })

    it('rejects 15 (one below the undocumented API minimum)', () => {
      expectReject({ ...baseValid, max_output_tokens: 15 })
    })

    it('rejects 0', () => {
      expectReject({ ...baseValid, max_output_tokens: 0 })
    })

    it('rejects negative', () => {
      expectReject({ ...baseValid, max_output_tokens: -5 })
    })

    it('rejects non-integer', () => {
      expectReject({ ...baseValid, max_output_tokens: 16.5 })
    })

    it('accepts omission', () => {
      expectAccept(baseValid)
    })
  })

  // ── systemPromptChannel ──────────────────────────────────────────────────────
  describe('systemPromptChannel', () => {
    it("defaults to 'instructions'", () => {
      const resolved = validateOptions(baseValid)
      expect(resolved.systemPromptChannel).toBe('instructions')
    })

    it.each(['instructions', 'developer-item', 'system-item'])('accepts %s', (v) => {
      expectAccept({ ...baseValid, systemPromptChannel: v })
    })

    it('rejects an unknown channel', () => {
      expectReject({ ...baseValid, systemPromptChannel: 'user-item' })
    })
  })

  // ── reasoningReplay ──────────────────────────────────────────────────────────
  describe('reasoningReplay', () => {
    it("defaults to 'off'", () => {
      const resolved = validateOptions(baseValid)
      expect(resolved.reasoningReplay).toBe('off')
    })

    it.each(['off', 'encrypted', 'summary-only'])('accepts %s', (v) => {
      expectAccept({ ...baseValid, reasoningReplay: v })
    })

    it('rejects an unknown mode', () => {
      expectReject({ ...baseValid, reasoningReplay: 'always' })
    })
  })

  // ── include ──────────────────────────────────────────────────────────────────
  describe('include', () => {
    it('accepts a known includable', () => {
      expectAccept({ ...baseValid, include: ['reasoning.encrypted_content'] })
    })

    it('accepts an arbitrary non-empty string (open string union)', () => {
      expectAccept({ ...baseValid, include: ['message.output_text.logprobs'] })
    })

    it('rejects an empty string element', () => {
      expectReject({ ...baseValid, include: [''] })
    })
  })

  // ── reasoning ────────────────────────────────────────────────────────────────
  describe('reasoning', () => {
    it('accepts effort + summary', () => {
      expectAccept({ ...baseValid, reasoning: { effort: 'medium', summary: 'concise' } })
    })

    it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])(
      'accepts effort %s',
      (effort) => {
        expectAccept({ ...baseValid, reasoning: { effort } })
      }
    )

    it('rejects an unknown effort', () => {
      expectReject({ ...baseValid, reasoning: { effort: 'extreme' } })
    })

    it('rejects an unknown key inside reasoning', () => {
      expectReject({ ...baseValid, reasoning: { budget_tokens: 1024 } })
    })
  })

  // ── tool_choice ──────────────────────────────────────────────────────────────
  describe('tool_choice', () => {
    it.each(['none', 'auto', 'required'])('accepts string variant %s', (v) => {
      expectAccept({ ...baseValid, tool_choice: v })
    })

    it('accepts the function-forcing object variant', () => {
      expectAccept({ ...baseValid, tool_choice: { type: 'function', name: 'my_tool' } })
    })

    it('rejects an unknown string', () => {
      expectReject({ ...baseValid, tool_choice: 'forced' })
    })

    it('rejects the function variant missing name', () => {
      expectReject({ ...baseValid, tool_choice: { type: 'function' } })
    })
  })

  // ── truncation / service_tier / prompt_cache_retention ──────────────────────
  describe('truncation', () => {
    it.each(['auto', 'disabled'])('accepts %s', (v) => {
      expectAccept({ ...baseValid, truncation: v })
    })
    it('rejects unknown', () => {
      expectReject({ ...baseValid, truncation: 'sometimes' })
    })
  })

  describe('service_tier', () => {
    it.each(['auto', 'default', 'flex', 'scale', 'priority'])('accepts %s', (v) => {
      expectAccept({ ...baseValid, service_tier: v })
    })
    it('rejects unknown', () => {
      expectReject({ ...baseValid, service_tier: 'ultra' })
    })
  })

  describe('prompt_cache_retention', () => {
    it.each(['in_memory', '24h'])('accepts %s', (v) => {
      expectAccept({ ...baseValid, prompt_cache_retention: v })
    })
    it('rejects unknown', () => {
      expectReject({ ...baseValid, prompt_cache_retention: '7d' })
    })
  })

  // ── text ──────────────────────────────────────────────────────────────────────
  describe('text', () => {
    it('accepts format + verbosity', () => {
      expectAccept({ ...baseValid, text: { format: { type: 'json_object' }, verbosity: 'low' } })
    })
    it('rejects an unknown top-level key', () => {
      expectReject({ ...baseValid, text: { format: {}, extra: true } })
    })
  })

  // ── numeric bounds ───────────────────────────────────────────────────────────
  describe('temperature / top_p / top_logprobs', () => {
    it('accepts temperature within [0,2]', () => {
      expectAccept({ ...baseValid, temperature: 1.5 })
    })
    it('rejects temperature above 2', () => {
      expectReject({ ...baseValid, temperature: 2.1 })
    })
    it('rejects temperature below 0', () => {
      expectReject({ ...baseValid, temperature: -0.1 })
    })
    it('accepts top_p within [0,1]', () => {
      expectAccept({ ...baseValid, top_p: 0.9 })
    })
    it('rejects top_p above 1', () => {
      expectReject({ ...baseValid, top_p: 1.1 })
    })
    it('accepts top_logprobs within [0,20]', () => {
      expectAccept({ ...baseValid, top_logprobs: 20 })
    })
    it('rejects top_logprobs above 20', () => {
      expectReject({ ...baseValid, top_logprobs: 21 })
    })
  })

  // ── bucketOrder ───────────────────────────────────────────────────────────────
  describe('bucketOrder', () => {
    const labels = ['standingInstructions', 'memories', 'retrievables', 'timeline']

    it('defaults to the full label set when omitted', () => {
      const resolved = validateOptions(baseValid)
      expect(resolved.bucketOrder).toEqual(labels)
    })

    it('accepts a subset', () => {
      expectAccept({ ...baseValid, bucketOrder: ['timeline'] })
    })

    it('rejects duplicate entries', () => {
      expectReject({ ...baseValid, bucketOrder: ['timeline', 'timeline'] })
    })

    it('rejects an unknown label', () => {
      expectReject({ ...baseValid, bucketOrder: ['rag'] })
    })
  })

  // ── tokenEncoding ↔ contextWindow (schema-level acceptance; adapter enforces the invariant) ──
  describe('tokenEncoding / contextWindow (schema level)', () => {
    it('tokenEncoding omitted defaults to null', () => {
      const resolved = validateOptions(baseValid)
      expect(resolved.tokenEncoding).toBeNull()
    })

    it('accepts a valid tokenEncoding string', () => {
      expectAccept({ ...baseValid, tokenEncoding: 'cl100k_base', contextWindow: 128_000 })
    })

    it('rejects an unknown encoding string', () => {
      expectReject({ ...baseValid, tokenEncoding: 'bpe' })
    })

    it('schema alone accepts tokenEncoding set WITHOUT contextWindow (the adapter enforces this cross-field invariant, not the schema)', () => {
      expectAccept({ ...baseValid, tokenEncoding: 'cl100k_base' })
    })
  })

  // ── strict ─────────────────────────────────────────────────────────────────────
  describe('strict', () => {
    it('accepts toolCallIdFilter', () => {
      expectAccept({ ...baseValid, toolCallIdFilter: () => 'filtered' })
    })

    it('accepts true/false', () => {
      expectAccept({ ...baseValid, strict: true })
      expectAccept({ ...baseValid, strict: false })
    })
    it('is undefined by default', () => {
      const resolved = validateOptions(baseValid)
      expect(resolved.strict).toBeUndefined()
    })
  })
})

// ─── Cross-field invariant enforced at the ADAPTER (not the schema) ────────────

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

interface MockCtx extends DispatchContext {
  _stored: { messages: Message[] }
}

const makeCtx = (): MockCtx => {
  const stored = { messages: [] as Message[] }
  return {
    systemPrompt: new Tokenizable('sys'),
    turnMessages: new Set([
      new Message({
        id: 'u1',
        role: 'user',
        content: 'hi',
        createdAt: dt('2026-01-01T00:00:00Z'),
        updatedAt: dt('2026-01-01T00:00:00Z'),
      }),
    ]),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: new ToolRegistry([]),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn((_h: () => void) => () => undefined),
    emitToolExecutionStart: vi.fn(),
    emitToolExecutionEnd: vi.fn(),
    emitMessage: vi.fn(),
    emitThought: vi.fn(),
    emitToolCall: vi.fn(),
    storeMessage: vi.fn(async (m: Message) => {
      stored.messages.push(m)
    }),
    storeThought: vi.fn(async () => {}),
    storeToolCall: vi.fn(async () => {}),
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as MockCtx
}

const makeHelpers = (): DispatchExecutorHelpers => {
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn(),
  } as unknown as DispatchExecutorHelpers
}

describe('OpenAIResponsesAdapter — tokenEncoding non-null requires contextWindow (cross-field, adapter-enforced)', () => {
  it('throws E_INVALID_OPENAI_RESPONSES_OPTIONS at iteration time when tokenEncoding is set without contextWindow', async () => {
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      tokenEncoding: 'cl100k_base',
      fetch: vi.fn() as never,
      stream: false,
    })
    const ctx = makeCtx()
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toBeInstanceOf(
      E_INVALID_OPENAI_RESPONSES_OPTIONS
    )
  })

  it('does not throw when both are set', async () => {
    const cassette = singleResponsesResponseCassette('both-set', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      tokenEncoding: 'cl100k_base',
      contextWindow: 128_000,
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('does not throw when tokenEncoding is null (default) regardless of contextWindow', async () => {
    const cassette = singleResponsesResponseCassette('null-encoding', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })
})

// ─── Three-layer merge precedence: stash > executor > constructor ─────────────

describe('OpenAIResponsesAdapter — three-layer option merge precedence', () => {
  it('stash wins over executor wins over ctor for model', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(
        JSON.stringify({ id: 'r', object: 'response', status: 'completed', output: [] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'ctor-model',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    ;(ctx.stash as Registry).set('openaiResponses', { model: 'stash-model' })
    await adapter.executor({ model: 'executor-model' })(ctx, makeHelpers())
    expect(bodies[0]!.model).toBe('stash-model')
  })

  it('executor wins over ctor when stash does not override', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(
        JSON.stringify({ id: 'r', object: 'response', status: 'completed', output: [] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'ctor-model',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor({ model: 'executor-model' })(ctx, makeHelpers())
    expect(bodies[0]!.model).toBe('executor-model')
  })

  it('headers merge key-by-key across all three layers, stash winning conflicts', async () => {
    let capturedHeaders: Headers | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit)
      return new Response(
        JSON.stringify({ id: 'r', object: 'response', status: 'completed', output: [] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      headers: { 'X-Ctor': 'ctor', 'X-Shared': 'ctor-value' },
    })
    const ctx = makeCtx()
    ;(ctx.stash as Registry).set('openaiResponses', {
      headers: { 'X-Stash': 'stash', 'X-Shared': 'stash-value' },
    })
    await adapter.executor({ headers: { 'X-Executor': 'executor' } })(ctx, makeHelpers())
    expect(capturedHeaders?.get('X-Ctor')).toBe('ctor')
    expect(capturedHeaders?.get('X-Executor')).toBe('executor')
    expect(capturedHeaders?.get('X-Stash')).toBe('stash')
    expect(capturedHeaders?.get('X-Shared')).toBe('stash-value')
  })

  it('an invalid stash override throws before any fetch call', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }))
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    ;(ctx.stash as Registry).set('openaiResponses', { max_output_tokens: 1 })
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toBeInstanceOf(
      E_INVALID_OPENAI_RESPONSES_OPTIONS
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('an invalid executor override throws before any fetch call', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }))
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    await expect(
      adapter.executor({ max_output_tokens: 1 })(ctx, makeHelpers())
    ).rejects.toBeInstanceOf(E_INVALID_OPENAI_RESPONSES_OPTIONS)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
