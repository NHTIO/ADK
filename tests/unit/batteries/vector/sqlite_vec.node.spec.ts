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
  runVectorStoreConformance('SqliteVecVectorStore', makeStore)

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
})
