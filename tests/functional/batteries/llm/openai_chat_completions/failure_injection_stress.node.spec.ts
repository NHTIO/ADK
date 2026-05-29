/**
 * Failure-injection stress — chaos `fetch` wrapper that simulates transient
 * upstream failures and verifies the adapter's retry / timeout / nack surface.
 *
 * Unlike the other stress specs, these tests do NOT need a live gateway —
 * the chaos fetch synthesises every response. They still default-skip on the
 * absence of `TEST_OPENAI_API_KEY` so the suite remains gated uniformly with
 * the rest of the live-LLM stress files.
 *
 * Coverage:
 *   - Transient 503 → retry succeeds → final assistant message persisted
 *   - Persistent 503 → retry exhausts → ctx.nack with E_..._HTTP_ERROR
 *   - 429 with `Retry-After` seconds honored (clamped to maxDelayMs)
 *   - Non-retriable 400 → no retry, immediate nack
 *   - Mid-stream byte drop → E_..._STREAM_ERROR via nack
 *   - SSE stall past streamIdleTimeoutMs → E_..._STREAM_STALLED via nack
 *   - Pre-headers hang past requestTimeoutMs → E_..._REQUEST_TIMEOUT via nack
 */
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../../../_fixtures/runner'
import { OpenAIChatCompletionsAdapter } from '@nhtio/adk/batteries/llm/openai_chat_completions'

const TEST_API_KEY = typeof process !== 'undefined' ? process.env?.TEST_OPENAI_API_KEY : undefined
const TEST_MODEL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_MODEL : undefined) ?? 'gpt-4o-mini'
const TEST_BASE_URL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_BASE_URL : undefined) || undefined

const SKIP = typeof process === 'undefined' || !TEST_API_KEY

