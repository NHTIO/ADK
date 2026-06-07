/**
 * @module @nhtio/adk/batteries/vector/elasticsearch
 *
 * Elasticsearch 8 adapter — each collection is an index with a `dense_vector` field; KNN uses ES8's
 * top-level `knn` search clause with an optional `filter`; the neutral filter tree compiles to bool/term/range
 * over `metadata.*`. Distinct from the opensearch adapter (which speaks OpenSearch's `knn_vector`/`query.knn` dialect).
 */

import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import { isFilterCondition, isRawFilter, isFilterGroup } from '../filters'
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
  VectorStoreCapabilities,
  BaseVectorStoreOptions,
  VectorMetadata,
  DistanceMetric,
} from '../types'

export interface ElasticsearchVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: {
    node?: string // default 'http://localhost:9200'
    auth?: { username: string; password: string } | { apiKey: string }
    client?: unknown // BYO @elastic/elasticsearch Client; overrides node
  }
}

const getElasticsearchClient = async () => {
  try {
    const mod = await import('@elastic/elasticsearch')
    return mod.Client
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@elastic/elasticsearch'])
  }
}

// Elasticsearch similarity per metric.
const similarity = (metric: DistanceMetric): string =>
  metric === 'cosine' ? 'cosine' : metric === 'dot' ? 'dot_product' : 'l2_norm'

/**
 * Compile the neutral filter tree to an Elasticsearch bool-query clause over `metadata.*`.
 * String values use the `.keyword` sub-field for exact match; numbers use range/term.
 */
export const translateElasticsearchFilter = (
  filter?: VectorFilter
): Record<string, unknown> | undefined => {
  if (!filter) return undefined
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'elasticsearch' || filter.$dialect === 'opensearch') {
      return filter.$raw as Record<string, unknown>
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['elasticsearch', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    const f = `metadata.${field}`
    const kw = `metadata.${field}.keyword`
    const term = (v: unknown) =>
      typeof v === 'number' || typeof v === 'boolean' ? { term: { [f]: v } } : { term: { [kw]: v } }
    switch (op) {
      case 'eq':
        return term(value)
      case 'ne':
        return { bool: { must_not: [term(value)] } }
      case 'gt':
        return { range: { [f]: { gt: value } } }
      case 'gte':
        return { range: { [f]: { gte: value } } }
      case 'lt':
        return { range: { [f]: { lt: value } } }
      case 'lte':
        return { range: { [f]: { lte: value } } }
      case 'in': {
        const arr = Array.isArray(value) ? value : [value]
        const allNum = arr.every((v) => typeof v === 'number' || typeof v === 'boolean')
        return { terms: { [allNum ? f : kw]: arr } }
      }
      case 'nin': {
        const arr = Array.isArray(value) ? value : [value]
        const allNum = arr.every((v) => typeof v === 'number' || typeof v === 'boolean')
        return { bool: { must_not: [{ terms: { [allNum ? f : kw]: arr } }] } }
      }
      case 'exists':
        return { exists: { field: f } }
      default:
        throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['elasticsearch', op])
    }
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and) {
      const must = and.map(translateElasticsearchFilter).filter(Boolean)
      return { bool: { must } }
    }
    if (or) {
      const should = or.map(translateElasticsearchFilter).filter(Boolean)
      return { bool: { should, minimum_should_match: 1 } }
    }
    if (not) {
      const inner = translateElasticsearchFilter(not)
      return inner ? { bool: { must_not: [inner] } } : undefined
    }
  }
  return undefined
}

