import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { LanceDBVectorStore } from '@nhtio/adk/batteries/vector/lancedb'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// In-process embedded store. Set TEST_VECTOR_LANCEDB_URL=1 to enable (a temp dir is used).
const enabled = process.env.TEST_VECTOR_LANCEDB_URL
const d = enabled ? describe : describe.skip

d('LanceDBVectorStore (integration)', () => {
  const makeStore = async () => {
    const uri = mkdtempSync(join(tmpdir(), 'lancedb-test-'))
    const vs = await createVectorStore({
      client: LanceDBVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { uri },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('LanceDBVectorStore', makeStore)
})
