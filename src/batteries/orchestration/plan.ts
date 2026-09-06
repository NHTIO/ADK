/**
 * The IR's runtime helpers: pure, graph-shaped predicates and guards.
 *
 * @module @nhtio/adk/batteries/orchestration/plan
 *
 * @remarks
 * This module is the shared vocabulary that WP 04's freeze validation and WP 07's executor both
 * call. It performs NO validation policy itself and throws nothing — it answers questions about a
 * graph. Every export is a pure function over `{nodes, edges}` (a `RawPlanView` or any structural
 * subset carrying those two arrays), so the same code path serves a full folded view and a
 * hand-built slice.
 *
 * The functions here are deliberately small and single-purpose. Policy — "exactly one entry",
 * "the graph is acyclic", "every join is a diamond" — lives in the freeze validator, which
 * composes these primitives; the executor composes them to decide what fires next. Neither
 * reimplements a graph walk.
 */

import type { PlanNode, PlanEdge, NodeId, EdgeHandle, PlanNodeKind, RawPlanView } from './types'

// ── the structural view ─────────────────────────────────────────────────────
/**
 * The minimal structural surface these helpers read. A `RawPlanView` satisfies it; so does any
 * `{nodes, edges}` subset. Accepting the subset keeps the helpers usable on slices and test
 * fixtures without forcing a full view.
 */
export interface PlanGraphView {
  /** Every node in the graph being examined, in no significant order. */
  nodes: readonly PlanNode[]
  /** Every edge in the graph being examined, over all handles. */
  edges: readonly PlanEdge[]
}

/** Normalise a `RawPlanView` or a structural subset to the minimal view. */
const asView = (view: RawPlanView | PlanGraphView): PlanGraphView => view

// ── shape guards ─────────────────────────────────────────────────────────────
/** The closed set of `PlanNodeKind` values a well-shaped node may carry. */
const NODE_KINDS: ReadonlySet<string> = new Set([
  'entry',
  'call',
  'reason',
  'transform',
  'branch',
  'select',
  'join',
])

/**
 * True when `v` is a well-shaped `PlanNode`.
 *
 * @remarks
 * A shape guard, not a validator: it checks the closed union of `kind` values and the presence of
 * the `id`/`definition` fields, and does not descend into the definition (whose shape is the
 * freeze validator's job). `kind` must be one of the seven closed values; anything else is not a
 * plan node. `id` must be a string; `definition` must be a non-null object. Extra fields are
 * tolerated — a node may carry `phase`.
 *
 * @param v - The value to test.
 * @returns True when `v` is a `PlanNode`.
 */
export const isPlanNode = (v: unknown): v is PlanNode => {
  if (v === null || typeof v !== 'object') return false
  const n = v as Record<string, unknown>
  return (
    typeof n.id === 'string' &&
    typeof n.kind === 'string' &&
    NODE_KINDS.has(n.kind) &&
    n.definition !== null &&
    typeof n.definition === 'object'
  )
}

/** The closed set of literal `EdgeHandle` values (excluding the `case_` prefix). */
const EDGE_HANDLES: ReadonlySet<string> = new Set([
  'always',
  'match',
  'no_match',
  'default',
  'error',
])

/**
 * True when `v` is a well-shaped `PlanEdge`.
 *
 * @remarks
 * A shape guard, not a validator. `handle` must be one of the closed `EdgeHandle` values — the
 * five literal handles, or a `case_${string}` (the `case_` prefix is reserved for `select` cases,
 * so any string starting with `case_` is a legal handle). `id`, `from` and `to` must be strings.
 * Extra fields are tolerated.
 *
 * @param v - The value to test.
 * @returns True when `v` is a `PlanEdge`.
 */
export const isPlanEdge = (v: unknown): v is PlanEdge => {
  if (v === null || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.from === 'string' &&
    typeof e.to === 'string' &&
    typeof e.handle === 'string' &&
    (EDGE_HANDLES.has(e.handle) || e.handle.startsWith('case_'))
  )
}

