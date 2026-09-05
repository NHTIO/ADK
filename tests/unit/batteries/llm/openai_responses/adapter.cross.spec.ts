/**
 * Adapter-level end-to-end coverage for the OpenAI Responses battery: happy paths for both stream
 * modes; retry/timeout/stall; abort mid-stream; EOF-without-terminal-event; `response.failed`;
 * `response.incomplete` + truncation; refusal-as-text; unknown output-item types create no slot.
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { cassetteFetch } from '../../../../_fixtures/cassette'
import { Tokenizable, Message, Tool, ToolCall, ToolRegistry, Registry } from '@nhtio/adk/common'
import {
  buildResponsesResponse,
  buildResponsesStreamFrames,
  singleResponsesResponseCassette,
  singleResponsesStreamCassette,
} from '../../../../_fixtures/cassette'
import {
  OpenAIResponsesAdapter,
  E_OPENAI_RESPONSES_HTTP_ERROR,
  E_OPENAI_RESPONSES_STREAM_ERROR,
  E_OPENAI_RESPONSES_STREAM_STALLED,
  E_OPENAI_RESPONSES_REQUEST_TIMEOUT,
  E_INVALID_OPENAI_RESPONSES_OPTIONS,
  E_OPENAI_RESPONSES_CONTEXT_OVERFLOW,
  deCollideOpenAIResponsesToolCallIds,
} from '@nhtio/adk/batteries/llm/openai_responses'
import type { Thought } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { SSEFrame } from '../../../../_fixtures/cassette'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}
interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (
  overrides: { abortSignal?: AbortSignal; tools?: ToolRegistry; toolCalls?: ToolCall[] } = {}
): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
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
    turnToolCalls: new Set(overrides.toolCalls ?? []),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: overrides.tools ?? new ToolRegistry([]),
    stash: new Registry({}),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
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
    storeThought: vi.fn(async (t: Thought) => {
      stored.thoughts.push(t)
    }),
    storeToolCall: vi.fn(async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
    }),
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as MockCtx
}

const makeHelpers = (): DispatchExecutorHelpers & {
  _events: Array<{ kind: string; id: string; payload: unknown }>
  _stats: Array<Record<string, unknown>>
} => {
  const events: Array<{ kind: string; id: string; payload: unknown }> = []
  const stats: Array<Record<string, unknown>> = []
  const noop = vi.fn()
  return {
    reportMessage: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) => {
      events.push({ kind: 'message', id, payload: { delta, ...(opts ?? {}) } })
    }),
    reportThought: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) => {
      events.push({ kind: 'thought', id, payload: { delta, ...(opts ?? {}) } })
    }),
    reportToolCall: vi.fn((id: string, partial: unknown) => {
      events.push({ kind: 'toolCall', id, payload: partial })
    }),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => stats.push(s)),
    _events: events,
    _stats: stats,
  } as unknown as DispatchExecutorHelpers & { _events: typeof events; _stats: typeof stats }
}

describe('OpenAIResponsesAdapter — static surface', () => {
  it('exposes STASH_KEY === "openaiResponses"', () => {
    expect(OpenAIResponsesAdapter.STASH_KEY).toBe('openaiResponses')
  })

  it('isOpenAIResponsesAdapter recognises instances', () => {
    const adapter = new OpenAIResponsesAdapter({ model: 'm' })
    expect(OpenAIResponsesAdapter.isOpenAIResponsesAdapter(adapter)).toBe(true)
    expect(OpenAIResponsesAdapter.isOpenAIResponsesAdapter({})).toBe(false)
  })

  it('throws E_INVALID_OPENAI_RESPONSES_OPTIONS at construction on bad options', () => {
    expect(() => new OpenAIResponsesAdapter({})).toThrow(E_INVALID_OPENAI_RESPONSES_OPTIONS)
  })
})

describe('OpenAIResponsesAdapter — happy paths (both stream modes)', () => {
  it('non-streaming: persists message, reports generation stats, acks', async () => {
    const cassette = singleResponsesResponseCassette('ns-happy', {
      content: 'hello there',
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
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
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('hello there')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._stats).toHaveLength(1)
    expect(helpers._stats[0]!.promptTokens).toBe(12)
    expect(helpers._stats[0]!.completionTokens).toBe(4)
    expect(helpers._stats[0]!.finishReason).toBe('stop')
    expect(helpers._stats[0]!.provider).toBe('openai_responses')
  })

  it('streaming: persists message, reports generation stats, acks', async () => {
    const cassette = singleResponsesStreamCassette('s-happy', {
      steps: [{ kind: 'text', deltas: ['hel', 'lo!'] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
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
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('hello!')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._stats).toHaveLength(1)
    expect(helpers._stats[0]!.completionTokens).toBe(3)
  })

  it('non-streaming tool-call response applies the ingress filter to a bare provider id', async () => {
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'function_call', call_id: 'call-filter', name: 'my_tool', arguments: '{}' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      toolCallIdFilter: (id: string) => `filtered-${id}`,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls[0]!.id).toBe('filtered-call-filter')
  })

  it('a colliding composite ingress id is de-collided without losing its fc_ item id', async () => {
    const tools = new ToolRegistry([
      new Tool({
        name: 'my_tool',
        description: 'test tool',
        inputSchema: validator.object({}).unknown(true),
        handler: async () => 'ok',
      }),
    ])
    const existing = new ToolCall({
      id: 'call-collision|fc_item',
      tool: 'my_tool',
      args: {},
      checksum: 'existing',
      isComplete: true,
      isError: false,
      results: new Tokenizable('existing'),
      createdAt: dt('2026-01-01T00:01:00Z'),
      updatedAt: dt('2026-01-01T00:01:00Z'),
      completedAt: dt('2026-01-01T00:01:00Z'),
    })
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call-collision',
              id: 'fc_item',
              name: 'my_tool',
              arguments: '{}',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      toolCallIdFilter: (id: string, context: DispatchContext) =>
        deCollideOpenAIResponsesToolCallIds(id, context),
    })
    const ctx = makeCtx({ tools, toolCalls: [existing] })
    await adapter.executor()(ctx, makeHelpers())

    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.id).toMatch(/^[0-9a-f-]{36}\|fc_item$/)
  })

  it('streaming ingress filter preserves the fc item half of a composite id', async () => {
    const cassette = singleResponsesStreamCassette('s-filter', {
      steps: [
        {
          kind: 'toolCall',
          callId: 'call-filter',
          itemId: 'fc-item',
          name: 'my_tool',
          argumentsDone: JSON.stringify({ x: 1 }),
        },
      ],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      toolCallIdFilter: (id: string) => id.replace('call-filter', 'filtered-call'),
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls[0]!.id).toBe('filtered-call|fc-item')
  })

  it('non-streaming tool-call response: no ack, one ToolCall persisted', async () => {
    const cassette = singleResponsesResponseCassette('ns-toolcall', {
      toolCalls: [{ callId: 'call-1', name: 'my_tool', arguments: { x: 1 } }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.tool).toBe('my_tool')
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ x: 1 })
    // No filter is configured: the adapter's real merge/validation/executor path preserves ingress ids.
    expect(ctx._stored.toolCalls[0]!.id).toMatch(/^call-1\|fc-/)
  })
})

describe('OpenAIResponsesAdapter — HTTP error mapping + retry', () => {
  it('retry disabled by default → single fetch on 503', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 503 }))
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_HTTP_ERROR))
  })

  it('retry succeeds on second attempt', async () => {
    let call = 0
    const fetchFn = vi.fn(async () => {
      call += 1
      if (call === 1) return new Response('busy', { status: 503 })
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('ok')
  })

  it('retry exhausts and nacks', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 503 }))
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_HTTP_ERROR))
  })

  it('non-retriable status (400) is not retried', async () => {
    const fetchFn = vi.fn(async () => new Response('bad request', { status: 400 }))
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_HTTP_ERROR))
  })

  it('honors Retry-After in seconds', async () => {
    let call = 0
    const fetchFn = vi.fn(async () => {
      call += 1
      if (call === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '0' } })
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 5000 },
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
  })
})

describe('OpenAIResponsesAdapter — request-timeout', () => {
  it('fires before headers arrive → nacks REQUEST_TIMEOUT', async () => {
    const fetchFn = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      requestTimeoutMs: 30,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_REQUEST_TIMEOUT))
  })
})

describe('OpenAIResponsesAdapter — stream idle-timeout watchdog', () => {
  it('disabled by default — long gaps OK', async () => {
    // Insert a delay frame before the terminal event to simulate a long gap with no watchdog set.
    const allFrames = buildResponsesStreamFrames({ steps: [{ kind: 'text', deltas: ['hi'] }] })
    const withDelay: SSEFrame[] = [
      ...allFrames.slice(0, -1),
      { delayMs: 250 },
      ...allFrames.slice(-1),
    ]
    const cassette = {
      name: 'no-watchdog',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: withDelay } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('fires on inactivity → nacks STREAM_STALLED', async () => {
    const streamFrames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['partial'] }],
      omitTerminal: true,
    })
    const withStall: SSEFrame[] = [...streamFrames, { delayMs: 500 }]
    const cassette = {
      name: 'stall',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: withStall } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      streamIdleTimeoutMs: 100,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_STREAM_STALLED))
  })

  it('ignored in non-streaming mode', async () => {
    const cassette = singleResponsesResponseCassette('ns-ignore-idle', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      streamIdleTimeoutMs: 50,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })
})

describe('OpenAIResponsesAdapter — abort handling', () => {
  it('mid-stream abort: cancels reader, no STREAM_ERROR/STREAM_STALLED nack', async () => {
    const controller = new AbortController()
    const streamFrames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['a'] }],
      omitTerminal: true,
    })
    const withDelay: SSEFrame[] = [...streamFrames, { delayMs: 200 }]
    const cassette = {
      name: 'abort-mid',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: withDelay } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx({ abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })
})

describe('OpenAIResponsesAdapter — EOF without a terminal event', () => {
  it('drains accumulated state and nacks NEITHER a hard failure nor silently succeeds without a message', async () => {
    const streamFrames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['drained content'] }],
      omitTerminal: true,
    })
    const cassette = {
      name: 'eof',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: streamFrames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('drained content')
  })
})

describe('OpenAIResponsesAdapter — response.failed', () => {
  it('streaming response.failed nacks STREAM_ERROR', async () => {
    const cassette = singleResponsesStreamCassette('failed-stream', {
      steps: [],
      status: 'failed',
      error: { message: 'generation failed upstream' },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_STREAM_ERROR))
  })

  it('non-streaming status "failed" nacks STREAM_ERROR', async () => {
    const cassette = singleResponsesResponseCassette('failed-ns', {
      status: 'failed',
      error: { message: 'nope' },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_STREAM_ERROR))
  })
})

describe('OpenAIResponsesAdapter — response.incomplete + truncation', () => {
  it('streaming incomplete with max_output_tokens reason still persists partial text, finishReason "length"', async () => {
    const cassette = singleResponsesStreamCassette('trunc-stream', {
      steps: [{ kind: 'text', deltas: ['truncated'] }],
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
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
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('truncated')
    expect(helpers._stats[0]!.finishReason).toBe('length')
  })

  it('non-streaming incomplete reports finishReason "length"', async () => {
    const cassette = singleResponsesResponseCassette('trunc-ns', {
      content: 'partial',
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
})

describe('OpenAIResponsesAdapter — refusal as text', () => {
  it('streaming refusal persists as message text, not an error', async () => {
    const cassette = singleResponsesStreamCassette('refusal-stream', {
      steps: [{ kind: 'refusal', deltas: ['cannot comply'] }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('cannot comply')
  })

  it('non-streaming refusal persists as message text, not an error', async () => {
    const cassette = singleResponsesResponseCassette('refusal-ns', { refusal: 'cannot comply' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('cannot comply')
  })
})

describe('OpenAIResponsesAdapter — unknown output-item types create no slot', () => {
  it('streaming: hosted item type opens no slot, no crash, debug-logged', async () => {
    const cassette = singleResponsesStreamCassette('unknown-item-stream', {
      steps: [{ kind: 'opaque', itemType: 'code_interpreter_call' }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(0)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })

  it('non-streaming: hosted item type is skipped, no crash', async () => {
    const cassette = singleResponsesResponseCassette('unknown-item-ns', {
      output: [{ type: 'mcp_call', id: 'mcp-1' }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(0)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })
})

describe('OpenAIResponsesAdapter — request body shape', () => {
  it('sends store:false always, and instructions from the ADK-rendered system prompt', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(capturedBody?.store).toBe(false)
    expect(capturedBody?.instructions).toBe('sys')
    expect(capturedBody?.model).toBe('m')
  })

  it('ADK control keys never leak into the request body', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      unsupportedMediaPolicy: 'throw',
      selfIdentity: 'assistant',
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(capturedBody?.autoAck).toBeUndefined()
    expect(capturedBody?.unsupportedMediaPolicy).toBeUndefined()
    expect(capturedBody?.selfIdentity).toBeUndefined()
    expect(capturedBody?.apiKey).toBeUndefined()
    expect(capturedBody?.helpers).toBeUndefined()
  })

  // `strict` is an ADK-control key with a TOOL-DECLARATION meaning: it becomes each emitted
  // function tool's own `strict` field, never a top-level request property. It was missing from
  // ADK_CONTROL_KEYS, so the generic body spread forwarded it verbatim and the wire body carried
  // `strict: true` next to `model`/`input`, where the API can reject the request before
  // generation. The assertion above did not catch it because it only listed keys that happened to
  // be in the set already.
  it('does not leak `strict` into the request body, but DOES apply it to tool declarations', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const tool = new Tool({
      name: 'noop_tool',
      description: 'no-op',
      inputSchema: validator.object({}),
      handler: async () => 'ok',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      strict: true,
    })
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    await adapter.executor()(ctx, makeHelpers())

    // Not a top-level request property.
    expect(capturedBody?.strict).toBeUndefined()
    expect(Object.keys(capturedBody ?? {})).not.toContain('strict')
    // ...but it still reaches the place it actually belongs.
    const tools = capturedBody?.tools as Array<{ name: string; strict?: boolean }> | undefined
    expect(tools?.[0]?.name).toBe('noop_tool')
    expect(tools?.[0]?.strict).toBe(true)
  })
})

// ─── Review-finding regressions ────────────────────────────────────────────────

describe('OpenAIResponsesAdapter — null-safe output enumeration', () => {
  it('survives a null item sitting between a reasoning item and its paired message', async () => {
    // `output[i + 1]` is a NULLABLE lookahead: the loop head guards `if (!item) continue`, but the
    // `pairedItemId` lookahead below it used `nextItem !== undefined && 'id' in nextItem`, and
    // `'id' in null` throws `TypeError: Cannot use 'in' operator to search for 'id' in null`,
    // killing the WHOLE dispatch — no message persisted, no thought persisted, turn lost.
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'r',
            object: 'response',
            status: 'completed',
            model: 'm',
            output: [
              {
                type: 'reasoning',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 't' }],
                encrypted_content: 'enc',
              },
              null,
              {
                type: 'message',
                role: 'assistant',
                id: 'msg_1',
                status: 'completed',
                content: [{ type: 'output_text', text: 'answer', annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.thoughts).toHaveLength(1)
    // The null is skipped for pairing purposes rather than crashing on it.
    const payload = ctx._stored.thoughts[0]!.payload as { pairedItemId?: string }
    expect(payload.pairedItemId).toBeUndefined()
  })
})

describe('OpenAIResponsesAdapter — multiline SSE data fields', () => {
  it('joins an event split across several `data:` lines instead of dropping it', async () => {
    // Per the SSE spec an event's `data:` fields are concatenated and parsed ONCE. Parsing each
    // line independently yields invalid JSON fragments that are silently skipped, losing the event.
    //
    // The frame split here is `response.completed` — deliberately NOT a text delta. A lost delta is
    // invisible because `response.output_item.done` re-supplies the full authoritative text, so a
    // test that split a delta would pass with or without the fix (verified: it did). Losing the
    // TERMINAL event is observable: without it the stream ends with no terminal seen, which the
    // adapter reports as `sse-eof-without-terminal-event` and drains with no usage recorded.
    const frames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['hello'] }],
      usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
    })
    const body = frames
      .map((f) => {
        const json = (f as { json?: unknown }).json
        if (json === undefined) return (f as { raw: string }).raw
        const raw = JSON.stringify(json)
        if ((json as { type?: string }).type === 'response.completed') {
          const at = Math.floor(raw.length / 2)
          return `data: ${raw.slice(0, at)}\ndata: ${raw.slice(at)}\n\n`
        }
        return `data: ${raw}\n\n`
      })
      .join('')
    const fetchFn = vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('hello')
    // The terminal event survived the split, so its usage reached the stats hook. Without the
    // join it is dropped and no usage is ever reported.
    expect(helpers._stats).toHaveLength(1)
    expect(helpers._stats[0]!.promptTokens).toBe(7)
    expect(helpers._stats[0]!.completionTokens).toBe(5)
  })
})

// `requestTimeoutMs` is documented as the request timeout, but its timer was cleared the moment
// `fetch` resolved — which happens on HEADERS. A response whose body then stalled waited forever
// whenever `streamIdleTimeoutMs` was unset, so the documented option did not bound what its name
// implies. It now covers body consumption too.
describe('OpenAIResponsesAdapter — requestTimeoutMs bounds the whole exchange', () => {
  it('nacks REQUEST_TIMEOUT when the body stalls and no idle timeout is configured', async () => {
    // Headers resolve immediately; the body never yields a byte and never closes.
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        /* deliberately silent */
      },
    })
    const fetchFn = vi.fn(
      async () =>
        new Response(stalled, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      requestTimeoutMs: 120,
      // streamIdleTimeoutMs deliberately UNSET — that is the gap being closed.
      autoAck: true,
    })
    const ctx = makeCtx()
    // `executor()` is typed `void | Promise<void>`, so wrap rather than calling `.then` on it.
    const run = (async () => {
      await adapter.executor()(ctx, makeHelpers())
      return 'returned' as const
    })()
    const outcome = await Promise.race([
      run,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ])
    expect(outcome).toBe('returned')
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.nack).mock.calls[0]![0]).toBeInstanceOf(E_OPENAI_RESPONSES_REQUEST_TIMEOUT)
  }, 10_000)
})

