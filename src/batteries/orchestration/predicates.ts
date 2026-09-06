import { E_ORCH_CELL_UNAVAILABLE } from './exceptions'
import { isInstanceOf, isObject } from '../../lib/utils/guards'
import type { EncodableValue } from './types'

// ── the structured predicate IR ─────────────────────────────────────────────
/**
 * The closed set of comparison operators a structured predicate leaf may name.
 *
 * `truthy` and `exists` take no `value`; every other operator requires one. The set is CLOSED —
 * `parseStructuredPredicate` refuses any other string with a model-addressed reason naming the
 * legal set, so a branch/select author cannot smuggle an operator no cell implements.
 */
export type PredicateOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'contains'
  | 'truthy'
  | 'exists'

/**
 * A leaf predicate: read `path` from the readable context and compare it with `op`.
 *
 * `value` is optional because `truthy` and `exists` are unary — they need no right-hand side.
 * For every other operator `parseStructuredPredicate` requires `value` to be present.
 */
export interface PredicateLeaf {
  /** The dot-path into the readable context to read and compare. */
  path: string
  /** The comparison operator. `truthy`/`exists` are unary and must not carry `value`. */
  op: PredicateOp
  /** The right-hand side to compare against. Required for every operator except `truthy`/`exists`. */
  value?: EncodableValue
}

/** A predicate that is satisfied only when EVERY member is satisfied. */
export interface AllPredicate {
  /** The member predicates; all must be satisfied. */
  all: StructuredPredicate[]
}

/** A predicate that is satisfied when AT LEAST ONE member is satisfied. */
export interface AnyPredicate {
  /** The member predicates; at least one must be satisfied. */
  any: StructuredPredicate[]
}

/** A predicate that is satisfied exactly when its single member is NOT satisfied. */
export interface NotPredicate {
  /** The member predicate; its negation is the result. */
  not: StructuredPredicate
}

/**
 * The structured predicate IR — the value a branch/select node's `predicate` field holds when the
 * structured cell interprets it.
 *
 * A discriminated union of four shapes: a leaf (`{path, op, value?}`), and the three combinators
 * `{all}`, `{any}`, `{not}`. The combinator shapes are discriminated by their single key, and a
 * leaf by the presence of `path`/`op`. `parseStructuredPredicate` is the single authority that
 * turns an untrusted `EncodableValue` into this IR.
 */
export type StructuredPredicate = PredicateLeaf | AllPredicate | AnyPredicate | NotPredicate

/**
 * Type guard for {@link PredicateLeaf}. A leaf is a plain object carrying a string `path` and a
 * string `op`; the `op` is narrowed to `PredicateOp` only when it is a member of the closed set.
 */
export const isPredicateLeaf = (v: unknown): v is PredicateLeaf => {
  if (!isObject(v)) return false
  if (!isSingleForm(v)) return false
  if (typeof v.path !== 'string') return false
  if (typeof v.op !== 'string') return false
  return isPredicateOp(v.op)
}

/**
 * Type guard for {@link AllPredicate}. An `all` combinator is a plain object whose sole
 * discriminator key `all` holds an array of structured predicates.
 */
export const isAllPredicate = (v: unknown): v is AllPredicate => {
  if (!isObject(v)) return false
  if (!isSingleForm(v)) return false
  if (!Array.isArray(v.all)) return false
  return v.all.every(isStructuredPredicate)
}

/**
 * Type guard for {@link AnyPredicate}. An `any` combinator is a plain object whose sole
 * discriminator key `any` holds an array of structured predicates.
 */
export const isAnyPredicate = (v: unknown): v is AnyPredicate => {
  if (!isObject(v)) return false
  if (!isSingleForm(v)) return false
  if (!Array.isArray(v.any)) return false
  return v.any.every(isStructuredPredicate)
}

/**
 * Type guard for {@link NotPredicate}. A `not` combinator is a plain object whose sole
 * discriminator key `not` holds a single structured predicate.
 */
export const isNotPredicate = (v: unknown): v is NotPredicate => {
  if (!isObject(v)) return false
  if (!isSingleForm(v)) return false
  return isStructuredPredicate(v.not)
}

