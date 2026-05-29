import { describe, expect, it } from 'vitest'
import { TokenEncoding, Tokenizable } from '../../../src/lib/classes/tokenizable'

describe('Tokenizable', () => {
  describe('construction and value access', () => {
    it('stores the initial string value', () => {
      const t = new Tokenizable('hello world')
      expect(t.toString()).toBe('hello world')
      expect(t.valueOf()).toBe('hello world')
      expect(t.toJSON()).toBe('hello world')
      expect(t.toLocaleString()).toBe('hello world')
    })

    it('coerces transparently to a string', () => {
      const t = new Tokenizable('hi')
      expect(`${t}`).toBe('hi')
      expect(String(t)).toBe('hi')
      expect(JSON.stringify(t)).toBe('"hi"')
    })

    it('returns the value from the nodejs.util.inspect.custom hook', () => {
      const t = new Tokenizable('inspected')
      const key = Symbol.for('nodejs.util.inspect.custom')
      const fn = (t as unknown as Record<symbol, () => string>)[key]
      expect(fn.call(t)).toBe('inspected')
    })
  })

  describe('set', () => {
    it('replaces the stored value', () => {
      const t = new Tokenizable('one')
      t.set('two')
      expect(t.toString()).toBe('two')
    })

    it('clears the token-count cache on update', () => {
      const t = new Tokenizable('hello world')
      const before = t.estimateTokens('cl100k_base')
      t.set('a much longer string than before with many more tokens to count')
      const after = t.estimateTokens('cl100k_base')
      expect(after).toBeGreaterThan(before)
    })
  })

  describe('estimateTokens (instance)', () => {
    it('returns a positive count for tiktoken-family encodings', () => {
      const t = new Tokenizable('Hello, world!')
      for (const enc of ['gpt2', 'r50k_base', 'p50k_base', 'cl100k_base', 'o200k_base'] as const) {
        expect(t.estimateTokens(enc)).toBeGreaterThan(0)
      }
    })

    it('returns a positive count for gemini', () => {
      const t = new Tokenizable('Hello, world!')
      expect(t.estimateTokens('gemini')).toBeGreaterThan(0)
    })

    it('returns a positive count for llama2', () => {
      const t = new Tokenizable('Hello, world!')
      expect(t.estimateTokens('llama2')).toBeGreaterThan(0)
    })

    it('uses the ~3.5 chars/token heuristic for claude', () => {
      const t = new Tokenizable('a'.repeat(35))
      // 35 chars / 3.5 = 10 tokens exactly
      expect(t.estimateTokens('claude')).toBe(10)
    })

    it('caches results per encoding (idempotent within a value)', () => {
      const t = new Tokenizable('cached value')
      const first = t.estimateTokens('cl100k_base')
      const second = t.estimateTokens('cl100k_base')
      expect(first).toBe(second)
    })
  })

  describe('Tokenizable.estimateTokens (static)', () => {
    it('returns a count for one-off invocations without creating a long-lived instance', () => {
      const count = Tokenizable.estimateTokens('hello', 'cl100k_base')
      expect(count).toBeGreaterThan(0)
    })

    it('matches the instance-method result for the same input', () => {
      const t = new Tokenizable('the same input')
      const inst = t.estimateTokens('cl100k_base')
      const stat = Tokenizable.estimateTokens('the same input', 'cl100k_base')
      expect(stat).toBe(inst)
    })
  })

  describe('Tokenizable.isTokenizable', () => {
    it('returns true for Tokenizable instances', () => {
      expect(Tokenizable.isTokenizable(new Tokenizable('x'))).toBe(true)
    })

    it('returns false for plain strings', () => {
      expect(Tokenizable.isTokenizable('x')).toBe(false)
    })

    it('returns false for null/undefined/objects', () => {
      expect(Tokenizable.isTokenizable(null)).toBe(false)
      expect(Tokenizable.isTokenizable(undefined)).toBe(false)
      expect(Tokenizable.isTokenizable({})).toBe(false)
    })
  })

  describe('TokenEncoding constant', () => {
    it('lists every supported encoding', () => {
      expect(TokenEncoding).toContain('gpt2')
      expect(TokenEncoding).toContain('cl100k_base')
      expect(TokenEncoding).toContain('o200k_base')
      expect(TokenEncoding).toContain('gemini')
      expect(TokenEncoding).toContain('llama2')
      expect(TokenEncoding).toContain('claude')
    })

    it('is exposed as a static on the class for runtime access', () => {
      expect(Tokenizable.TokenEncoding).toBe(TokenEncoding)
    })
  })
})
