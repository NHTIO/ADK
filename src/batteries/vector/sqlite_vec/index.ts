/**
 * @module @nhtio/adk/batteries/vector/sqlite_vec
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
import { validateRecords } from '../validation'
import { BaseVectorStore, CallableVectorStore } from '../contract'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_CONNECTION_FAILED,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
} from '../exceptions'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type { VectorMatch, VectorStoreCapabilities, BaseVectorStoreOptions } from '../types'

/** Construction options for {@link SqliteVecVectorStore}. */
export interface SqliteVecVectorStoreOptions extends BaseVectorStoreOptions {
  /** Database location: a filesystem path, or `':memory:'` for an in-memory database. */
  connection: {
    path: string
  }
}

interface VecRow {
  rowid: bigint
  distance: number
}

interface CachedStore {
  db: any
  drivers?: { Database: any; sqliteVec: any }
}

export class SqliteVecVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: true,
    namedVectors: false,
    rename: true,
    rawSql: true,
    builtInEncoding: false,
    // Strongly consistent (local file/in-memory): visible on resolve, so the option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #_cache: CachedStore | null = null
  #_dims: Map<string, number> = new Map()

  constructor(options: SqliteVecVectorStoreOptions) {
    super(options)
  }

  get #opts(): SqliteVecVectorStoreOptions {
    return this.options as SqliteVecVectorStoreOptions
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#_cache) {
      return
    }

    let Database: any
    let sqliteVec: any

    try {
      const mod1 = await import('better-sqlite3')
      Database = mod1.default
    } catch (e) {
      throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['better-sqlite3 / sqlite-vec'])
    }

    try {
      sqliteVec = await import('sqlite-vec')
    } catch (e) {
      throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['better-sqlite3 / sqlite-vec'])
    }

    const path = this.#opts.connection?.path ?? ':memory:'
    let db: any

    try {
      db = new Database(path)
    } catch (e: any) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([e?.message ?? String(e)])
    }

    sqliteVec.load(db)

    this.#_cache = { db, drivers: { Database, sqliteVec } }
  }

  async close(): Promise<void> {
    if (this.#_cache?.db) {
      this.#_cache.db.close()
      this.#_cache = null
    }
  }

  /** The underlying SQLite database handle; throws if the store is not connected. */
  get db(): any {
    if (!this.#_cache?.db) {
      throw new Error('Not connected')
    }
    return this.#_cache.db
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    await this.connect()
    const { collection, vector } = spec
    const dims = vector.dimensions
    const tbl = `"${collection}"`
    const metaTbl = `"${collection}__meta"`

    const { db } = this

    const exists = await this.hasCollection(collection)
    if (!ifNotExists && exists) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', 'collection exists'])
    }

    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tbl} USING vec0(embedding float[${dims}])`)
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${metaTbl} (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE, document TEXT, metadata TEXT)`
      )
      this.#_dims.set(collection, dims)
    } catch (e: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['create', e?.message ?? String(e)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    await this.connect()
    const tbl = `"${collection}"`
    const metaTbl = `"${collection}__meta"`

    const has = await this.hasCollection(collection)
    if (!has) {
      if (!ifExists) {
        throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', 'collection does not exist'])
      }
      return
    }

    const { db } = this
    try {
      db.exec(`DROP TABLE IF EXISTS ${tbl}`)
      db.exec(`DROP TABLE IF EXISTS ${metaTbl}`)
      this.#_dims.delete(collection)
    } catch (e: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['drop', e?.message ?? String(e)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    await this.connect()
    const { db } = this
    try {
      const res: any = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(collection)
      return !!res?.name
    } catch {
      return false
    }
  }

  async renameCollection(from: string, to: string): Promise<void> {
    await this.connect()
    const hasFrom = await this.hasCollection(from)
    if (!hasFrom) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['rename', 'source collection does not exist'])
    }

    const hasTo = await this.hasCollection(to)
    if (hasTo) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['rename', 'target collection already exists'])
    }

    const { db } = this
    try {
      db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`)
      db.exec(`ALTER TABLE "${from}__meta" RENAME TO "${to}__meta"`)
      const dims = this.#_dims.get(from)
      if (dims !== undefined) {
        this.#_dims.set(to, dims)
        this.#_dims.delete(from)
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['rename', e?.message ?? String(e)])
    }
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    await this.connect()
    validateRecords(plan.records)

    const collection = plan.collection
    const dims = this.#_dims.get(collection)
    const { db } = this

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

    const stmtMetaInsert = db.prepare(
      `INSERT INTO "${collection}__meta" (id, document, metadata) VALUES (?, ?, ?)`
    )
    const stmtMetaUpdate = db.prepare(
      `UPDATE "${collection}__meta" SET document = ?, metadata = ? WHERE id = ?`
    )
    const stmtRowid = db.prepare(`SELECT rowid FROM "${collection}__meta" WHERE id = ?`)
    const stmtVecDelete = db.prepare(`DELETE FROM "${collection}" WHERE rowid = ?`)
    const stmtVecInsert = db.prepare(`INSERT INTO "${collection}" (rowid, embedding) VALUES (?, ?)`)

    const txn = db.transaction(() => {
      for (const r of resolvedRows) {
        const buf = new Float32Array(r.vector)
        let rowid: bigint | undefined

        const rowidRes: any = stmtRowid.get(r.id)
        if (rowidRes?.rowid) {
          rowid = BigInt(rowidRes.rowid)
          stmtMetaUpdate.run(r.document ?? null, JSON.stringify(r.metadata ?? {}), r.id)
          stmtVecDelete.run(rowid)
          stmtVecInsert.run(rowid, buf)
        } else {
          const insertMeta = stmtMetaInsert.run(
            r.id,
            r.document ?? null,
            JSON.stringify(r.metadata ?? {})
          )
          rowid = BigInt(insertMeta.lastInsertRowid)
          stmtVecInsert.run(rowid, buf)
        }
      }
    })

    try {
      txn()
    } catch (e: any) {
      throw new E_VECTOR_STORE_UPSERT_FAILED([e?.message ?? String(e)])
    }
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    await this.connect()
    const { db } = this
    const collection = plan.collection
    const tbl = `"${collection}"`
    const metaTbl = `"${collection}__meta"`

    const near = plan.near
    const limit = (plan.offset ?? 0) + plan.topK

    try {
      if (near) {
        let qvec: number[] | undefined

        if ('vector' in near) {
          qvec = near.vector
        } else if ('serverText' in near) {
          const [v] = await this.encode([near.serverText], 'query')
          qvec = v
        } else if ('id' in near) {
          const refRow: any = db.prepare(`SELECT rowid FROM ${metaTbl} WHERE id = ?`).get(near.id)
          if (refRow?.rowid) {
            const refVecRes: any = db
              .prepare(`SELECT embedding FROM ${tbl} WHERE rowid = ?`)
              .get(BigInt(refRow.rowid))
            if (refVecRes?.embedding) {
              qvec = Array.from(new Float32Array(refVecRes.embedding.buffer || refVecRes.embedding))
            }
          }
        }

        if (!qvec) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['no query vector provided'])
        }

        const matchClause = `embedding MATCH ? ORDER BY distance LIMIT ${limit}`
        const matchBuf = new Float32Array(qvec)

        const matches: VecRow[] = []
        const stmtMatch = db.prepare(`SELECT rowid, distance FROM ${tbl} WHERE ${matchClause}`)
        for (const row of stmtMatch.iterate(matchBuf)) {
          matches.push({ rowid: BigInt(row.rowid), distance: row.distance })
        }

        let results: VectorMatch[] = []
        for (const m of matches) {
          const meta: any = db
            .prepare(`SELECT rowid, id, document, metadata FROM ${metaTbl} WHERE rowid = ?`)
            .get(m.rowid)
          if (!meta) {
            continue
          }

          const parsedMeta =
            typeof meta.metadata === 'string' ? JSON.parse(meta.metadata) : meta.metadata

          if (plan.filter && !evaluateFilter(plan.filter, parsedMeta as any)) {
            continue
          }

          let score = normalizeScore(
            Number(m.distance),
            this.options.metric ?? 'euclidean',
            'distance'
          )

          const proj: VectorMatch = {}
          if (plan.projection.id) proj.id = meta.id
          if (plan.projection.vector) {
            const vecRes: any = db
              .prepare(`SELECT embedding FROM ${tbl} WHERE rowid = ?`)
              .get(m.rowid)
            if (vecRes?.embedding) {
              proj.vector = Array.from(
                new Float32Array(vecRes.embedding.buffer || vecRes.embedding)
              )
            }
          }
          if (plan.projection.document && meta.document !== undefined) proj.document = meta.document
          if (plan.projection.metadata && parsedMeta !== undefined)
            proj.metadata = parsedMeta as any
          if (score !== undefined) proj.score = score
          results.push(proj)
        }

        const offset = plan.offset ?? 0
        return results.slice(offset, offset + plan.topK)
      } else {
        const rows: any[] = db.prepare(`SELECT rowid, id, document, metadata FROM ${metaTbl}`).all()
        let scored: { row: any; score?: number }[] = []

        for (const row of rows) {
          const parsedMeta =
            typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata

          if (plan.filter && !evaluateFilter(plan.filter, parsedMeta as any)) {
            continue
          }

          scored.push({ row, score: undefined })
        }

        const offset = plan.offset ?? 0
        const limited = scored.slice(offset, offset + plan.topK)

        return limited.map(({ row }) => {
          const parsedMeta =
            typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
          const out: VectorMatch = {}

          if (plan.projection.id) out.id = row.id

          if (plan.projection.vector) {
            const vecRes: any = db
              .prepare(`SELECT embedding FROM ${tbl} WHERE rowid = ?`)
              .get(BigInt(row.rowid))
            if (vecRes?.embedding) {
              out.vector = Array.from(new Float32Array(vecRes.embedding.buffer || vecRes.embedding))
            }
          }

          if (plan.projection.document && row.document !== undefined) out.document = row.document
          if (plan.projection.metadata && parsedMeta !== undefined) out.metadata = parsedMeta as any

          return out
        })
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([e?.message ?? String(e)])
    }
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    await this.connect()
    const collection = plan.collection
    const metaTbl = `"${collection}__meta"`
    const tbl = `"${collection}"`

    const { db } = this

    try {
      if (plan.ids && plan.ids.length > 0) {
        const stmtIds = db.prepare(
          `SELECT rowid, metadata FROM ${metaTbl} WHERE id IN (${plan.ids.map(() => '?').join(', ')})`
        )
        const rowids: bigint[] = stmtIds.all(...plan.ids).map((r: any) => BigInt(r.rowid))
        if (rowids.length > 0) {
          const rowidPlaceholders = rowids.map(() => '?').join(', ')
          db.prepare(`DELETE FROM ${metaTbl} WHERE rowid IN (${rowidPlaceholders})`).run(...rowids)
          db.prepare(`DELETE FROM ${tbl} WHERE rowid IN (${rowidPlaceholders})`).run(...rowids)
        }
      } else if (plan.filter) {
        const rows: any[] = db.prepare(`SELECT rowid, metadata FROM ${metaTbl}`).all()
        const toDeleteRowids: bigint[] = []

        for (const row of rows) {
          const parsedMeta =
            typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
          if (evaluateFilter(plan.filter, parsedMeta as any)) {
            toDeleteRowids.push(BigInt(row.rowid))
          }
        }

        if (toDeleteRowids.length > 0) {
          const rowidPlaceholders = toDeleteRowids.map(() => '?').join(', ')
          db.prepare(`DELETE FROM ${metaTbl} WHERE rowid IN (${rowidPlaceholders})`).run(
            ...toDeleteRowids
          )
          db.prepare(`DELETE FROM ${tbl} WHERE rowid IN (${rowidPlaceholders})`).run(
            ...toDeleteRowids
          )
        }
      } else {
        db.exec(`DELETE FROM ${metaTbl}`)
        db.exec(`DELETE FROM ${tbl}`)
      }
    } catch (e: any) {
      throw new E_VECTOR_STORE_DELETE_FAILED([e?.message ?? String(e)])
    }
  }

  async transaction(fn: (tx: CallableVectorStore) => Promise<void>): Promise<void> {
    await this.connect()
    const { db } = this

    db.exec('BEGIN')
    try {
      await fn(this.asCallable())
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}
