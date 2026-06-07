/**
 * @module @nhtio/adk/batteries/vector/weaviate
 *
 * @remarks
 * Weaviate-backed vector store adapter using the Weaviate v3 client with lazy driver
 * loading, deterministic object UUIDs, explicit vectors, and in-JS metadata filtering.
 */

import { sha256 } from 'js-sha256'
import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import { evaluateFilter, isRawFilter, isFilterCondition, isFilterGroup } from '../filters'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_CONNECTION_FAILED,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_OPERATION,
  E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR,
} from '../exceptions'
import type { VectorFilter } from '../filters'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type {
  VectorMatch,
  VectorMetadata,
  VectorStoreCapabilities,
  BaseVectorStoreOptions,
} from '../types'

/**
 * Connection options for {@link WeaviateVectorStore}.
 */
export interface WeaviateVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: {
    url?: string
    host?: string
    port?: number
    grpcHost?: string
    grpcPort?: number
    apiKey?: string
    secure?: boolean
    grpcSecure?: boolean
  }
}

/**
 * Compiles a neutral {@link VectorFilter} into a Weaviate v3 filter built from a collection's
 * `col.filter` builder (and `weaviate.Filters.and/or` for groups). Pure and dependency-injected
 * (takes the `col` handle and the `weaviate` module), so it is unit-testable with stubs.
 *
 * @throws {@link @nhtio/adk/batteries/vector/exceptions!E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR}
 *   for operators Weaviate cannot express (`nin`, group `not`) or a non-`weaviate` raw dialect.
 */
export const translateWeaviateFilter = (col: any, weaviate: any, filter?: VectorFilter): any => {
  if (!filter) return undefined
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'weaviate') return filter.$raw
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['weaviate', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    if (value === undefined && op !== 'exists') {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['weaviate', op])
    }
    const f = col.filter.byProperty(field)
    if (op === 'eq') return f.equal(value)
    if (op === 'ne') return f.notEqual(value)
    if (op === 'gt') return f.greaterThan(value)
    if (op === 'gte') return f.greaterOrEqual(value)
    if (op === 'lt') return f.lessThan(value)
    if (op === 'lte') return f.lessOrEqual(value)
    if (op === 'in') return f.containsAny(value)
    if (op === 'nin') throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['weaviate', 'nin'])
    if (op === 'exists') return f.isNull(value === false)
    if (op === 'contains') return f.containsAny(Array.isArray(value) ? value : [value])
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['weaviate', op])
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and) {
      const children = and
        .map((c: VectorFilter) => translateWeaviateFilter(col, weaviate, c))
        .filter((x: any) => x !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return weaviate.Filters.and(...children)
    }
    if (or) {
      const children = or
        .map((c: VectorFilter) => translateWeaviateFilter(col, weaviate, c))
        .filter((x: any) => x !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return weaviate.Filters.or(...children)
    }
    if (not) throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['weaviate', 'not'])
    return undefined
  }
  return undefined
}

/**
 * Weaviate-backed {@link @nhtio/adk/batteries/vector/contract!VectorStore}. Node-only.
 *
 * @remarks
 * Stores ids/documents/metadata as explicit object properties and all metadata filtering is
 * evaluated in JavaScript for portable behavior across Weaviate schema/index settings.
 */
