/**
 * @module @nhtio/adk/batteries/vector/vespa
 *
 * Vespa vector-store adapter. A logical collection maps to a document-type in a deployed
 * application package; the adapter maintains the application-package STATE in memory (the set of
 * live collections + their dims/metric) and redeploys the whole package on each schema change
 * via the config server (dependency-free store-zip). Feed/get/delete/search are performed over
 * the document + search HTTP APIs; scores are recomputed locally (cosineSim/dotProd/euclideanDist)
 * to guarantee the [0,1] contract regardless of backend metric quirks. Metadata is a JSON string
 * field filtered with the neutral filter tree's JS reference evaluator for cross-adapter parity.
 *
 * Vespa has NO runtime "create collection". A collection = a document-type declared in a .sd schema
 * file inside a deployed application package. The adapter maintains the application-package STATE
 * in memory and redeploys the whole package on each schema change via the config server.
 */

import { evaluateFilter } from '../filters'
import { normalizeScore } from '../helpers'
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

// ZIP writer (no compression)
const crc32Table: number[] = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const storeZip = (files: Array<{ name: string; data: Buffer }>): Buffer => {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = f.data
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const local = Buffer.concat([lh, name, data])
    locals.push(local)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([ch, name]))
    offset += local.length
  }
  const cd = Buffer.concat(central)
  const localAll = Buffer.concat(locals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(localAll.length, 16)
  return Buffer.concat([localAll, cd, eocd])
}

const metricToVespa = (metric: DistanceMetric): string =>
  metric === 'cosine' ? 'angular' : metric === 'euclidean' ? 'euclidean' : 'dotproduct'

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
  for (const [i, av] of a.entries()) {
    s += av * b[i]
  }
  return s
}

const euclideanDist = (a: number[], b: number[]): number => {
  let s = 0
  for (const [i, av] of a.entries()) {
    const d = av - b[i]
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
    const raw = cosineSim(vec, query)
    return normalizeScore(raw, 'cosine', 'similarity')
  }
}

export interface VespaVectorStoreOptions extends BaseVectorStoreOptions {
  connection?: {
    endpoint?: string
    configUrl?: string
  }
}

