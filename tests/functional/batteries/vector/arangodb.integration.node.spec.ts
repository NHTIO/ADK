import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { ArangoDBVectorStore } from '@nhtio/adk/batteries/vector/arangodb'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_ARANGODB_URL to http://host:8529 (server started with
// --experimental-vector-index=true; root/<pass>).
const url = process.env.TEST_VECTOR_ARANGODB_URL
const d = url ? describe : describe.skip

d('ArangoDBVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: ArangoDBVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url: url as string,
          username: process.env.TEST_VECTOR_ARANGODB_USER ?? 'root',
          password: process.env.TEST_VECTOR_ARANGODB_PASS ?? 'vectortest',
          database: 'vectortest',
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

  runVectorStoreConformance('ArangoDBVectorStore', makeStore)
})
