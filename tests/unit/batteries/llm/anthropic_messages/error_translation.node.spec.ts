import { describe, expect, it, vi } from 'vitest'
import { default as Anthropic } from '@anthropic-ai/sdk'
import { APIError, APIConnectionError } from '@anthropic-ai/sdk/core/error'
import { translateAnthropicError } from '../../../../../src/batteries/llm/anthropic_messages/error_translation'

const RETRIABLE = [429, 502, 503, 504, 529] as const

/**
 * Drive the REAL `@anthropic-ai/sdk` client with an injected `fetch`, and hand the REAL thrown error
 * to the classifier. This is the shape issue #46 was measured against: the SDK's error classes were
 * only ever fed to the classifier as hand-built instances of the SAME module, so the bundled-copy
 * identity mismatch never appeared. The client here imports the module the battery itself imports.
 */
const thrownByRealClient = async (
  status: number,
  headers: Record<string, string> = { 'content-type': 'application/json' }
): Promise<unknown> => {
  const client = new Anthropic({
    apiKey: 'sk-ant-test-key',
    maxRetries: 0,
    fetch: (async () =>
      new Response('{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}', {
        status,
        headers,
      })) as never,
  })
  try {
    await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    })
  } catch (err) {
    return err
  }
  throw new Error('the SDK did not throw for status ' + status)
}

describe('translateAnthropicError — REAL SDK-thrown HTTP errors (issue #46)', () => {
  it.each([429, 502, 503, 504, 529])('%s is retriable with its real status', async (status) => {
    const err = await thrownByRealClient(status)
    // The regression itself: the thrown value must BE an APIError from the same module the
    // classifier narrows against, not a bundled copy. `translateAnthropicError` is structural, so
    // this assertion is about the SDK's own thrown shape, not the classifier's implementation.
    expect(err).toBeInstanceOf(APIError)
    expect(translateAnthropicError(err, RETRIABLE)).toMatchObject({
      kind: 'retriable',
      status,
    })
  })

  it.each([400, 401])('%s is fatal with its real status (never retried)', async (status) => {
    const err = await thrownByRealClient(status)
    expect(translateAnthropicError(err, RETRIABLE)).toMatchObject({ kind: 'fatal', status })
  })

  it('reads the real SDK status, not 0, so the nack message tells the truth', async () => {
    const err = await thrownByRealClient(529)
    const classified = translateAnthropicError(err, RETRIABLE)
    expect((classified as { message: string }).message).not.toMatch(/HTTP error 0|^0 /)
  })
})

/**
 * An `APIError` as the SDK builds it when a GATEWAY terminated the HTTP request itself and reported
 * the upstream failure only inside the response body. `err.status` is absent — that absence is the
 * whole bug.
 */
const gatewayBodyStatusError = (bodyMessage = 'upstream returned 529') =>
  new APIError(
    undefined as never,
    { type: 'error', error: { type: 'server_error', message: bodyMessage } } as never,
    bodyMessage,
    undefined as never
  )

