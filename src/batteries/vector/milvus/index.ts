/**
 * @module @nhtio/adk/batteries/vector/milvus
 */

import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isFilterCondition, isRawFilter, isFilterGroup } from '../filters'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR,
  E_VECTOR_STORE_CONNECTION_FAILED,
} from '../exceptions'
import type { VectorFilter } from '../filters'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type { VectorMatch, VectorStoreCapabilities, BaseVectorStoreOptions } from '../types'

export interface MilvusVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: {
    address?: string
    url?: string
    token?: string
    username?: string
    password?: string
    ssl?: boolean
  }
}

const getMilvusClient = async () => {
  try {
    const mod = await import('@zilliz/milvus2-sdk-node')
    return mod.MilvusClient
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@zilliz/milvus2-sdk-node'])
  }
}

const getDataType = async () => {
  try {
    const mod = await import('@zilliz/milvus2-sdk-node')
    return mod.DataType
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@zilliz/milvus2-sdk-node'])
  }
}

const mapMetricToMilvus = (metric: string): string => {
  if (metric === 'cosine') return 'COSINE'
  if (metric === 'dot') return 'IP'
  if (metric === 'euclidean') return 'L2'
  return 'COSINE'
}

export class MilvusVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: true,
    rawSql: false,
    builtInEncoding: false,
    // Strongly consistent (search/query use consistency_level 'Strong'); the option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }
  #client: any | null = null
  #dims: Map<string, number> = new Map()
  get #opts() {
    return this.options as MilvusVectorStoreOptions
  }
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  async connect(): Promise<void> {
    if (this.#client) return
    const MilvusClient = await getMilvusClient()
    const c = this.#opts.connection || {}
    let address = c.address
    if (!address && c.url) {
      try {
        const url = new URL(c.url)
        const host = url.hostname
        const port = url.port || (url.protocol === 'https:' ? '443' : '19530')
        address = `${host}:${port}`
      } catch {
        throw new E_VECTOR_STORE_CONNECTION_FAILED(['Invalid connection URL'])
      }
    }
    if (!address) {
      address = 'localhost:19530'
    }
    try {
      this.#client = new MilvusClient({
        address,
        token: c.token,
        username: c.username,
        password: c.password,
        ssl: c.ssl,
      })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }
  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.closeConnection?.()
      this.#client = null
    }
  }
  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    const collectionName = spec.collection
    const metric = spec.vector.metric ?? 'cosine'
    const dim = spec.vector.dimensions
    if (ifNotExists && (await this.hasCollection(collectionName))) return
    try {
      const has = await client.hasCollection({ collection_name: collectionName })
      if (has.value && !ifNotExists) {
        throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', 'collection exists'])
      }
      if (has.value && ifNotExists) return
      const DataType = await getDataType()
      await client.createCollection({
        collection_name: collectionName,
        fields: [
          { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 512 },
          { name: 'vector', data_type: DataType.FloatVector, dim },
          { name: 'document', data_type: DataType.VarChar, max_length: 65535 },
          { name: 'metadata', data_type: DataType.JSON },
        ],
      })
      const indexType = 'AUTOINDEX'
      const metricType = mapMetricToMilvus(metric)
      await client.createIndex({
        collection_name: collectionName,
        field_name: 'vector',
        index_type: indexType,
        metric_type: metricType,
      })
      await client.loadCollectionSync({ collection_name: collectionName })
      this.#dims.set(collectionName, dim)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }
  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      const has = await client.hasCollection({ collection_name: collection })
      if (!has.value && !ifExists) {
        throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', 'collection does not exist'])
      }
      await client.dropCollection({ collection_name: collection })
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }
  async hasCollection(collection: string): Promise<boolean> {
    const client = this.#client || (await this.connect(), this.#client!)
    try {
      const r = await client.hasCollection({ collection_name: collection })
      return !!r.value
    } catch {
      return false
    }
  }
  async renameCollection(from: string, to: string): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    try {
      await client.renameCollection({ old_collection_name: from, new_collection_name: to })
      if (this.#dims.has(from)) {
        this.#dims.set(to, this.#dims.get(from)!)
        this.#dims.delete(from)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['renameCollection', String(err)])
    }
  }
  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const client = this.#client || (await this.connect(), this.#client!)
    const collectionName = plan.collection
    const dim = this.#dims.get(collectionName)
    const rows: any[] = []
    for (const r of plan.records) {
      let vector = r.vector
      if (!vector && r.document) {
        const [v] = await this.encode([r.document], 'document')
        vector = v
      }
      if (!vector) {
        throw new E_VECTOR_STORE_UPSERT_FAILED(['Record missing vector and document'])
      }
      if (dim !== undefined && vector.length !== dim) {
        throw new E_VECTOR_STORE_DIMENSION_MISMATCH([dim, vector.length])
      }
      rows.push({
        id: r.id,
        vector,
        document: r.document ?? '',
        metadata: r.metadata ?? {},
      })
    }
    try {
      await client.upsert({ collection_name: collectionName, data: rows })
      await client.flushSync({ collection_names: [collectionName] })
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
        const res = await client.query({
          collection_name: plan.collection,
          filter: `id == "${plan.near.id}"`,
          output_fields: ['vector'],
        })
        if (res.data.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = res.data[0].vector as number[]
      }
    }
    const outputFields = ['id', 'document', 'metadata']
    if (plan.projection.vector) {
      outputFields.push('vector')
    }
    const milvusFilter = translateMilvusFilter(plan.filter)
    let results: any
    if (queryVector) {
      results = await client.search({
        collection_name: plan.collection,
        data: [queryVector],
        limit: plan.topK,
        offset: plan.offset,
        filter: milvusFilter,
        output_fields: outputFields,
        consistency_level: 'Strong',
      })
    } else {
      results = await client.query({
        collection_name: plan.collection,
        filter: milvusFilter || '',
        limit: plan.topK,
        offset: plan.offset,
        output_fields: outputFields,
        consistency_level: 'Strong',
      })
    }
    const hitList = results.results || results.data || []
    const proj = plan.projection
    return hitList.map((hit: any) => this.projectHit(hit, proj, metric))
  }
  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = this.#client || (await this.connect(), this.#client!)
    try {
      const collectionName = plan.collection
      if (plan.ids) {
        const filter = `id in [${plan.ids.map((i) => JSON.stringify(i)).join(',')}]`
        await client.delete({ collection_name: collectionName, filter })
      } else if (plan.filter) {
        const filter = translateMilvusFilter(plan.filter)
        await client.delete({ collection_name: collectionName, filter })
      } else {
        await client.delete({ collection_name: collectionName, filter: 'id != ""' })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
  projectHit(hit: any, projection: any, metric: string): VectorMatch {
    const out: VectorMatch = {}
    if (projection.id) {
      out.id = hit.id
    }
    if (projection.vector && 'vector' in hit) {
      out.vector = hit.vector
    }
    if (projection.document) {
      out.document = hit.document
    }
    if (projection.metadata) {
      out.metadata = hit.metadata
    }
    if ('score' in hit && hit.score !== undefined) {
      const kind = metric === 'euclidean' ? 'distance' : 'similarity'
      out.score = normalizeScore(hit.score as number, metric as any, kind)
    }
    return out
  }
  translateMilvusFilter(filter?: VectorFilter): string {
    return translateMilvusFilter(filter)
  }
}

export const translateMilvusFilter = (filter?: VectorFilter): string => {
  if (!filter) return ''
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'milvus' && typeof filter.$raw === 'string') {
      return filter.$raw
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['milvus', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    const jsonField = `metadata["${field}"]`
    if (value === undefined) {
      if (op === 'exists') {
        return `exists ${jsonField}`
      }
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['milvus', op])
    }
    const toJsonValue = (v: unknown): string => {
      if (typeof v === 'string') return JSON.stringify(v)
      if (typeof v === 'number' || typeof v === 'boolean') return String(v)
      if (Array.isArray(v)) {
        return `[${v.map(toJsonValue).join(',')}]`
      }
      return JSON.stringify(v)
    }
    if (op === 'eq') return `${jsonField} == ${toJsonValue(value)}`
    if (op === 'ne') return `${jsonField} != ${toJsonValue(value)}`
    if (op === 'gt') return `${jsonField} > ${toJsonValue(value)}`
    if (op === 'gte') return `${jsonField} >= ${toJsonValue(value)}`
    if (op === 'lt') return `${jsonField} < ${toJsonValue(value)}`
    if (op === 'lte') return `${jsonField} <= ${toJsonValue(value)}`
    if (op === 'in') {
      if (!Array.isArray(value)) return ''
      return `${jsonField} in [${value.map(toJsonValue).join(',')}]`
    }
    if (op === 'nin') {
      if (!Array.isArray(value)) return ''
      return `${jsonField} not in [${value.map(toJsonValue).join(',')}]`
    }
    if (op === 'exists') {
      return `exists ${jsonField}`
    }
    if (op === 'contains') {
      return `json_contains(${jsonField}, ${toJsonValue(value)})`
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['milvus', op])
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    const parts: string[] = []
    if (and) {
      const children = and.map((f) => translateMilvusFilter(f)).filter((c) => c !== '')
      if (children.length === 0) return ''
      if (children.length === 1) return children[0]
      parts.push(`(${children.join(' && ')})`)
    }
    if (or) {
      const children = or.map((f) => translateMilvusFilter(f)).filter((c) => c !== '')
      if (children.length === 0) return ''
      if (children.length === 1) return children[0]
      parts.push(`(${children.join(' || ')})`)
    }
    if (not) {
      const child = translateMilvusFilter(not)
      if (child === '') return ''
      parts.push(`!(${child})`)
    }
    if (parts.length === 0) return ''
    if (parts.length === 1) return parts[0]
    return parts.join(' && ')
  }
  return ''
}
