/**
 * Submit-time validation and the lifecycle machine.
 *
 * @module @nhtio/adk/batteries/orchestration/validation
 *
 * @remarks
 * This module owns the freeze gate: it folds a plan's op log into a `RawPlanView`, runs every
 * submit check over that folded graph, and — only on a clean pass — commits the
 * `editable → reviewable` transition. It is the "the battery validates, the store commits" split
 * made concrete: every check here is battery policy a bring-your-own store has no business
 * reimplementing, and the store's `transition` is the only boundary that can atomically move the
 * lifecycle state.
 *
 * The two exported functions are the whole surface:
 *
 * - {@link collectIssues} — the pure-ish validator. Given a folded view and the injected
 *   `FreezeInputs` (the tier-C allowlist and the wired predicate cells), it returns every
 *   `PlanIssue` the graph raises. It never throws on a well-typed-but-invalid plan; a malformed
 *   definition surfaces as an issue, not a crash.
 * - {@link freezePlan} — the lifecycle entry point. It folds the log, runs {@link collectIssues},
 *   and only when no issue is `blocking` calls `store.transition(editable → reviewable,
 *   {expectedDigest})`. The digest is what makes the commit safe rather than racy: content is
 *   validated at digest D and the store commits only if the plan is still at D, so a concurrent
 *   edit invalidates the transition instead of slipping past an already-passed check.
 *
 * Every refusal is a `PlanIssue` with a stable `code`, a model-addressed `message` naming the fix,
 * the `nodeId`/`edgeId` where applicable, and a `severity`. Blocking issues refuse the freeze;
 * advisory issues are surfaced for the author but do not stop the transition.
 *
 * The checks are grouped into three families, each documented at its call site:
 * topology (entry, reachability, acyclicity, the diamond-join rule, id and handle rules),
 * references and dataflow (dangling refs, undeclared fields, join-crossing selections, ambiguous
 * references, taint), and per-node shape (call, transform, branch/select, encodability, scaffold
 * placeholders, unreachable calls).
 */

import { foldOps } from './ops'
import { NodeRef } from './encoding'
import { passesSchema } from '../../lib/utils/validation'
import { effectiveToolMethods } from './artifact_methods'
import { isError, isInstanceOf, isObject } from '../../lib/utils/guards'
import {
  entryNodes,
  findCycle,
  handleAppliesTo,
  immediateDominator,
  incoming,
  isValidEdgeId,
  isValidNodeId,
  nodeById,
  outgoing,
  reachableFrom,
  routesBetween,
} from './plan'
import type { PlanStore } from './store'
import type {
  FreezeInputs,
  NodeId,
  NodeRef as NodeRefType,
  PlanEdge,
  PlanIssue,
  PlanNode,
  RawPlanView,
} from './types'

// ── constants ────────────────────────────────────────────────────────────────
/**
 * The exact string an authoring tool leaves in a field it scaffolded but the model never filled
 * in. The check is deliberately an exact match: cheap, and effective against a model that filled
 * in structure but not intent. A value equal to this string is refused as an unedited scaffold
 * placeholder.
 */
const SCAFFOLD_PLACEHOLDER = 'lorem ipsum'

/**
 * Constructor names the encoder round-trips losslessly, and which are therefore inside the
 * `EncodableValue` subset. Anything else that is not a plain object or array is an unregistered
 * custom class and is refused at freeze. `NodeRef`/`ParamRef` are included because they are the
 * IR's own reference classes; luxon values are included because the encoder serialises them.
 */
const KNOWN_ENCODABLE_NAMES: ReadonlySet<string> = new Set([
  'Date',
  'RegExp',
  'Map',
  'Set',
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'DateTime',
  'Duration',
  'Interval',
  'NodeRef',
  'ParamRef',
])

// ── small structural helpers ─────────────────────────────────────────────────
/**
 * True for a PLAIN object — one whose prototype is `Object.prototype` or `null`. Every
 * encoder-owned value (`Date`, `RegExp`, `Map`, `Set`, typed arrays, `ArrayBuffer`, `DataView`,
 * bigint, luxon values, `NodeRef`/`ParamRef` instances) has a non-plain prototype, so this is
 * exactly the set whose keys we are allowed to walk as a record.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Read a field off a definition defensively. A folded definition is well-typed but may still be
 * invalid at runtime (a required field unset), so every required-field check reads through this
 * rather than trusting the type.
 */
const readField = (def: unknown, key: string): unknown =>
  isObject(def) ? (def as Record<string, unknown>)[key] : undefined

