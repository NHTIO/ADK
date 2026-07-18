import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROTOCOL,
  buildEditCommand,
  buildGenerateCommand,
  buildShutdownCommand,
  buildStopCommand,
  createFrameReader,
  parseFrame,
} from '../../../../../src/batteries/generation/local_diffusion/protocol'

const frame = (body: string): string => `${DEFAULT_PROTOCOL.eventPrefix} ${body}`
const malformed = (value: unknown): boolean => (value as { kind: string }).kind === 'malformed'

describe('local diffusion protocol', () => {
  it('parses every valid frame kind', () => {
    expect(parseFrame(frame('mdld 0.25'))).toEqual({ kind: 'modelLoad', progress: 0.25 })
    expect(parseFrame(frame('rdy'))).toEqual({ kind: 'ready' })
    expect(parseFrame(frame('dnpr 4 1'))).toEqual({ kind: 'progress', rid: 4, progress: 1 })
    expect(parseFrame(frame('nwim 4 {"path":"/tmp/a.png","mimeType":"image/png"}'))).toEqual({
      kind: 'image',
      rid: 4,
      payload: { path: '/tmp/a.png', mimeType: 'image/png' },
    })
    expect(parseFrame(frame('nwim 4 {"b64":"YWJj","mimeType":"image/png"}'))).toEqual({
      kind: 'image',
      rid: 4,
      payload: { b64: 'YWJj', mimeType: 'image/png' },
    })
    expect(parseFrame(frame('done 4'))).toEqual({ kind: 'done', rid: 4 })
    expect(parseFrame(frame('err 4 {"message":"no model"}'))).toEqual({
      kind: 'error',
      rid: 4,
      message: 'no model',
    })
  })

  it('classifies invalid and unknown frames without throwing', () => {
    expect(malformed(parseFrame(frame('mdld 2')))).toBe(true)
    expect(malformed(parseFrame(frame('dnpr 1 -0.1')))).toBe(true)
    expect(malformed(parseFrame(frame('nwim 1 {"path":"x"}')))).toBe(true)
    expect(malformed(parseFrame(frame('nwim 1 {"mimeType":"image/png"}')))).toBe(true)
    expect(malformed(parseFrame(frame('nwim 1 {bad')))).toBe(true)
    expect(malformed(parseFrame(frame('dnpr nope 0.2')))).toBe(true)
    expect(parseFrame(frame('future 1')).kind).toBe('unknown')
    expect(parseFrame('other rdy').kind).toBe('unknown')
  })

  it('rejects an image payload carrying both path and b64', () => {
    expect(
      malformed(parseFrame(frame('nwim 1 {"path":"/a.png","b64":"YWJj","mimeType":"image/png"}')))
    ).toBe(true)
  })

  it('rejects an image payload with both keys even when one value has the wrong type', () => {
    // Both KEYS present → malformed regardless of value types (a non-string path must not fall
    // through to being treated as a b64 image).
    expect(
      malformed(parseFrame(frame('nwim 1 {"path":7,"b64":"YWJj","mimeType":"image/png"}')))
    ).toBe(true)
    expect(
      malformed(parseFrame(frame('nwim 1 {"path":"/a.png","b64":7,"mimeType":"image/png"}')))
    ).toBe(true)
    // Exactly one key present but non-string → malformed.
    expect(malformed(parseFrame(frame('nwim 1 {"path":7,"mimeType":"image/png"}')))).toBe(true)
    expect(malformed(parseFrame(frame('nwim 1 {"b64":7,"mimeType":"image/png"}')))).toBe(true)
  })

  it('rejects a negative-signed -0 progress token', () => {
    expect(malformed(parseFrame(frame('mdld -0')))).toBe(true)
    expect(malformed(parseFrame(frame('dnpr 1 -0')))).toBe(true)
    // A plain 0 is still accepted and is positive zero.
    const f = parseFrame(frame('mdld 0'))
    expect(f).toEqual({ kind: 'modelLoad', progress: 0 })
    expect(Object.is((f as { progress: number }).progress, -0)).toBe(false)
  })

  it('rejects scientific and hex progress spellings but accepts plain decimals', () => {
    expect(malformed(parseFrame(frame('mdld 1e0')))).toBe(true)
    expect(malformed(parseFrame(frame('mdld 0x1')))).toBe(true)
    expect(parseFrame(frame('mdld .5'))).toEqual({ kind: 'modelLoad', progress: 0.5 })
    expect(parseFrame(frame('mdld +1'))).toEqual({ kind: 'modelLoad', progress: 1 })
  })

  it('does not throw on a runtime-invalid config (parseFrame is total)', () => {
    // A JS caller passing garbage must get a typed frame, not a TypeError.
    expect(() => parseFrame('sdbk rdy', null as never)).not.toThrow()
    expect(parseFrame('sdbk rdy', null as never).kind).toBe('malformed')
    expect(parseFrame('sdbk rdy', { eventPrefix: 'sdbk', events: null } as never).kind).toBe(
      'malformed'
    )
    // A partial events object (missing string members) is rejected, not dereferenced blindly.
    expect(parseFrame('sdbk rdy', { eventPrefix: 'sdbk', events: {} } as never).kind).toBe(
      'malformed'
    )
    // A hostile config whose event tag throws on access must be caught, not propagated.
    const hostile = {
      eventPrefix: 'sdbk',
      events: new Proxy(
        {},
        {
          get() {
            throw new Error('hostile getter')
          },
          has() {
            return true
          },
        }
      ),
    }
    expect(() => parseFrame('sdbk rdy', hostile as never)).not.toThrow()
    expect(parseFrame('sdbk rdy', hostile as never).kind).toBe('malformed')
  })

  it('rejects a ready frame that carries a payload', () => {
    expect(malformed(parseFrame(frame('rdy garbage')))).toBe(true)
    expect(malformed(parseFrame(frame('rdy {"unexpected":true}')))).toBe(true)
  })

  it('rejects blank or whitespace-only progress rather than coercing to zero', () => {
    // 'mdld ' — trailing space, empty numeric token: must NOT parse as progress 0.
    expect(malformed(parseFrame(`${frame('mdld')} `))).toBe(true)
    expect(malformed(parseFrame(`${frame('dnpr 1')} `))).toBe(true)
    // A non-numeric progress token is likewise rejected, not coerced.
    expect(malformed(parseFrame(frame('mdld abc')))).toBe(true)
  })

  it('validates request-id integer boundaries', () => {
    expect(parseFrame(frame('done 0'))).toEqual({ kind: 'done', rid: 0 })
    expect(parseFrame(frame('done 9007199254740991'))).toEqual({
      kind: 'done',
      rid: 9007199254740991,
    })
    // 2**53 is not a safe integer → rejected.
    expect(malformed(parseFrame(frame('done 9007199254740992')))).toBe(true)
    expect(malformed(parseFrame(frame('done -1')))).toBe(true)
    expect(malformed(parseFrame(frame('done 1.5')))).toBe(true)
  })

  it('supports configuration overrides', () => {
    const config = {
      ...DEFAULT_PROTOCOL,
      commandPrefix: 'cmd',
      eventPrefix: 'evt',
      ops: { generate: 'gen', edit: 'edt' },
    }
    expect(parseFrame('evt rdy', config)).toEqual({ kind: 'ready' })
    expect(buildGenerateCommand(2, { prompt: 'x' }, config)).toBe('cmd gen 2 {"prompt":"x"}\n')
  })

  it('builds exact command frames', () => {
    expect(buildGenerateCommand(7, { prompt: 'cat', n: 1 })).toBe(
      'b2py t2im 7 {"prompt":"cat","n":1}\n'
    )
    expect(buildEditCommand(7, { prompt: 'cat' })).toBe('b2py im2im 7 {"prompt":"cat"}\n')
    expect(buildStopCommand(7)).toBe('b2py __stop__ 7\n')
    expect(buildShutdownCommand()).toBe('b2py __shutdown__\n')
  })

  it('rejects command builders given an invalid request id or unserializable args', () => {
    expect(() => buildGenerateCommand(-1, { prompt: 'x' })).toThrow()
    expect(() => buildGenerateCommand(1.5, { prompt: 'x' })).toThrow()
    expect(() => buildGenerateCommand(Number.NaN, { prompt: 'x' })).toThrow()
    expect(() => buildStopCommand(2 ** 53)).toThrow()
    // A value JSON.stringify renders as `undefined` must not silently emit a literal `undefined`.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => buildGenerateCommand(1, cyclic)).toThrow()
    expect(() => buildGenerateCommand(1, { bad: BigInt(1) })).toThrow()
  })

  it('frames multiple, split, CRLF, and empty lines', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f) })
    // Two valid frames + an empty line between them: the empty line is skipped, both frames emit.
    reader.push(new TextEncoder().encode('sdbk rdy\n\nsdbk done 3\n'))
    expect(frames).toEqual([{ kind: 'ready' }, { kind: 'done', rid: 3 }])
    // A frame split across pushes + a CRLF terminator: emits once, after the newline arrives.
    reader.push(new TextEncoder().encode('sdbk md'))
    reader.push(new TextEncoder().encode('ld 0.5\r'))
    expect(frames).toHaveLength(2)
    reader.push(new TextEncoder().encode('\n'))
    expect(frames).toHaveLength(3)
    expect(frames[2]).toEqual({ kind: 'modelLoad', progress: 0.5 })
  })

  it('decodes a UTF-8 code point split across pushes', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f) })
    const bytes = new TextEncoder().encode('sdbk err 1 {"message":"✓"}\n')
    reader.push(bytes.slice(0, bytes.indexOf(0xe2) + 1))
    reader.push(bytes.slice(bytes.indexOf(0xe2) + 1))
    expect(frames).toEqual([{ kind: 'error', rid: 1, message: '✓' }])
  })

  it('classifies a line with invalid UTF-8 bytes as malformed', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f) })
    // 0xff is never valid UTF-8; the complete line must decode-fail → malformed, then recover.
    reader.push(new Uint8Array([0x73, 0x64, 0x62, 0x6b, 0x20, 0xff, 0x0a])) // "sdbk \xff\n"
    reader.push(new TextEncoder().encode('sdbk rdy\n'))
    expect(frames[0]?.kind).toBe('malformed')
    expect(frames[1]).toEqual({ kind: 'ready' })
  })

  it('retains a trailing partial and flushes EOF correctly', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f) })
    reader.push(new TextEncoder().encode('sdbk rdy\nsdbk done 2'))
    expect(frames).toEqual([{ kind: 'ready' }])
    reader.end()
    expect(frames[1]).toEqual({
      kind: 'malformed',
      raw: 'sdbk done 2',
      detail: 'unterminated line at EOF',
    })
  })

  it('caps an unbounded no-newline write while consuming, then resyncs after the next newline', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f), maxLineBytes: 16 })
    // A single oversized chunk far exceeding the cap, no newline → exactly one protocolError.
    reader.push(new TextEncoder().encode('x'.repeat(64)))
    expect(frames).toEqual([{ kind: 'protocolError', detail: 'line exceeded maxLineBytes' }])
    // The rest of that SAME physical line (including a frame-looking suffix) is discarded until the
    // terminating newline — it must NOT be parsed as a fresh frame (terra #2/#7).
    reader.push(new TextEncoder().encode('sdbk rdy'))
    expect(frames).toHaveLength(1)
    // The newline ends the oversized line; parsing resumes only AFTER it.
    reader.push(new TextEncoder().encode('\nsdbk done 5\n'))
    expect(frames).toEqual([
      { kind: 'protocolError', detail: 'line exceeded maxLineBytes' },
      { kind: 'done', rid: 5 },
    ])
  })

  it('reports overflow once for an oversized terminated line and parses the next line cleanly', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f), maxLineBytes: 16 })
    // An oversized line that DOES carry its own terminator: one protocolError, no lingering discard.
    reader.push(new TextEncoder().encode('12345678901234567890\nsdbk rdy\n'))
    expect(frames).toEqual([
      { kind: 'protocolError', detail: 'line exceeded maxLineBytes' },
      { kind: 'ready' },
    ])
  })

  it('does not emit a malformed EOF frame while discarding an unterminated oversized line', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f), maxLineBytes: 8 })
    reader.push(new TextEncoder().encode('this-is-way-too-long-with-no-newline'))
    reader.end()
    // Exactly the overflow report — the discarded remainder must not resurface as a malformed EOF line.
    expect(frames).toEqual([{ kind: 'protocolError', detail: 'line exceeded maxLineBytes' }])
  })

  it('rejects a non-positive, non-finite, or fractional maxLineBytes at construction', () => {
    const onFrame = (): void => {}
    expect(() => createFrameReader({ onFrame, maxLineBytes: Infinity })).toThrow()
    expect(() => createFrameReader({ onFrame, maxLineBytes: Number.NaN })).toThrow()
    expect(() => createFrameReader({ onFrame, maxLineBytes: 0 })).toThrow()
    expect(() => createFrameReader({ onFrame, maxLineBytes: -1 })).toThrow()
    expect(() => createFrameReader({ onFrame, maxLineBytes: 1.5 })).toThrow()
    // A valid positive integer is accepted.
    expect(() => createFrameReader({ onFrame, maxLineBytes: 64 })).not.toThrow()
  })

  it('assembles a line delivered as many single-byte fragments (segment queue)', () => {
    const frames: ReturnType<typeof parseFrame>[] = []
    const reader = createFrameReader({ onFrame: (f) => frames.push(f) })
    const bytes = new TextEncoder().encode('sdbk err 1 {"message":"fragmented"}\n')
    for (const b of bytes) reader.push(new Uint8Array([b]))
    expect(frames).toEqual([{ kind: 'error', rid: 1, message: 'fragmented' }])
  })
})