// A tool call goes on the wire as TWO sibling items: the `function_call` (carrying `name` +
// `arguments`) and its `function_call_output`. Only the output was tallied, so a prior call with
// large arguments was invisible to the context guard.
describe('OpenAIResponsesAdapter — context guard counts function_call arguments', () => {
  it('overflows when a prior tool call carries very large arguments', async () => {
    const bigArgs = { blob: 'x '.repeat(1_200) }
    const toolCall = new ToolCall({
      id: 'call_big',
      tool: 'noop_tool',
      args: bigArgs,
      checksum: 'sum-big',
      isComplete: true,
      isError: false,
      results: new Tokenizable('ok'),
      createdAt: dt('2026-01-01T00:00:01Z'),
      updatedAt: dt('2026-01-01T00:00:01Z'),
      completedAt: dt('2026-01-01T00:00:01Z'),
    })
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      tokenEncoding: 'cl100k_base',
      // Comfortably above the message text alone, well below the arguments blob's token cost.
      contextWindow: 400,
    })
    const ctx = makeCtx({ toolCalls: [toolCall] })
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toThrow(
      E_OPENAI_RESPONSES_CONTEXT_OVERFLOW
    )
    // The guard refused BEFORE the request went out.
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

// `requestTimeoutMs` is a WHOLE-EXCHANGE budget. Anchoring the body-read deadline to when headers
// arrived granted a slow-headers response a second, full interval to stream its body.
describe('OpenAIResponsesAdapter — requestTimeoutMs is a whole-exchange budget', () => {
  it('does not restart the clock after slow headers', async () => {
    const timeoutMs = 300
    // Headers arrive after ~70% of the budget; the body then never yields a byte. A deadline
    // anchored at the attempt start must fire in the REMAINING ~30%, not grant another full 300ms.
    const fetchFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, Math.floor(timeoutMs * 0.7)))
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* silent */
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      requestTimeoutMs: timeoutMs,
      autoAck: true,
    })
    const ctx = makeCtx()
    const startedAt = Date.now()
    await adapter.executor()(ctx, makeHelpers())
    const elapsed = Date.now() - startedAt
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.nack).mock.calls[0]![0]).toBeInstanceOf(E_OPENAI_RESPONSES_REQUEST_TIMEOUT)
    // The body read gets only the REMAINING budget (~30% here), so the whole exchange finishes
    // near one budget. Anchoring at headers instead would spend 70% + a fresh 100% ≈ 1.7x, so the
    // bound sits between the two: loose enough to survive scheduler jitter under parallel suite
    // load (a tighter bound flaked once in a full-suite run), tight enough that the wrong anchor
    // still fails.
    expect(elapsed).toBeLessThan(timeoutMs * 1.45)
  }, 10_000)
})

