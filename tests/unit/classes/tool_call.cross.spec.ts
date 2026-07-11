import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ToolCall } from '../../../src/lib/classes/tool_call'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import { E_INVALID_INITIAL_TOOL_CALL_VALUE } from '../../../src/lib/exceptions/runtime'

const makeArtifact = (content = 'tool result') =>
  new SpooledArtifact(new InMemorySpoolReader(content))

const validRaw = () => ({
  id: 'call-1',
  tool: 'search',
  args: { query: 'hello' },
  checksum: 'abc123',
  isComplete: true,
  isError: false,
  results: makeArtifact(),
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:01.000Z',
  completedAt: '2024-01-01T00:00:02.000Z',
})

describe('ToolCall', () => {
  describe('construction', () => {
    it('accepts valid raw input', () => {
      const tc = new ToolCall(validRaw())
      expect(tc.id).toBe('call-1')
      expect(tc.tool).toBe('search')
      expect(tc.checksum).toBe('abc123')
      expect(tc.isComplete).toBe(true)
      expect(tc.isError).toBe(false)
    })

    it('stores args as a plain object when given an object', () => {
      const tc = new ToolCall(validRaw())
      expect(tc.args).toEqual({ query: 'hello' })
    })

    it('parses a JSON-string args into a plain object', () => {
      const tc = new ToolCall({ ...validRaw(), args: '{"query":"world"}' })
      expect(tc.args).toEqual({ query: 'world' })
    })

    it('normalises temporal fields to DateTime instances', () => {
      const tc = new ToolCall(validRaw())
      expect(DateTime.isDateTime(tc.createdAt)).toBe(true)
      expect(DateTime.isDateTime(tc.updatedAt)).toBe(true)
      expect(DateTime.isDateTime(tc.completedAt)).toBe(true)
    })

    it('stores the results SpooledArtifact reference', () => {
      const artifact = makeArtifact('specific results')
      const tc = new ToolCall({ ...validRaw(), results: artifact })
      expect(tc.results).toBe(artifact)
      expect(SpooledArtifact.isSpooledArtifact(tc.results)).toBe(true)
    })
  })

  describe('validation', () => {
    it('throws when id is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.id
      expect(() => new ToolCall(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_TOOL_CALL_VALUE
      )
    })

    it('throws when tool is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.tool
      expect(() => new ToolCall(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_TOOL_CALL_VALUE
      )
    })

    it('throws when args is a non-parseable string', () => {
      expect(() => new ToolCall({ ...validRaw(), args: 'not json {' })).toThrow(
        E_INVALID_INITIAL_TOOL_CALL_VALUE
      )
    })

    it('throws when args is a JSON string that does not decode to an object', () => {
      expect(() => new ToolCall({ ...validRaw(), args: '"just a string"' })).toThrow(
        E_INVALID_INITIAL_TOOL_CALL_VALUE
      )
    })

    it('throws when results is not a SpooledArtifact', () => {
      expect(
        () =>
          new ToolCall({
            ...validRaw(),
            results: { not: 'an artifact' } as unknown as SpooledArtifact,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_CALL_VALUE)
    })

    it('throws when checksum is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.checksum
      expect(() => new ToolCall(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_TOOL_CALL_VALUE
      )
    })

    it('throws when isComplete is not a boolean', () => {
      expect(
        () =>
          new ToolCall({
            ...validRaw(),
            isComplete: 'yes' as unknown as boolean,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_CALL_VALUE)
    })
  })

  describe('inline field', () => {
    it('defaults to false when omitted (handle-by-default: a spooled result stays out of the prompt unless a producer opts into inline:true)', () => {
      const tc = new ToolCall(validRaw())
      expect(tc.inline).toBe(false)
    })

    it('accepts inline: false', () => {
      const tc = new ToolCall({ ...validRaw(), inline: false })
      expect(tc.inline).toBe(false)
    })

    it('accepts inline: true explicitly', () => {
      const tc = new ToolCall({ ...validRaw(), inline: true })
      expect(tc.inline).toBe(true)
    })

    it('rejects non-boolean inline', () => {
      expect(
        () =>
          new ToolCall({
            ...validRaw(),
            inline: 'yes' as unknown as boolean,
          })
      ).toThrow(E_INVALID_INITIAL_TOOL_CALL_VALUE)
    })
  })

  describe('fromArtifactTool field', () => {
    it('defaults to false when omitted', () => {
      const tc = new ToolCall(validRaw())
      expect(tc.fromArtifactTool).toBe(false)
    })

    it('accepts fromArtifactTool: true', () => {
      const tc = new ToolCall({ ...validRaw(), fromArtifactTool: true })
      expect(tc.fromArtifactTool).toBe(true)
    })
  })

  describe('ToolCall.isToolCall', () => {
    it('returns true for ToolCall instances', () => {
      expect(ToolCall.isToolCall(new ToolCall(validRaw()))).toBe(true)
    })

    it('returns false for plain objects of the same shape', () => {
      expect(ToolCall.isToolCall(validRaw())).toBe(false)
    })
  })
})
