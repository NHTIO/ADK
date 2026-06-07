import { describe, expect, it } from 'vitest'
import { translateChromaWhere } from '../../../../src/batteries/vector/chroma'

describe('translateChromaWhere', () => {
  it('eq', () => {
    const result = translateChromaWhere({ field: 'kind', op: 'eq', value: 'policy' })
    expect(result).toEqual({ kind: { $eq: 'policy' } })
  })

  it('gte', () => {
    const result = translateChromaWhere({ field: 'year', op: 'gte', value: 2024 })
    expect(result).toEqual({ year: { $gte: 2024 } })
  })

  it('in', () => {
    const result = translateChromaWhere({ field: 'k', op: 'in', value: ['a', 'b'] })
    expect(result).toEqual({ k: { $in: ['a', 'b'] } })
  })

  it('and group', () => {
    const result = translateChromaWhere({
      and: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toEqual({
      $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    })
  })

  it('or group', () => {
    const result = translateChromaWhere({
      or: [
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2 },
      ],
    })
    expect(result).toEqual({
      $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    })
  })

  it('nested A AND (B OR C): recurses into a group within a group', () => {
    const result = translateChromaWhere({
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
    expect(result).toEqual({
      $and: [{ a: { $eq: 1 } }, { $or: [{ b: { $eq: 2 } }, { c: { $eq: 3 } }] }],
    })
  })

  it('exists throws', () => {
    expect(() => translateChromaWhere({ field: 't', op: 'exists' })).toThrow()
  })

  it('not throws', () => {
    expect(() => translateChromaWhere({ not: { field: 'a', op: 'eq', value: 1 } })).toThrow()
  })

  it('nested not (deep) still throws', () => {
    expect(() =>
      translateChromaWhere({
        and: [{ field: 'a', op: 'eq', value: 1 }, { not: { field: 'b', op: 'eq', value: 2 } }],
      })
    ).toThrow()
  })

  it('wrong dialect throws', () => {
    expect(() =>
      translateChromaWhere({ $dialect: 'mongo', $raw: { kind: { $eq: 'policy' } } })
    ).toThrow()
  })

  it('undefined', () => {
    const result = translateChromaWhere(undefined)
    expect(result).toBeUndefined()
  })
})
