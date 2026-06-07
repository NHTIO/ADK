/**
 * @module @nhtio/adk/batteries/vector/in_memory
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { E_VECTOR_STORE_DIMENSION_MISMATCH } from '../exceptions'
import type { VectorMatch, VectorStoreCapabilities, BaseVectorStoreOptions } from '../types'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec, Projection } from '../plan'

export interface InMemoryVectorStoreOptions extends BaseVectorStoreOptions {}

interface StoredRow {
  id: string
  vector?: number[]
  document?: string
  metadata?: Record<string, unknown>
}

export class InMemoryVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: true,
    rawSql: false,
    builtInEncoding: false,
    // Strongly consistent: a write is visible on resolve, so the option is a no-op.
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }
  #collections = new Map<string, Map<string, StoredRow>>()
  #dims = new Map<string, number>()

  static isAvailable(): boolean {
    return true
  }
  isAvailable(): boolean {
    return true
  }
  async connect(): Promise<void> {
    /* no-op */
  }
  async close(): Promise<void> {
    /* no-op */
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    if (this.#collections.has(spec.collection)) {
      if (!ifNotExists) {
        throw new Error(`Collection "${spec.collection}" already exists`)
      }
      return
    }
    this.#collections.set(spec.collection, new Map())
    this.#dims.set(spec.collection, spec.vector.dimensions)
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (!this.#collections.has(collection)) {
      if (!ifExists) {
        throw new Error(`Collection "${collection}" does not exist`)
      }
      return
    }
    this.#collections.delete(collection)
    this.#dims.delete(collection)
  }

  async hasCollection(collection: string): Promise<boolean> {
    return this.#collections.has(collection)
  }

  async renameCollection(from: string, to: string): Promise<void> {
    const m = this.#collections.get(from)
    if (!m) {
      throw new Error(`Collection "${from}" does not exist`)
    }
    if (this.#collections.has(to)) {
      throw new Error(`Collection "${to}" already exists`)
    }
    this.#collections.set(to, m)
    this.#collections.delete(from)
    const d = this.#dims.get(from)
    if (d !== undefined) {
      this.#dims.set(to, d)
      this.#dims.delete(from)
    }
  }

  #coll(collection: string): Map<string, StoredRow> {
    let m = this.#collections.get(collection)
    if (!m) {
      m = new Map()
      this.#collections.set(collection, m)
    }
    return m
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const expected = this.#dims.get(plan.collection)
    const m = this.#coll(plan.collection)
    for (const r of plan.records) {
      let vector = r.vector
      if (!vector && r.document) {
        const [v] = await this.encode([r.document], 'document')
        vector = v
      }
      if (vector && expected !== undefined && vector.length !== expected) {
        throw new E_VECTOR_STORE_DIMENSION_MISMATCH([expected, vector.length])
      }
      m.set(r.id, {
        id: r.id,
        vector,
        document: r.document,
        metadata: r.metadata as Record<string, unknown> | undefined,
      })
    }
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const m = this.#coll(plan.collection)
    if (plan.ids) {
      for (const id of plan.ids) m.delete(id)
      return
    }
    if (plan.filter) {
      for (const [id, row] of [...m]) {
        if (evaluateFilter(plan.filter, (row.metadata ?? {}) as any)) m.delete(id)
      }
      return
    }
    m.clear()
  }

  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    const m = this.#coll(plan.collection)
    let rows = [...m.values()]
    if (plan.filter)
      rows = rows.filter((row) => evaluateFilter(plan.filter!, (row.metadata ?? {}) as any))
    let scored: { row: StoredRow; score?: number }[]
    if (plan.near && 'vector' in plan.near) {
      scored = rows.map((row) => ({
        row,
        score: this.#cosineLikeScore(plan.near as { vector: number[] }, row, plan),
      }))
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    } else if (plan.near && 'serverText' in plan.near) {
      const [qv] = await this.encode([plan.near.serverText], 'query')
      scored = rows.map((row) => ({ row, score: this.#scoreVec(qv, row.vector, plan) }))
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    } else if (plan.near && 'id' in plan.near) {
      const ref = m.get(plan.near.id)
      const qv = ref?.vector
      scored = rows.map((row) => ({
        row,
        score: qv ? this.#scoreVec(qv, row.vector, plan) : undefined,
      }))
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    } else {
      scored = rows.map((row) => ({ row }))
    }
    const limited = scored.slice(plan.offset ?? 0, (plan.offset ?? 0) + plan.topK)
    return limited.map(({ row, score }) => this.#project(row, score, plan.projection))
  }

  #scoreVec(q: number[], v: number[] | undefined, _plan: SearchPlan): number | undefined {
    if (!v) return undefined
    const metric = this.options.metric ?? 'cosine'
    let raw: number
    if (metric === 'cosine') {
      const dot = this.#dot(q, v)
      const na = Math.sqrt(this.#dot(q, q))
      const nb = Math.sqrt(this.#dot(v, v))
      raw = na && nb ? dot / (na * nb) : 0
      return normalizeScore(raw, 'cosine', 'similarity')
    }
    if (metric === 'dot') {
      raw = this.#dot(q, v)
      return normalizeScore(raw, 'dot', 'similarity')
    }
    let s = 0
    for (let i = 0; i < Math.min(q.length, v.length); i++) {
      const d = q[i] - v[i]
      s += d * d
    }
    raw = Math.sqrt(s)
    return normalizeScore(raw, 'euclidean', 'distance')
  }

  #cosineLikeScore(
    near: { vector: number[] },
    row: StoredRow,
    plan: SearchPlan
  ): number | undefined {
    return this.#scoreVec(near.vector, row.vector, plan)
  }

  #dot(a: number[], b: number[]): number {
    let s = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]
    return s
  }

  #project(row: StoredRow, score: number | undefined, p: Projection): VectorMatch {
    const out: VectorMatch = {}
    if (p.id) out.id = row.id
    if (score !== undefined) out.score = score
    if (p.vector && row.vector) out.vector = row.vector
    if (p.document && row.document !== undefined) out.document = row.document
    if (p.metadata && row.metadata !== undefined) out.metadata = row.metadata as any
    return out
  }
}
