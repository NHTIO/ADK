/**
 * @module @nhtio/adk/batteries/vector/pgvector
 */

import { normalizeScore } from '../helpers'
import { validateRecords } from '../validation'
import { BaseVectorStore, CallableVectorStore } from '../contract'
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
  E_VECTOR_STORE_UNSUPPORTED_OPERATION,
} from '../exceptions'
import type { VectorFilter } from '../filters'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type { VectorMatch, VectorStoreCapabilities, BaseVectorStoreOptions } from '../types'

interface PgVectorOptions extends BaseVectorStoreOptions {
  connection?:
    | string
    | {
        connectionString?: string
        host?: string
        port?: number
        user?: string
        password?: string
        database?: string
      }
  pool?: any
}

interface PGClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>
  release?: () => void
}

type PoolOrClient = any

const METRIC_TO_OPERATOR: Record<string, { op: string; opclass: string }> = {
  cosine: { op: '<=>', opclass: 'vector_cosine_ops' },
  dot: { op: '<#>', opclass: 'vector_ip_ops' },
  euclidean: { op: '<->', opclass: 'vector_l2_ops' },
}

export const translatePgFilter = (filter: VectorFilter): { sql: string; params: unknown[] } => {
  const params: unknown[] = []

  const walk = (f: VectorFilter): string => {
    if (isFilterCondition(f)) {
      const { field, op, value } = f

      if (op === 'exists') {
        const val = value === undefined || value === true
        return val ? `metadata ? '${field}'` : `NOT (metadata ? '${field}')`
      }

      if (op === 'contains') {
        params.push(JSON.stringify(value))
        return `metadata->>'${field}' @> $${params.length}::jsonb`
      }

      if (op === 'in' || op === 'nin') {
        params.push(Array.isArray(value) ? value : [value])
        const not = op === 'nin' ? 'NOT ' : ''
        return `${not}(metadata->>'${field}' = ANY($${params.length}))`
      }

      if (op === 'eq') {
        params.push(value)
        return `metadata->>'${field}' = $${params.length}`
      }

      if (op === 'ne') {
        params.push(value)
        return `metadata->>'${field}' IS DISTINCT FROM $${params.length}`
      }

      if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
        params.push(Number(value))
        const opMap: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' }
        return `(metadata->>'${field}')::numeric ${opMap[op]} $${params.length}`
      }

      throw new Error(`Unsupported filter operator: ${op}`)
    }

    if (isRawFilter(f)) {
      const { $dialect, $raw, $bindings } = f

      if (typeof $raw === 'string') {
        if ($dialect !== 'sql' && $dialect !== 'pgvector') {
          throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['pgvector', String($dialect)])
        }
      } else if ($raw !== undefined) {
        throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['raw-sql', 'pgvector'])
      }

      const rawStr = typeof $raw === 'string' ? $raw : String($raw)
      const bindingCount = (rawStr.match(/\?/g) || []).length

      if ($bindings && $bindings.length !== bindingCount) {
        throw new Error(
          `Raw fragment placeholder count (${bindingCount}) does not match bindings length (${$bindings?.length || 0})`
        )
      }

      if ($bindings && $bindings.length > 0) {
        for (const $binding of $bindings) {
          params.push($binding)
        }
        return rawStr.replace(/\?/g, () => `$${params.length}`)
      }

      return rawStr
    }

    if (isFilterGroup(f)) {
      const { and, or, not } = f

      if (and !== undefined) {
        const parts: string[] = []
        for (const child of and) {
          parts.push(walk(child))
        }
        return parts.length ? `(${parts.join(' AND ')})` : ''
      }

      if (or !== undefined) {
        const parts: string[] = []
        for (const child of or) {
          parts.push(walk(child))
        }
        return parts.length ? `(${parts.join(' OR ')})` : ''
      }

      if (not !== undefined) {
        return `NOT (${walk(not)})`
      }

      return ''
    }

    return ''
  }

  return { sql: walk(filter), params }
}

