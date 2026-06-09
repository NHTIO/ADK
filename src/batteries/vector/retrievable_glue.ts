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

/** Configuration for wiring a vector store to the ADK's retrievable lifecycle callbacks. */
export interface VectorRetrievableGlueOptions {
  /** The callable vector store the callbacks query and write to. */
  store: CallableVectorStore
  /** Collection the retrievables live in. */
  collection: string
  /** Trust tier for fetched matches — a fixed tier, or a per-match function. */
  trustTier: RetrievableTrustTier | ((m: VectorMatch) => RetrievableTrustTier)
  /** Maximum number of retrievables to fetch per turn (default 5). */
  topK?: number
  /** Optional filter applied to every retrieval query. */
  filter?: VectorFilter
  /** Derives the retrieval query from the turn context; defaults to the last user message. */
  deriveQuery?: (
    ctx: TurnContext
  ) => string | number[] | undefined | Promise<string | number[] | undefined>
  /** Maps a {@link VectorMatch} to a raw retrievable (trust tier applied separately). */
  toRetrievable?: (m: VectorMatch) => Omit<RawRetrievable, 'trustTier'>
}

/** The four retrievable-lifecycle callbacks produced by {@link createVectorRetrievableCallbacks}. */
export interface VectorRetrievableCallbacks {
  /** Fetches retrievables relevant to the current turn. */
  fetchRetrievablesCallback: RetrievableRetrievalFn
  /** Persists a new retrievable into the store. */
  storeRetrievableCallback: RetrievableStoreFn
  /** Replaces an existing retrievable (upsert). */
  mutateRetrievableCallback: RetrievableMutateFn
  /** Deletes a retrievable by id. */
  deleteRetrievableCallback: RetrievableDeleteFn
}

/**
 * Build the retrievable-lifecycle callbacks (fetch/store/mutate/delete) that bridge a callable
 * vector store to the ADK's retrievable subsystem, applying the supplied query derivation,
 * match-to-retrievable mapping, and trust-tier assignment.
 *
 * @param opts - The store, collection, and behaviour overrides.
 * @returns The four wired {@link VectorRetrievableCallbacks}.
 */
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
