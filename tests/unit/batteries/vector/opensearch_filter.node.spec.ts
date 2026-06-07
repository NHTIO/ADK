import { describe, expect, it } from 'vitest'
import { translateOpenSearchFilter } from '../../../../src/batteries/vector/opensearch'

// Neutral filter tree → OpenSearch bool-query over metadata.* (keyword for strings).
describe('translateOpenSearchFilter', () => {
  it('eq string => term on .keyword', () => {
    expect(translateOpenSearchFilter({ field: 'kind', op: 'eq', value: 'policy' })).toEqual({
      term: { 'metadata.kind.keyword': 'policy' },
    })
  })

  it('eq number => term on numeric field', () => {
    expect(translateOpenSearchFilter({ field: 'year', op: 'eq', value: 2024 })).toEqual({
      term: { 'metadata.year': 2024 },
    })
  })

  it('gte => range', () => {
    expect(translateOpenSearchFilter({ field: 'year', op: 'gte', value: 2024 })).toEqual({
      range: { 'metadata.year': { gte: 2024 } },
    })
  })

  it('in (strings) => terms on .keyword', () => {
    expect(translateOpenSearchFilter({ field: 'k', op: 'in', value: ['a', 'b'] })).toEqual({
      terms: { 'metadata.k.keyword': ['a', 'b'] },
    })
  })

  it('ne => bool must_not term', () => {
    expect(translateOpenSearchFilter({ field: 'kind', op: 'ne', value: 'x' })).toEqual({
      bool: { must_not: [{ term: { 'metadata.kind.keyword': 'x' } }] },
    })
  })

  it('and => bool must', () => {
    expect(
      translateOpenSearchFilter({
        and: [
          { field: 'a', op: 'eq', value: 'x' },
          { field: 'b', op: 'eq', value: 'y' },
        ],
      })
    ).toEqual({
      bool: {
        must: [{ term: { 'metadata.a.keyword': 'x' } }, { term: { 'metadata.b.keyword': 'y' } }],
      },
    })
  })

  it('or => bool should + minimum_should_match', () => {
    expect(
      translateOpenSearchFilter({
        or: [
          { field: 'a', op: 'eq', value: 'x' },
          { field: 'b', op: 'eq', value: 'y' },
        ],
      })
    ).toEqual({
      bool: {
        should: [{ term: { 'metadata.a.keyword': 'x' } }, { term: { 'metadata.b.keyword': 'y' } }],
        minimum_should_match: 1,
      },
    })
  })

  it('nested A AND (B OR C) => bool.must with a nested bool.should', () => {
    expect(
      translateOpenSearchFilter({
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
    ).toEqual({
      bool: {
        must: [
          { term: { 'metadata.a.keyword': 'x' } },
          {
            bool: {
              should: [
                { term: { 'metadata.b.keyword': 'y' } },
                { term: { 'metadata.c.keyword': 'z' } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    })
  })

  it('top-level NOT (A OR B) => bool.must_not wrapping a bool.should', () => {
    expect(
      translateOpenSearchFilter({
        not: {
          or: [
            { field: 'a', op: 'eq', value: 'x' },
            { field: 'b', op: 'eq', value: 'y' },
          ],
        },
      })
    ).toEqual({
      bool: {
        must_not: [
          {
            bool: {
              should: [
                { term: { 'metadata.a.keyword': 'x' } },
                { term: { 'metadata.b.keyword': 'y' } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    })
  })

  it('no filter => undefined', () => {
    expect(translateOpenSearchFilter(undefined)).toBeUndefined()
  })

  it('raw opensearch/elasticsearch dialects pass through', () => {
    const raw = { term: { foo: 'bar' } }
    expect(translateOpenSearchFilter({ $dialect: 'opensearch', $raw: raw })).toEqual(raw)
    expect(translateOpenSearchFilter({ $dialect: 'elasticsearch', $raw: raw })).toEqual(raw)
  })

  it('raw wrong dialect throws', () => {
    expect(() => translateOpenSearchFilter({ $dialect: 'sql', $raw: 'x=1' })).toThrow()
  })

  it('unsupported operator (contains) throws', () => {
    expect(() => translateOpenSearchFilter({ field: 'f', op: 'contains', value: 'x' })).toThrow()
  })
})
