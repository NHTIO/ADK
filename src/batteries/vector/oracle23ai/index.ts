/**
 * @module @nhtio/adk/batteries/vector/oracle23ai
 *
 * Oracle 23ai AI Vector Search adapter. Vectors live in a `VECTOR(dims, FLOAT32)` column
 * written with `DB_TYPE_VECTOR` (oracledb thin mode, default) and read back as Float32Array.
 * KNN search uses `VECTOR_DISTANCE(vec, :q, COSINE|EUCLIDEAN|DOT)` ordered ascending. Metadata
 * is a CLOB containing a JSON string, filtered with the neutral evaluator for exact cross-adapter
 * parity. Each collection maps to a table named `<tablePrefix><collection>` with double-quoted
 * identifiers for safety.
 *
 * The connecting user must default to a non-SYSTEM tablespace (e.g. USERS) and have CREATE TABLE.
 * Oracle 23ai provides strong consistency: commits are synchronous, so there is no settle-poll.
 *
 * Score contract: do NOT trust the raw VECTOR_DISTANCE as a [0,1] score. Instead, use SQL only to
 * order candidates, then recompute the [0,1] similarity locally using the stored `vec` and the
 * computeScore helper, ensuring the [0,1] contract regardless of metric semantics.
 *
 * Driver: `oracledb` (pure-JS thin mode, no Instant Client required).
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

const getOracle = async (): Promise<any> => {
  try {
    // oracledb ships no type declarations; import the specifier dynamically as untyped.
    const mod = await import(/* @vite-ignore */ 'oracledb' as string)
    return mod.default ?? mod
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['oracledb'])
  }
}

// Build a double-quoted Oracle identifier, safely escaping embedded double quotes.
const ident = (name: string): string => '"' + name.replace(/"/g, '""') + '"'

export interface Oracle23aiVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: {
    connectString: string // 'host:1521/FREEPDB1'
    user: string
    password: string
    tablePrefix?: string // logical collection → `${tablePrefix}${collection}` table
  }
}

