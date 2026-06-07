import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { DuckDBVectorStore } from '@nhtio/adk/batteries/vector/duckdb'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// In-process (no server). Set TEST_VECTOR_DUCKDB_URL=:memory: (or a file path) to run.
const path = process.env.TEST_VECTOR_DUCKDB_URL
const d = path ? describe : describe.skip

d('DuckDBVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: DuckDBVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { path },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('DuckDBVectorStore', makeStore)
})
