/**
 * The neutral `MediaPlan` intermediate representation and its canonical serializers.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. All three front-ends — the
 * chainable builder, the pipe-string parser, and the JSON ops array — compile to this one IR,
 * and the step runtime consumes only this IR. Invariants (frozen design, section 0.7):
 *
 * - **Serializable.** No live `RegExp`, `Media`, or function values — regexes are
 *   `{ source, flags }`, media refs are typed handles. A plan can be logged, content-hashed,
 *   and embedded in a tool result.
 * - **Round-trip is fixed-point.** `parsePipe(toPipe(plan))` produces an equal plan and
 *   `toPipe` is idempotent. `toPipe(parsePipe(s)) === s` is NOT promised (e.g. `2,3,4,5`
 *   renders as `2-5`).
 * - **Engine-agnostic.** Steps name verbs, never engines.
 */

import { isObject } from '@nhtio/adk/guards'
import { E_MEDIA_NOT_PIPE_EXPRESSIBLE } from './exceptions'

/**
 * A serializable regex reference. Never a live `RegExp` in the IR.
 */
export interface RegExpRef {
  /** The regex source, exactly as `RegExp.prototype.source` would report it. */
  source: string
  /** Sorted flag characters (canonicalized — `gi`, never `ig`). */
  flags: string
}

/**
 * A reference to another media participating in a multi-input verb (`merge`, `diff`,
 * `apply_patch`, `slides.update_image`).
 *
 * @remarks
 * The `id` variant is the canonical model-facing form — the pipe syntax is an inline
 * `@id` token (`merge with=@018f…`) and the ops form carries the same id. The `builder`
 * variant is implementor-only (a nested chain: `mp(a).diff(mp(b).convert('txt'))`) and is
 * not expressible in a flat pipe string.
 */
export type MediaRef = { kind: 'id'; id: string } | { kind: 'builder'; plan: MediaPlan }

/** Scalar arg values the flat pipe grammar can express directly. */
export type MediaArgScalar = string | number | boolean | RegExpRef | MediaRef

/**
 * A structured (JSON-shaped) arg value. In the pipe surface these are written as quoted JSON
 * (`updates='[{"address":"B2","value":3}]'`); in ops they are plain JSON. `null` is legal only
 * inside structured values (cell values), never as a top-level scalar.
 */
export type MediaArgJson =
  | string
  | number
  | boolean
  | null
  | MediaArgJson[]
  | { [key: string]: MediaArgJson }

/**
 * The value space of a single verb arg in the IR.
 *
 * @remarks
 * Flat lists (`types=image,font` → `['image','font']`) are `MediaArgScalar[]`. Whether a
 * value parsed from quoted JSON or a flat token is decided by the verb's arg schema — the IR
 * stores the final shape only.
 */
export type MediaArgValue = MediaArgScalar | MediaArgScalar[] | MediaArgJson

/** Source span carried by steps parsed from a pipe string, for error mapping. */
export interface SourceSpan {
  /** Zero-based character offset into the source string. */
  offset: number
  /** One-based line number. */
  line: number
  /** One-based column number. */
  col: number
  /** Length of the spanned text in characters. */
  length: number
}

/** One transform step: a canonical verb id plus its validated content args. */
export interface MediaStep {
  /**
   * Canonical verb id — dot-namespaced snake_case (`convert`, `select`, `extract.text`,
   * `sheet.update_cells`, `image.resize`).
   */
  verb: string
  /** Validated content args for this verb. */
  args: Record<string, MediaArgValue>
  /** Present when the step came from a pipe string; absent for builder/ops origins. */
  span?: SourceSpan
}

/** The neutral plan: an ordered, linear list of steps. No branching. */
export interface MediaPlan {
  /** The ordered transform steps. */
  steps: MediaStep[]
}

/** The JSON ops front-end's step shape — identical to {@link MediaStep} minus the span. */
export interface MediaOp {
  /** The canonical (or foldable) verb id. */
  verb: string
  /** The verb's named args. */
  args: Record<string, MediaArgValue>
}

// ── guards ───────────────────────────────────────────────────────────────────