export class ElasticsearchVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Made strongly consistent by refreshing the index after every write (refresh: true /
    // explicit _refresh), so a write is visible to the next search. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): ElasticsearchVectorStoreOptions {
    return this.options as ElasticsearchVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#client) return
    const c = this.#opts.connection || {}
    if (c.client) {
      this.#client = c.client
      return
    }
    const Client = await getElasticsearchClient()
    try {
      this.#client = new Client({ node: c.node ?? 'http://localhost:9200', auth: c.auth })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (
      this.#client &&
      typeof this.#client.close === 'function' &&
      !this.#opts.connection?.client
    ) {
      await this.#client.close()
    }
    this.#client = null
  }

  async #ensure(): Promise<any> {
    if (!this.#client) await this.connect()
    return this.#client!
  }

  // Unwrap the {body}/direct response shape across client versions.
  #body(res: any): any {
    return res && res.body !== undefined ? res.body : res
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    if (ifNotExists && (await this.hasCollection(spec.collection))) return
    try {
      await client.indices.create({
        index: spec.collection,
        mappings: {
          properties: {
            vec: {
              type: 'dense_vector',
              dims: spec.vector.dimensions,
              index: true,
              similarity: similarity(spec.vector.metric),
            },
            document: { type: 'text' },
            metadata: { type: 'object', enabled: true },
          },
        },
      })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = await this.#ensure()
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      await client.indices.delete({ index: collection })
      this.#dims.delete(collection)
    } catch (err) {
      const msg = String(err)
      if (ifExists && msg.includes('index_not_found')) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const client = await this.#ensure()
    try {
      const res = await client.indices.exists({ index: collection })
      const body = this.#body(res)
      return body === true || body === 200 || res?.statusCode === 200
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'elasticsearch'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const client = await this.#ensure()
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    try {
      const operations: any[] = []
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
        operations.push({ index: { _index: plan.collection, _id: r.id } })
        operations.push({ vec: vector, document: r.document ?? '', metadata: r.metadata ?? {} })
      }
      await client.bulk({ operations, refresh: true })
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
          const res = await client.get({ index: plan.collection, id: plan.near.id })
          queryVector = this.#body(res)?._source?.vec as number[]
        } catch {
          queryVector = undefined
        }
        if (!queryVector) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
      }
    }

    const filter = translateElasticsearchFilter(plan.filter)
    const size = plan.topK
    const from = plan.offset ?? 0
    try {
      let res: any
      if (queryVector) {
        const knn: any = {
          field: 'vec',
          query_vector: queryVector,
          k: size + from,
          num_candidates: Math.max((size + from) * 10, 100),
        }
        if (filter) knn.filter = filter
        res = await client.search({ index: plan.collection, knn, size, from, _source: true })
      } else {
        res = await client.search({
          index: plan.collection,
          size,
          from,
          query: filter ?? { match_all: {} },
        })
      }
      const hits = this.#body(res)?.hits?.hits ?? []
      return hits.map((hit: any) => this.#project(hit, plan, metric, !!queryVector))
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #project(hit: any, plan: SearchPlan, metric: string, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const src = hit._source ?? {}
    const out: VectorMatch = {}
    if (proj.id) out.id = hit._id as string
    if (proj.vector && src.vec) out.vector = src.vec as number[]
    if (proj.document) out.document = src.document as string | undefined
    if (proj.metadata) out.metadata = (src.metadata ?? {}) as VectorMetadata
    if (isKnn && typeof hit._score === 'number') {
      // Elasticsearch cosine _score is already (sim+1)/2 ∈ [0,1]; normalize defensively to [0,1].
      out.score = normalizeScore(hit._score, metric as DistanceMetric, 'similarity')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = await this.#ensure()
    try {
      if (plan.ids && plan.ids.length > 0) {
        const operations = plan.ids.map((id) => ({ delete: { _index: plan.collection, _id: id } }))
        await client.bulk({ operations, refresh: true })
      } else if (plan.filter) {
        const filter = translateElasticsearchFilter(plan.filter)
        await client.deleteByQuery({
          index: plan.collection,
          refresh: true,
          query: filter ?? { match_all: {} },
        })
      } else {
        await client.deleteByQuery({
          index: plan.collection,
          refresh: true,
          query: { match_all: {} },
        })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
