import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  compareRecordsTool,
  compareValuesTool,
} from '../../../../../src/batteries/tools/comparison'

const runCmp = async (args: Record<string, unknown>): Promise<string> => {
  return (await compareValuesTool.executor(makeToolCtxStub())(args)) as string
}

const runRec = async (args: Record<string, unknown>): Promise<string> => {
  return (await compareRecordsTool.executor(makeToolCtxStub())(args)) as string
}

describe('compareValuesTool', () => {
  describe('auto (default)', () => {
    it('detects equal numbers', async () => {
      expect(await runCmp({ a: 5, b: 5 })).toBe('equal')
    })

    it('detects greater_than for numeric a > b', async () => {
      expect(await runCmp({ a: 10, b: 5 })).toBe('greater_than')
    })

    it('detects less_than for numeric a < b', async () => {
      expect(await runCmp({ a: 1, b: 5 })).toBe('less_than')
    })

    it('coerces numeric-looking strings to numbers', async () => {
      expect(await runCmp({ a: '10', b: '5' })).toBe('greater_than')
    })

    it('compares strings lexicographically when not numeric', async () => {
      expect(await runCmp({ a: 'banana', b: 'apple' })).toBe('greater_than')
    })

    it('treats null < non-null', async () => {
      expect(await runCmp({ a: null, b: 5 })).toBe('less_than')
    })

    it('null vs null is equal', async () => {
      expect(await runCmp({ a: null, b: null })).toBe('equal')
    })
  })

  describe('type_hint: number', () => {
    it('forces numeric comparison', async () => {
      expect(await runCmp({ a: '10', b: '5', type_hint: 'number' })).toBe('greater_than')
    })

    it('returns an error when a is not numeric', async () => {
      const out = await runCmp({ a: 'foo', b: '5', type_hint: 'number' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('foo')
    })

    it('returns an error when b is not numeric', async () => {
      const out = await runCmp({ a: '5', b: 'bar', type_hint: 'number' })
      expect(out).toMatch(/^Error/)
    })
  })

  describe('type_hint: string', () => {
    it('compares as strings even when both are numeric-looking', async () => {
      // "100" < "20" lexicographically (because '1' < '2')
      expect(await runCmp({ a: '100', b: '20', type_hint: 'string' })).toBe('less_than')
    })

    it('case_insensitive comparison ignores casing', async () => {
      expect(
        await runCmp({ a: 'HELLO', b: 'hello', type_hint: 'string', case_insensitive: true })
      ).toBe('equal')
    })
  })

  describe('type_hint: date', () => {
    it('compares ISO date strings chronologically', async () => {
      const out = await runCmp({
        a: '2024-01-01T00:00:00Z',
        b: '2023-01-01T00:00:00Z',
        type_hint: 'date',
      })
      expect(out).toMatch(/greater_than/)
      expect(out).toContain('2024-01-01')
      expect(out).toContain('2023-01-01')
    })

    it('returns an error for unparseable date strings', async () => {
      const out = await runCmp({ a: 'not a date', b: '2024-01-01', type_hint: 'date' })
      expect(out).toMatch(/^Error/)
    })
  })

  describe('schema rejection', () => {
    it('rejects unknown type_hint', async () => {
      await expect(runCmp({ a: 1, b: 2, type_hint: 'xyz' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })
})

describe('compareRecordsTool', () => {
  describe('happy path', () => {
    it('reports both keys under "Same value" when records are equivalent', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ name: 'alice', age: 30 }),
        record_b: JSON.stringify({ name: 'alice', age: 30 }),
      })
      expect(out).toContain('Same value (2)')
      expect(out).toContain('name')
      expect(out).toContain('age')
    })

    it('returns "Records are identical." for two empty objects', async () => {
      const out = await runRec({
        record_a: JSON.stringify({}),
        record_b: JSON.stringify({}),
      })
      expect(out).toBe('Records are identical.')
    })

    it('reports keys only in A', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ name: 'alice', age: 30 }),
        record_b: JSON.stringify({ name: 'alice' }),
      })
      expect(out).toContain('Only in A')
      expect(out).toContain('age')
    })

    it('reports keys only in B', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ name: 'alice' }),
        record_b: JSON.stringify({ name: 'alice', age: 30 }),
      })
      expect(out).toContain('Only in B')
      expect(out).toContain('age')
    })

    it('reports keys with different values', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ name: 'alice' }),
        record_b: JSON.stringify({ name: 'bob' }),
      })
      expect(out).toContain('Different value')
      expect(out).toContain('A="alice"')
      expect(out).toContain('B="bob"')
    })

    it('lists keys with the same value', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ name: 'alice', age: 30, role: 'admin' }),
        record_b: JSON.stringify({ name: 'alice', age: 30, role: 'user' }),
      })
      expect(out).toContain('Same value (2)')
    })
  })

  describe('deep equality', () => {
    it('treats nested objects with the same content as equal (deep: true, default)', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ user: { name: 'alice', tags: ['x', 'y'] } }),
        record_b: JSON.stringify({ user: { name: 'alice', tags: ['x', 'y'] } }),
      })
      expect(out).toContain('Same value (1)')
      expect(out).toContain('user')
      expect(out).not.toContain('Different')
    })

    it('detects nested differences via deep comparison', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ user: { name: 'alice', tags: ['x'] } }),
        record_b: JSON.stringify({ user: { name: 'alice', tags: ['y'] } }),
      })
      expect(out).toContain('Different value')
    })

    it('with deep: false, falls back to JSON.stringify comparison', async () => {
      // For these inputs deep:false yields the same result as deep:true, but the path is exercised.
      const out = await runRec({
        record_a: JSON.stringify({ a: 1 }),
        record_b: JSON.stringify({ a: 1 }),
        deep: false,
      })
      expect(out).toContain('Same value (1)')
      expect(out).not.toContain('Different')
    })
  })

  describe('error paths', () => {
    it('returns an error for malformed record_a JSON', async () => {
      const out = await runRec({ record_a: 'not json {', record_b: '{}' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('record_a')
    })

    it('returns an error for malformed record_b JSON', async () => {
      const out = await runRec({ record_a: '{}', record_b: 'not json {' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('record_b')
    })

    it('rejects array roots in record_a', async () => {
      const out = await runRec({ record_a: '[1,2,3]', record_b: '{}' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('must be a JSON object')
    })

    it('rejects primitive root in record_a', async () => {
      const out = await runRec({ record_a: '42', record_b: '{}' })
      expect(out).toMatch(/^Error/)
    })
  })
})
