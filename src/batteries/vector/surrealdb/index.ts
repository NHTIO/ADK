/**
 * @module @nhtio/adk/batteries/vector/surrealdb
 *
 * SurrealDB adapter (multi-model). Each collection is a SurrealDB table; records store the
 * vector as a plain array field and KNN uses `vector::similarity::cosine` /
 * `vector::distance::euclidean` ordered appropriately. Metadata is a JSON string field filtered
 * with the neutral filter tree's JS reference evaluator for exact cross-adapter parity.
 *
 * Driver: `surrealdb` (pure JS). All queries are parameterized via `$bindings`.
 */

import { evaluateFilter } from '../filters'
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
} from '../types'

export interface SurrealDBVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: {
    url: string
    username?: string
    password?: string
    namespace?: string
    database?: string
  }
}

const getSurreal = async () => {
  try {
    const mod = await import('surrealdb')
    return mod.Surreal
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['surrealdb'])
  }
}

// Backtick-quoted SurrealQL identifier.
const ident = (name: string): string => '`' + name.replace(/`/g, '\\`') + '`'

// Extract the bare id from a SurrealDB RecordId (object with .id) or a "table:id" string.
const recordIdToString = (rid: unknown): string => {
  if (rid && typeof rid === 'object' && 'id' in (rid as any)) {
    return String((rid as any).id)
  }
  const s = String(rid)
  const idx = s.indexOf(':')
  return idx >= 0 ? s.slice(idx + 1).replace(/^⟨|⟩$/g, '') : s
}

export class SurrealDBVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Synchronous over the RPC connection: a write is visible on resolve. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #db: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): SurrealDBVectorStoreOptions {
    return this.options as SurrealDBVectorStoreOptions
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#db) return
    const Surreal = await getSurreal()
    const c = this.#opts.connection
    try {
      this.#db = new Surreal()
      const rpc = c.url.replace(/\/$/, '')
      await this.#db.connect(rpc.endsWith('/rpc') ? rpc : `${rpc}/rpc`)
      if (c.username) {
        await this.#db.signin({ username: c.username, password: c.password ?? '' })
      }
      await this.#db.use({ namespace: c.namespace ?? 'test', database: c.database ?? 'test' })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#db) {
      await this.#db.close()
      this.#db = null
    }
  }

  async #ensure(): Promise<any> {
    if (!this.#db) await this.connect()
    return this.#db!
  }

  async #query(sql: string, vars?: Record<string, unknown>): Promise<any[]> {
    const db = await this.#ensure()
    const res = await db.query(sql, vars)
    return res as any[]
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const ine = ifNotExists ? 'IF NOT EXISTS ' : ''
    try {
      await this.#query(`DEFINE TABLE ${ine}${ident(spec.collection)} SCHEMALESS;`)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const ie = ifExists ? 'IF EXISTS ' : ''
    try {
      await this.#query(`REMOVE TABLE ${ie}${ident(collection)};`)
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    try {
      const res = await this.#query('INFO FOR DB;')
      const info = res[0]
      const tables = info?.tables ?? info?.tb ?? {}
      return Object.prototype.hasOwnProperty.call(tables, collection)
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'surrealdb'])
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
        await this.#query(
          `UPSERT type::thing($tbl, $rid) SET vec = $vec, document = $document, metadata = $metadata;`,
          {
            tbl: plan.collection,
            rid: r.id,
            vec: vector,
            document: r.document ?? '',
            metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
          }
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
        const res = await this.#query(`SELECT vec FROM type::thing($tbl, $rid);`, {
          tbl: plan.collection,
          rid: plan.near.id,
        })
        const row = res[0]?.[0]
        if (!row) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = row.vec as number[]
      }
    }

    const offset = plan.offset ?? 0
    try {
      const tbl = ident(plan.collection)
      let rows: any[]
      if (queryVector) {
        // similarity::cosine (higher=better) for cosine/dot; distance::euclidean (lower=better) for l2.
        const useDistance = metric === 'euclidean'
        const fn = useDistance ? 'vector::distance::euclidean' : 'vector::similarity::cosine'
        const order = useDistance ? 'ASC' : 'DESC'
        const res = await this.#query(
          `SELECT *, ${fn}(vec, $qv) AS __score FROM ${tbl} ORDER BY __score ${order};`,
          { qv: queryVector }
        )
        rows = res[0] ?? []
        const scored = rows.map((row) => ({ row, score: this.#norm(Number(row.__score), metric) }))
        const filtered = plan.filter
          ? scored.filter((s) => evaluateFilter(plan.filter!, this.#parseMeta(s.row.metadata)))
          : scored
        return filtered
          .slice(offset, offset + plan.topK)
          .map((s) => this.#project(s.row, plan, s.score))
      } else {
        const res = await this.#query(`SELECT * FROM ${tbl};`)
        rows = res[0] ?? []
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, undefined))
      }
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  // cosine similarity is already [-1,1]; map to [0,1]. euclidean distance → 1/(1+d).
  #norm(raw: number, metric: string): number {
    if (metric === 'euclidean') return 1 / (1 + raw)
    return (raw + 1) / 2
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

  #project(row: any, plan: SearchPlan, score: number | undefined): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = recordIdToString(row.id)
    if (proj.vector && Array.isArray(row.vec)) out.vector = (row.vec as number[]).map(Number)
    if (proj.document) out.document = (row.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(row.metadata)
    if (score !== undefined && !Number.isNaN(score)) out.score = score
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    try {
      if (plan.ids && plan.ids.length > 0) {
        for (const id of plan.ids) {
          await this.#query(`DELETE type::thing($tbl, $rid);`, { tbl: plan.collection, rid: id })
        }
      } else if (plan.filter) {
        const res = await this.#query(`SELECT id, metadata FROM ${ident(plan.collection)};`)
        const rows = res[0] ?? []
        const targets = rows
          .filter((row: any) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          .map((row: any) => recordIdToString(row.id))
        for (const id of targets) {
          await this.#query(`DELETE type::thing($tbl, $rid);`, { tbl: plan.collection, rid: id })
        }
      } else {
        await this.#query(`DELETE ${ident(plan.collection)};`)
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
