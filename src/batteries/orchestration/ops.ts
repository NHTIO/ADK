/**
 * The op-log fold and the branch-key renderer for orchestration.
 *
 * @module @nhtio/adk/batteries/orchestration/ops
 *
 * @remarks
 * This module owns two things:
 *
 * 1. `foldOps` — the DETERMINISTIC fold that turns a plan's op log into a `RawPlanView`. The plan
 *    IS the fold of its op log: two actors folding the same op set must reach the same state, and
 *    ops may arrive out of order or twice. The fold never throws on a malformed-but-well-typed
 *    log; it surfaces `PlanIssue`s instead.
 * 2. `branchKey` — the canonical, INJECTIVE string form of a `BranchId` route, used to key
 *    `OutputTable`, identify `NodeRef.branchId`, order join contributors, and make duplicate
 *    arrivals idempotent.
 */

import { planDigest } from './encoding'
import { DEFAULT_PLAN_BOUNDS } from './types'
import type {
  PlanOp,
  PlanNode,
  PlanEdge,
  PlanBounds,
  RawPlanView,
  PlanIssue,
  NodeId,
  BranchId,
  PlanProvenance,
} from './types'

// ── the three-part key ───────────────────────────────────────────────────────
/**
 * Total order over ops: `(lamport, actorId, opId)`.
 *
 * @remarks
 * All three parts are REQUIRED, and the reason is convergence. `(lamport, actorId)` alone is not a
 * total order: one actor can legitimately emit two ops at the same lamport (a single logical
 * instant can author several edits), and then the arrival order would decide which of those two
 * ops is "later" — exactly the non-convergence the op log exists to prevent. Two offline writers
 * who each append before their logs meet would fold the same op set into different states purely
 * because of when each op happened to arrive. `opId` is unique by construction, so appending it
 * makes the triple total: no two ops share a key, and the sorted order is identical for every
 * actor regardless of arrival order. The fold therefore sorts by this triple before applying, and
 * the highest-key op touching any element is applied last and wins (LWW).
 */
const byKey = (a: PlanOp, b: PlanOp): number => {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport
  if (a.actorId !== b.actorId) return a.actorId < b.actorId ? -1 : 1
  if (a.opId !== b.opId) return a.opId < b.opId ? -1 : 1
  return 0
}

// ── spine copy ───────────────────────────────────────────────────────────────
/**
 * True for a PLAIN object — one whose prototype is `Object.prototype` or `null`. This is the same
 * distinction `encoding.ts`'s `isPlainObject` makes: every encoder-owned value (`Date`, `RegExp`,
 * `Map`, `Set`, typed arrays, `ArrayBuffer`, `DataView`, bigint, luxon values, and
 * `NodeRef`/`ParamRef` instances) has a non-plain prototype.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Copy the PLAIN-OBJECT/ARRAY spine of a value, carrying every other value across BY REFERENCE.
 *
 * @remarks
 * The fold treats every op as strictly read-only input, so it must never hand the caller's op
 * objects to the working map. But a naive JSON round-trip or a recursive rebuild would destroy
 * encoder-owned values — a `Date`, `RegExp`, `Map`, `Set`, typed array, bigint, or a
 * `NodeRef`/`ParamRef` INSTANCE — and the plan digest depends on those surviving intact. So we
 * copy only the plain-object/array spine and let every other value ride through unchanged, the
 * same distinction `encoding.ts`'s `isPlainObject` makes.
 */
const copySpine = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(copySpine)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = copySpine(value[key])
    return out
  }
  return value
}

// ── field-path setter ────────────────────────────────────────────────────────
/**
 * Set a dot-path within a node definition, COPYING along the path so the source op's node object
 * is never mutated. Intermediate objects are created when absent. The value is assigned by
 * reference (never copied) — the fold does not own the op's values.
 */
const setPath = (root: unknown, path: string, value: unknown): unknown => {
  const parts = path.split('.')
  const copy = (v: unknown): any =>
    // eslint-disable-next-line adk/prefer-is-object -- isObject excludes arrays, but arrays must be copied with [...v] here
    v !== null && typeof v === 'object' ? (Array.isArray(v) ? [...v] : { ...v }) : v
  const newRoot = copy(root)
  let cur = newRoot
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cur[key]
    cur[key] =
      // eslint-disable-next-line adk/prefer-is-object -- isObject excludes arrays, but arrays must be copied via copy()
      next !== null && typeof next === 'object' ? copy(next) : {}
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = value
  return newRoot
}

