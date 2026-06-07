/**
 * @module @nhtio/adk/batteries/vector/couchbase
 *
 * Couchbase (Enterprise) vector-store adapter. Vector search is Enterprise Edition only; the
 * Community Edition will throw "vector typed fields not supported". A logical collection maps to a
 * Couchbase scope.collection inside a bucket. KV operations (upsert/get/remove) use strong
 * consistency, while the scoped FTS vector index is async (settle-polled after writes).
 *
 * Scoring rule: do NOT trust FTS native scores (they vary per metric and are unbounded for
 * euclidean/l2_norm). Instead, use FTS only to retrieve the candidate id set, then KV-get each
 * candidate doc and RE-COMPUTE the similarity score from the stored vec vs query vec using
 * normalizeScore — guaranteeing the [0,1] contract regardless of backend metric quirks.
 *
 * Filter-scan, enumerate, and delete-by-filter use N1QL with RequestPlus for strong consistency.
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
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

const similarity = (metric: DistanceMetric): string =>
  metric === 'cosine' ? 'cosine' : metric === 'dot' ? 'dot_product' : 'l2_norm'

const cosineSim = (a: number[], b: number[]): number => {
  let dot = 0
  let normA = 0
  let normB = 0
  a.forEach((av, i) => {
    const bv = b[i]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  })
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

const dotProd = (a: number[], b: number[]): number => {
  let s = 0
  a.forEach((av, i) => {
    s += av * b[i]
  })
  return s
}

const euclideanDist = (a: number[], b: number[]): number => {
  let s = 0
  a.forEach((av, i) => {
    const d = av - b[i]
    s += d * d
  })
  return Math.sqrt(s)
}

const computeScore = (vec: number[], query: number[], metric: DistanceMetric): number => {
  if (metric === 'cosine') {
    const raw = cosineSim(vec, query)
    return normalizeScore(raw, 'cosine', 'similarity')
  } else if (metric === 'dot') {
    const raw = dotProd(vec, query)
    return normalizeScore(raw, 'dot', 'similarity')
  } else if (metric === 'euclidean') {
    const raw = euclideanDist(vec, query)
    return normalizeScore(raw, 'euclidean', 'distance')
  } else {
    // Fallback
    const raw = cosineSim(vec, query)
    return normalizeScore(raw, 'cosine', 'similarity')
  }
}

const getCB = async (): Promise<any> => {
  try {
    return await import('couchbase')
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['couchbase'])
  }
}

export interface CouchbaseVectorStoreOptions extends BaseVectorStoreOptions {
  connection: {
    url: string
    username: string
    password: string
    bucket: string
    scope?: string
    /**
     * When set, the physical Couchbase collection becomes `${collectionPrefix}${collection}`. The
     * logical collection the builder/base see is unchanged. Lets callers (and the test suite)
     * isolate otherwise identically-named collections — useful because the scoped FTS vector index
     * builds asynchronously, so a fresh collection per use avoids drop+rebuild-index churn.
     */
    collectionPrefix?: string
  }
}

