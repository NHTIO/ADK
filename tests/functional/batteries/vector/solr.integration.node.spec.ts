import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { SolrVectorStore } from '@nhtio/adk/batteries/vector/solr'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_SOLR_URL to http://host:8983 with a precreated core named 'docs'
// (e.g. `solr-precreate docs`). The adapter manages the core's schema, not the core itself.
const url = process.env.TEST_VECTOR_SOLR_URL
const d = url ? describe : describe.skip

d('SolrVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: SolrVectorStore,
      options: { metric: 'cosine', encoder: stubEncoder, dimensions: 3, connection: { url } },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('SolrVectorStore', makeStore)
})
