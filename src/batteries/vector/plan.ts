/**
 * Compiled query plans for the vector storage battery.
 *
 * @module @nhtio/adk/batteries/vector/plan
 *
 * @remarks
 * This module defines the neutral, pure-type plans that the query builder compiles to.
 * Adapters consume these plans to perform vector operations without runtime logic here.
 */

import type { VectorFilter } from './filters'
import type { VectorRecord, DistanceMetric, VectorConsistency } from './types'

/** Normalized projection from .select(); REQUIRED on reads — every column opt-in, id included. */
export interface Projection {
  /** Whether to return each match's id. */
  id: boolean
  /** Whether to return the stored vector (optionally renamed); `false` to omit. */
  vector: false | { name?: string }
  /** Whether to return the document body (optionally from a named field); `false` to omit. */
  document: false | { field?: string }
  /** Whether to return metadata (optionally a subset of fields); `false` to omit. */
  metadata: false | { fields?: string[] }
}

/** A compiled nearest-neighbour search operation, consumed by an adapter's `executeSearch`. */
export interface SearchPlan {
  /** Collection to search. */
  collection: string
  /** The nearest-neighbour anchor: a client vector, server-embedded text, or an existing record id. */
  near?:
    | {
        vector: number[]
      }
    | {
        serverText: string
      }
    | {
        id: string
      }
  /** Optional metadata filter applied alongside the vector search. */
  filter?: VectorFilter
  /** Maximum number of matches to return. */
  topK: number
  /** Number of leading matches to skip. */
  offset?: number
  /** Which fields each match projects. */
  projection: Projection
}

/** A compiled insert-or-replace operation, consumed by an adapter's `executeUpsert`. */
export interface UpsertPlan {
  /** Collection to write into. */
  collection: string
  /** Records to insert or replace. */
  records: VectorRecord[]
  /** Per-operation read-after-write override from `.consistency()`; absent = use store/adapter default. */
  consistency?: VectorConsistency
}

/** A compiled delete operation, consumed by an adapter's `executeDelete`. */
export interface DeletePlan {
  /** Collection to delete from. */
  collection: string
  /** Ids to delete (the fast path); mutually informative with `filter`. */
  ids?: string[]
  /** Filter selecting the records to delete when `ids` is not used. */
  filter?: VectorFilter
  /** Per-operation read-after-write override from `.consistency()`; absent = use store/adapter default. */
  consistency?: VectorConsistency
}

/** Declaration of a single metadata field in a {@link CollectionSpec}. */
export interface CollectionFieldSpec {
  /** Field name. */
  name: string
  /** Field's scalar type. */
  type: 'string' | 'integer' | 'number' | 'boolean' | 'json'
  /** Whether the backend should index the field for filtering. */
  index?: boolean
  /** Whether the field accepts null/absent values. */
  nullable?: boolean
}

/** A compiled collection definition, consumed by an adapter's `createCollection`. */
export interface CollectionSpec {
  /** Name of the collection to create. */
  collection: string
  /** The vector column's dimensionality and distance metric. */
  vector: {
    dimensions: number
    metric: DistanceMetric
  }
  /** The metadata fields the collection carries. */
  fields: CollectionFieldSpec[]
}
