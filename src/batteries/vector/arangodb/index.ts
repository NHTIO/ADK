/**
 * @module @nhtio/adk/batteries/vector/arangodb
 *
 * ArangoDB adapter (experimental vector index, 3.12.4+). Each collection is an ArangoDB
 * document collection keyed by `_key`; a `vector` index on `vec` enables KNN via
 * `APPROX_NEAR_COSINE` / `APPROX_NEAR_L2`. Metadata is a JSON string attribute filtered with
 * the neutral filter tree's JS reference evaluator for exact cross-adapter parity.
 *
 * Driver: `arangojs` (pure JS). Requires the server started with
 * `--experimental-vector-index=true`. All values are passed as AQL bind parameters.
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
} from '../types'

export interface ArangoDBVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: {
    url: string
    username?: string
    password?: string
    database?: string
    nLists?: number
  }
}

const getArango = async () => {
  try {
    const mod = await import('arangojs')
    return mod
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['arangojs'])
  }
}

export class ArangoDBVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Document writes are synchronous (visible on resolve). The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #db: any | null = null
  #aql: any | null = null
  #dims: Map<string, number> = new Map()
  // ArangoDB's IVF vector index can't be created on an empty collection ("not ready") and
  // needs nLists <= doc count. We therefore create the index lazily after the first upsert.
  #indexed: Set<string> = new Set()

  get #opts(): ArangoDBVectorStoreOptions {
    return this.options as ArangoDBVectorStoreOptions
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#db) return
    const arango = await getArango()
    this.#aql = arango.aql
    const c = this.#opts.connection
    const dbName = c.database ?? 'vector'
    try {
      const auth = c.username ? { username: c.username, password: c.password ?? '' } : undefined
      const sys = new arango.Database({ url: c.url, auth })
      const exists = await sys.listDatabases().then((dbs: string[]) => dbs.includes(dbName))
      if (!exists) {
        await sys.createDatabase(dbName)
      }
      this.#db = new arango.Database({ url: c.url, databaseName: dbName, auth })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    this.#db = null
    this.#aql = null
  }

  async #ensure(): Promise<any> {
    if (!this.#db) await this.connect()
    return this.#db!
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const db = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    try {
      const col = db.collection(spec.collection)
      const exists = await col.exists()
      if (exists && !ifNotExists) {
        await col.drop()
        this.#indexed.delete(spec.collection)
      }
      if (!(await col.exists())) {
        await col.create()
        this.#indexed.delete(spec.collection)
      }
      // The vector index is created lazily on first upsert (see #ensureVectorIndex): ArangoDB
      // rejects creating it on an empty collection ("vector index not ready").
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  // Create the IVF vector index once the collection has data (idempotent per collection).
  async #ensureVectorIndex(collection: string): Promise<void> {
    if (this.#indexed.has(collection)) return
    const db = await this.#ensure()
    const col = db.collection(collection)
    const metric = this.#opts.metric ?? 'cosine'
    const dim = this.#dims.get(collection) ?? this.#opts.dimensions
    if (dim === undefined) return
    try {
      await col.ensureIndex({
        type: 'vector',
        fields: ['vec'],
        params: {
          metric: metric === 'euclidean' ? 'l2' : 'cosine',
          dimension: dim,
          nLists: this.#opts.connection.nLists ?? 1,
        },
      })
      this.#indexed.add(collection)
    } catch {
      // If it still isn't ready (too few docs), leave it; executeSearch falls back to a
      // brute-force AQL scan so correctness holds regardless of the index.
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const db = await this.#ensure()
    try {
      const col = db.collection(collection)
      if (await col.exists()) {
        await col.drop()
      } else if (!ifExists) {
        throw new Error('collection not found: ' + collection)
      }
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const db = await this.#ensure()
    try {
      return await db.collection(collection).exists()
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'arangodb'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const db = await this.#ensure()
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    try {
      const col = db.collection(plan.collection)
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
        const doc = {
          _key: r.id,
          vec: vector,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
        }
        await col.save(doc, { overwriteMode: 'replace' })
      }
      // Now that the collection has data, ensure the IVF vector index exists.
      await this.#ensureVectorIndex(plan.collection)
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
    const db = await this.#ensure()
    const aql = this.#aql
    const metric = this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const col = db.collection(plan.collection)
        try {
          const doc = await col.document(plan.near.id)
          queryVector = doc.vec as number[]
        } catch {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
      }
    }

    const offset = plan.offset ?? 0
    try {
      let rows: any[]
      if (queryVector) {
        // Use the exact AQL distance functions (COSINE_SIMILARITY / L2_DISTANCE) rather than the
        // APPROX_NEAR_* index functions: they need no index, are always correct, and avoid
        // ArangoDB's IVF "not ready" / nLists-vs-doc-count constraints. The IVF index is still
        // created lazily on upsert for production-scale ANN; here correctness comes first.
        const useL2 = metric === 'euclidean'
        const fn = useL2 ? 'L2_DISTANCE' : 'COSINE_SIMILARITY'
        const dir = useL2 ? 'ASC' : 'DESC'
        const k = plan.filter ? 100000 : plan.topK + offset
        const query =
          `FOR d IN @@col ` +
          `LET __score = ${fn}(d.vec, @qv) ` +
          `SORT __score ${dir} LIMIT @k ` +
          `RETURN { id: d._key, vec: d.vec, document: d.document, metadata: d.metadata, score: __score }`
        const cursor = await db.query(query, {
          '@col': plan.collection,
          'qv': queryVector,
          k,
        })
        rows = await cursor.all()
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, true))
      } else {
        const cursor = await db.query(
          aql`FOR d IN ${db.collection(plan.collection)} RETURN { id: d._key, vec: d.vec, document: d.document, metadata: d.metadata }`
        )
        rows = await cursor.all()
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, false))
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
      // APPROX_NEAR_COSINE returns cosine similarity in [0,1]; L2 returns a distance.
      const m = this.#opts.metric ?? 'cosine'
      out.score = m === 'euclidean' ? 1 / (1 + Number(row.score)) : Number(row.score)
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const db = await this.#ensure()
    const aql = this.#aql
    try {
      const col = db.collection(plan.collection)
      if (plan.ids && plan.ids.length > 0) {
        await col.removeAll(plan.ids).catch(async () => {
          for (const id of plan.ids!) await col.remove(id).catch(() => undefined)
        })
      } else if (plan.filter) {
        const cursor = await db.query(
          aql`FOR d IN ${col} RETURN { id: d._key, metadata: d.metadata }`
        )
        const rows = await cursor.all()
        const targets = rows
          .filter((row: any) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          .map((row: any) => row.id as string)
        if (targets.length > 0) {
          await col.removeAll(targets).catch(async () => {
            for (const id of targets) await col.remove(id).catch(() => undefined)
          })
        }
      } else {
        await col.truncate()
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
