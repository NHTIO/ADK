/**
 * @module @nhtio/adk/batteries/vector/qdrant
 */

import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { normalizeScore, sanitizeMetadata } from '../helpers'
import { isFilterCondition, isRawFilter, isFilterGroup } from '../filters'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR,
  E_VECTOR_STORE_UNSUPPORTED_OPERATION,
} from '../exceptions'
import type { VectorFilter } from '../filters'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type { VectorMatch, VectorStoreCapabilities, BaseVectorStoreOptions } from '../types'

/** Translate a neutral {@link VectorFilter} into a Qdrant filter object. */
export const translateQdrantFilter = (
  filter?: VectorFilter
): Record<string, unknown> | undefined => {
  if (!filter) return undefined
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'qdrant') {
      return filter.$raw as Record<string, unknown>
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['qdrant', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    if (value === undefined) {
      if (op === 'exists') {
        return { must_not: [{ is_empty: { key: field } }] }
      }
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['qdrant', op])
    }
    if (op === 'eq') {
      return { must: [{ key: field, match: { value } }] }
    }
    if (op === 'ne') {
      return { must_not: [{ key: field, match: { value } }] }
    }
    if (op === 'gt') {
      return { must: [{ key: field, range: { gt: value } }] }
    }
    if (op === 'gte') {
      return { must: [{ key: field, range: { gte: value } }] }
    }
    if (op === 'lt') {
      return { must: [{ key: field, range: { lt: value } }] }
    }
    if (op === 'lte') {
      return { must: [{ key: field, range: { lte: value } }] }
    }
    if (op === 'in') {
      return { must: [{ key: field, match: { any: value } }] }
    }
    if (op === 'nin') {
      return { must_not: [{ key: field, match: { any: value } }] }
    }
    if (op === 'exists') {
      return value === false
        ? { must: [{ is_empty: { key: field } }] }
        : { must_not: [{ is_empty: { key: field } }] }
    }
    if (op === 'contains') {
      return { must: [{ key: field, match: { value } }] }
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['qdrant', op])
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and) {
      const children = and
        .map((f) => translateQdrantFilter(f) as Record<string, unknown>)
        .filter((c) => c !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return { must: children }
    }
    if (or) {
      const children = or
        .map((f) => translateQdrantFilter(f) as Record<string, unknown>)
        .filter((c) => c !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return { should: children }
    }
    if (not) {
      const child = translateQdrantFilter(not)
      if (!child) return { must_not: [] }
      return { must_not: [child] }
    }
    return undefined
  }
  return undefined
}

export interface QdrantVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection?: { url?: string; host?: string; port?: number; apiKey?: string; https?: boolean }
}

const getQdrantClient = async () => {
  try {
    const mod = await import('@qdrant/js-client-rest')
    return mod.QdrantClient
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@qdrant/js-client-rest'])
  }
}

const getSha256 = () => {
  try {
    const mod = require('js-sha256')
    return mod.sha256
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['js-sha256'])
  }
}

const uuidFromId = (id: string): string => {
  const sha256 = getSha256()
  const h = sha256(id)
  return (
    h.slice(0, 8) +
    '-' +
    h.slice(8, 12) +
    '-' +
    h.slice(12, 16) +
    '-' +
    h.slice(16, 20) +
    '-' +
    h.slice(20, 32)
  )
}

export class QdrantVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: true,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Strongly consistent (writes use wait=true): visible on resolve, so the option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }
  #client: any | null = null
  get #opts() {
    return this.options as QdrantVectorStoreOptions
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
    const QdrantClient = await getQdrantClient()
    const c = this.#opts.connection || {}
    this.#client = new QdrantClient({
      url: c.url,
      host: c.host,
      port: c.port,
      apiKey: c.apiKey,
      https: c.https,
    })
  }
  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.close()
      this.#client = null
    }
  }
  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    const dist =
      spec.vector.metric === 'cosine' ? 'Cosine' : spec.vector.metric === 'dot' ? 'Dot' : 'Euclid'
    if (ifNotExists && (await this.hasCollection(spec.collection))) return
    try {
      await client.createCollection(spec.collection, {
        vectors: { size: spec.vector.dimensions, distance: dist },
      })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }
  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      await client.deleteCollection(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }
  async hasCollection(collection: string): Promise<boolean> {
    const client = this.#client || (await this.connect(), this.#client!)
    try {
      await client.getCollection(collection)
      return true
    } catch {
      return false
    }
  }
  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'qdrant'])
  }
  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const client = this.#client || (await this.connect(), this.#client!)
    const expected = this.#opts.dimensions
    const points: any[] = []
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
      points.push({
        id: uuidFromId(r.id),
        vector,
        payload: { ...sanitizeMetadata(r.metadata), __id: r.id, __document: r.document },
      })
    }
    try {
      await client.upsert(plan.collection, { points })
    } catch (err) {
      throw new E_VECTOR_STORE_UPSERT_FAILED([String(err)])
    }
  }
  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    const client = this.#client || (await this.connect(), this.#client!)
    const metric = this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const res = await client.scroll(plan.collection, {
          filter: { must: [{ key: '__id', match: { value: plan.near.id } }] },
          limit: 1,
          with_payload: true,
          with_vector: true,
        })
        if (res.points.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = res.points[0].vector as number[]
      }
    }
    let hits: any[]
    if (queryVector) {
      const filter = this.translateQdrantFilter(plan.filter)
      const res = await client.search(plan.collection, {
        vector: queryVector,
        limit: plan.topK,
        offset: plan.offset,
        filter,
        with_payload: true,
        with_vector: !!plan.projection.vector,
      })
      hits = res
    } else {
      const filter = this.translateQdrantFilter(plan.filter)
      const res = await client.scroll(plan.collection, {
        filter,
        limit: plan.topK,
        with_payload: true,
        with_vector: !!plan.projection.vector,
      })
      hits = res.points
    }
    const proj = plan.projection
    return hits.map((hit) => this.projectHit(hit, proj, metric))
  }
  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    try {
      if (plan.ids) {
        await client.delete(plan.collection, { points: plan.ids.map(uuidFromId) })
      } else if (plan.filter) {
        await client.delete(plan.collection, { filter: this.translateQdrantFilter(plan.filter) })
      } else {
        await client.delete(plan.collection, { filter: {} })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
  /** Project a raw Qdrant hit into a {@link VectorMatch} per the requested projection, normalizing its score. */
  projectHit(hit: any, projection: any, metric: string): VectorMatch {
    const out: VectorMatch = {}
    const payload = hit.payload || {}
    if (projection.id) {
      out.id = payload.__id
    }
    if (projection.vector && hit.vector) {
      out.vector = hit.vector as number[]
    }
    if (projection.document) {
      out.document = payload.__document
    }
    if (projection.metadata) {
      const meta: Record<string, unknown> = {}
      for (const k in payload) {
        if (k !== '__id' && k !== '__document') {
          meta[k] = payload[k]
        }
      }
      out.metadata = meta as any
    }
    if (projection.score !== false && 'score' in hit) {
      out.score = normalizeScore(
        hit.score as number,
        metric as any,
        metric === 'euclidean' ? 'distance' : 'similarity'
      )
    }
    return out
  }
  /** Instance wrapper over the module-level {@link translateQdrantFilter}. */
  translateQdrantFilter(filter?: VectorFilter): Record<string, unknown> | undefined {
    return translateQdrantFilter(filter)
  }
}
