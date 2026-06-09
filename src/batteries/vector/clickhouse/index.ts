/**
 * @module @nhtio/adk/batteries/vector/clickhouse
 *
 * ClickHouse adapter. Vectors live in an `Array(Float32)` column; KNN uses ClickHouse's
 * `cosineDistance` / `L2Distance` / negative-inner-product expressions ordered ascending.
 * Metadata is a JSON `String` column, filtered with the neutral filter tree's JS reference
 * evaluator for exact cross-adapter parity. Each collection is a MergeTree table.
 *
 * MergeTree allows duplicate keys, so upsert is delete-then-insert; writes are made
 * read-after-write consistent with `mutations_sync = 2` on deletes.
 *
 * Driver: `@clickhouse/client` (HTTP).
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

export interface ClickHouseVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection?: { url?: string; username?: string; password?: string; database?: string }
}

const getClickHouseClient = async () => {
  try {
    const mod = await import('@clickhouse/client')
    return mod.createClient
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@clickhouse/client'])
  }
}

// ClickHouse distance expression per metric (all "lower is closer" once negated for dot).
const distanceExpr = (metric: DistanceMetric, vecLit: string): string =>
  metric === 'euclidean'
    ? `L2Distance(vec, ${vecLit})`
    : metric === 'dot'
      ? `-arraySum(arrayMap((a, b) -> a * b, vec, ${vecLit}))`
      : `cosineDistance(vec, ${vecLit})`

// Backtick-quote an identifier, escaping embedded backticks.
const ident = (name: string): string => '`' + name.replace(/`/g, '``') + '`'

// Single-quoted ClickHouse string literal.
const lit = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// number[] → ClickHouse array literal [1, 2, 3].
const vectorLiteral = (vector: number[]): string =>
  `[${vector.map((n) => (Number.isFinite(n) ? String(n) : '0')).join(', ')}]`

export class ClickHouseVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: true,
    rawSql: true,
    builtInEncoding: false,
    // Made strongly consistent via mutations_sync=2 on deletes; writes visible on resolve.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): ClickHouseVectorStoreOptions {
    return this.options as ClickHouseVectorStoreOptions
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
    const createClient = await getClickHouseClient()
    const c = this.#opts.connection || {}
    try {
      this.#client = createClient({
        url: c.url ?? 'http://localhost:8123',
        username: c.username ?? 'default',
        password: c.password ?? '',
        database: c.database ?? 'default',
      })
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    if (this.#client) {
      await this.#client.close()
      this.#client = null
    }
  }

  async #ensure(): Promise<any> {
    if (!this.#client) await this.connect()
    return this.#client!
  }

  async #json(sql: string): Promise<any[]> {
    const client = await this.#ensure()
    const rs = await client.query({ query: sql, format: 'JSONEachRow' })
    return (await rs.json()) as any[]
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const ine = ifNotExists ? 'IF NOT EXISTS ' : ''
    try {
      await client.command({
        query:
          `CREATE TABLE ${ine}${ident(spec.collection)} (` +
          `id String, vec Array(Float32), document String, metadata String` +
          `) ENGINE = MergeTree() ORDER BY id`,
      })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = await this.#ensure()
    const ie = ifExists ? 'IF EXISTS ' : ''
    try {
      await client.command({ query: `DROP TABLE ${ie}${ident(collection)}` })
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const rows = await this.#json(`EXISTS TABLE ${ident(collection)}`)
    return rows.length > 0 && (rows[0].result === 1 || rows[0].result === '1')
  }

  async renameCollection(from: string, to: string): Promise<void> {
    const client = await this.#ensure()
    try {
      await client.command({ query: `RENAME TABLE ${ident(from)} TO ${ident(to)}` })
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
    const client = await this.#ensure()
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    const values: any[] = []
    const ids: string[] = []
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
        ids.push(r.id)
        values.push({
          id: r.id,
          vec: vector,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
        })
      }
      // MergeTree allows dupes — delete the ids first (synchronously) so upsert replaces.
      const idList = ids.map((id) => lit(id)).join(', ')
      await client.command({
        query: `DELETE FROM ${ident(plan.collection)} WHERE id IN (${idList})`,
        clickhouse_settings: { mutations_sync: '2' },
      })
      await client.insert({
        table: plan.collection,
        values,
        format: 'JSONEachRow',
      })
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
        const rows = await this.#json(
          `SELECT vec FROM ${ident(plan.collection)} WHERE id = ${lit(plan.near.id)} LIMIT 1`
        )
        if (rows.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = rows[0].vec as number[]
      }
    }

    const offset = plan.offset ?? 0
    try {
      if (queryVector) {
        const distExpr = distanceExpr(metric, vectorLiteral(queryVector))
        const rows = await this.#json(
          `SELECT id, vec, document, metadata, ${distExpr} AS __dist FROM ${ident(plan.collection)}`
        )
        const filtered = plan.filter
          ? rows.filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          : rows
        filtered.sort((a, b) => Number(a.__dist) - Number(b.__dist))
        return filtered
          .slice(offset, offset + plan.topK)
          .map((row) => this.#project(row, plan, metric, true))
      } else {
        const rows = await this.#json(
          `SELECT id, vec, document, metadata FROM ${ident(plan.collection)}`
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
    if (proj.vector) out.vector = (row.vec as number[]).map((n) => Number(n))
    if (proj.document) out.document = (row.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(row.metadata)
    if (isKnn && row.__dist !== undefined && row.__dist !== null) {
      out.score = normalizeScore(Number(row.__dist), metric as DistanceMetric, 'distance')
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = await this.#ensure()
    const sync = { mutations_sync: '2' as const }
    try {
      if (plan.ids && plan.ids.length > 0) {
        const list = plan.ids.map((id) => lit(id)).join(', ')
        await client.command({
          query: `DELETE FROM ${ident(plan.collection)} WHERE id IN (${list})`,
          clickhouse_settings: sync,
        })
      } else if (plan.filter) {
        const rows = await this.#json(`SELECT id, metadata FROM ${ident(plan.collection)}`)
        const targets = rows
          .filter((row) => evaluateFilter(plan.filter!, this.#parseMeta(row.metadata)))
          .map((row) => row.id as string)
        if (targets.length > 0) {
          const list = targets.map((id) => lit(id)).join(', ')
          await client.command({
            query: `DELETE FROM ${ident(plan.collection)} WHERE id IN (${list})`,
            clickhouse_settings: sync,
          })
        }
      } else {
        await client.command({
          query: `DELETE FROM ${ident(plan.collection)} WHERE 1 = 1`,
          clickhouse_settings: sync,
        })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
