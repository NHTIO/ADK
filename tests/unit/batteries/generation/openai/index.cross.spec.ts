import { describe, expect, it, vi } from 'vitest'
import {
  OpenAIGenerationAdapter,
  EDIT_IMAGE_FIELD_NAME,
  E_INVALID_OPENAI_GENERATION_OPTIONS,
  E_OPENAI_GENERATION_HTTP_ERROR,
  E_OPENAI_GENERATION_REQUEST_TIMEOUT,
  E_OPENAI_GENERATION_MALFORMED_RESPONSE,
} from '../../../../../src/batteries/generation/openai'

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

// Known 4 bytes and their base64 encoding, used to assert exact decode correctness.
const KNOWN_BYTES = new Uint8Array([1, 2, 3, 4])
const KNOWN_B64 = 'AQIDBA==' // base64 of [1,2,3,4]

const imagesBody = (n: number, b64 = KNOWN_B64) => ({
  data: Array.from({ length: n }, () => ({ b64_json: b64 })),
})

// ─── construction / validation ─────────────────────────────────────────────────

describe('OpenAIGenerationAdapter — construction', () => {
  it('throws E_INVALID_OPENAI_GENERATION_OPTIONS when model is missing', () => {
    expect(() => new OpenAIGenerationAdapter({ apiKey: 'sk-test' })).toThrow(
      E_INVALID_OPENAI_GENERATION_OPTIONS
    )
  })

  it('throws when model is an empty string', () => {
    expect(() => new OpenAIGenerationAdapter({ model: '' })).toThrow(
      E_INVALID_OPENAI_GENERATION_OPTIONS
    )
  })

  it('throws on unknown option keys', () => {
    expect(() => new OpenAIGenerationAdapter({ model: 'gpt-image-1', bogus: true })).toThrow(
      E_INVALID_OPENAI_GENERATION_OPTIONS
    )
  })

  it('throws on an invalid quality enum value', () => {
    expect(() => new OpenAIGenerationAdapter({ model: 'gpt-image-1', quality: 'ultra' })).toThrow(
      E_INVALID_OPENAI_GENERATION_OPTIONS
    )
  })

  it('throws on an invalid outputFormat enum value', () => {
    expect(
      () => new OpenAIGenerationAdapter({ model: 'gpt-image-1', outputFormat: 'bmp' })
    ).toThrow(E_INVALID_OPENAI_GENERATION_OPTIONS)
  })

  it('throws on an invalid background enum value', () => {
    expect(
      () => new OpenAIGenerationAdapter({ model: 'gpt-image-1', background: 'blurred' })
    ).toThrow(E_INVALID_OPENAI_GENERATION_OPTIONS)
  })

  it('throws on an invalid responseFormatMode enum value', () => {
    expect(
      () => new OpenAIGenerationAdapter({ model: 'gpt-image-1', responseFormatMode: 'weird' })
    ).toThrow(E_INVALID_OPENAI_GENERATION_OPTIONS)
  })

  it('constructs with a valid minimal model', () => {
    const a = new OpenAIGenerationAdapter({ model: 'gpt-image-1' })
    expect(a.isAvailable()).toBe(true)
    expect(OpenAIGenerationAdapter.isAvailable()).toBe(true)
  })

  it('constructs with a full valid option set', () => {
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      apiKey: 'sk-test',
      baseURL: 'https://example.test/v1',
      headers: { 'X-Extra': '1' },
      retry: { maxAttempts: 2 },
      requestTimeoutMs: 5000,
      size: '1024x1024',
      quality: 'high',
      outputFormat: 'png',
      background: 'transparent',
      responseFormatMode: 'auto',
    })
    expect(a.isAvailable()).toBe(true)
  })

  it('preload and reset are no-ops that resolve/return cleanly', async () => {
    const a = new OpenAIGenerationAdapter({ model: 'gpt-image-1' })
    await expect(a.preload()).resolves.toBeUndefined()
    expect(a.reset()).toBeUndefined()
  })
})

// ─── URL construction ───────────────────────────────────────────────────────────

describe('OpenAIGenerationAdapter — URL construction', () => {
  it('uses the default base URL', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe('https://api.openai.com/v1/images/generations')
  })

  it('uses a custom base URL', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      baseURL: 'https://gateway.example.com/v1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe('https://gateway.example.com/v1/images/generations')
  })

  it('trims a trailing slash from baseURL', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      baseURL: 'https://gateway.example.com/v1/',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [url] = callOf(fetchFn)
    expect(url).toBe('https://gateway.example.com/v1/images/generations')
  })
})

// ─── auth / headers ─────────────────────────────────────────────────────────────

describe('OpenAIGenerationAdapter — auth & headers', () => {
  it('sends no Authorization header when apiKey is unset', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('sends Bearer auth when apiKey is set', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      apiKey: 'sk-test',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
  })

  it('caller headers override built defaults, including Authorization', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      apiKey: 'sk-test',
      headers: { Authorization: 'Bearer overridden' },
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer overridden')
  })

  it('the JSON path (generate) sets Content-Type: application/json', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const [, init] = callOf(fetchFn)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})

// ─── generate body / response_format matrix ─────────────────────────────────────

