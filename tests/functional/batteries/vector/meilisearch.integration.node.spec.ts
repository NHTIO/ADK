import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { MeilisearchVectorStore } from '@nhtio/adk/batteries/vector/meilisearch'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_MEILISEARCH_URL
const d = url ? describe : describe.skip

d('MeilisearchVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: MeilisearchVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          host: url,
          apiKey: process.env.TEST_VECTOR_MEILISEARCH_API_KEY ?? 'vectortest',
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

  runVectorStoreConformance('MeilisearchVectorStore', makeStore)
})
