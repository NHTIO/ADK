/**
 * @module @nhtio/adk/batteries/vector/factory
 */

import { E_VECTOR_STORE_DRIVER_UNAVAILABLE } from './exceptions'
import { validateCreateConfig, resolveClientCtor } from './validation'
import type { CallableVectorStore, BaseVectorStore } from './contract'
import type { BaseVectorStoreOptions, VectorEncoderFn, EncodeKind } from './types'

// The adapter class shape the factory accepts as 'client'.
export interface VectorStoreConstructor<O extends BaseVectorStoreOptions = BaseVectorStoreOptions> {
  new (options: O): BaseVectorStore
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

export interface CreateVectorStoreConfig<
  O extends BaseVectorStoreOptions = BaseVectorStoreOptions,
> {
  client: VectorStoreClient<O>
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
export interface EmbeddingsLike {
  embedMany(texts: string[], opts?: { kind?: EncodeKind }): Promise<number[][]>
}
export const encoderFromEmbeddings = (adapter: EmbeddingsLike): VectorEncoderFn => {
  return (texts: string[], kind: EncodeKind) => adapter.embedMany(texts, { kind })
}
