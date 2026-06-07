import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { ClickHouseVectorStore } from '@nhtio/adk/batteries/vector/clickhouse'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

const url = process.env.TEST_VECTOR_CLICKHOUSE_URL
const d = url ? describe : describe.skip

d('ClickHouseVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: ClickHouseVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          url,
          username: process.env.TEST_VECTOR_CLICKHOUSE_USER ?? 'vector',
          password: process.env.TEST_VECTOR_CLICKHOUSE_PASSWORD ?? 'vector',
          database: process.env.TEST_VECTOR_CLICKHOUSE_DB ?? 'vector',
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

  runVectorStoreConformance('ClickHouseVectorStore', makeStore)
})
