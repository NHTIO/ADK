import { describe, expect, it } from 'vitest'
import {
  createNdjsonLineReader,
  encodeWrapperCommand,
  encodeWrapperEvent,
} from '../../../../../src/batteries/llm/claude_code_cli/wire'
import type {
  WrapperCommand,
  WrapperEvent,
  WrapperRunCommand,
} from '../../../../../src/batteries/llm/claude_code_cli/wire'

describe('claude_code_cli wire protocol', () => {
  describe('encodeWrapperCommand / encodeWrapperEvent', () => {
    it('encodes a run command as one NDJSON line with a trailing newline', () => {
      const command: WrapperRunCommand = {
        type: 'run',
        prompt: 'hello',
        allowedTools: [],
        claudeBin: 'claude',
        unsupportedResultMediaPolicy: 'throw',
        bridgedTools: [],
      }
      const encoded = encodeWrapperCommand(command)
      expect(encoded.endsWith('\n')).toBe(true)
      expect(encoded.indexOf('\n')).toBe(encoded.length - 1)
      expect(JSON.parse(encoded)).toEqual(command)
    })

    it('round-trips every WrapperCommand variant through encode/decode', () => {
      const commands: WrapperCommand[] = [
        {
          type: 'run',
          prompt: 'p',
          allowedTools: ['a', 'b'],
          claudeBin: 'claude',
          unsupportedResultMediaPolicy: 'throw',
          bridgedTools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
          extraArgs: [{ flag: '--effort', value: 'high' }],
        },
        { type: 'tool_call_response', requestId: '1', results: { content: [] } },
        { type: 'shutdown' },
      ]
      for (const command of commands) {
        const decoded = JSON.parse(encodeWrapperCommand(command))
        expect(decoded).toEqual(command)
      }
    })

    it('round-trips every WrapperEvent variant through encode/decode', () => {
      const events: WrapperEvent[] = [
        { type: 'ready' },
        { type: 'init', model: 'm', tools: ['a'], mcpServerErrors: [] },
        { type: 'message_delta', id: '1', delta: 'x', isComplete: true },
        { type: 'thought_delta', id: '1', delta: 'y' },
        { type: 'tool_call_request', requestId: '1', tool: 't', args: { a: 1 } },
        { type: 'retry', attempt: 1 },
        { type: 'result', isError: false, resultText: 'ok' },
        { type: 'error', message: 'boom' },
        { type: 'log', level: 'trace', kind: 'k', message: 'm' },
        { type: 'shutdown_complete' },
      ]
      for (const event of events) {
        const decoded = JSON.parse(encodeWrapperEvent(event))
        expect(decoded).toEqual(event)
      }
    })
  })

  describe('createNdjsonLineReader', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

    it('parses a single complete line', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.push(enc('{"a":1}\n'))
      expect(lines).toEqual(['{"a":1}'])
    })

    it('parses multiple lines delivered in one chunk', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.push(enc('{"a":1}\n{"b":2}\n'))
      expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    })

    it('reassembles a line split across many pushes', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.push(enc('{"a"'))
      reader.push(enc(':'))
      reader.push(enc('1}'))
      expect(lines).toHaveLength(0)
      reader.push(enc('\n'))
      expect(lines).toEqual(['{"a":1}'])
    })

    it('strips a trailing CR (CRLF line endings)', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.push(enc('{"a":1}\r\n'))
      expect(lines).toEqual(['{"a":1}'])
    })

    it('skips empty lines without invoking onLine', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.push(enc('{"a":1}\n\n{"b":2}\n'))
      expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    })

    it('treats a malformed line as tolerated, non-fatal: onLine returning undefined does not throw', () => {
      const results: Array<string | undefined> = []
      const reader = createNdjsonLineReader<string>((raw) => {
        if (raw === 'bad') return undefined
        results.push(raw)
        return raw
      })
      expect(() => reader.push(enc('bad\ngood\n'))).not.toThrow()
      expect(results).toEqual(['good'])
    })

    it('decodes a UTF-8 code point split across pushes', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      const bytes = enc('{"msg":"✓"}\n')
      const splitAt = bytes.indexOf(0xe2) + 1
      reader.push(bytes.slice(0, splitAt))
      reader.push(bytes.slice(splitAt))
      expect(lines).toEqual(['{"msg":"✓"}'])
    })

    it('drops a line with invalid UTF-8 bytes without calling onLine, and recovers on the next line', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      // 0xff is never valid UTF-8 in this position.
      reader.push(new Uint8Array([0x7b, 0xff, 0x0a])) // "{\xff\n"
      reader.push(enc('{"a":1}\n'))
      expect(lines).toEqual(['{"a":1}'])
    })

    it('caps an unbounded no-newline write via maxLineBytes, then resyncs after the next newline', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>(
        (raw) => {
          lines.push(raw)
          return raw
        },
        { maxLineBytes: 8 }
      )
      reader.push(enc('x'.repeat(64)))
      expect(lines).toHaveLength(0)
      // The rest of the same physical (oversized) line must be discarded, not parsed.
      reader.push(enc('{"a":1}'))
      expect(lines).toHaveLength(0)
      // The newline ends the oversized line; parsing resumes only after it.
      reader.push(enc('\n{"b":2}\n'))
      expect(lines).toEqual(['{"b":2}'])
    })

    it('discards an oversized line that DOES carry its own terminator, then parses the next line cleanly', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>(
        (raw) => {
          lines.push(raw)
          return raw
        },
        { maxLineBytes: 8 }
      )
      reader.push(enc('12345678901234567890\n{"a":1}\n'))
      expect(lines).toEqual(['{"a":1}'])
    })

    it('assembles a line delivered as many single-byte fragments', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>(
        (raw) => {
          lines.push(raw)
          return raw
        },
        { maxLineBytes: 1_048_576 }
      )
      const bytes = enc('{"fragmented":true}\n')
      for (const b of bytes) reader.push(new Uint8Array([b]))
      expect(lines).toEqual(['{"fragmented":true}'])
    })

    it('discards an unterminated trailing partial silently on end() — no flush, no callback', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.push(enc('{"a":1}\n{"b":2'))
      expect(lines).toEqual(['{"a":1}'])
      reader.end()
      expect(lines).toEqual(['{"a":1}'])
    })

    it('ignores any further push() calls after end()', () => {
      const lines: string[] = []
      const reader = createNdjsonLineReader<string>((raw) => {
        lines.push(raw)
        return raw
      })
      reader.end()
      reader.push(enc('{"a":1}\n'))
      expect(lines).toHaveLength(0)
    })

    it('rejects a non-positive, non-finite, or fractional maxLineBytes at construction', () => {
      const onLine = (): undefined => undefined
      expect(() => createNdjsonLineReader(onLine, { maxLineBytes: Infinity })).toThrow(RangeError)
      expect(() => createNdjsonLineReader(onLine, { maxLineBytes: Number.NaN })).toThrow(RangeError)
      expect(() => createNdjsonLineReader(onLine, { maxLineBytes: 0 })).toThrow(RangeError)
      expect(() => createNdjsonLineReader(onLine, { maxLineBytes: -1 })).toThrow(RangeError)
      expect(() => createNdjsonLineReader(onLine, { maxLineBytes: 1.5 })).toThrow(RangeError)
      expect(() => createNdjsonLineReader(onLine, { maxLineBytes: 64 })).not.toThrow()
    })

    it('parses real WrapperEvent/WrapperCommand JSON lines end-to-end', () => {
      const events: WrapperEvent[] = []
      const reader = createNdjsonLineReader<WrapperEvent>((raw) => {
        try {
          return JSON.parse(raw) as WrapperEvent
        } catch {
          return undefined
        }
      })
      const capturingReader = createNdjsonLineReader<WrapperEvent>((raw) => {
        const parsed = JSON.parse(raw) as WrapperEvent
        events.push(parsed)
        return parsed
      })
      void reader
      capturingReader.push(enc(encodeWrapperEvent({ type: 'ready' })))
      capturingReader.push(
        enc(encodeWrapperEvent({ type: 'result', isError: false, resultText: 'ok' }))
      )
      expect(events).toEqual([
        { type: 'ready' },
        { type: 'result', isError: false, resultText: 'ok' },
      ])
    })
  })
})
