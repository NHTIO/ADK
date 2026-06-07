import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { MilvusVectorStore } from '@nhtio/adk/batteries/vector/milvus'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_MILVUS_URL
const d = url ? describe : describe.skip

d('MilvusVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: MilvusVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          address: url,
          token: process.env.TEST_VECTOR_MILVUS_TOKEN,
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

  runVectorStoreConformance('MilvusVectorStore', makeStore)
})
