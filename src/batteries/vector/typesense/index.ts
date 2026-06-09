/**
 * @module @nhtio/adk/batteries/vector/typesense
 *
 * Typesense adapter. Each collection is a Typesense collection with a `float[]` vector field
 * (native `vector_query` KNN). Metadata is stored as a JSON string field and filtered with
 * the neutral filter tree's JS reference evaluator for exact cross-adapter parity (Typesense
 * filter_by requires per-field schema declaration, which the neutral metadata model doesn't
 * have). Document + id are plain fields.
 *
 * Driver: `typesense` (pure JS).
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

export interface TypesenseVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection?: {
    host?: string
    port?: number
    protocol?: string
    apiKey?: string
    url?: string
  }
}

const getTypesense = async () => {
  try {
    const mod = await import('typesense')
    return (mod as any).default ?? mod
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['typesense'])
  }
}

export class TypesenseVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Typesense indexes writes synchronously (searchable on resolve). The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): TypesenseVectorStoreOptions {
    return this.options as TypesenseVectorStoreOptions
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
    const Typesense = await getTypesense()
    const c = this.#opts.connection || {}
    let node: any
    if (c.url) {
      const u = new URL(c.url)
      node = {
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'https:' ? 443 : 8108),
        protocol: u.protocol.replace(':', ''),
      }
    } else {
      node = { host: c.host ?? 'localhost', port: c.port ?? 8108, protocol: c.protocol ?? 'http' }
    }
    try {
      this.#client = new Typesense.Client({
        nodes: [node],
        apiKey: c.apiKey ?? 'xyz',
        connectionTimeoutSeconds: 5,
      })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    this.#client = null
  }

  async #ensure(): Promise<any> {
    if (!this.#client) await this.connect()
    return this.#client!
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    if (ifNotExists && (await this.hasCollection(spec.collection))) return
    try {
      await client.collections().create({
        name: spec.collection,
        fields: [
          { name: 'id', type: 'string' },
          { name: 'vec', type: 'float[]', num_dim: spec.vector.dimensions },
          { name: 'document', type: 'string', optional: true },
          { name: 'metadata', type: 'string', optional: true },
        ],
      })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = await this.#ensure()
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      await client.collections(collection).delete()
      this.#dims.delete(collection)
    } catch (err) {
      const msg = String(err)
      if (ifExists && msg.includes('Not Found')) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const client = await this.#ensure()
    try {
      await client.collections(collection).retrieve()
      return true
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'typesense'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const client = await this.#ensure()
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    try {
      const docs: any[] = []
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
        docs.push({
          id: r.id,
          vec: vector,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
        })
      }
      await client.collections(plan.collection).documents().import(docs, { action: 'upsert' })
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
    const client = await this.#ensure()
    const metric = this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        try {
          const doc = await client.collections(plan.collection).documents(plan.near.id).retrieve()
          queryVector = doc.vec as number[]
        } catch {
          queryVector = undefined
        }
        if (!queryVector) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
      }
    }

    const offset = plan.offset ?? 0
    try {
      const coll = client.collections(plan.collection).documents()
      if (queryVector) {
        // Over-fetch then JS-filter for exact cross-adapter filter semantics.
        const k = Math.max(plan.topK + offset, plan.topK) + (plan.filter ? 250 : 0)
        const res = await coll.search({
          q: '*',
          vector_query: `vec:([${queryVector.join(',')}], k:${k})`,
          per_page: Math.min(250, k),
        })
        const hits = (res.hits ?? []) as any[]
        const mapped = hits.map((hit) => ({
          match: this.#project(hit.document, plan, metric, hit.vector_distance),
          meta: this.#parseMeta(hit.document.metadata),
        }))
        const filtered = plan.filter
          ? mapped.filter((m) => evaluateFilter(plan.filter!, m.meta))
          : mapped
        return filtered.slice(offset, offset + plan.topK).map((m) => m.match)
      } else {
        const res = await coll.search({ q: '*', query_by: 'document', per_page: 250 })
        const hits = (res.hits ?? []) as any[]
        const mapped = hits.map((hit) => ({
          match: this.#project(hit.document, plan, metric, undefined),
          meta: this.#parseMeta(hit.document.metadata),
        }))
        const filtered = plan.filter
          ? mapped.filter((m) => evaluateFilter(plan.filter!, m.meta))
          : mapped
        return filtered.slice(offset, offset + plan.topK).map((m) => m.match)
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

  #project(doc: any, plan: SearchPlan, metric: string, dist: number | undefined): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = doc.id as string
    if (proj.vector && Array.isArray(doc.vec)) out.vector = doc.vec as number[]
    if (proj.document) out.document = (doc.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(doc.metadata)
    if (dist !== undefined && dist !== null) {
      out.score = normalizeScore(Number(dist), metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = await this.#ensure()
    const collection = client.collections(plan.collection)
    const coll = collection.documents()
    // Delete a single document by id: documents(id).delete() (NOT documents().delete(id),
    // which targets the bulk filter endpoint).
    const deleteOne = async (id: string): Promise<void> => {
      await collection
        .documents(id)
        .delete()
        .catch(() => undefined)
    }
    try {
      if (plan.ids && plan.ids.length > 0) {
        for (const id of plan.ids) await deleteOne(id)
      } else if (plan.filter) {
        // Resolve ids via a scan + JS evaluator, then delete by id.
        const res = await coll.search({ q: '*', query_by: 'document', per_page: 250 })
        const hits = (res.hits ?? []) as any[]
        const targets = hits
          .filter((hit) => evaluateFilter(plan.filter!, this.#parseMeta(hit.document.metadata)))
          .map((hit) => hit.document.id as string)
        for (const id of targets) await deleteOne(id)
      } else {
        // Delete-all: bulk delete by an always-true filter; fall back to per-id on error.
        try {
          await coll.delete({ filter_by: 'id:!= ' })
        } catch {
          const res = await coll.search({ q: '*', query_by: 'document', per_page: 250 })
          const hits = (res.hits ?? []) as any[]
          for (const hit of hits) await deleteOne(hit.document.id as string)
        }
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