export class Oracle23aiVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #oracledb: any | null = null
  #conn: any | null = null
  #dims: Map<string, number> = new Map()
  #metrics: Map<string, DistanceMetric> = new Map()

  get #opts(): Oracle23aiVectorStoreOptions {
    return this.options as Oracle23aiVectorStoreOptions
  }

  // Map a logical collection name to its physical table (with optional prefix).
  #table(collection: string): string {
    const prefix = this.#opts.connection.tablePrefix ?? ''
    return prefix + collection
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#conn) return
    this.#oracledb = await getOracle()
    const c = this.#opts.connection
    try {
      this.#conn = await this.#oracledb.getConnection({
        user: c.user,
        password: c.password,
        connectString: c.connectString,
      })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#conn) {
      await this.#conn.close()
      this.#conn = null
      this.#oracledb = null
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

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const coll = spec.collection
    const dims = spec.vector.dimensions
    const metric = spec.vector.metric
    this.#dims.set(coll, dims)
    this.#metrics.set(coll, metric)

    const T = ident(this.#table(coll))
    const tableName = this.#table(coll)

    try {
      // Check if table exists
      const checkRows = await this.#conn!.execute(
        `SELECT 1 FROM user_tables WHERE table_name = :n`,
        [tableName],
        { outFormat: this.#oracledb!.OUT_FORMAT_OBJECT }
      )
      const exists = checkRows.rows.length > 0

      if (exists) {
        if (ifNotExists) {
          // Clear existing table
          await this.#conn!.execute(`DELETE FROM ${T}`)
          await this.#conn!.commit()
          return
        }
        // Drop and recreate
        await this.#conn!.execute(`DROP TABLE ${T}`)
      }

      // Create table
      const sql = `CREATE TABLE ${T} (
        id VARCHAR2(512) PRIMARY KEY,
        vec VECTOR(${dims}, FLOAT32),
        document CLOB,
        metadata CLOB
      )`
      await this.#conn!.execute(sql)
      await this.#conn!.commit()
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const T = ident(this.#table(collection))
    try {
      await this.#conn!.execute(`DROP TABLE ${T}`)
      this.#dims.delete(collection)
      this.#metrics.delete(collection)
    } catch (err: any) {
      if (err?.message && err.message.includes('ORA-00942')) {
        if (ifExists) return
        throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', 'table does not exist'])
      }
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const tableName = this.#table(collection)
    const rows = await this.#conn!.execute(
      `SELECT 1 FROM user_tables WHERE table_name = :n`,
      [tableName],
      { outFormat: this.#oracledb!.OUT_FORMAT_OBJECT }
    )
    return rows.rows.length > 0
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'oracle23ai'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)

    const T = ident(this.#table(plan.collection))

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

        const vecBind = {
          type: this.#oracledb!.DB_TYPE_VECTOR,
          val: Float32Array.from(vector),
        }

        const doc = r.document ?? ''
        const meta = r.metadata ? JSON.stringify(r.metadata) : '{}'

        // MERGE upsert
        await this.#conn!.execute(
          `MERGE INTO ${T} d
           USING (SELECT :id AS id FROM dual) s
           ON (d.id = s.id)
           WHEN MATCHED THEN UPDATE SET vec = :vec, document = :doc, metadata = :meta
           WHEN NOT MATCHED THEN INSERT (id, vec, document, metadata)
             VALUES (:id, :vec, :doc, :meta)`,
          {
            id: r.id,
            vec: vecBind,
            doc,
            meta,
          },
          { outFormat: this.#oracledb!.OUT_FORMAT_OBJECT }
        )
      }
      await this.#conn!.commit()
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
    const coll = plan.collection
    const metric: DistanceMetric = this.#metrics.get(coll) ?? this.#opts.metric ?? 'cosine'
    const T = ident(this.#table(coll))

    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const rows = await this.#conn!.execute(
          `SELECT vec FROM ${T} WHERE id = :id`,
          [plan.near.id],
          {
            outFormat: this.#oracledb!.OUT_FORMAT_OBJECT,
            fetchInfo: { VEC: { type: this.#oracledb!.DB_TYPE_VECTOR } },
          }
        )
        if (rows.rows.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        const arr = rows.rows[0].VEC as Float32Array
        queryVector = Array.from(arr)
      }
    }

    const offset = plan.offset ?? 0

    try {
      if (queryVector) {
        const k = plan.filter ? 1000 : plan.topK + offset
        const metricSql =
          metric === 'cosine'
            ? 'COSINE'
            : metric === 'euclidean'
              ? 'EUCLIDEAN'
              : metric === 'dot'
                ? 'DOT'
                : 'COSINE'

        const qBind = {
          type: this.#oracledb!.DB_TYPE_VECTOR,
          val: Float32Array.from(queryVector),
        }

        const rows = await this.#conn!.execute(
          `SELECT id, vec, document, metadata, VECTOR_DISTANCE(vec, :q, ${metricSql}) AS dist
           FROM ${T}
           ORDER BY dist
           FETCH APPROX FIRST :k ROWS ONLY`,
          { q: qBind, k },
          {
            outFormat: this.#oracledb!.OUT_FORMAT_OBJECT,
            fetchInfo: {
              DOCUMENT: { type: this.#oracledb!.STRING },
              METADATA: { type: this.#oracledb!.STRING },
            },
          }
        )

        const result: VectorMatch[] = []
        for (const row of rows.rows) {
          const meta = this.#parseMeta(row.METADATA)
          if (plan.filter && !evaluateFilter(plan.filter, meta)) {
            continue
          }
          const storedVec = Array.from(row.VEC as Float32Array)
          const score = computeScore(storedVec, queryVector!, metric)
          result.push(this.#project(row, plan, score))
        }

        // Apply offset/slice after filtering
        return result.slice(offset, offset + plan.topK)
      } else {
        // Filter-scan: no KNN, read all rows
        const cap = 1000
        const rows = await this.#conn!.execute(
          `SELECT id, vec, document, metadata FROM ${T} FETCH FIRST :cap ROWS ONLY`,
          [cap],
          {
            outFormat: this.#oracledb!.OUT_FORMAT_OBJECT,
            fetchInfo: {
              DOCUMENT: { type: this.#oracledb!.STRING },
              METADATA: { type: this.#oracledb!.STRING },
            },
          }
        )

        const result: VectorMatch[] = []
        for (const row of rows.rows) {
          const meta = this.#parseMeta(row.METADATA)
          if (plan.filter && !evaluateFilter(plan.filter, meta)) {
            continue
          }
          result.push(this.#project(row, plan, undefined))
        }
        return result.slice(offset, offset + plan.topK)
      }
    } catch (err: any) {
      if (err?.message && err.message.includes('Referenced id not found')) {
        throw err
      }
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #project(row: any, plan: SearchPlan, score?: number): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = row.ID as string
    if (proj.vector) out.vector = (Array.from(row.VEC as Float32Array) as number[]).map(Number)
    if (proj.document) out.document = (row.DOCUMENT ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(row.METADATA)
    if (score !== undefined) out.score = score
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const T = ident(this.#table(plan.collection))
    try {
      if (plan.ids && plan.ids.length > 0) {
        const ids = plan.ids
        const bindObj: any = {}
        ids.forEach((id, i) => {
          bindObj['id' + i] = id
        })
        const sql = `DELETE FROM ${T} WHERE id IN (${ids.map((_id, i) => ':id' + i).join(', ')})`
        await this.#conn!.execute(sql, bindObj)
        await this.#conn!.commit()
      } else if (plan.filter) {
        const rows = await this.#conn!.execute(
          `SELECT id, metadata FROM ${T}`,
          {},
          {
            outFormat: this.#oracledb!.OUT_FORMAT_OBJECT,
            fetchInfo: {
              METADATA: { type: this.#oracledb!.STRING },
            },
          }
        )
        const targets = rows.rows
          .filter((r: any) => evaluateFilter(plan.filter!, this.#parseMeta(r.METADATA)))
          .map((r: any) => r.ID as string)
        if (targets.length > 0) {
          const bindObj: any = {}
          targets.forEach((id: string, i: number) => {
            bindObj['id' + i] = id
          })
          const sql = `DELETE FROM ${T} WHERE id IN (${targets.map((_id: string, i: number) => ':id' + i).join(', ')})`
          await this.#conn!.execute(sql, bindObj)
          await this.#conn!.commit()
        }
      } else {
        await this.#conn!.execute(`DELETE FROM ${T}`)
        await this.#conn!.commit()
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}

// Score recomputation helpers (copied from couchbase/index.ts verbatim)

const cosineSim = (a: number[], b: number[]): number => {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [i, av] of a.entries()) {
    const bv = b[i]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

const dotProd = (a: number[], b: number[]): number => {
  let s = 0
  for (const [i, element] of a.entries()) {
    s += element * b[i]
  }
  return s
}

const euclideanDist = (a: number[], b: number[]): number => {
  let s = 0
  for (const [i, element] of a.entries()) {
    const d = element - b[i]
    s += d * d
  }
  return Math.sqrt(s)
}

const computeScore = (vec: number[], query: number[], metric: DistanceMetric): number => {
  if (metric === 'cosine') {
    const raw = cosineSim(vec, query)
    return normalizeScore(raw, 'cosine', 'similarity')
  } else if (metric === 'dot') {
    const raw = dotProd(vec, query)
    return normalizeScore(raw, 'dot', 'similarity')
  } else if (metric === 'euclidean') {
    const raw = euclideanDist(vec, query)
    return normalizeScore(raw, 'euclidean', 'distance')
  } else {
    // Fallback
    const raw = cosineSim(vec, query)
    return normalizeScore(raw, 'cosine', 'similarity')
  }
}
