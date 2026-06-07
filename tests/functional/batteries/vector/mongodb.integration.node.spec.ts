import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { MongoDBVectorStore } from '@nhtio/adk/batteries/vector/mongodb'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_MONGODB_URL to a mongodb:// URL backed by Atlas Search
// (e.g. mongodb/mongodb-atlas-local: mongodb://localhost:27017/?directConnection=true).
const url = process.env.TEST_VECTOR_MONGODB_URL
const d = url ? describe : describe.skip

let seq = 0

d('MongoDBVectorStore (integration)', () => {
  const makeStore = async () => {
    // Fresh physical collection per test via collectionPrefix (the harness drives a hardcoded
    // 'docs'; the prefix maps it to a unique collection). Building the Atlas vectorSearch index
    // once per test avoids the slow drop+rebuild-index churn a shared collection would incur, and
    // isolates state by construction — the same pattern the Pinecone adapter uses (namespacePrefix).
    const collectionPrefix = `t${Date.now().toString(36)}${seq++}_`
    const vs = await createVectorStore({
      client: MongoDBVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { url: url as string, database: 'vectortest', collectionPrefix },
      },
    })
    await vs.connect()
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('MongoDBVectorStore', makeStore)
})
