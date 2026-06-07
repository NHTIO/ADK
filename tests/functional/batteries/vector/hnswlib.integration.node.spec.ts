import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { HnswlibVectorStore } from '@nhtio/adk/batteries/vector/hnswlib'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Embedded, in-process (no server). Set TEST_VECTOR_HNSWLIB_URL=1 to enable.
const enabled = process.env.TEST_VECTOR_HNSWLIB_URL
const d = enabled ? describe : describe.skip

d('HnswlibVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: HnswlibVectorStore,
      options: { metric: 'cosine', encoder: stubEncoder, dimensions: 3 },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('HnswlibVectorStore', makeStore)
})