export class CouchbaseVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #cluster: any | null = null
  #bucket: any | null = null
  #cb: any | null = null
  #dims: Map<string, number> = new Map()
  #metrics: Map<string, DistanceMetric> = new Map()

  get #opts(): CouchbaseVectorStoreOptions {
    return this.options as CouchbaseVectorStoreOptions
  }

  #scopeName(): string {
    return this.#opts.connection.scope ?? '_default'
  }

  // Map a logical collection name to its physical Couchbase collection (optional prefix).
  #phys(collection: string): string {
    const prefix = this.#opts.connection.collectionPrefix
    return prefix ? `${prefix}${collection}` : collection
  }

  #vecIndexName(collection: string): string {
    return `${this.#phys(collection)}_vec`
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#cluster) return
    const couchbase = await getCB()
    this.#cb = couchbase
    const c = this.#opts.connection
    try {
      this.#cluster = await couchbase.connect(c.url, { username: c.username, password: c.password })
      this.#bucket = this.#cluster.bucket(c.bucket)
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#cluster) {
      await this.#cluster.close()
      this.#cluster = null
      this.#bucket = null
    }
  }

  async #sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  async #scope(): Promise<any> {
    if (!this.#bucket) await this.connect()
    return this.#bucket.scope(this.#scopeName())
  }

  async #coll(scope: any, collection: string): Promise<any> {
    return scope.collection(this.#phys(collection))
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    if (!this.#bucket) await this.connect()
    const cm = this.#bucket.collections()
    const scopeName = this.#scopeName()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    this.#metrics.set(spec.collection, spec.vector.metric)

    // Physical collection name (logical name + optional prefix); the FTS index, N1QL identifiers
    // and the collection-manager ops all key off the physical name.
    const collectionName = this.#phys(spec.collection)
    const indexName = this.#vecIndexName(spec.collection)

    try {
      // Create scope.collection
      try {
        await cm.createCollection({ name: collectionName, scopeName })
      } catch (err: any) {
        if (err.message && err.message.includes('CollectionExists')) {
          if (ifNotExists) {
            // Clear existing collection
            try {
              await this.#cluster.query(
                `DELETE FROM \`${this.#opts.connection.bucket}\`.\`${scopeName}\`.\`${collectionName}\``
              )
            } catch {
              // Ignore cleanup failures
            }
          } else {
            // Drop and recreate
            await cm.dropCollection(collectionName, scopeName)
            await cm.createCollection({ name: collectionName, scopeName })
          }
        } else {
          throw err
        }
      }

      // Wait for collection to be ready
      await this.#sleep(1000)

      // Create primary index
      try {
        await this.#cluster.query(
          `CREATE PRIMARY INDEX ON \`${this.#opts.connection.bucket}\`.\`${scopeName}\`.\`${collectionName}\``
        )
      } catch {
        // Ignore if already exists
      }

      // Create FTS vector index
      const mgr = this.#bucket.scope(scopeName).searchIndexes()
      try {
        await mgr.upsertIndex({
          name: indexName,
          sourceType: 'gocbcore',
          sourceName: this.#opts.connection.bucket,
          type: 'fulltext-index',
          planParams: { indexPartitions: 1 },
          params: {
            doc_config: {
              mode: 'scope.collection.type_field',
              type_field: 'type',
            },
            mapping: {
              default_mapping: { enabled: false },
              default_analyzer: 'standard',
              default_type: '_default',
              types: {
                [`${scopeName}.${collectionName}`]: {
                  enabled: true,
                  dynamic: false,
                  properties: {
                    vec: {
                      enabled: true,
                      fields: [
                        {
                          name: 'vec',
                          type: 'vector',
                          dims: spec.vector.dimensions,
                          similarity: similarity(spec.vector.metric),
                          index: true,
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        })
      } catch {
        // Ignore if index already exists
      }

      // Poll until index is queryable
      const scope = this.#bucket.scope(scopeName)
      const probe = new Array(spec.vector.dimensions).fill(0)
      probe[0] = 1
      for (let i = 0; i < 60; i++) {
        try {
          const req = this.#cb.SearchRequest.create(
            this.#cb.VectorSearch.fromVectorQuery(
              this.#cb.VectorQuery.create('vec', probe).numCandidates(10)
            )
          )
          await scope.search(indexName, req, { timeout: 10000 })
          break
        } catch {
          await this.#sleep(1000)
        }
      }
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (!this.#bucket) await this.connect()
    const cm = this.#bucket.collections()
    const scopeName = this.#scopeName()
    const physical = this.#phys(collection)
    const indexName = this.#vecIndexName(collection)
    const mgr = this.#bucket.scope(scopeName).searchIndexes()

    try {
      // Drop FTS index
      try {
        await mgr.dropIndex(indexName)
      } catch {
        // Ignore if index doesn't exist
      }

      // Drop collection
      try {
        const scopes = await cm.getAllScopes()
        const scope = scopes.find((s: any) => s.name === scopeName)
        if (!scope) {
          if (ifExists) return
          throw new Error(`scope not found: ${scopeName}`)
        }
        const coll = scope.collections?.find((c: any) => c.name === physical)
        if (!coll) {
          if (ifExists) return
          throw new Error(`collection not found: ${collection}`)
        }
      } catch (err: any) {
        if (err.message && err.message.includes('not found')) {
          if (ifExists) return
          throw err
        }
        throw err
      }

      await cm.dropCollection(physical, scopeName)
      this.#dims.delete(collection)
      this.#metrics.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    if (!this.#bucket) await this.connect()
    const cm = this.#bucket.collections()
    const scopeName = this.#scopeName()
    try {
      const scopes = await cm.getAllScopes()
      const scope = scopes.find((s: any) => s.name === scopeName)
      if (!scope) return false
      return !!scope.collections?.find((c: any) => c.name === this.#phys(collection))
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'couchbase'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const scope = await this.#scope()
    const coll = await this.#coll(scope, plan.collection)
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    const dims = expected ?? 0
    const indexName = this.#vecIndexName(plan.collection)

    try {
      const ids: string[] = []
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
        await coll.upsert(r.id, {
          id: r.id,
          vec: vector,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
          type: plan.collection,
        })
        ids.push(r.id)
      }

      // Poll until FTS index shows all ids
      const probe = new Array(dims).fill(0)
      probe[0] = 1
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        let seen = new Set<string>()
        try {
          const req = this.#cb.SearchRequest.create(
            this.#cb.VectorSearch.fromVectorQuery(
              this.#cb.VectorQuery.create('vec', probe).numCandidates(100)
            )
          )
          const res: any = await scope.search(indexName, req, { timeout: 10000 })
          seen = new Set(res.rows?.map((row: any) => row.id) ?? [])
        } catch {
          // Continue polling
        }
        if (ids.every((id) => seen.has(id))) break
        await this.#sleep(300)
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
    const scope = await this.#scope()
    const coll = await this.#coll(scope, plan.collection)
    const indexName = this.#vecIndexName(plan.collection)
    const metric: DistanceMetric =
      this.#metrics.get(plan.collection) ?? this.#opts.metric ?? 'cosine'
    const oversample = 10

    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        try {
          const got: any = await coll.get(plan.near.id)
          queryVector = got.content?.vec
          if (!queryVector) {
            throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
          }
        } catch (err: any) {
          if (err.message && err.message.includes('DocumentNotFound')) {
            throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
          }
          throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
        }
      }
    }

    const offset = plan.offset ?? 0

    try {
      if (queryVector) {
        // Similarity search: FTS for candidates, then KV-get and re-score
        const k = (plan.filter ? 1000 : (plan.topK + offset) * oversample) || 100
        const req = this.#cb.SearchRequest.create(
          this.#cb.VectorSearch.fromVectorQuery(
            this.#cb.VectorQuery.create('vec', queryVector).numCandidates(Math.max(k, 100))
          )
        )
        const res: any = await scope.search(indexName, req, { timeout: 10000 })
        const candidateIds = res.rows?.map((row: any) => row.id) ?? []

        // KV-get each candidate to get full doc
        const candidates: any[] = []
        for (const id of candidateIds) {
          try {
            const got: any = await coll.get(id)
            candidates.push(got.content)
          } catch {
            // Skip docs that can't be read
          }
        }

        // Apply filter and compute scores
        const filtered = candidates.filter((d) =>
          evaluateFilter(plan.filter ?? {}, this.#parseMeta(d.metadata))
        )

        // Re-compute scores and sort
        const scored = filtered.map((d) => ({
          ...d,
          score: computeScore(d.vec, queryVector, metric),
        }))
        scored.sort((a, b) => b.score - a.score)

        return scored
          .slice(offset, offset + plan.topK)
          .map((d: any) => this.#project(d, plan, true))
      } else {
        // Filter-scan: N1QL
        const bucket = this.#opts.connection.bucket
        const scopeName = this.#scopeName()
        const q = await this.#cluster.query(
          `SELECT d.id, d.vec, d.document, d.metadata FROM \`${bucket}\`.\`${scopeName}\`.\`${this.#phys(plan.collection)}\` d`,
          { scanConsistency: this.#cb.QueryScanConsistency.RequestPlus }
        )
        const docs: any[] = q.rows ?? []

        const filtered = docs.filter((d) =>
          evaluateFilter(plan.filter ?? {}, this.#parseMeta(d.metadata))
        )

        return filtered
          .slice(offset, offset + plan.topK)
          .map((d: any) => this.#project(d, plan, false))
      }
    } catch (err: any) {
      if (err?.message?.includes('Referenced id not found')) {
        throw err
      }
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

  #project(doc: any, plan: SearchPlan, hasScore: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = doc.id as string
    if (proj.vector && Array.isArray(doc.vec)) out.vector = (doc.vec as number[]).map(Number)
    if (proj.document) out.document = (doc.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(doc.metadata)
    if (hasScore && typeof doc.score === 'number') {
      out.score = doc.score
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const scope = await this.#scope()
    const coll = await this.#coll(scope, plan.collection)
    const bucket = this.#opts.connection.bucket
    const scopeName = this.#scopeName()

    try {
      if (plan.ids && plan.ids.length > 0) {
        // Delete by ids
        for (const id of plan.ids) {
          try {
            await coll.remove(id)
          } catch {
            // Ignore DocumentNotFoundError
          }
        }
      } else if (plan.filter) {
        // Enumerate via N1QL, filter, then delete
        const q = await this.#cluster.query(
          `SELECT d.id, d.metadata FROM \`${bucket}\`.\`${scopeName}\`.\`${this.#phys(plan.collection)}\` d`,
          { scanConsistency: this.#cb.QueryScanConsistency.RequestPlus }
        )
        const docs: any[] = q.rows ?? []

        const targets = docs
          .filter((d) => evaluateFilter(plan.filter!, this.#parseMeta(d.metadata)))
          .map((d: any) => d.id as string)

        for (const id of targets) {
          try {
            await coll.remove(id)
          } catch {
            // Ignore DocumentNotFoundError
          }
        }
      } else {
        // Delete all
        await this.#cluster.query(
          `DELETE FROM \`${bucket}\`.\`${scopeName}\`.\`${this.#phys(plan.collection)}\` d`,
          { scanConsistency: this.#cb.QueryScanConsistency.RequestPlus }
        )
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
