import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Memory } from '../../../src/lib/classes/memory'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { E_INVALID_INITIAL_MEMORY_VALUE } from '../../../src/lib/exceptions/runtime'

const validRaw = () => ({
  id: 'mem-1',
  content: 'the agent has previously discussed this topic',
  confidence: 0.8,
  importance: 0.6,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
})

describe('Memory', () => {
  describe('construction', () => {
    it('accepts valid raw input', () => {
      const m = new Memory(validRaw())
      expect(m.id).toBe('mem-1')
      expect(m.confidence).toBe(0.8)
      expect(m.importance).toBe(0.6)
    })

    it('normalises temporal fields to DateTime instances', () => {
      const m = new Memory(validRaw())
      expect(DateTime.isDateTime(m.createdAt)).toBe(true)
      expect(DateTime.isDateTime(m.updatedAt)).toBe(true)
      expect(m.createdAt.toISO()).toBe('2024-01-01T00:00:00.000Z')
    })

    it('accepts numeric (Unix ms) timestamps', () => {
      const ts = Date.parse('2024-01-01T00:00:00.000Z')
      const m = new Memory({ ...validRaw(), createdAt: ts, updatedAt: ts })
      expect(m.createdAt.toMillis()).toBe(ts)
    })

    it('accepts Date instances for temporal fields', () => {
      const d = new Date('2024-06-15T12:00:00.000Z')
      const m = new Memory({ ...validRaw(), createdAt: d, updatedAt: d })
      expect(m.createdAt.toISO()).toBe('2024-06-15T12:00:00.000Z')
    })

    it('wraps a plain string content into a Tokenizable', () => {
      const m = new Memory(validRaw())
      expect(Tokenizable.isTokenizable(m.content)).toBe(true)
      expect(m.content.toString()).toBe('the agent has previously discussed this topic')
    })

    it('passes through an existing Tokenizable content unchanged', () => {
      const t = new Tokenizable('pre-wrapped')
      const m = new Memory({ ...validRaw(), content: t })
      expect(m.content).toBe(t)
    })
  })

  describe('validation', () => {
    it('throws E_INVALID_INITIAL_MEMORY_VALUE when id is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.id
      expect(() => new Memory(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_MEMORY_VALUE
      )
    })

    it('throws when confidence is out of range', () => {
      expect(() => new Memory({ ...validRaw(), confidence: 1.5 })).toThrow(
        E_INVALID_INITIAL_MEMORY_VALUE
      )
      expect(() => new Memory({ ...validRaw(), confidence: -0.1 })).toThrow(
        E_INVALID_INITIAL_MEMORY_VALUE
      )
    })

    it('throws when importance is out of range', () => {
      expect(() => new Memory({ ...validRaw(), importance: 1.5 })).toThrow(
        E_INVALID_INITIAL_MEMORY_VALUE
      )
    })

    it('throws when createdAt is not parseable', () => {
      expect(() => new Memory({ ...validRaw(), createdAt: 'not a date' })).toThrow(
        E_INVALID_INITIAL_MEMORY_VALUE
      )
    })

    it('throws when content is neither string nor Tokenizable', () => {
      expect(
        () =>
          new Memory({
            ...validRaw(),
            content: 42 as unknown as string,
          })
      ).toThrow(E_INVALID_INITIAL_MEMORY_VALUE)
    })
  })

  describe('immutability', () => {
    it('exposes id as a read-only property', () => {
      const m = new Memory(validRaw())
      expect(() => {
        ;(m as unknown as { id: string }).id = 'tampered'
      }).toThrow()
    })
  })

  describe('Memory.isMemory', () => {
    it('returns true for Memory instances', () => {
      expect(Memory.isMemory(new Memory(validRaw()))).toBe(true)
    })

    it('returns false for plain objects with the same shape', () => {
      expect(Memory.isMemory(validRaw())).toBe(false)
    })
  })

  describe('schema', () => {
    it('is exposed as a static for reuse in other schemas', () => {
      expect(Memory.schema).toBeDefined()
      expect(typeof Memory.schema.validate).toBe('function')
    })
  })
})