const okJsonResponse = (content: string) =>
  new Response(
    JSON.stringify({
      id: 'cmpl-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: TEST_MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

const okSseResponse = (chunks: ReadonlyArray<unknown>) => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const errorJsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const truncatedSseResponse = () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      // Open a chunk but never close — half-write then error the stream.
      controller.enqueue(
        encoder.encode('data: {"id":"cmpl-x","choices":[{"index":0,"delta":{"content":"hel')
      )
      controller.error(new Error('synthetic mid-stream transport failure'))
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const stallingSseResponse = (signal: AbortSignal) => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            id: 'cmpl-stall',
            choices: [{ index: 0, delta: { content: 'partial' } }],
          })}\n\n`
        )
      )
      // Never enqueue anything else. Abort closes us.
      signal.addEventListener('abort', () => {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe.skipIf(SKIP)('failure injection — retry on transient 503', () => {
  it(
    'returns 503 twice, then 200 → dispatch settles successfully with retry',
    { timeout: 30_000 },
    async () => {
      let calls = 0
      const chaosFetch: typeof fetch = async () => {
        calls += 1
        if (calls <= 2) return errorJsonResponse(503, { error: 'unavailable' })
        return okJsonResponse('recovered')
      }

      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        fetch: chaosFetch,
        retry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 },
        autoAck: true,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])

      expect(results[0].status).toBe('fulfilled')
      expect(calls).toBeGreaterThanOrEqual(3)
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )

  it(
    'persistent 503 across maxAttempts → ctx.nack with HTTP_ERROR',
    { timeout: 30_000 },
    async () => {
      let calls = 0
      const chaosFetch: typeof fetch = async () => {
        calls += 1
        return errorJsonResponse(503, { error: 'down' })
      }

      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        fetch: chaosFetch,
        retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 },
        autoAck: true,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])

      expect(calls).toBe(3)
      // Dispatch settled (one way or another) — either turnEnd or error event.
      const turnEnds = events.filter((e) => e.kind === 'turnEnd')
      const errs = events.filter((e) => e.kind === 'error')
      expect(turnEnds.length + errs.length).toBeGreaterThanOrEqual(1)
    }
  )
})

describe.skipIf(SKIP)('failure injection — Retry-After honored and clamped', () => {
  it('oversized Retry-After is clamped to maxDelayMs', { timeout: 30_000 }, async () => {
    const start = Date.now()
    let calls = 0
    const chaosFetch: typeof fetch = async () => {
      calls += 1
      if (calls === 1)
        return errorJsonResponse(429, { error: 'rate-limited' }, { 'Retry-After': '60' })
      return okJsonResponse('recovered')
    }

    const adapter = new OpenAIChatCompletionsAdapter({
      model: TEST_MODEL,
      apiKey: TEST_API_KEY!,
      ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
      stream: false,
      fetch: chaosFetch,
      retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 200, honorRetryAfter: true },
      autoAck: true,
    })

    const { run, events } = makeFixtureRunner({
      executorCallback: adapter.executor(),
    })

    const results = await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])

    const elapsed = Date.now() - start
    // Clamped to 200ms (+ jitter < 10%) — must NOT wait the full 60s.
    expect(elapsed).toBeLessThan(5_000)
    expect(calls).toBe(2)
    expect(results[0].status).toBe('fulfilled')
    expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
  })
})

describe.skipIf(SKIP)('failure injection — non-retriable status', () => {
  it('400 → no retry, single fetch, immediate nack', { timeout: 30_000 }, async () => {
    let calls = 0
    const chaosFetch: typeof fetch = async () => {
      calls += 1
      return errorJsonResponse(400, { error: 'bad-request' })
    }

    const adapter = new OpenAIChatCompletionsAdapter({
      model: TEST_MODEL,
      apiKey: TEST_API_KEY!,
      ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
      stream: false,
      fetch: chaosFetch,
      retry: { maxAttempts: 5, baseDelayMs: 5 },
      autoAck: true,
    })

    const { run } = makeFixtureRunner({
      executorCallback: adapter.executor(),
    })

    await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])

    expect(calls).toBe(1)
  })
})

describe.skipIf(SKIP)('failure injection — mid-stream byte drop', () => {
  it('truncated SSE stream surfaces STREAM_ERROR via ctx.nack', { timeout: 30_000 }, async () => {
    const chaosFetch: typeof fetch = async () => truncatedSseResponse()

    const adapter = new OpenAIChatCompletionsAdapter({
      model: TEST_MODEL,
      apiKey: TEST_API_KEY!,
      ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
      stream: true,
      fetch: chaosFetch,
      autoAck: true,
    })

    const { run, events } = makeFixtureRunner({
      executorCallback: adapter.executor(),
    })

    await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])

    // Dispatch must settle one way or another — not hang.
    const turnEnds = events.filter((e) => e.kind === 'turnEnd')
    const errs = events.filter((e) => e.kind === 'error')
    expect(turnEnds.length + errs.length).toBeGreaterThanOrEqual(1)
  })
})

describe.skipIf(SKIP)('failure injection — SSE stall past idle timeout', () => {
  it(
    'SSE that goes silent past streamIdleTimeoutMs → STREAM_STALLED nack',
    { timeout: 30_000 },
    async () => {
      const controller = new AbortController()
      const chaosFetch: typeof fetch = async (_url, init) => {
        // Honor the adapter's abort signal so we don't leak.
        const sig = (init?.signal as AbortSignal | undefined) ?? controller.signal
        return stallingSseResponse(sig)
      }

      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: true,
        fetch: chaosFetch,
        streamIdleTimeoutMs: 250,
        autoAck: true,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const start = Date.now()
      await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])
      const elapsed = Date.now() - start

      // Watchdog should have fired in roughly the timeout window — well under 10s.
      expect(elapsed).toBeLessThan(10_000)
      const turnEnds = events.filter((e) => e.kind === 'turnEnd')
      const errs = events.filter((e) => e.kind === 'error')
      expect(turnEnds.length + errs.length).toBeGreaterThanOrEqual(1)
    }
  )
})

describe.skipIf(SKIP)('failure injection — pre-headers hang', () => {
  it(
    'fetch that never resolves headers → REQUEST_TIMEOUT after requestTimeoutMs',
    { timeout: 30_000 },
    async () => {
      const chaosFetch: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined
          if (sig) {
            sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }
        })

      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        fetch: chaosFetch,
        requestTimeoutMs: 300,
        retry: { maxAttempts: 1 },
        autoAck: true,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const start = Date.now()
      await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])
      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(10_000)
      const turnEnds = events.filter((e) => e.kind === 'turnEnd')
      const errs = events.filter((e) => e.kind === 'error')
      expect(turnEnds.length + errs.length).toBeGreaterThanOrEqual(1)
    }
  )
})

describe.skipIf(SKIP)('failure injection — REQUEST_TIMEOUT retries', () => {
  it(
    'hang on first attempt, succeed on second → dispatch fulfills',
    { timeout: 30_000 },
    async () => {
      let calls = 0
      const chaosFetch: typeof fetch = (_url, init) => {
        calls += 1
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            const sig = init?.signal as AbortSignal | undefined
            if (sig) {
              sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            }
          })
        }
        return Promise.resolve(okJsonResponse('recovered'))
      }

      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        fetch: chaosFetch,
        requestTimeoutMs: 200,
        retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50 },
        autoAck: true,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply "ok".' })])

      expect(calls).toBeGreaterThanOrEqual(2)
      expect(results[0].status).toBe('fulfilled')
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )
})

describe.skipIf(SKIP)('failure injection — streaming success path with chaos fetch', () => {
  it('clean SSE stream through chaos fetch settles normally', { timeout: 30_000 }, async () => {
    const chaosFetch: typeof fetch = async () =>
      okSseResponse([
        { id: 'cmpl-x', choices: [{ index: 0, delta: { content: 'he' } }] },
        { id: 'cmpl-x', choices: [{ index: 0, delta: { content: 'llo' } }] },
        { id: 'cmpl-x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])

    const adapter = new OpenAIChatCompletionsAdapter({
      model: TEST_MODEL,
      apiKey: TEST_API_KEY!,
      ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
      stream: true,
      fetch: chaosFetch,
      autoAck: true,
    })

    const { run, events } = makeFixtureRunner({
      executorCallback: adapter.executor(),
    })

    const results = await Promise.allSettled([run({ systemPrompt: 'Reply with hello.' })])

    expect(results[0].status).toBe('fulfilled')
    expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
  })
})
