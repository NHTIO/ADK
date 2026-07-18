import { describe, expect, it, vi } from 'vitest'
import {
  OllamaEmbeddingsAdapter,
  E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS,
  E_OLLAMA_EMBEDDINGS_HTTP_ERROR,
  E_OLLAMA_EMBEDDINGS_REQUEST_TIMEOUT,
  E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE,
} from '../../../../../src/batteries/embeddings/ollama'

// ─── helpers ──────────────────────────────────────────────────────────────────

const jsonResponse = (
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> }
) =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })

// Read the [url, init] of a recorded fetch mock call (typed past the no-arg mock signature).
const callOf = (fetchFn: ReturnType<typeof vi.fn>, i = 0): [string, RequestInit] =>
  fetchFn.mock.calls[i] as unknown as [string, RequestInit]

const sentBody = (fetchFn: ReturnType<typeof vi.fn>, i = 0): Record<string, unknown> =>
  JSON.parse(callOf(fetchFn, i)[1].body as string)

// Build a canned /api/embed success body for `n` inputs.
// CRITICAL: each vector encodes its position (filled with value i) so that any
// accidental openai-style index-sort would visibly corrupt the order and fail the test.
const embeddingsBody = (n: number, dim = 3) => ({
  model: 'nomic-embed-text',
  embeddings: Array.from({ length: n }, (_, i) => Array.from({ length: dim }, () => i)),
})

// A DELIBERATELY NON-MONOTONIC position-encoded body: the response order (20, 10, 30) is not
// ascending, so ANY accidental sort — by value, by a phantom index, or otherwise — corrupts it.
const nonMonotonicBody = () => ({
  model: 'nomic-embed-text',
  embeddings: [[20], [10], [30]],
})

// ─── construction / validation ─────────────────────────────────────────────────

describe('OllamaEmbeddingsAdapter — construction', () => {
  it('throws E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS when model is missing', () => {
    expect(() => new OllamaEmbeddingsAdapter({ apiKey: 'test' })).toThrow(
      E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS
    )
  })

  it('throws when model is an empty string', () => {
    expect(() => new OllamaEmbeddingsAdapter({ model: '' })).toThrow(
      E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS
    )
  })

  it('throws on unknown option keys', () => {
    expect(() => new OllamaEmbeddingsAdapter({ model: 'nomic-embed-text', bogus: true })).toThrow(
      E_INVALID_OLLAMA_EMBEDDINGS_OPTIONS
    )
  })

  it('constructs with a valid model and reports dimensions when configured', () => {
    const a = new OllamaEmbeddingsAdapter({ model: 'nomic-embed-text', dimensions: 768 })
    expect(a.dimensions).toBe(768)
    expect(a.isAvailable()).toBe(true)
    expect(OllamaEmbeddingsAdapter.isAvailable()).toBe(true)
  })

  it('preload and reset are no-ops that resolve/return cleanly', async () => {
    const a = new OllamaEmbeddingsAdapter({ model: 'nomic-embed-text' })
    await expect(a.preload()).resolves.toBeUndefined()
    expect(a.reset()).toBeUndefined()
  })
})

// ─── embed / embedMany happy path ───────────────────────────────────────────────