export class VespaVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    consistency: { configurable: false, default: 'strong', modes: ['strong'] },
  }

  #collections: Map<string, { dims: number; metric: DistanceMetric }> = new Map()
  #connected: boolean = false

  get #opts(): VespaVectorStoreOptions {
    return this.options as VespaVectorStoreOptions
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined' && typeof fetch === 'function'
  }

  isAvailable(): boolean {
    return typeof process !== 'undefined' && typeof fetch === 'function'
  }

  async connect(): Promise<void> {
    if (this.#connected) return
    const endpoint = this.#endpoint()
    try {
      const res = await fetch(endpoint + '/ApplicationStatus')
      if (!res.ok) {
        const body = (await res.json()) as any
        throw new E_VECTOR_STORE_CONNECTION_FAILED([
          `Vespa config server unreachable: ${body?.message ?? res.statusText}`,
        ])
      }
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
    this.#connected = true
  }

  async close(): Promise<void> {
    this.#connected = false
  }

  #endpoint(): string {
    return this.#opts.connection?.endpoint ?? 'http://localhost:8080'
  }

  #configUrl(): string {
    return this.#opts.connection?.configUrl ?? 'http://localhost:19071'
  }

  #untilDate(): string {
    return new Date(Date.now() + 25 * 86400 * 1000).toISOString().slice(0, 10)
  }

  #buildPackage(): Buffer {
    const files: Array<{ name: string; data: Buffer }> = []

    // hosts.xml (constant)
    files.push({
      name: 'hosts.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="utf-8" ?>\n<hosts><host name="localhost"><alias>node1</alias></host></hosts>\n',
        'utf8'
      ),
    })

    // validation-overrides.xml
    const until = this.#untilDate()
    files.push({
      name: 'validation-overrides.xml',
      data: Buffer.from(
        `<validation-overrides>\n  <allow until="${until}">schema-removal</allow>\n  <allow until="${until}">field-type-change</allow>\n  <allow until="${until}">indexing-change</allow>\n</validation-overrides>\n`,
        'utf8'
      ),
    })

    // services.xml (one <document> line per live collection)
    let docLines = ''
    for (const [coll] of this.#collections) {
      docLines += `    <document type="${coll}" mode="index"/>\n`
    }
    if (docLines === '') docLines = '    <document type="empty" mode="index"/>\n'
    files.push({
      name: 'services.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="utf-8" ?>\n<services version="1.0">\n  <container id="default" version="1.0"><document-api/><search/></container>\n  <content id="docs" version="1.0">\n    <redundancy>1</redundancy>\n    <documents>\n${docLines}    </documents>\n    <nodes><node distribution-key="0" hostalias="node1"/></nodes>\n    <tuning><resource-limits><disk>0.97</disk><memory>0.95</memory></resource-limits></tuning>\n  </content>\n</services>\n`,
        'utf8'
      ),
    })

    // schemas/<coll>.sd
    for (const [coll, spec] of this.#collections) {
      const metric = metricToVespa(spec.metric)
      const sd = `schema ${coll} {\n  document ${coll} {\n    field id type string {\n      indexing: summary | attribute\n      attribute: fast-search\n    }\n    field vec type tensor<float>(x[${spec.dims}]) {\n      indexing: summary | attribute | index\n      attribute { distance-metric: ${metric} }\n      index { hnsw { max-links-per-node: 16 neighbors-to-explore-at-insert: 100 } }\n    }\n    field document type string { indexing: summary }\n    field metadata type string { indexing: summary }\n  }\n  rank-profile vector_nearest {\n    inputs { query(q) tensor<float>(x[${spec.dims}]) }\n    first-phase { expression: closeness(field, vec) }\n  }\n}\n`
      files.push({
        name: `schemas/${coll}.sd`,
        data: Buffer.from(sd, 'utf8'),
      })
    }

    return storeZip(files)
  }

  async #deploy(): Promise<void> {
    const url = this.#configUrl() + '/application/v2/tenant/default/prepareandactivate'
    const pkg = this.#buildPackage()
    // fetch's BodyInit doesn't accept a Node Buffer directly under the DOM lib types; a Uint8Array
    // view over the same bytes is an accepted BodyInit and avoids a copy.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      // The installed DOM lib's BodyInit doesn't list Uint8Array, but the runtime (undici/Node)
      // accepts a typed-array body fine — cast through the accepted union.
      body: new Uint8Array(pkg.buffer, pkg.byteOffset, pkg.byteLength) as unknown as BodyInit,
    })
    if (!res.ok) {
      const data = (await res.json()) as any
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['deploy', data?.message ?? `HTTP ${res.status}`])
    }
    // Poll ApplicationStatus until 200
    const endpoint = this.#endpoint()
    for (let i = 0; i < 60; i++) {
      try {
        const sres = await fetch(endpoint + '/ApplicationStatus')
        if (sres.ok) return
      } catch {
        // continue polling
      }
      await this.#sleep(1000)
    }
  }

  async #sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  #vecValues(field: any): number[] {
    if (field?.values && Array.isArray(field.values)) return field.values
    if (field?.cells && Array.isArray(field.cells)) {
      return field.cells.map((c: any) => c.value)
    }
    return []
  }

  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const coll = spec.collection
    if (this.#collections.has(coll)) {
      if (ifNotExists) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED([
        'createCollection',
        `collection already exists: ${coll}`,
      ])
    }
    this.#collections.set(coll, { dims: spec.vector.dimensions, metric: spec.vector.metric })
    try {
      await this.#deploy()
      // Wait for schema to be query-ready
      const endpoint = this.#endpoint()
      for (let i = 0; i < 30; i++) {
        try {
          const q = encodeURIComponent(`select id from ${coll} where true`)
          const res = await fetch(`${endpoint}/search/?yql=${q}&hits=1`)
          if (res.ok) break
        } catch {
          // continue polling
        }
        await this.#sleep(500)
      }
      // Clear any residual documents (redeploy preserves data)
      await this.#clearCollection(coll)
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['createCollection', String(err)])
    }
  }

  async #clearCollection(coll: string): Promise<void> {
    try {
      const endpoint = this.#endpoint()
      const res = await fetch(
        `${endpoint}/document/v1/default/${coll}/docid?selection=true&cluster=docs`,
        {
          method: 'DELETE',
        }
      )
      if (!res.ok) {
        const body = (await res.json()) as any
        // Ignore 404 for non-existing collection
        if (body?.message?.includes('No document type') || res.status === 404) {
          return
        }
      }
    } catch {
      // Ignore errors during clear
    }
  }

  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (!this.#collections.has(collection)) {
      if (ifExists) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED([
        'dropCollection',
        `collection not found: ${collection}`,
      ])
    }
    try {
      await this.#clearCollection(collection)
      this.#collections.delete(collection)
      if (this.#collections.size === 0) {
        // Do not redeploy an empty content cluster; just forget it locally
        return
      }
      await this.#deploy()
    } catch (err) {
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  async hasCollection(collection: string): Promise<boolean> {
    return this.#collections.has(collection)
  }

  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'vespa'])
  }

  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    const coll = plan.collection
    const endpoint = this.#endpoint()
    const dims = this.#opts.dimensions ?? this.#collections.get(coll)?.dims
    try {
      const ids = []
      for (const r of plan.records) {
        let vector = r.vector
        if (!vector && r.document) {
          const [v] = await this.encode([r.document], 'document')
          vector = v
        }
        if (!vector) {
          throw new E_VECTOR_STORE_UPSERT_FAILED(['Record missing vector and document'])
        }
        if (dims !== undefined && vector.length !== dims) {
          throw new E_VECTOR_STORE_DIMENSION_MISMATCH([dims, vector.length])
        }
        const body = {
          fields: {
            id: r.id,
            vec: { values: vector },
            document: r.document ?? '',
            metadata: r.metadata ? JSON.stringify(r.metadata) : '{}',
          },
        }
        const res = await fetch(
          `${endpoint}/document/v1/default/${coll}/docid/${encodeURIComponent(r.id)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
        if (!res.ok) {
          const errData = (await res.json()) as any
          throw new Error(errData?.message ?? `HTTP ${res.status}`)
        }
        ids.push(r.id)
      }
      // Brief settle for HNSW index
      await this.#sleep(500)
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
    const endpoint = this.#endpoint()
    const metric = this.#collections.get(coll)?.metric ?? this.#opts.metric ?? 'cosine'
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const res = await fetch(
          `${endpoint}/document/v1/default/${coll}/docid/${encodeURIComponent(plan.near.id)}`
        )
        if (!res.ok) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        const data = (await res.json()) as any
        const vec = this.#vecValues(data.fields?.vec)
        if (!vec || vec.length === 0) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = vec
      }
    }

    const offset = plan.offset ?? 0
    const topK = plan.topK ?? 10
    const k = plan.filter ? 400 : topK + offset
    const yql = queryVector
      ? `select id, document, metadata, vec from ${coll} where {targetHits:${k}}nearestNeighbor(vec, q)`
      : `select id, document, metadata, vec from ${coll} where true`

    try {
      const body: any = {
        yql,
        hits: k,
      }
      if (queryVector) {
        body['input.query(q)'] = queryVector
        body['ranking.profile'] = 'vector_nearest'
      }
      const res = await fetch(`${endpoint}/search/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = (await res.json()) as any
      const root = data.root as any
      const children = root.children ?? []

      if (queryVector) {
        const filtered = children
          .filter((c: any) =>
            evaluateFilter(plan.filter ?? {}, this.#parseMeta(c.fields?.metadata))
          )
          .map((c: any) => {
            const vec = this.#vecValues(c.fields?.vec)
            const score = computeScore(vec, queryVector, metric)
            return { ...c.fields, score }
          })
        filtered.sort((a: any, b: any) => b.score - a.score)
        return filtered.slice(offset, offset + topK).map((d: any) => this.#project(d, plan, true))
      } else {
        const filtered = children.filter((c: any) =>
          evaluateFilter(plan.filter ?? {}, this.#parseMeta(c.fields?.metadata))
        )
        return filtered.slice(offset, offset + topK).map((d: any) => this.#project(d, plan, false))
      }
    } catch (err) {
      if ((err as any)?.message?.includes('Referenced id not found')) {
        throw err
      }
      throw new E_VECTOR_STORE_SEARCH_FAILED([String(err)])
    }
  }

  async executeDelete(plan: DeletePlan): Promise<void> {
    const coll = plan.collection
    const endpoint = this.#endpoint()
    try {
      if (plan.ids && plan.ids.length > 0) {
        for (const id of plan.ids) {
          const res = await fetch(
            `${endpoint}/document/v1/default/${coll}/docid/${encodeURIComponent(id)}`,
            { method: 'DELETE' }
          )
          if (!res.ok && res.status !== 404) {
            const body = (await res.json()) as any
            throw new Error(body?.message ?? `HTTP ${res.status}`)
          }
        }
      } else if (plan.filter) {
        const yql = `select id, metadata, vec from ${coll} where true`
        const res = await fetch(`${endpoint}/search/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ yql, hits: 400 }),
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const data = (await res.json()) as any
        const children = data.root.children ?? []
        const targets = children
          .filter((c: any) => evaluateFilter(plan.filter!, this.#parseMeta(c.fields?.metadata)))
          .map((c: any) => c.fields?.id)
        for (const id of targets) {
          await fetch(`${endpoint}/document/v1/default/${coll}/docid/${encodeURIComponent(id)}`, {
            method: 'DELETE',
          })
        }
      } else {
        await fetch(`${endpoint}/document/v1/default/${coll}/docid?selection=true&cluster=docs`, {
          method: 'DELETE',
        })
      }
    } catch (err) {
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
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

  #project(doc: any, plan: SearchPlan, hasScore: boolean): VectorMatch {
    const proj = plan.projection
    const out: VectorMatch = {}
    if (proj.id) out.id = doc.id as string
    if (proj.vector) {
      const vec = this.#vecValues(doc.vec)
      if (vec && vec.length > 0) out.vector = vec.map(Number)
    }
    if (proj.document) out.document = (doc.document ?? undefined) as string | undefined
    if (proj.metadata) out.metadata = this.#parseMeta(doc.metadata)
    if (hasScore && typeof doc.score === 'number') {
      out.score = doc.score
    }
    return out
  }
}
