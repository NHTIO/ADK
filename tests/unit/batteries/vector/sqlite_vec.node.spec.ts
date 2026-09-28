/**
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest'
import { createVectorStore } from '../../../../src/batteries/vector/factory'
import { SqliteVecVectorStore } from '../../../../src/batteries/vector/sqlite_vec'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'

let driverAvailable = true
try {
  await import('better-sqlite3')
  await import('sqlite-vec')
} catch {
  driverAvailable = false
}

const makeStore = async () => {
  const vs = await createVectorStore({
    client: SqliteVecVectorStore,
    options: {
      metric: 'euclidean',
      encoder: stubEncoder,
      dimensions: 3,
      connection: { path: ':memory:' },
    },
  })
  await vs.connect()
  await vs.schema.createCollection('docs', (c) => {
    c.vector({ dimensions: 3 })
  })
  return vs
}

const d = driverAvailable ? describe : describe.skip

d('SqliteVecVectorStore (real backend, :memory:)', () => {
  it('vector conformance', async () => {
    await runVectorStoreConformance('SqliteVecVectorStore', makeStore)
  })

  it('reports transactions capability true', async () => {
    const vs = await makeStore()
    expect(vs.capabilities.transactions).toBe(true)
    await vs.close()
  })
  it('commits a transaction', async () => {
    const vs = await makeStore()
    await vs.transaction(async (tx) => {
      await tx('docs').upsert([{ id: 'tx1', vector: [9, 9, 9] }])
    })
    const all = await vs('docs').select('id').limit(10)
    expect(all.some((r) => r.id === 'tx1')).toBe(true)
    await vs.close()
  })
  it('rolls back a failed transaction', async () => {
    const vs = await makeStore()
    await expect(
      vs.transaction(async (tx) => {
        await tx('docs').upsert([{ id: 'tx2', vector: [9, 9, 9] }])
        throw new Error('boom')
      })
    ).rejects.toThrow()
    const all = await vs('docs').select('id').limit(10)
    expect(all.some((r) => r.id === 'tx2')).toBe(false)
    await vs.close()
  })

  it('reports rename capability false', async () => {
    const vs = await makeStore()
    expect(vs.capabilities.rename).toBe(false)
    await vs.close()
  })

  it('renameCollection rejects with E_VECTOR_STORE_UNSUPPORTED_OPERATION, leaving the collection intact', async () => {
    const vs = await makeStore()
    await vs('docs').upsert([{ id: 'r1', vector: [1, 0, 0] }])

    let caught: unknown
    try {
      await vs.schema.renameCollection('docs', 'x')
    } catch (e) {
      caught = e
    }
    expect((caught as { name?: string } | undefined)?.name).toBe(
      'E_VECTOR_STORE_UNSUPPORTED_OPERATION'
    )

    // Still searchable after the rejected rename.
    const found = await vs('docs').nearVector([1, 0, 0]).select('id').limit(1)
    expect(found.some((r) => r.id === 'r1')).toBe(true)

    // Still writable after the rejected rename.
    await vs('docs').upsert([{ id: 'r2', vector: [0, 1, 0] }])
    const all = await vs('docs').select('id').limit(10)
    expect(all.some((r) => r.id === 'r2')).toBe(true)

    // No table named `x`, `x__meta`, or starting `x_` (vec0 shadow tables) was created.
    const stray: any[] = (vs as unknown as { db: any }).db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND (name = 'x' OR name = 'x__meta' OR name LIKE 'x\\_%' ESCAPE '\\')`
      )
      .all()
    expect(stray.length).toBe(0)

    await vs.close()
  })

  it('escapes a collection name containing a double quote', async () => {
    const vs = await makeStore()
    const name = 'a"b'
    await vs.schema.createCollection(name, (c) => {
      c.vector({ dimensions: 3 })
    })

    await vs(name).upsert([
      { id: '1', vector: [1, 0, 0], metadata: { kind: 'x' } },
      { id: '2', vector: [0, 1, 0], metadata: { kind: 'x' } },
    ])

    const near = await vs(name).nearVector([1, 0, 0]).select('id', 'score').limit(1)
    expect(near.length).toBe(1)
    expect(near[0].id).toBe('1')

    const scanned = await vs(name).where('kind', 'x').select('id').limit(10)
    expect(scanned.map((r) => r.id).sort()).toEqual(['1', '2'])

    await vs(name).whereIn('id', ['1']).delete()
    const afterDelete = await vs(name).select('id').limit(10)
    expect(afterDelete.map((r) => r.id)).toEqual(['2'])

    await vs.schema.dropCollection(name)
    expect(await vs.schema.hasCollection(name)).toBe(false)

    await vs.close()
  })

  it('documented rename workaround: pages, verifies, then drops only after completeness is confirmed', async () => {
    const vs = await makeStore()

    // More than one page of records, each with a distinct vector/document/metadata so every field
    // can be checked for fidelity after the copy. Every third record has no document: sqlite_vec
    // reads that back as `null`, which upsert rejects unless the snippet omits it.
    const total = 23
    const source = Array.from({ length: total }, (_, i) => ({
      id: `id${i}`,
      vector: [i, i + 1, i + 2],
      ...(i % 3 === 0 ? {} : { document: `doc${i}` }),
      metadata: { n: i },
    }))
    await vs('docs').upsert(source)

    // --- exact code from docs/batteries/vector/adapters.md, with this collection's dimensions and a
    // small pageSize for the test ---
    const dimensions = 3
    await vs.schema.createCollection('documents', (c) => c.vector({ dimensions }))

    const pageSize = 7
    const copiedIds = new Set<string>()
    let offset = 0
    for (;;) {
      const page = await vs('docs')
        .select('id', 'vector', 'document', 'metadata')
        .limit(pageSize)
        .offset(offset)
      if (page.length === 0) break
      await vs('documents').upsert(
        page.map((row) => ({
          id: row.id!,
          vector: row.vector,
          // A record stored without a document reads back as `null`, which upsert rejects: omit it.
          ...(typeof row.document === 'string' ? { document: row.document } : {}),
          metadata: row.metadata,
        }))
      )
      for (const row of page) copiedIds.add(row.id!)
      offset += pageSize
    }

    const remaining = await vs('docs').select('id').limit(Number.MAX_SAFE_INTEGER)
    const sourceIds = remaining.map((r) => r.id!)
    if (sourceIds.length !== copiedIds.size || sourceIds.some((id) => !copiedIds.has(id))) {
      throw new Error(
        'rename workaround: copy is incomplete, refusing to drop the source collection'
      )
    }

    // The source must still exist right up until this point — the drop is the very last step, only
    // reached once completeness was verified above.
    expect(await vs.schema.hasCollection('docs')).toBe(true)

    await vs.schema.dropCollection('docs')
    // --- end of documented snippet ---

    expect(await vs.schema.hasCollection('docs')).toBe(false)
    expect(copiedIds.size).toBe(total)

    const copied = await vs('documents').select('id', 'vector', 'document', 'metadata').limit(total)
    expect(copied.length).toBe(total)
    const byId = new Map(copied.map((r) => [r.id, r]))
    for (const rec of source) {
      const got = byId.get(rec.id)
      expect(got).toBeDefined()
      expect(got!.vector).toEqual(rec.vector)
      expect(got!.document ?? undefined).toBe(rec.document)
      expect(got!.metadata).toEqual(rec.metadata)
    }

    await vs.close()
  })
})