// ── foldOps ──────────────────────────────────────────────────────────────────
/**
 * Fold an op log into a `RawPlanView`, deterministically and convergently.
 *
 * @remarks
 * The plan is the fold of its op log. Two actors folding the same op set must reach the same
 * state, and ops may arrive out of order or twice. The fold is therefore a pure function of the
 * op SET: it sorts by the three-part key `(lamport, actorId, opId)` — see {@link byKey} for why
 * all three parts are required — and applies the ops in that total order. Because the highest-key
 * op touching any element is applied last, the result is LWW (last-writer-wins) and identical for
 * every arrival order.
 *
 * **Ops are strictly read-only input.** The fold never mutates the caller's op objects: on
 * `add_node` and `set_node_definition` it copies the plain-object/array SPINE of the node or
 * definition (carrying every encoder-owned value — `Date`, `RegExp`, `Map`, `Set`, typed arrays,
 * bigint, `NodeRef`/`ParamRef` instances — across by reference), and `set_node_field`/
 * `set_node_phase` write only onto those copies. So a `PlanStore` can serve historical views from
 * the same op log without a read-only projection silently altering it.
 *
 * **Bounds are the fold SEED, not an op.** The fold starts from `DEFAULT_PLAN_BOUNDS`, so an empty
 * log folds to revision 0 with a complete view and a stable digest, and the first authoring op
 * makes revision 1. `revision` is the number of ops folded. `set_bounds` ops override the seed by
 * LWW thereafter.
 *
 * **Element semantics.** `add_node`/`remove_node` and `add_edge`/`remove_edge` are LWW-ELEMENT,
 * not add-wins: the highest-key op touching an element decides whether it exists. Add-wins is
 * deliberately NOT attempted — it needs causal context a scalar lamport cannot provide. A
 * `remove_node` also records its `incidentEdgeIds`, so removal cascades to those edges
 * order-independently. `set_node_field` is LWW per field on the same three-part key (its value may
 * contain a `NodeRef`, so it accepts `ArgValue`); `set_node_definition` replaces a whole
 * definition by LWW; `set_node_phase` sets a phase, with `null` clearing it; `set_bounds` overrides
 * the seed by LWW.
 *
 * **The fold surfaces issues rather than throwing.** It never throws on a malformed-but-well-typed
 * log:
 * - An edge whose `from` or `to` node does not exist after folding is DROPPED and surfaced as a
 *   `dangling_edge` issue — a dangling edge is never what anyone wanted.
 * - Two `add_edge` ops with the SAME id but different endpoints: LWW decides, the loser is dropped,
 *   and the issue names BOTH so the author renames one. The second is not refused at append time —
 *   that would make the fold order-dependent, and two offline writers can each legally append
 *   before their logs meet.
 * - An op referencing an unknown nodeId is surfaced as an `unknown_node` issue, not thrown.
 *
 * The `digest` is computed via `planDigest(view)` with the digest field itself empty when hashing,
 * so it cannot depend on itself.
 *
 * @param planId - The plan's id, carried into the view.
 * @param ops - The op log to fold. May be empty, out of order, or contain duplicates.
 * @param provenance - Optional lineage (clone/template), carried into the view and covered by the
 *   digest.
 * @returns The folded view and any issues the fold surfaced.
 */