/**
 * Type guard for the whole {@link StructuredPredicate} union. A value is a structured predicate
 * iff it is one of the four shapes. Because the combinator shapes are discriminated by their
 * single key and a leaf by `path`/`op`, the four guards are mutually exclusive.
 */
export const isStructuredPredicate = (v: unknown): v is StructuredPredicate => {
  return isPredicateLeaf(v) || isAllPredicate(v) || isAnyPredicate(v) || isNotPredicate(v)
}

/**
 * Type guard for {@link PredicateOp}. `op` is a member of the closed set.
 */
const isPredicateOp = (v: unknown): v is PredicateOp => {
  return (
    v === 'eq' ||
    v === 'ne' ||
    v === 'lt' ||
    v === 'lte' ||
    v === 'gt' ||
    v === 'gte' ||
    v === 'in' ||
    v === 'contains' ||
    v === 'truthy' ||
    v === 'exists'
  )
}

const LEGAL_OPS =
  "'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains' | 'truthy' | 'exists'"

/**
 * The recognised structural keys of a structured predicate: the leaf markers `path`/`op` and the
 * three combinator keys `all`/`any`/`not`.
 */
const STRUCTURAL_KEYS = ['all', 'any', 'not', 'path', 'op'] as const

/**
 * The structural keys an object actually carries, in a stable order.
 */
const presentStructuralKeys = (v: object): string[] => STRUCTURAL_KEYS.filter((k) => k in v)

/**
 * True when an object carries exactly one predicate FORM: a leaf (`path`/`op` with no combinator
 * key), or exactly one of `all`/`any`/`not`. A value mixing a leaf with a combinator, or carrying
 * more than one combinator key, is ambiguous and is not a single form.
 */
const isSingleForm = (v: object): boolean => {
  const present = presentStructuralKeys(v)
  const hasLeaf = present.includes('path') || present.includes('op')
  const combinators = present.filter((k) => k === 'all' || k === 'any' || k === 'not')
  return !(combinators.length > 1 || (hasLeaf && combinators.length > 0))
}

/**
 * The result of {@link parseStructuredPredicate}: either a validated predicate, or a
 * model-addressed reason naming the fix.
 */
export type ParsePredicateResult =
  | { ok: true; predicate: StructuredPredicate }
  | { ok: false; reason: string }

/**
 * The deepest combinator nesting a structured predicate may carry.
 *
 * @remarks
 * Chosen well below the measured failure point rather than at it: evaluation begins throwing
 * `RangeError` around 5,000 levels on Node 24, and a limit tuned to one engine's stack size would
 * be a limit that shifts under the reader. 256 is far past anything a human or a model writes —
 * `all`/`any` take LISTS, so real predicates are wide, not deep — while leaving a very large
 * margin against the actual overflow.
 */
export const MAX_PREDICATE_DEPTH = 256

/**
 * Validates an untrusted `EncodableValue` into the structured predicate IR.
 *
 * This is the single authority that turns a branch/select node's `predicate` field (typed
 * `EncodableValue` in the IR) into a {@link StructuredPredicate}. It never throws: every failure
 * returns `{ok: false, reason}` where `reason` is MODEL-ADDRESSED — it names the offending field
 * and the fix (for example, which operator is unknown and what the legal set is), so an authoring
 * model can correct the plan in one pass.
 *
 * The value is validated structurally, not by type alone: a leaf requires a string `path` and a
 * closed-set `op`; `truthy`/`exists` must not carry a `value` while every other operator must;
 * combinators require arrays of already-valid predicates (`all`/`any`) or a single one (`not`).
 * A value that is none of the four shapes is refused with a reason naming the shape it most
 * resembles, so the author knows what to change.
 *
 * @param value - The untrusted value to validate, as read from a plan's `predicate` field.
 * @returns A discriminated result: `{ok: true, predicate}` on success, or `{ok: false, reason}`
 *   naming the fix on failure.
 */
