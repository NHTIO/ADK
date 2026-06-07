/**
 * @module @nhtio/adk/batteries/vector/mariadb
 *
 * MariaDB adapter (native VECTOR type, 11.7+). Vectors live in a `VECTOR(N)` column written
 * with `VEC_FromText('[...]')` and read with `VEC_ToText(vec)`; KNN uses
 * `VEC_DISTANCE_COSINE` / `VEC_DISTANCE_EUCLIDEAN` ordered ascending. Metadata is a `JSON`
 * column. The neutral filter tree is evaluated with the JS reference evaluator for exact
 * cross-adapter parity. Each collection is a table.
 *
 * Driver: `mariadb` (pure JS, pooled).
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

export interface MariaDBVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: {
    host?: string
    port?: number
    user?: string
    password?: string
    database?: string
    connectionLimit?: number
  }
}

const getMariaDB = async () => {
  try {
    const mod = await import('mariadb')
    return (mod as any).default ?? mod
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['mariadb'])
  }
}

const distanceFn = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'VEC_DISTANCE_EUCLIDEAN' : 'VEC_DISTANCE_COSINE'

// Backtick-quoted identifier.
const ident = (name: string): string => '`' + name.replace(/`/g, '``') + '`'

export class MariaDBVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: true,
    namedVectors: false,
    rename: true,
    rawSql: true,
    builtInEncoding: false,
    // SQL backend, synchronous on commit: a write is visible on resolve. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #pool: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): MariaDBVectorStoreOptions {
    return this.options as MariaDBVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#pool) return
    const mariadb = await getMariaDB()
    const c = this.#opts.connection || {}
    try {
      this.#pool = mariadb.createPool({
        host: c.host ?? 'localhost',
        port: c.port ?? 3306,
        user: c.user ?? 'root',
        password: c.password,
        database: c.database,
        connectionLimit: c.connectionLimit ?? 4,
      })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#pool) {
      await this.#pool.end()
      this.#pool = null
    }
  }

  async #ensure(): Promise<any> {
    if (!this.#pool) await this.connect()
    return this.#pool!
  }

  async #query(sql: string, params?: unknown[]): Promise<any[]> {
    const pool = await this.#ensure()
    return await pool.query(sql, params)
  }

  // VEC_ToText returns "[1,0,0]"; parse into number[].
  #parseVec(text: unknown): number[] {
    if (typeof text !== 'string') return []
    try {
      return JSON.parse(text) as number[]
    } catch {
      return []
    }
  }

  #parseMeta(val: unknown): VectorMetadata {
    if (val === null || val === undefined) return {}
    if (typeof val === 'string') {
      try {
        return JSON.parse(val) as VectorMetadata
      } catch {
        return {}
      }
    }
    if (typeof val === 'object') return val as VectorMetadata
    return {}
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const ine = ifNotExists ? 'IF NOT EXISTS ' : ''
    try {
      await this.#query(
        `CREATE TABLE ${ine}${ident(spec.collection)} (` +
          `id VARCHAR(255) PRIMARY KEY, ` +
          `vec VECTOR(${spec.vector.dimensions}) NOT NULL, ` +
          `document TEXT, ` +
          `metadata JSON, ` +
          `VECTOR INDEX (vec))`
      )
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const ie = ifExists ? 'IF EXISTS ' : ''
    try {
      await this.#query(`DROP TABLE ${ie}${ident(collection)}`)
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const rows = await this.#query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
      [collection]
    )
    return rows.length > 0
  }

  async renameCollection(from: string, to: string): Promise<void> {
    try {
      await this.#query(`RENAME TABLE ${ident(from)} TO ${ident(to)}`)
      const d = this.#dims.get(from)
      if (d !== undefined) {
        this.#dims.set(to, d)
        this.#dims.delete(from)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', String(err)])
    }
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
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
        const vecText = `[${vector.join(',')}]`
        const meta = r.metadata ? JSON.stringify(r.metadata) : '{}'
        await this.#query(
          `INSERT INTO ${ident(plan.collection)} (id, vec, document, metadata) ` +
            `VALUES (?, VEC_FromText(?), ?, ?) ` +
            `ON DUPLICATE KEY UPDATE vec = VEC_FromText(?), document = ?, metadata = ?`,
          [r.id, vecText, r.document ?? '', meta, vecText, r.document ?? '', meta]
        )
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
    const metric = this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const rows = await this.#query(
          `SELECT VEC_ToText(vec) vec FROM ${ident(plan.collection)} WHERE id = ?`,
          [plan.near.id]
        )
        if (rows.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = this.#parseVec(rows[0].vec)
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        const fn = distanceFn(metric)
        const vecText = `[${queryVector.join(',')}]`
        const rows = await this.#query(
          `SELECT id, VEC_ToText(vec) vec, document, metadata, ` +
            `${fn}(vec, VEC_FromText(?)) __dist FROM ${ident(plan.collection)}`,
          [vecText]
        )
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        filtered.sort((a, b) => Number(a.__dist) - Number(b.__dist))
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, metric, true))
      } else {
        const rows = await this.#query(
          `SELECT id, VEC_ToText(vec) vec, document, metadata FROM ${ident(plan.collection)}`
        )
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, metric, false))
      }
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #project(row: any, plan: SearchPlan, metric: string, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = row.id as string
    if (proj.vector) out.vector = this.#parseVec(row.vec)
    if (proj.document) out.document = (row.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(row.metadata)
    if (isKnn && row.__dist !== undefined && row.__dist !== null) {
      out.score = normalizeScore(Number(row.__dist), metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    try {
      if (plan.ids && plan.ids.length > 0) {
        const placeholders = plan.ids.map(() => '?').join(', ')
        await this.#query(
          `DELETE FROM ${ident(plan.collection)} WHERE id IN (${placeholders})`,
          plan.ids
        )
      } else if (plan.filter) {
        const rows = await this.#query(`SELECT id, metadata FROM ${ident(plan.collection)}`)
        const targets = rows
          .filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          .map((row) => row.id as string)
        if (targets.length > 0) {
          const placeholders = targets.map(() => '?').join(', ')
          await this.#query(
            `DELETE FROM ${ident(plan.collection)} WHERE id IN (${placeholders})`,
            targets
          )
        }
      } else {
        await this.#query(`DELETE FROM ${ident(plan.collection)}`)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
