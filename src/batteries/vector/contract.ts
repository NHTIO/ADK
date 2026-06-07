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

export interface VectorTx {}

export interface VectorStore extends PlanSink, SchemaExecutor {
  readonly capabilities: VectorStoreCapabilities
  isAvailable(): boolean
  connect(): Promise<void>
  close(): Promise<void>
  (collection: string): VectorQueryBuilder
  schema: VectorSchemaBuilder
  transaction(fn: (tx: VectorStore) => Promise<void>): Promise<void>
}

export abstract class BaseVectorStore implements PlanSink, SchemaExecutor {
  abstract readonly capabilities: VectorStoreCapabilities
  protected options: BaseVectorStoreOptions

  constructor(options: BaseVectorStoreOptions) {
    this.options = options
  }

  abstract isAvailable(): boolean
  abstract connect(): Promise<void>
  abstract close(): Promise<void>

  abstract executeSearch(plan: SearchPlan): Promise<VectorMatch[]>
  abstract executeUpsert(plan: UpsertPlan): Promise<void>
  abstract executeDelete(plan: DeletePlan): Promise<void>

  abstract createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void>
  abstract dropCollection(collection: string, ifExists: boolean): Promise<void>
  abstract hasCollection(collection: string): Promise<boolean>
  abstract renameCollection(from: string, to: string): Promise<void>

  protected async encode(texts: string[], kind: EncodeKind): Promise<number[][]> {
    if (this.capabilities.builtInEncoding) {
      throw new E_VECTOR_STORE_ENCODER_REQUIRED(['contract'])
    }
    if (!this.options.encoder) throw new E_VECTOR_STORE_ENCODER_REQUIRED([this.constructor.name])
    return this.options.encoder(texts, kind)
  }

  async transaction(_fn: (tx: CallableVectorStore) => Promise<void>): Promise<void> {
    throw new E_VECTOR_STORE_TRANSACTIONS_UNSUPPORTED([this.constructor.name])
  }

  get schema(): VectorSchemaBuilder {
    return new VectorSchemaBuilder(this)
  }

  query(collection: string): VectorQueryBuilder {
    const defaultTopK = 10
    return new VectorQueryBuilder(this, collection, defaultTopK)
  }

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

export type CallableVectorStore = ((collection: string) => VectorQueryBuilder) & VectorStore
