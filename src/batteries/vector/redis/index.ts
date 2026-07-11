/**
 * @module @nhtio/adk/batteries/vector/redis
 *
 * One adapter for the whole Redis/Valkey family. The vector engine is RediSearch
 * (`FT.CREATE` / `FT.SEARCH` with a `VECTOR` field over a HASH keyspace); records are
 * stored as Redis hashes keyed `${collection}:${id}`, with the vector packed as a
 * little-endian Float32 buffer. Metadata scalars are stored as TAG/NUMERIC fields so the
 * neutral filter tree compiles to RediSearch query syntax.
 *
 * Works against `redis/redis-stack-server` (bundles RediSearch) and any Redis/Valkey with
 * the RediSearch module loaded.
 */

import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
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
  E_VECTOR_STORE_CONNECTION_FAILED,
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

export interface RedisVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection?: { url?: string; username?: string; password?: string }
}

const getRedisClient = async () => {
  try {
    const mod = await import('redis')
    return mod.createClient
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['redis'])
  }
}

// RediSearch index name + key prefix derived from the logical collection.
const indexName = (collection: string): string => `idx:${collection}`
const keyPrefix = (collection: string): string => `${collection}:`
const keyFor = (collection: string, id: string): string => `${collection}:${id}`

// Pack a number[] into a little-endian Float32 Buffer (RediSearch FLOAT32 vector blob).
const packVector = (vector: number[]): Buffer => {
  const buf = Buffer.allocUnsafe(vector.length * 4)
  for (let i = 0; i < vector.length; i++) buf.writeFloatLE(vector[i], i * 4)
  return buf
}

const unpackVector = (buf: Buffer): number[] => {
  const out: number[] = []
  for (let i = 0; i < buf.length; i += 4) out.push(buf.readFloatLE(i))
  return out
}

// RediSearch distance metric for the index. Cosine + L2 are native; 'dot' maps to IP.
const metricToRedis = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'L2' : metric === 'dot' ? 'IP' : 'COSINE'

// Escape a value for a RediSearch TAG filter (`@field:{value}`). Special chars must be escaped.
const escapeTag = (value: string): string =>
  value.replace(/[,.<>{}[\]"':;!@#$%^&*()\-+=~|/\\ ]/g, '\\$&')

/**
 * Compile the neutral filter tree to a RediSearch query fragment. TAG fields hold string /
 * boolean metadata; NUMERIC fields hold numbers. Returns a fragment to AND with the KNN
 * clause (or to use alone for a filter-scan). Throws on operators RediSearch can't express.
 */
export const translateRedisFilter = (filter?: VectorFilter): string => {
  if (!filter) return '*'
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'redis' && typeof filter.$raw === 'string') {
      return filter.$raw
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['redis', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    const tag = (v: unknown): string => `@${field}:{${escapeTag(String(v))}}`
    const num = (lo: string, hi: string): string => `@${field}:[${lo} ${hi}]`
    // Range bounds must be finite numbers — a non-numeric value would be concatenated
    // raw into the query fragment, letting it break out of the `[lo hi]` bracket.
    const bound = (v: unknown): string => {
      const n = Number(v)
      if (!Number.isFinite(n)) {
        throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR([
          'redis',
          `${op} with non-numeric value`,
        ])
      }
      return String(n)
    }
    switch (op) {
      case 'eq':
        return typeof value === 'number' ? num(bound(value), bound(value)) : tag(value)
      case 'ne':
        return typeof value === 'number' ? `-${num(bound(value), bound(value))}` : `-${tag(value)}`
      case 'gt':
        return num(`(${bound(value)}`, '+inf')
      case 'gte':
        return num(bound(value), '+inf')
      case 'lt':
        return num('-inf', `(${bound(value)}`)
      case 'lte':
        return num('-inf', bound(value))
      case 'in': {
        if (!Array.isArray(value) || value.length === 0) return '@__never:{__never}'
        return `@${field}:{${value.map((v) => escapeTag(String(v))).join('|')}}`
      }
      case 'nin': {
        if (!Array.isArray(value) || value.length === 0) return '*'
        return `-@${field}:{${value.map((v) => escapeTag(String(v))).join('|')}}`
      }
      case 'exists':
        return `@${field}:*`
      default:
        throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['redis', op])
    }
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and) {
      const parts = and.map(translateRedisFilter).filter((p) => p !== '*')
      return parts.length === 0 ? '*' : `(${parts.join(' ')})`
    }
    if (or) {
      const parts = or.map(translateRedisFilter).filter((p) => p !== '*')
      return parts.length === 0 ? '*' : `(${parts.join(' | ')})`
    }
    if (not) {
      const inner = translateRedisFilter(not)
      return inner === '*' ? '*' : `-${inner}`
    }
    return '*'
  }
  return '*'
}

