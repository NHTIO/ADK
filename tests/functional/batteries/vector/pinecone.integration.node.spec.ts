import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { PineconeVectorStore } from '@nhtio/adk/batteries/vector/pinecone'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const apiKey = process.env.TEST_VECTOR_PINECONE_API_KEY
const index = process.env.TEST_VECTOR_PINECONE_INDEX
const d = apiKey && index ? describe : describe.skip

d('PineconeVectorStore (integration)', () => {
  const makeStore = async () => {
    // Each store gets a fresh, never-before-used physical namespace (via namespacePrefix),
    // so tests are isolated by construction: zero cross-test contamination and zero reset
    // cost. Pinecone namespaces are implicit (born on first upsert), so there is nothing to
    // create or drain — which sidesteps Pinecone's slow-to-confirm namespace clear entirely.
    const namespacePrefix = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
    const vs = await createVectorStore({
      client: PineconeVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        apiKey: apiKey,
        index: index,
        namespacePrefix,
      },
    })
    await vs.connect()
    // No dropCollectionIfExists: the namespace is unique per store, so nothing to reset.
    // createCollection only records dims locally for Pinecone (no server-side create).
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('PineconeVectorStore', makeStore)
})
