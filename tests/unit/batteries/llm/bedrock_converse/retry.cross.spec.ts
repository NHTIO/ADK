import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tokenizable, ToolRegistry, Registry } from '@nhtio/adk/common'
import { BedrockConverseAdapter } from '../../../../../src/batteries/llm/bedrock_converse/adapter'
import {
  E_CONVERSE_ALTERNATION_VIOLATION,
  E_CONVERSE_MISSING_TOOL_CONFIG,
  E_CONVERSE_REQUEST_FAILED,
  E_CONVERSE_STREAM_ERROR,
} from '../../../../../src/batteries/llm/bedrock_converse/exceptions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// ─── helpers ──────────────────────────────────────────────────────────────────
// Mirrors the harness in openai_chat_completions/adapter.cross.spec.ts's retry describe block,
// adapted to Bedrock Converse's response shape (output.message.content[]).

const validResponse = (text = 'hello'): Response =>
  new Response(JSON.stringify({ output: { message: { content: [{ text }] } } }), {
    status: 200,
  })

const makeHelpers = (): DispatchExecutorHelpers & {
  _logs: Array<{ level: string; kind: string; message: string; payload?: unknown }>
} => {
  const logs: Array<{ level: string; kind: string; message: string; payload?: unknown }> = []
  const captureLog =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
    (entry: { kind: string; message: string; payload?: Record<string, unknown> }) => {
      logs.push({ level, kind: entry.kind, message: entry.message, payload: entry.payload })
    }
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: {
      trace: vi.fn(captureLog('trace')),
      debug: vi.fn(captureLog('debug')),
      info: vi.fn(captureLog('info')),
      warn: vi.fn(captureLog('warn')),
      error: vi.fn(captureLog('error')),
    },
    _logs: logs,
  } as unknown as DispatchExecutorHelpers & { _logs: typeof logs }
}

const makeCtx = (
  overrides: { abortSignal?: AbortSignal; stash?: Record<string, unknown> } = {}
): DispatchContext =>
  ({
    systemPrompt: new Tokenizable(''),
    standingInstructions: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    tools: new ToolRegistry(),
    stash: new Registry(overrides.stash ?? {}),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    storeMessage: vi.fn(async () => undefined),
    storeThought: vi.fn(async () => undefined),
    storeToolCall: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
  }) as never