describe('OpenAIGenerationAdapter — generate request body', () => {
  it('sends exact JSON body including all knobs', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'dall-e-3',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a red bicycle', {
      n: 2,
      size: '512x512',
      quality: 'high',
      outputFormat: 'jpeg',
      background: 'opaque',
    })
    const [, init] = callOf(fetchFn)
    const sent = JSON.parse(init.body as string)
    expect(sent).toEqual({
      model: 'dall-e-3',
      prompt: 'a red bicycle',
      n: 2,
      size: '512x512',
      quality: 'high',
      output_format: 'jpeg',
      background: 'opaque',
      response_format: 'b64_json',
    })
  })

  it('response_format auto + gpt-image-1 → absent', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.response_format).toBeUndefined()
  })

  it('response_format auto + dall-e-3 → b64_json', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'dall-e-3',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.response_format).toBe('b64_json')
  })

  it('response_format mode "send" → present regardless of model', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      responseFormatMode: 'send',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.response_format).toBe('b64_json')
  })

  it('response_format mode "omit" → absent regardless of model', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'dall-e-3',
      responseFormatMode: 'omit',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.generate('a cat')
    const sent = JSON.parse(callOf(fetchFn)[1].body as string)
    expect(sent.response_format).toBeUndefined()
  })
})

// ─── b64 decode correctness ─────────────────────────────────────────────────────

describe('OpenAIGenerationAdapter — b64 decode correctness', () => {
  it('decodes a known b64_json into the exact expected Uint8Array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs).toHaveLength(1)
    expect(outputs[0].bytes).toEqual(KNOWN_BYTES)
    expect(outputs[0].kind).toBe('image')
    expect(outputs[0].mimeType).toBe('image/png')
    expect(outputs[0].filename).toBe('generated-1.png')
  })

  it('n > 1 produces one output per image with distinct filenames', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(3)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('three cats', { n: 3 })
    expect(outputs).toHaveLength(3)
    expect(outputs.map((o) => o.filename)).toEqual([
      'generated-1.png',
      'generated-2.png',
      'generated-3.png',
    ])
    for (const o of outputs) {
      expect(o.bytes).toEqual(KNOWN_BYTES)
    }
  })

  it('respects a configured outputFormat in mimeType + filename extension', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      outputFormat: 'webp',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.generate('a cat')
    expect(outputs[0].mimeType).toBe('image/webp')
    expect(outputs[0].filename).toBe('generated-1.webp')
  })
})

// ─── multipart edit ─────────────────────────────────────────────────────────────

describe('OpenAIGenerationAdapter — edit (multipart)', () => {
  it('sends a FormData body without a Content-Type header', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      apiKey: 'sk-test',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(new Uint8Array([1, 2, 3]), 'add a hat')
    const [, init] = callOf(fetchFn)
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    // Authorization still applies to the multipart path.
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
  })

  it(`appends each image under the "${EDIT_IMAGE_FIELD_NAME}" field as a Blob with type + filename`, async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit({ bytes: new Uint8Array([9, 9, 9]), mimeType: 'image/jpeg' }, 'add a hat')
    const [, init] = callOf(fetchFn)
    const form = init.body as FormData
    const entries = form.getAll(EDIT_IMAGE_FIELD_NAME)
    expect(entries).toHaveLength(1)
    const blob = entries[0] as File
    expect(blob.type).toBe('image/jpeg')
    expect(blob.name).toBe('input-1.png')
  })

  it('includes prompt and model fields', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(new Uint8Array([1]), 'add a hat')
    const [, init] = callOf(fetchFn)
    const form = init.body as FormData
    expect(form.get('prompt')).toBe('add a hat')
    expect(form.get('model')).toBe('gpt-image-1')
  })

  it('appends a mask field when provided', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(new Uint8Array([1]), 'add a hat', {
      mask: { bytes: new Uint8Array([2]), mimeType: 'image/png' },
    })
    const [, init] = callOf(fetchFn)
    const form = init.body as FormData
    const mask = form.get('mask') as File
    expect(mask).toBeTruthy()
    expect(mask.type).toBe('image/png')
  })

  it('does not append a mask field when omitted', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit(new Uint8Array([1]), 'add a hat')
    const [, init] = callOf(fetchFn)
    const form = init.body as FormData
    expect(form.get('mask')).toBeNull()
  })

  it('multiple inputs produce multiple image[] entries', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await a.edit([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])], 'combine these')
    const [, init] = callOf(fetchFn)
    const form = init.body as FormData
    const entries = form.getAll(EDIT_IMAGE_FIELD_NAME)
    expect(entries).toHaveLength(3)
  })

  it('decodes edit response b64_json into the expected Uint8Array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    const outputs = await a.edit(new Uint8Array([1]), 'add a hat')
    expect(outputs[0].bytes).toEqual(KNOWN_BYTES)
  })
})

// ─── retry / timeout / error handling ───────────────────────────────────────────

describe('OpenAIGenerationAdapter — errors & retry', () => {
  it('throws E_OPENAI_GENERATION_HTTP_ERROR on a non-retriable non-2xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad' }, { status: 400 }))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retries a 503 then succeeds when attempts allow', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(imagesBody(1)))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    })
    const outputs = await a.generate('x')
    expect(outputs).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxAttempts on persistent 503', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'busy' }, { status: 503 }))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_HTTP_ERROR)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('surfaces a transport failure (fetch rejects) as HTTP_ERROR with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_HTTP_ERROR)
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
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      requestTimeoutMs: 10,
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_REQUEST_TIMEOUT)
  })

  it('throws MALFORMED_RESPONSE on an empty object body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_MALFORMED_RESPONSE)
  })

  it('throws MALFORMED_RESPONSE when data is an empty array', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [] }))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_MALFORMED_RESPONSE)
  })

  it('throws MALFORMED_RESPONSE when an entry is missing b64_json', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{}] }))
    const a = new OpenAIGenerationAdapter({
      model: 'gpt-image-1',
      fetch: fetchFn as unknown as typeof globalThis.fetch,
    })
    await expect(a.generate('x')).rejects.toThrow(E_OPENAI_GENERATION_MALFORMED_RESPONSE)
  })
})