/**
 * True when `value` is an instance of a class the encoder round-trips losslessly. Used to tell a
 * legitimate encodable value (a `Date`, a `Map`, a `NodeRef`) apart from an unregistered custom
 * class, which the encoder cannot hydrate.
 */
const isKnownEncodable = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object') return false
  const name = (v as { constructor?: { name?: string } }).constructor?.name
  return name !== undefined && KNOWN_ENCODABLE_NAMES.has(name)
}

/**
 * Collect every `NodeRef` reachable inside a value, depth-first. `NodeRef` is a class, so
 * `NodeRef.isNodeRef` is an `instanceof`-backed guard no look-alike record can satisfy.
 *
 * A seen-set of visited object references guards against a cyclic staged value looping this walk
 * forever (a self-referencing record, array, `Map`, or `Set`). The set is persistent rather than
 * path-scoped: revisiting an already-visited value cannot surface a `NodeRef` that the first visit
 * missed, so we only need to stop re-descending, not to distinguish sibling re-references.
 */
const collectRefs = (value: unknown, out: NodeRefType[], seen: Set<object>): void => {
  if (NodeRef.isNodeRef(value)) {
    out.push(value)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out, seen)
    return
  }
  if (isInstanceOf(value, 'Map', Map)) {
    for (const [k, v] of value) {
      collectRefs(k, out, seen)
      collectRefs(v, out, seen)
    }
    return
  }
  if (isInstanceOf(value, 'Set', Set)) {
    for (const v of value) collectRefs(v, out, seen)
    return
  }
  for (const key of Object.keys(value)) {
    collectRefs((value as Record<string, unknown>)[key], out, seen)
  }
}

/**
 * The data references a node consumes to produce its output. `call` reads its `args`, `reason`
 * reads its `prompt`, `transform` reads its `source`. `branch`/`select` route rather than produce
 * data, so they contribute nothing here.
 */
const dataRefs = (node: PlanNode): NodeRefType[] => {
  const out: NodeRefType[] = []
  if (node.kind === 'call') collectRefs(node.definition.args, out, new Set<object>())
  else if (node.kind === 'reason') collectRefs(node.definition.prompt, out, new Set<object>())
  else if (node.kind === 'transform') collectRefs(node.definition.source, out, new Set<object>())
  return out
}

/**
 * The declared output field paths of a node, for reference-field validation. `reason` nodes carry
 * an encoded `Schema` rather than `DeclaredField[]`, so their fields are not statically
 * enumerable here and the check is skipped for them. A `join`'s output is provenance
 * (`via`/`from`/`branch`), which is a graph constant.
 */
const declaredFieldPaths = (node: PlanNode): string[] => {
  if (node.kind === 'entry') return node.definition.input.map((f) => f.path)
  if (node.kind === 'call') return node.definition.output.map((f) => f.path)
  if (node.kind === 'transform') return node.definition.output.map((f) => f.path)
  if (node.kind === 'join') return ['via', 'from', 'branch']
  return []
}

/**
 * True when a reference path is a prefix of (or equal to) a declared field path. A reference may
 * read a sub-path of a declared field (`result.items` from a declared `result`), so the check is
 * prefix-based in both directions.
 */
const pathIsDeclared = (paths: readonly string[], path: string): boolean =>
  paths.some((p) => p === path || p.startsWith(path + '.') || path.startsWith(p + '.'))

/**
 * An independent reachability derivation, written from scratch rather than delegating to
 * `reachableFrom`. Used by the unreachable-`call` check, which is deliberately implemented twice
 * in independent derivations — see that check for why this is not dead code.
 */
