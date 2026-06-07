/**
 * Filter types and evaluator for the vector battery.
 *
 * @module @nhtio/adk/batteries/vector/filters
 */

import { isObject } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import type { VectorMetadata, VectorMetadataValue } from './types'

export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'exists'
  | 'contains'

export interface RawExpr {
  __raw: string
  bindings: unknown[]
}

export const raw = (sql: string, bindings: unknown[] = []): RawExpr => ({ __raw: sql, bindings })

export const isRawExpr = (v: unknown): v is RawExpr =>
  isObject(v) && typeof v.__raw === 'string' && Array.isArray(v.bindings)

export interface FilterCondition {
  field: string
  op: FilterOperator
  value?: VectorMetadataValue | VectorMetadataValue[] | RawExpr
}
export interface FilterGroup {
  and?: VectorFilter[]
  or?: VectorFilter[]
  not?: VectorFilter
}
export interface RawFilter {
  $dialect: string
  $raw: string | unknown
  $bindings?: unknown[]
}
export type VectorFilter = FilterCondition | FilterGroup | RawFilter

export const isFilterCondition = (f: VectorFilter): f is FilterCondition =>
  typeof (f as FilterCondition).field === 'string' && typeof (f as FilterCondition).op === 'string'

export const isRawFilter = (f: VectorFilter): f is RawFilter =>
  typeof (f as RawFilter).$dialect === 'string'

export const isFilterGroup = (f: VectorFilter): f is FilterGroup =>
  !isFilterCondition(f) && !isRawFilter(f)

const rawFilterSchema = validator.object<RawFilter>({
  $dialect: validator.string().required(),
  // eslint-disable-next-line adk/require-validator-any-required -- value type-arg: $raw is any structured dialect payload; disposition is set by the .required() on the alternatives
  $raw: validator.alternatives(validator.string(), validator.any()).required(),
  // eslint-disable-next-line adk/require-validator-any-required -- item type-arg: bindings hold arbitrary values; disposition is set by .optional() on the array
  $bindings: validator.array().items(validator.any()).optional(),
})

const filterConditionSchema = validator.object<FilterCondition>({
  field: validator.string().required(),
  op: validator
    .string()
    .valid('eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'exists', 'contains')
    .required(),
  value: validator
    // eslint-disable-next-line adk/require-validator-any-required -- value type-arg: a filter value is any scalar or array of any; disposition is set by .optional() below
    .alternatives(validator.any(), validator.array().items(validator.any()))
    .optional(),
})

export const vectorFilterSchema = validator
  .alternatives(
    filterConditionSchema,
    rawFilterSchema,
    validator
      .object<FilterGroup>({
        and: validator.array().items(validator.link('#vectorFilter')).optional(),
        or: validator.array().items(validator.link('#vectorFilter')).optional(),
        not: validator.link('#vectorFilter').optional(),
      })
      .unknown(false)
  )
  .id('vectorFilter')

const getField = (metadata: VectorMetadata, path: string): VectorMetadataValue | undefined => {
  const keys = path.split('.')
  let current: VectorMetadataValue | undefined = metadata
  for (const key of keys) {
    if (current === undefined || current === null) {
      return undefined
    }
    if (typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, VectorMetadataValue>)[key]
  }
  return current
}

export const evaluateFilter = (filter: VectorFilter, metadata: VectorMetadata): boolean => {
  if (isRawFilter(filter)) {
    throw new Error('raw filters are not evaluable by the in-memory filter evaluator')
  }

  if (isFilterCondition(filter)) {
    const { field, op, value } = filter
    const fieldVal = getField(metadata, field)

    if (isRawExpr(value)) {
      throw new Error('raw expressions are not evaluable by the in-memory filter evaluator')
    }

    switch (op) {
      case 'eq': {
        return fieldVal === value
      }

      case 'ne': {
        return fieldVal !== value
      }

      case 'gt': {
        if (fieldVal === undefined || value === undefined) {
          return false
        }
        if (typeof fieldVal === 'number' && typeof value === 'number') {
          return fieldVal > value
        }
        if (typeof fieldVal === 'string' && typeof value === 'string') {
          return fieldVal > value
        }
        return false
      }

      case 'gte': {
        if (fieldVal === undefined || value === undefined) {
          return false
        }
        if (typeof fieldVal === 'number' && typeof value === 'number') {
          return fieldVal >= value
        }
        if (typeof fieldVal === 'string' && typeof value === 'string') {
          return fieldVal >= value
        }
        return false
      }

      case 'lt': {
        if (fieldVal === undefined || value === undefined) {
          return false
        }
        if (typeof fieldVal === 'number' && typeof value === 'number') {
          return fieldVal < value
        }
        if (typeof fieldVal === 'string' && typeof value === 'string') {
          return fieldVal < value
        }
        return false
      }

      case 'lte': {
        if (fieldVal === undefined || value === undefined) {
          return false
        }
        if (typeof fieldVal === 'number' && typeof value === 'number') {
          return fieldVal <= value
        }
        if (typeof fieldVal === 'string' && typeof value === 'string') {
          return fieldVal <= value
        }
        return false
      }

      case 'in': {
        if (!Array.isArray(value)) {
          return false
        }
        return value.includes(fieldVal as never)
      }

      case 'nin': {
        if (!Array.isArray(value)) {
          return true
        }
        return !value.includes(fieldVal as never)
      }

      case 'exists': {
        const checkExists = value === undefined || value === true
        return checkExists ? fieldVal !== undefined : fieldVal === undefined
      }

      case 'contains': {
        if (fieldVal === undefined) {
          return false
        }
        if (Array.isArray(fieldVal)) {
          return fieldVal.includes(value as never)
        }
        if (typeof fieldVal === 'string') {
          return fieldVal.includes(String(value))
        }
        return false
      }

      default: {
        return false
      }
    }
  }

  if (isFilterGroup(filter)) {
    const { and, or, not } = filter

    if (and !== undefined) {
      return and.every((child) => evaluateFilter(child, metadata))
    }

    if (or !== undefined) {
      return or.some((child) => evaluateFilter(child, metadata))
    }

    if (not !== undefined) {
      return !evaluateFilter(not, metadata)
    }

    return true
  }

  return false
}
