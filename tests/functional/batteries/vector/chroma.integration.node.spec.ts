import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { ChromaVectorStore } from '@nhtio/adk/batteries/vector/chroma'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_CHROMA_URL
const d = url ? describe : describe.skip

d('ChromaVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: ChromaVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url: url,
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

  runVectorStoreConformance('ChromaVectorStore', makeStore)
})
