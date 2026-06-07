import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { VespaVectorStore } from '@nhtio/adk/batteries/vector/vespa'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_VESPA_URL to the data/query endpoint (e.g. http://localhost:8080) and
// TEST_VECTOR_VESPA_CONFIG_URL to the config server (e.g. http://localhost:19071). A Vespa
// "collection" is a document type in a deployed application package; the adapter builds and
// redeploys that package (dependency-free store-zip) via the config server on createCollection.
const url = process.env.TEST_VECTOR_VESPA_URL
const d = url ? describe : describe.skip

d('VespaVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: VespaVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          endpoint: url as string,
          configUrl: process.env.TEST_VECTOR_VESPA_CONFIG_URL ?? 'http://localhost:19071',
        },
      },
    })
    await vs.connect()
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('VespaVectorStore', makeStore)
})