// A DYNAMIC system prompt is a `Tokenizable` built from a `(ctx) => string` resolver. The shared
// `renderChatCompletionsSystemPrompt` has a `renderCtx` seam for exactly this, but nothing passed
// it — so such a prompt rendered against `undefined` and silently dropped whatever it read.
describe('OpenAIResponsesAdapter — dynamic system prompt sees the dispatch context', () => {
  it('resolves a context-reading systemPrompt against the live ctx', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    // Reads a field that only exists on a real dispatch context.
    ;(ctx as unknown as { systemPrompt: Tokenizable }).systemPrompt = new Tokenizable(
      (c?: unknown) =>
        `tools=${(c as { tools?: unknown } | undefined)?.tools !== undefined ? 'present' : 'MISSING'}`
    )
    await adapter.executor()(ctx, makeHelpers())
    expect(capturedBody?.instructions).toBe('tools=present')
  })
})

// `Message.id` is application-generated and unconstrained; a Responses item id must satisfy the
// provider's charset and 64-character limit. Replaying an own-assistant message copied the id
// verbatim, so an oversized id got the whole continuation request rejected.
describe('OpenAIResponsesAdapter — own-assistant replay normalizes item ids', () => {
  it('normalizes an oversized prior-assistant message id', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string)
      return new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const longId = `assistant-${'x'.repeat(200)}`
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    ctx.turnMessages.add(
      new Message({
        id: longId,
        role: 'assistant',
        identity: 'assistant' as never,
        content: 'prior answer',
        createdAt: dt('2026-01-01T00:00:02Z'),
        updatedAt: dt('2026-01-01T00:00:02Z'),
      })
    )
    await adapter.executor()(ctx, makeHelpers())
    const replayed = (capturedBody?.input as Array<{ type?: string; id?: string }>).find(
      (i) => i.type === 'message' && i.id !== undefined
    )
    expect(replayed).toBeDefined()
    expect(replayed!.id).not.toBe(longId)
    expect(replayed!.id!.length).toBeLessThanOrEqual(64)
    expect(replayed!.id).toMatch(/^msg_[0-9a-f]{8}$/)
  })
})