describe('OllamaEmbeddingsAdapter — embed', () => {
  it('embeds a single string and returns a number[]', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'nomic-embed-text',
      apiKey: 'test',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const vec = await a.embed('hello')
    expect(Array.isArray(vec)).toBe(true)
    expect(vec).toEqual([0, 0, 0])

    // Verify request shape: POST /api/embed with auth.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = callOf(fetchFn)
    expect(url).toBe('http://localhost:11434/api/embed')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test')
    const sent = JSON.parse(init.body as string)
    expect(sent).toMatchObject({
      model: 'nomic-embed-text',
      input: ['hello'],
    })
  })

  it('embedMany returns one vector per input in input order (positional, no index sort)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(3)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const vecs = await a.embedMany(['a', 'b', 'c'])
    expect(vecs.length).toBe(3)
    // Position-encoded: input i → vector filled with value i
    expect(vecs[0]).toEqual([0, 0, 0])
    expect(vecs[1]).toEqual([1, 1, 1])
    expect(vecs[2]).toEqual([2, 2, 2])
  })

  it('preserves response order exactly, even when non-monotonic (no sort of any kind)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(nonMonotonicBody()))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const vecs = await a.embedMany(['first', 'second', 'third'])
    // Returned verbatim in response/input position: [20], [10], [30] — a sort would reorder these.
    expect(vecs).toEqual([[20], [10], [30]])
  })

  it('returns [] for an empty batch without calling fetch', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(0)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(await a.embedMany([])).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('omits dimensions/truncate/keep_alive/options from the body when none are configured', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'nomic-embed-text',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hello')
    const sent = sentBody(fetchFn)
    expect(sent).toEqual({ model: 'nomic-embed-text', input: ['hello'] })
    expect('truncate' in sent).toBe(false)
    expect('dimensions' in sent).toBe(false)
    expect('keep_alive' in sent).toBe(false)
    expect('options' in sent).toBe(false)
  })

  it('rejects a same-length response with a non-array vector as MALFORMED', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ model: 'm', embeddings: [null] }))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embedMany(['a'])).rejects.toThrow(E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE)
  })

  it('rejects a same-length response with a non-numeric coordinate as MALFORMED', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ model: 'm', embeddings: [['not-a-number']] }))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embedMany(['a'])).rejects.toThrow(E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE)
  })

  it('forwards configured dimensions in the request body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1, 4)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'nomic-embed-text',
      dimensions: 256,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const sent = sentBody(fetchFn)
    expect(sent.dimensions).toBe(256)
  })

  it('forwards truncate when set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      truncate: true,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const sent = sentBody(fetchFn)
    expect(sent.truncate).toBe(true)
  })

  it('forwards keepAlive as keep_alive when set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      keepAlive: '5m',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const sent = sentBody(fetchFn)
    expect(sent.keep_alive).toBe('5m')
  })

  it('forwards options (num_ctx, num_thread) when set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      options: { num_ctx: 2048, num_thread: 4 },
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const sent = sentBody(fetchFn)
    expect(sent.options).toEqual({ num_ctx: 2048, num_thread: 4 })
  })

  it('uses a custom baseURL and trims trailing slash', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      baseURL: 'http://my-ollama:11434/',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const [url] = callOf(fetchFn)
    expect(url).toBe('http://my-ollama:11434/api/embed')
  })

  it('does not send Authorization header when apiKey is unset', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('allows header override via headers option', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      apiKey: 'sk-test',
      headers: { 'X-Custom': 'override', 'Authorization': 'Bearer custom-token' },
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const [, init] = callOf(fetchFn)
    const headers = init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('override')
    expect(headers['Authorization']).toBe('Bearer custom-token')
  })
})

// ─── prefix handling ─────────────────────────────────────────────────────────────

describe('OllamaEmbeddingsAdapter — query/document prefix', () => {
  it('applies queryPrefix only for kind: query', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      queryPrefix: 'Q: ',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('cats', { kind: 'query' })
    const sent = sentBody(fetchFn)
    expect(sent.input).toEqual(['Q: cats'])
  })

  it('does not apply queryPrefix for kind: document (default)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      queryPrefix: 'Q: ',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('cats')
    const sent = sentBody(fetchFn)
    expect(sent.input).toEqual(['cats'])
  })

  it('applies documentPrefix for kind: document when set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      documentPrefix: 'D: ',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('cats', { kind: 'document' })
    const sent = sentBody(fetchFn)
    expect(sent.input).toEqual(['D: cats'])
  })
})

// ─── errors / retry ──────────────────────────────────────────────────────────────

describe('OllamaEmbeddingsAdapter — errors & retry', () => {
  it('throws E_OLLAMA_EMBEDDINGS_HTTP_ERROR on a non-retriable non-2xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad' }, { status: 400 }))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OLLAMA_EMBEDDINGS_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries a 503 then succeeds when attempts allow', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const vec = await a.embed('x')
    expect(vec).toEqual([0, 0, 0])
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts on persistent 503', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'busy' }, { status: 503 }))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(a.embed('x')).rejects.toThrow(E_OLLAMA_EMBEDDINGS_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('surfaces a transport failure as HTTP_ERROR with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OLLAMA_EMBEDDINGS_HTTP_ERROR)
  })

  it('throws REQUEST_TIMEOUT when the handshake aborts past requestTimeoutMs', async () => {
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      })
    })
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      requestTimeoutMs: 10,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OLLAMA_EMBEDDINGS_REQUEST_TIMEOUT)
  })

  it('throws MALFORMED_RESPONSE when vector count mismatches input count', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embedMany(['a', 'b'])).rejects.toThrow(E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE)
  })

  it('throws MALFORMED_RESPONSE on malformed JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('not-json', { status: 200 }))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE)
  })

  it('throws MALFORMED_RESPONSE when embeddings field is missing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ model: 'm' }))
    const a = new OllamaEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OLLAMA_EMBEDDINGS_MALFORMED_RESPONSE)
  })
})
