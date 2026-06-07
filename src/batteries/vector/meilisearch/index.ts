/**
 * @module @nhtio/adk/batteries/vector/meilisearch
 *
 * Meilisearch adapter. Each collection is a Meilisearch index with a `userProvided` embedder
 * (BYO vectors under `_vectors.<embedder>`); KNN uses semantic search (`vector` +
 * `hybrid.semanticRatio = 1`). Metadata is stored as a JSON string field and filtered with the
 * neutral filter tree's JS reference evaluator for exact cross-adapter parity. Meilisearch
 * returns `_rankingScore` already normalized to [0,1] (higher = closer).
 *
 * Requires the `vectorStore` experimental feature, which the adapter enables on connect.
 * Driver: `meilisearch` (pure JS).
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

const EMBEDDER = 'default'

export interface MeilisearchVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: { host?: string; apiKey?: string }
}

const getMeilisearch = async () => {
  try {
    const mod = await import('meilisearch')
    return mod.Meilisearch
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['meilisearch'])
  }
}

export class MeilisearchVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Writes are awaited to task completion (waitForTask) before resolving — strongly
    // consistent for the next search. The option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #client: any | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): MeilisearchVectorStoreOptions {
    return this.options as MeilisearchVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }

  async connect(): Promise<void> {
    if (this.#client) return
    const Meilisearch = await getMeilisearch()
    const c = this.#opts.connection || {}
    const host = c.host ?? 'http://localhost:7700'
    try {
      this.#client = new Meilisearch({ host, apiKey: c.apiKey })
      // Enable the vector store experimental feature (no-op / stable on newer versions).
      await fetch(`${host.replace(/\/$/, '')}/experimental-features`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
        },
        body: JSON.stringify({ vectorStore: true }),
      }).catch(() => undefined)
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }

  async close(): Promise<void> {
    this.#client = null
  }

  async #ensure(): Promise<any> {
    if (!this.#client) await this.connect()
    return this.#client!
  }

  async #wait(task: any): Promise<void> {
    const uid = task?.taskUid ?? task?.uid
    if (uid === undefined) return
    await this.#client.tasks.waitForTask(uid)
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const client = await this.#ensure()
    this.#dims.set(spec.collection, spec.vector.dimensions)
    if (ifNotExists && (await this.hasCollection(spec.collection))) return
    try {
      await this.#wait(await client.createIndex(spec.collection, { primaryKey: 'id' }))
      const idx = client.index(spec.collection)
      await this.#wait(
        await idx.updateEmbedders({
          [EMBEDDER]: { source: 'userProvided', dimensions: spec.vector.dimensions },
        })
      )
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    const client = await this.#ensure()
    if (ifExists && !(await this.hasCollection(collection))) return
    try {
      await this.#wait(await client.deleteIndex(collection))
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    const client = await this.#ensure()
    try {
      await client.index(collection).getRawInfo()
      return true
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'meilisearch'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const client = await this.#ensure()
    const expected = this.#opts.dimensions ?? this.#dims.get(plan.collection)
    try {
      const docs: any[] = []
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
        docs.push({
          id: r.id,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
          _vectors: { [EMBEDDER]: vector },
        })
      }
      await this.#wait(await client.index(plan.collection).addDocuments(docs))
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
    const client = await this.#ensure()
    const idx = client.index(plan.collection)
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        try {
          const doc = await idx.getDocument(plan.near.id, { retrieveVectors: true })
          queryVector = this.#unwrapVector(doc?._vectors?.[EMBEDDER])
        } catch {
          queryVector = undefined
        }
        if (!queryVector) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
      }
    }

    const offset = plan.offset ?? 0
    try {
      const over = plan.filter ? 250 : plan.topK + offset
      let hits: any[]
      if (queryVector) {
        const res = await idx.search('', {
          vector: queryVector,
          hybrid: { embedder: EMBEDDER, semanticRatio: 1.0 },
          limit: Math.max(over, plan.topK + offset),
          showRankingScore: true,
          retrieveVectors: true,
        })
        hits = res.hits ?? []
      } else {
        const res = await idx.search('', {
          limit: Math.max(over, plan.topK + offset),
          retrieveVectors: true,
        })
        hits = res.hits ?? []
      }
      const mapped = hits.map((hit) => ({
        match: this.#project(hit, plan, !!queryVector),
        meta: this.#parseMeta(hit.metadata),
      }))
      const filtered = plan.filter
        ? mapped.filter((m) => evaluateFilter(plan.filter!, m.meta))
        : mapped
      return filtered.slice(offset, offset + plan.topK).map((m) => m.match)
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #unwrapVector(v: unknown): number[] | undefined {
    // Meilisearch returns _vectors.default as { embeddings: number[][] } or number[][] or number[].
    if (!v) return undefined
    if (Array.isArray(v)) {
      return Array.isArray(v[0]) ? (v[0] as number[]) : (v as number[])
    }
    const emb = (v as any).embeddings
    if (Array.isArray(emb)) return Array.isArray(emb[0]) ? (emb[0] as number[]) : (emb as number[])
    return undefined
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

  #project(hit: any, plan: SearchPlan, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = hit.id as string
    if (proj.vector) {
      const v = this.#unwrapVector(hit._vectors?.[EMBEDDER])
      if (v) out.vector = v
    }
    if (proj.document) out.document = (hit.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(hit.metadata)
    if (isKnn && typeof hit._rankingScore === 'number') {
      // Meilisearch _rankingScore is already in [0,1], higher = closer.
      out.score = hit._rankingScore
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const client = await this.#ensure()
    const idx = client.index(plan.collection)
    try {
      if (plan.ids && plan.ids.length > 0) {
        await this.#wait(await idx.deleteDocuments(plan.ids))
      } else if (plan.filter) {
        // Resolve ids via a scan + JS evaluator, then delete by id.
        const res = await idx.search('', { limit: 1000 })
        const targets = (res.hits ?? [])
          .filter((hit: any) => evaluateFilter(plan.filter!, this.#parseMeta(hit.metadata)))
          .map((hit: any) => hit.id as string)
        if (targets.length > 0) await this.#wait(await idx.deleteDocuments(targets))
      } else {
        await this.#wait(await idx.deleteAllDocuments())
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