export class RedisVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // RediSearch indexes synchronously on HSET; a write is visible on resolve. No-op option.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }
  #client: any | null = null
  // Per-collection declared metadata fields, so FT.CREATE can declare TAG/NUMERIC schema.
  #fields: Map<string, CollectionSpec['fields']> = new Map()

  get #opts(): RedisVectorStoreOptions {
    return this.options as RedisVectorStoreOptions
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
    const createClient = await getRedisClient()
    const c = this.#opts.connection || {}
    try {
      this.#client = createClient({
        url: c.url ?? 'redis://localhost:6379',
        username: c.username,
        password: c.password,
      })
      await this.#client.connect()
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#client) {
      try {
        await this.#client.quit()
      } catch {
        // ignore quit errors on teardown
      }
      this.#client = null
    }
  }

  async #ensure(): Promise<any> {
    if (!this.#client) await this.connect()
    return this.#client!
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = await this.#ensure()
    this.#fields.set(spec.collection, spec.fields)
    if (ifNotExists && (await this.hasCollection(spec.collection))) return
    const dim = spec.vector.dimensions
    const distance = metricToRedis(spec.vector.metric)
    // Build the FT.CREATE schema: the vector field + a TAG/NUMERIC field per declared payload
    // column. Declared fields are advisory; undeclared metadata is still stored on the hash
    // (just not independently filterable).
    const schema: string[] = [
      '__vector',
      'VECTOR',
      'FLAT',
      '6',
      'TYPE',
      'FLOAT32',
      'DIM',
      String(dim),
      'DISTANCE_METRIC',
      distance,
    ]
    for (const f of spec.fields) {
      schema.push(f.name)
      schema.push(f.type === 'integer' || f.type === 'number' ? 'NUMERIC' : 'TAG')
    }
    try {
      await client.sendCommand([
        'FT.CREATE',
        indexName(spec.collection),
        'ON',
        'HASH',
        'PREFIX',
        '1',
        keyPrefix(spec.collection),
        'SCHEMA',
        ...schema,
      ])
    } catch (err) {
      const msg = String(err)
      if (msg.includes('Index already exists')) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', msg])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = await this.#ensure()
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      // DD drops the indexed documents too.
      await client.sendCommand(['FT.DROPINDEX', indexName(collection), 'DD'])
    } catch (err) {
      const msg = String(err)
      if (ifExists && msg.includes('Unknown')) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const client = await this.#ensure()
    try {
      await client.sendCommand(['FT.INFO', indexName(collection)])
      return true
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'redis'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const client = await this.#ensure()
    const expected = this.#opts.dimensions
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
        // Hash fields: the vector blob, the document, and each metadata scalar (stringified
        // for TAG, numeric kept as-is). __id/__document are reserved internal fields.
        const blob = packVector(vector)
        const entries: Record<string, string | Buffer> = {
          // Raw FLOAT32 blob for RediSearch to index on...
          __vector: blob,
          // ...plus a base64 copy so the vector survives a plain (string) hGetAll read-back
          // (node-redis v6's buffer-mode read API is version-fragile; base64 is portable).
          __vecb64: blob.toString('base64'),
          __id: r.id,
        }
        if (r.document !== undefined) entries.__document = r.document
        if (r.metadata) {
          for (const [k, v] of Object.entries(sanitizeMetadata(r.metadata))) {
            if (v === null || v === undefined) continue
            entries[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
          }
        }
        await client.hSet(keyFor(plan.collection, r.id), entries)
      }
    } catch (err) {
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_DIMENSION_MISMATCH', E_VECTOR_STORE_DIMENSION_MISMATCH) ||
        isInstanceOf(err, 'E_VECTOR_STORE_UPSERT_FAILED', E_VECTOR_STORE_UPSERT_FAILED)
      )
        throw err
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
        const raw = await client.hGetAll(keyFor(plan.collection, plan.near.id))
        const b64 = raw?.__vecb64
        if (!b64) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = unpackVector(Buffer.from(String(b64), 'base64'))
      }
    }

    try {
      if (queryVector) {
        const filterFrag = translateRedisFilter(plan.filter)
        const k = plan.topK + (plan.offset ?? 0)
        const query = `(${filterFrag})=>[KNN ${k} @__vector $BLOB AS __score]`
        const reply: any = await client.sendCommand([
          'FT.SEARCH',
          indexName(plan.collection),
          query,
          'PARAMS',
          '2',
          'BLOB',
          packVector(queryVector),
          'SORTBY',
          '__score',
          'DIALECT',
          '2',
          'LIMIT',
          String(plan.offset ?? 0),
          String(plan.topK),
          'RETURN',
          '1',
          '__score',
        ])
        return await this.#materialize(client, reply, plan, metric, true)
      } else {
        // Filter-scan: FT.SEARCH with the filter fragment, no KNN.
        const filterFrag = translateRedisFilter(plan.filter)
        const reply: any = await client.sendCommand([
          'FT.SEARCH',
          indexName(plan.collection),
          filterFrag,
          'DIALECT',
          '2',
          'LIMIT',
          String(plan.offset ?? 0),
          String(plan.topK),
          'NOCONTENT',
        ])
        return await this.#materialize(client, reply, plan, metric, false)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  // Parse a node-redis v6 FT.SEARCH reply (structured object OR legacy flat array) into
  // [{ key, score? }] pairs. Score is read from extra_attributes.__score on KNN searches.
  #parseSearchReply(reply: any): Array<{ key: string; score?: number }> {
    // node-redis v6 returns { total_results, results: [{ id, extra_attributes }] }
    if (reply && typeof reply === 'object' && Array.isArray(reply.results)) {
      return reply.results.map((r: any) => ({
        key: String(r.id),
        score:
          r.extra_attributes && r.extra_attributes.__score !== undefined
            ? Number(r.extra_attributes.__score)
            : undefined,
      }))
    }
    // Legacy flat array reply: [total, key, key, ...]
    if (Array.isArray(reply)) {
      return reply.filter((_: unknown, i: number) => i > 0).map((k: any) => ({ key: String(k) }))
    }
    return []
  }

  // Parse the FT.SEARCH reply for keys (+ KNN score), then re-fetch each hash as buffers to
  // project. Re-fetching keeps the vector blob intact (RediSearch's per-field reply mangles it).
  async #materialize(
    client: any,
    reply: any,
    plan: SearchPlan,
    metric: string,
    isKnn: boolean
  ): Promise<VectorMatch[]> {
    const hits = this.#parseSearchReply(reply)
    const out: VectorMatch[] = []
    for (const hit of hits) {
      const raw = await client.hGetAll(hit.key)
      if (!raw) continue
      out.push(this.#project(raw, plan, metric, isKnn, hit.score))
    }
    return out
  }

  #decode(buf: unknown): string | undefined {
    if (buf === undefined || buf === null) return undefined
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
  }

  #project(
    raw: Record<string, unknown>,
    plan: SearchPlan,
    metric: string,
    isKnn: boolean,
    rawScore?: number
  ): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = this.#decode(raw.__id)
    if (proj.vector && raw.__vecb64) {
      out.vector = unpackVector(Buffer.from(String(this.#decode(raw.__vecb64)), 'base64'))
    }
    if (proj.document) out.document = this.#decode(raw.__document)
    if (proj.metadata) {
      const meta: VectorMetadata = {}
      const reserved = new Set(['__vector', '__vecb64', '__id', '__document', '__score'])
      for (const [k, v] of Object.entries(raw)) {
        if (reserved.has(k)) continue
        meta[k] = this.#decode(v) as string
      }
      out.metadata = meta
    }
    if (isKnn && rawScore !== undefined) {
      // RediSearch returns the raw distance for the metric; normalize to [0,1] higher-is-better.
      out.score = normalizeScore(rawScore, metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = await this.#ensure()
    try {
      if (plan.ids && plan.ids.length > 0) {
        await client.del(plan.ids.map((id) => keyFor(plan.collection, id)))
      } else if (plan.filter) {
        // Resolve ids via a filter-scan, then delete the hashes.
        const filterFrag = translateRedisFilter(plan.filter)
        const reply: any = await client.sendCommand([
          'FT.SEARCH',
          indexName(plan.collection),
          filterFrag,
          'DIALECT',
          '2',
          'LIMIT',
          '0',
          '10000',
          'NOCONTENT',
        ])
        const keys = this.#parseSearchReply(reply).map((h) => h.key)
        if (keys.length > 0) await client.del(keys)
      } else {
        // Delete-all: drop every hash under the prefix via the index.
        const reply: any = await client.sendCommand([
          'FT.SEARCH',
          indexName(plan.collection),
          '*',
          'DIALECT',
          '2',
          'LIMIT',
          '0',
          '10000',
          'NOCONTENT',
        ])
        const keys = this.#parseSearchReply(reply).map((h) => h.key)
        if (keys.length > 0) await client.del(keys)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
