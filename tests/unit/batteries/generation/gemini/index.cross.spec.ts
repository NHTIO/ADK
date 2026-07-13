import { describe, expect, it, vi } from 'vitest'
import {
  GeminiGenerationAdapter,
  E_INVALID_GEMINI_GENERATION_OPTIONS,
  E_GEMINI_GENERATION_HTTP_ERROR,
  E_GEMINI_GENERATION_REQUEST_TIMEOUT,
  E_GEMINI_GENERATION_MALFORMED_RESPONSE,
} from '../../../../../src/batteries/generation/gemini'

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

// Known 4 bytes and their base64 encoding, used to assert exact decode/encode correctness.
const KNOWN_BYTES = new Uint8Array([1, 2, 3, 4])
const KNOWN_B64 = 'AQIDBA==' // base64 of [1,2,3,4]

const imagePart = (b64 = KNOWN_B64, mimeType = 'image/png') => ({
  inlineData: { mimeType, data: b64 },
})

const snakeImagePart = (b64 = KNOWN_B64, mimeType = 'image/png') => ({
  inline_data: { mimeType, data: b64 },
})

const candidatesBody = (parts: unknown[]) => ({
  candidates: [{ content: { parts } }],
})

// ─── construction / validation ─────────────────────────────────────────────────

describe('GeminiGenerationAdapter — construction', () => {
  it('throws E_INVALID_GEMINI_GENERATION_OPTIONS when model is missing', () => {
    expect(() => new GeminiGenerationAdapter({ apiKey: 'key-test' })).toThrow(
      E_INVALID_GEMINI_GENERATION_OPTIONS
    )
  })

  it('throws when model is an empty string', () => {
    expect(() => new GeminiGenerationAdapter({ model: '' })).toThrow(
      E_INVALID_GEMINI_GENERATION_OPTIONS
    )
  })

  it('throws on unknown option keys', () => {
    expect(
      () => new GeminiGenerationAdapter({ model: 'gemini-2.5-flash-image', bogus: true })
    ).toThrow(E_INVALID_GEMINI_GENERATION_OPTIONS)
  })

  it('throws on an invalid responseModalities entry', () => {
    expect(
      () =>
        new GeminiGenerationAdapter({
          model: 'gemini-2.5-flash-image',
          responseModalities: ['TEXT', 'AUDIO'],
        })
    ).toThrow(E_INVALID_GEMINI_GENERATION_OPTIONS)
  })

  it('throws on a non-array responseModalities', () => {
    expect(
      () =>
        new GeminiGenerationAdapter({
          model: 'gemini-2.5-flash-image',
          responseModalities: 'IMAGE',
        })
    ).toThrow(E_INVALID_GEMINI_GENERATION_OPTIONS)
  })

  it('constructs with a valid minimal model', () => {
    const a = new GeminiGenerationAdapter({ model: 'gemini-2.5-flash-image' })
    expect(a.isAvailable()).toBe(true)
    expect(GeminiGenerationAdapter.isAvailable()).toBe(true)
  })

  it('constructs with a full valid option set', () => {
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      apiKey: 'key-test',
      baseURL: 'https://example.test/v1beta',
      headers: { 'X-Extra': '1' },
      retry: { maxAttempts: 2 },
      requestTimeoutMs: 5000,
      responseModalities: ['TEXT', 'IMAGE'],
      aspectRatio: '16:9',
    })
    expect(a.isAvailable()).toBe(true)
  })

  it('preload and reset are no-ops that resolve/return cleanly', async () => {
    const a = new GeminiGenerationAdapter({ model: 'gemini-2.5-flash-image' })
    await expect(a.preload()).resolves.toBeUndefined()
    expect(a.reset()).toBeUndefined()
  })
})

// ─── URL construction ───────────────────────────────────────────────────────────

describe('GeminiGenerationAdapter — URL construction', () => {
  it('uses the default base URL, interpolating the model', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent'
    )
  })

  it('uses a custom base URL (e.g. an LB origin)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      baseURL: 'https://lb.example.com/v1beta',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe('https://lb.example.com/v1beta/models/gemini-2.5-flash-image:generateContent')
  })

  it('trims a trailing slash from baseURL', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      baseURL: 'https://lb.example.com/v1beta/',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe('https://lb.example.com/v1beta/models/gemini-2.5-flash-image:generateContent')
  })

  it('interpolates a different model id', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-3-pro-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent'
    )
  })
})

// ─── auth / headers ─────────────────────────────────────────────────────────────

describe('GeminiGenerationAdapter — auth & headers', () => {
  it('sends no x-goog-api-key header when apiKey is unset', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBeUndefined()
  })

  it('sends x-goog-api-key when apiKey is set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      apiKey: 'key-test',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key-test')
  })

  it('caller headers override built defaults, including x-goog-api-key', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      apiKey: 'key-test',
      headers: { 'x-goog-api-key': 'overridden' },
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('overridden')
  })

  it('LB case: no x-goog-api-key when apiKey unset + Authorization provided via headers', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      headers: { Authorization: 'Bearer lb-token' },
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    const headers = init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBeUndefined()
    expect(headers['Authorization']).toBe('Bearer lb-token')
  })

  it('sets Content-Type: application/json', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})

// ─── generate request body ──────────────────────────────────────────────────────

