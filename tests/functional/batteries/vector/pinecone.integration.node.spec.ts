import { afterAll, describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { PineconeVectorStore } from '@nhtio/adk/batteries/vector/pinecone'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const apiKey = process.env.TEST_VECTOR_PINECONE_API_KEY
const index = process.env.TEST_VECTOR_PINECONE_INDEX
const d = apiKey && index ? describe : describe.skip

d('PineconeVectorStore (integration)', () => {
  // Track every store the harness spins up so we can reclaim its namespace afterward.
  // Each makeStore() uses a fresh namespacePrefix for isolation; without cleanup these
  // accumulate against Pinecone's serverless 100-namespace-per-index cap and eventually
  // fail upserts ("max namespaces allowed ... (100)"). Pinecone auto-removes a namespace
  // once it's empty, so dropping the collection (delete all vectors) reclaims it.
  const created: Array<{ vs: any; ns: string }> = []

  const makeStore = async () => {
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
    // createCollection only records dims locally for Pinecone (no server-side create).
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    created.push({ vs, ns: namespacePrefix })
    return vs
  }

  afterAll(async () => {
    // Reclaim each store's namespace (drop the collection → empties it → Pinecone frees it).
    // Best-effort: a failed cleanup must not fail the suite, but log it so leaks are visible.
    for (const { vs, ns } of created) {
      try {
        await vs.schema.dropCollectionIfExists('docs')
      } catch (err) {
        console.warn(`pinecone namespace cleanup failed for ${ns}: ${String(err)}`)
      }
      try {
        await vs.close()
      } catch {
        /* ignore */
      }
    }
  })

  runVectorStoreConformance('PineconeVectorStore', makeStore)
})
