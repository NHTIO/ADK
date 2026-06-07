import { OramaVectorStore } from '../../../../src/batteries/vector/orama'
import { createVectorStore } from '../../../../src/batteries/vector/factory'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'

const makeStore = async () => {
  const vs = await createVectorStore({
    client: OramaVectorStore,
    options: { metric: 'cosine', encoder: stubEncoder, dimensions: 3 },
  })
  await vs.connect()
  await vs.schema.createCollection('docs', (c) => {
    c.vector({ dimensions: 3 })
  })
  return vs
}

runVectorStoreConformance('OramaVectorStore', makeStore)
