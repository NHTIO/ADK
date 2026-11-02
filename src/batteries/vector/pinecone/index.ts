/**
 * @module @nhtio/adk/batteries/vector/pinecone
 */

import { BaseVectorStore } from '../contract'
import { validateRecords } from '../validation'
import { isInstanceOf, isObject } from '@nhtio/adk/guards'
import { normalizeScore, sanitizeMetadata } from '../helpers'
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
  /** Pinecone API key. */
  apiKey: string
  /** Name of the Pinecone index this store operates against. */
  index: string
  /**
   * When set, the physical Pinecone namespace becomes `${namespacePrefix}__${collection}`.
   * The logical collection name the builder/base see is unchanged — only the physical
   * namespace string is prefixed. Lets callers (and the test suite) isolate otherwise
   * identically-named collections into distinct, uncontended namespaces. Pinecone
   * namespaces are implicit (born on first upsert), so a fresh prefix costs nothing.
   */
  namespacePrefix?: string
  /** Connection and authentication parameters for the backend. */
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
  // Deployment type of the index, resolved ONCE per store via the control-plane describeIndex().
  // deleteNamespace() is serverless-only, so this decides whether a drop reclaims the namespace
  // or only its vectors. `undefined` means "not resolved yet"; 'unknown' means the control plane
  // could not tell us (describe failed, or an injected client has no control-plane API).
  #indexType: 'serverless' | 'pod' | 'unknown' | undefined

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

  // Resolve (and cache) whether this index is serverless, pod-based, or unknown. Pod-based
  // indexes reject deleteNamespace(), so dropping one must stay vectors-only.
  async #resolveIndexType(): Promise<'serverless' | 'pod' | 'unknown'> {
    if (this.#indexType !== undefined) return this.#indexType
    try {
      const pc = this.#pc
      if (!pc || typeof pc.describeIndex !== 'function') {
        // BYO client without a control plane — probe deleteNamespace() instead.
        this.#indexType = 'unknown'
        return this.#indexType
      }
      const model = await pc.describeIndex((this.options as PineconeVectorStoreOptions).index)
      const spec = model?.spec
      this.#indexType = spec?.serverless ? 'serverless' : spec?.pod ? 'pod' : 'unknown'
    } catch (err) {
      // A structured 404 means the INDEX itself is absent — a real failure, not a
      // "control plane unavailable" condition — so surface it rather than guessing the
      // deployment type. Any other describe failure falls back to probing deleteNamespace().
      if (isNamespaceAbsent(err)) throw err
      this.#indexType = 'unknown'
    }
    return this.#indexType
  }

  // Delete the whole namespace (records included) on serverless indexes. A namespace that is
  // already gone is a no-op: ONLY structured absence signals are tolerated — free-text messages
  // are surfaced, since matching them would swallow unrelated failures.
  async #deleteNamespace(physicalNs: string): Promise<void> {
    try {
      await this.#index!.deleteNamespace(physicalNs)
    } catch (err) {
      if (!isNamespaceAbsent(err)) throw err
    }
  }

  // Resolve a namespace's existence via the namespace-enumeration API. Unlike
  // describeIndexStats(), the namespace API is guaranteed to list an existing-but-empty
  // namespace. describeNamespace() (SDK 7.2.0) is a single exact call; listNamespaces() is the
  // paginated fallback, consulted BOTH when describeNamespace() is unavailable AND when it
  // fails for a NON-404 reason: an inconclusive describe must not stop a listing that could
  // still settle the question definitively (e.g. a strong-mode reclaim timing out on a
  // namespace that listNamespaces() already proves gone). 'unknown' means every AVAILABLE probe
  // was inconclusive (no API at all, or a failure other than a structured 404) — callers must
  // not read it as absence. `onProbeError` (optional) reports each failed probe so callers can
  // classify the failure (e.g. the pod "not supported" signal in hasCollection()).
  async #namespaceState(
    physicalNs: string,
    onProbeError?: (phase: 'describe' | 'list', err: unknown) => void
  ): Promise<'present' | 'absent' | 'unknown'> {
    const index = this.#index!
    if (typeof index.describeNamespace === 'function') {
      try {
        await index.describeNamespace(physicalNs)
        return 'present'
      } catch (err) {
        if (isNamespaceAbsent(err)) return 'absent'
        // Inconclusive, NOT absent: fall through to the listNamespaces probe below.
        onProbeError?.('describe', err)
      }
    }
    if (typeof index.listNamespaces === 'function') {
      let token: string | undefined
      try {
        do {
          const page = await index.listNamespaces({
            limit: 99,
            ...(token ? { paginationToken: token } : {}),
          })
          if ((page.namespaces ?? []).some((n: any) => n.name === physicalNs)) return 'present'
          token = page.pagination?.next
        } while (token)
        return 'absent'
      } catch (err) {
        onProbeError?.('list', err)
        return 'unknown'
      }
    }
    return 'unknown'
  }

  // Whether this client exposes the namespace-enumeration API at all. A BYO/injected client may
  // provide NEITHER describeNamespace() nor listNamespaces(); that is a different condition from
  // an API that exists but failed, which must never be read as proof of absence.
  #hasNamespaceApi(): boolean {
    const index = this.#index
    return (
      !!index &&
      (typeof index.describeNamespace === 'function' || typeof index.listNamespaces === 'function')
    )
  }

  // Returns true if visibility was confirmed within the bound, false on timeout.
  // Polls the SAME read paths the adapter reads through downstream:
  //   present ids    → must appear in BOTH query() matches AND listPaginated()
  //   absent  ids    → must be gone from BOTH listPaginated() AND fetch()
  //   namespaceGone  → the namespace must no longer be listed. In strong mode this is confirmed
  //                    by namespace enumeration (see #namespaceState), NOT by stats alone. An
  //                    INCONCLUSIVE enumeration (the probe returned 'unknown' because it errored)
  //                    is treated as "not yet confirmed" and keeps polling until the deadline.
  //                    The only exception is a client that has no namespace API at all (see
  //                    {@link #hasNamespaceApi}), for which describeIndexStats() is the sole
  //                    available signal.
  async #waitVisible(
    ns: any,
    collection: string,
    opts: {
      present?: string[]
      absent?: string[]
      namespaceGone?: boolean
      probeVector?: number[]
    },
    mode: VectorConsistency
  ): Promise<boolean> {
    const present = opts.present ?? []
    const absent = opts.absent ?? []
    const namespaceGone = !!opts.namespaceGone
    if (present.length === 0 && absent.length === 0 && !namespaceGone) return true
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
          const lr = await this.#index!.listPaginated({ namespace: physicalNs, limit: 99 })
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
          const lr = await this.#index!.listPaginated({ namespace: physicalNs, limit: 99 })
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
      let namespaceOk = true
      if (namespaceGone) {
        if (mode === 'strong') {
          // A missing describeIndexStats() entry is not proof: stats are not guaranteed to list
          // an existing-but-empty namespace, so strong callers must not proceed while
          // listNamespaces()/describeNamespace() still report the namespace. An inconclusive
          // probe ('unknown') means "not yet confirmed" — NOT absence — so polling continues
          // until the deadline and the caller times out. Only a client with no namespace API at
          // all falls back to the stats signal.
          const state = await this.#namespaceState(physicalNs)
          if (state !== 'unknown') {
            namespaceOk = state === 'absent'
          } else if (!this.#hasNamespaceApi()) {
            try {
              const stats = await this.#index!.describeIndexStats()
              namespaceOk = !stats.namespaces?.[physicalNs]
            } catch {
              namespaceOk = false
            }
          } else {
            namespaceOk = false
          }
        } else {
          try {
            const stats = await this.#index!.describeIndexStats()
            namespaceOk = !stats.namespaces?.[physicalNs]
          } catch {
            namespaceOk = false
          }
        }
      }
      if (presentOk && absentOk && namespaceOk) return true
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
    opts: { present?: string[]; absent?: string[]; namespaceGone?: boolean },
    what: string,
    mode: VectorConsistency
  ): Promise<void> {
    if (mode === 'eventual') return
    const confirmed = await this.#waitVisible(ns, collection, opts, mode)
    if (!confirmed && mode === 'strong') {
      throw new E_VECTOR_STORE_CONSISTENCY_TIMEOUT([what])
    }
    // best-effort: resolve regardless
  }

  /** Static availability probe: whether this adapter's runtime driver can load in the current environment. */
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
    this.#indexType = undefined
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
  /**
   * Drop `collection`.
   *
   * Pinecone namespaces are only reclaimable on serverless indexes, where an empty namespace
   * still counts toward the per-index namespace cap. On a serverless index the drop deletes the
   * whole namespace — records included, so the vector-by-vector list + `deleteMany` sweep is
   * redundant there — and then settles on the namespace's absence. On a pod-based index, where
   * `deleteNamespace` is not supported, the drop keeps the previous vectors-only behaviour: list
   * the namespace's records, `deleteMany` them, then settle on their absence.
   *
   * The deployment type is resolved ONCE per store via the control-plane `describeIndex()` and
   * cached when it positively reports `spec.serverless`/`spec.pod`. When it cannot be determined
   * (the describe call fails, or an injected client has no control plane) the adapter attempts
   * `deleteNamespace`; an explicit namespace-operation "not supported" error is read as the pod
   * case for THIS drop only — it is not cached, so a later drop re-probes.
   *
   * Namespace absence is tolerated ONLY at the deleteNamespace call site, and only for structured
   * signals (`status`/`statusCode` 404 or the SDK's `PineconeNotFoundError`). Absence-looking
   * errors from anywhere else (describeIndex, the pod vector sweep) propagate as collection
   * failures, as do free-text messages.
   *
   * Existence for the drop decision is deployment-type dependent and deliberately does NOT reuse
   * `hasCollection()` on serverless/unknown indexes. There, `describeIndexStats()` may omit an
   * existing-but-empty namespace, so a missing stats entry is NOT evidence of absence: only a
   * definitive `'absent'` from namespace enumeration is a no-op, while `'present'` and the
   * inconclusive `'unknown'` both attempt `deleteNamespace()` (a structured 404 is tolerated). This
   * is what stops an empty namespace from being leaked. Pod-based indexes keep the stats-based
   * check — they expose no namespace API and have no equivalent empty-namespace leak.
   */
  async dropCollection(collection: string, _ifExists: boolean): Promise<void> {
    await this.connect()
    const physicalNs = this.#ns(collection)
    const ns = this.#index!.namespace(physicalNs)
    const what = 'dropCollection ' + collection
    try {
      const indexType = await this.#resolveIndexType()

      if ('pod' === indexType) {
        // Pod-based indexes do not support deleteNamespace(); keep the vectors-only drop. The
        // stats-based existence check is fine here: namespaces are not quota-limited the same way,
        // so there is no empty-namespace leak to guard against.
        if (!(await this.#podCollectionExists(physicalNs))) return
        await this.#sweepVectors(collection, physicalNs, ns)
        this.#dims.delete(collection)
        return
      }

      // Serverless OR unknown deployment type: the existence decision must NOT come from
      // describeIndexStats(). A stats omission is indistinguishable from an empty namespace, and
      // trusting it would skip deleteNamespace() and leak the namespace this drop exists to
      // reclaim. Only a DEFINITIVE 'absent' from the namespace API is a no-op; 'present' and the
      // inconclusive 'unknown' both attempt the deletion.
      if ('absent' === (await this.#namespaceState(physicalNs))) return

      if ('serverless' === indexType) {
        // deleteNamespace() deletes the namespace AND all of its records, so there is nothing to
        // sweep. Doing it FIRST also means a strong-mode settle timeout can no longer skip the
        // reclaim: the namespace is already gone when the timeout is surfaced.
        await this.#deleteNamespace(physicalNs)
        this.#dims.delete(collection)
        await this.#settle(ns, collection, { namespaceGone: true }, what, this.#consistencyMode())
        return
      }

      // Unknown deployment type: probe deleteNamespace() and treat an explicit namespace-operation
      // "not supported" error as the pod case, keeping the (previous) vectors-only behaviour
      // without throwing. Do NOT cache 'pod' from this inference: an unrelated error carrying
      // matching wording would otherwise permanently classify a serverless index as pod and stop
      // future drops from reclaiming namespaces. Leaving #indexType at 'unknown' re-probes next
      // drop.
      try {
        await this.#deleteNamespace(physicalNs)
      } catch (err) {
        if (!isNamespaceUnsupported(err)) throw err
        await this.#sweepVectors(collection, physicalNs, ns)
        this.#dims.delete(collection)
        return
      }
      this.#dims.delete(collection)
      await this.#settle(ns, collection, { namespaceGone: true }, what, this.#consistencyMode())
    } catch (err: any) {
      // Re-throw consistency timeout directly (don't swallow)
      if (
        isInstanceOf(err, 'E_VECTOR_STORE_CONSISTENCY_TIMEOUT', E_VECTOR_STORE_CONSISTENCY_TIMEOUT)
      )
        throw err
      // Namespace absence is tolerated only inside #deleteNamespace (the one call site where it
      // means "already dropped"). Anything else — including a structured 404 from
      // describeIndex() or from the pod vector sweep — is a real failure: a sweep that 404s
      // mid-drop must not report success without clearing vectors or the dims cache.
      throw new E_VECTOR_STORE_COLLECTION_FAILED(['dropCollection', String(err)])
    }
  }

  // Pod-only existence check: describeIndexStats() is good enough there (no namespace API, and no
  // empty-namespace quota leak), so the historical behaviour is preserved unchanged.
  async #podCollectionExists(physicalNs: string): Promise<boolean> {
    const stats = await this.#index!.describeIndexStats()
    return !!stats.namespaces?.[physicalNs]
  }

  // Vectors-only reclaim for pod-based indexes: list the namespace's ids, delete them, then
  // settle on their absence (the pre-existing behaviour).
  async #sweepVectors(collection: string, physicalNs: string, ns: any): Promise<void> {
    let page: any = { next: null }
    const ids: string[] = []
    do {
      const lr = await this.#index!.listPaginated({
        namespace: physicalNs,
        limit: 99,
        startingToken: page.next,
      })
      if (lr.vectors) ids.push(...lr.vectors.map((v: any) => v.id))
      page.next = lr.pagination?.next
    } while (page.next)

    if (ids.length > 0) {
      await ns.deleteMany({ ids })
    }

    await this.#settle(
      ns,
      collection,
      { absent: ids },
      'dropCollection ' + collection,
      this.#consistencyMode()
    )
  }
  /**
   * Whether the collection exists.
   *
   * A Pinecone namespace can legitimately exist with zero records, and `describeIndexStats()` is
   * NOT guaranteed to list such a namespace — a missing stats entry is not evidence of absence.
   * Existence is therefore decided by namespace enumeration (`describeNamespace()`, one data-plane
   * call, or the paginated `listNamespaces()` fallback — which is also consulted when describe
   * fails for a non-404 reason) on every index type that can serve namespace operations:
   * serverless AND an `unknown` deployment type. Pod-based indexes expose no namespace API and
   * have no empty-namespace quota leak, so they keep the `describeIndexStats()` path.
   *
   * Resolution order:
   * - A definitive `present`/`absent` from enumeration wins immediately (on serverless and on an
   *   unknown deployment type alike; a pod index merely makes the enumeration fail, see below).
   * - If enumeration is inconclusive and the client exposes NO namespace API at all (a
   *   BYO/injected client), `describeIndexStats()` is the only available signal and is used.
   * - If the namespace API EXISTS but every probe failed, a missing stats entry cannot prove
   *   absence — stats may omit an existing-but-empty namespace — so the unreadable state is
   *   surfaced as {@link E_VECTOR_STORE_COLLECTION_FAILED} instead of silently reporting the
   *   collection gone. The one exception is an explicit pod "not supported" error from the API,
   *   which proves the index is pod-based (even when `describeIndex()` could not classify it)
   *   and routes back to the stats path, which is correct for pod.
   */
  async hasCollection(collection: string): Promise<boolean> {
    await this.connect()
    const physicalNs = this.#ns(collection)
    const index = this.#index!
    if ('pod' !== (await this.#resolveIndexType())) {
      // Serverless OR unknown deployment type: enumeration is the only signal that can see an
      // existing-but-EMPTY namespace, and it is definitive on both.
      let podByUnsupported = false
      const probeErrors: string[] = []
      const state = await this.#namespaceState(physicalNs, (_phase, err) => {
        if (isNamespaceUnsupported(err)) {
          // An explicit pod "not supported" response PROVES the index is pod-based even when
          // describeIndex() could not classify it: pod has no namespace API, and stats is the
          // correct (and only) signal for it.
          podByUnsupported = true
        } else {
          probeErrors.push(String(err))
        }
      })
      if (state === 'present') return true
      if (state === 'absent') return false
      if (!podByUnsupported && this.#hasNamespaceApi()) {
        throw new E_VECTOR_STORE_COLLECTION_FAILED([
          'hasCollection',
          `Existence of namespace "${physicalNs}" could not be determined: the namespace API failed (${probeErrors.join('; ') || 'no error reported'}) and describeIndexStats() may omit an existing-but-empty namespace, so a missing stats entry is not proof of absence`,
        ])
      }
      // Remaining cases fall through to stats: an index proven pod by the probe failure, or a
      // BYO client with no namespace API at all.
    }
    // Pod index (or BYO client without a namespace API): stats is the only available signal.
    const stats = await index.describeIndexStats()
    return !!stats.namespaces?.[physicalNs]
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
        metadata: { ...sanitizeMetadata(r.metadata), __document: r.document ?? '' },
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
          limit: 99,
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
            limit: 99,
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
            limit: 99,
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

