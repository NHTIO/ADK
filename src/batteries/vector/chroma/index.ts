/**
 * @module @nhtio/adk/batteries/vector/chroma
 */

import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isFilterCondition, isRawFilter, isFilterGroup } from '../filters'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_CONNECTION_FAILED,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR,
} from '../exceptions'
import type { VectorFilter } from '../filters'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type {
  VectorMatch,
  VectorMetadata,
  BaseVectorStoreOptions,
  VectorStoreCapabilities,
} from '../types'

export interface ChromaVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection?: { url?: string; host?: string; port?: number; ssl?: boolean }
}

const getChromaClient = async () => {
  try {
    const mod = await import('chromadb')
    return mod.ChromaClient
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['chromadb'])
  }
}

const getSpace = (metric: string): string => {
  if (metric === 'cosine') return 'cosine'
  if (metric === 'euclidean') return 'l2'
  if (metric === 'dot') return 'ip'
  return 'cosine'
}

/** Translate a neutral {@link VectorFilter} into Chroma's `where` filter object. */
export const translateChromaWhere = (
  filter?: VectorFilter
): Record<string, unknown> | undefined => {
  if (!filter) return undefined
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'chroma') {
      return filter.$raw as Record<string, unknown>
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['chroma', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    if (value === undefined) {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['chroma', op])
    }
    if (op === 'eq') {
      return { [field]: { $eq: value } }
    }
    if (op === 'ne') {
      return { [field]: { $ne: value } }
    }
    if (op === 'gt') {
      return { [field]: { $gt: value } }
    }
    if (op === 'gte') {
      return { [field]: { $gte: value } }
    }
    if (op === 'lt') {
      return { [field]: { $lt: value } }
    }
    if (op === 'lte') {
      return { [field]: { $lte: value } }
    }
    if (op === 'in') {
      return { [field]: { $in: value } }
    }
    if (op === 'nin') {
      return { [field]: { $nin: value } }
    }
    if (op === 'exists' || op === 'contains') {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['chroma', op])
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['chroma', op])
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and) {
      const children = and
        .map((f) => translateChromaWhere(f) as Record<string, unknown>)
        .filter((c) => c !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return { $and: children }
    }
    if (or) {
      const children = or
        .map((f) => translateChromaWhere(f) as Record<string, unknown>)
        .filter((c) => c !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return { $or: children }
    }
    if (not) {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['chroma', 'not'])
    }
    return undefined
  }
  return undefined
}

