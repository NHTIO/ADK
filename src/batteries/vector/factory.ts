/**
 * @module @nhtio/adk/batteries/vector/factory
 */

import { E_VECTOR_STORE_DRIVER_UNAVAILABLE } from './exceptions'
import { validateCreateConfig, resolveClientCtor } from './validation'
import type { CallableVectorStore, BaseVectorStore } from './contract'
import type { BaseVectorStoreOptions, VectorEncoderFn, EncodeKind } from './types'

/** The adapter class shape the factory accepts as `client` — a constructor with an optional availability probe. */
export interface VectorStoreConstructor<O extends BaseVectorStoreOptions = BaseVectorStoreOptions> {
  /** Construct the adapter from its options. */
  new (options: O): BaseVectorStore
  /** Optional static probe: `false` short-circuits creation with a driver-unavailable error. */
  isAvailable?: () => boolean
}

/**
 * `client` is one of:
 *   - the adapter class itself          — `QdrantVectorStore`
 *   - a sync resolver                   — `() => QdrantVectorStore`
 *   - an async resolver / dynamic import — `() => import('…/qdrant').then(m => m.QdrantVectorStore)`
 * A resolver may also return a module namespace whose `default` is the class.
 */
export type VectorStoreClient<O extends BaseVectorStoreOptions = BaseVectorStoreOptions> =
  | VectorStoreConstructor<O>
  | (() => VectorStoreConstructor<O> | { default: VectorStoreConstructor<O> })
  | (() => Promise<VectorStoreConstructor<O> | { default: VectorStoreConstructor<O> }>)

/** Configuration accepted by {@link createVectorStore}: the adapter `client` plus its `options`. */
export interface CreateVectorStoreConfig<
  O extends BaseVectorStoreOptions = BaseVectorStoreOptions,
> {
  /** The adapter class, or a (possibly async) resolver of it. See {@link VectorStoreClient}. */
  client: VectorStoreClient<O>
  /** Options passed to the resolved adapter's constructor. */
  options: O
}

/**
 * Build a callable store. Validate config; resolve the `client` (class | sync resolver | async
 * resolver) to a BaseVectorStore subclass ctor; optional availability gate; construct; return
 * asCallable(). Async so that `client: () => import('…')` can lazily load the adapter (and its
 * driver) only when the store is actually created.
 */
export const createVectorStore = async <O extends BaseVectorStoreOptions = BaseVectorStoreOptions>(
  config: CreateVectorStoreConfig<O>
): Promise<CallableVectorStore> => {
  validateCreateConfig(config)
  const Ctor = (await resolveClientCtor(config.client)) as VectorStoreConstructor<O>
  if (typeof Ctor.isAvailable === 'function' && !Ctor.isAvailable()) {
    throw new E_VECTOR_STORE_DRIVER_UNAVAILABLE([Ctor.name || 'unknown'])
  }
  const instance = new Ctor(config.options)
  return instance.asCallable() as CallableVectorStore
}

// Helper: adapt an embeddings-battery-shaped object (has embedMany(texts, { kind })) into a VectorEncoderFn.
// The embeddings adapters expose: embedMany(texts: string[], opts?: { kind?: 'query'|'document' }): Promise<number[][]>
/** The minimal shape of an embeddings-battery adapter usable as a vector encoder. */
export interface EmbeddingsLike {
  /** Embed a batch of texts, optionally hinting query vs. document encoding. */
  embedMany(texts: string[], opts?: { kind?: EncodeKind }): Promise<number[][]>
}
/**
 * Adapt an {@link EmbeddingsLike} object into a {@link VectorEncoderFn} for use as a store encoder.
 *
 * @param adapter - The embeddings adapter to wrap.
 * @returns An encoder function forwarding to `adapter.embedMany`.
 */
export const encoderFromEmbeddings = (adapter: EmbeddingsLike): VectorEncoderFn => {
  return (texts: string[], kind: EncodeKind) => adapter.embedMany(texts, { kind })
}
