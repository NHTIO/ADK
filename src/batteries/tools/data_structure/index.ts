/**
 * Pre-constructed tools for querying, filtering, grouping, and reshaping structured values.
 *
 * @module @nhtio/adk/batteries/tools/data_structure
 *
 * @remarks
 * Pre-constructed bundled tools for the `data_structure` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'
import { isError, isObject } from '@nhtio/adk/guards'
import { bigSum, bigMean, formatBig, bigToNumber } from '@nhtio/adk/lib/helpers/bignum'
import type { BigNumber } from 'mathjs'

/**
 * Render a {@link BigNumber} aggregate as a JSON-friendly value: a plain `number` when the result
 * is exactly representable as a float64 (|x| ≤ Number.MAX_SAFE_INTEGER, so existing consumers and
 * tests see a number with no precision loss), or a full-precision string otherwise — covering both
 * overflow (which `JSON.stringify` would turn into `null`) and the gap above 2^53 where float64
 * silently rounds (e.g. 3 × MAX_SAFE_INTEGER).
 */
function aggregateValue(big: BigNumber): number | string {
  const asNum = bigToNumber(big)
  if (Number.isFinite(asNum) && Math.abs(asNum) <= Number.MAX_SAFE_INTEGER) return asNum
  return formatBig(big, 16)
}

function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

type FilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'exists'

function matchesFilter(
  item: unknown,
  key: string,
  operator: FilterOperator,
  value: unknown
): boolean {
  const actual = getPath(item, key)
  switch (operator) {
    case 'eq':
      return actual === value
    case 'ne':
      return actual !== value
    case 'gt':
      return typeof actual === 'number' && actual > (value as number)
    case 'gte':
      return typeof actual === 'number' && actual >= (value as number)
    case 'lt':
      return typeof actual === 'number' && actual < (value as number)
    case 'lte':
      return typeof actual === 'number' && actual <= (value as number)
    case 'contains':
      return typeof actual === 'string' && actual.includes(String(value))
    case 'starts_with':
      return typeof actual === 'string' && actual.startsWith(String(value))
    case 'ends_with':
      return typeof actual === 'string' && actual.endsWith(String(value))
    case 'exists':
      return actual !== undefined && actual !== null
    default:
      return false
  }
}

function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function applyTemplate(template: string, item: unknown): string {
  if (typeof item !== 'object' || item === null) return String(item)
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const val = getPath(item, key.trim())
    return val === undefined || val === null ? '' : String(val)
  })
}

type Operation =
  | { op: 'filter'; key: string; operator: FilterOperator; value?: unknown }
  | { op: 'sort'; key: string; direction?: 'asc' | 'desc' }
  | { op: 'select_keys'; keys: string[] }
  | { op: 'pluck'; key: string }
  | { op: 'slice'; start: number; end?: number }
  | { op: 'unique' }
  | { op: 'unique_by'; key: string }
  | { op: 'group_by'; key: string }
  | { op: 'flatten'; depth?: number }
  | { op: 'reverse' }
  | { op: 'count' }
  | { op: 'sum'; key?: string }
  | { op: 'avg'; key?: string }
  | { op: 'median'; key?: string }
  | { op: 'min'; key?: string }
  | { op: 'max'; key?: string }
  | { op: 'first'; n?: number }
  | { op: 'last'; n?: number }
  | { op: 'chunk'; size: number }
  | { op: 'frequency_count'; key?: string }
  | { op: 'top_n'; n: number; key: string; direction?: 'asc' | 'desc' }
  | { op: 'map_template'; template: string }

