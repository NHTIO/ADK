/**
 * @module @nhtio/adk/batteries/vector/pinecone
 */

import { normalizeScore } from '../helpers'
import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import { isFilterCondition, isRawFilter, isFilterGroup, evaluateFilter } from '../filters'
import {
  E_VECTOR_STORE_DRIVER_UNAVAILABLE,
  E_VECTOR_STORE_COLLECTION_FAILED,
  E_VECTOR_STORE_UPSERT_FAILED,
  E_VECTOR_STORE_SEARCH_FAILED,
  E_VECTOR_STORE_DELETE_FAILED,
  E_VECTOR_STORE_DIMENSION_MISMATCH,
  E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR,
  E_VECTOR_STORE_UNSUPPORTED_OPERATION,
  E_VECTOR_STORE_CONNECTION_FAILED,
  E_VECTOR_STORE_CONSISTENCY_TIMEOUT,
} from '../exceptions'
import type { VectorFilter } from '../filters'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from '../plan'
import type {
  VectorMatch,
  VectorStoreCapabilities,
  BaseVectorStoreOptions,
  VectorMetadata,
  VectorConsistency,
} from '../types'

export interface PineconeVectorStoreOptions extends BaseVectorStoreOptions {
  apiKey: string
  index: string
  /**
   * When set, the physical Pinecone namespace becomes `${namespacePrefix}__${collection}`.
   * The logical collection name the builder/base see is unchanged — only the physical
   * namespace string is prefixed. Lets callers (and the test suite) isolate otherwise
   * identically-named collections into distinct, uncontended namespaces. Pinecone
   * namespaces are implicit (born on first upsert), so a fresh prefix costs nothing.
   */
  namespacePrefix?: string
  connection?: { controllerHostUrl?: string }
}

const getPineconeClient = async () => {
  try {
    const mod = await import('@pinecone-database/pinecone')
    return mod.Pinecone
  } catch {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE(['@pinecone-database/pinecone'])
  }
}

export class PineconeVectorStore extends BaseVectorStore {
  readonly capabilities: VectorStoreCapabilities = {
    transactions: false,
    namedVectors: false,
    rename: false,
    rawSql: false,
    builtInEncoding: false,
    // Pinecone serverless is eventually consistent: the option is honored, and the default
    // is 'strong' so out-of-the-box behavior matches the strongly-consistent adapters.
    consistency: {
      configurable: true,
      default: 'strong',
      modes: ['strong', 'best-effort', 'eventual'],
    },
  }
  #pc: any | null = null
  #index: any | null = null
  #dims: Map<string, number> = new Map()

