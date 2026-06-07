/**
 * @module @nhtio/adk/batteries/vector/neo4j
 *
 * Neo4j adapter (native vector index, 5.13+). Each collection is a node label; records are
 * nodes with `id`/`vec`/`document`/`metadata` properties and a `VECTOR INDEX` on `vec`. KNN
 * uses `db.index.vector.queryNodes(index, k, vector)` (score is the similarity, already [0,1]
 * for cosine). Metadata is a JSON string property filtered with the neutral filter tree's JS
 * reference evaluator for exact cross-adapter parity.
 *
 * Driver: `neo4j-driver` (pure JS). Labels/index names can't be Cypher-parameterized, so they
 * are derived from the (sanitized) collection name; all values are parameterized.
 */

import { evaluateFilter } from '../filters'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_CONNECTION_FAILED,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_OPERATION,
} from '../exceptions'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type {
  VectorMatch,
  VectorStoreCapabilities,
  BaseVectorStoreOptions,
  VectorMetadata,
  DistanceMetric,
} from '../types'

export interface Neo4jVectorStoreOptions extends BaseVectorStoreOptions {
  connection: { url: string; username?: string; password?: string; database?: string }
}

const getNeo4j = async () => {
  try {
    const mod = await import('neo4j-driver')
    return (mod as any).default ?? mod
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['neo4j-driver'])
  }
}

// A Cypher-safe label/index token derived from the collection (labels can't be parameterized).
const sanitize = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_')
const labelFor = (collection: string): string => 'Vec_' + sanitize(collection)
const indexFor = (collection: string): string => 'vecidx_' + sanitize(collection)

const similarityFn = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'euclidean' : 'cosine'

