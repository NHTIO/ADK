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
  id: boolean
  vector: false | { name?: string }
  document: false | { field?: string }
  metadata: false | { fields?: string[] }
}

export interface SearchPlan {
  collection: string
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
  filter?: VectorFilter
  topK: number
  offset?: number
  projection: Projection
}

export interface UpsertPlan {
  collection: string
  records: VectorRecord[]
  /** Per-operation read-after-write override from `.consistency()`; absent = use store/adapter default. */
  consistency?: VectorConsistency
}

export interface DeletePlan {
  collection: string
  ids?: string[]
  filter?: VectorFilter
  /** Per-operation read-after-write override from `.consistency()`; absent = use store/adapter default. */
  consistency?: VectorConsistency
}

export interface CollectionFieldSpec {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean' | 'json'
  index?: boolean
  nullable?: boolean
}

export interface CollectionSpec {
  collection: string
  vector: {
    dimensions: number
    metric: DistanceMetric
  }
  fields: CollectionFieldSpec[]
}
