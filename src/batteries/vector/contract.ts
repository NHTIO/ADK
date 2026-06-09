/**
 * @module @nhtio/adk/batteries/vector/contract
 */

import { VectorQueryBuilder, type PlanSink } from './builder'
import { VectorSchemaBuilder, type SchemaExecutor } from './schema'
import {
  E_VECTOR_STORE_ENCODER_REQUIRED,
  E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED,
} from './exceptions'
import type { SearchPlan, UpsertPlan, DeletePlan, CollectionSpec } from './plan'
import type {
  VectorMatch,
  BaseVectorStoreOptions,
  VectorStoreCapabilities,
  EncodeKind,
} from './types'

/**
 * Opaque handle for a backend transaction. Stores that support transactions return a
 * driver-specific implementation; the harness only passes it back through {@link VectorStore.transaction}.
 */
export interface VectorTx {}

/**
 * The public surface every vector store exposes: capability flags, lifecycle (`connect`/`close`),
 * a callable form that opens a {@link VectorQueryBuilder} for a collection, schema access, and an
 * optional transaction wrapper. Adapters extend {@link BaseVectorStore}, which implements this plus
 * the low-level plan/schema executor contracts.
 */
export interface VectorStore extends PlanSink, SchemaExecutor {
  /** Static description of what this backend supports (built-in encoding, transactions, filters, etc.). */
  readonly capabilities: VectorStoreCapabilities
  /** Whether the backend's optional peer dependency is installed and the store is usable. */
  isAvailable(): boolean
  /** Open the backing connection (clients, pools, sockets). */
  connect(): Promise<void>
  /** Release the backing connection and any held resources. */
  close(): Promise<void>
  /** Callable form: `store('collection')` returns a query builder scoped to that collection. */
  (collection: string): VectorQueryBuilder
  /** Schema builder for creating, dropping, and migrating collections. */
  schema: VectorSchemaBuilder
  /** Run `fn` inside a backend transaction, where supported; rejects otherwise. */
  transaction(fn: (tx: VectorStore) => Promise<void>): Promise<void>
}

/**
 * Abstract base shared by every bundled vector adapter. It implements the cross-cutting surface
 * (`query`/`schema`/`transaction`/`asCallable`/`encode`) on top of the small set of backend-specific
 * abstract methods each adapter fills in (`connect`, `executeSearch`, `createCollection`, …). Concrete
 * adapters inherit the doc comments below unless they override them.
 */
export abstract class BaseVectorStore implements PlanSink, SchemaExecutor {
  /** Static description of what this backend supports — see {@link VectorStoreCapabilities}. */
  abstract readonly capabilities: VectorStoreCapabilities
  /** Construction options (connection details and the optional encoder), held for later use. */
  protected options: BaseVectorStoreOptions

  constructor(options: BaseVectorStoreOptions) {
    this.options = options
  }

  /** Whether the backend's optional peer dependency is installed and the store is usable. */
  abstract isAvailable(): boolean
  /** Establish the backing connection (open clients, pools, sockets). Idempotent where the driver allows. */
  abstract connect(): Promise<void>
  /** Release the backing connection and any held resources. */
  abstract close(): Promise<void>

  /** Execute a compiled search plan and return the matched records. */
  abstract executeSearch(plan: SearchPlan): Promise<VectorMatch[]>
  /** Execute a compiled upsert plan (insert-or-replace the given records). */
  abstract executeUpsert(plan: UpsertPlan): Promise<void>
  /** Execute a compiled delete plan. */
  abstract executeDelete(plan: DeletePlan): Promise<void>

  /** Create a collection from `spec`; a no-op when `ifNotExists` and it already exists. */
  abstract createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void>
  /** Drop a collection; a no-op when `ifExists` and it is absent. */
  abstract dropCollection(collection: string, ifExists: boolean): Promise<void>
  /** Whether a collection currently exists in the backend. */
  abstract hasCollection(collection: string): Promise<boolean>
  /** Rename a collection from `from` to `to`. */
  abstract renameCollection(from: string, to: string): Promise<void>

  /**
   * Encode text to vectors via the configured encoder. Throws {@link E_VECTOR_STORE_ENCODER_REQUIRED}
   * when the backend has no built-in encoding and no encoder was supplied.
   */
  protected async encode(texts: string[], kind: EncodeKind): Promise<number[][]> {
    if (this.capabilities.builtInEncoding) {
      throw new E_VECTOR_STORE_ENCODER_REQUIRED(['contract'])
    }
    if (!this.options.encoder) throw new E_VECTOR_STORE_ENCODER_REQUIRED([this.constructor.name])
    return this.options.encoder(texts, kind)
  }

  /**
   * Run `fn` inside a backend transaction. The base implementation rejects with
   * {@link E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED}; adapters whose backend supports transactions
   * override this.
   */
  async transaction(_fn: (tx: CallableVectorStore) => Promise<void>): Promise<void> {
    throw new E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED([this.constructor.name])
  }

  /** Schema builder bound to this store, for creating/dropping/migrating collections. */
  get schema(): VectorSchemaBuilder {
    return new VectorSchemaBuilder(this)
  }

  /** Open a {@link VectorQueryBuilder} scoped to `collection` (default top-K of 10). */
  query(collection: string): VectorQueryBuilder {
    const defaultTopK = 10
    return new VectorQueryBuilder(this, collection, defaultTopK)
  }

  /**
   * Wrap this store in a callable proxy so `store('collection')` is shorthand for
   * `store.query('collection')`, while all other methods/properties pass through unchanged.
   */
  asCallable(): CallableVectorStore {
    const self = this
    const fn = ((collection: string) => self.query(collection)) as CallableVectorStore
    return new Proxy(fn, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver)
        const val = (self as any)[prop]
        return typeof val === 'function' ? val.bind(self) : val
      },
    })
  }
}

/** A {@link VectorStore} in its callable form — `store('collection')` opens a query builder. */
export type CallableVectorStore = ((collection: string) => VectorQueryBuilder) & VectorStore
