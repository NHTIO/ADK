import { describe, it, expect } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { PgVectorStore } from '@nhtio/adk/batteries/vector/pgvector'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_PGVECTOR_URL
const d = url ? describe : describe.skip

d('PgVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: PgVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { connectionString: url },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('PgVectorStore', makeStore)

  it('reports transactions capability true', async () => {
    const vs = await makeStore()
    expect(vs.capabilities.transactions).toBe(true)
    await vs.close()
  })
})
