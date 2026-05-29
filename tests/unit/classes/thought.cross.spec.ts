import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Thought } from '../../../src/lib/classes/thought'
import { Identity } from '../../../src/lib/classes/identity'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { E_INVALID_INITIAL_THOUGHT_VALUE } from '../../../src/lib/exceptions/runtime'

const validRaw = () => ({
  id: 'thought-1',
  content: 'reasoning about the next step',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
})

describe('Thought', () => {
  describe('construction', () => {
    it('accepts valid raw input', () => {
      const t = new Thought(validRaw())
      expect(t.id).toBe('thought-1')
    })

    it('normalises temporal fields to DateTime instances', () => {
      const t = new Thought(validRaw())
      expect(DateTime.isDateTime(t.createdAt)).toBe(true)
      expect(DateTime.isDateTime(t.updatedAt)).toBe(true)
    })

    it('wraps a plain string content into a Tokenizable', () => {
      const t = new Thought(validRaw())
      expect(Tokenizable.isTokenizable(t.content)).toBe(true)
      expect(t.content.toString()).toBe('reasoning about the next step')
    })

    it('passes through an existing Tokenizable content unchanged', () => {
      const tk = new Tokenizable('pre-wrapped')
      const t = new Thought({ ...validRaw(), content: tk })
      expect(t.content).toBe(tk)
    })

    it("defaults identity to 'assistant' when omitted", () => {
      const t = new Thought(validRaw())
      expect(Identity.isIdentity(t.identity)).toBe(true)
      expect(t.identity.identifier).toBe('assistant')
      expect(t.identity.representation.toString()).toBe('assistant')
    })

    it('accepts a string identity', () => {
      const t = new Thought({ ...validRaw(), identity: 'planner' })
      expect(t.identity.identifier).toBe('planner')
    })

    it('accepts a RawIdentity object identity', () => {
      const t = new Thought({
        ...validRaw(),
        identity: { identifier: 'planner-id', representation: 'Planner' },
      })
      expect(t.identity.identifier).toBe('planner-id')
      expect(t.identity.representation.toString()).toBe('Planner')
    })

    it('accepts an existing Identity instance', () => {
      const id = new Identity({ identifier: 'planner-id', representation: 'Planner' })
      const t = new Thought({ ...validRaw(), identity: id })
      expect(t.identity.identifier).toBe('planner-id')
    })
  })

  describe('validation', () => {
    it('throws when id is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.id
      expect(() => new Thought(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_THOUGHT_VALUE
      )
    })

    it('throws when content is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.content
      expect(() => new Thought(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_THOUGHT_VALUE
      )
    })

    it('throws when createdAt is unparseable', () => {
      expect(() => new Thought({ ...validRaw(), createdAt: 'not a date' })).toThrow(
        E_INVALID_INITIAL_THOUGHT_VALUE
      )
    })
  })

  describe('payload and replayCompatibility', () => {
    it('defaults both fields to undefined when omitted (plain-text mode)', () => {
      const t = new Thought(validRaw())
      expect(t.payload).toBeUndefined()
      expect(t.replayCompatibility).toBeUndefined()
    })

    it('accepts both fields populated together', () => {
      const t = new Thought({
        ...validRaw(),
        payload: { signature: 'abc...' },
        replayCompatibility: 'anthropic-messages-thinking-v1',
      })
      expect(t.payload).toEqual({ signature: 'abc...' })
      expect(t.replayCompatibility).toBe('anthropic-messages-thinking-v1')
    })

    it('rejects payload without replayCompatibility', () => {
      expect(
        () =>
          new Thought({
            ...validRaw(),
            payload: { foo: 1 },
          })
      ).toThrow(E_INVALID_INITIAL_THOUGHT_VALUE)
    })

    it('accepts replayCompatibility without payload (documents intent)', () => {
      const t = new Thought({
        ...validRaw(),
        replayCompatibility: 'plain-text',
      })
      expect(t.replayCompatibility).toBe('plain-text')
      expect(t.payload).toBeUndefined()
    })

    it('rejects empty-string replayCompatibility', () => {
      expect(
        () =>
          new Thought({
            ...validRaw(),
            replayCompatibility: '',
          })
      ).toThrow(E_INVALID_INITIAL_THOUGHT_VALUE)
    })

    it('rejects non-string replayCompatibility', () => {
      expect(
        () =>
          new Thought({
            ...validRaw(),
            replayCompatibility: 123 as unknown as string,
          })
      ).toThrow(E_INVALID_INITIAL_THOUGHT_VALUE)
    })
  })

  describe('Thought.isThought', () => {
    it('returns true for Thought instances', () => {
      expect(Thought.isThought(new Thought(validRaw()))).toBe(true)
    })

    it('returns false for plain objects of the same shape', () => {
      expect(Thought.isThought(validRaw())).toBe(false)
    })
  })
})
