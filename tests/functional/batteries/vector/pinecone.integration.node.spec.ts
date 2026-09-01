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
    // REGISTER FOR CLEANUP FIRST. `connect()` and `createCollection()` below can both throw — and
    // when the index is already at its namespace cap, they do. Pushing only after they succeed
    // meant a store that failed to initialise was never tracked, so its namespace was never
    // reclaimed: each failing run leaked, pushing the index further past the cap and making the
    // next run fail harder. That is exactly how this index reached exactly 100 namespaces and had
    // to be purged by hand. Tracking up front makes cleanup cover the failure path too.
    created.push({ vs, ns: namespacePrefix })
    await vs.connect()
    // createCollection only records dims locally for Pinecone (no server-side create).
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  afterAll(async () => {
    // Reclaim each store's namespace (drop the collection → empties it → Pinecone frees it).
    // Still best-effort — a failed cleanup must not fail the suite, since the tests themselves may
    // already have failed for an unrelated reason and masking that would be worse. But a leak is
    // now reported LOUDLY and in aggregate rather than as a single `console.warn` per store buried
    // in a passing run's output: silent per-store warnings are why this index accumulated to its
    // 100-namespace cap unnoticed, and every subsequent run then failed on "max namespaces
    // allowed" until it was purged by hand.
    const leaked: string[] = []
    for (const { vs, ns } of created) {
      try {
        await vs.schema.dropCollectionIfExists('docs')
      } catch (err) {
        leaked.push(`${ns}: ${String(err)}`)
      }
      try {
        await vs.close()
      } catch {
        /* ignore */
      }
    }
    if (leaked.length > 0) {
      console.error(
        `\n!!! PINECONE NAMESPACE LEAK — ${leaked.length}/${created.length} namespace(s) were not ` +
          `reclaimed. Pinecone's serverless indexes cap at 100 namespaces per index; once that cap ` +
          `is reached EVERY subsequent upsert fails with "max namespaces allowed ... (100)" and the ` +
          `index must be purged manually. Leaked:\n` +
          leaked.map((l) => `  - ${l}`).join('\n') +
          `\n`
      )
    }
  })

  runVectorStoreConformance('PineconeVectorStore', makeStore)
})
