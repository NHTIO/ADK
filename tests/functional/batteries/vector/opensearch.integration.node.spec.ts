import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { OpenSearchVectorStore } from '@nhtio/adk/batteries/vector/opensearch'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// One adapter for the ES/OpenSearch family. Point at either a live OpenSearch or Elasticsearch
// node via TEST_VECTOR_OPENSEARCH_URL (http://host:9200).
const url = process.env.TEST_VECTOR_OPENSEARCH_URL
const d = url ? describe : describe.skip

d('OpenSearchVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: OpenSearchVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: { node: url },
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('OpenSearchVectorStore', makeStore)
})
