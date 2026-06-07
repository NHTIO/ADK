import { describe, expect, it } from 'vitest'
import { VectorQueryBuilder } from '../../../../src/batteries/vector/builder'

describe('VectorQueryBuilder', () => {
  const sink = {
    executeSearch: async (p: any) => {
      captured = p
      return []
    },
    executeUpsert: async (p: any) => {
      captured = p
    },
    executeDelete: async (p: any) => {
      captured = p
    },
  }
  let captured: any

  it('where(field,value)=>eq cond', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toMatchObject({ and: [{ field: 'kind', op: 'eq', value: 'policy' }] })
  })

  it('where(field,>=,n) normalizes to gte op', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('year', '>=', 2024)
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter.and[0].op).toBe('gte')
  })

  it('whereIn=>in', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .whereIn('kind', ['policy', 'rule'])
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter.and[0].op).toBe('in')
  })

  it('chained where => and-group with 2 conds', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .where('year', 2024)
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter.and.length).toBe(2)
  })

  it('orWhere => or group', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .orWhere('kind', 'rule')
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter.or).toBeDefined()
  })

  it('nearVector sets near', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .nearVector([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
      .select('id')
    expect(captured.near).toEqual({ vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] })
  })

  it('nearText sets near', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10).nearText('test query').select('id')
    expect(captured.near).toEqual({ serverText: 'test query' })
  })

  it('nearId sets near', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10).nearId('doc1').select('id')
    expect(captured.near).toEqual({ id: 'doc1' })
  })

  it('two near* throws', () => {
    expect(() =>
      new VectorQueryBuilder(sink, 'docs', 10).nearVector([1, 2, 3]).nearText('x')
    ).toThrow()
  })

  it('no .select() before await throws', async () => {
    await expect(new VectorQueryBuilder(sink, 'docs', 10).where('k', 'v')).rejects.toThrow()
  })

  it('select(*) sets all 4 projection cols', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10).nearVector([1, 2, 3]).select('*')
    expect(captured.projection).toMatchObject({ id: true, vector: {}, document: {}, metadata: {} })
  })

  it('select(id,document) sets those', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10).nearVector([1, 2, 3]).select('id', 'document')
    expect(captured.projection).toMatchObject({ id: true, document: {} })
  })

  it('whereRaw with mismatched ? count vs bindings throws', async () => {
    await expect(
      new VectorQueryBuilder(sink, 'docs', 10)
        .whereRaw('year > ? AND kind = ?', [2024])
        .nearVector([1, 2, 3])
        .select('id')
    ).rejects.toThrow()
  })

  it('upsert => UpsertPlan with records', async () => {
    const records = [
      {
        id: 'doc1',
        document: 'test',
        metadata: {},
        vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      },
    ]
    await new VectorQueryBuilder(sink, 'docs', 10).upsert(records)
    expect(captured.records[0].id).toBe('doc1')
  })

  it('whereIn(id,[...]).delete() => DeletePlan with ids', async () => {
    await new VectorQueryBuilder(sink, 'docs', 10).whereIn('id', ['doc1', 'doc2']).delete()
    expect(captured.collection).toBe('docs')
    expect(captured.ids).toEqual(['doc1', 'doc2'])
  })

  it('.consistency(mode) threads into the UpsertPlan', async () => {
    await new VectorQueryBuilder(sink, 'docs', 10)
      .consistency('eventual')
      .upsert([{ id: 'doc1', vector: [1, 0, 0] }])
    expect(captured.consistency).toBe('eventual')
  })

  it('.consistency(mode) threads into the DeletePlan', async () => {
    await new VectorQueryBuilder(sink, 'docs', 10)
      .whereIn('id', ['doc1'])
      .consistency('best-effort')
      .delete()
    expect(captured.consistency).toBe('best-effort')
  })

  it('omitting .consistency() leaves plan.consistency undefined (use store/adapter default)', async () => {
    await new VectorQueryBuilder(sink, 'docs', 10).upsert([{ id: 'doc1', vector: [1, 0, 0] }])
    expect(captured.consistency).toBeUndefined()
  })

  it('where(A).where(B).orWhere(C) => (A AND B) OR C — orWhere does not re-snapshot the AND-list', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .where('year', 2024)
      .orWhere('pinned', true)
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      or: [
        {
          and: [
            { field: 'kind', op: 'eq', value: 'policy' },
            { field: 'year', op: 'eq', value: 2024 },
          ],
        },
        { and: [{ field: 'pinned', op: 'eq', value: true }] },
      ],
    })
  })

  it('where(cb) => nested AND group nested in the outer AND-list', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .where((qb) => qb.where('a', 1).where('b', 2))
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      and: [
        { field: 'kind', op: 'eq', value: 'policy' },
        {
          and: [
            { field: 'a', op: 'eq', value: 1 },
            { field: 'b', op: 'eq', value: 2 },
          ],
        },
      ],
    })
  })

  it('A AND (B OR C) via .andWhere(cb) with an OR inside the group', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .andWhere((qb) => qb.where('year', '>=', 2024).orWhere('pinned', true))
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      and: [
        { field: 'kind', op: 'eq', value: 'policy' },
        {
          or: [
            { and: [{ field: 'year', op: 'gte', value: 2024 }] },
            { and: [{ field: 'pinned', op: 'eq', value: true }] },
          ],
        },
      ],
    })
  })

  it('(A OR B) AND C via .orWhere(cb) then a trailing AND condition', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where((qb) => qb.where('a', 1).orWhere('b', 2))
      .where('c', 3)
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      and: [
        {
          or: [
            { and: [{ field: 'a', op: 'eq', value: 1 }] },
            { and: [{ field: 'b', op: 'eq', value: 2 }] },
          ],
        },
        { field: 'c', op: 'eq', value: 3 },
      ],
    })
  })

  it('whereNot(field, value) still produces an ne condition (back-compat)', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .whereNot('kind', 'rule')
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({ and: [{ field: 'kind', op: 'ne', value: 'rule' }] })
  })

  it('whereNot(cb) => { not: <group> } nested in the AND-list', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .whereNot((qb) => qb.where('archived', true).orWhere('hidden', true))
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      and: [
        { field: 'kind', op: 'eq', value: 'policy' },
        {
          not: {
            or: [
              { and: [{ field: 'archived', op: 'eq', value: true }] },
              { and: [{ field: 'hidden', op: 'eq', value: true }] },
            ],
          },
        },
      ],
    })
  })

  it('orWhereNot(cb) opens an OR branch holding a negated group', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .orWhereNot((qb) => qb.where('archived', true))
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      or: [
        { and: [{ field: 'kind', op: 'eq', value: 'policy' }] },
        { and: [{ not: { and: [{ field: 'archived', op: 'eq', value: true }] } }] },
      ],
    })
  })

  it('deep nesting: and > or > not survives the builder', async () => {
    captured = undefined
    await new VectorQueryBuilder(sink, 'docs', 10)
      .where('kind', 'policy')
      .andWhere((qb) => qb.where('a', 1).orWhere((inner) => inner.whereNot((n) => n.where('b', 2))))
      .nearVector([1, 2, 3])
      .select('id')
    expect(captured.filter).toEqual({
      and: [
        { field: 'kind', op: 'eq', value: 'policy' },
        {
          or: [
            { and: [{ field: 'a', op: 'eq', value: 1 }] },
            { and: [{ and: [{ not: { and: [{ field: 'b', op: 'eq', value: 2 }] } }] }] },
          ],
        },
      ],
    })
  })

  it('nested raw fragment with mismatched bindings still throws (validation recurses)', async () => {
    await expect(
      new VectorQueryBuilder(sink, 'docs', 10)
        .where((qb) => qb.whereRaw('year > ? AND kind = ?', [2024]))
        .nearVector([1, 2, 3])
        .select('id')
    ).rejects.toThrow()
  })
})