/** `true` when `value` is a {@link RegExpRef}. */
export const isRegExpRef = (value: unknown): value is RegExpRef => {
  if (!isObject(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.source === 'string' && typeof v.flags === 'string' && Object.keys(v).length === 2
}

/** `true` when `value` is a {@link MediaRef}. */
export const isMediaRef = (value: unknown): value is MediaRef => {
  if (!isObject(value)) return false
  const v = value as MediaRef
  if (v.kind === 'id') return typeof (v as { id?: unknown }).id === 'string'
  if (v.kind === 'builder') return isObject((v as { plan?: unknown }).plan)
  return false
}

// ── canonical rendering helpers ──────────────────────────────────────────────

/** Characters legal in an unquoted bareword value. */
const BAREWORD = /^[A-Za-z0-9_]+$/
/** Strings that would lex as a non-ident token and therefore must be quoted. */
const LEXES_AS_OTHER = /^(?:\d+(?:-\d+)?|\d+\.\d+|true|false|@.*)$/

/**
 * The frozen quoting predicate: quote any string that is empty, would lex as a number, range,
 * boolean, or `@id` token, starts with `/`, or contains a character outside `[A-Za-z0-9_]`.
 */
const renderString = (s: string): string => {
  if (s.length === 0 || !BAREWORD.test(s) || LEXES_AS_OTHER.test(s) || s.startsWith('/')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return s
}

/** Canonicalize regex flags: validate against JS flags and sort. */
export const canonicalFlags = (flags: string): string => Array.from(flags).sort().join('')

/** Render a {@link RegExpRef} back to a pipe regex literal, re-escaping bare slashes. */
const renderRegExp = (ref: RegExpRef): string => {
  const source = ref.source.length === 0 ? '(?:)' : ref.source
  // Escape bare `/` that are not already escaped and not inside a character class.
  let out = ''
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\') {
      out += ch + (source[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    if (ch === '/' && !inClass) {
      out += '\\/'
      continue
    }
    out += ch
  }
  return `/${out}/${canonicalFlags(ref.flags)}`
}

/**
 * Compress maximal ascending consecutive runs in a number list to `a-b` range tokens.
 * Order-preserving and lossless on the array; never sorts or dedupes.
 */
const renderNumberList = (nums: number[]): string => {
  const parts: string[] = []
  let i = 0
  while (i < nums.length) {
    let j = i
    while (
      j + 1 < nums.length &&
      Number.isInteger(nums[j]) &&
      nums[j + 1] === (nums[j] as number) + 1
    ) {
      j++
    }
    if (j - i >= 1 && Number.isInteger(nums[i])) {
      parts.push(`${nums[i]}-${nums[j]}`)
    } else {
      parts.push(String(nums[i]))
      j = i
    }
    i = j + 1
  }
  return parts.join(',')
}

const renderScalar = (value: MediaArgScalar): string => {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return renderString(value)
  if (isRegExpRef(value)) return renderRegExp(value)
  // MediaRef
  if (value.kind === 'id') return `@${value.id}`
  throw new E_MEDIA_NOT_PIPE_EXPRESSIBLE(['nested builder refs have no pipe form; use toOps()'])
}

const isScalar = (value: MediaArgValue): value is MediaArgScalar =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean' ||
  isRegExpRef(value) ||
  isMediaRef(value)

const renderValue = (value: MediaArgValue): string => {
  if (value === null) {
    // null is only legal inside structured JSON values
    throw new E_MEDIA_NOT_PIPE_EXPRESSIBLE(['null is not a flat pipe value; use toOps()'])
  }
  if (Array.isArray(value)) {
    const arr = value as MediaArgScalar[]
    if (arr.length > 0 && arr.every((v) => typeof v === 'number')) {
      return renderNumberList(arr as number[])
    }
    if (arr.every(isScalar)) {
      return arr.map(renderScalar).join(',')
    }
    // structured (nested) array -> quoted JSON
    return `'${JSON.stringify(value)}'`
  }
  if (isScalar(value)) return renderScalar(value)
  // structured object -> quoted JSON
  return `'${JSON.stringify(value)}'`
}

/**
 * Render a {@link MediaPlan} to its canonical pipe string.
 *
 * @remarks
 * Total for every plan except those containing builder-variant media refs, which throw
 * {@link E_MEDIA_NOT_PIPE_EXPRESSIBLE}. Structured args render as quoted JSON. The output is
 * canonical: dot-namespaced verbs render as space-separated words, number runs compress to
 * ranges, strings quote per the frozen predicate.
 *
 * @param plan - The plan to render.
 * @returns The canonical pipe expression.
 */
export const toPipe = (plan: MediaPlan): string =>
  plan.steps
    .map((step) => {
      const verb = step.verb.replace(/\./g, ' ')
      const args = Object.entries(step.args)
        .map(([k, v]) => `${k}=${renderValue(v)}`)
        .join(' ')
      return args.length > 0 ? `${verb} ${args}` : verb
    })
    .join(' | ')

/**
 * Render a {@link MediaPlan} to its JSON ops array. Total — every plan has an ops form.
 *
 * @param plan - The plan to render.
 * @returns The ops array (spans stripped).
 */
export const toOps = (plan: MediaPlan): MediaOp[] =>
  plan.steps.map((step) => ({ verb: step.verb, args: step.args }))

/**
 * Build a {@link MediaPlan} from a JSON ops array. The inverse of {@link toOps}.
 *
 * @remarks
 * Performs structural normalization only (verb-id folding via the caller's verb table happens
 * in validation, not here). Steps carry no spans.
 *
 * @param ops - The ops array.
 * @returns The equivalent plan.
 */
export const fromOps = (ops: MediaOp[]): MediaPlan => ({
  steps: ops.map((op) => ({ verb: op.verb, args: op.args })),
})