  // Resolve the effective consistency mode for one write, honoring precedence:
  //   per-operation override (plan.consistency) > store option > adapter-declared default.
  #consistencyMode(perOp?: VectorConsistency): VectorConsistency {
    return (
      perOp ??
      (this.options as PineconeVectorStoreOptions).consistency ??
      this.capabilities.consistency.default
    )
  }

  // Map a logical collection name to its physical Pinecone namespace. Only the physical
  // namespace string is prefixed; #dims and everything the base/builder see stay keyed on
  // the logical name.
  #ns(collection: string): string {
    const prefix = (this.options as PineconeVectorStoreOptions).namespacePrefix
    return prefix ? `${prefix}__${collection}` : collection
  }

  // Returns true if visibility was confirmed within the bound, false on timeout.
  // Polls the SAME read paths the adapter reads through downstream:
  //   present ids → must appear in BOTH query() matches AND listPaginated()
  //   absent  ids → must be gone from BOTH listPaginated() AND fetch()
  async #waitVisible(
    ns: any,
    collection: string,
    opts: { present?: string[]; absent?: string[]; probeVector?: number[] }
  ): Promise<boolean> {
    const present = opts.present ?? []
    const absent = opts.absent ?? []
    if (present.length === 0 && absent.length === 0) return true
    const physicalNs = this.#ns(collection)
    const dims = this.#dims.get(collection) ?? 3
    const queryVec = opts.probeVector ?? new Array(dims).fill(0).map((_, i) => (i === 0 ? 1 : 0))
    const deadline = Date.now() + 10_000 // 10s ceiling; freshness is ~seconds
    const topK = Math.max(present.length + absent.length + 5, 10)
    while (true) {
      let presentOk = true
      let absentOk = true
      if (present.length > 0) {
        let listed = new Set<string>()
        try {
          const lr = await this.#index!.listPaginated({ namespace: physicalNs, limit: 100 })
          listed = new Set((lr.vectors ?? []).map((v: any) => v.id))
        } catch {
          listed = new Set()
        }
        let queried = new Set<string>()
        try {
          const qr = await ns.query({ vector: queryVec, topK, includeValues: false })
          queried = new Set((qr.matches ?? []).map((m: any) => m.id))
        } catch {
          queried = new Set()
        }
        presentOk = present.every((id) => listed.has(id) && queried.has(id))
      }
      if (absent.length > 0) {
        let listed = new Set<string>()
        try {
          const lr = await this.#index!.listPaginated({ namespace: physicalNs, limit: 1000 })
          listed = new Set((lr.vectors ?? []).map((v: any) => v.id))
        } catch {
          listed = new Set()
        }
        let fetched: Record<string, unknown> = {}
        try {
          const fr = await ns.fetch({ ids: absent })
          fetched = fr.records ?? {}
        } catch {
          fetched = {}
        }
        absentOk = absent.every((id) => !listed.has(id) && fetched[id] === undefined)
      }
      if (presentOk && absentOk) return true
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  // Apply the resolved consistency-mode semantics for one write:
  //   strong      → wait, and THROW E_VECTOR_STORE_CONSISTENCY_TIMEOUT if not confirmed.
  //   best-effort → wait up to the bound, then resolve whether or not confirmed (no throw).
  //   eventual    → no wait at all.
  // `mode` is the effective mode for THIS operation (already resolved from the precedence
  // chain by the caller via #consistencyMode(plan.consistency)).
  async #settle(
    ns: any,
    collection: string,
    opts: { present?: string[]; absent?: string[] },
    what: string,
    mode: VectorConsistency
  ): Promise<void> {
    if (mode === 'eventual') return
    const confirmed = await this.#waitVisible(ns, collection, opts)
    if (!confirmed && mode === 'strong') {
      throw new E_VECTOR_STORE_CONSISTENCY_TIMEOUT([what])
    }
    // best-effort: resolve regardless
  }

  static isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  isAvailable(): boolean {
    return typeof process !== 'undefined'
  }
  async connect(): Promise<void> {
    if (this.#pc) return
    const Pinecone = await getPineconeClient()
    const opts = this.options as PineconeVectorStoreOptions
    try {
      this.#pc = new Pinecone({ apiKey: opts.apiKey, ...opts.connection })
      this.#index = this.#pc.index(opts.index)
    } catch (err) {
      throw new E_VECTOR_STORE_CONNECTION_FAILED([String(err)])
    }
  }
  async close(): Promise<void> {
    this.#pc = null
    this.#index = null
  }
  async createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void> {
    const collection = spec.collection
    if (ifNotExists) {
      if (await this.hasCollection(collection)) return
    }
    if (this.#dims.has(collection)) {
      const existingDim = this.#dims.get(collection)!
      if (existingDim !== spec.vector.dimensions) {
        throw new E_VECTOR_STORE_COLLECTION_FAILED([
          'createCollection',
          `Collection ${collection} already exists with dimension ${existingDim}`,
        ])
      }
      return
    }
    this.#dims.set(collection, spec.vector.dimensions)
  }
  async dropCollection(collection: string, ifExists: boolean): Promise<void> {
    if (ifExists) {
      if (!(await this.hasCollection(collection))) return
    } else if (!(await this.hasCollection(collection))) {
      return
    }
    await this.connect()
    const physicalNs = this.#ns(collection)
    const ns = this.#index!.namespace(physicalNs)
    try {
      // Get all IDs via pagination
      let page: any = { next: null }
      const ids: string[] = []
      do {
        const lr = await this.#index!.listPaginated({
          namespace: physicalNs,
          limit: 1000,
          startingToken: page.next,
        })
        if (lr.vectors) ids.push(...lr.vectors.map((v: any) => v.id))
        page.next = lr.pagination?.next
      } while (page.next)

      // Delete all found IDs
      if (ids.length > 0) {
        await ns.deleteMany({ ids })
      }

      // Settle on absence
      await this.#settle(
        ns,
        collection,
        { absent: ids },
        'dropCollection ' + collection,
        this.#consistencyMode()
      )
    } catch (err: any) {
      // Re-throw consistency timeout directly (don't swallow)
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_CONSISTENCY_TIMEOUT', E_VECTOR_STORE_CONSISTENCY_TIMEOUT)
      )
        throw err
      const msg = String(err)
      if (ifExists && msg.includes('not found')) return
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', msg])
    }
  }
  async hasCollection(collection: string): Promise<boolean> {
    await this.connect()
    const stats = await this.#index!.describeIndexStats()
    return !!stats.namespaces?.[this.#ns(collection)]
  }
  async renameCollection(_from: string, _to: string): Promise<void> {
    throw new E_VECTOR_STORE_UNSUPPORTED_OPERATION(['renameCollection', 'pinecone'])
  }
  async executeUpsert(plan: UpsertPlan): Promise<void> {
    if (plan.records.length === 0) return
    validateRecords(plan.records)
    await this.connect()
    const collection = plan.collection
    const ns = this.#index!.namespace(this.#ns(collection))
    const dims = this.#dims.get(collection)
    const vectors: any[] = []
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
      vectors.push({
        id: r.id,
        values: vector,
        metadata: { ...r.metadata, __document: r.document ?? '' },
      })
    }
    try {
      await ns.upsert({ records: vectors })
      // Call settle after upsert to wait for visibility (per-op override > store > default)
      await this.#settle(
        ns,
        collection,
        { present: vectors.map((v) => v.id) },
        'upsert ' + vectors.length + ' record(s)',
        this.#consistencyMode(plan.consistency)
      )
    } catch (err) {
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_CONSISTENCY_TIMEOUT', E_VECTOR_STORE_CONSISTENCY_TIMEOUT)
      )
        throw err
      throw new E_VECTOR_STORE_UPSERT_FAILED([String(err)])
    }
  }
  async executeSearch(plan: SearchPlan): Promise<VectorMatch[]> {
    await this.connect()
    const collection = plan.collection
    const physicalNs = this.#ns(collection)
    const ns = this.#index!.namespace(physicalNs)
    const metric = this.options.metric ?? 'cosine'
    let queryVector: number[] | undefined
    if (plan.near) {
      if ('vector' in plan.near) {
        queryVector = plan.near.vector
      } else if ('serverText' in plan.near) {
        const [v] = await this.encode([plan.near.serverText], 'query')
        queryVector = v
      } else if ('id' in plan.near) {
        const res = await ns.fetch({ ids: [plan.near.id] })
        const record = res.records[plan.near.id]
        if (!record) {
          throw new E_VECTOR_STORE_SEARCH_FAILED(['Referenced id not found: ' + plan.near.id])
        }
        queryVector = record.values
      }
    }
    const offset = plan.offset ?? 0
    const k = plan.topK + offset
    if (queryVector) {
      const filter = translatePineconeFilter(plan.filter)
      const res = await ns.query({
        vector: queryVector,
        topK: k,
        filter,
        includeMetadata: true,
        includeValues: !!plan.projection.vector,
      })
      const rawMatches = res.matches ?? []
      const sliceMatches = rawMatches.slice(offset)
      const matches: VectorMatch[] = []
      for (const match of sliceMatches) {
        const proj: VectorMatch = {}
        if (plan.projection.id) {
          proj.id = match.id
        }
        if (plan.projection.vector && match.values) {
          proj.vector = match.values
        }
        if (plan.projection.document && match.metadata) {
          proj.document = match.metadata.__document
        }
        if (plan.projection.metadata && match.metadata) {
          const meta: VectorMetadata = {}
          for (const key in match.metadata) {
            if (key !== '__document') {
              meta[key] = match.metadata[key]
            }
          }
          proj.metadata = meta
        }
        if (plan.near) {
          proj.score = normalizeScore(match.score!, metric, 'similarity')
        }
        matches.push(proj)
      }
      return matches
    } else {
      // Filter-scan: Pinecone v7 listPaginated filter is broken, so we get all records
      // and filter client-side. First, get all IDs without filter, then fetch.
      let page: any = { next: null }
      const ids: string[] = []
      do {
        // Get all IDs without filter - Pinecone v7 listPaginated without filter works
        const listRes = await this.#index!.listPaginated({
          limit: 100,
          startingToken: page.next,
          namespace: physicalNs,
        })
        if (listRes.vectors) {
          ids.push(...listRes.vectors.map((v: any) => v.id))
        }
        page.next = listRes.pagination?.next
      } while (page.next)
      if (ids.length === 0) return []

      // Fetch all records and filter client-side
      const allRecords: any = {}
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100)
        const fetchRes = await ns.fetch({ ids: batch })
        if (fetchRes && fetchRes.records) {
          for (const id in fetchRes.records) {
            allRecords[id] = fetchRes.records[id]
          }
        }
      }
      const matches: VectorMatch[] = []
      for (const id in allRecords) {
        const record = allRecords[id]
        if (record.metadata) {
          const evalMeta: VectorMetadata = {}
          for (const key in record.metadata) {
            if (key !== '__document') {
              evalMeta[key] = record.metadata[key]
            }
          }
          // If no filter, include all records; otherwise evaluate the filter
          if (!plan.filter || evaluateFilter(plan.filter, evalMeta)) {
            const proj: VectorMatch = {}
            if (plan.projection.id) {
              proj.id = id
            }
            if (plan.projection.vector && record.values) {
              proj.vector = record.values
            }
            if (plan.projection.document && record.metadata) {
              proj.document = record.metadata.__document
            }
            if (plan.projection.metadata && record.metadata) {
              const meta: VectorMetadata = {}
              for (const key in record.metadata) {
                if (key !== '__document') {
                  meta[key] = record.metadata[key]
                }
              }
              proj.metadata = meta as VectorMetadata
            }
            matches.push(proj)
          }
        }
      }
      return matches.slice(offset, offset + plan.topK)
    }
  }
  async executeDelete(plan: DeletePlan): Promise<void> {
    await this.connect()
    const collection = plan.collection
    const physicalNs = this.#ns(collection)
    const ns = this.#index!.namespace(physicalNs)
    const mode = this.#consistencyMode(plan.consistency)
    try {
      if (plan.ids && plan.ids.length > 0) {
        await ns.deleteMany({ ids: plan.ids })
        // Call settle after delete-by-ids to wait for absence
        await this.#settle(ns, collection, { absent: plan.ids }, 'delete by id', mode)
      } else if (plan.filter) {
        // Pinecone v7 listPaginated filter is broken, and Pinecone doesn't support
        // filtering by record ID. Get all IDs and filter client-side.
        let page: any = { next: null }
        const ids: string[] = []
        do {
          const listRes = await this.#index!.listPaginated({
            limit: 1000,
            startingToken: page.next,
            namespace: physicalNs,
          })
          if (listRes.vectors) {
            ids.push(...listRes.vectors.map((v: any) => v.id))
          }
          page.next = listRes.pagination?.next
        } while (page.next)

        // For Pinecone, we can only filter by metadata fields.
        // If the filter is on 'id', filter client-side without metadata.
        // Otherwise, fetch records and filter by metadata.
        const deleteIds: string[] = []

        // Check if filter targets 'id' field (Pinecone record ID)
        const filterTargetsId = plan.filter ? isFilterOnId(plan.filter) : false

        if (filterTargetsId) {
          // Filter by record ID directly
          for (const id of ids) {
            if (evaluateFilter(plan.filter, { id })) {
              deleteIds.push(id)
            }
          }
        } else {
          // Filter by metadata
          for (const id of ids) {
            const res = await ns.fetch({ ids: [id] })
            const record = res.records[id]
            if (record && record.metadata) {
              const evalMeta: VectorMetadata = {}
              for (const key in record.metadata) {
                if (key !== '__document') {
                  evalMeta[key] = record.metadata[key]
                }
              }
              if (evaluateFilter(plan.filter, evalMeta)) {
                deleteIds.push(id)
              }
            }
          }
        }

        if (deleteIds.length > 0) {
          await ns.deleteMany({ ids: deleteIds })
          // Call settle after delete-by-filter to wait for absence
          await this.#settle(ns, collection, { absent: deleteIds }, 'delete by filter', mode)
        }
      } else {
        // Delete all via list+deleteMany pattern (no more deleteAll + settleEmpty)
        let page: any = { next: null }
        const allIds: string[] = []
        do {
          const lr = await this.#index!.listPaginated({
            namespace: physicalNs,
            limit: 1000,
            startingToken: page.next,
          })
          if (lr.vectors) allIds.push(...lr.vectors.map((v: any) => v.id))
          page.next = lr.pagination?.next
        } while (page.next)

        if (allIds.length > 0) {
          await ns.deleteMany({ ids: allIds })
        }
        // Settle on absence
        await this.#settle(ns, collection, { absent: allIds }, 'delete all', mode)
      }
    } catch (err) {
      // Re-throw consistency timeout directly (don't swallow)
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_CONSISTENCY_TIMEOUT', E_VECTOR_STORE_CONSISTENCY_TIMEOUT)
      )
        throw err
      throw new E_VECTOR_STORE_DELETE_FAILED([String(err)])
    }
  }
}