export class PgVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: true,
    namedVectors: false,
    rename: true,
    rawSql: true,
    builtInEncoding: false,
    // Strongly consistent: a write is visible on resolve, so the option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #_pool: PoolOrClient | null = null
  #_txClient: PGClient | null = null
  #_externalPool = false

  constructor(options: PgVectorOptions) {
    super(options)
  }

  get #opts(): PgVectorOptions {
    return this.options as PgVectorOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#_pool) {
      return
    }

    let pg: any

    try {
      pg = await import('pg')
    } catch (e) {
      throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['pg'])
    }

    let pool: any

    if (this.#opts.pool) {
      pool = this.#opts.pool
      this.#_externalPool = true
    } else {
      const connectionConfig = this.#opts.connection
      if (typeof connectionConfig === 'string') {
        pool = new pg.Pool({ connectionString: connectionConfig })
      } else if (connectionConfig) {
        pool = new pg.Pool(connectionConfig)
      } else {
        pool = new pg.Pool()
      }
    }

    try {
      await pool.query('SELECT 1')
    } catch (e: any) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([e?.message ?? String(e)])
    }

    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
    } catch (e: any) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([e?.message ?? String(e)])
    }

    this.#_pool = pool
  }

  async close(): Promise<void> {
    if (this.#_txClient) {
      this.#_txClient.release?.()
      this.#_txClient = null
    }

    if (this.#_pool && !this.#_externalPool) {
      await this.#_pool.end()
    }

    this.#_pool = null
    this.#_txClient = null
  }

  get clientOrPool(): PoolOrClient {
    if (this.#_txClient) {
      return this.#_txClient
    }
    if (!this.#_pool) {
      throw new Error('Not connected')
    }
    return this.#_pool
  }

  async ensureConnected(): Promise<void> {
    await this.connect()
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    await this.ensureConnected()
    const { collection, vector } = spec
    const { dimensions, metric } = vector
    const tbl = `"${collection}"`
    const { opclass } = METRIC_TO_OPERATOR[metric]

    const has = await this.hasCollection(collection)
    if (!ifNotExists && has) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', 'collection exists'])
    }

    const createTable = `
      CREATE TABLE IF NOT EXISTS ${tbl} (
        id TEXT PRIMARY KEY,
        embedding vector(${dimensions}),
        document TEXT,
        metadata JSONB
      )
    `
    const createIndex = `
      CREATE INDEX IF NOT EXISTS "${collection}_embedding_idx" ON ${tbl} USING hnsw (embedding ${opclass})
    `

    try {
      await this.#_pool!.query(createTable)
      await this.#_pool!.query(createIndex)
    } catch (e: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', e?.message ?? String(e)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    await this.ensureConnected()
    const tbl = `"${collection}"`

    const has = await this.hasCollection(collection)
    if (!has) {
      if (!ifExists) {
        throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', 'collection does not exist'])
      }
      return
    }

    const dropTbl = `DROP TABLE IF EXISTS ${tbl}`
    try {
      await this.#_pool!.query(dropTbl)
    } catch (e: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', e?.message ?? String(e)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    await this.ensureConnected()
    const check = `SELECT to_regclass($1) IS NOT NULL AS exists`
    try {
      const res = await this.#_pool!.query(check, [collection])
      return res.rows[0]?.exists === true
    } catch {
      return false
    }
  }

  async renameCollection(from: string, to: string): Promise<void> {
    await this.ensureConnected()
    const hasFrom = await this.hasCollection(from)
    if (!hasFrom) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['rename', 'source collection does not exist'])
    }

    const hasTo = await this.hasCollection(to)
    if (hasTo) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['rename', 'target collection already exists'])
    }

    const rename = `ALTER TABLE "${from}" RENAME TO "${to}"`
    try {
      await this.#_pool!.query(rename)
    } catch (e: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['rename', e?.message ?? String(e)])
    }
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    await this.ensureConnected()
    validateRecords(plan.records)

    const collection = plan.collection
    const tbl = `"${collection}"`
    const dims = this.#opts.dimensions

    const resolvedRows: {
      id: string
      vector: number[]
      document?: string
      metadata?: Record<string, unknown>
    }[] = []

    for (const r of plan.records) {
      let vector = r.vector
      if (!vector && r.document) {
        const [v] = await this.encode([r.document], 'document')
        vector = v
      }

      if (vector && dims !== undefined && vector.length !== dims) {
        throw new E_VECTOR_STORE_DIMENSION_MISMATCH([dims, vector.length])
      }

      resolvedRows.push({
        id: r.id,
        vector: vector ?? [],
        document: r.document,
        metadata: r.metadata as Record<string, unknown> | undefined,
      })
    }

    const sql = `
      INSERT INTO ${tbl} (id, embedding, document, metadata)
      VALUES ($1, $2::vector, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        embedding = $2::vector,
        document = $3,
        metadata = $4
    `

    const client = this.clientOrPool
    try {
      for (const r of resolvedRows) {
        const vecStr = '[' + r.vector.join(',') + ']'
        await client.query(sql, [
          r.id,
          vecStr,
          r.document ?? null,
          JSON.stringify(r.metadata ?? {}),
        ])
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_UPSERT_FAILED([e?.message ?? String(e)])
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    await this.ensureConnected()
    const collection = plan.collection
    const tbl = `"${collection}"`
    const metric = this.options.metric ?? 'euclidean'
    const { op } = METRIC_TO_OPERATOR[metric]

    const filterSql = plan.filter
      ? (() => {
          const { sql, params } = translatePgFilter(plan.filter)
          if (sql) {
            return { sql: ` AND ${sql}`, params }
          }
          return { sql: '', params: [] }
        })()
      : { sql: '', params: [] }

    try {
      if (plan.near) {
        let qvec: number[] | undefined

        if ('vector' in plan.near) {
          qvec = plan.near.vector
        } else if ('serverText' in plan.near) {
          const [v] = await this.encode([plan.near.serverText], 'query')
          qvec = v
        } else if ('id' in plan.near) {
          const id = plan.near.id
          const vecRes = await this.#_pool!.query(`SELECT embedding FROM ${tbl} WHERE id = $1`, [
            id,
          ])
          if (vecRes.rows[0]?.embedding) {
            const raw = vecRes.rows[0].embedding
            if (typeof raw === 'string') {
              const stripped = raw.replace(/^\[|\]$/g, '')
              qvec = stripped.split(',').map((n) => Number.parseFloat(n.trim()))
            }
          }
        }

        if (!qvec) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['no query vector provided'])
        }

        const vecStr = '[' + qvec.join(',') + ']'
        const sql = `
          SELECT id, document, metadata, embedding, embedding ${op} $1 AS distance
          FROM ${tbl}
          WHERE 1=1 ${filterSql.sql}
          ORDER BY distance
          LIMIT ${plan.topK} OFFSET ${plan.offset ?? 0}
        `
        const { rows } = await this.#_pool!.query(sql, [vecStr, ...filterSql.params])

        const results: VectorMatch[] = []

        for (const row of rows) {
          let distance = Number(row.distance)

          let score: number | undefined
          if (metric === 'dot') {
            const inner = -distance
            score = normalizeScore(inner, 'dot', 'similarity')
            distance = inner
          } else {
            score = normalizeScore(distance, metric, 'distance')
          }

          const parsedMeta =
            typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata

          const proj: VectorMatch = {}
          if (plan.projection.id) proj.id = row.id
          if (plan.projection.vector) {
            const rawVec = row.embedding
            if (typeof rawVec === 'string') {
              const stripped = rawVec.replace(/^\[|\]$/g, '')
              proj.vector = stripped.split(',').map((n) => Number.parseFloat(n.trim()))
            }
          }
          if (plan.projection.document && row.document !== undefined) proj.document = row.document
          if (plan.projection.metadata && parsedMeta !== undefined) proj.metadata = parsedMeta
          if (score !== undefined) proj.score = score

          results.push(proj)
        }

        return results
      } else {
        const sql = `
          SELECT id, document, metadata, embedding
          FROM ${tbl}
          WHERE 1=1 ${filterSql.sql}
          LIMIT ${plan.topK} OFFSET ${plan.offset ?? 0}
        `
        const { rows } = await this.#_pool!.query(sql, [...filterSql.params])

        const results: VectorMatch[] = []

        for (const row of rows) {
          const parsedMeta =
            typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata

          const proj: VectorMatch = {}
          if (plan.projection.id) proj.id = row.id
          if (plan.projection.vector) {
            const vecRes = await this.#_pool!.query(`SELECT embedding FROM ${tbl} WHERE id = $1`, [
              row.id,
            ])
            if (vecRes.rows[0]?.embedding) {
              const rawVec = vecRes.rows[0].embedding
              if (typeof rawVec === 'string') {
                const stripped = rawVec.replace(/^\[|\]$/g, '')
                proj.vector = stripped.split(',').map((n) => Number.parseFloat(n.trim()))
              }
            }
          }
          if (plan.projection.document && row.document !== undefined) proj.document = row.document
          if (plan.projection.metadata && parsedMeta !== undefined) proj.metadata = parsedMeta

          results.push(proj)
        }

        return results
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([e?.message ?? String(e)])
    }
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    await this.ensureConnected()
    const collection = plan.collection
    const tbl = `"${collection}"`

    try {
      if (plan.ids && plan.ids.length > 0) {
        const sql = `DELETE FROM ${tbl} WHERE id = ANY($1)`
        await this.#_pool!.query(sql, [plan.ids])
      } else if (plan.filter) {
        const { sql, params } = translatePgFilter(plan.filter)
        const whereClause = sql ? ` WHERE ${sql}` : ''
        const delSql = `DELETE FROM ${tbl}${whereClause}`
        await this.#_pool!.query(delSql, params)
      } else {
        await this.#_pool!.query(`TRUNCATE TABLE ${tbl} RESTART IDENTITY`)
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_DELETE_FAILED([e?.message ?? String(e)])
    }
  }

  async transaction(fn: (tx: CallableVectorStore) => Promise<void>): Promise<void> {
    await this.ensureConnected()

    const pool = this.#_pool!
    const client = await pool.connect()

    try {
      await client.query('BEGIN')
      this.#_txClient = client
      await fn(this.asCallable())
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      this.#_txClient = null
      client.release()
    }
  }
}
