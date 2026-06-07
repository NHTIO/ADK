import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { RedisVectorStore } from '@nhtio/adk/batteries/vector/redis'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_REDIS_URL
const d = url ? describe : describe.skip

d('RedisVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: RedisVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { url },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) => {
      c.vector({ dimensions: 3, metric: 'cosine' })
      c.string('kind')
      // Declared so the shared conformance suite's nested-filter test (kind AND (year OR pinned))
      // can filter on them — RediSearch only filters fields present in the FT.CREATE schema.
      c.integer('year')
      c.boolean('pinned')
    })
    return vs
  }

  runVectorStoreConformance('RedisVectorStore', makeStore)
})
