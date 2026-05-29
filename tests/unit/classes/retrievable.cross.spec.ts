import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Memory } from '../../../src/lib/classes/memory'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { E_INVALID_INITIAL_RETRIEVABLE_VALUE } from '../../../src/lib/exceptions/runtime'

const validRaw = () => ({
  id: 'ret-1',
  content: 'policy document body',
  trustTier: 'first-party' as const,
  source: 'kb://policies/access-control',
  kind: 'policy',
  score: 0.82,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
})

describe('Retrievable', () => {
  describe('construction', () => {
    it('accepts valid raw input and round-trips every field', () => {
      const r = new Retrievable(validRaw())
      expect(r.id).toBe('ret-1')
      expect(r.trustTier).toBe('first-party')
      expect(r.source).toBe('kb://policies/access-control')
      expect(r.kind).toBe('policy')
      expect(r.score).toBe(0.82)
    })

    it('normalises temporal fields to DateTime instances', () => {
      const r = new Retrievable(validRaw())
      expect(DateTime.isDateTime(r.createdAt)).toBe(true)
      expect(DateTime.isDateTime(r.updatedAt)).toBe(true)
      expect(r.createdAt.toISO()).toBe('2024-01-01T00:00:00.000Z')
    })

    it('accepts numeric (Unix ms) timestamps', () => {
      const ts = Date.parse('2024-01-01T00:00:00.000Z')
      const r = new Retrievable({ ...validRaw(), createdAt: ts, updatedAt: ts })
      expect(r.createdAt.toMillis()).toBe(ts)
    })

    it('accepts Date instances for temporal fields', () => {
      const d = new Date('2024-06-15T12:00:00.000Z')
      const r = new Retrievable({ ...validRaw(), createdAt: d, updatedAt: d })
      expect(r.createdAt.toISO()).toBe('2024-06-15T12:00:00.000Z')
    })

    it('wraps a plain string content into a Tokenizable', () => {
      const r = new Retrievable(validRaw())
      expect(Tokenizable.isTokenizable(r.content)).toBe(true)
      expect(r.content.toString()).toBe('policy document body')
    })

    it('passes through an existing Tokenizable content unchanged', () => {
      const t = new Tokenizable('pre-wrapped')
      const r = new Retrievable({ ...validRaw(), content: t })
      expect(r.content).toBe(t)
    })

    it('treats source / kind / score as optional', () => {
      const raw = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete raw.source
      delete raw.kind
      delete raw.score
      const r = new Retrievable(raw as ReturnType<typeof validRaw>)
      expect(r.source).toBeUndefined()
      expect(r.kind).toBeUndefined()
      expect(r.score).toBeUndefined()
    })
  })

  describe('trustTier validation', () => {
    it('accepts "first-party"', () => {
      expect(() => new Retrievable({ ...validRaw(), trustTier: 'first-party' })).not.toThrow()
    })

    it('accepts "third-party-public"', () => {
      expect(
        () => new Retrievable({ ...validRaw(), trustTier: 'third-party-public' })
      ).not.toThrow()
    })

    it('accepts "third-party-private"', () => {
      expect(
        () => new Retrievable({ ...validRaw(), trustTier: 'third-party-private' })
      ).not.toThrow()
    })

    it('rejects unknown trustTier values', () => {
      expect(
        () =>
          new Retrievable({
            ...validRaw(),
            trustTier: 'unknown' as unknown as 'first-party',
          })
      ).toThrow(E_INVALID_INITIAL_RETRIEVABLE_VALUE)
    })

    it('rejects the historic "user-supplied" vocabulary (regression guard)', () => {
      expect(
        () =>
          new Retrievable({
            ...validRaw(),
            trustTier: 'user-supplied' as unknown as 'first-party',
          })
      ).toThrow(E_INVALID_INITIAL_RETRIEVABLE_VALUE)
    })

    it('rejects when trustTier is missing (no default)', () => {
      const raw = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete raw.trustTier
      expect(() => new Retrievable(raw as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })
  })

  describe('validation', () => {
    it('throws when id is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.id
      expect(() => new Retrievable(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })

    it('throws when score is out of range (> 1)', () => {
      expect(() => new Retrievable({ ...validRaw(), score: 1.5 })).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })

    it('throws when score is out of range (< 0)', () => {
      expect(() => new Retrievable({ ...validRaw(), score: -0.1 })).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })

    it('throws when source is not a string', () => {
      expect(
        () =>
          new Retrievable({
            ...validRaw(),
            source: 42 as unknown as string,
          })
      ).toThrow(E_INVALID_INITIAL_RETRIEVABLE_VALUE)
    })

    it('throws when kind is not a string', () => {
      expect(
        () =>
          new Retrievable({
            ...validRaw(),
            kind: 42 as unknown as string,
          })
      ).toThrow(E_INVALID_INITIAL_RETRIEVABLE_VALUE)
    })

    it('throws when createdAt is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.createdAt
      expect(() => new Retrievable(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })

    it('throws when updatedAt is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.updatedAt
      expect(() => new Retrievable(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })

    it('throws when createdAt is not parseable', () => {
      expect(() => new Retrievable({ ...validRaw(), createdAt: 'not a date' })).toThrow(
        E_INVALID_INITIAL_RETRIEVABLE_VALUE
      )
    })

    it('throws when content is neither string nor Tokenizable', () => {
      expect(
        () =>
          new Retrievable({
            ...validRaw(),
            content: 42 as unknown as string,
          })
      ).toThrow(E_INVALID_INITIAL_RETRIEVABLE_VALUE)
    })
  })

  describe('immutability', () => {
    it('exposes id as a read-only property', () => {
      const r = new Retrievable(validRaw())
      expect(() => {
        ;(r as unknown as { id: string }).id = 'tampered'
      }).toThrow()
    })

    it('exposes trustTier as a read-only property', () => {
      const r = new Retrievable(validRaw())
      expect(() => {
        ;(r as unknown as { trustTier: string }).trustTier = 'third-party-public'
      }).toThrow()
    })
  })

  describe('Retrievable.isRetrievable', () => {
    it('returns true for Retrievable instances', () => {
      expect(Retrievable.isRetrievable(new Retrievable(validRaw()))).toBe(true)
    })

    it('returns false for plain objects with the same shape', () => {
      expect(Retrievable.isRetrievable(validRaw())).toBe(false)
    })

    it('distinguishes Retrievable from Memory (cross-realm guard)', () => {
      const mem = new Memory({
        id: 'mem-1',
        content: 'a memory',
        confidence: 0.9,
        importance: 0.5,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      })
      expect(Retrievable.isRetrievable(mem)).toBe(false)
      expect(Memory.isMemory(new Retrievable(validRaw()))).toBe(false)
    })
  })

  describe('schema', () => {
    it('is exposed as a static for reuse in other schemas', () => {
      expect(Retrievable.schema).toBeDefined()
      expect(typeof Retrievable.schema.validate).toBe('function')
    })
  })
})
