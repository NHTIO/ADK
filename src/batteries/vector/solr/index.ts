/**
 * @module @nhtio/adk/batteries/vector/solr
 *
 * Apache Solr adapter (dense vector / kNN query parser, Solr 9+). A logical collection maps to a
 * Solr core; the adapter ensures a `DenseVectorField` (`vec`) plus `document`/`metadata` string
 * fields exist in the core schema, then uses the `{!knn f=vec topK=N}[...]` parser for search.
 * Score is Solr's cosine similarity ([0,1]). Metadata is a JSON string field filtered with the
 * neutral filter tree's JS reference evaluator for cross-adapter parity.
 *
 * No typed driver — Solr is plain HTTP/JSON, so this uses `fetch` (zero extra dependency). The
 * target core must already exist (e.g. `solr-precreate <core>` / the Core Admin API); the adapter
 * does not create cores at runtime, only their schema fields. `collection` is the core name.
 */

import { evaluateFilter } from '../filters'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import {
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

export interface SolrVectorStoreOptions extends BaseVectorStoreOptions {
  /** Connection and authentication parameters for the backend. */
  connection: { url: string }
}

const simFn = (metric: DistanceMetric): string =>
  metric === 'euclidean' ? 'euclidean' : metric === 'dot' ? 'dot_product' : 'cosine'

export class SolrVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Writes are committed (commit=true) before resolving, so they're visible to the next query.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #base: string | null = null
  #dims: Map<string, number> = new Map()

  get #opts(): SolrVectorStoreOptions {
    return this.options as SolrVectorStoreOptions
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
  static isAvailable(): boolean {
    return typeof process !== 'undefined' && typeof fetch === 'function'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined' && typeof fetch === 'function'
  }

  async connect(): Promise<void> {
    if (this.#base) return
    const url = this.#opts.connection?.url
    if (!url) throw new E_VECTOR_STORE_CONNECTION_FAILED(['Solr requires connection.url'])
    this.#base = url.replace(/\/$/, '')
  }

  async close(): Promise<void> {
    this.#base = null
  }

  async #core(collection: string): Promise<string> {
    if (!this.#base) await this.connect()
    return `${this.#base}/solr/${encodeURIComponent(collection)}`
  }

  async #post(coreUrl: string, path: string, body: unknown): Promise<any> {
    const res = await fetch(coreUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) {
      throw new Error(json.error?.msg ?? `HTTP ${res.status}`)
    }
    return json
  }

  async #get(coreUrl: string, path: string): Promise<any> {
    const res = await fetch(coreUrl + path)
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) {
      throw new Error(json.error?.msg ?? `HTTP ${res.status}`)
    }
    return json
  }

  async createCollection(spec: CollectionSpec, _ifNotExists: boolean): Promise<void> {
    const core = await this.#core(spec.collection)
    this.#dims.set(spec.collection, spec.vector.dimensions)
    const ftName = `knn_${spec.vector.dimensions}_${simFn(spec.vector.metric)}`
    try {
      // Ensure the dense-vector field type (idempotent: ignore "already exists").
      await this.#post(core, '/schema', {
        'add-field-type': {
          name: ftName,
          class: 'solr.DenseVectorField',
          vectorDimension: spec.vector.dimensions,
          similarityFunction: simFn(spec.vector.metric),
        },
      }).catch((e: unknown) => {
        if (!String(e).includes('already')) throw e
      })
      // Ensure the fields (idempotent per field).
      for (const f of [
        { name: 'vec', type: ftName, indexed: true, stored: true },
        { name: 'document', type: 'string', stored: true },
        { name: 'metadata', type: 'string', stored: true },
      ]) {
        await this.#post(core, '/schema', { 'add-field': f }).catch((e: unknown) => {
          if (!String(e).includes('already')) throw e
        })
      }
      // Start from an empty core for this logical collection.
      await this.#post(core, '/update?commit=true', { delete: { query: '*:*' } })
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async dropCollection(collection: string, _ifExists: boolean): Promise<void> {
    // Cores aren't created/destroyed at runtime here; "drop" clears the core's documents.
    try {
      const core = await this.#core(collection)
      await this.#post(core, '/update?commit=true', { delete: { query: '*:*' } })
      this.#dims.delete(collection)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    try {
      const core = await this.#core(collection)
      await this.#get(core, '/admin/ping')
      return true
    } catch {
      return false
    }
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'solr'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const core = await this.#core(plan.collection)
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
          vec: vector,
          document: r.document ?? '',
          metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
        })
      }
      // Solr upserts by id; commit so the write is visible to the next query.
      await this.#post(core, '/update?commit=true', docs)
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
    const core = await this.#core(plan.collection)
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const r = await this.#get(
          core,
          `/select?q=${encodeURIComponent('id:' + this.#escape(plan.near.id))}&fl=vec&rows=1`
        )
        const doc = r.response?.docs?.[0]
        if (!doc) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = doc.vec as number[]
      }
    }

    const offset = plan.offset ?? 0
    const fl = 'id,vec,document,metadata,score'
    try {
      let docs: any[]
      if (queryVector) {
        const k = (plan.filter ? 1000 : plan.topK + offset) || 10
        const q = `{!knn f=vec topK=${k}}[${queryVector.join(',')}]`
        const r = await this.#get(core, `/select?q=${encodeURIComponent(q)}&fl=${fl}&rows=${k}`)
        docs = r.response?.docs ?? []
      } else {
        const r = await this.#get(core, `/select?q=*:*&fl=${fl}&rows=100000`)
        docs = r.response?.docs ?? []
      }
      const filtered = plan.filter
        ? docs.filter((d) => evaluateFilter(plan.filter!, this.#parseMeta(d.metadata)))
        : docs
      return filtered
        .slice(offset, offset + plan.topK)
        .map((d) => this.#project(d, plan, !!queryVector))
    } catch (err) {
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  #escape(value: string): string {
    // Escape Solr query special chars for an id: term match.
    return value.replace(/([+\-!(){}[\]^"~*?:\\/ ])/g, '\\$1')
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

  #project(doc: any, plan: SearchPlan, isKnn: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = doc.id as string
    if (proj.vector && Array.isArray(doc.vec)) out.vector = (doc.vec as number[]).map(Number)
    if (proj.document) out.document = (doc.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(doc.metadata)
    if (isKnn && typeof doc.score === 'number') {
      // Solr's DenseVectorField cosine score is already in [0,1], higher = closer.
      out.score = doc.score
    }
    return out
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const core = await this.#core(plan.collection)
    try {
      if (plan.ids && plan.ids.length > 0) {
        await this.#post(core, '/update?commit=true', { delete: plan.ids })
      } else if (plan.filter) {
        const r = await this.#get(core, `/select?q=*:*&fl=id,metadata&rows=100000`)
        const docs = r.response?.docs ?? []
        const targets = docs
          .filter((d: any) => evaluateFilter(plan.filter!, this.#parseMeta(d.metadata)))
          .map((d: any) => d.id as string)
        if (targets.length > 0) {
          await this.#post(core, '/update?commit=true', { delete: targets })
        }
      } else {
        await this.#post(core, '/update?commit=true', { delete: { query: '*:*' } })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}
