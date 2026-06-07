import { describe, expect, it } from 'vitest'
import { translatePineconeFilter } from '../../../../src/batteries/vector/pinecone'

describe('translatePineconeFilter', () => {
  it('eq', () => {
    const result = translatePineconeFilter({ field: 'kind', op: 'eq', value: 'policy' })
    expect(result).toEqual({ kind: { $eq: 'policy' } })
  })

  it('gte', () => {
    const result = translatePineconeFilter({ field: 'year', op: 'gte', value: 2024 })
    expect(result).toEqual({ year: { $gte: 2024 } })
  })

  it('in', () => {
    const result = translatePineconeFilter({ field: 'k', op: 'in', value: ['a', 'b'] })
    expect(result).toEqual({ k: { $in: ['a', 'b'] } })
  })

  it('and group', () => {
    const result = translatePineconeFilter({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toEqual({ $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] })
  })

  it('or group', () => {
    const result = translatePineconeFilter({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toEqual({ $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] })
  })

  it('exists throws', () => {
    expect(() => translatePineconeFilter({ field: 't', op: 'exists' })).toThrow()
  })

  it('contains throws', () => {
    expect(() => translatePineconeFilter({ field: 't', op: 'contains', value: 'x' })).toThrow()
  })

  it('not throws', () => {
    expect(() => translatePineconeFilter({ not: { field: 'a', op: 'eq', value: 1 } })).toThrow()
  })

  it('wrong dialect throws', () => {
    expect(() =>
      translatePineconeFilter({ $dialect: 'mongo', $raw: { kind: { $eq: 'policy' } } })
    ).toThrow()
  })

  it('undefined', () => {
    const result = translatePineconeFilter(undefined)
    expect(result).toBeUndefined()
  })
})
