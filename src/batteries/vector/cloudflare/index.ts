/**
 * @module @nhtio/adk/batteries/vector/cloudflare
 *
 * Managed Cloudflare Vectorize V2 vector-store adapter over REST (pure fetch, no driver).
 * A logical collection maps to a Vectorize **index**. Supported dimensions: 32–1536.
 *
 * Upserter: POST /{name}/upsert via `multipart/form-data` with field name `vectors`
 * (content-type `application/x-ndjson`). Each line: `{"id":"..","values":[..],"metadata":{..}}`.
 * Query/get/delete use JSON bodies. Eventual consistency is handled by settle-polling.
 *
 * Native filtering: Vectorize requires pre-created metadata indexes and lacks `$and`/`$or`.
 * For guaranteed cross-adapter parity, **over-fetch + JS evaluateFilter** (topK cap 100).
 *
 * Scores: returned as-is from Vectorize, then re-computed locally (cosineSim/dotProd/euclideanDist)
 * to guarantee the [0,1] contract.
 *
 * Document: stored under the reserved metadata key `__document`; extracted on read.
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import {
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

// Cloudflare Vectorize V2 REST endpoint base
const BASE_URL = 'https://api.cloudflare.com/client/v4/accounts'

// Over-fetch constant for JS filtering (Vectorize native filtering needs metadata indexes + lacks
// $and/$or). Cloudflare caps topK at 50 when returnValues=true or returnMetadata=all (which we
// need to recompute scores + filter locally), so 50 is the ceiling.
const OVERFETCH = 50

const mapMetricToCF = (metric: DistanceMetric): string => {
  if (metric === 'cosine') return 'cosine'
  if (metric === 'euclidean') return 'euclidean'
  if (metric === 'dot') return 'dot-product'
  throw new E_VECTOR_STORE_COLLECTION_FAILED([
    'createCollection',
    `Metric "${metric}" is not supported by Cloudflare Vectorize; use "cosine", "euclidean", or "dot"`,
  ])
}

// Score computation helpers (copied from couchbase/index.ts)
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

export interface CloudflareVectorizeVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: {
    accountId: string
    apiKey: string
    indexNamePrefix?: string
  }
}

export class CloudflareVectorizeVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #baseUrl: string | null = null
  #authHeaders: Record<string, string> | null = null
  #dims: Map<string, number> = new Map()
  #metrics: Map<string, DistanceMetric> = new Map()

  get #opts(): CloudflareVectorizeVectorStoreOptions {
    return this.options as CloudflareVectorizeVectorStoreOptions
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined' && typeof fetch !== 'undefined'
  }

  isAvailable(): boolean {
    return typeof process !== 'undefined' && typeof fetch !== 'undefined'
  }

  #base(): string {
    if (!this.#baseUrl) {
      this.#baseUrl = `${BASE_URL}/${this.#opts.connection.accountId}/vectorize/v2/indexes`
    }
    return this.#baseUrl
  }

  #headers(): Record<string, string> {
    if (!this.#authHeaders) {
      this.#authHeaders = { Authorization: `Bearer ${this.#opts.connection.apiKey}` }
    }
    return this.#authHeaders
  }

  // Map a logical collection name to its physical Vectorize index name (with optional prefix).
  #index(collection: string): string {
    const prefix = this.#opts.connection.indexNamePrefix ?? ''
    return `${prefix}${collection}`
  }

  async #req<T = any>(
    method: string,
    path: string,
    { json, form }: { json?: any; form?: FormData } = {}
  ): Promise<T> {
    const url = this.#base() + path
    const headers: Record<string, string> = { ...this.#headers() }
    let body: BodyInit | undefined
    if (form) {
      body = form
    } else if (json !== undefined) {
      body = JSON.stringify(json)
      headers['Content-Type'] = 'application/json'
    }
    const res = await fetch(url, { method, headers, body })
    const payload: any = await res.json().catch(() => ({}))
    if (!res.ok || !payload.success) {
      const msg = payload.errors?.[0]?.message || payload.messages?.[0] || `HTTP ${res.status}`
      throw new Error(msg)
    }
    return payload.result
  }

  // Settle-poll after writes/deletes against the QUERY index (the surface reads go through).
  //
  // Vectorize is aggressively eventually-consistent: a fresh index takes ~20s before its first
  // write is queryable, and the query index FLAPS — a just-written id can appear then vanish (or a
  // just-deleted id reappear) across consecutive polls for several seconds. A single converged poll
  // is therefore not enough. We require STABILITY: `STABLE` consecutive polls that all satisfy the
  // present/absent condition before returning, so the subsequent read-after-write is reliable.
  async #settle(
    collection: string,
    opts: { present?: string[]; absent?: string[] }
  ): Promise<void> {
    const present = opts.present ?? []
    const absent = opts.absent ?? []
    if (present.length === 0 && absent.length === 0) return

    const physicalIndex = this.#index(collection)
    const dims = this.#dims.get(collection) ?? this.#opts.dimensions ?? 32
    const probeVec = new Array(dims).fill(0)
    probeVec[0] = 1

    const STABLE = 3 // consecutive satisfying polls required to declare settled
    const deadline = Date.now() + 60_000
    let streak = 0
    while (Date.now() < deadline) {
      let ok = true
      try {
        const res = await this.#req<{ matches: any[] }>('POST', `/${physicalIndex}/query`, {
          json: { vector: probeVec, topK: 50, returnValues: false, returnMetadata: 'none' },
        })
        const seen = new Set((res.matches ?? []).map((m: any) => m.id))
        if (present.length > 0 && !present.every((id) => seen.has(id))) ok = false
        if (absent.length > 0 && !absent.every((id) => !seen.has(id))) ok = false
      } catch {
        ok = false
      }
      streak = ok ? streak + 1 : 0
      if (streak >= STABLE) return
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  async connect(): Promise<void> {
    // HTTP is stateless; the base URL + auth headers are built lazily and cached on first use.
  }

  async close(): Promise<void> {
    this.#baseUrl = null
    this.#authHeaders = null
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const collection = spec.collection
    const physicalIndex = this.#index(collection)
    const dims = spec.vector.dimensions
    const metric = spec.vector.metric

    // Validate dimensions (32–1536)
    if (dims < 32 || dims > 1536) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED([
        'createCollection',
        `Dimensions must be 32–1536; got ${dims}`,
      ])
    }

    this.#dims.set(collection, dims)
    this.#metrics.set(collection, metric)

    if (ifNotExists) {
      if (await this.hasCollection(collection)) return
    }

    try {
      await this.connect()
      const body: any = {
        name: physicalIndex,
        config: {
          dimensions: dims,
          metric: mapMetricToCF(metric),
        },
      }
      await this.#req('POST', '', { json: body })
    } catch (err: any) {
      const msg = String(err)
      if (ifNotExists && msg.toLowerCase().includes('already exists')) {
        return
      }
      // If NOT ifNotExists and exists, best-effort clear (Vectorize has no bulk-clear;
      // per-test isolation uses prefix so fresh index is effectively empty).
      if (!ifNotExists && msg.toLowerCase().includes('already exists')) {
        try {
          await this.dropCollection(collection, true)
          await this.createCollection(spec, false)
          return
        } catch {
          // Fall through to rethrow original
        }
      }
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', msg])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const physicalIndex = this.#index(collection)

    if (ifExists) {
      if (!(await this.hasCollection(collection))) return
    } else if (!(await this.hasCollection(collection))) {
      return
    }

    try {
      await this.connect()
      await this.#req('DELETE', `/${physicalIndex}`)
      // Clear local state
      this.#dims.delete(collection)
      this.#metrics.delete(collection)
    } catch (err: any) {
      const msg = String(err)
      if (ifExists && (msg.includes('not found') || msg.includes('404'))) {
        return
      }
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    await this.connect()
    const physicalIndex = this.#index(collection)
    try {
      const res: any = await this.#req('GET', `/${physicalIndex}`)
      return !!res
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'cloudflare'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)

    const collection = plan.collection
    const physicalIndex = this.#index(collection)
    const dims = this.#dims.get(collection) ?? this.#opts.dimensions

    try {
      await this.connect()

      const ndjsonLines: string[] = []
      for (const r of plan.records) {
        let vector = r.vector
        if (!vector && r.document) {
          const [v] = await this.encode([r.document], 'document')
          vector = v
        }
        if (!vector) {
          throw new E_VECTOR_STORE_UPSERT_FAILED(['Record missing vector and document'])
        }
        if (dims !== undefined && vector.length !== dims) {
          throw new E_VECTOR_STORE_DIMENSION_MISMATCH([dims, vector.length])
        }
        const meta: any = { ...(r.metadata ?? {}) }
        if (r.document) meta.__document = r.document
        ndjsonLines.push(JSON.stringify({ id: r.id, values: vector, metadata: meta }))
      }

      const ndjson = ndjsonLines.join('\n')

      // Build FormData for multipart upload
      const fd = new FormData()
      fd.append('vectors', new Blob([ndjson], { type: 'application/x-ndjson' }), 'vectors.ndjson')

      await this.#req('POST', `/${physicalIndex}/upsert`, { form: fd })

      // Settle until all ids are visible
      await this.#settle(collection, { present: plan.records.map((r) => r.id) })
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
    await this.connect()
    const collection = plan.collection
    const physicalIndex = this.#index(collection)
    const metric = this.#metrics.get(collection) ?? this.#opts.metric ?? 'cosine'
    const offset = plan.offset ?? 0
    const dims = this.#dims.get(collection) ?? this.#opts.dimensions ?? 32

    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        try {
          const res: any = await this.#req('POST', `/${physicalIndex}/get_by_ids`, {
            json: { ids: [plan.near.id] },
          })
          const match = Array.isArray(res) ? res[0] : res?.result?.[0]
          if (!match || !match.values) {
            throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
          }
          queryVector = match.values
        } catch (err: any) {
          const msg = String(err)
          if (msg.includes('not found') || msg.includes('404')) {
            throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
          }
          throw new E_VECTOR_STORE_SEARCH_FAILED([msg])
        }
      }
    }

    if (queryVector) {
      // Similarity search: query with over-fetch, JS-filter, recompute scores
      const res: any = await this.#req('POST', `/${physicalIndex}/query`, {
        json: {
          vector: queryVector,
          topK: OVERFETCH,
          filter: undefined, // no native filter for parity
          returnValues: true,
          returnMetadata: 'all',
        },
      })
      let rawMatches = res.matches ?? []

      // Filter by JS-evaluateFilter
      if (plan.filter) {
        rawMatches = rawMatches.filter((m: any) => {
          const meta = this.#projectMeta(m.metadata)
          return evaluateFilter(plan.filter!, meta)
        })
      }

      // Slice offset+topK
      rawMatches = rawMatches.slice(offset, offset + plan.topK)

      // Re-compute scores and project
      const out: VectorMatch[] = []
      for (const m of rawMatches) {
        const projected = this.#project(m, plan, undefined, metric, queryVector)
        if (projected) out.push(projected)
      }
      return out
    } else {
      // Filter-scan: query with arbitrary probe vector, over-fetch, JS-filter
      const probeVec = new Array(dims).fill(0)
      probeVec[0] = 1

      const res: any = await this.#req('POST', `/${physicalIndex}/query`, {
        json: {
          vector: probeVec,
          topK: OVERFETCH,
          filter: undefined,
          returnValues: false,
          returnMetadata: 'all',
        },
      })
      let rawMatches = res.matches ?? []

      // JS-filter
      if (plan.filter) {
        rawMatches = rawMatches.filter((m: any) => {
          const meta = this.#projectMeta(m.metadata)
          return evaluateFilter(plan.filter!, meta)
        })
      }

      // Slice
      rawMatches = rawMatches.slice(offset, offset + plan.topK)

      // Project without score
      const out: VectorMatch[] = []
      for (const m of rawMatches) {
        const projected = this.#project(m, plan, undefined, metric, undefined)
        if (projected) out.push(projected)
      }
      return out
    }
  }

  #projectMeta(metadata: any): VectorMetadata {
    if (!metadata || typeof metadata !== 'object') return {}
    const out: VectorMetadata = {}
    for (const key in metadata) {
      if (key !== '__document') out[key] = metadata[key]
    }
    return out
  }

  #project(
    match: any,
    plan: SearchPlan,
    score: number | undefined,
    metric: DistanceMetric,
    queryVector: number[] | undefined
  ): VectorMatch | null {
    const proj = plan.projection
    const out: VectorMatch = {}

    if (proj.id) out.id = match.id

    if (proj.document) {
      const meta = match.metadata ?? {}
      if (typeof meta.__document === 'string') {
        out.document = meta.__document
      }
    }

    if (proj.metadata) {
      out.metadata = this.#projectMeta(match.metadata)
    }

    if (proj.vector) {
      out.vector = match.values
    }

    if (typeof score === 'number') {
      out.score = score
    } else if (queryVector && match.values) {
      // Recompute score for the [0,1] contract
      out.score = computeScore(match.values, queryVector, metric)
    }

    // If nothing was projected, return null to filter out
    if (Object.keys(out).length === 0) return null
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const collection = plan.collection
    const physicalIndex = this.#index(collection)

    try {
      await this.connect()

      if (plan.ids && plan.ids.length > 0) {
        await this.#req('POST', `/${physicalIndex}/delete_by_ids`, {
          json: { ids: plan.ids },
        })
        await this.#settle(collection, { absent: plan.ids })
      } else if (plan.filter) {
        // Enumerate all, JS-filter, delete matched
        const dims = this.#dims.get(collection) ?? this.#opts.dimensions ?? 32
        const probeVec = new Array(dims).fill(0)
        probeVec[0] = 1

        const res: any = await this.#req('POST', `/${physicalIndex}/query`, {
          json: {
            vector: probeVec,
            topK: OVERFETCH,
            returnValues: true,
            returnMetadata: 'all',
          },
        })
        const targets: string[] = []
        for (const m of res.matches ?? []) {
          const meta = this.#projectMeta(m.metadata)
          if (evaluateFilter(plan.filter!, meta)) {
            targets.push(m.id)
          }
        }

        if (targets.length > 0) {
          await this.#req('POST', `/${physicalIndex}/delete_by_ids`, {
            json: { ids: targets },
          })
          await this.#settle(collection, { absent: targets })
        }
      } else {
        // Delete all: enumerate all ids then delete
        const dims = this.#dims.get(collection) ?? this.#opts.dimensions ?? 32
        const probeVec = new Array(dims).fill(0)
        probeVec[0] = 1

        const res: any = await this.#req('POST', `/${physicalIndex}/query`, {
          json: {
            vector: probeVec,
            topK: OVERFETCH,
            returnValues: true,
            returnMetadata: 'all',
          },
        })

        const allIds = (res.matches ?? []).map((m: any) => m.id)
        if (allIds.length > 0) {
          await this.#req('POST', `/${physicalIndex}/delete_by_ids`, {
            json: { ids: allIds },
          })
          await this.#settle(collection, { absent: allIds })
        }
      }
    } catch (err: any) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