// Check if a filter targets the 'id' field (Pinecone record ID)
const isFilterOnId = (filter?: VectorFilter): boolean => {
  if (!filter) return false
  if (isRawFilter(filter)) {
    return false
  }
  if (isFilterCondition(filter)) {
    return filter.field === 'id'
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and && and.length > 0) {
      return and.some((f) => isFilterOnId(f))
    }
    if (or && or.length > 0) {
      return or.some((f) => isFilterOnId(f))
    }
    if (not) {
      return isFilterOnId(not)
    }
  }
  return false
}

export const translatePineconeFilter = (
  filter?: VectorFilter
): Record<string, unknown> | undefined => {
  if (!filter) return undefined
  if (isRawFilter(filter)) {
    if (filter.$dialect === 'pinecone') {
      return filter.$raw as Record<string, unknown>
    }
    throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['pinecone', String(filter.$dialect)])
  }
  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    if (value === undefined) {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['pinecone', op])
    }
    if (op === 'eq') {
      return { [field]: { $eq: value } }
    }
    if (op === 'ne') {
      return { [field]: { $ne: value } }
    }
    if (op === 'gt') {
      return { [field]: { $gt: value } }
    }
    if (op === 'gte') {
      return { [field]: { $gte: value } }
    }
    if (op === 'lt') {
      return { [field]: { $lt: value } }
    }
    if (op === 'lte') {
      return { [field]: { $lte: value } }
    }
    if (op === 'in') {
      return { [field]: { $in: value } }
    }
    if (op === 'nin') {
      return { [field]: { $nin: value } }
    }
    if (op === 'exists') {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['pinecone', op])
    }
    if (op === 'contains') {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['pinecone', op])
    }
    return undefined
  }
  if (isFilterGroup(filter)) {
    const { and, or, not } = filter
    if (and) {
      const children = and
        .map((f) => translatePineconeFilter(f) as Record<string, unknown>)
        .filter((c) => c !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return { $and: children }
    }
    if (or) {
      const children = or
        .map((f) => translatePineconeFilter(f) as Record<string, unknown>)
        .filter((c) => c !== undefined)
      if (children.length === 0) return undefined
      if (children.length === 1) return children[0]
      return { $or: children }
    }
    if (not) {
      throw new E_VECTOR_STORE_UNSUPPORTED_FILTER_OPERATOR(['pinecone', 'not'])
    }
    return undefined
  }
  return undefined
}
