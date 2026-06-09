/**
 * @module @nhtio/adk/batteries/vector/lancedb
 *
 * Embedded LanceDB adapter (no server — file-based, like sqlite_vec/duckdb). Each collection
 * is a Lance table with an explicit Arrow schema (`id` Utf8, `vec` FixedSizeList<Float32>,
 * `document` Utf8, `metadata` Utf8-JSON). KNN uses `table.search(vector).distanceType(...)`;
 * metadata is filtered with the neutral filter tree's JS reference evaluator for exact
 * cross-adapter parity. Upsert is a merge-insert on `id`.
 *
 * Drivers: `@lancedb/lancedb` + `apache-arrow` (prebuilt binary; no native compile).
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

export interface LanceDBVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: { uri: string }
}

const getLanceDB = async () => {
  try {
    return await import('@lancedb/lancedb')
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@lancedb/lancedb'])
  }
}

const getArrow = async () => {
  try {
    return await import('apache-arrow')
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['apache-arrow'])
  }
}

const lanceMetric = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'l2' : metric === 'dot' ? 'dot' : 'cosine'

// LanceDB SQL string literal (single-quoted, escape embedded quotes).
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`

export class LanceDBVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: true,
    rawSql: false,
    builtInEncoding: false,
    // Embedded and synchronous: a write is visible on resolve. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #db: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): LanceDBVectorStoreOptions {
    return this.options as LanceDBVectorStoreOptions
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
    const lancedb = await getLanceDB()
    const uri = this.#opts.connection?.uri
    if (!uri) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([
        'LanceDB requires connection.uri (a directory path)',
      ])
    }
    try {
      this.#db = await lancedb.connect(uri)
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    this.#db = null
  }

  async #ensure(): Promise<any> {
    if (!this.#db) await this.connect()
    return this.#db!
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const db = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    if (ifNotExists && (await this.hasCollection(spec.collection))) return
    const arrow = await getArrow()
    const schema = new arrow.Schema([
      new arrow.Field('id', new arrow.Utf8(), false),
      new arrow.Field(
        'vec',
        new arrow.FixedSizeList(
          spec.vector.dimensions,
          new arrow.Field('item', new arrow.Float32(), true)
        ),
        false
      ),
      new arrow.Field('document', new arrow.Utf8(), true),
      new arrow.Field('metadata', new arrow.Utf8(), true),
    ])
    try {
      await db.createEmptyTable(spec.collection, schema, { mode: 'overwrite' })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const db = await this.#ensure()
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      await db.dropTable(collection)
      this.#dims.delete(collection)
    } catch (err) {
      const msg = String(err)
      if (ifExists && msg.includes('not found')) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const db = await this.#ensure()
    try {
      const names = await db.tableNames()
      return names.includes(collection)
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'lancedb'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const db = await this.#ensure()
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    try {
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
        if (expected !== undefined && vector.length !== expected) {
          throw new E_VECTOR_STORE_DIMENSION_MISMATCH([expected, vector.length])
        }
        rows.push({
          id: r.id,
          vec: vector,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
        })
      }
      const tbl = await db.openTable(plan.collection)
      // Merge-insert on id = upsert (update matched, insert unmatched).
      await tbl.mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows)
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
    const db = await this.#ensure()
    const metric = this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined
    let tbl: any
    try {
      tbl = await db.openTable(plan.collection)
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }

    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const rows = await tbl
          .query()
          .where(`id = ${lit(plan.near.id)}`)
          .limit(1)
          .toArray()
        if (rows.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = Array.from(rows[0].vec as ArrayLike<number>)
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        // Over-fetch then JS-filter for exact cross-adapter filter semantics.
        const k = plan.filter ? 1000 : plan.topK + offset
        const rows = await tbl
          .search(queryVector)
          .distanceType(lanceMetric(metric))
          .limit(k)
          .toArray()
        const filtered = plan.filter
          ? rows.filter((row: any) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row: any) => this.#project(row, plan, metric, true))
      } else {
        const rows = await tbl
          .query()
          .limit(plan.filter ? 100000 : plan.topK + offset)
          .toArray()
        const filtered = plan.filter
          ? rows.filter((row: any) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row: any) => this.#project(row, plan, metric, false))
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

  #project(row: any, plan: SearchPlan, metric: string, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = row.id as string
    if (proj.vector && row.vec) out.vector = Array.from(row.vec as ArrayLike<number>)
    if (proj.document) out.document = (row.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(row.metadata)
    if (isKnn && row._distance !== undefined && row._distance !== null) {
      out.score = normalizeScore(Number(row._distance), metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const db = await this.#ensure()
    try {
      const tbl = await db.openTable(plan.collection)
      if (plan.ids && plan.ids.length > 0) {
        const list = plan.ids.map((id) => lit(id)).join(', ')
        await tbl.delete(`id IN (${list})`)
      } else if (plan.filter) {
        const rows = await tbl.query().limit(100000).toArray()
        const targets: string[] = rows
          .filter((row: any) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          .map((row: any) => row.id as string)
        if (targets.length > 0) {
          const list = targets.map((id) => lit(id)).join(', ')
          await tbl.delete(`id IN (${list})`)
        }
      } else {
        await tbl.delete('true')
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
