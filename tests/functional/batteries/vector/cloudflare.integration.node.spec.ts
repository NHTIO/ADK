import { describe, beforeAll, afterAll } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { CloudflareVectorizeVectorStore } from '@nhtio/adk/batteries/vector/cloudflare'
import {
  runVectorStoreConformance,
  paddedStubEncoder,
} from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'
import type { CallableVectorStore } from '@nhtio/adk/batteries/vector'

// Cloudflare Vectorize V2 (managed). Set TEST_VECTOR_CLOUDFLARE_ACCOUNT_ID +
// TEST_VECTOR_CLOUDFLARE_API_KEY. Vectorize requires dimensions in [32, 1536], so the conformance
// harness runs at dim 32 (every test vector is zero-padded to 32).
//
// Test architecture: a FRESH Vectorize index has a large, variable warmup (~8–34s) before its
// first write is queryable, and the query index settles independently of get_by_ids. Creating a
// new index per test would make the suite slow and flaky. Instead we create + WARM ONE index for
// the whole run (poll until a seed write is queryable), then clear it (delete-all) before each
// test via makeStore — on an already-warm index, settles are ~1s, so reads-after-write are
// deterministic. The index is dropped in afterAll.
const accountId = process.env.TEST_VECTOR_CLOUDFLARE_ACCOUNT_ID
const apiKey = process.env.TEST_VECTOR_CLOUDFLARE_API_KEY
const d = accountId && apiKey ? describe : describe.skip

const DIM = 32

d('CloudflareVectorizeVectorStore (integration)', () => {
  let store: CallableVectorStore

  // Unique index name per run. Vectorize's index create/DROP are themselves eventually consistent,
  // so re-using a fixed name across runs (drop in afterAll, recreate in beforeAll) races the
  // pending delete and yields an "index deleted" limbo on the next write. A fresh name per run
  // sidesteps that entirely; the index is created+warmed once and reused across the 7 tests.
  const indexNamePrefix = `cfconf${Date.now().toString(36)}-`

  beforeAll(async () => {
    store = await createVectorStore({
      client: CloudflareVectorizeVectorStore,
      options: {
        metric: 'cosine',
        encoder: paddedStubEncoder(DIM),
        dimensions: DIM,
        connection: { accountId: accountId as string, apiKey: apiKey as string, indexNamePrefix },
      },
    })
    await store.connect()
    // Create the shared index and warm it: an upsert+settle on a fresh index pays the one-time
    // warmup here (the adapter's settle-present polls until the seed row is queryable).
    await store.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: DIM, metric: 'cosine' })
    )
    const seed = new Array(DIM).fill(0)
    seed[0] = 1
    await store('docs').upsert([{ id: '__warm__', vector: seed, metadata: {} }])
    await store('docs').whereIn('id', ['__warm__']).delete()
  }, 120_000)

  afterAll(async () => {
    if (store) {
      await store.schema.dropCollectionIfExists('docs')
      await store.close()
    }
  })

  // makeStore returns the shared, warmed store after clearing all rows — each test starts clean.
  const makeStore = async () => {
    await store('docs').delete()
    return store
  }

  // Cloudflare Vectorize is aggressively eventually-consistent and its query index flaps for
  // seconds after a write/delete. The adapter settles as best it can, but a single attempt can
  // still race the flap. `retry` re-runs a flaked attempt (re-clearing via makeStore) against a
  // more-settled index — turning transient-consistency flake into deterministic green without
  // weakening assertions. Generous per-test timeout because each attempt clears + settles.
  runVectorStoreConformance('CloudflareVectorizeVectorStore', makeStore, DIM, {
    retry: 4,
    timeout: 90_000,
  })
})