// The non-streaming twin of the streaming body-deadline gap. `response.json()` consumes the body,
// and the per-attempt timer is cleared when `fetch` resolves (on headers) — so a stalled body hung
// forever despite a configured `requestTimeoutMs`. Bounded by the same whole-exchange deadline.
describe('OpenAIResponsesAdapter — non-streaming body read is bounded', () => {
  it('nacks REQUEST_TIMEOUT when response.json() stalls', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        /* headers only; body never yields */
      },
    })
    const fetchFn = vi.fn(
      async () =>
        new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      requestTimeoutMs: 150,
      autoAck: true,
    })
    const ctx = makeCtx()
    const run = (async () => {
      await adapter.executor()(ctx, makeHelpers())
      return 'returned' as const
    })()
    const outcome = await Promise.race([
      run,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ])
    expect(outcome).toBe('returned')
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.nack).mock.calls[0]![0]).toBeInstanceOf(E_OPENAI_RESPONSES_REQUEST_TIMEOUT)
  }, 10_000)
})

// The context guard must size what goes ON THE WIRE, not the source primitives. Every timeline
// message ships wrapped in an identity envelope (`<message_<id> from=… role=… createdAt=…>`),
// every surfaced thought in a `<thought_…>` envelope, and all standing instructions inside one
// `<system_instructions …>` block. Measured: a 30-char message ships as 118 chars (3.9x), and the
// envelope is a near-fixed ~90 chars regardless of body length — so a long conversation of short
// messages leaked hundreds of tokens the guard never saw. This is the "envelope overhead" the
// review kept raising across several rounds.
describe('OpenAIResponsesAdapter — context guard counts envelope overhead', () => {
  it('overflows on many short messages whose ENVELOPES exceed the window', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      tokenEncoding: 'cl100k_base',
      // 40 messages of ~10 chars each is ~100 tokens of raw content, but ~900+ tokens once each
      // carries its ~90-char envelope. A window of 400 sits between the two, so this overflows
      // only if envelopes are counted.
      contextWindow: 400,
    })
    const ctx = makeCtx()
    ctx.turnMessages.clear()
    for (let i = 0; i < 40; i++) {
      ctx.turnMessages.add(
        new Message({
          id: `u-${i}`,
          role: 'user',
          content: `msg ${i}`,
          createdAt: dt('2026-01-01T00:00:00Z'),
          updatedAt: dt('2026-01-01T00:00:00Z'),
        })
      )
    }
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toThrow(
      E_OPENAI_RESPONSES_CONTEXT_OVERFLOW
    )
    // Refused BEFORE the request went out.
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('still admits the same messages when the window comfortably covers the envelopes', async () => {
    // The mirror case, so the test above cannot pass merely because the guard over-counts
    // everything: with a generous window the identical payload must go through.
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(buildResponsesResponse({ content: 'ok' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      tokenEncoding: 'cl100k_base',
      contextWindow: 100_000,
    })
    const ctx = makeCtx()
    ctx.turnMessages.clear()
    for (let i = 0; i < 40; i++) {
      ctx.turnMessages.add(
        new Message({
          id: `u-${i}`,
          role: 'user',
          content: `msg ${i}`,
          createdAt: dt('2026-01-01T00:00:00Z'),
          updatedAt: dt('2026-01-01T00:00:00Z'),
        })
      )
    }
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

// The stall path and the EOF path both arrive holding the SAME partial slots, and treat them
// oppositely — a stall discards, EOF drains. That asymmetry is deliberate (a stall means the
// connection is still open and more content may be in flight, so a mid-sentence fragment must not
// enter history as a finished assistant turn; EOF means the provider closed and the fragment IS
// the answer), but it was undocumented across three batteries and reads as a bug. Pinned here so
// neither half can drift into the other.
describe('OpenAIResponsesAdapter — stall discards, EOF drains', () => {
  const partialStream = (opts: { closeAfterMs?: number }) => {
    let ctrl: ReadableStreamDefaultController<Uint8Array>
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c
      },
    })
    setTimeout(() => {
      ctrl.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } })}\n\n`
        )
      )
      ctrl.enqueue(
        enc.encode(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'partial answer' })}\n\n`
        )
      )
      if (opts.closeAfterMs !== undefined) setTimeout(() => ctrl.close(), opts.closeAfterMs)
    }, 20)
    return body
  }

  it('a STALL nacks and persists nothing, even with partial text received', async () => {
    // Connection stays open and silent -> idle timer fires.
    const fetchFn = vi.fn(
      async () =>
        new Response(partialStream({}), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 120,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(vi.mocked(ctx.nack).mock.calls[0]![0]).toBeInstanceOf(E_OPENAI_RESPONSES_STREAM_STALLED)
    expect(ctx._stored.messages).toHaveLength(0)
  }, 15_000)

  it('an EOF with the SAME partial text drains and persists it', async () => {
    // Identical payload, but the provider CLOSES the stream -> drain path.
    const fetchFn = vi.fn(
      async () =>
        new Response(partialStream({ closeAfterMs: 10 }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 5_000,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('partial answer')
  }, 15_000)
})
