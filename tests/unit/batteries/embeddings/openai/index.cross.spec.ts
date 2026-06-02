import { describe, expect, it, vi } from 'vitest'
import {
  OpenAIEmbeddingsAdapter,
  applyEmbeddingPrefix,
  E_INVALID_OPENAI_EMBEDDINGS_OPTIONS,
  E_OPENAI_EMBEDDINGS_HTTP_ERROR,
  E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT,
  E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE,
} from '../../../../../src/batteries/embeddings/openai'

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

// Build a canned /v1/embeddings success body for `n` inputs, each vector = [i, i, i].
const embeddingsBody = (n: number, dim = 3) => ({
  object: 'list',
  model: 'text-embedding-3-small',
  data: Array.from({ length: n }, (_, i) => ({
    object: 'embedding',
    index: i,
    embedding: Array.from({ length: dim }, () => i),
  })),
  usage: { prompt_tokens: 1, total_tokens: 1 },
})

// ─── construction / validation ─────────────────────────────────────────────────

describe('OpenAIEmbeddingsAdapter — construction', () => {
  it('throws E_INVALID_OPENAI_EMBEDDINGS_OPTIONS when model is missing', () => {
    expect(() => new OpenAIEmbeddingsAdapter({ apiKey: 'sk-test' })).toThrow(
      E_INVALID_OPENAI_EMBEDDINGS_OPTIONS
    )
  })

  it('throws when model is an empty string', () => {
    expect(() => new OpenAIEmbeddingsAdapter({ model: '' })).toThrow(
      E_INVALID_OPENAI_EMBEDDINGS_OPTIONS
    )
  })

  it('throws on unknown option keys', () => {
    expect(
      () => new OpenAIEmbeddingsAdapter({ model: 'text-embedding-3-small', bogus: true })
    ).toThrow(E_INVALID_OPENAI_EMBEDDINGS_OPTIONS)
  })

  it('constructs with a valid model and reports dimensions when configured', () => {
    const a = new OpenAIEmbeddingsAdapter({ model: 'text-embedding-3-small', dimensions: 1536 })
    expect(a.dimensions).toBe(1536)
    expect(a.isAvailable()).toBe(true)
    expect(OpenAIEmbeddingsAdapter.isAvailable()).toBe(true)
  })

  it('preload and reset are no-ops that resolve/return cleanly', async () => {
    const a = new OpenAIEmbeddingsAdapter({ model: 'text-embedding-3-small' })
    await expect(a.preload()).resolves.toBeUndefined()
    expect(a.reset()).toBeUndefined()
  })
})

// ─── embed / embedMany happy path ───────────────────────────────────────────────

describe('OpenAIEmbeddingsAdapter — embed', () => {
  it('embeds a single string and returns a number[]', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const vec = await a.embed('hello')
    expect(Array.isArray(vec)).toBe(true)
    expect(vec).toEqual([0, 0, 0])

    // Verify request shape: POST /embeddings with auth + float encoding.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = callOf(fetchFn)
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
    const sent = JSON.parse(init.body as string)
    expect(sent).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['hello'],
      encoding_format: 'float',
    })
  })

  it('embedMany returns one vector per input in input order', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(3)))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const vecs = await a.embedMany(['a', 'b', 'c'])
    expect(vecs.length).toBe(3)
    expect(vecs[0]).toEqual([0, 0, 0])
    expect(vecs[2]).toEqual([2, 2, 2])
  })

  it('reorders out-of-order response data by index', async () => {
    const scrambled = {
      object: 'list',
      data: [
        { index: 1, embedding: [1, 1] },
        { index: 0, embedding: [0, 0] },
      ],
    }
    const fetchFn = vi.fn(async () => jsonResponse(scrambled))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const vecs = await a.embedMany(['x', 'y'])
    expect(vecs[0]).toEqual([0, 0])
    expect(vecs[1]).toEqual([1, 1])
  })

  it('returns [] for an empty batch without calling fetch', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(0)))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    expect(await a.embedMany([])).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('forwards configured dimensions in the request body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1, 4)))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'text-embedding-3-large',
      dimensions: 256,
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('hi')
    const sent = sentBody(fetchFn)
    expect(sent.dimensions).toBe(256)
  })
})

// ─── prefix handling ─────────────────────────────────────────────────────────────

describe('OpenAIEmbeddingsAdapter — query/document prefix', () => {
  it('applies queryPrefix only for kind: query', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OpenAIEmbeddingsAdapter({
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
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      queryPrefix: 'Q: ',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.embed('cats')
    const sent = sentBody(fetchFn)
    expect(sent.input).toEqual(['cats'])
  })

  it('applyEmbeddingPrefix is pure and does not mutate input', () => {
    const input = ['a', 'b']
    const out = applyEmbeddingPrefix(input, 'query', { queryPrefix: 'P:' })
    expect(out).toEqual(['P:a', 'P:b'])
    expect(input).toEqual(['a', 'b'])
    expect(applyEmbeddingPrefix(input, 'document', { queryPrefix: 'P:' })).toEqual(['a', 'b'])
  })
})

// ─── errors / retry ──────────────────────────────────────────────────────────────

describe('OpenAIEmbeddingsAdapter — errors & retry', () => {
  it('throws E_OPENAI_EMBEDDINGS_HTTP_ERROR on a non-retriable non-2xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad' }, { status: 400 }))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OPENAI_EMBEDDINGS_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries a 503 then succeeds when attempts allow', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(embeddingsBody(1)))
    const a = new OpenAIEmbeddingsAdapter({
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
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(a.embed('x')).rejects.toThrow(E_OPENAI_EMBEDDINGS_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('surfaces a transport failure as HTTP_ERROR with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OPENAI_EMBEDDINGS_HTTP_ERROR)
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
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      requestTimeoutMs: 10,
    })
    await expect(a.embed('x')).rejects.toThrow(E_OPENAI_EMBEDDINGS_REQUEST_TIMEOUT)
  })

  it('throws MALFORMED_RESPONSE when vector count mismatches input count', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(embeddingsBody(1)))
    const a = new OpenAIEmbeddingsAdapter({
      model: 'm',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.embedMany(['a', 'b'])).rejects.toThrow(E_OPENAI_EMBEDDINGS_MALFORMED_RESPONSE)
  })
})
