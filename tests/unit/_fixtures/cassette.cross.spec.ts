import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildChatCompletion,
  buildErrorResponse,
  buildStreamingChatCompletionFrames,
  buildStreamingResponse,
  cassetteFetch,
  materializeCassetteResponse,
  resetCassetteIds,
  singleChatCompletionCassette,
  singleStreamingCassette,
  type Cassette,
  type SSEFrame,
} from '../../_fixtures/cassette'

const readSSE = async (resp: Response): Promise<string> => {
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

beforeEach(() => {
  resetCassetteIds()
})

describe('cassette / buildChatCompletion', () => {
  it('produces a well-formed chat.completion body with assistant content', () => {
    const body = buildChatCompletion({ content: 'hi', model: 'gpt-x' })
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('gpt-x')
    const choices = body.choices as Array<{
      message: { role: string; content: string }
      finish_reason: string
    }>
    expect(choices[0].message.role).toBe('assistant')
    expect(choices[0].message.content).toBe('hi')
    expect(choices[0].finish_reason).toBe('stop')
  })

  it('emits tool_calls and switches finish_reason to "tool_calls" by default', () => {
    const body = buildChatCompletion({
      toolCalls: [{ name: 'add', arguments: { a: 1, b: 2 } }],
    })
    const choices = body.choices as Array<{
      message: {
        content: string | null
        tool_calls: Array<{
          id: string
          type: string
          function: { name: string; arguments: string }
        }>
      }
      finish_reason: string
    }>
    expect(choices[0].message.content).toBeNull()
    expect(choices[0].finish_reason).toBe('tool_calls')
    expect(choices[0].message.tool_calls[0].function.name).toBe('add')
    expect(JSON.parse(choices[0].message.tool_calls[0].function.arguments)).toEqual({
      a: 1,
      b: 2,
    })
  })

  it('uses deterministic ids when resetCassetteIds() is called', () => {
    resetCassetteIds()
    const a = buildChatCompletion({ content: 'a' }).id
    const b = buildChatCompletion({ content: 'b' }).id
    resetCassetteIds()
    const a2 = buildChatCompletion({ content: 'a' }).id
    expect(a).not.toBe(b)
    expect(a).toBe(a2)
  })
})

describe('cassette / buildStreamingChatCompletionFrames', () => {
  it('emits role on first frame and content deltas thereafter, then a stop frame', () => {
    const frames = buildStreamingChatCompletionFrames({
      deltas: ['hi', ' there'],
      model: 'gpt-x',
    })
    expect(frames.length).toBe(3) // first delta+role, second delta, stop
    const f0 = (frames[0] as { json: { choices: [{ delta: { role: string; content: string } }] } })
      .json
    expect(f0.choices[0].delta.role).toBe('assistant')
    expect(f0.choices[0].delta.content).toBe('hi')
    const f1 = (frames[1] as { json: { choices: [{ delta: { content: string } }] } }).json
    expect(f1.choices[0].delta.content).toBe(' there')
    const f2 = (frames[2] as { json: { choices: [{ finish_reason: string }] } }).json
    expect(f2.choices[0].finish_reason).toBe('stop')
  })

  it('emits a terminal usage frame when stream_options.include_usage is implied', () => {
    const frames = buildStreamingChatCompletionFrames({
      deltas: ['x'],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })
    const last = (
      frames[frames.length - 1] as {
        json: { usage: { total_tokens: number } }
      }
    ).json
    expect(last.usage.total_tokens).toBe(3)
  })

  it('emits reasoning_content frames when supplied', () => {
    const frames = buildStreamingChatCompletionFrames({
      deltas: ['answer'],
      reasoningDeltas: ['thinking...'],
    })
    const hasReasoning = frames.some((f) => {
      if (typeof f !== 'object' || f === null || !('json' in f)) return false
      const j = f.json as { choices?: [{ delta?: { reasoning_content?: string } }] }
      return !!j.choices?.[0]?.delta?.reasoning_content
    })
    expect(hasReasoning).toBe(true)
  })

  it('emits tool_call deltas with index/id/type/function chunks', () => {
    const frames = buildStreamingChatCompletionFrames({
      toolCallDeltas: [
        { index: 0, id: 'call_1', type: 'function', name: 'do_it' },
        { index: 0, argumentsChunk: '{"x"' },
        { index: 0, argumentsChunk: ':1}' },
      ],
      finishReason: 'tool_calls',
    })
    // 3 tc delta frames + 1 finish frame
    expect(frames.length).toBe(4)
    const first = (
      frames[0] as {
        json: { choices: [{ delta: { tool_calls: [{ id: string; function: { name: string } }] } }] }
      }
    ).json
    expect(first.choices[0].delta.tool_calls[0].id).toBe('call_1')
    expect(first.choices[0].delta.tool_calls[0].function.name).toBe('do_it')
  })
})

describe('cassette / buildStreamingResponse', () => {
  it('appends the [DONE] terminator', () => {
    const frames = buildStreamingResponse({ deltas: ['ok'] })
    expect(frames[frames.length - 1]).toBe('[DONE]')
  })
})

describe('cassette / buildErrorResponse', () => {
  it('produces a non-2xx response with retry-after when supplied', () => {
    const r = buildErrorResponse({ status: 429, retryAfter: 5 })
    expect(r.status).toBe(429)
    expect(r.headers?.['retry-after']).toBe('5')
    expect((r.body as { error: { message: string } }).error.message).toBe('HTTP 429')
  })
})

describe('cassette / materializeCassetteResponse', () => {
  it('serialises a JSON body with application/json content-type', async () => {
    const resp = materializeCassetteResponse({ body: { ok: true } })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toBe('application/json')
    expect(await resp.json()).toEqual({ ok: true })
  })

  it('serialises SSE frames into a streaming body with the right content-type', async () => {
    const resp = materializeCassetteResponse({
      sse: [{ json: { foo: 1 } }, '[DONE]'] as SSEFrame[],
    })
    expect(resp.headers.get('content-type')).toBe('text/event-stream')
    const txt = await readSSE(resp)
    expect(txt).toContain('data: {"foo":1}\n\n')
    expect(txt).toContain('data: [DONE]\n\n')
  })

  it('emits comment frames as ":<text>\\n\\n"', async () => {
    const resp = materializeCassetteResponse({
      sse: [{ comment: 'keep-alive' }, '[DONE]'] as SSEFrame[],
    })
    const txt = await readSSE(resp)
    expect(txt).toContain(':keep-alive\n\n')
  })

  it('aborts the stream when an error frame is encountered', async () => {
    const resp = materializeCassetteResponse({
      sse: [{ json: { ok: 1 } }, { error: 'boom' }] as SSEFrame[],
    })
    const reader = resp.body!.getReader()
    let errorMsg = ''
    try {
      // Consume until the stream errors. The first read returns the JSON frame;
      // a subsequent read should reject with the error frame's payload.

      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch (e) {
      errorMsg = (e as Error).message
    }
    expect(errorMsg).toMatch(/boom/)
  })

  it('honours delayMs frames (non-blocking pause)', async () => {
    const start = Date.now()
    const resp = materializeCassetteResponse({
      sse: [{ delayMs: 25 }, { json: { ok: 1 } }, '[DONE]'] as SSEFrame[],
    })
    await readSSE(resp)
    expect(Date.now() - start).toBeGreaterThanOrEqual(20)
  })
})

describe('cassette / cassetteFetch — once mode (default)', () => {
  it('matches a permissive interaction and returns the response', async () => {
    const cassette = singleChatCompletionCassette('one', { content: 'hi' })
    const fetchFn = cassetteFetch(cassette)
    const resp = await fetchFn('https://x/y/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
    })
    const body = (await resp.json()) as { choices: [{ message: { content: string } }] }
    expect(body.choices[0].message.content).toBe('hi')
  })

  it('rejects extra calls with a descriptive error when all interactions are consumed', async () => {
    const cassette = singleChatCompletionCassette('one', { content: 'hi' })
    const fetchFn = cassetteFetch(cassette)
    await fetchFn('https://x/y/chat/completions', { method: 'POST', body: '{}' })
    await expect(
      fetchFn('https://x/y/chat/completions', { method: 'POST', body: '{}' })
    ).rejects.toThrow(/no interaction matched/)
  })

  it('throws when no interaction matches the request and includes remaining labels', async () => {
    const cassette: Cassette = {
      name: 'mismatched',
      interactions: [
        {
          label: 'expects-GET',
          request: { method: 'GET' },
          response: { body: { ok: true } },
        },
      ],
    }
    const fetchFn = cassetteFetch(cassette)
    await expect(fetchFn('https://x/y', { method: 'POST', body: '{}' })).rejects.toThrow(
      /expects-GET/
    )
  })

  it('matches by JSON body partial-include', async () => {
    const cassette: Cassette = {
      name: 'body-match',
      interactions: [
        {
          request: { body: { model: 'gpt-x' } },
          response: { body: { matched: 'gpt-x' } },
        },
        {
          request: { body: { model: 'other' } },
          response: { body: { matched: 'other' } },
        },
      ],
    }
    const fetchFn = cassetteFetch(cassette)
    const r1 = await fetchFn('https://x', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-x', extra: true }),
    })
    expect(await r1.json()).toEqual({ matched: 'gpt-x' })
    const r2 = await fetchFn('https://x', {
      method: 'POST',
      body: JSON.stringify({ model: 'other' }),
    })
    expect(await r2.json()).toEqual({ matched: 'other' })
  })

  it('matches by URL RegExp', async () => {
    const cassette: Cassette = {
      name: 'url-regex',
      interactions: [
        {
          request: { url: /\/chat\/completions$/ },
          response: { body: { ok: 'chat' } },
        },
      ],
    }
    const fetchFn = cassetteFetch(cassette)
    const r = await fetchFn('https://anything.invalid/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    expect(await r.json()).toEqual({ ok: 'chat' })
  })

  it('matches by required headers', async () => {
    const cassette: Cassette = {
      name: 'header-match',
      interactions: [
        {
          request: { headers: { authorization: 'Bearer xyz' } },
          response: { body: { ok: true } },
        },
      ],
    }
    const fetchFn = cassetteFetch(cassette)
    await expect(
      fetchFn('https://x', { method: 'POST', headers: { authorization: 'Bearer wrong' } })
    ).rejects.toThrow(/no interaction matched/)
    const ok = await fetchFn('https://x', {
      method: 'POST',
      headers: { authorization: 'Bearer xyz' },
    })
    expect(await ok.json()).toEqual({ ok: true })
  })

  it('consumes interactions in order even when later ones would also match', async () => {
    const cassette: Cassette = {
      name: 'ordered',
      interactions: [
        { label: 'first', response: { body: { n: 1 } } },
        { label: 'second', response: { body: { n: 2 } } },
      ],
    }
    const fetchFn = cassetteFetch(cassette)
    const r1 = await fetchFn('https://x', { method: 'POST' })
    expect(await r1.json()).toEqual({ n: 1 })
    const r2 = await fetchFn('https://x', { method: 'POST' })
    expect(await r2.json()).toEqual({ n: 2 })
  })
})

describe('cassette / cassetteFetch — reusable mode', () => {
  it('serves the same interaction repeatedly when mode is "reusable"', async () => {
    const cassette: Cassette = {
      name: 'reusable',
      mode: 'reusable',
      interactions: [{ response: { body: { n: 'same' } } }],
    }
    const fetchFn = cassetteFetch(cassette)
    for (let i = 0; i < 5; i++) {
      const resp = await fetchFn('https://x', { method: 'POST' })
      expect(await resp.json()).toEqual({ n: 'same' })
    }
  })
})

describe('cassette / singleStreamingCassette convenience', () => {
  it('returns a streaming response that concatenates to the supplied deltas', async () => {
    const cassette = singleStreamingCassette('stream-one', {
      deltas: ['hi', ' there'],
    })
    const fetchFn = cassetteFetch(cassette)
    const resp = await fetchFn('https://x/chat/completions', {
      method: 'POST',
      body: '{}',
    })
    const txt = await readSSE(resp)
    expect(txt).toContain('"hi"')
    expect(txt).toContain('" there"')
    expect(txt).toContain('data: [DONE]\n\n')
  })
})
