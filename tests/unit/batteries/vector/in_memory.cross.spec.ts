import { describe, it, expect } from 'vitest'
import { createVectorStore } from '../../../../src/batteries/vector/factory'
import { InMemoryVectorStore } from '../../../../src/batteries/vector/in_memory'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'

const makeStore = async () => {
  const vs = await createVectorStore({
    client: InMemoryVectorStore,
    options: { metric: 'cosine', encoder: stubEncoder, dimensions: 3 },
  })
  await vs.connect()
  await vs.schema.createCollection('docs', (c) => {
    c.vector({ dimensions: 3 })
  })
  return vs
}

runVectorStoreConformance('InMemoryVectorStore', makeStore)

// Plus a couple in-memory-specific direct assertions:
describe('InMemoryVectorStore specifics', () => {
  it('throws encoder-required when text upserted without an encoder', async () => {
    const vs = await createVectorStore({ client: InMemoryVectorStore, options: {} })
    await vs.schema.createCollection('c', (c) => c.vector({ dimensions: 3 }))
    await expect(vs('c').upsert([{ id: 'x', document: 'hi' }])).rejects.toThrow()
  })
  it('rejects a non-finite vector entry', async () => {
    const vs = await createVectorStore({ client: InMemoryVectorStore, options: { dimensions: 2 } })
    await vs.schema.createCollection('c', (c) => c.vector({ dimensions: 2 }))
    await expect(vs('c').upsert([{ id: 'x', vector: [1, Number.NaN] }])).rejects.toThrow()
  })
})
