/**
 * @module @nhtio/adk/batteries/orchestration/cells/structured
 *
 * The `structured` predicate cell.
 *
 * This cell evaluates a declarative, JSON-shaped predicate tree against a
 * bounded, already-materialised plain-data snapshot of a run's outputs. It is
 * the default predicate evaluator for most plans because it has no external
 * dependencies: there is no parser to load and no runtime to initialise, so it
 * can never fail for a missing peer.
 *
 * Two properties hold by construction and are worth keeping in mind when
 * reading this cell:
 *
 * 1. It reads a plain-data snapshot rather than live objects. The predicate
 *    only ever touches values reached through `readPath` on the marshalled
 *    outputs, so it never invokes reachable methods or getters and cannot be
 *    surprised by object identity or prototype chains.
 * 2. It uses no clock and no randomness. A branch or select node is therefore
 *    safe to re-enter unconditionally when a run resumes: re-evaluating the
 *    same predicate against the same snapshot always yields the same verdict.
 */

import { readPath } from '../plan'
import { isObject, isInstanceOf } from '../../../lib/utils/guards'
import {
  parseStructuredPredicate,
  isPredicateLeaf,
  isAllPredicate,
  isAnyPredicate,
  isNotPredicate,
  type StructuredPredicate,
} from '../predicates'
import type { PredicateEvaluator, PredicateContext, PredicateVerdict, PlanNode } from './../types'

/**
 * Evaluate a structured predicate against a plain-data snapshot.
 *
 * Recurses over the predicate tree:
 * - `all` is true when every member is true.
 * - `any` is true when at least one member is true.
 * - `not` is the negation of its member.
 * - a leaf reads `leaf.path` from the snapshot and applies `leaf.op`.
 *
 * @param predicate - the structured predicate to evaluate.
 * @param snapshot - the plain-data snapshot to read leaf paths from.
 * @returns whether the predicate holds for the snapshot.
 */
const evaluatePredicate = (predicate: StructuredPredicate, snapshot: unknown): boolean => {
  if (isPredicateLeaf(predicate)) {
    return evaluateLeaf(predicate, snapshot)
  }
  if (isAllPredicate(predicate)) {
    return predicate.all.every((member) => evaluatePredicate(member, snapshot))
  }
  if (isAnyPredicate(predicate)) {
    return predicate.any.some((member) => evaluatePredicate(member, snapshot))
  }
  if (isNotPredicate(predicate)) {
    return !evaluatePredicate(predicate.not, snapshot)
  }
  return false
}

/**
 * Apply a single leaf predicate to the snapshot.
 *
 * The value at `leaf.path` is read with `readPath`, which already rejects
 * prototype-polluting segments and returns `undefined` for a missing path.
 * Comparison semantics are deliberately total: mismatched or non-comparable
 * types yield `false` rather than throwing.
 *
 * @param leaf - the leaf predicate to apply.
 * @param snapshot - the plain-data snapshot to read from.
 * @returns whether the leaf holds for the snapshot.
 */
const evaluateLeaf = (
  leaf: { path: string; op: string; value?: unknown },
  snapshot: unknown
): boolean => {
  const actual = readPath(snapshot, leaf.path)
  const expected = leaf.value

  switch (leaf.op) {
    case 'eq':
      return equals(actual, expected)
    case 'ne':
      return !equals(actual, expected)
    case 'lt':
      return compare(actual, expected) < 0
    case 'lte':
      return compare(actual, expected) <= 0
    case 'gt':
      return compare(actual, expected) > 0
    case 'gte':
      return compare(actual, expected) >= 0
    case 'in':
      return Array.isArray(expected) && expected.some((item) => equals(actual, item))
    case 'contains':
      return contains(actual, expected)
    case 'truthy':
      return Boolean(actual)
    case 'exists':
      return actual !== undefined
    default:
      return false
  }
}

/**
 * Strict equality that treats two `Date` instances as equal when they share a
 * time value. Mismatched types are simply not equal and never throw.
 *
 * @param a - the left operand.
 * @param b - the right operand.
 * @returns whether `a` and `b` are equal.
 */
const equals = (a: unknown, b: unknown): boolean => {
  if (isInstanceOf(a, 'Date', Date) && isInstanceOf(b, 'Date', Date)) {
    return a.getTime() === b.getTime()
  }
  return a === b
}

/**
 * Order two comparable values. Only two numbers, two `Date` instances, or two
 * strings are comparable; any other combination is treated as incomparable and
 * yields a non-zero result so the ordering operators report `false`.
 *
 * @param a - the left operand.
 * @param b - the right operand.
 * @returns a negative, zero, or positive number, or `NaN` when incomparable.
 */
const compare = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (isInstanceOf(a, 'Date', Date) && isInstanceOf(b, 'Date', Date)) {
    return a.getTime() - b.getTime()
  }
  return Number.NaN
}

/**
 * Membership test for `contains`: a string containing the expected value, or an
 * array including it. Any other combination is `false`.
 *
 * @param actual - the value read from the snapshot.
 * @param expected - the value to look for.
 * @returns whether `actual` contains `expected`.
 */
const contains = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.includes(expected)
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => equals(item, expected))
  }
  return false
}

