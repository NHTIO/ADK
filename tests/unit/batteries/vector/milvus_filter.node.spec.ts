import { describe, expect, it } from 'vitest'
import { translateMilvusFilter } from '../../../../src/batteries/vector/milvus'

describe('translateMilvusFilter', () => {
  it('eq', () => {
    const result = translateMilvusFilter({ field: 'kind', op: 'eq', value: 'policy' })
    expect(result).toContain('metadata["kind"] == "policy"')
  })

  it('gte', () => {
    const result = translateMilvusFilter({ field: 'year', op: 'gte', value: 2024 })
    expect(result).toContain('>= 2024')
  })

  it('in', () => {
    const result = translateMilvusFilter({ field: 'k', op: 'in', value: ['a', 'b'] })
    expect(result).toContain('in [')
  })

  it('and', () => {
    const result = translateMilvusFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toContain('&&')
  })

  it('or', () => {
    const result = translateMilvusFilter({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toContain('||')
  })

  it('nested A AND (B OR C): nested OR recurses inside the AND expression', () => {
    const result = translateMilvusFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        {
          or: [
            { field: 'b', op: 'eq', value: 2 },
            { field: 'c', op: 'eq', value: 3 },
          ],
        },
      ],
    })
    expect(result).toContain('&&')
    expect(result).toContain('||')
    expect(result).toContain('metadata["b"] == 2')
    expect(result).toContain('metadata["c"] == 3')
  })

  it('nested not within a group: !( ) recurses', () => {
    const result = translateMilvusFilter({
      and: [{ field: 'a', op: 'eq', value: 1 }, { not: { field: 'b', op: 'eq', value: 2 } }],
    })
    expect(result).toContain('!(')
    expect(result).toContain('metadata["b"] == 2')
  })

  it('wrong dialect throws', () => {
    expect(() => translateMilvusFilter({ $dialect: 'mongo', $raw: '' })).toThrow()
  })

  it('undefined', () => {
    const result = translateMilvusFilter(undefined)
    expect(result).toBe('')
  })
})
