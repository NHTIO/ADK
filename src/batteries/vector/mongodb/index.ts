/**
 * @module @nhtio/adk/batteries/vector/mongodb
 *
 * MongoDB Atlas Vector Search adapter. Each collection is a MongoDB collection with an Atlas
 * `vectorSearch` index on `vec`; KNN uses the `$vectorSearch` aggregation stage (cosine
 * `vectorSearchScore`, [0,1]). Metadata is a JSON string field filtered with the neutral filter
 * tree's JS reference evaluator for cross-adapter parity.
 *
 * Consistency note: the *document* collection is strongly consistent, but the Atlas vector
 * *index* updates asynchronously after a write (~1s). So filter-scans, fetch-by-id and the
 * delete read-back use a plain `find()` (immediate), and only KNN goes through `$vectorSearch` —
 * after which the adapter polls until the just-inserted ids are index-visible (strong mode).
 *
 * Driver: `mongodb`. Works against `mongodb/mongodb-atlas-local` or a real Atlas cluster.
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

const INDEX = 'vec_idx'

export interface MongoDBVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: {
    url: string
    database?: string
    /**
     * When set, the physical MongoDB collection becomes `${collectionPrefix}${collection}`. The
     * logical collection the builder/base see is unchanged. Lets callers (and the test suite)
     * isolate otherwise identically-named collections — useful because the Atlas vectorSearch
     * index builds asynchronously, so a fresh collection per use avoids drop+rebuild churn.
     */
    collectionPrefix?: string
  }
}

const getMongo = async () => {
  try {
    const mod = await import('mongodb')
    return mod.MongoClient
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['mongodb'])
  }
}

const similarity = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'euclidean' : metric === 'dot' ? 'dotProduct' : 'cosine'