export class ChromaVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: true,
    rawSql: false,
    builtInEncoding: false,
    // Strongly consistent on resolve; the option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }
  #client: any | null = null
  #collectionCache: Map<string, any> = new Map()
  get #opts() {
    return this.options as ChromaVectorStoreOptions
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
    const ChromaClient = await getChromaClient()
    const c = this.#opts.connection || {}
    let host: string | undefined
    let port: number | undefined
    let ssl: boolean = false

    if (c.url) {
      const url = new URL(c.url)
      host = url.hostname
      port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80
      ssl = url.protocol === 'https:'
    } else {
      host = c.host
      port = c.port
      ssl = c.ssl || false
    }

    const path =
      host && port !== undefined
        ? `${ssl ? 'https://' : 'http://'}${host}${port === 80 || port === 443 ? '' : ':' + port}`
        : undefined

    try {
      this.#client = new ChromaClient({ path })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    this.#client = null
    this.#collectionCache.clear()
  }

  /** Resolve (and cache) the underlying Chroma collection handle for `name`. */
  async getCollection(name: string): Promise<any> {
    let collection = this.#collectionCache.get(name)
    if (collection) return collection
    if (!this.#client) await this.connect()
    const metric = this.#opts.metric ?? 'cosine'
    collection = await this.#client.getOrCreateCollection({
      name,
      metadata: { 'hnsw:space': getSpace(metric) },
    })
    this.#collectionCache.set(name, collection)
    return collection
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const name = spec.collection
    if (ifNotExists && (await this.hasCollection(name))) return
    if (await this.hasCollection(name)) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', 'exists'])
    }
    try {
      await this.connect()
      const metric = spec.vector.metric ?? 'cosine'
      await this.#client!.getOrCreateCollection({
        name,
        metadata: { 'hnsw:space': getSpace(metric) },
      })
      this.#collectionCache.set(name, null)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      await this.connect()
      await this.#client!.deleteCollection({ name: collection })
      this.#collectionCache.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    if (!this.#client) await this.connect()
    try {
      const collections = await this.#client!.listCollections()
      for (const c of collections) {
        if (typeof c === 'object' ? c.name === collection : c === collection) {
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  async renameCollection(from: string, to: string): Promise<void> {
    try {
      const collection = await this.getCollection(from)
      await collection.modify({ name: to })
      const cached = this.#collectionCache.get(from)
      this.#collectionCache.delete(from)
      if (cached) {
        this.#collectionCache.set(to, cached)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['renameCollection', String(err)])
    }
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const collection = await this.getCollection(plan.collection)
    const expected = this.#opts.dimensions
    const ids: string[] = []
    const embeddings: number[][] = []
    const documents: string[] = []
    const metadatas: VectorMetadata[] = []

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
      ids.push(r.id)
      embeddings.push(vector)
      documents.push(r.document ?? '')
      const md = { ...(r.metadata ?? {}), internalId: r.id }
      metadatas.push(md)
    }

    try {
      await collection.upsert({ ids, embeddings, documents, metadatas })
    } catch (err) {
      throw new E_VECTOR_STORE_UPSERT_FAILED([String(err)])
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    const collection = await this.getCollection(plan.collection)
    const metric = this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined

    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const res = await collection.get({ ids: [plan.near.id], include: ['embeddings'] })
        if (!res.ids || res.ids.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        const embeddings = res.embeddings || []
        if (!embeddings || embeddings.length === 0 || !embeddings[0]) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id has no vector: ' + plan.near.id])
        }
        queryVector = embeddings[0]
      }
    }

    const where = translateChromaWhere(plan.filter)

    let results: any
    if (queryVector) {
      try {
        results = await collection.query({
          queryEmbeddings: [queryVector],
          nResults: plan.topK,
          where,
          include: ['documents', 'metadatas', 'distances', 'embeddings'],
        })
      } catch (err) {
        throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
      }
    } else {
      try {
        results = await collection.get({
          where,
          limit: plan.topK,
          include: ['documents', 'metadatas', 'embeddings'],
        })
      } catch (err) {
        throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
      }
    }

    const proj = plan.projection
    const out: VectorMatch[] = []
    // `query()` returns per-query nested arrays (`ids: [[...]]`); `get()` (the filter-scan path)
    // returns flat arrays (`ids: [...]`). Unwrap one level only for the query path.
    const unwrap = (col: any): any[] => {
      if (!col) return []
      return queryVector ? (col[0] ?? []) : col
    }
    const ids = unwrap(results.ids)
    const documents = unwrap(results.documents)
    const metadatas = unwrap(results.metadatas)
    const embeddings = unwrap(results.embeddings)
    const distances = unwrap(results.distances)

    const start = plan.offset || 0
    const limit = plan.topK

    for (let i = start; i < Math.min(ids.length, start + limit); i++) {
      const match: VectorMatch = {}
      if (proj.id) {
        match.id = ids[i]
      }
      if (proj.vector && embeddings[i]) {
        match.vector = embeddings[i]
      }
      if (proj.document) {
        match.document = documents[i] ?? undefined
      }
      if (proj.metadata && metadatas[i]) {
        const rawMeta = metadatas[i] as VectorMetadata
        const { internalId, ...rest } = rawMeta
        match.metadata = rest
      }
      if (queryVector && distances && distances[i] !== undefined) {
        match.score = normalizeScore(distances[i], metric, 'distance')
      }
      out.push(match)
    }

    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const collection = await this.getCollection(plan.collection)
    try {
      if (plan.ids) {
        await collection.delete({ ids: plan.ids })
      } else if (plan.filter) {
        const where = translateChromaWhere(plan.filter)
        if (where) {
          await collection.delete({ where })
        } else {
          await collection.delete({ where: {} })
        }
      } else {
        await collection.delete({ where: {} })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