export const parseStructuredPredicate = (
  value: unknown,
  depth: number = 0
): ParsePredicateResult => {
  // DEPTH IS BOUNDED, and the bound is here rather than at evaluation because this is the gate
  // freeze runs. An over-deep tree overflows the JavaScript call stack — measured: evaluation
  // throws `RangeError` around 5,000 nested combinators and parsing itself throws around 20,000
  // — and a stack overflow escapes as an uncaught error, which breaks the cell's promise that a
  // predicate never crashes a run.
  //
  // Plan bounds do not cover this: a crashing 20,000-deep predicate encodes to roughly 180KB
  // against a 1 MiB `maxEncodedBytes`, so it passes freeze on size and detonates at run time.
  // Refusing here means the plan is rejected BEFORE an operator can approve it.
  if (depth > MAX_PREDICATE_DEPTH) {
    return {
      ok: false,
      reason:
        `predicate nests deeper than ${MAX_PREDICATE_DEPTH} combinators, which would overflow ` +
        'the call stack during evaluation. Flatten it — `all`/`any` take a LIST, so sibling ' +
        'conditions belong in one array rather than nested one per level.',
    }
  }
  if (!isObject(value)) {
    return {
      ok: false,
      reason:
        'predicate must be a structured predicate object: a leaf {path, op, value?}, or a ' +
        'combinator {all: [...]}, {any: [...]}, or {not: ...}. Got a non-object.',
    }
  }

  // Refuse a value that mixes more than one predicate FORM: a leaf with a combinator, or more
  // than one combinator key. Silently keeping whichever key the parser tests first would let an
  // approved plan branch on a condition the author never wrote.
  if (!isSingleForm(value)) {
    const present = presentStructuralKeys(value)
    return {
      ok: false,
      reason:
        `predicate mixes more than one form: it carries ${present.map((k) => `'${k}'`).join(', ')}. ` +
        'A predicate must be exactly one form: a leaf {path, op, value?}, or one of ' +
        '{all: [...]}, {any: [...]}, {not: ...}.',
    }
  }

  // A leaf: {path, op, value?}
  if ('path' in value || 'op' in value) {
    if (typeof value.path !== 'string') {
      return {
        ok: false,
        reason: `predicate leaf 'path' must be a string (a dot-path into the readable context). Got ${describe(value.path)}.`,
      }
    }
    if (typeof value.op !== 'string') {
      return {
        ok: false,
        reason: `predicate leaf 'op' must be a string. Got ${describe(value.op)}.`,
      }
    }
    if (!isPredicateOp(value.op)) {
      return {
        ok: false,
        reason: `predicate leaf 'op' is unknown: '${value.op}'. The legal set is ${LEGAL_OPS}.`,
      }
    }
    const unary = value.op === 'truthy' || value.op === 'exists'
    if (unary && 'value' in value) {
      return {
        ok: false,
        reason: `predicate leaf 'op' is '${value.op}', which is unary and must NOT carry a 'value'. Remove the 'value' field.`,
      }
    }
    if (!unary && !('value' in value)) {
      return {
        ok: false,
        reason: `predicate leaf 'op' is '${value.op}', which requires a 'value' to compare against. Add a 'value' field.`,
      }
    }
    return {
      ok: true,
      predicate: {
        path: value.path,
        op: value.op,
        value: value.value as EncodableValue | undefined,
      },
    }
  }

  // Combinators: {all}, {any}, {not}
  if ('all' in value) {
    if (!Array.isArray(value.all)) {
      return {
        ok: false,
        reason: `predicate combinator 'all' must be an array of structured predicates. Got ${describe(value.all)}.`,
      }
    }
    for (let i = 0; i < value.all.length; i++) {
      const member = parseStructuredPredicate(value.all[i], depth + 1)
      if (!member.ok) {
        return {
          ok: false,
          reason: `predicate combinator 'all' member ${i} is invalid: ${member.reason}`,
        }
      }
    }
    return { ok: true, predicate: { all: value.all as StructuredPredicate[] } }
  }
  if ('any' in value) {
    if (!Array.isArray(value.any)) {
      return {
        ok: false,
        reason: `predicate combinator 'any' must be an array of structured predicates. Got ${describe(value.any)}.`,
      }
    }
    for (let i = 0; i < value.any.length; i++) {
      const member = parseStructuredPredicate(value.any[i], depth + 1)
      if (!member.ok) {
        return {
          ok: false,
          reason: `predicate combinator 'any' member ${i} is invalid: ${member.reason}`,
        }
      }
    }
    return { ok: true, predicate: { any: value.any as StructuredPredicate[] } }
  }
  if ('not' in value) {
    const member = parseStructuredPredicate(value.not, depth + 1)
    if (!member.ok) {
      return {
        ok: false,
        reason: `predicate combinator 'not' is invalid: ${member.reason}`,
      }
    }
    return { ok: true, predicate: { not: member.predicate } }
  }

  return {
    ok: false,
    reason:
      'predicate must be a structured predicate object: a leaf {path, op, value?}, or a ' +
      'combinator {all: [...]}, {any: [...]}, or {not: ...}. Got an object with none of the ' +
      `discriminator keys 'path'/'op'/'all'/'any'/'not'.`,
  }
}

