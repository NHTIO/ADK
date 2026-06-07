import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { Neo4jVectorStore } from '@nhtio/adk/batteries/vector/neo4j'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_NEO4J_URL to bolt://host:7687 (+ user/pass).
const url = process.env.TEST_VECTOR_NEO4J_URL
const d = url ? describe : describe.skip

d('Neo4jVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: Neo4jVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url: url as string,
          username: process.env.TEST_VECTOR_NEO4J_USER ?? 'neo4j',
          password: process.env.TEST_VECTOR_NEO4J_PASS ?? 'vectortest',
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

  runVectorStoreConformance('Neo4jVectorStore', makeStore)
})
