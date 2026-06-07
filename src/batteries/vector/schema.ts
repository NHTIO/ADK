/**
 * Knex-style schema builder for the vector battery.
 *
 * @module @nhtio/adk/batteries/vector/schema
 */

import type { DistanceMetric } from './types'
import type { CollectionSpec, CollectionFieldSpec } from './plan'

export interface SchemaExecutor {
  createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void>
  dropCollection(collection: string, ifExists: boolean): Promise<void>
  hasCollection(collection: string): Promise<boolean>
  renameCollection(from: string, to: string): Promise<void>
}

export class CollectionBuilder {
  #vectorDef?: { dimensions: number; metric: DistanceMetric }
  #fields: CollectionFieldSpec[] = []

  vector(def: { dimensions: number; metric?: DistanceMetric }): this {
    this.#vectorDef = {
      dimensions: def.dimensions,
      metric: def.metric ?? 'cosine',
    }
    return this
  }

  string(name: string): FieldChain {
    return this.#pushField(name, 'string')
  }

  integer(name: string): FieldChain {
    return this.#pushField(name, 'integer')
  }

  number(name: string): FieldChain {
    return this.#pushField(name, 'number')
  }

  boolean(name: string): FieldChain {
    return this.#pushField(name, 'boolean')
  }

  json(name: string): FieldChain {
    return this.#pushField(name, 'json')
  }

  #pushField(name: string, type: CollectionFieldSpec['type']): FieldChain {
    const spec: CollectionFieldSpec = {
      name,
      type,
      index: false,
      nullable: false,
    }
    this.#fields.push(spec)
    return new FieldChainImpl(spec)
  }

  build(collection: string): CollectionSpec {
    if (!this.#vectorDef) {
      throw new Error('a collection requires a vector() definition')
    }
    return {
      collection,
      vector: this.#vectorDef,
      fields: this.#fields,
    }
  }
}

export interface FieldChain {
  index(): FieldChain
  nullable(): FieldChain
}

class FieldChainImpl implements FieldChain {
  #spec: CollectionFieldSpec

  constructor(spec: CollectionFieldSpec) {
    this.#spec = spec
  }

  index(): FieldChain {
    this.#spec.index = true
    return this
  }

  nullable(): FieldChain {
    this.#spec.nullable = true
    return this
  }
}

export class VectorSchemaBuilder {
  #executor: SchemaExecutor

  constructor(executor: SchemaExecutor) {
    this.#executor = executor
  }

  async createCollection(collection: string, cb: (c: CollectionBuilder) => void): Promise<void> {
    const builder = new CollectionBuilder()
    cb(builder)
    const spec = builder.build(collection)
    await this.#executor.createCollection(spec, false)
  }

  async createCollectionIfNotExists(
    collection: string,
    cb: (c: CollectionBuilder) => void
  ): Promise<void> {
    const builder = new CollectionBuilder()
    cb(builder)
    const spec = builder.build(collection)
    await this.#executor.createCollection(spec, true)
  }

  async dropCollection(collection: string): Promise<void> {
    await this.#executor.dropCollection(collection, false)
  }

  async dropCollectionIfExists(collection: string): Promise<void> {
    await this.#executor.dropCollection(collection, true)
  }

  async hasCollection(collection: string): Promise<boolean> {
    return this.#executor.hasCollection(collection)
  }

  async renameCollection(from: string, to: string): Promise<void> {
    await this.#executor.renameCollection(from, to)
  }
}