/**
 * A short, safe description of a value for use in a model-addressed reason. Never throws and
 * never inspects live objects beyond their constructor name.
 */
const describe = (v: unknown): string => {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return `a string`
  if (typeof v === 'number') return `a number`
  if (typeof v === 'boolean') return `a boolean`
  if (Array.isArray(v)) return `an array`
  if (isObject(v)) {
    const name = (v as { constructor?: { name?: string } }).constructor?.name
    return name ? `an object of type '${name}'` : 'an object'
  }
  return `a ${typeof v}`
}

// ── idempotent lazy loading ─────────────────────────────────────────────────
/**
 * Wraps a cell's `load()` so it is idempotent and converts a failed lazy `await import()` into
 * `E_ORCH_CELL_UNAVAILABLE`.
 *
 * A cell's `load()` is expected to resolve an optional ESM peer through a lazy `await import()`.
 * That import can fail (the package is not installed), and the failure must surface as a named
 * `E_ORCH_CELL_UNAVAILABLE` whose message names the missing package and its install command —
 * not as a raw module-resolution error the author cannot act on. This helper also makes `load()`
 * idempotent: the wrapped loader runs at most once, and every subsequent call resolves with the
 * same outcome, so a cell can be loaded once and reused across many plans without re-importing.
 *
 * The helper is deliberately minimal — it is a single idempotence + error-mapping wrapper, not a
 * plugin registry. A cell that needs to register itself with a consumer's registry does so in its
 * own `load()` body, before or after calling the wrapped loader.
 *
 * @param id - The cell's id, used to name the missing package in the error.
 * @param loader - The cell's actual load body (typically a lazy `await import()`).
 * @returns A wrapped loader that is idempotent and maps import failure to
 *   `E_ORCH_CELL_UNAVAILABLE`.
 */
export const loadOnce = (id: string, loader: () => Promise<void>): (() => Promise<void>) => {
  let state: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle'
  let pending: Promise<void> | undefined
  let failure: unknown

  return async () => {
    if (state === 'loaded') return
    if (state === 'failed') throw failure
    if (state === 'loading' && pending) return pending

    state = 'loading'
    pending = (async () => {
      try {
        await loader()
        state = 'loaded'
      } catch (err) {
        state = 'failed'
        failure = toCellUnavailable(id, err)
        throw failure
      }
    })()
    return pending
  }
}

/**
 * Maps a failed lazy import into an `E_ORCH_CELL_UNAVAILABLE` naming the missing package and its
 * install command. The package name is derived from the cell id (a cell id is expected to be the
 * package it loads, e.g. `'jexl'` or `'fengari'`); the install command is the standard
 * `npm install <id>`.
 */
const toCellUnavailable = (id: string, err: unknown): unknown => {
  const message =
    `orchestration cell '${id}' is unavailable: its optional peer could not be loaded. ` +
    `Install it with: npm install ${id}. Underlying error: ${isInstanceOf(err, 'Error', Error) ? err.message : String(err)}`
  return new E_ORCH_CELL_UNAVAILABLE([message])
}