describe('GeminiGenerationAdapter — generate request body', () => {
  it('sends the exact minimal JSON body (default responseModalities, no aspectRatio/candidateCount)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a red bicycle')
    const [, init] = callOf(fetchFn)
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'a red bicycle' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    })
  })

  it('overrides responseModalities via constructor option', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      responseModalities: ['IMAGE'],
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.generationConfig.responseModalities).toEqual(['IMAGE'])
  })

  it('omits candidateCount when n is 1 or unset', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat', { n: 1 })
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.generationConfig.candidateCount).toBeUndefined()
  })

  it('includes candidateCount when n > 1 (best-effort)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('three cats', { n: 3 })
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.generationConfig.candidateCount).toBe(3)
  })

  it('omits imageConfig when aspectRatio is unset', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.generationConfig.imageConfig).toBeUndefined()
  })

  it('includes imageConfig.aspectRatio from the constructor default', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      aspectRatio: '16:9',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' })
  })

  it('a per-call aspectRatio overrides the constructor default', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      aspectRatio: '16:9',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat', { aspectRatio: '1:1' })
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' })
  })
})

// ─── edit request body ──────────────────────────────────────────────────────────

describe('GeminiGenerationAdapter — edit request body', () => {
  it('places image parts before the text prompt, single input', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(KNOWN_BYTES, 'add a hat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: KNOWN_B64 } },
      { text: 'add a hat' },
    ])
  })

  it('preserves order across multiple inputs, text still last', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const first = new Uint8Array([1])
    const second = new Uint8Array([2])
    await a.edit([first, second], 'combine these')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AQ==' } },
      { inlineData: { mimeType: 'image/png', data: 'Ag==' } },
      { text: 'combine these' },
    ])
  })

  it('propagates mimeType from a GenerationBytesInput / toBytes result', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit({ bytes: KNOWN_BYTES, mimeType: 'image/jpeg' }, 'add a hat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: KNOWN_B64 },
    })
  })

  it('defaults mimeType to image/png for a bare Uint8Array (unknown mime)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(KNOWN_BYTES, 'add a hat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.contents[0].parts[0].inlineData.mimeType).toBe('image/png')
  })

  it('base64-encodes the exact known bytes correctly', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(KNOWN_BYTES, 'add a hat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.contents[0].parts[0].inlineData.data).toBe(KNOWN_B64)
  })
})

// ─── response mapping ───────────────────────────────────────────────────────────

describe('GeminiGenerationAdapter — response mapping', () => {
  it('parses camelCase inlineData parts', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs).toHaveLength(1)
    expect(outputs[0].bytes).toEqual(KNOWN_BYTES)
    expect(outputs[0].kind).toBe('image')
    expect(outputs[0].mimeType).toBe('image/png')
    expect(outputs[0].filename).toBe('generated-1.png')
  })

  it('tolerates snake_case inline_data parts', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(candidatesBody([snakeImagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs).toHaveLength(1)
    expect(outputs[0].bytes).toEqual(KNOWN_BYTES)
  })

  it('mixed text + image parts: only images are returned', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(candidatesBody([{ text: 'here you go' }, imagePart()]))
    )
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs).toHaveLength(1)
    expect(outputs[0].bytes).toEqual(KNOWN_BYTES)
  })

  it('multi-image response: distinct filenames in order', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        candidatesBody([imagePart(KNOWN_B64, 'image/png'), imagePart(KNOWN_B64, 'image/jpeg')])
      )
    )
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('two cats', { n: 2 })
    expect(outputs).toHaveLength(2)
    expect(outputs.map((o) => o.filename)).toEqual(['generated-1.png', 'generated-2.jpg'])
    expect(outputs.map((o) => o.mimeType)).toEqual(['image/png', 'image/jpeg'])
  })

  it('derives the extension from the mime type (webp)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(candidatesBody([imagePart(KNOWN_B64, 'image/webp')]))
    )
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs[0].mimeType).toBe('image/webp')
    expect(outputs[0].filename).toBe('generated-1.webp')
  })

  it('defaults mimeType to image/png when a response part omits it', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(candidatesBody([{ inlineData: { data: KNOWN_B64 } }]))
    )
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs[0].mimeType).toBe('image/png')
  })
})

// ─── refusal surface ─────────────────────────────────────────────────────────────

describe('GeminiGenerationAdapter — refusal surface', () => {
  it('2xx with text-only parts throws MALFORMED_RESPONSE including the text', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(candidatesBody([{ text: "I can't create that image." }]))
    )
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('something unsafe')).rejects.toThrow(
      E_GEMINI_GENERATION_MALFORMED_RESPONSE
    )
    try {
      await a.generate('something unsafe')
      expect.fail('expected a throw')
    } catch (err) {
      expect((err as Error).message).toContain("I can't create that image.")
    }
  })
})

// ─── error core: retry / timeout / transport ────────────────────────────────────

describe('GeminiGenerationAdapter — errors & retry', () => {
  it('throws E_GEMINI_GENERATION_HTTP_ERROR on a non-retriable non-2xx (400), no retry', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad' }, { status: 400 }))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_GEMINI_GENERATION_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries a 503 then succeeds when attempts allow', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(candidatesBody([imagePart()])))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const outputs = await a.generate('x')
    expect(outputs).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts on persistent 503 (retry exhaustion)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'busy' }, { status: 503 }))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(a.generate('x')).rejects.toThrow(E_GEMINI_GENERATION_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('surfaces a transport failure (fetch rejects) as HTTP_ERROR with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_GEMINI_GENERATION_HTTP_ERROR)
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
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      requestTimeoutMs: 10,
    })
    await expect(a.generate('x')).rejects.toThrow(E_GEMINI_GENERATION_REQUEST_TIMEOUT)
  })

  it('throws MALFORMED_RESPONSE when the 2xx body has no candidates', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_GEMINI_GENERATION_MALFORMED_RESPONSE)
  })

  it('throws MALFORMED_RESPONSE when candidates is an empty array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ candidates: [] }))
    const a = new GeminiGenerationAdapter({
      model: 'gemini-2.5-flash-image',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_GEMINI_GENERATION_MALFORMED_RESPONSE)
  })
})