// ── lookup ───────────────────────────────────────────────────────────────────
/**
 * Look up a node by id.
 *
 * @param view - The graph to search.
 * @param id - The node id to find.
 * @returns The node, or `undefined` when no node carries that id.
 */
export const nodeById = (view: RawPlanView | PlanGraphView, id: NodeId): PlanNode | undefined =>
  asView(view).nodes.find((n) => n.id === id)

/**
 * The edges leaving a node.
 *
 * @param view - The graph to search.
 * @param nodeId - The source node id.
 * @returns Every edge whose `from` is `nodeId`, in view order.
 */
export const outgoing = (view: RawPlanView | PlanGraphView, nodeId: NodeId): PlanEdge[] =>
  asView(view).edges.filter((e) => e.from === nodeId)

/**
 * The edges entering a node.
 *
 * @param view - The graph to search.
 * @param nodeId - The target node id.
 * @returns Every edge whose `to` is `nodeId`, in view order.
 */
export const incoming = (view: RawPlanView | PlanGraphView, nodeId: NodeId): PlanEdge[] =>
  asView(view).edges.filter((e) => e.to === nodeId)

// ── entry ────────────────────────────────────────────────────────────────────
/**
 * Every node of kind `'entry'`.
 *
 * @remarks
 * Whether exactly one exists is WP 04's rule, not this function's. The executor calls this to
 * find what to materialise; the freeze validator calls it to enforce the exactly-one invariant.
 * Returning an array (rather than a single node) keeps this a pure question about the graph and
 * lets the caller decide what a count of zero or more than one means.
 *
 * @param view - The graph to search.
 * @returns Every node whose `kind` is `'entry'`, in view order.
 */
export const entryNodes = (view: RawPlanView | PlanGraphView): PlanNode[] =>
  asView(view).nodes.filter((n) => n.kind === 'entry')

// ── reachability ─────────────────────────────────────────────────────────────
/**
 * The forward closure from a start node over ALL edge handles.
 *
 * @remarks
 * `error` and `default` edges are included: a node reachable only over an error edge is still
 * reachable, because the executor can still execute it. The closure is the set of nodes reachable
 * by following any outgoing edge transitively. The start node itself is included. A node with no
 * outgoing edges contributes nothing further.
 *
 * @param view - The graph to search.
 * @param startId - The node to start from.
 * @returns The set of node ids reachable from `startId`, including `startId` itself.
 */
export const reachableFrom = (view: RawPlanView | PlanGraphView, startId: NodeId): Set<NodeId> => {
  const g = asView(view)
  const byFrom = new Map<NodeId, PlanEdge[]>()
  for (const e of g.edges) {
    const list = byFrom.get(e.from)
    if (list) list.push(e)
    else byFrom.set(e.from, [e])
  }
  const seen = new Set<NodeId>([startId])
  const stack: NodeId[] = [startId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const e of byFrom.get(cur) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to)
        stack.push(e.to)
      }
    }
  }
  return seen
}

// ── cycle detection ──────────────────────────────────────────────────────────
/**
 * Find a cycle in the graph, over EVERY edge handle.
 *
 * @remarks
 * A topological sort over all edges — `error` and `default` included — because an error edge back
 * to an ancestor is still a cycle: it can still execute, so it can still loop. A diamond fan-in
 * (two distinct paths reaching one node) is NOT a cycle and is not reported. The function returns
 * the CLOSING edge — the edge whose `to` is already on the current path — so a caller can name it
 * in an issue. Returns `undefined` when the graph is acyclic.
 *
 * The algorithm is an iterative DFS with three node states (unvisited / on-stack / done). When a
 * back edge is found, the edge that closes the cycle is returned immediately.
 *
 * @param view - The graph to search.
 * @returns The closing edge of the first cycle found, or `undefined` when acyclic.
 */
