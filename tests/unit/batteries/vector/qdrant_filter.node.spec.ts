import { describe, expect, it } from 'vitest'
import { translateQdrantFilter } from '../../../../src/batteries/vector/qdrant'

describe('translateQdrantFilter', () => {
  it('eq', () => {
    const result = translateQdrantFilter({ field: 'kind', op: 'eq', value: 'policy' })
    expect(result).toEqual({ must: [{ key: 'kind', match: { value: 'policy' } }] })
  })

  it('gte', () => {
    const result = translateQdrantFilter({ field: 'year', op: 'gte', value: 2024 })
    expect(result).toEqual({ must: [{ key: 'year', range: { gte: 2024 } }] })
  })

  it('in', () => {
    const result = translateQdrantFilter({ field: 'k', op: 'in', value: ['a', 'b'] })
    expect(result).toEqual({ must: [{ key: 'k', match: { any: ['a', 'b'] } }] })
  })

  it('exists', () => {
    const result = translateQdrantFilter({ field: 't', op: 'exists' })
    expect(result).toEqual({ must_not: [{ is_empty: { key: 't' } }] })
  })

  it('and group', () => {
    const result = translateQdrantFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toEqual({
      must: [
        { must: [{ key: 'a', match: { value: 1 } }] },
        { must: [{ key: 'b', match: { value: 2 } }] },
      ],
    })
  })

  it('or group', () => {
    const result = translateQdrantFilter({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toEqual({
      should: [
        { must: [{ key: 'a', match: { value: 1 } }] },
        { must: [{ key: 'b', match: { value: 2 } }] },
      ],
    })
  })

  it('not group', () => {
    const result = translateQdrantFilter({ not: { field: 'a', op: 'eq', value: 1 } })
    expect(result).toEqual({ must_not: [{ must: [{ key: 'a', match: { value: 1 } }] }] })
  })

  it('raw qdrant dialect passthrough', () => {
    const result = translateQdrantFilter({ $dialect: 'qdrant', $raw: { must: [] } })
    expect(result).toEqual({ must: [] })
  })

  it('nested A AND (B OR C): nested OR-group recurses (should inside must)', () => {
    const result = translateQdrantFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        {
          or: [
            { field: 'b', op: 'eq', value: 2 },
            { field: 'c', op: 'eq', value: 3 },
          ],
        },
      ],
    }) as any
    expect(Array.isArray(result.must)).toBe(true)
    expect(result.must.length).toBe(2)
    const nested = result.must.find((m: any) => m.should)
    expect(nested).toBeDefined()
    expect(nested.should.length).toBe(2)
  })

  it('wrong dialect throws', () => {
    expect(() => translateQdrantFilter({ $dialect: 'mongo', $raw: { must: [] } })).toThrow()
  })

  it('undefined', () => {
    const result = translateQdrantFilter(undefined)
    expect(result).toBeUndefined()
  })
})
