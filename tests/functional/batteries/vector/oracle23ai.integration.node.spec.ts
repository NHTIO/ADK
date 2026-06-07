import { describe } from 'vitest'
import { createVectorStore } from '@nhtio/adk/batteries/vector'
import { Oracle23aiVectorStore } from '@nhtio/adk/batteries/vector/oracle23ai'
import { runVectorStoreConformance, stubEncoder } from '@nhtio/adk/batteries/vector/conformance'
import type { CollectionBuilder } from '@nhtio/adk/batteries/vector'

// Oracle 23ai AI Vector Search. Set TEST_VECTOR_ORACLE_URL to an EZConnect string
// (host:1521/FREEPDB1) plus TEST_VECTOR_ORACLE_USER / _PASS. The connecting user must default to a
// non-SYSTEM tablespace (e.g. USERS) — VECTOR columns are rejected in SYSTEM. A logical collection
// maps to a table; tablePrefix isolates per test.
const url = process.env.TEST_VECTOR_ORACLE_URL
const d = url ? describe : describe.skip

let seq = 0

d('Oracle23aiVectorStore (integration)', () => {
  const makeStore = async () => {
    const tablePrefix = `t${Date.now().toString(36)}${seq++}_`
    const vs = await createVectorStore({
      client: Oracle23aiVectorStore,
      options: {
        metric: 'cosine',
        encoder: stubEncoder,
        dimensions: 3,
        connection: {
          connectString: url as string,
          user: process.env.TEST_VECTOR_ORACLE_USER ?? 'vector',
          password: process.env.TEST_VECTOR_ORACLE_PASS ?? 'vector',
          tablePrefix,
        },
      },
    })
    await vs.connect()
    await vs.schema.createCollection('docs', (c: CollectionBuilder) =>
      c.vector({ dimensions: 3, metric: 'cosine' })
    )
    return vs
  }

  runVectorStoreConformance('Oracle23aiVectorStore', makeStore)
})