export const findCycle = (
  view: RawPlanView | PlanGraphView
): { edgeId: string; from: NodeId; to: NodeId } | undefined => {
  const g = asView(view)
  const byFrom = new Map<NodeId, PlanEdge[]>()
  for (const e of g.edges) {
    const list = byFrom.get(e.from)
    if (list) list.push(e)
    else byFrom.set(e.from, [e])
  }
  const state = new Map<NodeId, 0 | 1 | 2>() // 0 unvisited, 1 on-stack, 2 done
  const stack: { node: NodeId; next: number }[] = []

  for (const n of g.nodes) {
    if (state.get(n.id) === 2) continue
    state.set(n.id, 1)
    stack.push({ node: n.id, next: 0 })
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const edges = byFrom.get(top.node) ?? []
      if (top.next < edges.length) {
        const e = edges[top.next]
        top.next++
        const s = state.get(e.to)
        if (s === 1) {
          return { edgeId: e.id, from: e.from, to: e.to }
        }
        if (s === undefined) {
          state.set(e.to, 1)
          stack.push({ node: e.to, next: 0 })
        }
      } else {
        state.set(top.node, 2)
        stack.pop()
      }
    }
  }
  return undefined
}

// ── simple paths ─────────────────────────────────────────────────────────────
/** The cap on distinct simple paths `routesBetween` will enumerate before giving up. */
const MAX_ROUTES = 10_000

/**
 * All distinct simple paths from one node to another.
 *
 * @remarks
 * A simple path is a route that visits no node twice. This is used to derive a join's `required`
 * (the number of fork→join routes) and to validate the diamond topology. The result is a list of
 * node-id sequences, each starting at `fromId` and ending at `toId`.
 *
 * **Blowup guard.** The number of simple paths in a DAG can be exponential in the node count, so
 * this enumerates at most {@link MAX_ROUTES} paths and stops. A caller that needs an exact count
 * (a join's `required`) must treat a truncated result as "too many to count" and refuse the graph
 * rather than trust a partial count — the freeze validator does exactly that. The cap is a
 * documented safety valve, not a correctness knob.
 *
 * @param view - The graph to search.
 * @param fromId - The start node id.
 * @param toId - The target node id.
 * @returns Every distinct simple path from `fromId` to `toId`, truncated at {@link MAX_ROUTES}.
 */
export const routesBetween = (
  view: RawPlanView | PlanGraphView,
  fromId: NodeId,
  toId: NodeId
): NodeId[][] => {
  const g = asView(view)
  const byFrom = new Map<NodeId, PlanEdge[]>()
  for (const e of g.edges) {
    const list = byFrom.get(e.from)
    if (list) list.push(e)
    else byFrom.set(e.from, [e])
  }
  const results: NodeId[][] = []
  const path: NodeId[] = [fromId]
  const onPath = new Set<NodeId>([fromId])

  const dfs = (cur: NodeId): void => {
    if (results.length >= MAX_ROUTES) return
    if (cur === toId) {
      results.push([...path])
      return
    }
    for (const e of byFrom.get(cur) ?? []) {
      if (onPath.has(e.to)) continue
      onPath.add(e.to)
      path.push(e.to)
      dfs(e.to)
      path.pop()
      onPath.delete(e.to)
      if (results.length >= MAX_ROUTES) return
    }
  }

  dfs(fromId)
  return results
}

// ── immediate dominator ──────────────────────────────────────────────────────
/**
 * The immediate dominator of a node, relative to an entry.
 *
 * @remarks
 * The standard iterative dominator algorithm (Cooper–Harvey–Kennedy). A node `d` dominates `n`
 * when every path from `entryId` to `n` passes through `d`; the immediate dominator is the unique
 * strict dominator closest to `n`. A join's FORK is its immediate dominator — which is what makes
 * diamond joins decidable: the fork is known statically, so correlation and `required` are
 * computable at freeze.
 *
 * Returns `undefined` when `nodeId` is the entry itself (a node does not dominate itself in the
 * immediate sense) or when `nodeId` is unreachable from `entryId` (no dominator exists).
 *
 * @param view - The graph to search.
 * @param entryId - The entry node id.
 * @param nodeId - The node whose immediate dominator to find.
 * @returns The immediate dominator's id, or `undefined` when none exists.
 */