export class MongoDBVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // The document store is strongly consistent; KNN settles on the async index after writes.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any | null = null
  #db: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): MongoDBVectorStoreOptions {
    return this.options as MongoDBVectorStoreOptions
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#client) return
    const MongoClient = await getMongo()
    const c = this.#opts.connection
    try {
      this.#client = new MongoClient(c.url)
      await this.#client.connect()
      this.#db = this.#client.db(c.database ?? 'vector')
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.close()
      this.#client = null
      this.#db = null
    }
  }

  // Map a logical collection name to its physical MongoDB collection (optional prefix).
  #name(collection: string): string {
    const prefix = this.#opts.connection?.collectionPrefix
    return prefix ? `${prefix}${collection}` : collection
  }

  async #col(collection: string): Promise<any> {
    if (!this.#db) await this.connect()
    return this.#db.collection(this.#name(collection))
  }

  async #sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    if (!this.#db) await this.connect()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const physical = this.#name(spec.collection)
    try {
      const names = await this.#db.listCollections({ name: physical }).toArray()
      if (names.length > 0) {
        if (ifNotExists) {
          // Clear any residual documents so each store starts empty.
          await this.#db.collection(physical).deleteMany({})
          return
        }
        await this.#db
          .collection(physical)
          .drop()
          .catch(() => undefined)
      }
      await this.#db.createCollection(physical).catch(() => undefined)
      const col = this.#db.collection(physical)
      // Create the Atlas vectorSearch index if absent, then wait until it's queryable.
      const existing = await col
        .listSearchIndexes()
        .toArray()
        .catch(() => [])
      if (!existing.find((i: any) => i.name === INDEX)) {
        await col.createSearchIndex({
          name: INDEX,
          type: 'vectorSearch',
          definition: {
            fields: [
              {
                type: 'vector',
                path: 'vec',
                numDimensions: spec.vector.dimensions,
                similarity: similarity(spec.vector.metric),
              },
            ],
          },
        })
      }
      for (let i = 0; i < 60; i++) {
        const list = await col.listSearchIndexes().toArray()
        const idx = list.find((x: any) => x.name === INDEX)
        if (idx?.queryable) break
        await this.#sleep(1000)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (!this.#db) await this.connect()
    const physical = this.#name(collection)
    try {
      const names = await this.#db.listCollections({ name: physical }).toArray()
      if (names.length === 0) {
        if (ifExists) return
        throw new Error('collection not found: ' + collection)
      }
      // Clear documents (fast/immediate) and drop the collection; the search index goes with it.
      await this.#db
        .collection(physical)
        .drop()
        .catch(() => undefined)
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    if (!this.#db) await this.connect()
    const names = await this.#db.listCollections({ name: this.#name(collection) }).toArray()
    return names.length > 0
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'mongodb'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const col = await this.#col(plan.collection)
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    const ids: string[] = []
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
        await col.updateOne(
          { id: r.id },
          {
            $set: {
              id: r.id,
              vec: vector,
              document: r.document ?? '',
              metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
            },
          },
          { upsert: true }
        )
        ids.push(r.id)
      }
      // Settle: wait until the just-written ids are visible to $vectorSearch (the index is async).
      await this.#settlePresent(col, ids, expected ?? this.#dims.get(plan.collection) ?? 0)
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

  // Poll $vectorSearch until every id in `ids` appears (bounded). Best-effort: returns on timeout.
  async #settlePresent(col: any, ids: string[], dims: number): Promise<void> {
    if (ids.length === 0 || dims <= 0) return
    const probe = new Array(dims).fill(0)
    probe[0] = 1
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      let seen: Set<string>
      try {
        const res = await col
          .aggregate([
            {
              $vectorSearch: {
                index: INDEX,
                path: 'vec',
                queryVector: probe,
                numCandidates: Math.max(ids.length * 10, 50),
                limit: Math.max(ids.length * 5, 50),
              },
            },
            { $project: { id: 1 } },
          ])
          .toArray()
        seen = new Set(res.map((d: any) => d.id))
      } catch {
        seen = new Set()
      }
      if (ids.every((id) => seen.has(id))) return
      await this.#sleep(300)
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    const col = await this.#col(plan.collection)
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        // Plain find() — strongly consistent, no index lag.
        const doc = await col.findOne({ id: plan.near.id })
        if (!doc) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = doc.vec as number[]
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        const k = (plan.filter ? 1000 : plan.topK + offset) || 10
        const pipeline: any[] = [
          {
            $vectorSearch: {
              index: INDEX,
              path: 'vec',
              queryVector,
              numCandidates: Math.max(k * 10, 100),
              limit: k,
            },
          },
          {
            $project: {
              id: 1,
              vec: 1,
              document: 1,
              metadata: 1,
              score: { $meta: 'vectorSearchScore' },
            },
          },
        ]
        const docs = await col.aggregate(pipeline).toArray()
        const filtered = plan.filter
          ? docs.filter((d: any) => evaluateFilter(plan.filter!, this.#parseMeta(d.metadata)))
          : docs
        return filtered
          .slice(offset, offset + plan.topK)
          .map((d: any) => this.#project(d, plan, true))
      } else {
        // Filter-scan: plain find() (strongly consistent, no $vectorSearch index lag).
        const docs = await col.find({}).toArray()
        const filtered = plan.filter
          ? docs.filter((d: any) => evaluateFilter(plan.filter!, this.#parseMeta(d.metadata)))
          : docs
        return filtered
          .slice(offset, offset + plan.topK)
          .map((d: any) => this.#project(d, plan, false))
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

  #project(doc: any, plan: SearchPlan, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = doc.id as string
    if (proj.vector && Array.isArray(doc.vec)) out.vector = (doc.vec as number[]).map(Number)
    if (proj.document) out.document = (doc.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(doc.metadata)
    if (isKnn && typeof doc.score === 'number') {
      // Atlas vectorSearchScore for cosine is already in [0,1], higher = closer.
      out.score = doc.score
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const col = await this.#col(plan.collection)
    try {
      if (plan.ids && plan.ids.length > 0) {
        await col.deleteMany({ id: { $in: plan.ids } })
      } else if (plan.filter) {
        // Plain find() to resolve target ids (immediate), then delete by id.
        const docs = await col.find({}).toArray()
        const targets = docs
          .filter((d: any) => evaluateFilter(plan.filter!, this.#parseMeta(d.metadata)))
          .map((d: any) => d.id as string)
        if (targets.length > 0) await col.deleteMany({ id: { $in: targets } })
      } else {
        await col.deleteMany({})
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