describe('BedrockConverseAdapter — HTTP error mapping + retry', () => {
  // A timed-out test can remain suspended before its finally block; don't leak fake timers.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retry disabled by default → single fetch on 502', async () => {
    const fetchFn = vi.fn(async () => new Response('upstream busy', { status: 502 }))
    const adapter = new BedrockConverseAdapter({ model: 'test', fetch: fetchFn as never })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_CONVERSE_REQUEST_FAILED
    )
  })

  it('retry succeeds on third attempt (502, 502, 200)', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n < 3) return new Response('busy', { status: 502 })
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
  })

  it('retry exhausts after exactly maxAttempts fetches, then nacks', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 502 }))
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(5)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_CONVERSE_REQUEST_FAILED
    )
  })

  it('aborting during retry backoff returns promptly without a second fetch', async () => {
    // Fake timers so this doesn't burn real wall-clock time under CI load — the abort must fire
    // (and the loop bail out) before the 60s backoff would otherwise elapse.
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchFn = vi.fn(async () => {
        setTimeout(() => controller.abort(), 20)
        return new Response('busy', { status: 502 })
      })
      const adapter = new BedrockConverseAdapter({
        model: 'test',
        fetch: fetchFn as never,
        retry: { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
      })
      const ctx = makeCtx({ abortSignal: controller.signal })
      const p = adapter.executor()(ctx, makeHelpers())
      await vi.advanceTimersByTimeAsync(25)
      await p
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(ctx.ack).not.toHaveBeenCalled()
      expect(ctx.nack).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors Retry-After in seconds', async () => {
    // Fake timers so the ~1s Retry-After backoff doesn't cost a real second per test run.
    vi.useFakeTimers()
    try {
      let n = 0
      const fetchFn = vi.fn(async () => {
        n += 1
        if (n === 1) {
          return new Response('throttled', { status: 429, headers: { 'Retry-After': '1' } })
        }
        return validResponse()
      })
      const adapter = new BedrockConverseAdapter({
        model: 'test',
        fetch: fetchFn as never,
        retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 5000 },
      })
      const ctx = makeCtx()
      const before = Date.now()
      const p = adapter.executor()(ctx, makeHelpers())
      // Advance in steps rather than one large jump: the backoff timer is registered only after
      // reading the first response body. Allow enough real macrotask yields for slow browsers to
      // finish that read; the cap keeps a genuine failure bounded.
      let settled = false
      void Promise.resolve(p).then(() => (settled = true))
      for (let i = 0; i < 300 && !settled; i++) await vi.advanceTimersByTimeAsync(100)
      expect(settled).toBe(true)
      await p
      const elapsed = Date.now() - before
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(elapsed).toBeGreaterThanOrEqual(800)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps Retry-After at maxDelayMs', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1)
        return new Response('throttled', { status: 429, headers: { 'Retry-After': '60' } })
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 200 },
    })
    const t0 = Date.now()
    await adapter.executor()(makeCtx(), makeHelpers())
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThanOrEqual(1000)
  })

  it('honorRetryAfter:false ignores the header', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1)
        return new Response('throttled', { status: 429, headers: { 'Retry-After': '30' } })
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 2, baseDelayMs: 10, honorRetryAfter: false },
    })
    const t0 = Date.now()
    await adapter.executor()(makeCtx(), makeHelpers())
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(3000)
  })

  it('a thrown transport error is retried up to maxAttempts', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('ECONNRESET')
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('a thrown transport error nacks E_CONVERSE_STREAM_ERROR once retries are exhausted', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_CONVERSE_STREAM_ERROR
    )
  })

  it('non-retriable status (400) is not retried', async () => {
    const fetchFn = vi.fn(async () => new Response('bad request', { status: 400 }))
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
  })

  it('the toolConfig vendor classification is terminal even under a retriable status', async () => {
    // 429 IS in the default retriableStatuses set, but the toolConfig body match must win and
    // short-circuit BEFORE the generic retriable-status branch is ever consulted.
    const fetchFn = vi.fn(
      async () =>
        new Response('{"message":"toolConfig is required when toolUse blocks are present"}', {
          status: 429,
        })
    )
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 5, baseDelayMs: 1 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_CONVERSE_MISSING_TOOL_CONFIG
    )
  })

  it('the alternation-violation vendor classification is terminal even under a retriable status', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('{"message":"messages must alternate between user and assistant roles"}', {
          status: 503,
        })
    )
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 5, baseDelayMs: 1 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_CONVERSE_ALTERNATION_VIOLATION
    )
  })

  it('custom retriableStatuses [418,502]: retries 418, does not retry 429', async () => {
    let n = 0
    const fetchFn418 = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('teapot', { status: 418 })
      return validResponse()
    })
    const adapter418 = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn418 as never,
      retry: { maxAttempts: 3, baseDelayMs: 10, retriableStatuses: [418, 502] },
    })
    await adapter418.executor()(makeCtx(), makeHelpers())
    expect(fetchFn418).toHaveBeenCalledTimes(2)

    const fetchFn429 = vi.fn(async () => new Response('throttled', { status: 429 }))
    const adapter429 = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn429 as never,
      retry: { maxAttempts: 3, baseDelayMs: 10, retriableStatuses: [418, 502] },
    })
    const ctx429 = makeCtx()
    await adapter429.executor()(ctx429, makeHelpers())
    expect(fetchFn429).toHaveBeenCalledTimes(1)
    expect(ctx429.nack).toHaveBeenCalledTimes(1)
  })

  it('retry per-dispatch override via stash', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('busy', { status: 502 })
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 1 },
    })
    const ctx = makeCtx({
      stash: { bedrockConverse: { retry: { maxAttempts: 3, baseDelayMs: 10 } } },
    })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('a retriable failure before any output is retried; no retry occurs once a response has been reported', async () => {
    // This battery reads the whole body as one blob (no incremental SSE parsing) regardless of
    // the `stream` option, so there is no partial-output state to protect mid-response — retry
    // only ever happens inside the `!res.ok` branch, strictly before any helpers.report* call.
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('busy', { status: 502 })
      return validResponse('recovered')
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      stream: true,
      retry: { maxAttempts: 2, baseDelayMs: 1 },
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(helpers.reportMessage).toHaveBeenCalledTimes(1)
    expect((helpers.reportMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('recovered')
  })
})

