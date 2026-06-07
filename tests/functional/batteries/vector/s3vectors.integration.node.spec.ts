import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { S3VectorsVectorStore } from '@nhtio/adk/batteries/vector/s3vectors'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// AWS S3 Vectors (managed). Set TEST_VECTOR_S3VECTORS_BUCKET to a pre-existing vector bucket and
// TEST_VECTOR_S3VECTORS_REGION to its region; AWS credentials come from the ambient credential
// chain (env / shared config). A logical collection maps to an index inside the bucket; the
// adapter creates/drops indexes. indexPrefix isolates per test (index names must be 3–63 chars).
const bucket = process.env.TEST_VECTOR_S3VECTORS_BUCKET
const region = process.env.TEST_VECTOR_S3VECTORS_REGION
const d = bucket ? describe : describe.skip

let seq = 0

d('S3VectorsVectorStore (integration)', () => {
  const makeStore = async () => {
    const indexPrefix = `t${Date.now().toString(36)}${seq++}-`
    const vs = await createVectorStore({
      client: S3VectorsVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { bucket: bucket as string, region, indexPrefix },
      },
    })
    await vs.connect()
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('S3VectorsVectorStore', makeStore)
})
