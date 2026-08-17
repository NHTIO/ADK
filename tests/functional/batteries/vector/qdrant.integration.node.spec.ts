import { describe, it } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { QdrantVectorStore } from '@nhtio/adk/batteries/vector/qdrant'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_QDRANT_URL
const d = url ? describe : describe.skip

d('QdrantVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: QdrantVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url: url,
          apiKey: process.env.TEST_VECTOR_QDRANT_API_KEY,
        },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('QdrantVectorStore', makeStore)

  it('closes without throwing', async () => {
    const vs = await makeStore()
    await vs.close()
  })
})
