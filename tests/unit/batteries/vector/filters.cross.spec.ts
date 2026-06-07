import { describe, expect, it } from 'vitest'
import { evaluateFilter, raw, isRawExpr } from '../../../../src/batteries/vector/filters'
import type { VectorFilter } from '../../../../src/batteries/vector/filters'

describe('filters', () => {
  const meta = { kind: 'policy', year: 2024, tags: ['a', 'b'], nested: { x: 5 } }

  it('eq: matches exact value', () => {
    expect(evaluateFilter({ field: 'kind', op: 'eq', value: 'policy' }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'kind', op: 'eq', value: 'rule' }, meta)).toBe(false)
  })

  it('ne: matches non-equal value', () => {
    expect(evaluateFilter({ field: 'kind', op: 'ne', value: 'rule' }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'kind', op: 'ne', value: 'policy' }, meta)).toBe(false)
  })

  it('gt: greater than (numeric)', () => {
    expect(evaluateFilter({ field: 'year', op: 'gt', value: 2020 }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'year', op: 'gt', value: 2024 }, meta)).toBe(false)
  })

  it('gte: greater than or equal (numeric)', () => {
    expect(evaluateFilter({ field: 'year', op: 'gte', value: 2024 }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'year', op: 'gte', value: 2025 }, meta)).toBe(false)
  })

  it('lt: less than (numeric)', () => {
    expect(evaluateFilter({ field: 'year', op: 'lt', value: 2030 }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'year', op: 'lt', value: 2024 }, meta)).toBe(false)
  })

  it('lte: less than or equal (numeric)', () => {
    expect(evaluateFilter({ field: 'year', op: 'lte', value: 2024 }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'year', op: 'lte', value: 2023 }, meta)).toBe(false)
  })

  it('in: value in array', () => {
    expect(evaluateFilter({ field: 'kind', op: 'in', value: ['policy', 'rule'] }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'kind', op: 'in', value: ['rule', 'other'] }, meta)).toBe(false)
  })

  it('nin: value not in array', () => {
    expect(evaluateFilter({ field: 'kind', op: 'nin', value: ['rule', 'other'] }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'kind', op: 'nin', value: ['policy', 'rule'] }, meta)).toBe(
      false
    )
  })

  it('exists: field present (default value:true)', () => {
    expect(evaluateFilter({ field: 'kind', op: 'exists' }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'missing', op: 'exists' }, meta)).toBe(false)
  })

  it('exists: field present but value:false', () => {
    expect(evaluateFilter({ field: 'kind', op: 'exists', value: false }, meta)).toBe(false)
    expect(evaluateFilter({ field: 'missing', op: 'exists', value: false }, meta)).toBe(true)
  })

  it('contains: array contains value', () => {
    expect(evaluateFilter({ field: 'tags', op: 'contains', value: 'a' }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'tags', op: 'contains', value: 'c' }, meta)).toBe(false)
  })

  it('contains: string contains substring', () => {
    expect(evaluateFilter({ field: 'kind', op: 'contains', value: 'pol' }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'kind', op: 'contains', value: 'xyz' }, meta)).toBe(false)
  })

  it('dot-path field: nested.x', () => {
    expect(evaluateFilter({ field: 'nested.x', op: 'eq', value: 5 }, meta)).toBe(true)
    expect(evaluateFilter({ field: 'nested.x', op: 'eq', value: 10 }, meta)).toBe(false)
  })

  it('and-group: all conditions true', () => {
    expect(
      evaluateFilter(
        {
          and: [
            { field: 'kind', op: 'eq', value: 'policy' },
            { field: 'year', op: 'gte', value: 2024 },
          ],
        },
        meta
      )
    ).toBe(true)
    expect(
      evaluateFilter(
        {
          and: [
            { field: 'kind', op: 'eq', value: 'rule' },
            { field: 'year', op: 'gte', value: 2024 },
          ],
        },
        meta
      )
    ).toBe(false)
  })

  it('or-group: any condition true', () => {
    expect(
      evaluateFilter(
        {
          or: [
            { field: 'kind', op: 'eq', value: 'policy' },
            { field: 'year', op: 'lt', value: 2020 },
          ],
        },
        meta
      )
    ).toBe(true)
    expect(
      evaluateFilter(
        {
          or: [
            { field: 'kind', op: 'eq', value: 'rule' },
            { field: 'year', op: 'lt', value: 2020 },
          ],
        },
        meta
      )
    ).toBe(false)
  })

  it('not-group: negates result', () => {
    expect(evaluateFilter({ not: { field: 'kind', op: 'eq', value: 'rule' } }, meta)).toBe(true)
    expect(evaluateFilter({ not: { field: 'kind', op: 'eq', value: 'policy' } }, meta)).toBe(false)
  })

  it('empty and-group => true', () => {
    expect(evaluateFilter({ and: [] }, meta)).toBe(true)
  })

  it('empty or-group => false', () => {
    expect(evaluateFilter({ or: [] }, meta)).toBe(false)
  })

  it('A AND (B OR C): outer AND with a nested OR branch', () => {
    const nestedOr: VectorFilter = {
      or: [
        { field: 'year', op: 'gte', value: 2030 },
        { field: 'tags', op: 'contains', value: 'a' },
      ],
    }
    // kind='policy' AND (year>=2030 OR tags contains 'a') — true via the OR's second arm
    expect(
      evaluateFilter({ and: [{ field: 'kind', op: 'eq', value: 'policy' }, nestedOr] }, meta)
    ).toBe(true)
    // flip the outer AND to false
    expect(
      evaluateFilter({ and: [{ field: 'kind', op: 'eq', value: 'rule' }, nestedOr] }, meta)
    ).toBe(false)
  })

  it('builder DNF shape { or: [{ and: [...] }, { and: [...] }] } evaluates correctly', () => {
    const secondArm: VectorFilter = { and: [{ field: 'year', op: 'lt', value: 2020 }] }
    // (kind='rule' AND year>=2024) OR (year<2020) — both arms false => false
    expect(
      evaluateFilter(
        {
          or: [
            {
              and: [
                { field: 'kind', op: 'eq', value: 'rule' },
                { field: 'year', op: 'gte', value: 2024 },
              ],
            },
            secondArm,
          ],
        },
        meta
      )
    ).toBe(false)
    // first arm now matches (kind='policy')
    expect(
      evaluateFilter(
        { or: [{ and: [{ field: 'kind', op: 'eq', value: 'policy' }] }, secondArm] },
        meta
      )
    ).toBe(true)
  })

  it('NOT (A OR B): negated group', () => {
    // NOT (kind='rule' OR year<2020) => NOT(false) => true
    expect(
      evaluateFilter(
        {
          not: {
            or: [
              { field: 'kind', op: 'eq', value: 'rule' },
              { field: 'year', op: 'lt', value: 2020 },
            ],
          },
        },
        meta
      )
    ).toBe(true)
    // NOT (kind='policy' OR ...) => NOT(true) => false
    expect(
      evaluateFilter(
        {
          not: {
            or: [
              { field: 'kind', op: 'eq', value: 'policy' },
              { field: 'year', op: 'lt', value: 2020 },
            ],
          },
        },
        meta
      )
    ).toBe(false)
  })

  it('deep nesting and > or > not evaluates correctly', () => {
    // kind='policy' AND (year>=2030 OR NOT(tags contains 'c')) => true AND (false OR NOT(false)) => true
    expect(
      evaluateFilter(
        {
          and: [
            { field: 'kind', op: 'eq', value: 'policy' },
            {
              or: [
                { field: 'year', op: 'gte', value: 2030 },
                { not: { field: 'tags', op: 'contains', value: 'c' } },
              ],
            },
          ],
        },
        meta
      )
    ).toBe(true)
  })

  it('raw() produces { __raw, bindings }', () => {
    const expr = raw('year > ?', [2020])
    expect(expr.__raw).toBe('year > ?')
    expect(expr.bindings).toEqual([2020])
  })

  it('isRawExpr returns true for raw() result', () => {
    expect(isRawExpr(raw('year > ?', [2020]))).toBe(true)
    expect(isRawExpr({ field: 'kind', op: 'eq', value: 'policy' })).toBe(false)
  })

  it('evaluateFilter throws on a RawFilter node', () => {
    expect(() => evaluateFilter({ $dialect: 'sql', $raw: 'x=1' }, meta)).toThrow()
  })

  it('evaluateFilter throws on a RawExpr value', () => {
    expect(() => evaluateFilter({ field: 'a', op: 'eq', value: raw('?', [1]) }, meta)).toThrow()
  })
})