export class WeaviateVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: true,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Single-node Weaviate is strongly consistent on resolve; the option is a no-op here.
    // (A future multi-node adapter variant would set configurable:true.)
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any = null
  #weaviate: any = null
  #dims = new Map<string, number>()

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#client) return
    let weaviate: any
    try {
      const weaviateMod = await import('weaviate-client')
      weaviate = weaviateMod.default
    } catch {
      throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['weaviate-client'])
    }
    const c = (this.options as WeaviateVectorStoreOptions).connection ?? {}
    let httpHost = c.host ?? 'localhost'
    let httpPort = c.port ?? 8080
    let secure = c.secure
    if (c.url) {
      const u = new URL(c.url)
      httpHost = u.hostname
      httpPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
      secure = u.protocol === 'https:'
    }
    try {
      this.#client = await weaviate.connectToCustom({
        httpHost,
        httpPort,
        httpSecure: !!secure,
        grpcHost: c.grpcHost ?? httpHost,
        grpcPort: c.grpcPort ?? 50051,
        grpcSecure: !!c.grpcSecure,
        headers: c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : undefined,
      })
      this.#weaviate = weaviate
    } catch (e: any) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([e?.message ?? String(e)])
    }
  }

  async close(): Promise<void> {
    await this.#client?.close?.()
    this.#client = null
    this.#weaviate = null
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    await this.connect()
    const c = this.#cls(spec.collection)
    try {
      if (await this.#client.collections.exists(c)) {
        if (ifNotExists) return
        throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', 'collection exists'])
      }
      await this.#client.collections.create({
        name: c,
        vectorizers: this.#weaviate.configure.vectorizer.none(),
        properties: [
          { name: '__id', dataType: 'text' },
          { name: '__document', dataType: 'text' },
          { name: '__metadata', dataType: 'text' },
        ],
      })
      this.#dims.set(spec.collection, spec.vector.dimensions)
    } catch (e: any) {
      if (isInstanceOf(e, 'E_VECTOR_STORE_COLLECTION_FAILED', E_VECTOR_STORE_COLLECTION_FAILED))
        throw e
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', e?.message ?? String(e)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    await this.connect()
    const c = this.#cls(collection)
    try {
      const exists = await this.#client.collections.exists(c)
      if (!exists) {
        if (!ifExists)
          throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', 'collection does not exist'])
        return
      }
      await this.#client.collections.delete(c)
      this.#dims.delete(collection)
    } catch (e: any) {
      if (isInstanceOf(e, 'E_VECTOR_STORE_COLLECTION_FAILED', E_VECTOR_STORE_COLLECTION_FAILED))
        throw e
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', e?.message ?? String(e)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    await this.connect()
    return await this.#client.collections.exists(this.#cls(collection))
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'weaviate'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    await this.connect()
    validateRecords(plan.records)
    const dims = this.#dims.get(plan.collection) ?? this.options.dimensions
    const col = this.#client.collections.get(this.#cls(plan.collection))
    try {
      const objects = []
      for (const r of plan.records) {
        let vector = r.vector
        if (!vector && r.document) {
          const [v] = await this.encode([r.document], 'document')
          vector = v
        }
        if (!vector) throw new E_VECTOR_STORE_UPSERT_FAILED(['Record missing vector and document'])
        if (dims !== undefined && vector.length !== dims) {
          throw new E_VECTOR_STORE_DIMENSION_MISMATCH([dims, vector.length])
        }
        objects.push({
          id: this.#uuidFromId(r.id),
          properties: {
            __id: r.id,
            __document: r.document ?? '',
            __metadata: JSON.stringify(r.metadata ?? {}),
          },
          vectors: vector,
        })
      }
      if (objects.length > 0) await col.data.insertMany(objects)
    } catch (e: any) {
      if (isInstanceOf(e, 'E_VECTOR_STORE_DIMENSION_MISMATCH', E_VECTOR_STORE_DIMENSION_MISMATCH))
        throw e
      if (isInstanceOf(e, 'E_VECTOR_STORE_UPSERT_FAILED', E_VECTOR_STORE_UPSERT_FAILED)) throw e
      throw new E_VECTOR_STORE_UPSERT_FAILED([e?.message ?? String(e)])
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    await this.connect()
    const col = this.#client.collections.get(this.#cls(plan.collection))
    const metric = this.options.metric ?? 'cosine'
    try {
      let qvec: number[] | undefined
      if (plan.near) {
        if ('vector' in plan.near) qvec = plan.near.vector
        else if ('serverText' in plan.near) {
          const [v] = await this.encode([plan.near.serverText], 'query')
          qvec = v
        } else if ('id' in plan.near) {
          const ref = await col.query.fetchObjectById(this.#uuidFromId(plan.near.id), {
            includeVector: true,
          })
          qvec = this.#extractVector(ref?.vectors)
        }
      }
      let res: any
      if (qvec) {
        res = await col.query.nearVector(qvec, {
          limit: (plan.topK + (plan.offset ?? 0)) * 4,
          returnMetadata: ['distance'],
          includeVector: !!plan.projection.vector,
          returnProperties: ['__id', '__document', '__metadata'],
        })
      } else {
        res = await col.query.fetchObjects({
          limit: 10000,
          includeVector: !!plan.projection.vector,
          returnProperties: ['__id', '__document', '__metadata'],
        })
      }
      const filtered = (res.objects ?? []).filter((obj: any) => {
        const metadata = this.#parseMetadata(obj)
        return !plan.filter || evaluateFilter(plan.filter, metadata)
      })
      const start = plan.offset ?? 0
      return filtered
        .slice(start, start + plan.topK)
        .map((obj: any) => this.#project(obj, plan, !!qvec, metric))
    } catch (e: any) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([e?.message ?? String(e)])
    }
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    await this.connect()
    const col = this.#client.collections.get(this.#cls(plan.collection))
    try {
      if (plan.ids && plan.ids.length > 0) {
        for (const id of plan.ids) await col.data.deleteById(this.#uuidFromId(id))
        return
      }
      const res = await col.query.fetchObjects({
        limit: 10000,
        returnProperties: ['__id', '__document', '__metadata'],
      })
      for (const obj of res.objects ?? []) {
        const id = obj.properties?.__id
        if (!id) continue
        if (!plan.filter || evaluateFilter(plan.filter, this.#parseMetadata(obj))) {
          await col.data.deleteById(this.#uuidFromId(id))
        }
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_DELETE_FAILED([e?.message ?? String(e)])
    }
  }

  #cls(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1)
  }

  #uuidFromId(id: string): string {
    const h = sha256(id)
    return (
      h.slice(0, 8) +
      '-' +
      h.slice(8, 12) +
      '-4' +
      h.slice(13, 16) +
      '-8' +
      h.slice(17, 20) +
      '-' +
      h.slice(20, 32)
    )
  }

  #parseMetadata(obj: any): VectorMetadata {
    try {
      return JSON.parse(obj.properties?.__metadata || '{}') as VectorMetadata
    } catch {
      return {}
    }
  }

  #extractVector(vectors: any): number[] | undefined {
    if (Array.isArray(vectors)) return vectors as number[]
    if (vectors?.default) return vectors.default as number[]
    if (vectors && typeof vectors === 'object')
      return Object.values(vectors)[0] as number[] | undefined
    return undefined
  }

  #project(obj: any, plan: SearchPlan, scored: boolean, metric: string): VectorMatch {
    const out: VectorMatch = {}
    const props = obj.properties ?? {}
    if (plan.projection.id) out.id = props.__id
    if (plan.projection.document) out.document = props.__document
    if (plan.projection.metadata) out.metadata = this.#parseMetadata(obj)
    if (plan.projection.vector) out.vector = this.#extractVector(obj.vectors)
    if (scored)
      out.score = normalizeScore(Number(obj.metadata?.distance ?? 0), metric as any, 'distance')
    return out
  }
}
