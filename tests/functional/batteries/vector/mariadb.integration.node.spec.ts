import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { MariaDBVectorStore } from '@nhtio/adk/batteries/vector/mariadb'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Set TEST_VECTOR_MARIADB_URL to a connection string mysql://user:pass@host:port/db (11.7+).
const url = process.env.TEST_VECTOR_MARIADB_URL
const d = url ? describe : describe.skip

const parse = (u: string) => {
  const x = new URL(u)
  return {
    host: x.hostname,
    port: Number(x.port) || 3306,
    user: decodeURIComponent(x.username),
    password: decodeURIComponent(x.password),
    database: x.pathname.replace(/^\//, ''),
  }
}

d('MariaDBVectorStore (integration)', () => {
  const makeStore = async () => {
    const vs = await createVectorStore({
      client: MariaDBVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: parse(url as string),
      },
    })
    await vs.connect()
    await vs.schema.dropCollectionIfExists('docs')
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('MariaDBVectorStore', makeStore)
})
