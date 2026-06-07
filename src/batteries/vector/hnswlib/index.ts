/**
 * @module @nhtio/adk/batteries/vector/hnswlib
 *
 * Embedded HNSWLib adapter (in-process, no server — like in_memory/sqlite_vec/duckdb). hnswlib is
 * a pure ANN index keyed by integer labels and holding ONLY vectors, so this adapter pairs the
 * index with a JS sidecar that owns id↔label mapping plus the document/metadata records. KNN runs
 * through the HNSW index; metadata filtering, filter-scans, projection and delete are served from
 * the sidecar via the neutral filter tree's JS reference evaluator (exact cross-adapter parity).
 *
 * Driver: `hnswlib-node` (native addon; requires the build to be approved — see
 * pnpm-workspace.yaml `allowBuilds`). Persistence is in-memory per process; pass a fresh store per
 * use. (The index supports writeIndex/readIndex on disk, but the sidecar would need its own
 * persistence — out of scope for the in-memory contract here.)
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
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

export interface HnswlibVectorStoreOptions extends BaseVectorStoreOptions {
  // Initial index capacity per collection (grows automatically via resizeIndex). Default 1024.
  initialCapacity?: number
}

interface StoredRecord {
  id: string
  label: number
  vector: number[]
  document?: string
  metadata?: VectorMetadata
}

interface Collection {
  index: any
  dims: number
  metric: DistanceMetric
  byId: Map<string, StoredRecord>
  idByLabel: Map<number, string>
  nextLabel: number
  capacity: number
}

const getHnswlib = async () => {
  try {
    const mod = await import('hnswlib-node')
    return (mod as any).default ?? mod
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['hnswlib-node'])
  }
}

const spaceFor = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'l2' : metric === 'dot' ? 'ip' : 'cosine'

export class HnswlibVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: true,
    rawSql: false,
    builtInEncoding: false,
    // In-process and synchronous: a write is visible on resolve. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #lib: any | null = null
  #collections: Map<string, Collection> = new Map()

  get #opts(): HnswlibVectorStoreOptions {
    return this.options as HnswlibVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#lib) return
    this.#lib = await getHnswlib()
  }

  async close(): Promise<void> {
    this.#collections.clear()
    this.#lib = null
  }

  async #ensureLib(): Promise<any> {
    if (!this.#lib) await this.connect()
    return this.#lib!
  }

  #coll(collection: string): Collection {
    const c = this.#collections.get(collection)
    if (!c) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED([
        'collection',
        'unknown collection: ' + collection,
      ])
    }
    return c
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const lib = await this.#ensureLib()
    if (this.#collections.has(spec.collection)) {
      if (ifNotExists) return
      this.#collections.delete(spec.collection)
    }
    try {
      const capacity = this.#opts.initialCapacity ?? 1024
      const index = new lib.HierarchicalNSW(spaceFor(spec.vector.metric), spec.vector.dimensions)
      index.initIndex(capacity)
      this.#collections.set(spec.collection, {
        index,
        dims: spec.vector.dimensions,
        metric: spec.vector.metric,
        byId: new Map(),
        idByLabel: new Map(),
        nextLabel: 0,
        capacity,
      })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (!this.#collections.has(collection)) {
      if (ifExists) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', 'unknown collection'])
    }
    this.#collections.delete(collection)
  }

  async hasCollection(collection: string): Promise<boolean> {
    return this.#collections.has(collection)
  }

  async renameCollection(from: string, to: string): Promise<void> {
    const c = this.#collections.get(from)
    if (!c) throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'unknown: ' + from])
    this.#collections.set(to, c)
    this.#collections.delete(from)
  }

  #ensureCapacity(c: Collection, additional: number): void {
    const needed = c.byId.size + additional
    if (needed > c.capacity) {
      const next = Math.max(needed, c.capacity * 2)
      c.index.resizeIndex(next)
      c.capacity = next
    }
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    await this.#ensureLib()
    const c = this.#coll(plan.collection)
    const expected = this.#opts.dimensions ?? c.dims
    try {
      this.#ensureCapacity(c, plan.records.length)
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
        // Reuse the existing label on update (mark the old point deleted, then re-add under a
        // fresh label so the vector value actually changes — hnswlib has no in-place update).
        const existing = c.byId.get(r.id)
        if (existing) {
          try {
            c.index.markDelete(existing.label)
          } catch {
            // already gone — ignore
          }
        }
        this.#ensureCapacity(c, 1)
        const label = c.nextLabel++
        c.index.addPoint(vector, label)
        c.idByLabel.set(label, r.id)
        c.byId.set(r.id, { id: r.id, label, vector, document: r.document, metadata: r.metadata })
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
    await this.#ensureLib()
    const c = this.#coll(plan.collection)
    const metric = this.#opts.metric ?? c.metric
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const rec = c.byId.get(plan.near.id)
        if (!rec) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = rec.vector
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        // Over-fetch when filtering (and to absorb deleted points), then JS-filter for parity.
        const live = c.byId.size
        if (live === 0) return []
        const want = plan.filter ? live : Math.min(plan.topK + offset, live)
        const k = Math.min(Math.max(want, 1), live)
        const res = c.index.searchKnn(queryVector, k)
        const hits: Array<{ rec: StoredRecord; dist: number }> = []
        for (let i = 0; i < res.neighbors.length; i++) {
          const id = c.idByLabel.get(res.neighbors[i])
          if (id === undefined) continue
          const rec = c.byId.get(id)
          if (rec) hits.push({ rec, dist: res.distances[i] })
        }
        const filtered = plan.filter
          ? hits.filter((h) => evaluateFilter(plan.filter!, h.rec.metadata ?? {}))
          : hits
        return filtered
          .slice(offset, offset + plan.topK)
          .map((h) => this.#project(h.rec, plan, metric, h.dist))
      } else {
        // Filter-scan: serve from the sidecar (insertion order), JS-filter, no score.
        const rows = [...c.byId.values()]
        const filtered = plan.filter
          ? rows.filter((rec) => evaluateFilter(plan.filter!, rec.metadata ?? {}))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((rec) => this.#project(rec, plan, metric, undefined))
      }
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #project(
    rec: StoredRecord,
    plan: SearchPlan,
    metric: string,
    dist: number | undefined
  ): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = rec.id
    if (proj.vector) out.vector = rec.vector.slice()
    if (proj.document) out.document = rec.document
    if (proj.metadata) out.metadata = rec.metadata ?? {}
    if (dist !== undefined) {
      out.score = normalizeScore(dist, metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    await this.#ensureLib()
    const c = this.#coll(plan.collection)
    try {
      let targets: string[]
      if (plan.ids && plan.ids.length > 0) {
        targets = plan.ids
      } else if (plan.filter) {
        targets = [...c.byId.values()]
          .filter((rec) => evaluateFilter(plan.filter!, rec.metadata ?? {}))
          .map((rec) => rec.id)
      } else {
        targets = [...c.byId.keys()]
      }
      for (const id of targets) {
        const rec = c.byId.get(id)
        if (!rec) continue
        try {
          c.index.markDelete(rec.label)
        } catch {
          // already deleted — ignore
        }
        c.idByLabel.delete(rec.label)
        c.byId.delete(id)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
