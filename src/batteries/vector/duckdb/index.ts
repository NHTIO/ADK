/**
 * @module @nhtio/adk/batteries/vector/duckdb
 *
 * In-process DuckDB adapter (like sqlite_vec — no server). Uses the `vss` community
 * extension for vector distance functions over a `FLOAT[N]` column; metadata lives in a
 * `JSON` column filtered with DuckDB's `json_extract*` functions. Each collection is a
 * table; the document and id are plain columns.
 *
 * Driver: `@duckdb/node-api` (promise-based). Path defaults to `:memory:`.
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

export interface DuckDBVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: { path?: string }
}

const getDuckDB = async () => {
  try {
    const mod = await import('@duckdb/node-api')
    return mod.DuckDBInstance
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@duckdb/node-api'])
  }
}

// DuckDB vss distance function per metric (all return a distance — lower is closer).
const distanceFn = (metric: DistanceMetric): string =>
  metric === 'euclidean'
    ? 'array_distance'
    : metric === 'dot'
      ? 'array_negative_inner_product'
      : 'array_cosine_distance'

// A double-quoted SQL identifier (table/column), escaping embedded quotes.
const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`

// A single-quoted SQL string literal, escaping embedded quotes.
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`

// Render a number[] as a DuckDB FLOAT[N] array literal: [1.0, 2.0, ...]::FLOAT[N].
const vectorLiteral = (vector: number[]): string =>
  `[${vector.map((n) => (Number.isFinite(n) ? String(n) : '0')).join(', ')}]::FLOAT[${vector.length}]`

export class DuckDBVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: true,
    namedVectors: false,
    rename: true,
    rawSql: true,
    builtInEncoding: false,
    // In-process and synchronous: a write is visible on resolve. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #instance: any | null = null
  #conn: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): DuckDBVectorStoreOptions {
    return this.options as DuckDBVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#conn) return
    const DuckDBInstance = await getDuckDB()
    const path = this.#opts.connection?.path ?? ':memory:'
    try {
      this.#instance = await DuckDBInstance.create(path)
      this.#conn = await this.#instance.connect()
      // vss provides the array_*_distance vector functions.
      await this.#conn.run('INSTALL vss;')
      await this.#conn.run('LOAD vss;')
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    // @duckdb/node-api connections are GC-managed; drop references.
    this.#conn = null
    this.#instance = null
  }

  async #ensure(): Promise<any> {
    if (!this.#conn) await this.connect()
    return this.#conn!
  }

  async #rows(sql: string): Promise<any[][]> {
    const conn = await this.#ensure()
    const reader = await conn.runAndReadAll(sql)
    return reader.getRows()
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const conn = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const ine = ifNotExists ? 'IF NOT EXISTS ' : ''
    try {
      await conn.run(
        `CREATE TABLE ${ine}${ident(spec.collection)} (` +
          `id VARCHAR PRIMARY KEY, ` +
          `vec FLOAT[${spec.vector.dimensions}], ` +
          `document VARCHAR, ` +
          `metadata JSON)`
      )
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const conn = await this.#ensure()
    const ie = ifExists ? 'IF EXISTS ' : ''
    try {
      await conn.run(`DROP TABLE ${ie}${ident(collection)}`)
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const rows = await this.#rows(
      `SELECT 1 FROM information_schema.tables WHERE table_name = ${lit(collection)}`
    )
    return rows.length > 0
  }

  async renameCollection(from: string, to: string): Promise<void> {
    const conn = await this.#ensure()
    try {
      await conn.run(`ALTER TABLE ${ident(from)} RENAME TO ${ident(to)}`)
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
    const conn = await this.#ensure()
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
        const meta = r.metadata ? JSON.stringify(r.metadata) : '{}'
        const doc = r.document === undefined ? 'NULL' : lit(r.document)
        // DuckDB upsert: delete-then-insert keeps it simple and dialect-portable.
        await conn.run(`DELETE FROM ${ident(plan.collection)} WHERE id = ${lit(r.id)}`)
        await conn.run(
          `INSERT INTO ${ident(plan.collection)} (id, vec, document, metadata) VALUES (` +
            `${lit(r.id)}, ${vectorLiteral(vector)}, ${doc}, ${lit(meta)}::JSON)`
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
        const rows = await this.#rows(
          `SELECT vec FROM ${ident(plan.collection)} WHERE id = ${lit(plan.near.id)}`
        )
        if (rows.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = this.#unwrapVector(rows[0][0])
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        // Compute distance in DuckDB (vss), then apply the neutral filter with the JS
        // reference evaluator before sorting + limiting — so similarity + filter semantics
        // exactly match every other adapter. DuckDB scans are fast at the in-process scale.
        const fn = distanceFn(metric)
        const distExpr = `${fn}(vec, ${vectorLiteral(queryVector)})`
        const rows = await this.#rows(
          `SELECT id, vec, document, metadata, ${distExpr} AS __dist FROM ${ident(plan.collection)}`
        )
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row[3])))
          : rows
        filtered.sort((a, b) => Number(a[4]) - Number(b[4]))
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, metric, true))
      } else {
        // Filter-scan: no similarity, just the neutral filter (JS evaluator) + limit.
        const rows = await this.#rows(
          `SELECT id, vec, document, metadata, NULL AS __dist FROM ${ident(plan.collection)}`
        )
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row[3])))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, metric, false))
      }
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #unwrapVector(val: unknown): number[] {
    // DuckDB FLOAT[] comes back as { items: number[] } via node-api.
    if (val && typeof val === 'object' && Array.isArray((val as any).items)) {
      return (val as any).items as number[]
    }
    if (Array.isArray(val)) return val as number[]
    return []
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

  #project(row: any[], plan: SearchPlan, metric: string, isKnn: boolean): VectorMatch {
    // Row order: id, vec, document, metadata, __dist
    const [id, vec, document, metadata, dist] = row
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = id as string
    if (proj.vector) out.vector = this.#unwrapVector(vec)
    if (proj.document) out.document = (document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(metadata)
    if (isKnn && dist !== null && dist !== undefined) {
      out.score = normalizeScore(Number(dist), metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const conn = await this.#ensure()
    try {
      if (plan.ids && plan.ids.length > 0) {
        const list = plan.ids.map((id) => lit(id)).join(', ')
        await conn.run(`DELETE FROM ${ident(plan.collection)} WHERE id IN (${list})`)
      } else if (plan.filter) {
        // Resolve target ids in JS via the reference evaluator, then delete by id.
        const rows = await this.#rows(`SELECT id, metadata FROM ${ident(plan.collection)}`)
        const targets = rows
          .filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row[1])))
          .map((row) => row[0] as string)
        if (targets.length > 0) {
          const list = targets.map((id) => lit(id)).join(', ')
          await conn.run(`DELETE FROM ${ident(plan.collection)} WHERE id IN (${list})`)
        }
      } else {
        await conn.run(`DELETE FROM ${ident(plan.collection)}`)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
