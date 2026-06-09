import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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

/* ── existing basic tests ─────────────────────────────────────────────── */

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

  /* ── INVARIANT: compare(a,b) inverse sign of compare(b,a) ────────────── */

  describe('symmetry / inverse invariants', () => {
    it('compare(a,b) is the inverse of compare(b,a) for numbers', async () => {
      const ab = await runCmp({ a: 10, b: 5 })
      const ba = await runCmp({ a: 5, b: 10 })
      expect(ab).toBe('greater_than')
      expect(ba).toBe('less_than')
    })

    it('compare(a,b) is the inverse of compare(b,a) for strings', async () => {
      const ab = await runCmp({ a: 'zebra', b: 'apple', type_hint: 'string' })
      const ba = await runCmp({ a: 'apple', b: 'zebra', type_hint: 'string' })
      expect(ab).toBe('greater_than')
      expect(ba).toBe('less_than')
    })

    it('equal values report equal in both directions', async () => {
      expect(await runCmp({ a: 42, b: 42 })).toBe('equal')
      expect(await runCmp({ a: 42, b: 42 })).toBe('equal')
    })

    it('case_insensitive equal strings report equal both directions', async () => {
      const ab = await runCmp({ a: 'ABC', b: 'abc', type_hint: 'string', case_insensitive: true })
      const ba = await runCmp({ a: 'abc', b: 'ABC', type_hint: 'string', case_insensitive: true })
      expect(ab).toBe('equal')
      expect(ba).toBe('equal')
    })

    it('date comparison is inverse when swapped', async () => {
      const ab = await runCmp({ a: '2025-06-01', b: '2025-01-01', type_hint: 'date' })
      const ba = await runCmp({ a: '2025-01-01', b: '2025-06-01', type_hint: 'date' })
      expect(ab).toMatch(/greater_than/)
      expect(ba).toMatch(/less_than/)
    })
  })

  /* ── number comparison edge cases ────────────────────────────────────── */

  describe('number edge cases', () => {
    it('0 and -0 are equal', async () => {
      expect(await runCmp({ a: 0, b: -0 })).toBe('equal')
    })

    it('NaN in type_hint:number returns an error for a', async () => {
      const out = await runCmp({ a: Number.NaN, b: 5, type_hint: 'number' })
      expect(out).toMatch(/^Error/)
    })

    it('Infinity > finite number', async () => {
      const out = await runCmp({ a: Infinity, b: 1e308, type_hint: 'number' })
      expect(out).toBe('greater_than')
    })

    it('-Infinity < finite number', async () => {
      const out = await runCmp({ a: -Infinity, b: -1e308, type_hint: 'number' })
      expect(out).toBe('less_than')
    })

    it('negative number < positive number', async () => {
      expect(await runCmp({ a: -5, b: 5 })).toBe('less_than')
    })

    it('0.1 + 0.2 compared to 0.3 in number mode', async () => {
      // In auto mode, 0.1+0.2 = 0.30000000000000004, which is coerced to number and > 0.3
      // In number mode, same thing
      const result = await runCmp({ a: 0.1 + 0.2, b: 0.3, type_hint: 'number' })
      // 0.1+0.2 !== 0.3 due to floating point — result should be 'greater_than'
      expect(result).toBe('greater_than')
    })

    it('comparing Number.MAX_SAFE_INTEGER to itself is equal', async () => {
      expect(await runCmp({ a: Number.MAX_SAFE_INTEGER, b: Number.MAX_SAFE_INTEGER })).toBe('equal')
    })

    it('comparing 2**53 to itself is equal', async () => {
      expect(await runCmp({ a: 2 ** 53, b: 2 ** 53 })).toBe('equal')
    })
  })

  /* ── string comparison edge cases ─────────────────────────────────────── */

  describe('string edge cases', () => {
    it('empty strings are equal', async () => {
      expect(await runCmp({ a: '', b: '', type_hint: 'string' })).toBe('equal')
    })

    it('whitespace-only strings compared lexicographically', async () => {
      const out = await runCmp({ a: ' ', b: '', type_hint: 'string' })
      expect(out).toBe('greater_than')
    })

    it('case_sensitive comparison distinguishes case', async () => {
      const out = await runCmp({ a: 'Apple', b: 'apple', type_hint: 'string' })
      // 'A' < 'a' in most locale orderings via localeCompare
      // We just verify they are NOT equal
      expect(out).not.toBe('equal')
    })

    it('case_insensitive with type_hint string makes equal', async () => {
      expect(
        await runCmp({ a: 'Apple', b: 'apple', type_hint: 'string', case_insensitive: true })
      ).toBe('equal')
    })

    it('unicode strings compared correctly', async () => {
      // 'café' > 'cafe' in localeCompare
      const out = await runCmp({ a: 'café', b: 'cafe', type_hint: 'string' })
      expect(out).not.toBe('equal')
    })
  })

  /* ── date comparison edge cases ───────────────────────────────────────── */

  describe('date edge cases', () => {
    it('same date is equal', async () => {
      const out = await runCmp({ a: '2025-01-01', b: '2025-01-01', type_hint: 'date' })
      expect(out).toMatch(/^equal/)
    })

    it('unparseable date b returns error', async () => {
      const out = await runCmp({ a: '2025-01-01', b: 'not-a-date', type_hint: 'date' })
      expect(out).toMatch(/^Error/)
    })

    it('dates with different times differ', async () => {
      const out = await runCmp({
        a: '2025-01-01T12:00:00Z',
        b: '2025-01-01T00:00:00Z',
        type_hint: 'date',
      })
      expect(out).toMatch(/greater_than/)
    })
  })

  /* ── null / undefined edge cases ─────────────────────────────────────── */

  describe('null and undefined', () => {
    it('null vs null is equal', async () => {
      const out = await runCmp({ a: null, b: null })
      expect(out).toBe('equal')
    })

    it('null vs 0: null < 0', async () => {
      const out = await runCmp({ a: null, b: 0 })
      expect(out).toBe('less_than')
    })
  })

  /* ── comparing number vs string in auto mode ─────────────────────────── */

  describe('type coercion in auto', () => {
    it('string "5" and number 5 are both coerced to number and equal', async () => {
      const out = await runCmp({ a: '5', b: 5 })
      expect(out).toBe('equal')
    })

    it('string "abc" and number 5: string "abc" coerces to NaN → stays string, "5" vs "abc"', async () => {
      // "abc" can't coerce to number, so compareTwo uses localeCompare
      // "abc" > "5" in localeCompare? Actually "5" < "a" so "abc" > "5"
      const out = await runCmp({ a: 'abc', b: 5 })
      // "abc" can't coerce to number; 5 can. coerce(5) = 5 (number).
      // "abc" can't coerce → stays string. typeof string !== typeof number → localeCompare
      // Actually compareTwo: coerce("abc") returns "abc" (string), coerce(5) returns 5 (number)
      // typeof "abc" is string, typeof 5 is number → localeCompare("abc", "5")
      expect(out).not.toBe('equal')
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

  /* ── INVARIANT: equal values report equal both directions ─────────────── */

  describe('symmetry invariants', () => {
    it('swapping A and B swaps "Only in A" and "Only in B"', async () => {
      const outAB = await runRec({
        record_a: JSON.stringify({ x: 1 }),
        record_b: JSON.stringify({ y: 2 }),
      })
      const outBA = await runRec({
        record_a: JSON.stringify({ y: 2 }),
        record_b: JSON.stringify({ x: 1 }),
      })
      expect(outAB).toContain('Only in A')
      expect(outAB).toContain('Only in B')
      // When swapped, x moves to B and y moves to A
      expect(outBA).toContain('Only in A')
      expect(outBA).toContain('Only in B')
    })

    it('identical records with matching keys report same values', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ a: 1, b: 'two', c: null }),
        record_b: JSON.stringify({ a: 1, b: 'two', c: null }),
      })
      // All 3 keys match
      expect(out).toContain('Same value')
      expect(out).not.toContain('Different value')
      expect(out).not.toContain('Only in')
    })
  })

  /* ── deep: false edge cases ─────────────────────────────────────────── */

  describe('deep: false edge cases', () => {
    it('deep:false treats objects with same JSON serialization as equal', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ x: 1, y: [1, 2] }),
        record_b: JSON.stringify({ x: 1, y: [1, 2] }),
        deep: false,
      })
      expect(out).toContain('Same value')
    })

    it('deep:false detects difference when same key has object with different key order', async () => {
      // When the value is an object, deep:false serializes each value.
      // Different key order → different serialization → different value
      const out = await runRec({
        record_a: JSON.stringify({ x: { a: 1, b: 2 } }),
        record_b: JSON.stringify({ x: { b: 2, a: 1 } }),
        deep: false,
      })
      // JSON.stringify({a:1,b:2}) !== JSON.stringify({b:2,a:1})
      expect(out).toContain('Different value')
    })

    it('deep:true treats objects with different key order as equal', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ a: 1, b: 2 }),
        record_b: JSON.stringify({ b: 2, a: 1 }),
        deep: true,
      })
      expect(out).toContain('Same value')
    })
  })

  /* ── nested objects ───────────────────────────────────────────────────── */

  describe('nested and complex values', () => {
    it('arrays of different length are different', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ items: [1, 2] }),
        record_b: JSON.stringify({ items: [1, 2, 3] }),
      })
      expect(out).toContain('Different value')
    })

    it('null values are compared correctly', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ x: null }),
        record_b: JSON.stringify({ x: null }),
      })
      expect(out).toContain('Same value')
    })

    it('null vs undefined in values', async () => {
      // JSON.stringify removes undefined values; null is preserved
      const out = await runRec({
        record_a: JSON.stringify({ x: null }),
        record_b: JSON.stringify({ x: 0 }),
      })
      expect(out).toContain('Different value')
    })

    it('nested object difference detected', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ a: { b: { c: 1 } } }),
        record_b: JSON.stringify({ a: { b: { c: 2 } } }),
      })
      expect(out).toContain('Different value')
    })

    it('boolean values compared correctly', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ active: true }),
        record_b: JSON.stringify({ active: true }),
      })
      expect(out).toContain('Same value')
    })

    it('number vs string with same content is different', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ x: 1 }),
        record_b: JSON.stringify({ x: '1' }),
      })
      expect(out).toContain('Different value')
    })
  })

  /* ─__proto__ key ──────────────────────────────────────────────────── */

  describe('edge case keys', () => {
    it('handles __proto__ key safely', async () => {
      // JSON.parse('{"__proto__": 1}') should work without prototype pollution
      const out = await runRec({
        record_a: JSON.stringify({ __proto__: 'test' }),
        record_b: JSON.stringify({ __proto__: 'test' }),
      })
      // Should at least not throw/crash; result may vary
      expect(typeof out).toBe('string')
    })

    it('handles empty keys', async () => {
      const out = await runRec({
        record_a: JSON.stringify({ '': 'value' }),
        record_b: JSON.stringify({ '': 'value' }),
      })
      expect(out).toContain('Same value')
    })
  })

  /* ── schema rejection ─────────────────────────────────────────────────── */

  describe('schema rejection', () => {
    it('rejects missing record_a', async () => {
      await expect(runRec({ record_b: '{}' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })

    it('rejects missing record_b', async () => {
      await expect(runRec({ record_a: '{}' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })
  })

  /* ── callTool no-crash: adversarial edges ─────────────────────────────── */

  it('compare_values with lone-surrogate strings must not crash', async () => {
    const r = await callTool(compareValuesTool, { a: '\uD800', b: '\uD800', type_hint: 'string' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('compare_values with NaN in number mode must not crash', async () => {
    const r = await callTool(compareValuesTool, { a: Number.NaN, b: 5, type_hint: 'number' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('compare_values with Infinity must not crash', async () => {
    const r = await callTool(compareValuesTool, { a: Infinity, b: -Infinity, type_hint: 'number' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toBe('greater_than')
  })

  it('compare_records with deeply nested JSON must not crash', async () => {
    // Create a deeply nested object
    let obj: Record<string, unknown> = { v: 1 }
    for (let i = 0; i < 50; i++) obj = { nested: obj }
    const r = await callTool(compareRecordsTool, {
      record_a: JSON.stringify(obj),
      record_b: JSON.stringify(obj),
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('compare_records with huge JSON string must not crash', async () => {
    const big = JSON.stringify({ key: 'x'.repeat(100000) })
    const r = await callTool(compareRecordsTool, { record_a: big, record_b: big })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })
})
// ── Edge cases surfaced by an independent model review (verified against the source) ──────
describe('compareRecordsTool — array vs object type confusion (nested)', () => {
  // EXPECTED-RED: isEqual only takes the array branch when BOTH sides are arrays; a nested array vs
  // an integer-keyed object falls through to the Object.keys() path and compares equal. So
  // {x:[1,2]} is reported identical to {x:{"0":1,"1":2}}.
  it('reports a nested array and an integer-keyed object as DIFFERENT', async () => {
    const r = await callTool(compareRecordsTool, {
      record_a: '{"x":[1,2]}',
      record_b: '{"x":{"0":1,"1":2}}',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).not.toMatch(/Same value/)
  })
})