export class Neo4jVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Writes commit synchronously over Bolt and the index awaits; visible on resolve. No-op option.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #driver: any | null = null
  #neo4j: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): Neo4jVectorStoreOptions {
    return this.options as Neo4jVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#driver) return
    const neo4j = await getNeo4j()
    this.#neo4j = neo4j
    const c = this.#opts.connection
    try {
      this.#driver = neo4j.driver(
        c.url,
        c.username ? neo4j.auth.basic(c.username, c.password ?? '') : undefined
      )
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#driver) {
      await this.#driver.close()
      this.#driver = null
    }
  }

  async #run(cypher: string, params?: Record<string, unknown>): Promise<any[]> {
    if (!this.#driver) await this.connect()
    const db = this.#opts.connection.database
    const session = this.#driver.session(db ? { database: db } : undefined)
    try {
      const res = await session.run(cypher, params)
      return res.records
    } finally {
      await session.close()
    }
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const label = labelFor(spec.collection)
    const index = indexFor(spec.collection)
    try {
      if (!ifNotExists) {
        await this.#run(`DROP INDEX ${index} IF EXISTS`)
      }
      await this.#run(
        `CREATE VECTOR INDEX ${index} IF NOT EXISTS FOR (n:${label}) ON (n.vec) ` +
          `OPTIONS {indexConfig: {\`vector.dimensions\`: $dim, \`vector.similarity_function\`: $sim}}`,
        { dim: this.#neo4j.int(spec.vector.dimensions), sim: similarityFn(spec.vector.metric) }
      )
      await this.#run(`CALL db.awaitIndex($index, $timeout)`, {
        index,
        timeout: this.#neo4j.int(30),
      }).catch(() => undefined)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, _ifExists: boolean): Promise<void> {
    const label = labelFor(collection)
    const index = indexFor(collection)
    try {
      await this.#run(`DROP INDEX ${index} IF EXISTS`)
      await this.#run(`MATCH (n:${label}) DETACH DELETE n`)
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const index = indexFor(collection)
    try {
      const recs = await this.#run(`SHOW INDEXES YIELD name WHERE name = $index RETURN name`, {
        index,
      })
      return recs.length > 0
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'neo4j'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const label = labelFor(plan.collection)
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    try {
      for (const r of plan.records) {
        let vector = r.vector
        if (!vector && r.document) {
          const [v] = await this.encode([r.document], 'document')
          vector = v
        }
        if (!vector) {
          throw new E_VECTOR_STORE_UPSERT_FAILED(['Record missing vector and document'])
        }
        if (expected !== undefined && vector.length !== expected) {
          throw new E_VECTOR_STORE_DIMENSION_MISMATCH([expected, vector.length])
        }
        await this.#run(
          `MERGE (n:${label} {id: $id}) ` +
            `SET n.vec = $vec, n.document = $document, n.metadata = $metadata`,
          {
            id: r.id,
            vec: vector,
            document: r.document ?? '',
            metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
          }
        )
      }
    } catch (err) {
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_DIMENSION_MISMATCH', E_VECTOR_STORE_DIMENSION_MISMATCH) ||
        isInstanceOf(err, 'E_VECTOR_STORE_UPSERT_FAILED', E_VECTOR_STORE_UPSERT_FAILED)
      ) {
        throw err
      }
      throw new E_VECTOR_STORE_UPSERT_FAILED([String(err)])
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    const label = labelFor(plan.collection)
    const index = indexFor(plan.collection)
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const recs = await this.#run(`MATCH (n:${label} {id: $id}) RETURN n.vec AS vec`, {
          id: plan.near.id,
        })
        if (recs.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = recs[0].get('vec') as number[]
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        // Over-fetch when filtering so the JS post-filter still yields topK.
        const k = plan.filter ? 1000 : plan.topK + offset
        const recs = await this.#run(
          `CALL db.index.vector.queryNodes($index, $k, $qv) YIELD node, score ` +
            `RETURN node.id AS id, node.vec AS vec, node.document AS document, ` +
            `node.metadata AS metadata, score ORDER BY score DESC`,
          { index, k: this.#neo4j.int(k), qv: queryVector }
        )
        const mapped = recs.map((rec: any) => ({
          row: {
            id: rec.get('id'),
            vec: rec.get('vec'),
            document: rec.get('document'),
            metadata: rec.get('metadata'),
            score: rec.get('score'),
          },
        }))
        const filtered = plan.filter
          ? mapped.filter((m: any) => evaluateFilter(plan.filter!, this.#parseMeta(m.row.metadata)))
          : mapped
        return filtered
          .slice(offset, offset + plan.topK)
          .map((m: any) => this.#project(m.row, plan, true))
      } else {
        const recs = await this.#run(
          `MATCH (n:${label}) RETURN n.id AS id, n.vec AS vec, n.document AS document, n.metadata AS metadata`
        )
        const rows = recs.map((rec: any) => ({
          id: rec.get('id'),
          vec: rec.get('vec'),
          document: rec.get('document'),
          metadata: rec.get('metadata'),
        }))
        const filtered = plan.filter
          ? rows.filter((row: any) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row: any) => this.#project(row, plan, false))
      }
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #parseMeta(val: unknown): VectorMetadata {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val) as VectorMetadata
      } catch {
        return {}
      }
    }
    if (val && typeof val === 'object') return val as VectorMetadata
    return {}
  }

  #project(row: any, plan: SearchPlan, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = row.id as string
    if (proj.vector && Array.isArray(row.vec)) out.vector = (row.vec as number[]).map(Number)
    if (proj.document) out.document = (row.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(row.metadata)
    if (isKnn && row.score !== undefined && row.score !== null) {
      // Neo4j cosine similarity score is already in [0,1], higher = closer.
      out.score = Number(row.score)
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const label = labelFor(plan.collection)
    try {
      if (plan.ids && plan.ids.length > 0) {
        await this.#run(`MATCH (n:${label}) WHERE n.id IN $ids DETACH DELETE n`, { ids: plan.ids })
      } else if (plan.filter) {
        const recs = await this.#run(`MATCH (n:${label}) RETURN n.id AS id, n.metadata AS metadata`)
        const targets = recs
          .filter((rec: any) => evaluateFilter(plan.filter!, this.#parseMeta(rec.get('metadata'))))
          .map((rec: any) => rec.get('id') as string)
        if (targets.length > 0) {
          await this.#run(`MATCH (n:${label}) WHERE n.id IN $ids DETACH DELETE n`, { ids: targets })
        }
      } else {
        await this.#run(`MATCH (n:${label}) DETACH DELETE n`)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