function applyOperation(data: unknown, op: Operation): unknown {
  // Guard malformed pipeline entries (null, non-object, or missing `op`) so they produce a clear
  // error string rather than a TypeError from dereferencing `op.op`.
  if (op === null || typeof op !== 'object' || typeof (op as { op?: unknown }).op !== 'string') {
    throw new Error('Each operation must be an object with a string "op" field.')
  }

  if (op.op === 'count') {
    if (Array.isArray(data)) return data.length
    if (isObject(data)) return Object.keys(data).length
    return 0
  }

  if (!Array.isArray(data)) {
    throw new Error(`Operation "${op.op}" requires an array input.`)
  }

  const arr = data as unknown[]

  switch (op.op) {
    case 'filter':
      return arr.filter((item) => matchesFilter(item, op.key, op.operator, op.value))

    case 'sort': {
      const dir = op.direction === 'desc' ? -1 : 1
      return [...arr].sort((a, b) => {
        const av = getPath(a, op.key)
        const bv = getPath(b, op.key)
        if (av === bv) return 0
        if (av === undefined || av === null) return 1
        if (bv === undefined || bv === null) return -1
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }

    case 'select_keys':
      return arr.map((item) => {
        if (typeof item !== 'object' || item === null) return item
        const result: Record<string, unknown> = {}
        for (const key of op.keys) result[key] = (item as Record<string, unknown>)[key]
        return result
      })

    case 'pluck':
      return arr.map((item) => getPath(item, op.key))

    case 'slice':
      return arr.slice(op.start, op.end)

    case 'unique': {
      const seen = new Set<string>()
      return arr.filter((item) => {
        const key = typeof item === 'object' ? JSON.stringify(item) : String(item)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    case 'unique_by': {
      const seen = new Set<string>()
      return arr.filter((item) => {
        const raw = getPath(item, op.key)
        // Serialise the key value so deep-equal objects/arrays dedupe by VALUE, not reference —
        // JSON.parse produces a distinct reference per row, so a raw Set never matched them. This
        // must catch BOTH plain objects and arrays, so a raw `typeof === 'object'` is intended here
        // rather than the plain-object-only `isObject` guard.
        // eslint-disable-next-line adk/prefer-is-object
        const isObjectOrArray = typeof raw === 'object' && raw !== null
        const key = isObjectOrArray ? JSON.stringify(raw) : `${typeof raw}:${String(raw)}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    }

    case 'group_by': {
      const groups: Record<string, unknown[]> = {}
      for (const item of arr) {
        const key = String(getPath(item, op.key) ?? '__undefined__')
        if (!groups[key]) groups[key] = []
        groups[key].push(item)
      }
      return groups
    }

    case 'flatten':
      return arr.flat(op.depth ?? 1)

    case 'reverse':
      return [...arr].reverse()

    case 'sum': {
      // The total is accumulated in BigNumber so a sum exceeding float64 stays exact (returned as
      // a precise string) instead of silently becoming Infinity → JSON null.
      const values = op.key ? arr.map((i) => getPath(i, op.key!)) : arr
      const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      // A non-empty input with no numeric values is almost always a mistake (e.g. an array of
      // objects summed without a `key`). Returning 0 would be silently wrong, so error instead.
      if (nums.length === 0 && arr.length > 0) {
        throw new Error(
          op.key
            ? `No numeric values found at key "${op.key}".`
            : 'No numeric values to sum. For an array of objects, pass a "key".'
        )
      }
      return aggregateValue(bigSum(nums))
    }

    case 'avg': {
      const values = op.key ? arr.map((i) => getPath(i, op.key!)) : arr
      const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      // null (not 0) signals "no numeric data" — unlike sum, an average has no neutral element,
      // so null is an honest "no result" rather than a misleading number.
      if (nums.length === 0) return null
      return aggregateValue(bigMean(nums))
    }

    case 'median': {
      const values = op.key ? arr.map((i) => getPath(i, op.key!)) : arr
      const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (nums.length === 0) return null
      return medianOf(nums)
    }

    case 'min': {
      const values = op.key ? arr.map((i) => getPath(i, op.key!)) : arr
      const nums = values.filter((v): v is number => typeof v === 'number')
      if (nums.length === 0) return null
      return Math.min(...nums)
    }

    case 'max': {
      const values = op.key ? arr.map((i) => getPath(i, op.key!)) : arr
      const nums = values.filter((v): v is number => typeof v === 'number')
      if (nums.length === 0) return null
      return Math.max(...nums)
    }

    case 'first':
      return op.n !== undefined ? arr.slice(0, op.n) : arr[0]

    case 'last':
      return op.n !== undefined ? arr.slice(-op.n) : arr[arr.length - 1]

    case 'chunk': {
      const size = Math.max(1, Math.floor(op.size))
      const chunks: unknown[][] = []
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
      return chunks
    }

    case 'frequency_count': {
      const freq: Record<string, number> = {}
      for (const item of arr) {
        const key = op.key ? String(getPath(item, op.key) ?? '__undefined__') : String(item)
        freq[key] = (freq[key] ?? 0) + 1
      }
      return freq
    }

    case 'top_n': {
      // desc (default) ranks largest-first; asc ranks smallest-first. The base comparator
      // `(bv - av)` / `localeCompare(bv, av)` is descending, so asc flips it.
      const dir = op.direction === 'asc' ? -1 : 1
      return [...arr]
        .sort((a, b) => {
          const av = getPath(a, op.key)
          const bv = getPath(b, op.key)
          if (typeof av === 'number' && typeof bv === 'number') return (bv - av) * dir
          return String(bv).localeCompare(String(av)) * dir
        })
        .slice(0, op.n)
    }

    case 'map_template':
      return arr.map((item) => applyTemplate(op.template, item))

    default:
      throw new Error(`Unknown operation: ${(op as { op: string }).op}`)
  }
}

/**
 * Apply a pipeline of operations to a JSON array or object.
 *
 * @remarks
 * Operations are applied in order; each step transforms the output of the previous. Supported
 * operations: `filter`, `sort`, `select_keys`, `pluck`, `slice`, `unique`, `unique_by`,
 * `group_by`, `flatten`, `reverse`, `count`, `sum`, `avg`, `median`, `min`, `max`, `first`,
 * `last`, `chunk`, `frequency_count`, `top_n`, `map_template`. Dot-notation paths are supported
 * for nested key access in every operation that takes a `key` field.
 */
export const jsonTransformTool = new Tool({
  name: 'json_transform',
  description:
    'Apply a pipeline of operations to a JSON array or object: filter, sort, group, aggregate (sum/avg/median/min/max), pluck fields, deduplicate, flatten, chunk, frequency count, top-N, and more.',
  inputSchema: validator.object({
    data: validator.string().required().description('JSON data as a string (array or object)'),
    operations: validator
      .array()
      .items(validator.object().unknown(true))
      .required()
      .description(
        'Pipeline of operations to apply in order. Each step transforms the output of the previous.'
      ),
  }),
  handler: async (args) => {
    const { data: dataStr, operations } = args as {
      data: string
      operations: Operation[]
    }

    let data: unknown
    try {
      data = JSON.parse(dataStr)
    } catch {
      return 'Error: Invalid JSON input.'
    }

    let current: unknown = data

    for (const [i, operation] of operations.entries()) {
      try {
        current = applyOperation(current, operation)
      } catch (err) {
        const opName =
          operation && typeof operation === 'object' && 'op' in operation
            ? String((operation as { op: unknown }).op)
            : String(operation)
        return `Error in operation ${i + 1} ("${opName}"): ${isError(err) ? err.message : String(err)}`
      }
    }

    if (typeof current === 'string') return current
    return JSON.stringify(current, null, 2)
  },
})

/**
 * Perform set operations on two JSON arrays.
 *
 * @remarks
 * Supported operations: `intersection`, `union`, `difference`, `symmetric_difference`,
 * `is_member`, `is_subset`, `is_superset`. For arrays of objects, an optional `compare_key`
 * narrows equality to a single property rather than deep structural comparison.
 */
export const setOperationsTool = new Tool({
  name: 'set_operations',
  description:
    'Perform set operations on two JSON arrays: intersection (common elements), union (all elements), difference (in A but not B), symmetric difference, or membership check.',
  inputSchema: validator.object({
    data_a: validator.string().required().description('First JSON array'),
    data_b: validator.string().optional().description('Second JSON array'),
    operation: validator
      .string()
      .valid(
        'intersection',
        'union',
        'difference',
        'symmetric_difference',
        'is_member',
        'is_subset',
        'is_superset'
      )
      .required()
      .description('Set operation to perform'),
    item: validator.any().optional().description('For is_member: the value to look up in data_a.'),
    compare_key: validator
      .string()
      .optional()
      .description(
        'For arrays of objects: use this key for equality comparison instead of deep equality.'
      ),
  }),
  handler: async (args) => {
    const {
      data_a: dataA,
      data_b: dataB,
      operation,
      item,
      compare_key: compareKey,
    } = args as {
      data_a: string
      data_b?: string
      operation: string
      item?: unknown
      compare_key?: string
    }

    let a: unknown[]
    let b: unknown[] = []

    try {
      a = JSON.parse(dataA)
    } catch {
      return 'Error: data_a is not valid JSON.'
    }
    if (!Array.isArray(a)) return 'Error: data_a must be a JSON array.'

    if (dataB !== undefined) {
      try {
        b = JSON.parse(dataB)
      } catch {
        return 'Error: data_b is not valid JSON.'
      }
      if (!Array.isArray(b)) return 'Error: data_b must be a JSON array.'
    }

    const toKey = (val: unknown): string =>
      compareKey && isObject(val)
        ? String((val as Record<string, unknown>)[compareKey])
        : JSON.stringify(val)

    if (operation === 'is_member') {
      const needle = JSON.stringify(item)
      const found = a.some((entry) => JSON.stringify(entry) === needle)
      return found ? `Found: item is in the array.` : `Not found: item is not in the array.`
    }

    const setA = new Set(a.map(toKey))
    const setB = new Set(b.map(toKey))
    const indexA = new Map(a.map((entry) => [toKey(entry), entry]))

    switch (operation) {
      case 'intersection': {
        const result = [...setA].filter((k) => setB.has(k)).map((k) => indexA.get(k))
        return JSON.stringify(result, null, 2)
      }
      case 'union': {
        const result = [...a, ...b.filter((entry) => !setA.has(toKey(entry)))]
        return JSON.stringify(result, null, 2)
      }
      case 'difference': {
        const result = a.filter((entry) => !setB.has(toKey(entry)))
        return JSON.stringify(result, null, 2)
      }
      case 'symmetric_difference': {
        const result = [
          ...a.filter((entry) => !setB.has(toKey(entry))),
          ...b.filter((entry) => !setA.has(toKey(entry))),
        ]
        return JSON.stringify(result, null, 2)
      }
      case 'is_subset':
        return [...setA].every((k) => setB.has(k))
          ? `Yes: A is a subset of B (all ${a.length} elements of A are in B).`
          : `No: A is not a subset of B.`
      case 'is_superset':
        return [...setB].every((k) => setA.has(k))
          ? `Yes: A is a superset of B (A contains all ${b.length} elements of B).`
          : `No: A is not a superset of B.`
      default:
        return `Error: Unknown operation "${operation}".`
    }
  },
})