export const immediateDominator = (
  view: RawPlanView | PlanGraphView,
  entryId: NodeId,
  nodeId: NodeId
): NodeId | undefined => {
  const g = asView(view)
  if (nodeId === entryId) return undefined

  const byFrom = new Map<NodeId, PlanEdge[]>()
  const byTo = new Map<NodeId, PlanEdge[]>()
  for (const e of g.edges) {
    const o = byFrom.get(e.from)
    if (o) o.push(e)
    else byFrom.set(e.from, [e])
    const i = byTo.get(e.to)
    if (i) i.push(e)
    else byTo.set(e.to, [e])
  }

  // Reachable set from entry, over all handles.
  const reachable = new Set<NodeId>([entryId])
  const stack: NodeId[] = [entryId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const e of byFrom.get(cur) ?? []) {
      if (!reachable.has(e.to)) {
        reachable.add(e.to)
        stack.push(e.to)
      }
    }
  }
  if (!reachable.has(nodeId)) return undefined

  const nodes = g.nodes.map((n) => n.id).filter((id) => reachable.has(id))
  const idSet = new Set(nodes)
  const preds = new Map<NodeId, NodeId[]>()
  for (const id of nodes) {
    const ps: NodeId[] = []
    for (const e of byTo.get(id) ?? []) {
      if (idSet.has(e.from)) ps.push(e.from)
    }
    preds.set(id, ps)
  }

  // Initialise: entry dominates itself; everything else is dominated by everything.
  const dom = new Map<NodeId, Set<NodeId>>()
  for (const id of nodes) dom.set(id, new Set(nodes))
  dom.set(entryId, new Set([entryId]))

  // Iterate to a fixpoint.
  let changed = true
  while (changed) {
    changed = false
    for (const id of nodes) {
      if (id === entryId) continue
      const ps = preds.get(id) ?? []
      if (ps.length === 0) continue
      let newDom: Set<NodeId> | undefined
      for (const p of ps) {
        const pdom = dom.get(p)!
        newDom = newDom === undefined ? new Set(pdom) : intersect(newDom, pdom)
      }
      newDom!.add(id)
      if (!setsEqual(newDom!, dom.get(id)!)) {
        dom.set(id, newDom!)
        changed = true
      }
    }
  }

  // Immediate dominator: the CLOSEST strict dominator of nodeId (its dominator set minus
  // itself). Among the strict dominators, the immediate dominator is the one dominated by every
  // other strict dominator — i.e. the one closest to nodeId. So prefer `d` when `d` is dominated
  // BY the current candidate (`idom` dominates `d`), NOT when `d` dominates `idom` (that would
  // walk toward the farthest strict dominator, always `entry`).
  const nodeDom = dom.get(nodeId)!
  let idom: NodeId | undefined
  for (const d of nodeDom) {
    if (d === nodeId) continue
    if (idom === undefined) {
      idom = d
      continue
    }
    // `d` is a better candidate if it is dominated by the current idom (i.e. is closer to nodeId).
    if (dom.get(d)!.has(idom)) idom = d
  }
  return idom
}

/** Intersection of two sets. */
const intersect = <T>(a: Set<T>, b: Set<T>): Set<T> => {
  const out = new Set<T>()
  for (const v of a) if (b.has(v)) out.add(v)
  return out
}