/**
 * Build the plain-data snapshot a predicate reads.
 *
 * @remarks
 * `ctx.outputs` is an `OutputTable` — a `ReadonlyMap`. `readPath` walks with property access, so
 * handing it the Map directly reads NOTHING: every path misses and every leaf evaluates false, so
 * a branch silently took `no_match` on a predicate that should have matched. Marshalling is also
 * the cross-cutting rule for every cell — a predicate reads a bounded, already-materialised
 * snapshot, never live objects with reachable methods — and the jexl cell already did this.
 *
 * Each table key maps to the merged `json` of that output's items, so a predicate addresses
 * `` `${nodeId}:${branchKey}`.field ``.
 *
 * @param outputs - The frame's branch-local output table.
 * @returns A plain record keyed identically to the table.
 */
const snapshotOf = (outputs: PredicateContext['outputs']): Record<string, unknown> => {
  const snapshot: Record<string, unknown> = {}
  for (const [key, output] of outputs) {
    const merged: Record<string, unknown> = {}
    for (const item of output.items) {
      for (const [k, v] of Object.entries(item.json)) merged[k] = v
    }
    snapshot[key] = merged
  }
  return snapshot
}

/**
 * The `structured` predicate evaluator.
 *
 * Zero-dependency by design: `load` is an idempotent no-op, `validate` checks
 * that the node's predicate parses, and `evaluate` produces a branch or select
 * verdict from the parsed predicate tree.
 */
export const createStructuredCell = (): PredicateEvaluator => ({
  id: 'structured',

  /**
   * No-op initialisation. This cell has no parser or runtime to load, so it is
   * always ready and can be called any number of times.
   */
  async load(): Promise<void> {
    // Intentionally empty: nothing to initialise.
  },

  /**
   * Validate that the node's predicate is a well-formed structured predicate.
   *
   * @param node - the plan node to validate.
   * @throws when the predicate fails to parse, carrying the parser's reason.
   */
  async validate(node: PlanNode): Promise<void> {
    const definition = node.definition as { predicate?: unknown; cases?: string[] }

    if (node.kind === 'select') {
      // A `select`'s predicate is a record of case label -> structured predicate. Refusing here,
      // at freeze, is what stops a plan reaching the approval gate with cases that can never fire.
      const cases = definition.cases ?? []
      if (!isObject(definition.predicate)) {
        throw new Error(
          `Select node "${node.id}" needs its "predicate" to be an object mapping each case label ` +
            `to a structured predicate (for example {"${cases[0] ?? 'label'}": {"path": "...", "op": "eq", "value": "..."}}).`
        )
      }
      const byCase = definition.predicate as Record<string, unknown>
      for (const label of cases) {
        if (!(label in byCase)) {
          throw new Error(
            `Select node "${node.id}" declares case "${label}" but its "predicate" object has no ` +
              `entry for it; add one, or remove the case.`
          )
        }
        const parsed = parseStructuredPredicate(byCase[label])
        if (!parsed.ok) {
          throw new Error(`Select node "${node.id}", case "${label}": ${parsed.reason}`)
        }
      }
      return
    }

    const parsed = parseStructuredPredicate(definition?.predicate)
    if (!parsed.ok) {
      throw new Error(parsed.reason)
    }
  },

  /**
   * Evaluate the node's predicate against the run's outputs.
   *
   * For a `branch` node the verdict reports whether the predicate matched. For
   * a `select` node the predicate is evaluated against each case label in
   * declared order and the first match is returned; `null` routes to the
   * `default` handle.
   *
   * @param node - the plan node to evaluate.
   * @param ctx - the evaluation context carrying the outputs snapshot.
   * @returns the branch or select verdict.
   */
  async evaluate(node: PlanNode, ctx: PredicateContext): Promise<PredicateVerdict> {
    const definition = node.definition as {
      predicate?: unknown
      cases?: string[]
    }
    const snapshot = snapshotOf(ctx.outputs)

    if (node.kind === 'select') {
      // A `select` needs a predicate PER CASE, so the node's `predicate` is a record mapping each
      // declared case label to its own structured predicate. The first label whose predicate holds
      // wins, in the order `cases` declares — so the author controls precedence, and overlapping
      // predicates resolve deterministically rather than by object key order.
      //
      // A single predicate cannot express an n-way choice: it answers true or false. The other
      // cells solve this by having the predicate RETURN a label (jexl compares the evaluated value
      // to each case; Lua likewise), but the structured IR is a closed boolean tree with no way to
      // yield a string — so the mapping is declared instead of computed. An earlier version looped
      // the case labels while re-evaluating ONE boolean, which returned the first label whenever
      // that predicate was true and `null` otherwise: the second and later cases were unreachable.
      const cases = definition.cases ?? []
      const byCase = definition.predicate
      if (!isObject(byCase)) return { kind: 'select', caseLabel: null }
      for (const label of cases) {
        const parsed = parseStructuredPredicate((byCase as Record<string, unknown>)[label])
        if (!parsed.ok) continue
        if (evaluatePredicate(parsed.predicate, snapshot)) {
          return { kind: 'select', caseLabel: label }
        }
      }
      // Nothing matched: the `default` handle. Also the total answer for a malformed predicate —
      // a predicate is never allowed to crash a run.
      return { kind: 'select', caseLabel: null }
    }

    const parsed = parseStructuredPredicate(definition?.predicate)
    if (!parsed.ok) return { kind: 'branch', matched: false }
    return { kind: 'branch', matched: evaluatePredicate(parsed.predicate, snapshot) }
  },
})