export const foldOps = (
  planId: string,
  ops: readonly PlanOp[],
  provenance?: PlanProvenance
): { view: RawPlanView; issues: PlanIssue[] } => {
  const sorted = [...ops].sort(byKey)
  const nodes = new Map<NodeId, PlanNode>()
  const edges = new Map<string, PlanEdge>()
  let bounds: PlanBounds = { ...DEFAULT_PLAN_BOUNDS }
  const issues: PlanIssue[] = []

  // Same-id add_edge collision detection: per edgeId, the set of distinct endpoint signatures
  // seen and the first edge that claimed the id (to name both sides of a collision).
  const edgeSigs = new Map<string, Set<string>>()
  const edgeFirst = new Map<string, PlanEdge>()

  for (const op of sorted) {
    switch (op.op) {
      case 'add_node': {
        nodes.set(op.node.id, copySpine(op.node) as PlanNode)
        break
      }
      case 'remove_node': {
        nodes.delete(op.nodeId)
        for (const edgeId of op.incidentEdgeIds) edges.delete(edgeId)
        break
      }
      case 'set_node_field': {
        const node = nodes.get(op.nodeId)
        if (node)
          node.definition = setPath(node.definition, op.path, op.value) as PlanNode['definition']
        break
      }
      case 'set_node_definition': {
        const node = nodes.get(op.nodeId)
        if (node) node.definition = copySpine(op.definition) as PlanNode['definition']
        break
      }
      case 'set_node_phase': {
        const node = nodes.get(op.nodeId)
        if (node) {
          if (op.phase === null) delete node.phase
          else node.phase = op.phase
        }
        break
      }
      case 'add_edge': {
        const sig = `${op.edge.from}\u0000${op.edge.to}\u0000${op.edge.handle}`
        if (!edgeSigs.has(op.edge.id)) {
          edgeSigs.set(op.edge.id, new Set([sig]))
          edgeFirst.set(op.edge.id, op.edge)
        } else {
          const sigs = edgeSigs.get(op.edge.id)!
          if (!sigs.has(sig)) {
            const first = edgeFirst.get(op.edge.id)!
            issues.push({
              code: 'duplicate_edge_id',
              message:
                `Edge id "${op.edge.id}" is used by two different edges: ` +
                `${first.from}→${first.to} (${first.handle}) and ${op.edge.from}→${op.edge.to} ` +
                `(${op.edge.handle}); rename one of them.`,
              edgeId: op.edge.id,
              severity: 'advisory',
            })
            sigs.add(sig)
          }
        }
        edges.set(op.edge.id, op.edge)
        break
      }
      case 'remove_edge': {
        edges.delete(op.edgeId)
        break
      }
      case 'set_bounds': {
        bounds = { ...op.bounds }
        break
      }
    }
  }

  // Cleanup: drop dangling edges (from/to node absent after folding) and surface them.
  const finalEdges = new Map<string, PlanEdge>()
  for (const [edgeId, edge] of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      finalEdges.set(edgeId, edge)
    } else {
      issues.push({
        code: 'dangling_edge',
        message:
          `Edge "${edgeId}" (${edge.from} → ${edge.to}) references a node that does not ` +
          `exist after folding; the edge was dropped.`,
        edgeId,
        severity: 'advisory',
      })
    }
  }

  // Cleanup: surface ops that reference a nodeId absent from the final folded node set.
  const unknownNodeIds = new Set<NodeId>()
  for (const op of sorted) {
    if (
      op.op === 'set_node_field' ||
      op.op === 'set_node_definition' ||
      op.op === 'set_node_phase'
    ) {
      if (!nodes.has(op.nodeId)) unknownNodeIds.add(op.nodeId)
    }
  }
  for (const nodeId of unknownNodeIds) {
    issues.push({
      code: 'unknown_node',
      message:
        `Node "${nodeId}" does not exist in the folded plan; add it or remove the ops ` +
        `that reference it.`,
      nodeId,
      severity: 'advisory',
    })
  }

  const view: RawPlanView = {
    planId,
    digest: '',
    revision: ops.length,
    nodes: [...nodes.values()],
    edges: [...finalEdges.values()],
    bounds,
    ...(provenance ? { provenance } : {}),
  }
  view.digest = planDigest(view)

  return { view, issues }
}

// ── branchKey ────────────────────────────────────────────────────────────────
/**
 * The canonical, INJECTIVE string form of a `BranchId` route.
 *
 * @remarks
 * `branchKey` keys `OutputTable`, identifies `NodeRef.branchId`, orders join contributors, and
 * makes duplicate arrivals idempotent — so a collision would overwrite one node's output with
 * another's or merge unrelated barriers. It MUST therefore be injective.
 *
 * Naive delimiter-joining is NOT injective: an edge id containing the delimiter (`a>b`) collides
 * with two segments (`a`, `b`), and an id shaped like `join:x(y)` collides with a join segment. So
 * the rendering is LENGTH-PREFIXED, concatenated with no separator:
 * - an edge segment renders as `` `e${id.length}:${id}` ``;
 * - a join segment renders as `` `j${nodeId.length}:${nodeId}(${of.map(len-prefixed).join('')})` ``.
 *
 * Length-prefixing is injective regardless of content: a parser reads the length, then exactly
 * that many characters for the id, so no delimiter can be forged and no two distinct routes render
 * to the same string. The `e`/`j` prefixes keep edge and join segments disjoint, and the join's
 * `of` ids are themselves length-prefixed so the closing `)` is unambiguous.
 *
 * @param b - The route to render.
 * @returns The length-prefixed, separator-free canonical string.
 */
export const branchKey = (b: BranchId): string => {
  let out = ''
  for (const seg of b.segments) {
    if ('edge' in seg) {
      out += `e${seg.edge.length}:${seg.edge}`
    } else {
      const of = seg.of.map((id) => `e${id.length}:${id}`).join('')
      out += `j${seg.join.length}:${seg.join}(${of})`
    }
  }
  return out
}