describe('BedrockConverseAdapter — body-read timeout/abort parity (gate defect 1)', () => {
  // Mirrors the Gemini battery's equivalent describe block (see
  // gemini_generate_content/retry.cross.spec.ts) — a ReadableStream wired to the request's
  // signal so aborting it errors the stream the way a real fetch body does. This battery also
  // buffers the whole body via `res.text()` with no incremental parsing, so a stalled upstream
  // can only hang in the body-read phase, which needs the same bound the fetch phase gets.

  it('body stalls past timeoutMs → aborted and nacked as a timeout, not hung', async () => {
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          if (init?.signal) {
            init.signal.addEventListener(
              'abort',
              () => {
                try {
                  c.error(new DOMException('aborted', 'AbortError'))
                } catch {
                  /* already errored or closed */
                }
              },
              { once: true }
            )
          }
          // Otherwise hang forever — never enqueue, never close.
        },
      })
      return new Response(body, { status: 200 })
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      timeoutMs: 50,
    })
    const ctx = makeCtx()
    const t0 = Date.now()
    await adapter.executor()(ctx, makeHelpers())
    const elapsed = Date.now() - t0
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(5_000)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_CONVERSE_STREAM_ERROR
    )
  })

  it('body stalls past timeoutMs with retries configured → retried as a timeout, then succeeds', async () => {
    let n = 0
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      n += 1
      if (n === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            if (init?.signal) {
              init.signal.addEventListener(
                'abort',
                () => {
                  try {
                    c.error(new DOMException('aborted', 'AbortError'))
                  } catch {
                    /* already errored or closed */
                  }
                },
                { once: true }
              )
            }
          },
        })
        return new Response(body, { status: 200 })
      }
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      timeoutMs: 50,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
  })

  it('caller abort during body read → no nack, no further fetch', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          if (init?.signal) {
            init.signal.addEventListener(
              'abort',
              () => {
                try {
                  c.error(new DOMException('aborted', 'AbortError'))
                } catch {
                  /* already errored or closed */
                }
              },
              { once: true }
            )
          }
        },
      })
      return new Response(body, { status: 200 })
    })
    const adapter = new BedrockConverseAdapter({ model: 'test', fetch: fetchFn as never })
    const ctx = makeCtx({ abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.ack).not.toHaveBeenCalled()
  })

  it('caller abort during fetch (before headers arrive) → no retry', async () => {
    const controller = new AbortController()
    const fetchFn = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
          // Otherwise never resolve — simulates a fetch that never gets headers.
        })
    )
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx({ abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.ack).not.toHaveBeenCalled()
  })
})

describe('BedrockConverseAdapter — structured observability hooks (helpers.log)', () => {
  it('emits a `retry-attempt` warn when a 502 triggers a retry, and an `http-error` error when the retry exhausts', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 502 }))
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 2, baseDelayMs: 5 },
    })
    const helpers = makeHelpers()
    await adapter.executor()(makeCtx(), helpers)
    const retryEvents = helpers._logs.filter((l) => l.kind === 'retry-attempt')
    const errEvents = helpers._logs.filter((l) => l.kind === 'http-error')
    expect(retryEvents.length).toBeGreaterThanOrEqual(1)
    expect(retryEvents[0].level).toBe('warn')
    expect((retryEvents[0].payload as { status?: number }).status).toBe(502)
    expect(errEvents.length).toBe(1)
    expect(errEvents[0].level).toBe('error')
    expect((errEvents[0].payload as { status?: number }).status).toBe(502)
  })

  it('emits a `transport-error` error and a `retry-attempt` debug when a thrown error retries', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) throw new Error('ECONNRESET')
      return validResponse()
    })
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      fetch: fetchFn as never,
      retry: { maxAttempts: 2, baseDelayMs: 5 },
    })
    const helpers = makeHelpers()
    await adapter.executor()(makeCtx(), helpers)
    const transportEvents = helpers._logs.filter((l) => l.kind === 'transport-error')
    expect(transportEvents.length).toBe(1)
    expect(transportEvents[0].level).toBe('error')
    const retryEvents = helpers._logs.filter((l) => l.kind === 'retry-attempt')
    expect(retryEvents.length).toBe(1)
    expect(retryEvents[0].level).toBe('debug')
    expect((retryEvents[0].payload as { reason?: string }).reason).toBe('transport-error')
  })
})
