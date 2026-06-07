import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { TypesenseVectorStore } from '@nhtio/adk/batteries/vector/typesense'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_TYPESENSE_URL
const d = url ? describe : describe.skip

d('TypesenseVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: TypesenseVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { url, apiKey: process.env.TEST_VECTOR_TYPESENSE_API_KEY ?? 'vectortest' },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('TypesenseVectorStore', makeStore)
})
