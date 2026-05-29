/**
 * Pre-constructed tools for comparing primitive values, arrays, and ranges.
 *
 * @module @nhtio/adk/batteries/tools/comparison
 *
 * @remarks
 * Pre-constructed bundled tools for the `comparison` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'

type Primitive = string | number | boolean | null | undefined

function coerce(value: Primitive): number | string | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  const n = Number(value)
  if (!Number.isNaN(n) && value.trim() !== '') return n
  return value
}

function compareTwo(a: Primitive, b: Primitive): number {
  const ca = coerce(a)
  const cb = coerce(b)
  if (ca === null && cb === null) return 0
  if (ca === null) return -1
  if (cb === null) return 1
  if (typeof ca === 'number' && typeof cb === 'number') return ca - cb
  return String(ca).localeCompare(String(cb))
}

/**
 * Compare two values and return their relationship (`equal`, `greater_than`, `less_than`).
 *
 * @remarks
 * Handles numbers, strings (lexicographic), booleans, ISO date strings, and null/undefined.
 * Use `type_hint` to force a specific interpretation; the default `auto` infers from the
 * values themselves.
 */
export const compareValuesTool = new Tool({
  name: 'compare_values',
  description:
    'Compare two values and return their relationship: equal, greater_than, less_than, or not_comparable. Handles numbers, strings (lexicographic), booleans, dates (ISO strings), null/undefined.',
  inputSchema: validator.object({
    a: validator.any().required().description('First value to compare'),
    b: validator.any().required().description('Second value to compare'),
    type_hint: validator
      .string()
      .valid('auto', 'string', 'number', 'date')
      .default('auto')
      .description(
        'Force interpretation: "auto" detects, "date" parses ISO date strings, "string" compares lexicographically, "number" coerces to numbers (default: auto)'
      ),
    case_insensitive: validator
      .boolean()
      .default(false)
      .description('For string comparisons: ignore case (default: false)'),
  }),
  handler: async (args) => {
    const {
      a: rawA,
      b: rawB,
      type_hint: typeHint,
      case_insensitive: ci,
    } = args as {
      a: unknown
      b: unknown
      type_hint: string
      case_insensitive: boolean
    }

    let av: unknown = rawA
    let bv: unknown = rawB

    try {
      if (typeHint === 'date') {
        const da = new Date(av as string)
        const db = new Date(bv as string)
        if (Number.isNaN(da.getTime())) return `Error: Cannot parse "${av}" as a date.`
        if (Number.isNaN(db.getTime())) return `Error: Cannot parse "${bv}" as a date.`
        const diff = da.getTime() - db.getTime()
        const rel = diff === 0 ? 'equal' : diff > 0 ? 'greater_than' : 'less_than'
        return `${rel}\na = ${da.toISOString()}\nb = ${db.toISOString()}`
      }

      if (typeHint === 'number') {
        const na = Number(av)
        const nb = Number(bv)
        if (Number.isNaN(na)) return `Error: Cannot convert "${av}" to a number.`
        if (Number.isNaN(nb)) return `Error: Cannot convert "${bv}" to a number.`
        const diff = na - nb
        return diff === 0 ? 'equal' : diff > 0 ? 'greater_than' : 'less_than'
      }

      if (typeHint === 'string') {
        const sa = ci ? String(av).toLowerCase() : String(av)
        const sb = ci ? String(bv).toLowerCase() : String(bv)
        const cmp = sa.localeCompare(sb)
        return cmp === 0 ? 'equal' : cmp > 0 ? 'greater_than' : 'less_than'
      }

      // auto
      if (ci && typeof av === 'string' && typeof bv === 'string') {
        av = av.toLowerCase()
        bv = bv.toLowerCase()
      }
      const cmp = compareTwo(av as Primitive, bv as Primitive)
      return cmp === 0 ? 'equal' : cmp > 0 ? 'greater_than' : 'less_than'
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Compare two JSON objects and report keys only in A, keys only in B, keys with matching
 * values, and keys with differing values.
 *
 * @remarks
 * Accepts JSON strings (not pre-parsed objects) so the schema can validate the input
 * shape uniformly across providers. When `deep` is true (default), nested objects and arrays
 * are compared structurally; when false, comparison reduces to JSON serialisation equality.
 */
export const compareRecordsTool = new Tool({
  name: 'compare_records',
  description:
    'Compare two JSON objects and report: keys only in A, keys only in B, keys present in both with the same value, and keys present in both with different values.',
  inputSchema: validator.object({
    record_a: validator.string().required().description('First JSON object (as a string)'),
    record_b: validator.string().required().description('Second JSON object (as a string)'),
    deep: validator
      .boolean()
      .default(true)
      .description(
        'Use deep equality for nested values (default: true). When false, compares by JSON serialization.'
      ),
  }),
  handler: async (args) => {
    const {
      record_a: recordA,
      record_b: recordB,
      deep,
    } = args as { record_a: string; record_b: string; deep: boolean }

    let a: Record<string, unknown>
    let b: Record<string, unknown>

    try {
      a = JSON.parse(recordA) as Record<string, unknown>
    } catch {
      return 'Error: record_a is not valid JSON.'
    }
    try {
      b = JSON.parse(recordB) as Record<string, unknown>
    } catch {
      return 'Error: record_b is not valid JSON.'
    }

    if (typeof a !== 'object' || a === null || Array.isArray(a))
      return 'Error: record_a must be a JSON object (not array or primitive).'
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      return 'Error: record_b must be a JSON object (not array or primitive).'

    function isEqual(x: unknown, y: unknown): boolean {
      if (!deep) return JSON.stringify(x) === JSON.stringify(y)
      if (x === y) return true
      if (typeof x !== typeof y) return false
      if (x === null || y === null) return x === y
      if (Array.isArray(x) && Array.isArray(y)) {
        if (x.length !== y.length) return false
        for (const [i, element] of x.entries()) {
          if (!isEqual(element, y[i])) return false
        }
        return true
      }
      if (typeof x === 'object' && typeof y === 'object') {
        const xk = Object.keys(x as object).sort()
        const yk = Object.keys(y as object).sort()
        if (JSON.stringify(xk) !== JSON.stringify(yk)) return false
        for (const k of xk) {
          if (!isEqual((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]))
            return false
        }
        return true
      }
      return false
    }

    const keysA = new Set(Object.keys(a))
    const keysB = new Set(Object.keys(b))

    const onlyInA: string[] = []
    const onlyInB: string[] = []
    const same: string[] = []
    const different: Array<{ key: string; a: unknown; b: unknown }> = []

    for (const k of keysA) {
      if (!keysB.has(k)) {
        onlyInA.push(k)
      } else if (isEqual(a[k], b[k])) {
        same.push(k)
      } else {
        different.push({ key: k, a: a[k], b: b[k] })
      }
    }

    for (const k of keysB) {
      if (!keysA.has(k)) onlyInB.push(k)
    }

    const lines: string[] = []

    if (onlyInA.length > 0) lines.push(`Only in A (${onlyInA.length}): ${onlyInA.join(', ')}`)
    if (onlyInB.length > 0) lines.push(`Only in B (${onlyInB.length}): ${onlyInB.join(', ')}`)
    if (same.length > 0) lines.push(`Same value (${same.length}): ${same.join(', ')}`)

    if (different.length > 0) {
      lines.push(`Different value (${different.length}):`)
      for (const { key, a: av, b: bv } of different) {
        lines.push(`  ${key}: A=${JSON.stringify(av)}, B=${JSON.stringify(bv)}`)
      }
    }

    if (lines.length === 0) return 'Records are identical.'
    return lines.join('\n')
  },
})