const manualReachable = (view: RawPlanView, startId: NodeId): Set<NodeId> => {
  const byFrom = new Map<NodeId, PlanEdge[]>()
  for (const e of view.edges) {
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

// ── taint ────────────────────────────────────────────────────────────────────
/**
 * A tainted node, and which of its output fields carry the taint.
 *
 * @remarks
 * `fields: 'all'` is the ordinary case — a node with no declassification taints everything it
 * produces. A node that declares `declassifies` taints only the fields NOT named there, which is
 * why this cannot collapse to a set of node ids.
 */
interface TaintedNode {
  fields: 'all' | ReadonlySet<string>
}

/**
 * Compute which node outputs are tainted, by fixpoint, at FIELD granularity.
 *
 * @remarks
 * External input at the `entry` node is tainted and propagates transitively through data
 * references. A node is tainted when any of its data references reaches a tainted OUTPUT FIELD.
 *
 * **Declassification is per FIELD, not per node**, which is the whole reason this returns a map
 * rather than a set of ids. The contract is that "an output field named in `declassifies` is
 * untainted regardless of its inputs; EVERY OTHER FIELD keeps the taint of the node's inputs" —
 * so a node declaring `declassifies: ['safe']` while also emitting `unsafe` launders exactly one
 * of them. A node-granular set cannot express that: declaring one safe field would clear the
 * node, and a downstream `call` reading the untouched sibling would be accepted. That was a real
 * gap, and it is the security-relevant direction, since `declassifies` is an author's ASSERTION
 * that a tool sanitised something — an assertion that must bind only to what it actually names.
 *
 * A `reason` node cannot declassify at all: a model is precisely not a sanitiser. `branch`/`select`
 * route rather than produce data, so they neither propagate nor clear taint.
 *
 * @param view - The folded plan.
 * @param entryId - The entry node, the origin of all external taint.
 * @returns A map from node id to which of its output fields are tainted.
 */
const computeTainted = (view: RawPlanView, entryId: NodeId): Map<NodeId, TaintedNode> => {
  const tainted = new Map<NodeId, TaintedNode>([[entryId, { fields: 'all' }]])

  /** Does this reference read a field that is currently tainted? */
  const readsTainted = (ref: NodeRefType): boolean => {
    const source = tainted.get(ref.node)
    if (!source) return false
    if (source.fields === 'all') return true
    // A reference with no path reads the whole item, so ANY tainted field taints it.
    if (ref.path === undefined) return source.fields.size > 0
    // Otherwise only the named field matters — matched at its root segment, since a dot-path
    // reaches INTO a declared field and inherits that field's status.
    const root = ref.path.split('.')[0] ?? ref.path
    return source.fields.has(root)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const node of view.nodes) {
      const existing = tainted.get(node.id)
      if (existing?.fields === 'all') continue
      if (!dataRefs(node).some(readsTainted)) continue

      const declassifies =
        node.kind === 'call' && Array.isArray(node.definition.declassifies)
          ? node.definition.declassifies
          : []

      let next: TaintedNode
      if (declassifies.length === 0) {
        next = { fields: 'all' }
      } else {
        // Only the fields this node did NOT claim to sanitise stay tainted. A declared output
        // list is what makes that enumerable; with none declared there is nothing left to taint.
        const declared = node.kind === 'call' ? node.definition.output.map((f) => f.path) : []
        const remaining = new Set(declared.filter((path) => !declassifies.includes(path)))
        next = { fields: remaining }
      }

      // Monotone widening only, so the fixpoint terminates: a node's taint may grow from absent
      // to some fields to all, never shrink.
      const sizeOf = (t: TaintedNode): number =>
        typeof t.fields === 'string' ? Number.POSITIVE_INFINITY : t.fields.size
      if (existing === undefined || sizeOf(next) > sizeOf(existing)) {
        tainted.set(node.id, next)
        changed = true
      }
    }
  }
  return tainted
}

// ── encodability ─────────────────────────────────────────────────────────────
/**
 * Walk a staged value and refuse anything outside the `EncodableValue` subset, plus any cycle
 * inside it. Type membership does not imply encodability: a `Function`, an `Error`, or an
 * unregistered custom class is inside no subset the encoder can hydrate, and a record/array/`Map`/
 * `Set` can be cyclic even though it is well-typed. The walk uses a path-scoped seen-set, so a
 * value referenced twice in sibling branches is fine while a value that reaches itself is refused.
 */
const checkEncodable = (
  value: unknown,
  seen: Set<unknown>,
  nodeId: NodeId,
  issues: PlanIssue[]
): void => {
  if (typeof value === 'function') {
    issues.push({
      code: 'unencodable_value',
      message: `Node "${nodeId}" stages a Function, which the encoder serialises by source text and cannot hydrate; replace it with a plain encodable value.`,
      nodeId,
      severity: 'blocking',
    })
    return
  }
  if (isError(value)) {
    issues.push({
      code: 'unencodable_value',
      message: `Node "${nodeId}" stages an Error, which is outside the encodable value subset; replace it with a plain encodable value.`,
      nodeId,
      severity: 'blocking',
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) {
    issues.push({
      code: 'cyclic_value',
      message: `Node "${nodeId}" stages a cyclic value, which cannot be encoded; break the cycle.`,
      nodeId,
      severity: 'blocking',
    })
    return
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (const v of value) checkEncodable(v, seen, nodeId, issues)
  } else if (isInstanceOf(value, 'Map', Map)) {
    for (const [k, v] of value) {
      checkEncodable(k, seen, nodeId, issues)
      checkEncodable(v, seen, nodeId, issues)
    }
  } else if (isInstanceOf(value, 'Set', Set)) {
    for (const v of value) checkEncodable(v, seen, nodeId, issues)
  } else if (isKnownEncodable(value)) {
    // Date, RegExp, typed array, ArrayBuffer, DataView, luxon, NodeRef, ParamRef — fine.
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) checkEncodable(value[key], seen, nodeId, issues)
  } else {
    issues.push({
      code: 'unencodable_value',
      message: `Node "${nodeId}" stages an unregistered custom class, which the encoder cannot hydrate; replace it with a plain encodable value.`,
      nodeId,
      severity: 'blocking',
    })
  }
  seen.delete(value)
}

// ── scaffold placeholder ─────────────────────────────────────────────────────
/**
 * Walk a staged value and refuse any string equal to the scaffold placeholder. A seen-set guards
 * against a cyclic value looping this walk (the cycle itself is reported by the encodability
 * check).
 */
const checkScaffold = (
  value: unknown,
  seen: Set<unknown>,
  nodeId: NodeId,
  issues: PlanIssue[]
): void => {
  if (typeof value === 'string') {
    if (value === SCAFFOLD_PLACEHOLDER) {
      issues.push({
        code: 'scaffold_placeholder',
        message: `Node "${nodeId}" still carries the unedited scaffold placeholder "${SCAFFOLD_PLACEHOLDER}"; replace it with the intended content.`,
        nodeId,
        severity: 'blocking',
      })
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const v of value) checkScaffold(v, seen, nodeId, issues)
  } else if (isInstanceOf(value, 'Map', Map)) {
    for (const [k, v] of value) {
      checkScaffold(k, seen, nodeId, issues)
      checkScaffold(v, seen, nodeId, issues)
    }
  } else if (isInstanceOf(value, 'Set', Set)) {
    for (const v of value) checkScaffold(v, seen, nodeId, issues)
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) checkScaffold(value[key], seen, nodeId, issues)
  }
}

// ── collectIssues ───────────────────────────────────────────────────────────
/**
 * Run every submit check over a folded plan view.
 *
 * The checks are grouped into three families:
 *
 * **Topology** — exactly one `entry` with no incoming edges; every other node reachable from it;
 * acyclicity over every handle (a diamond fan-in is not a cycle); every `join` a diamond (its fork
 * is its immediate dominator, more than one fork→join route, no reconvergence, no nested join);
 * edge ids valid and unique; node ids valid; handle applicability per source kind; a `select`
 * must carry a `default` edge.
 *
 * **References and dataflow** — a `NodeRef` naming a missing node or an undeclared field; a
 * `first`/`last` selection resolved across a `join`; an omitted `branchId` where more than one path
 * reaches the referenced node; taint (a tainted reference may reach a `reason` prompt but not a
 * `call` node's args, with declassification only via a `call` node's `declassifies`); staged
 * values outside the encodable subset and cyclic values inside it.
 *
 * **Per-node shape** — a `call` naming a tool outside the allowlist, with `replaySafe`/
 * `onIndeterminate` unset, or the retry-unsafe-repeat contradiction; a `branch`/`select` with no
 * wired evaluator cell (and `load()`/`validate()` on every wired cell); a `transform` naming a
 * step absent from the source class's effective method set, with args failing the descriptor's
 * schema, or whose source tool's return class is undeclared; a `Media`/`Uint8Array`-returning tool
 * feeding a field-declaring node; an unedited scaffold placeholder; an unreachable `call` node.
 *
 * This function never throws on a well-typed-but-invalid plan. A malformed definition surfaces as
 * an issue rather than a crash, and every evaluator interaction is wrapped so a failing cell
 * reports an issue instead of propagating.
 *
 * @param view - The folded plan content to validate.
 * @param inputs - The injected tier-C allowlist and wired predicate cells.
 * @returns Every issue the graph raises, blocking and advisory.
 */
export async function collectIssues(view: RawPlanView, inputs: FreezeInputs): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = []

  // ── topology: entry ───────────────────────────────────────────────────────
  const entries = entryNodes(view)
  if (entries.length === 0) {
    issues.push({
      code: 'no_entry',
      message: 'The plan has no entry node, so nothing can start; add exactly one entry node.',
      severity: 'blocking',
    })
  }
  if (entries.length > 1) {
    issues.push({
      code: 'multiple_entries',
      message:
        `The plan has ${entries.length} entry nodes, so the executor cannot tell which to ` +
        `materialise; keep exactly one entry node.`,
      severity: 'blocking',
    })
  }
  for (const e of entries) {
    if (incoming(view, e.id).length > 0) {
      issues.push({
        code: 'entry_has_incoming',
        message: `Entry node "${e.id}" has incoming edges; the entry must have no incoming edges.`,
        nodeId: e.id,
        severity: 'blocking',
      })
    }
  }
  const entryId = entries.length === 1 ? entries[0].id : undefined

  // ── topology: acyclicity (over every handle) ─────────────────────────────
  const cycle = findCycle(view)
  if (cycle) {
    issues.push({
      code: 'cycle',
      message:
        `The graph contains a cycle closed by edge "${cycle.edgeId}" (${cycle.from} → ${cycle.to}); ` +
        `remove the cycle — an error or default edge back to an ancestor is still a cycle.`,
      edgeId: cycle.edgeId,
      severity: 'blocking',
    })
  }

  // ── topology: node ids ───────────────────────────────────────────────────
  for (const node of view.nodes) {
    if (!isValidNodeId(node.id)) {
      issues.push({
        code: 'invalid_node_id',
        message:
          `Node id "${node.id}" is not a valid snake_case id (lowercase letters, digits, ` +
          `underscores, no "/" and no leading "."); rename it so it cannot be mistaken for a path.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
  }

  // ── topology: edge ids valid and unique ─────────────────────────────────
  const seenEdgeIds = new Map<string, PlanEdge>()
  for (const edge of view.edges) {
    if (!isValidEdgeId(edge.id)) {
      issues.push({
        code: 'invalid_edge_id',
        message:
          `Edge id "${edge.id}" does not match /^[A-Za-z0-9_-]{1,64}$/; rename it so the route ` +
          `renderer cannot be forged.`,
        edgeId: edge.id,
        severity: 'blocking',
      })
    }
    if (seenEdgeIds.has(edge.id)) {
      issues.push({
        code: 'duplicate_edge_id',
        message:
          `Edge id "${edge.id}" is used by more than one edge; rename one of them — edge ids are ` +
          `identifiers and must be unique.`,
        edgeId: edge.id,
        severity: 'blocking',
      })
    } else {
      seenEdgeIds.set(edge.id, edge)
    }
  }

  // ── topology: handle applicability ───────────────────────────────────────
  for (const edge of view.edges) {
    const src = nodeById(view, edge.from)
    if (src && !handleAppliesTo(src.kind, edge.handle)) {
      issues.push({
        code: 'invalid_handle',
        message:
          `Edge "${edge.id}" uses handle "${edge.handle}" from a ${src.kind} node, which does not ` +
          `allow that handle; use a handle the source kind permits.`,
        edgeId: edge.id,
        severity: 'blocking',
      })
    }
  }

  // ── topology: select must have a default edge ────────────────────────────
  for (const node of view.nodes) {
    if (node.kind === 'select') {
      const hasDefault = outgoing(view, node.id).some((e) => e.handle === 'default')
      if (!hasDefault) {
        issues.push({
          code: 'select_missing_default',
          message:
            `Select node "${node.id}" has no "default" edge; a select must carry a default so an ` +
            `unmatched case has somewhere to go.`,
          nodeId: node.id,
          severity: 'blocking',
        })
      }
    }
  }

  // ── topology: reachability and the diamond-join rule (need a single entry) ─
  if (entryId !== undefined) {
    const reachable = reachableFrom(view, entryId)
    for (const node of view.nodes) {
      if (node.id !== entryId && !reachable.has(node.id)) {
        issues.push({
          code: 'unreachable_node',
          message: `Node "${node.id}" is not reachable from the entry node; connect it or remove it.`,
          nodeId: node.id,
          severity: 'blocking',
        })
      }
    }

    const joins = view.nodes.filter((n) => n.kind === 'join')
    for (const join of joins) {
      const fork = immediateDominator(view, entryId, join.id)
      if (fork === undefined) {
        issues.push({
          code: 'join_no_fork',
          message:
            `Join "${join.id}" has no immediate dominator from the entry; a join must close a ` +
            `fan-out that a single ancestor opened.`,
          nodeId: join.id,
          severity: 'blocking',
        })
        continue
      }
      const routes = routesBetween(view, fork, join.id)
      if (routes.length <= 1) {
        issues.push({
          code: 'join_not_diamond',
          message:
            `Join "${join.id}" has only ${routes.length} route(s) from its fork "${fork}"; a join ` +
            `must close more than one distinct fork→join route, so this join should not exist.`,
          nodeId: join.id,
          severity: 'blocking',
        })
        continue
      }
      // The fork→join region: every node on a fork→join route, excluding the fork and the join.
      const region = new Set<NodeId>()
      for (const route of routes) {
        for (let i = 1; i < route.length - 1; i++) region.add(route[i])
      }
      for (const rid of region) {
        const rnode = nodeById(view, rid)
        if (rnode && rnode.kind === 'join') {
          issues.push({
            code: 'nested_join',
            message:
              `Join "${join.id}" contains a nested join "${rid}" inside its fork→join region; a ` +
              `diamond must not contain another barrier.`,
            nodeId: join.id,
            severity: 'blocking',
          })
          break
        }
        if (incoming(view, rid).length > 1) {
          issues.push({
            code: 'join_reconvergence',
            message:
              `Join "${join.id}" has reconverged inside its diamond at "${rid}" (in-degree > 1); ` +
              `the fork→join region must contain no node with in-degree > 1 other than the join.`,
            nodeId: join.id,
            severity: 'blocking',
          })
          break
        }
      }
    }
  }

  // ── references and dataflow ──────────────────────────────────────────────
  const joins = view.nodes.filter((n) => n.kind === 'join')
  const allRefs: { ref: NodeRefType; nodeId: NodeId }[] = []
  for (const node of view.nodes) {
    const refs: NodeRefType[] = []
    collectRefs(node.definition, refs, new Set<object>())
    for (const ref of refs) allRefs.push({ ref, nodeId: node.id })
  }

  for (const { ref, nodeId } of allRefs) {
    const target = nodeById(view, ref.node)
    if (!target) {
      issues.push({
        code: 'missing_reference',
        message: `Node "${nodeId}" references node "${ref.node}", which does not exist; fix the reference.`,
        nodeId,
        severity: 'blocking',
      })
      continue
    }
    const paths = declaredFieldPaths(target)
    if (ref.path !== undefined && paths.length > 0 && !pathIsDeclared(paths, ref.path)) {
      issues.push({
        code: 'undeclared_field',
        message:
          `Node "${nodeId}" references path "${ref.path}" on node "${ref.node}", which does not ` +
          `declare that field; reference a declared field.`,
        nodeId,
        severity: 'blocking',
      })
    }
    if (ref.select === 'first' || ref.select === 'last') {
      const acrossJoin = joins.some((j) => reachableFrom(view, j.id).has(ref.node))
      if (acrossJoin) {
        issues.push({
          code: 'first_last_across_join',
          message:
            `Node "${nodeId}" selects "${ref.select}" from node "${ref.node}", which is reached ` +
            `across a join; we ship no automatic pairing, so a first/last selection across a join ` +
            `is refused.`,
          nodeId,
          severity: 'blocking',
        })
      }
    }
    if (ref.branchId === undefined && entryId !== undefined) {
      const routes = routesBetween(view, entryId, ref.node)
      if (routes.length > 1) {
        issues.push({
          code: 'ambiguous_reference',
          message:
            `Node "${nodeId}" references node "${ref.node}" without a branchId, but more than one ` +
            `path reaches it; name which execution to read.`,
          nodeId,
          severity: 'blocking',
        })
      }
    }
  }

  // ── taint ────────────────────────────────────────────────────────────────
  if (entryId !== undefined) {
    const tainted = computeTainted(view, entryId)
    for (const node of view.nodes) {
      if (node.kind !== 'call') continue
      const declassifies =
        Array.isArray(node.definition.declassifies) && node.definition.declassifies.length > 0
      if (declassifies) continue // the sanctioned declassification point
      const refs: NodeRefType[] = []
      collectRefs(node.definition.args, refs, new Set<object>())
      for (const ref of refs) {
        const source = tainted.get(ref.node)
        if (source === undefined) continue
        const root = ref.path === undefined ? undefined : (ref.path.split('.')[0] ?? ref.path)
        const readsTaintedField =
          source.fields === 'all'
            ? true
            : root === undefined
              ? source.fields.size > 0
              : source.fields.has(root)
        if (readsTaintedField) {
          issues.push({
            code: 'tainted_call_arg',
            message:
              `Call node "${node.id}" passes tainted data from node "${ref.node}" into its args; ` +
              `a tainted reference may reach a reason prompt but not a call node's args. ` +
              `Declassify via this call node's "declassifies" field, or route the value through a ` +
              `sanitising step first.`,
            nodeId: node.id,
            severity: 'blocking',
          })
        }
      }
    }
  }

  // ── per-node shape: call ─────────────────────────────────────────────────
  for (const node of view.nodes) {
    if (node.kind !== 'call') continue
    const def = node.definition
    if (!inputs.invocable.has(def.tool)) {
      const available = inputs.invocable.names()
      issues.push({
        code: 'unknown_tool',
        message:
          `Call node "${node.id}" names tool "${def.tool}", which is not on the allowlist; use one ` +
          `of the available tools: ${available.join(', ')}.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
    if (readField(def, 'replaySafe') === undefined) {
      issues.push({
        code: 'missing_replay_safe',
        message: `Call node "${node.id}" does not set "replaySafe"; it is required and has no default.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
    if (readField(def, 'onIndeterminate') === undefined) {
      issues.push({
        code: 'missing_on_indeterminate',
        message: `Call node "${node.id}" does not set "onIndeterminate"; it is required and has no default.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
    if (def.onIndeterminate === 'retry' && def.replaySafe === false) {
      issues.push({
        code: 'retry_unsafe_repeat',
        message:
          `Call node "${node.id}" sets onIndeterminate "retry" with replaySafe false — a ` +
          `contradiction: it is asserted unsafe to repeat and to be repeated.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
    const ret = inputs.invocable.returns(def.tool)
    if (ret && (ret.kind === 'media' || ret.kind === 'bytes') && def.output.length > 0) {
      issues.push({
        code: 'media_feeds_fields',
        message:
          `Call node "${node.id}" returns ${ret.kind} but declares output fields; bytes and media ` +
          `are not pathable, so a field-declaring node cannot consume them.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
  }

  // ── per-node shape: transform ────────────────────────────────────────────
  for (const node of view.nodes) {
    if (node.kind !== 'transform') continue
    const source = node.definition.source
    const sourceNode = nodeById(view, source.node)
    if (!sourceNode) continue // missing reference reported above
    if (sourceNode.kind !== 'call') {
      issues.push({
        code: 'transform_source_not_call',
        message:
          `Transform "${node.id}" reads its source from node "${source.node}", which is not a ` +
          `call node; a transform must read a call node's artifact output.`,
        nodeId: node.id,
        severity: 'blocking',
      })
      continue
    }
    const tool = sourceNode.definition.tool
    const ret = inputs.invocable.returns(tool)
    if (ret === undefined) {
      issues.push({
        code: 'transform_undeclared_tool',
        message:
          `Transform "${node.id}" reads from tool "${tool}", whose return class is not declared; ` +
          `declare what the tool returns so the legal step set is known — the battery never guesses ` +
          `a class.`,
        nodeId: node.id,
        severity: 'blocking',
      })
      continue
    }
    if (ret.kind !== 'artifact') {
      issues.push({
        code: 'transform_source_not_artifact',
        message:
          `Transform "${node.id}" reads from tool "${tool}", which does not return an artifact; a ` +
          `transform needs an artifact class to name its steps.`,
        nodeId: node.id,
        severity: 'blocking',
      })
      continue
    }
    const methods = effectiveToolMethods(ret.artifactClass)
    for (const step of node.definition.steps) {
      const desc = methods.find((m) => m.name === step.name)
      if (!desc) {
        const legal = methods.map((m) => m.name)
        issues.push({
          code: 'transform_unknown_step',
          message:
            `Transform "${node.id}" names step "${step.name}", which is not a method of the source ` +
            `artifact class; use one of: ${legal.join(', ')}.`,
          nodeId: node.id,
          severity: 'blocking',
        })
        continue
      }
      if (desc.argsSchema && step.args !== undefined && !passesSchema(desc.argsSchema, step.args)) {
        issues.push({
          code: 'transform_step_args',
          message:
            `Transform "${node.id}" step "${step.name}" has args that fail that method's schema; ` +
            `fix the args.`,
          nodeId: node.id,
          severity: 'blocking',
        })
      }
    }
  }

  // ── per-node shape: branch/select evaluator wiring ───────────────────────
  for (const node of view.nodes) {
    if (node.kind !== 'branch' && node.kind !== 'select') continue
    const evaluatorId = node.definition.evaluator
    const cell = inputs.evaluators.find((e) => e.id === evaluatorId)
    if (!cell) {
      issues.push({
        code: 'unwired_evaluator',
        message:
          `${node.kind === 'branch' ? 'Branch' : 'Select'} node "${node.id}" names evaluator ` +
          `"${evaluatorId}", which is not wired; supply a cell with that id.`,
        nodeId: node.id,
        severity: 'blocking',
      })
      continue
    }
    try {
      await cell.load()
      await cell.validate(node)
    } catch (err) {
      issues.push({
        code: 'evaluator_error',
        message:
          `Evaluator "${evaluatorId}" failed to load or validate ${node.kind} node "${node.id}": ` +
          `${isError(err) ? err.message : String(err)}.`,
        nodeId: node.id,
        severity: 'blocking',
      })
    }
  }

  // ── per-node shape: encodability, scaffold, unreachable call ─────────────
  for (const node of view.nodes) {
    checkEncodable(node.definition, new Set<unknown>(), node.id, issues)
    checkScaffold(node.definition, new Set<unknown>(), node.id, issues)
  }

  // The unreachable-`call` check is implemented TWICE, in independent derivations, and that is
  // not dead code: the bug this family guards — a `call` node that can never run because nothing
  // reaches it — shipped twice in the prior art, each time because a single reachability walk was
  // subtly wrong (one missed edges over a particular handle, the other mishandled the entry). Two
  // independent walks cannot share the same blind spot, so a `call` is reported unreachable only
  // when BOTH derivations agree it is. The first derivation delegates to the plan module's
  // `reachableFrom`; the second is `manualReachable`, written from scratch above.
  if (entryId !== undefined) {
    const reachableA = reachableFrom(view, entryId)
    const reachableB = manualReachable(view, entryId)
    for (const node of view.nodes) {
      if (node.kind !== 'call') continue
      if (!reachableA.has(node.id) || !reachableB.has(node.id)) {
        issues.push({
          code: 'unreachable_call',
          message:
            `Call node "${node.id}" is unreachable from the entry node, so it can never run; ` +
            `connect it or remove it.`,
          nodeId: node.id,
          severity: 'blocking',
        })
      }
    }
  }

  return issues
}

// ── freezePlan ───────────────────────────────────────────────────────────────
/**
 * Freeze a plan: fold the log, validate, and commit the `editable → reviewable` transition.
 *
 * The op log is folded into a `RawPlanView`, the fold's own issues are carried over (minus the
 * fold's advisory `duplicate_edge_id`, which {@link collectIssues} reports as a blocking check),
 * and {@link collectIssues} runs over the folded graph. Only when no issue is `blocking` is the
 * store's `transition` called, passing the folded digest as `expectedDigest`.
 *
 * The digest is what makes the commit safe rather than racy: content is validated at digest D and
 * the store commits only if the plan is still at D, so a concurrent edit invalidates the
 * transition instead of slipping past an already-passed check. If the transition is rejected
 * (the digest moved or the state is not `editable`), a `transition_rejected` blocking issue is
 * appended and the freeze reports failure.
 *
 * @param store - The plan store holding the plan.
 * @param planId - Identity of the plan to freeze.
 * @param inputs - The fully-resolved tier-C allowlist and wired predicate cells.
 * @returns Whether the freeze succeeded, and every issue the plan raised.
 */
export async function freezePlan(
  store: PlanStore,
  planId: string,
  inputs: FreezeInputs
): Promise<{ ok: boolean; issues: PlanIssue[] }> {
  const ops = await store.readOps(planId)
  const provenance = await store.readProvenance(planId)
  const { view, issues: foldIssues } = foldOps(planId, ops, provenance)

  const collected = await collectIssues(view, inputs)
  // The fold reports a same-id edge collision as advisory; collectIssues owns it as a blocking
  // check, so drop the advisory duplicate to avoid double-reporting the same defect.
  const fold = foldIssues.filter((i) => i.code !== 'duplicate_edge_id')
  const issues = [...fold, ...collected]

  if (issues.some((i) => i.severity === 'blocking')) {
    return { ok: false, issues }
  }

  const result = await store.transition(planId, {
    from: 'editable',
    to: 'reviewable',
    expectedDigest: view.digest,
  })
  if (result.ok) return { ok: true, issues }

  return {
    ok: false,
    issues: [
      ...issues,
      {
        code: 'transition_rejected',
        message: `The plan changed while it was being validated (${result.reason}); re-run freeze.`,
        severity: 'blocking',
      },
    ],
  }
}