/** Set equality. */
const setsEqual = <T>(a: Set<T>, b: Set<T>): boolean => {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// ── handle applicability ──────────────────────────────────────────────────────
/**
 * Whether an edge handle may be used on an edge leaving a node of a given kind.
 *
 * @remarks
 * The applicability table, exactly:
 * - `entry` → `'always'`
 * - `call` | `reason` | `transform` → `'always'` | `'error'`
 * - `branch` → `'match'` | `'no_match'` | `'default'` | `'error'`
 * - `select` → `case_${string}` | `'default'` | `'error'`
 * - `join` → `'always'` | `'error'`
 *
 * This is a pure question about the graph; the freeze validator enforces it as policy. The
 * executor uses it to decide which handles may fire for a settled node's outcome.
 *
 * @param kind - The source node's kind.
 * @param handle - The edge handle to test.
 * @returns True when the handle is legal for that node kind.
 */
export const handleAppliesTo = (kind: PlanNodeKind, handle: EdgeHandle): boolean => {
  switch (kind) {
    case 'entry':
      return handle === 'always'
    case 'call':
    case 'reason':
    case 'transform':
      return handle === 'always' || handle === 'error'
    case 'branch':
      return (
        handle === 'match' || handle === 'no_match' || handle === 'default' || handle === 'error'
      )
    case 'select':
      return handle.startsWith('case_') || handle === 'default' || handle === 'error'
    case 'join':
      return handle === 'always' || handle === 'error'
  }
}

// ── prototype-pollution-safe path read ────────────────────────────────────────
/** Segments that would let a crafted path reach the prototype chain. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * Read a dot-path from a value, with a per-segment prototype-pollution guard.
 *
 * @remarks
 * This is the prototype-pollution guard, so it is strict. Each path segment is checked against
 * `__proto__`, `prototype` and `constructor` BEFORE it is used as a key; any of those is refused
 * (returns `undefined`) rather than followed. This prevents a crafted path like
 * `a.__proto__.polluted` or `constructor.prototype.x` from reaching the prototype chain. A
 * missing path — a segment that is absent, or a non-object intermediate — returns `undefined`.
 *
 * The guard is per-segment, not just on the whole path, because a path is split on `.` and each
 * segment is a separate key access; a single check on the joined string would miss a segment
 * smuggled past an object boundary. Empty segments (from a leading/trailing dot or a double dot)
 * are treated as missing and return `undefined`.
 *
 * @param value - The value to read from.
 * @param path - A dot-separated path, e.g. `'a.b.c'`.
 * @returns The value at the path, or `undefined` when the path is missing or refused.
 */
export const readPath = (value: unknown, path: string): unknown => {
  if (path === '') return value
  let cur = value
  for (const seg of path.split('.')) {
    if (seg === '' || FORBIDDEN_SEGMENTS.has(seg)) return undefined
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

// ── id validation ────────────────────────────────────────────────────────────
/**
 * Whether a string is a valid node id.
 *
 * @remarks
 * A valid node id is snake_case: lowercase ASCII letters, digits and underscores, with no `/` and
 * no leading `.`. The `/` and leading-`.` rules are load-bearing: a path-shaped id gets copied by
 * small models as a citation, which cost a real 35–57 dispatch re-cite loop in this repo. Keeping
 * node ids out of path shape means a model cannot mistake one for a file path and re-cite it.
 *
 * @param id - The string to test.
 * @returns True when `id` is a valid node id.
 */
export const isValidNodeId = (id: string): boolean =>
  /^[a-z0-9_]+$/.test(id) && !id.startsWith('.') && !id.includes('/')

/**
 * Whether a string is a valid edge id.
 *
 * @remarks
 * An edge id must match `/^[A-Za-z0-9_-]{1,64}$/` — no delimiter, no colon, no parenthesis — so
 * `branchKey` cannot be forged. This is the same charset rule the freeze validator enforces; this
 * guard is the pure predicate it calls. The length cap (1–64) bounds the length-prefixed route
 * rendering.
 *
 * @param id - The string to test.
 * @returns True when `id` is a valid edge id.
 */
export const isValidEdgeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id)