describe('translateAnthropicError — statusless APIError (work item #3)', () => {
  it('reproduces the bug: without a resolver a body-only 529 is FATAL, so retry never fires', () => {
    const c = translateAnthropicError(gatewayBodyStatusError(), RETRIABLE)
    // Documents the shipped default deliberately: unchanged from before the hook existed.
    expect(c.kind).toBe('fatal')
    expect(c).toMatchObject({ status: 0 })
    // The `0` in "HTTP error 0: 529 ..." is this coercion; the real status is in the body.
    expect((c as { message: string }).message).toContain('529')
  })

  it('a resolver recovers the status, making the SAME error retriable', () => {
    const c = translateAnthropicError(gatewayBodyStatusError(), RETRIABLE, {
      resolveErrorStatus: ({ bodyText, sdkStatus }) => {
        if (sdkStatus !== 0) return undefined
        const m = /upstream returned (\d{3})/.exec(bodyText)
        return m ? Number(m[1]) : undefined
      },
    })
    expect(c.kind).toBe('retriable')
    // Reported as 529, not 0 — so the exception payload and log line tell the truth.
    expect(c).toMatchObject({ status: 529 })
  })

  it('passes the SDK status, body text, and the error itself to the resolver', () => {
    const err = gatewayBodyStatusError()
    const resolver = vi.fn((_input: unknown) => undefined)
    translateAnthropicError(err, RETRIABLE, { resolveErrorStatus: resolver })
    expect(resolver).toHaveBeenCalledTimes(1)
    const arg = resolver.mock.calls[0]![0] as {
      error: unknown
      bodyText: string
      sdkStatus: number
    }
    expect(arg.error).toBe(err)
    expect(arg.sdkStatus).toBe(0)
    expect(arg.bodyText).toContain('upstream returned 529')
  })

  it('declining (undefined) leaves the SDK status in force', () => {
    const c = translateAnthropicError(gatewayBodyStatusError(), RETRIABLE, {
      resolveErrorStatus: () => undefined,
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
  })
})

describe('translateAnthropicError — resolver misbehaviour must never worsen the error', () => {
  it('a THROWING resolver is caught, warned about, and treated as declining', () => {
    const warn = vi.fn()
    const c = translateAnthropicError(gatewayBodyStatusError(), RETRIABLE, {
      resolveErrorStatus: () => {
        throw new Error('resolver blew up')
      },
      warn,
    })
    // The caller still sees the REAL upstream failure, not the resolver's.
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
    expect((c as { message: string }).message).toContain('529')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('resolver blew up'))
  })

  it.each([
    ['out of range low', 99],
    ['out of range high', 600],
    ['non-integer', 4.5],
  ])('ignores an implausible status (%s) with a warning', (_label, value) => {
    const warn = vi.fn()
    const c = translateAnthropicError(gatewayBodyStatusError(), RETRIABLE, {
      resolveErrorStatus: () => value,
      warn,
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a resolver returning a non-number is ignored', () => {
    const warn = vi.fn()
    const c = translateAnthropicError(gatewayBodyStatusError(), RETRIABLE, {
      resolveErrorStatus: (() => '529') as never,
      warn,
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('translateAnthropicError — the resolver must not break existing classification', () => {
  it('a resolver can NOT turn a real deterministic 400 into a retry by accident', () => {
    // Resolver only speaks when the SDK had nothing; a real 400 is untouched.
    const err = new APIError(
      400 as never,
      { error: { message: 'bad' } } as never,
      'bad',
      undefined as never
    )
    const c = translateAnthropicError(err, RETRIABLE, {
      resolveErrorStatus: ({ sdkStatus }) => (sdkStatus === 0 ? 529 : undefined),
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 400 })
  })

  it('context overflow is still detected when a resolver recovers 400 from the body', () => {
    const err = new APIError(
      undefined as never,
      { type: 'error', error: { message: 'prompt is too long: 300000 tokens' } } as never,
      'prompt is too long',
      undefined as never
    )
    const c = translateAnthropicError(err, RETRIABLE, { resolveErrorStatus: () => 400 })
    expect(c.kind).toBe('context-overflow')
  })

  it('a genuine SDK-visible 529 remains retriable with no resolver configured', () => {
    const err = new APIError(
      529 as never,
      { error: { type: 'overloaded_error' } } as never,
      'overloaded',
      undefined as never
    )
    expect(translateAnthropicError(err, RETRIABLE)).toMatchObject({
      kind: 'retriable',
      status: 529,
    })
  })

  it('APIConnectionError stays retriable at status 0 — the precedent for statusless retries', () => {
    const err = new APIConnectionError({ message: 'socket hang up' })
    expect(translateAnthropicError(err, RETRIABLE)).toMatchObject({ kind: 'retriable', status: 0 })
  })

  it('the resolver is not consulted for non-APIError values', () => {
    const resolver = vi.fn((_input: unknown) => 529)
    expect(
      translateAnthropicError(new Error('boom'), RETRIABLE, { resolveErrorStatus: resolver })
    ).toMatchObject({
      kind: 'fatal',
      status: 0,
    })
    expect(resolver).not.toHaveBeenCalled()
  })
})

// A diagnostic path must never become the failure the caller sees. The resolver AND the warn sink
// are both consumer-supplied, so either can throw — and when they do, the real upstream error must
// still be what surfaces. Verified escaping before the fix: a throwing `warn` propagated
// `logger boom` out of the classifier, discarding a genuine 529.
describe('translateAnthropicError — diagnostics must never replace the upstream error', () => {
  const gatewayErr = () =>
    new APIError(
      undefined as never,
      { error: { message: 'upstream returned 529' } } as never,
      'x',
      undefined as never
    )

  it('a throwing WARN SINK does not escape on the resolver-throw path', () => {
    const c = translateAnthropicError(gatewayErr(), RETRIABLE, {
      resolveErrorStatus: () => {
        throw new Error('resolver boom')
      },
      warn: () => {
        throw new Error('logger boom')
      },
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
    expect((c as { message: string }).message).toContain('529')
  })

  it('a throwing WARN SINK does not escape on the non-integer path', () => {
    const c = translateAnthropicError(gatewayErr(), RETRIABLE, {
      resolveErrorStatus: () => 4.5,
      warn: () => {
        throw new Error('logger boom')
      },
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
  })

  it('a throwing WARN SINK does not escape on the out-of-range path', () => {
    const c = translateAnthropicError(gatewayErr(), RETRIABLE, {
      resolveErrorStatus: () => 600,
      warn: () => {
        throw new Error('logger boom')
      },
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
  })

  it('a resolver throwing an UNCOERCIBLE value is still contained', () => {
    const hostile = {
      toString() {
        throw new Error('coercion boom')
      },
    }
    const warn = vi.fn()
    const c = translateAnthropicError(gatewayErr(), RETRIABLE, {
      resolveErrorStatus: () => {
        throw hostile
      },
      warn,
    })
    expect(c).toMatchObject({ kind: 'fatal', status: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('uncoercible'))
  })
})
