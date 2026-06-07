/**
 * @module @nhtio/adk/batteries/vector/retrievable
 */

import { Retrievable } from '@nhtio/adk'
import type { VectorFilter } from './filters'
import type { CallableVectorStore } from './contract'
import type { VectorMatch, VectorMetadata } from './types'
import type { RawRetrievable, RetrievableTrustTier } from '@nhtio/adk/common'
import type {
  TurnContext,
  RetrievableRetrievalFn,
  RetrievableStoreFn,
  RetrievableMutateFn,
  RetrievableDeleteFn,
} from '@nhtio/adk'

export interface VectorRetrievableGlueOptions {
  store: CallableVectorStore
  collection: string
  trustTier: RetrievableTrustTier | ((m: VectorMatch) => RetrievableTrustTier)
  topK?: number
  filter?: VectorFilter
  deriveQuery?: (
    ctx: TurnContext
  ) => string | number[] | undefined | Promise<string | number[] | undefined>
  toRetrievable?: (m: VectorMatch) => Omit<RawRetrievable, 'trustTier'>
}

export interface VectorRetrievableCallbacks {
  fetchRetrievablesCallback: RetrievableRetrievalFn
  storeRetrievableCallback: RetrievableStoreFn
  mutateRetrievableCallback: RetrievableMutateFn
  deleteRetrievableCallback: RetrievableDeleteFn
}

export const createVectorRetrievableCallbacks = (
  opts: VectorRetrievableGlueOptions
): VectorRetrievableCallbacks => {
  const topK = opts.topK ?? 5
  const tierFor = (m: VectorMatch): RetrievableTrustTier =>
    typeof opts.trustTier === 'function' ? opts.trustTier(m) : opts.trustTier

  // default deriveQuery: last user message text, else undefined
  const deriveQuery =
    opts.deriveQuery ??
    (async (ctx: TurnContext) => {
      const msgs = await ctx.fetchMessages()
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') return msgs[i].content?.toString() ?? ''
      }
      return undefined
    })

  // default mapping VectorMatch -> RawRetrievable (minus trustTier)
  const toRetrievable =
    opts.toRetrievable ??
    ((m: VectorMatch): Omit<RawRetrievable, 'trustTier'> => {
      const md = (m.metadata ?? {}) as Record<string, unknown>
      const now = new Date()
      return {
        id: m.id ?? String(md.id ?? ''),
        content: m.document ?? String(md.content ?? ''),
        source: typeof md.source === 'string' ? md.source : undefined,
        kind: typeof md.kind === 'string' ? md.kind : undefined,
        score: typeof m.score === 'number' ? m.score : undefined,
        createdAt: (md.createdAt as any) ?? now,
        updatedAt: (md.updatedAt as any) ?? now,
      }
    })

  const fetchRetrievablesCallback: RetrievableRetrievalFn = async (ctx) => {
    const q = await deriveQuery(ctx)
    if (q === undefined) return []
    let b = opts.store(opts.collection)
    b = Array.isArray(q) ? b.nearVector(q) : b.nearText(q)
    if (opts.filter) b = b.whereRaw(opts.filter as any)
    const matches = await b.select('id', 'document', 'metadata').limit(topK)
    return matches.map((m) => new Retrievable({ ...toRetrievable(m), trustTier: tierFor(m) }))
  }

  const storeRetrievableCallback: RetrievableStoreFn = async (_ctx, r) => {
    const content = await r.contentString()
    const metadata: VectorMetadata = {
      trustTier: r.trustTier,
      createdAt: r.createdAt?.toISO?.() ?? String(r.createdAt),
      updatedAt: r.updatedAt?.toISO?.() ?? String(r.updatedAt),
    }
    if (r.source !== undefined) metadata.source = r.source
    if (r.kind !== undefined) metadata.kind = r.kind
    await opts.store(opts.collection).upsert([{ id: r.id, document: content, metadata }])
  }
  const mutateRetrievableCallback: RetrievableMutateFn = storeRetrievableCallback // upsert == replace
  const deleteRetrievableCallback: RetrievableDeleteFn = async (_ctx, id) => {
    await opts.store(opts.collection).whereIn('id', [id]).delete()
  }

  return {
    fetchRetrievablesCallback,
    storeRetrievableCallback,
    mutateRetrievableCallback,
    deleteRetrievableCallback,
  }
}
