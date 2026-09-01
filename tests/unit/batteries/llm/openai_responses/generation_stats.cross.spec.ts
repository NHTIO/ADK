/**
 * Generation-stats coverage for the OpenAI Responses adapter:
 *   - `cached_tokens` subtraction: `promptTokens = max(0, usage.input_tokens - cached_tokens)`
 *   - `rawStopReason` composite: `status` + `incomplete_details.reason` mapping into `finishReason`
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { cassetteFetch } from '../../../../_fixtures/cassette'
import { Tokenizable, Message, ToolRegistry, Registry } from '@nhtio/adk/common'
import { OpenAIResponsesAdapter } from '@nhtio/adk/batteries/llm/openai_responses'
import {
  buildResponsesResponse,
  singleResponsesResponseCassette,
  singleResponsesStreamCassette,
} from '../../../../_fixtures/cassette'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const makeCtx = (): DispatchContext => {
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
    storeMessage: vi.fn(async () => {}),
    storeThought: vi.fn(async () => {}),
    storeToolCall: vi.fn(async () => {}),
    mutateToolCall: vi.fn(async () => {}),
  } as unknown as DispatchContext
}

const makeHelpers = (): DispatchExecutorHelpers & { _stats: Array<Record<string, unknown>> } => {
  const stats: Array<Record<string, unknown>> = []
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => stats.push(s)),
    _stats: stats,
  } as unknown as DispatchExecutorHelpers & { _stats: typeof stats }
}

describe('OpenAIResponsesAdapter — generation stats: cached_tokens subtraction', () => {
  it('non-streaming: promptTokens = input_tokens - cached_tokens', async () => {
    const cassette = singleResponsesResponseCassette('cached', {
      content: 'hi',
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_tokens: 30 },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.promptTokens).toBe(70)
    expect(helpers._stats[0]!.completionTokens).toBe(20)
    expect(helpers._stats[0]!.totalTokens).toBe(120)
  })

  it('non-streaming: no cached_tokens present → promptTokens = input_tokens unchanged', async () => {
    const cassette = singleResponsesResponseCassette('no-cache', {
      content: 'hi',
      usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.promptTokens).toBe(50)
  })

  it('clamps at 0 rather than going negative if cached_tokens somehow exceeds input_tokens', async () => {
    const cassette = singleResponsesResponseCassette('over-cached', {
      content: 'hi',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_tokens: 999 },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.promptTokens).toBe(0)
  })

  it('streaming: promptTokens = input_tokens - cached_tokens off the terminal event usage', async () => {
    const cassette = singleResponsesStreamCassette('cached-stream', {
      steps: [{ kind: 'text', deltas: ['hi'] }],
      usage: { input_tokens: 80, output_tokens: 15, total_tokens: 95, cached_tokens: 20 },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.promptTokens).toBe(60)
  })
})

describe('OpenAIResponsesAdapter — generation stats: rawStopReason composite (status + incomplete_details.reason)', () => {
  it('status "completed" with no tool calls → finishReason "stop"', async () => {
    const cassette = singleResponsesResponseCassette('stop', {
      content: 'done',
      status: 'completed',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.finishReason).toBe('stop')
  })

  it('status "completed" with tool calls → finishReason "tool_calls"', async () => {
    const cassette = singleResponsesResponseCassette('tool-calls-finish', {
      status: 'completed',
      toolCalls: [{ callId: 'c1', name: 't', arguments: {} }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.finishReason).toBe('tool_calls')
  })

  it('status "incomplete" + reason "max_output_tokens" → finishReason "length"', async () => {
    const cassette = singleResponsesResponseCassette('length', {
      content: 'trunc',
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.finishReason).toBe('length')
  })

  it('status "incomplete" + reason "content_filter" → finishReason "content_filter"', async () => {
    const cassette = singleResponsesResponseCassette('cf', {
      content: 'flagged',
      status: 'incomplete',
      incompleteReason: 'content_filter',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.finishReason).toBe('content_filter')
  })

  it('status "incomplete" with no reason still maps to "length" (default incomplete → length)', async () => {
    const cassette = singleResponsesResponseCassette('incomplete-noreason', {
      content: 'x',
      status: 'incomplete',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.finishReason).toBe('length')
  })

  it('raw carries the full response object payload', async () => {
    const cassette = singleResponsesResponseCassette('raw-payload', {
      id: 'resp-raw-1',
      content: 'hi',
      status: 'completed',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const raw = helpers._stats[0]!.raw as Record<string, unknown>
    expect(raw.id).toBe('resp-raw-1')
    expect(raw.status).toBe('completed')
  })

  it('provider field is always "openai_responses"', async () => {
    const cassette = singleResponsesResponseCassette('provider-field', {
      content: 'hi',
      model: 'my-model',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'my-model',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.provider).toBe('openai_responses')
    expect(helpers._stats[0]!.model).toBe('my-model')
  })

  it('falls back to the REQUESTED model when the response body omits its own model field', async () => {
    const body = {
      id: 'r',
      object: 'response',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const cassette = {
      name: 'no-model-echo',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'fallback-model',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.model).toBe('fallback-model')
  })

  it('does not report generationStats when usage AND status are both absent', async () => {
    const body = { id: 'r', object: 'response', output: [] }
    const cassette = {
      name: 'no-stats',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats).toHaveLength(0)
  })

  it('streaming: reports generationStats once, off the terminal event only', async () => {
    const cassette = singleResponsesStreamCassette('stream-once', {
      steps: [{ kind: 'text', deltas: ['a', 'b'] }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats).toHaveLength(1)
  })
})

describe('OpenAIResponsesAdapter — generation stats: model field reflects the response object, falling back to the request model', () => {
  it('uses the response body model when present', async () => {
    const body = buildResponsesResponse({ content: 'hi', model: 'server-echoed-model' })
    const cassette = {
      name: 'model-echo',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'requested-model',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.model).toBe('server-echoed-model')
  })
})
