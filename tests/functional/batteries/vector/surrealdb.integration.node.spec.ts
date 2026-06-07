import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { SurrealDBVectorStore } from '@nhtio/adk/batteries/vector/surrealdb'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_SURREALDB_URL to http://host:8000 (root/root, ns/db = test).
const url = process.env.TEST_VECTOR_SURREALDB_URL
const d = url ? describe : describe.skip

d('SurrealDBVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: SurrealDBVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url: url as string,
          username: process.env.TEST_VECTOR_SURREALDB_USER ?? 'root',
          password: process.env.TEST_VECTOR_SURREALDB_PASS ?? 'root',
          namespace: 'test',
          database: 'test',
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

  runVectorStoreConformance('SurrealDBVectorStore', makeStore)
})
