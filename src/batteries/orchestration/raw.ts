/**
 * The machine-readable reading surface for a plan's op log.
 *
 * @module @nhtio/adk/batteries/orchestration/raw
 *
 * @remarks
 * The prose views (`render`, `outline`) are for humans and for model re-consumption: they adapt
 * their audience, frame trust, and narrate. A UI showing "here is what changed and what will be
 * applied" needs machine-readable state instead, and the op log makes that well-defined. This
 * module is that surface.
 *
 * Three properties this view has that the prose views deliberately do NOT:
 *
 * 1. **It is NOT audience-adapted.** It is data — no narrative, no trust framing, no prose. A
 *    `RawPlanView` is the folded content of the log, and nothing more.
 * 2. **It is STABLE.** A given revision folds to the same bytes forever, which is what makes a
 *    digest meaningful. The fold is a pure function of the op set (see `foldOps`), so the same
 *    prefix always yields the same view and the same digest.
 * 3. **It is reachable both ways.** As a plain exported function, for a UI talking to a
 *    `PlanStore` directly and never going through an agent; and later as a tool, so a model can
 *    read the same data through the same seam.
 *
 * **`RawPlanView` carries NO lifecycle `state`, and that is deliberate.** Lifecycle state is not
 * a `PlanOp`, so it cannot be folded from the log, and a historical revision therefore has no
 * recoverable state to report. A view at revision 7 answers "what did the CONTENT look like
 * then", not "what state was it in then". `state` is a property of the plan NOW — read it from
 * `store.readState()`. Do not add a `state` field.
 */

import { foldOps } from './ops'
import { isObject } from '../../lib/utils/guards'
import type { PlanStore } from './store'
import type { ArgValue, PlanDiff, PlanEdge, PlanNode, PlanOp, RawPlanView } from './types'

/**
 * Fold the plan's op log up to a revision into a `RawPlanView`.
 *
 * @remarks
 * The plan IS the fold of its op log, so this is the canonical way to read plan CONTENT. With no
 * `revision`, it folds the plan's present log. With `{revision: N}`, it serves a HISTORICAL view:
 * it reads the op prefix `throughRevision: N` and folds exactly that prefix, so the result is
 * what the content looked like at revision N. A revision the log never reached is REJECTED by
 * the store (which throws rather than silently returning everything) — this function never
 * guesses or truncates.
 *
 * `provenance` (clone/template lineage) is read from `store.readProvenance(planId)` and carried
 * into the view, where it is covered by the digest.
 *
 * The returned view carries NO lifecycle `state` — see the module doc. `state` is a property of
 * the plan NOW and lives on `store.readState()`, not here.
 *
 * @param store - The plan store to read from.
 * @param planId - The plan to read.
 * @param opts - Optional revision selector.
 * @param opts.revision - Fold only the op prefix through this revision. Omitted folds the present
 *   log.
 * @returns The folded content view at the requested revision.
 */
export const rawPlan = async (
  store: PlanStore,
  planId: string,
  opts?: { revision?: number }
): Promise<RawPlanView> => {
  const ops = await store.readOps(planId, { throughRevision: opts?.revision })
  const provenance = await store.readProvenance(planId)
  return foldOps(planId, ops, provenance).view
}

/**
 * Read the plan's raw op log.
 *
 * @remarks
 * The op log is the source of truth the fold reads; this returns the ops themselves, optionally
 * filtered. `sinceLamport` filters by clock (a Lamport value is not a revision selector — use
 * `throughRevision` to bound by revision). `throughRevision` bounds the result to a REVISION
 * PREFIX, which is what `rawPlan({revision})` and `rawDiff(a, b)` need. A revision the log never
 * reached is rejected by the store rather than silently returning everything.
 *
 * @param store - The plan store to read from.
 * @param planId - The plan to read.
 * @param opts - Optional filters.
 * @param opts.sinceLamport - Only ops with `lamport >= sinceLamport`.
 * @param opts.throughRevision - Only ops up to and including this revision.
 * @returns The matching ops, in the store's order.
 */
export const rawOps = async (
  store: PlanStore,
  planId: string,
  opts?: { sinceLamport?: number; throughRevision?: number }
): Promise<PlanOp[]> => {
  return store.readOps(planId, opts)
}

