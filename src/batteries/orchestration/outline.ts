/**
 * @module @nhtio/adk/batteries/orchestration/outline
 *
 * Progressive-disclosure reading for plans that are too large for a model's context window.
 * `planOutline` produces a single flat, self-describing index of a plan; `planRead` fetches a
 * small, self-locating slice of that plan by the exact identifiers the outline printed.
 *
 * @remarks
 * A model's context window is smaller than a plan will get, so it must be able to work on a plan
 * it cannot hold. This module is that mechanism, and its shape is load-bearing:
 *
 * - **ONE FLAT LEVEL. Never two.** `planOutline` returns a single flat list of phases — no
 *   sub-phases, no index that needs an index. This is not a style preference: a controlled study
 *   of this pattern found one routing level helps and a second "never helps and sometimes breaks
 *   accuracy outright" (0.9126 → 0.6398 on one cell), because in a two-level pack every child
 *   description sits in context before the router commits, recreating the very pressure
 *   progressive disclosure exists to relieve.
 * - **Entries carry EXACT SURFACE FORMS, not paraphrase.** Per the same study, per-chunk metadata
 *   must be a short summary PLUS a list of key elements, because the element list supplies "exact
 *   surface forms that a one-sentence summary would paraphrase away". For a plan that is decisive:
 *   a model writing `NodeRef{node:'archive_files'}` needs the EXACT node id, and a prose summary
 *   of a phase destroys it. So each `PhaseEntry` carries, verbatim: the phase name, the node ids,
 *   the tool name of each `call` node in that phase, an open-issue count, and a one-line summary.
 * - **`unphased` is addressed identically.** Nodes with no `phase` are not second-class — they get
 *   their own `PhaseEntry` so a model reaches them the same way.
 * - **The outline's key IS the reader's key.** `planRead` takes the SAME identifiers the outline
 *   printed — a phase name or a node id. No line numbers anywhere.
 * - **Each slice is SELF-LOCATING.** A returned slice carries its phase and the immediate
 *   predecessors/successors of the slice as a whole (`boundary`), so a model can keep linking new
 *   nodes without re-fetching the outline.
 * - **Scoped reading is available, not mandatory.** The study's own conclusion is that progressive
 *   disclosure "buys context, not intelligence" — decisive once an artifact is too large to read,
 *   redundant when an agent can navigate it directly. So a five-node plan should be read whole;
 *   the outline hop is not compulsory.
 */

import { foldOps } from './ops'
import { PlanStore } from './store'
import { isObject } from '../../lib/utils/guards'
import { incoming, outgoing, nodeById } from './plan'
import type {
  NodeId,
  PhaseEntry,
  PlanIssue,
  PlanNode,
  PlanOutline,
  PlanSlice,
  RawPlanView,
} from './types'

/**
 * Build a flat outline of a plan: one entry per phase, plus a single entry for unphased nodes.
 *
 * @remarks
 * Each `PhaseEntry` carries the exact surface forms a reader needs to fetch a slice — the phase
 * name, the node ids, the tool names of every `call` node, an open-issue count, and a one-line
 * summary. The outline is deliberately a single flat list with no second routing level; see the
 * module doc for why.
 *
 * @param store - the plan store to read from.
 * @param planId - the id of the plan to outline.
 * @returns the flat outline of the plan.
 */
export async function planOutline(store: PlanStore, planId: string): Promise<PlanOutline> {
  const state = await store.readState(planId)
  const ops = await store.readOps(planId)
  const { view, issues } = foldOps(planId, ops)

  const byPhase = new Map<string, PlanNode[]>()
  const unphased: PlanNode[] = []

  for (const node of view.nodes) {
    const phase = node.phase ?? ''
    if (phase === '') {
      unphased.push(node)
    } else {
      const bucket = byPhase.get(phase)
      if (bucket === undefined) byPhase.set(phase, [node])
      else bucket.push(node)
    }
  }

  const phases: PhaseEntry[] = []
  for (const [phase, phaseNodes] of byPhase) {
    phases.push(entryFor(phase, phaseNodes, issues))
  }

  return {
    planId,
    state: state.state,
    digest: state.digest,
    nodeCount: view.nodes.length,
    phases,
    unphased: unphased.length > 0 ? entryFor('', unphased, issues) : undefined,
  }
}