// Structured namespace-absence signals only. @pinecone-database/pinecone 7.2.0 maps a 404 from
// deleteNamespace() to PineconeNotFoundError (whose `name` is set, but which carries no
// `status`); the status/statusCode checks cover clients that surface the raw response instead.
const isNamespaceAbsent = (err: unknown): boolean =>
  isObject(err) &&
  (err.status === 404 || err.statusCode === 404 || err.name === 'PineconeNotFoundError')

// An explicit namespace-operation "not supported" response — the pod-based index case. The SDK
// maps a 501 to PineconeNotImplementedError; a 400 carries the server's message instead, so that
// case is matched narrowly for Pinecone's pod-index wording (never for generic "unsupported" or
// absence). Free-text matches of "not supported" on other error classes do NOT count.
const isNamespaceUnsupported = (err: unknown): boolean => {
  if (!isObject(err)) return false
  if (err.name === 'PineconeNotImplementedError') return true
  const isBadRequest =
    err.status === 400 || err.statusCode === 400 || err.name === 'PineconeBadRequestError'
  if (!isBadRequest) return false
  const message = err.message !== null && err.message !== undefined ? String(err.message) : ''
  return /not[ -]supported for pod[ -]based indexes/i.test(message)
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

/** Translate a neutral {@link VectorFilter} into a Pinecone metadata filter object. */
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
