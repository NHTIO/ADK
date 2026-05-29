import { describe, expect, it } from 'vitest'
import { Registry } from '../../../src/lib/classes/registry'
import { E_INVALID_INITIAL_REGISTRY_VALUE } from '../../../src/lib/exceptions/runtime'

describe('Registry', () => {
  describe('construction', () => {
    it('accepts no initial value (empty store)', () => {
      const r = new Registry()
      expect(r.all()).toEqual({})
    })

    it('accepts an initial plain object', () => {
      const r = new Registry({ name: 'alice', count: 3 })
      expect(r.get('name')).toBe('alice')
      expect(r.get('count')).toBe(3)
    })

    it('deep-clones the initial value (caller mutations do not affect stored state)', () => {
      const initial = { user: { name: 'alice' } }
      const r = new Registry(initial)
      initial.user.name = 'bob'
      expect(r.get<{ name: string }>('user').name).toBe('alice')
    })

    it('throws E_INVALID_INITIAL_REGISTRY_VALUE for arrays', () => {
      expect(() => new Registry([] as unknown as Record<string, unknown>)).toThrow(
        E_INVALID_INITIAL_REGISTRY_VALUE
      )
    })

    it('throws E_INVALID_INITIAL_REGISTRY_VALUE for primitives', () => {
      expect(() => new Registry('not an object' as unknown as Record<string, unknown>)).toThrow(
        E_INVALID_INITIAL_REGISTRY_VALUE
      )
      expect(() => new Registry(42 as unknown as Record<string, unknown>)).toThrow(
        E_INVALID_INITIAL_REGISTRY_VALUE
      )
    })

    it('accepts undefined explicitly (treated as empty)', () => {
      const r = new Registry(undefined)
      expect(r.all()).toEqual({})
    })
  })

  describe('get / set with dot paths', () => {
    it('reads and writes top-level keys', () => {
      const r = new Registry()
      r.set('name', 'alice')
      expect(r.get('name')).toBe('alice')
    })

    it('reads and writes nested paths', () => {
      const r = new Registry()
      r.set('user.profile.name', 'alice')
      expect(r.get('user.profile.name')).toBe('alice')
      expect(r.get<{ profile: { name: string } }>('user').profile.name).toBe('alice')
    })

    it('creates intermediate objects automatically on nested write', () => {
      const r = new Registry()
      r.set('a.b.c', 'deep')
      expect(r.get('a.b.c')).toBe('deep')
    })

    it('returns defaultValue for an absent path', () => {
      const r = new Registry({ name: 'alice' })
      expect(r.get('missing', 'fallback')).toBe('fallback')
    })

    it('returns undefined when neither path nor defaultValue is set', () => {
      const r = new Registry()
      expect(r.get('missing')).toBeUndefined()
    })
  })

  describe('has', () => {
    it('returns true for a present top-level key', () => {
      const r = new Registry({ name: 'alice' })
      expect(r.has('name')).toBe(true)
    })

    it('returns true for a present nested path', () => {
      const r = new Registry({ user: { profile: { name: 'alice' } } })
      expect(r.has('user.profile.name')).toBe(true)
      expect(r.has('user.profile')).toBe(true)
      expect(r.has('user')).toBe(true)
    })

    it('returns false for an absent path', () => {
      const r = new Registry({ name: 'alice' })
      expect(r.has('missing')).toBe(false)
      expect(r.has('user.profile.name')).toBe(false)
    })

    it('returns false on an empty registry', () => {
      const r = new Registry()
      expect(r.has('anything')).toBe(false)
    })

    it('returns true after set, false after never having been set', () => {
      const r = new Registry()
      expect(r.has('a.b')).toBe(false)
      r.set('a.b', 'value')
      expect(r.has('a.b')).toBe(true)
      expect(r.has('a.c')).toBe(false)
    })

    it('treats a stored undefined as absent (matches get/defaultValue convention)', () => {
      const r = new Registry()
      r.set('explicit', undefined)
      expect(r.has('explicit')).toBe(false)
    })

    it('returns true for stored falsy non-undefined values', () => {
      const r = new Registry()
      r.set('zero', 0)
      r.set('empty', '')
      r.set('flag', false)
      r.set('nothing', null)
      expect(r.has('zero')).toBe(true)
      expect(r.has('empty')).toBe(true)
      expect(r.has('flag')).toBe(true)
      expect(r.has('nothing')).toBe(true)
    })
  })

  describe('deep-clone isolation on read', () => {
    it('get returns a clone — mutating it does not affect stored state', () => {
      const r = new Registry({ user: { name: 'alice' } })
      const retrieved = r.get<{ name: string }>('user')
      retrieved.name = 'bob'
      expect(r.get<{ name: string }>('user').name).toBe('alice')
    })

    it('all returns a clone — mutating it does not affect stored state', () => {
      const r = new Registry({ name: 'alice' })
      const snapshot = r.all()
      snapshot.name = 'bob'
      expect(r.get('name')).toBe('alice')
    })
  })

  describe('Registry.isRegistry', () => {
    it('returns true for Registry instances', () => {
      expect(Registry.isRegistry(new Registry())).toBe(true)
    })

    it('returns false for plain objects, arrays, or other classes', () => {
      expect(Registry.isRegistry({})).toBe(false)
      expect(Registry.isRegistry([])).toBe(false)
      expect(Registry.isRegistry(null)).toBe(false)
      expect(Registry.isRegistry(undefined)).toBe(false)
      expect(Registry.isRegistry('registry')).toBe(false)
    })
  })
})
