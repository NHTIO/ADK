/**
 * Knex-style schema builder for the vector battery.
 *
 * @module @nhtio/adk/batteries/vector/schema
 */

import type { DistanceMetric } from './types'
import type { CollectionSpec, CollectionFieldSpec } from './plan'

/**
 * The backend side of the schema builder — the adapter operations a {@link VectorSchemaBuilder}
 * drains its compiled {@link CollectionSpec}s and DDL calls into.
 */
export interface SchemaExecutor {
  /** Create a collection from `spec`; `ifNotExists` suppresses the already-exists error. */
  createCollection(spec: CollectionSpec, ifNotExists: boolean): Promise<void>
  /** Drop a collection; `ifExists` suppresses the not-found error. */
  dropCollection(collection: string, ifExists: boolean): Promise<void>
  /** Resolve `true` if the collection exists. */
  hasCollection(collection: string): Promise<boolean>
  /** Rename a collection from `from` to `to`. */
  renameCollection(from: string, to: string): Promise<void>
}

/**
 * Chainable builder for a single collection definition — declares the vector column and the typed
 * metadata fields, compiled to a {@link CollectionSpec} by {@link CollectionBuilder.build}.
 */
export class CollectionBuilder {
  #vectorDef?: { dimensions: number; metric: DistanceMetric }
  #fields: CollectionFieldSpec[] = []

  /** Declare the vector column's dimensionality and (optionally) its distance metric (default `'cosine'`). */
  vector(def: { dimensions: number; metric?: DistanceMetric }): this {
    this.#vectorDef = {
      dimensions: def.dimensions,
      metric: def.metric ?? 'cosine',
    }
    return this
  }

  /** Declare a string metadata field; returns a {@link FieldChain} for `.index()`/`.nullable()`. */
  string(name: string): FieldChain {
    return this.#pushField(name, 'string')
  }

  /** Declare an integer metadata field; returns a {@link FieldChain} for `.index()`/`.nullable()`. */
  integer(name: string): FieldChain {
    return this.#pushField(name, 'integer')
  }

  /** Declare a number metadata field; returns a {@link FieldChain} for `.index()`/`.nullable()`. */
  number(name: string): FieldChain {
    return this.#pushField(name, 'number')
  }

  /** Declare a boolean metadata field; returns a {@link FieldChain} for `.index()`/`.nullable()`. */
  boolean(name: string): FieldChain {
    return this.#pushField(name, 'boolean')
  }

  /** Declare a JSON metadata field; returns a {@link FieldChain} for `.index()`/`.nullable()`. */
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

  /**
   * Compile the accumulated definition into a {@link CollectionSpec}.
   *
   * @throws when no {@link CollectionBuilder.vector} definition was declared.
   */
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

/** Post-declaration chain for a metadata field, toggling indexing and nullability. */
export interface FieldChain {
  /** Mark the field as indexed for filtering. */
  index(): FieldChain
  /** Mark the field as nullable. */
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

/**
 * Knex-style schema facade exposing collection DDL (create/drop/rename/has) over a
 * {@link SchemaExecutor}. Returned by a vector store's `schema()` accessor.
 */
export class VectorSchemaBuilder {
  #executor: SchemaExecutor

  /**
   * @param executor - The adapter-backed executor the DDL calls are drained into.
   */
  constructor(executor: SchemaExecutor) {
    this.#executor = executor
  }

  /** Create a collection, defining it via the `cb` builder. Errors if it already exists. */
  async createCollection(collection: string, cb: (c: CollectionBuilder) => void): Promise<void> {
    const builder = new CollectionBuilder()
    cb(builder)
    const spec = builder.build(collection)
    await this.#executor.createCollection(spec, false)
  }

  /** Create a collection only if absent; a no-op if it already exists. */
  async createCollectionIfNotExists(
    collection: string,
    cb: (c: CollectionBuilder) => void
  ): Promise<void> {
    const builder = new CollectionBuilder()
    cb(builder)
    const spec = builder.build(collection)
    await this.#executor.createCollection(spec, true)
  }

  /** Drop a collection. Errors if it does not exist. */
  async dropCollection(collection: string): Promise<void> {
    await this.#executor.dropCollection(collection, false)
  }

  /** Drop a collection only if present; a no-op if it does not exist. */
  async dropCollectionIfExists(collection: string): Promise<void> {
    await this.#executor.dropCollection(collection, true)
  }

  /** Resolve `true` if the collection exists. */
  async hasCollection(collection: string): Promise<boolean> {
    return this.#executor.hasCollection(collection)
  }

  /** Rename a collection from `from` to `to`. */
  async renameCollection(from: string, to: string): Promise<void> {
    await this.#executor.renameCollection(from, to)
  }
}