/**
 * A STRUCTURAL delta between two folded states of a plan.
 *
 * @remarks
 * `rawDiff(a, b)` compares two folded states, NOT an event log. It resolves each side to a
 * revision (`'current'` means the plan's present revision), folds both prefixes, and compares the
 * resulting content structurally:
 *
 * - `nodesAdded` / `nodesRemoved` are keyed by node id.
 * - `nodesChanged` names the CHANGED FIELD PATHS with before/after values, typed `ArgValue` — a
 *   changed field may hold a `NodeRef`, so a narrower type would make a legitimate change
 *   unrepresentable.
 * - `edgesAdded` / `edgesRemoved` are keyed by edge id; an edge whose endpoints or handle changed
 *   counts as removed-then-added, since its identity is its id.
 * - Both digests are carried so a UI can label either side.
 *
 * Because this is a FINAL-STATE diff, a node edited and then reverted across the compared span
 * produces NO row — the two states are identical at that node, and there is nothing to report.
 *
 * @param store - The plan store to read from.
 * @param planId - The plan to diff.
 * @param a - The "from" side: a revision number or `'current'`.
 * @param b - The "to" side: a revision number or `'current'`.
 * @returns The structural delta between the two folded states.
 */
export const rawDiff = async (
  store: PlanStore,
  planId: string,
  a: number | 'current',
  b: number | 'current'
): Promise<PlanDiff> => {
  const resolve = async (side: number | 'current'): Promise<number> => {
    if (side === 'current') {
      const state = await store.readState(planId)
      return state.revision
    }
    return side
  }

  const [revA, revB] = await Promise.all([resolve(a), resolve(b)])

  const [opsA, opsB] = await Promise.all([
    store.readOps(planId, { throughRevision: revA }),
    store.readOps(planId, { throughRevision: revB }),
  ])

  const viewA = foldOps(planId, opsA).view
  const viewB = foldOps(planId, opsB).view

  const nodesA = new Map(viewA.nodes.map((n) => [n.id, n]))
  const nodesB = new Map(viewB.nodes.map((n) => [n.id, n]))

  const nodesAdded: PlanNode[] = []
  const nodesRemoved: PlanNode[] = []
  const nodesChanged: PlanDiff['nodesChanged'] = []

  for (const node of viewB.nodes) {
    if (!nodesA.has(node.id)) {
      nodesAdded.push(node)
    }
  }
  for (const node of viewA.nodes) {
    if (!nodesB.has(node.id)) {
      nodesRemoved.push(node)
    }
  }

  for (const [id, nodeB] of nodesB) {
    const nodeA = nodesA.get(id)
    if (!nodeA) continue
    const fields = diffNode(nodeA, nodeB)
    if (fields.length > 0) {
      nodesChanged.push({ nodeId: id, fields })
    }
  }

  const edgesA = new Map(viewA.edges.map((e) => [e.id, e]))
  const edgesB = new Map(viewB.edges.map((e) => [e.id, e]))

  const edgesAdded: PlanEdge[] = []
  const edgesRemoved: PlanEdge[] = []

  for (const [id, edgeB] of edgesB) {
    const edgeA = edgesA.get(id)
    if (!edgeA || !sameEdge(edgeA, edgeB)) {
      edgesAdded.push(edgeB)
    }
  }
  for (const [id, edgeA] of edgesA) {
    const edgeB = edgesB.get(id)
    if (!edgeB || !sameEdge(edgeA, edgeB)) {
      edgesRemoved.push(edgeA)
    }
  }

  return {
    from: { revision: revA, digest: viewA.digest },
    to: { revision: revB, digest: viewB.digest },
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    edgesAdded,
    edgesRemoved,
  }
}

/**
 * Compare two node definitions structurally and return the changed field paths with before/after
 * values. A node's `id` and `phase` are compared too, but only definition changes are reported as
 * field paths; a changed `phase` is reported under the `phase` path.
 */
const diffNode = (
  a: PlanNode,
  b: PlanNode
): { path: string; before: ArgValue; after: ArgValue }[] => {
  const fields: { path: string; before: ArgValue; after: ArgValue }[] = []
  const walk = (path: string, before: unknown, after: unknown): void => {
    if (isObject(before) && isObject(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)])
      for (const key of keys) {
        const childPath = path ? `${path}.${key}` : key
        walk(
          childPath,
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key]
        )
      }
      return
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) {
        fields.push({ path, before: before as ArgValue, after: after as ArgValue })
        return
      }
      for (const [i, element] of before.entries()) {
        walk(`${path}.${i}`, element, after[i])
      }
      return
    }
    if (before !== after) {
      fields.push({ path, before: before as ArgValue, after: after as ArgValue })
    }
  }
  walk('', a.definition, b.definition)
  if (a.phase !== b.phase) {
    fields.push({ path: 'phase', before: a.phase as ArgValue, after: b.phase as ArgValue })
  }
  return fields
}

/**
 * Whether two edges are the same edge — same id, endpoints and handle. An edge whose endpoints or
 * handle changed is treated as removed-then-added, since its identity is its id.
 */
const sameEdge = (a: PlanEdge, b: PlanEdge): boolean =>
  a.from === b.from && a.to === b.to && a.handle === b.handle
