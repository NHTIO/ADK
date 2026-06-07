import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { CouchbaseVectorStore } from '@nhtio/adk/batteries/vector/couchbase'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_COUCHBASE_URL to a couchbase:// URL (Couchbase ENTERPRISE — vector search is
// EE-only; Community throws "vector typed fields not supported"). The bucket named below must
// already exist with the kv/n1ql/index/fts services (the docker init creates it). Credentials
// come from TEST_VECTOR_COUCHBASE_USER / _PASS, the bucket from TEST_VECTOR_COUCHBASE_BUCKET.
const url = process.env.TEST_VECTOR_COUCHBASE_URL
const d = url ? describe : describe.skip

let seq = 0

d('CouchbaseVectorStore (integration)', () => {
  const makeStore = async () => {
    // Fresh physical collection per test via collectionPrefix (the harness drives a hardcoded
    // 'docs'; the prefix maps it to a unique scope.collection). Building the scoped FTS vector
    // index once per collection avoids the slow drop+rebuild-index churn a shared collection
    // would incur, and isolates state by construction — the same pattern the MongoDB adapter uses.
    const collectionPrefix = `t${Date.now().toString(36)}${seq++}_`
    const vs = await createVectorStore({
      client: CouchbaseVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url: url as string,
          username: process.env.TEST_VECTOR_COUCHBASE_USER ?? 'Administrator',
          password: process.env.TEST_VECTOR_COUCHBASE_PASS ?? 'password123',
          bucket: process.env.TEST_VECTOR_COUCHBASE_BUCKET ?? 'vectors',
          collectionPrefix,
        },
      },
    })
    await vs.connect()
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('CouchbaseVectorStore', makeStore)
})