/**
 * Read a self-locating slice of a plan by the exact identifier the outline printed.
 *
 * @remarks
 * The selection is either a phase name (`{ phase }`) or a node id (`{ node }`) — the SAME
 * identifiers the outline printed, never line numbers. The returned slice carries its phase and
 * the immediate predecessors/successors of the slice as a whole (`boundary`), so a model can keep
 * linking new nodes without re-fetching the outline.
 *
 * Scoped reading is available, not mandatory: a small plan should be read whole, and the outline
 * hop is not compulsory.
 *
 * @param store - the plan store to read from.
 * @param planId - the id of the plan to read.
 * @param sel - the selection: `{ phase }` to read a whole phase, or `{ node }` to read the slice
 *   around a single node.
 * @returns the self-locating slice of the plan.
 * @throws if the phase or node id is unknown, naming the valid set — never an empty slice.
 */
export async function planRead(
  store: PlanStore,
  planId: string,
  sel: { phase: string } | { node: NodeId }
): Promise<PlanSlice> {
  if (!isObject(sel)) {
    throw new Error('planRead: selection must be an object')
  }

  const ops = await store.readOps(planId)
  const { view, issues } = foldOps(planId, ops)

  const allIds = view.nodes.map((n) => n.id)

  let selected: PlanNode[]
  let phase: string | undefined

  if ('phase' in sel) {
    const wanted = sel.phase
    selected = view.nodes.filter((n) => (n.phase ?? '') === wanted)
    if (selected.length === 0) {
      throw new Error(
        `planRead: unknown phase ${JSON.stringify(wanted)}; valid phases are ${JSON.stringify([
          ...new Set(view.nodes.map((n) => n.phase ?? '')),
        ])}`
      )
    }
    phase = wanted === '' ? undefined : wanted
  } else {
    const wanted = sel.node
    const node = nodeById(view, wanted)
    if (node === undefined) {
      throw new Error(
        `planRead: unknown node ${JSON.stringify(wanted)}; valid node ids are ${JSON.stringify(
          allIds
        )}`
      )
    }
    selected = [node]
    phase = node.phase
  }

  const selectedIds = new Set(selected.map((n) => n.id))
  const boundary =
    selected.length === 1
      ? {
          incoming: incoming(view, selected[0].id).map((e) => e.from),
          outgoing: outgoing(view, selected[0].id).map((e) => e.to),
        }
      : boundaryOf(view, selectedIds)

  return {
    nodes: selected,
    phase,
    boundary,
    issues,
  }
}

/**
 * Build a single `PhaseEntry` for a group of nodes sharing a phase.
 *
 * @param phase - the phase name (empty string for unphased nodes).
 * @param nodes - the nodes in the phase.
 * @param issues - the plan's issues, used to count open issues.
 * @returns the phase entry.
 */
function entryFor(phase: string, nodes: PlanNode[], issues: PlanIssue[]): PhaseEntry {
  const nodeIds = nodes.map((n) => n.id)
  const tools = nodes.filter((n) => n.kind === 'call').map((n) => n.definition.tool)

  const issueCount = issues.filter(
    (issue) => issue.nodeId !== undefined && nodeIds.includes(issue.nodeId)
  ).length

  return {
    phase,
    summary: summarize(phase, nodes),
    nodeIds,
    tools,
    issueCount,
  }
}

/**
 * Produce a one-line summary of a group of nodes.
 *
 * @param phase - the phase name.
 * @param nodes - the nodes in the phase.
 * @returns a short human-readable summary.
 */
function summarize(phase: string, nodes: PlanNode[]): string {
  const label = phase === '' ? 'unphased' : phase
  const calls = nodes.filter((n) => n.kind === 'call').length
  const reads = nodes.filter((n) => n.kind === 'reason').length
  const writes = nodes.filter((n) => n.kind === 'transform').length
  return `${label}: ${nodes.length} node(s) — ${calls} call, ${reads} reason, ${writes} transform`
}

/**
 * Compute the immediate predecessors/successors of a set of nodes, by id.
 *
 * @param view - the graph to search.
 * @param selectedIds - the ids of the slice's nodes.
 * @returns the boundary node ids, deduplicated.
 */
function boundaryOf(
  view: RawPlanView,
  selectedIds: Set<NodeId>
): { incoming: NodeId[]; outgoing: NodeId[] } {
  const incomingIds = new Set<NodeId>()
  const outgoingIds = new Set<NodeId>()
  for (const edge of view.edges) {
    if (selectedIds.has(edge.to) && !selectedIds.has(edge.from)) incomingIds.add(edge.from)
    if (selectedIds.has(edge.from) && !selectedIds.has(edge.to)) outgoingIds.add(edge.to)
  }
  return { incoming: [...incomingIds], outgoing: [...outgoingIds] }
}
