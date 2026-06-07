import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { ElasticsearchVectorStore } from '@nhtio/adk/batteries/vector/elasticsearch'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Elasticsearch 8 adapter (dense_vector + top-level knn). Point at a live ES node via
// TEST_VECTOR_ELASTICSEARCH_URL (http://host:9200). Distinct from the opensearch adapter.
const url = process.env.TEST_VECTOR_ELASTICSEARCH_URL
const d = url ? describe : describe.skip

d('ElasticsearchVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: ElasticsearchVectorStore,
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

  runVectorStoreConformance('ElasticsearchVectorStore', makeStore)
})
