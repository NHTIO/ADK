import { describe, it, expect } from 'vitest'
import { translatePgFilter } from '../../../../src/batteries/vector/pgvector'

describe('translatePgFilter', () => {
  it('eq', () => {
    const result = translatePgFilter({ field: 'kind', op: 'eq', value: 'policy' })
    expect(result.sql).toContain("metadata->>'kind' = $1")
    expect(result.params[0]).toBe('policy')
  })

  it('gte numeric', () => {
    const result = translatePgFilter({ field: 'year', op: 'gte', value: 2024 })
    expect(result.sql).toContain("(metadata->>'year')::numeric >= $1")
  })

  it('in', () => {
    const result = translatePgFilter({ field: 'k', op: 'in', value: ['a', 'b'] })
    expect(result.sql).toContain('ANY($1)')
    expect(result.params[0]).toEqual(['a', 'b'])
  })

  it('and group', () => {
    const result = translatePgFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result.sql).toContain(' AND ')
    expect(result.params.length).toBe(2)
  })

  it('or group', () => {
    const result = translatePgFilter({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result.sql).toContain(' OR ')
  })

  it('not', () => {
    const result = translatePgFilter({ not: { field: 'a', op: 'eq', value: 1 } })
    expect(result.sql).toContain('NOT ')
  })

  it('exists', () => {
    const result = translatePgFilter({ field: 't', op: 'exists' })
    expect(result.sql).toContain('metadata ? ')
  })

  it('raw with bindings', () => {
    const result = translatePgFilter({ $dialect: 'sql', $raw: 'x > ?', $bindings: [5] })
    expect(result.sql).toContain('$1')
    expect(result.params[0]).toBe(5)
  })

  it('injection safety', () => {
    const result = translatePgFilter({ $dialect: 'sql', $raw: 'x > ?', $bindings: [5] })
    expect(result.params).includes(5)
    expect(result.sql).not.toContain('5')
  })

  it('unsupported dialect', () => {
    expect(() => translatePgFilter({ $dialect: 'mongo', $raw: {} })).toThrow()
  })
})
