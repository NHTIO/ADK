import { describe, expect, it } from 'vitest'
import { translateRedisFilter } from '../../../../src/batteries/vector/redis'

// RediSearch query-syntax compilation: TAG fields use @f:{v}, NUMERIC use @f:[lo hi].
describe('translateRedisFilter', () => {
  it('eq string => TAG', () => {
    expect(translateRedisFilter({ field: 'kind', op: 'eq', value: 'policy' })).toBe(
      '@kind:{policy}'
    )
  })

  it('eq number => NUMERIC exact range', () => {
    expect(translateRedisFilter({ field: 'year', op: 'eq', value: 2024 })).toBe('@year:[2024 2024]')
  })

  it('gte / lt => numeric ranges with inclusive/exclusive bounds', () => {
    expect(translateRedisFilter({ field: 'year', op: 'gte', value: 2024 })).toBe(
      '@year:[2024 +inf]'
    )
    expect(translateRedisFilter({ field: 'year', op: 'lt', value: 2024 })).toBe(
      '@year:[-inf (2024]'
    )
  })

  it('in => TAG alternation', () => {
    expect(translateRedisFilter({ field: 'k', op: 'in', value: ['a', 'b'] })).toBe('@k:{a|b}')
  })

  it('ne string => negated TAG', () => {
    expect(translateRedisFilter({ field: 'kind', op: 'ne', value: 'x' })).toBe('-@kind:{x}')
  })

  it('and group joins with space', () => {
    const out = translateRedisFilter({
      and: [
        { field: 'a', op: 'eq', value: 'x' },
        { field: 'b', op: 'eq', value: 'y' },
      ],
    })
    expect(out).toBe('(@a:{x} @b:{y})')
  })

  it('or group joins with pipe', () => {
    const out = translateRedisFilter({
      or: [
        { field: 'a', op: 'eq', value: 'x' },
        { field: 'b', op: 'eq', value: 'y' },
      ],
    })
    expect(out).toBe('(@a:{x} | @b:{y})')
  })

  it('nested A AND (B OR C): nested OR-group recurses inside the AND', () => {
    const out = translateRedisFilter({
      and: [
        { field: 'a', op: 'eq', value: 'x' },
        {
          or: [
            { field: 'b', op: 'eq', value: 'y' },
            { field: 'c', op: 'eq', value: 'z' },
          ],
        },
      ],
    })
    expect(out).toBe('(@a:{x} (@b:{y} | @c:{z}))')
  })

  it('top-level NOT (A OR B): negation prefixes the nested group', () => {
    const out = translateRedisFilter({
      not: {
        or: [
          { field: 'a', op: 'eq', value: 'x' },
          { field: 'b', op: 'eq', value: 'y' },
        ],
      },
    })
    expect(out).toBe('-(@a:{x} | @b:{y})')
  })

  it('no filter => match-all', () => {
    expect(translateRedisFilter(undefined)).toBe('*')
  })

  it('raw redis dialect passes through', () => {
    expect(translateRedisFilter({ $dialect: 'redis', $raw: '@foo:{bar}' })).toBe('@foo:{bar}')
  })

  it('raw non-redis dialect throws', () => {
    expect(() => translateRedisFilter({ $dialect: 'sql', $raw: 'x = 1' })).toThrow()
  })

  it('unsupported operator (contains) throws', () => {
    expect(() => translateRedisFilter({ field: 'f', op: 'contains', value: 'x' })).toThrow()
  })
})
