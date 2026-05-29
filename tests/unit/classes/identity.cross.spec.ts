import { describe, expect, it } from 'vitest'
import { Identity } from '../../../src/lib/classes/identity'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { E_INVALID_INITIAL_IDENTITY_VALUE } from '../../../src/lib/exceptions/runtime'

describe('Identity', () => {
  describe('construction', () => {
    it('accepts a string identifier and string representation', () => {
      const i = new Identity({ identifier: 'user-1', representation: 'Alice' })
      expect(i.identifier).toBe('user-1')
      expect(i.representation.toString()).toBe('Alice')
    })

    it('accepts a numeric identifier', () => {
      const i = new Identity({ identifier: 42, representation: 'Bob' })
      expect(i.identifier).toBe(42)
    })

    it('coerces a string representation into a Tokenizable', () => {
      const i = new Identity({ identifier: 'x', representation: 'Alice' })
      expect(Tokenizable.isTokenizable(i.representation)).toBe(true)
    })

    it('passes through an existing Tokenizable representation unchanged', () => {
      const t = new Tokenizable('Alice')
      const i = new Identity({ identifier: 'x', representation: t })
      expect(i.representation).toBe(t)
    })
  })

  describe('validation', () => {
    it('throws E_INVALID_INITIAL_IDENTITY_VALUE when identifier is missing', () => {
      expect(
        () =>
          new Identity({ representation: 'Alice' } as unknown as {
            identifier: string
            representation: string
          })
      ).toThrow(E_INVALID_INITIAL_IDENTITY_VALUE)
    })

    it('throws E_INVALID_INITIAL_IDENTITY_VALUE when representation is missing', () => {
      expect(
        () =>
          new Identity({ identifier: 'x' } as unknown as {
            identifier: string
            representation: string
          })
      ).toThrow(E_INVALID_INITIAL_IDENTITY_VALUE)
    })

    it('throws when identifier is neither string nor number', () => {
      expect(
        () =>
          new Identity({
            identifier: { not: 'a string or number' } as unknown as string,
            representation: 'Alice',
          })
      ).toThrow(E_INVALID_INITIAL_IDENTITY_VALUE)
    })

    it('throws when representation is not a string or Tokenizable', () => {
      expect(
        () =>
          new Identity({
            identifier: 'x',
            representation: 42 as unknown as string,
          })
      ).toThrow(E_INVALID_INITIAL_IDENTITY_VALUE)
    })

    it('carries the underlying ValidationException as cause', () => {
      try {
        new Identity({} as unknown as { identifier: string; representation: string })
        expect.fail('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(E_INVALID_INITIAL_IDENTITY_VALUE)
        expect((err as Error).cause).toBeDefined()
      }
    })
  })

  describe('immutability', () => {
    it('exposes identifier and representation as read-only properties', () => {
      const i = new Identity({ identifier: 'x', representation: 'Alice' })
      expect(() => {
        ;(i as unknown as { identifier: string }).identifier = 'y'
      }).toThrow()
      expect(() => {
        ;(i as unknown as { representation: Tokenizable }).representation = new Tokenizable('Bob')
      }).toThrow()
    })
  })

  describe('Identity.isIdentity', () => {
    it('returns true for Identity instances', () => {
      const i = new Identity({ identifier: 'x', representation: 'Alice' })
      expect(Identity.isIdentity(i)).toBe(true)
    })

    it('returns false for plain objects with the same shape', () => {
      expect(Identity.isIdentity({ identifier: 'x', representation: 'Alice' })).toBe(false)
    })

    it('returns false for null, undefined, primitives', () => {
      expect(Identity.isIdentity(null)).toBe(false)
      expect(Identity.isIdentity(undefined)).toBe(false)
      expect(Identity.isIdentity(42)).toBe(false)
      expect(Identity.isIdentity('Alice')).toBe(false)
    })
  })

  describe('schema', () => {
    it('exposes a reusable schema fragment on the class', () => {
      expect(Identity.schema).toBeDefined()
      expect(typeof Identity.schema.validate).toBe('function')
    })
  })
})
