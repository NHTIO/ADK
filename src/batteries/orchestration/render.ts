/**
 * Prose projection of a plan — the review surface an operator reads at the approval gate, and the
 * re-consumption surface a model reads for a plan it did not author.
 *
 * @module @nhtio/adk/batteries/orchestration/render
 *
 * @remarks
 * There is NO dry run in this design. This prose IS the review surface, and that is what makes the
 * operator view load-bearing rather than cosmetic: an operator who approves a plan they cannot
 * fully see is the failure this replaces. So for `audience: 'operator'` with `view: 'as_planned'`,
 * brevity is NOT a virtue — every side effect with its tool and arguments, every authority claim,
 * every condition with its exact predicate, in traversal order, with branch structure legible.
 *
 * Arguments at approval time are STAGED, NOT RESOLVED, and the renderer says which. A `NodeRef`
 * resolves from the `OutputTable`, which only exists during a run; approval happens before any run
 * and there is no dry run to populate it. So a literal argument renders as its value, and a
 * `NodeRef` renders as its PROVENANCE — never as a fabricated value, never silently as though it
 * were known. The operator is approving what the plan will do with whatever its sources produce,
 * and the AUTHORITY CLAIM is the bound on that — which IS fully known at approval time. The
 * `as_executed` view is where arguments appear resolved, because by then they are.
 *
 * The operator view is a SEPARATE DISPLAY PROJECTION, not the execution payload: no model-written
 * free text rendered as if it were fact, no raw machine identifiers where a human-readable label
 * exists. The model view (`audience: 'model'`) is the inverse: exact identifiers, the same surface
 * forms a model would cite back, so a model can re-consume a plan it did not author without a
 * paraphrase hop.
 *
 * Properties:
 * - **DETERMINISTIC.** Same plan + same options ⇒ byte-identical output. The traversal order is
 *   fixed (entry-first, then graph order, with branch structure rendered by handle), value
 *   formatting is total, and nothing reads a clock, a store, or a global.
 * - **TOTAL.** Every node kind renders. The node-kind switch is exhaustiveness-checked with
 *   `const exhaustive: never = kind`, so a new node kind cannot silently render as nothing.
 *
 * It is NOT reversible — there is no prose parser, and `render(parse(s)) === s` is not promised,
 * because `parse` does not exist. The renderer is a one-way display projection.
 */

import { NodeRef as NodeRefClass } from './encoding'
import { isObject, isInstanceOf } from '../../lib/utils/guards'
import { outgoing, incoming, nodeById, entryNodes } from './plan'
import type {
  ArgValue,
  AuthorityClaim,
  AuthorityVerb,
  BranchId,
  DeclaredField,
  EdgeHandle,
  EncodableValue,
  NodeId,
  NodeRef,
  PlanEdge,
  PlanNode,
  RawPlanView,
  RunProjection,
} from './types'

// ── options ──────────────────────────────────────────────────────────────────
/**
 * The audience a render targets.
 * - `'operator'` — the approval-gate human: prose, trust framing, side effects legible, a total
 *   authority summary.
 * - `'model'` — a model re-consuming a plan it did not author: exact identifiers and surface
 *   forms, minimal paraphrase.
 */
type Audience = 'operator' | 'model'

/**
 * The view of a render.
 * - `'as_planned'` — what the plan WILL do. Arguments are staged; a `NodeRef` renders as its
 *   provenance, never as a fabricated value. This is the approval-gate view.
 * - `'as_executed'` — what the plan DID do, against a `RunProjection`. Arguments appear resolved
 *   from the run's `outputs`.
 */
type View = 'as_planned' | 'as_executed'

/**
 * Options for {@link renderPlan}.
 *
 * @remarks
 * The union encodes the two real read modes: `as_planned` carries no run (it is the approval-gate
 * view, before any execution), and `as_executed` requires a `RunProjection` so arguments can be
 * resolved from its `outputs` and node states can be annotated.
 */
export type RenderPlanOptions =
  | { audience: Audience; view: 'as_planned' }
  | { audience: Audience; view: 'as_executed'; run: RunProjection }

// ── the public function ──────────────────────────────────────────────────────
/**
 * Render a plan as prose — the review surface an operator reads at the approval gate, or the
 * re-consumption surface a model reads for a plan it did not author.
 *
 * @remarks
 * A PURE function of its arguments — no store access, no I/O, no clock. That is what keeps it
 * testable and deterministic: the same plan plus the same options yields byte-identical output,
 * and a snapshot test is a complete regression contract. It reads no `PlanStore`, resolves no
 * live values, and registers nothing.
 *
 * The `as_planned` view renders staged arguments as their provenance (a `NodeRef` names the node
 * and selection it reads, never a fabricated value); the `as_executed` view resolves them against
 * `run.outputs`. The operator view renders every side effect with its tool and arguments, every
 * authority claim, every condition with its exact predicate, and ends with a deduplicated
 * total-authority summary grouped by capability; the model view renders exact identifiers.
 *
 * DETERMINISTIC and TOTAL — see the module doc. Not reversible.
 *
 * @param plan - the {@link RawPlanView} to render.
 * @param options - audience, view, and (for `as_executed`) the {@link RunProjection} to resolve
 *   against.
 * @returns the prose projection, as a single string.
 */
export function renderPlan(plan: RawPlanView, options: RenderPlanOptions): string {
  const lines: string[] = []
  const ctx: RenderContext = {
    plan,
    audience: options.audience,
    view: options.view,
    run: options.view === 'as_executed' ? options.run : undefined,
  }

  renderHeader(ctx, lines)
  renderProvenance(ctx, lines)
  renderBody(ctx, lines)
  if (ctx.audience === 'operator') {
    renderTotalAuthority(ctx, lines)
  }

  return lines.join('\n')
}

// ── internal context ─────────────────────────────────────────────────────────
/**
 * The fixed bundle a render pass threads through its helpers. Carries everything a helper needs
 * so none of them takes a long argument list or reaches outside the function's inputs.
 */
interface RenderContext {
  plan: RawPlanView
  audience: Audience
  view: View
  run: RunProjection | undefined
}

// ── header ───────────────────────────────────────────────────────────────────
/**
 * Append the plan header: id, digest, revision, and the view/audience banner.
 */
const renderHeader = (ctx: RenderContext, lines: string[]): void => {
  const { plan, audience, view } = ctx
  lines.push(`Plan ${plan.planId}`)
  lines.push(`digest: ${plan.digest}`)
  lines.push(`revision: ${plan.revision}`)
  lines.push(
    `${audience === 'operator' ? 'Operator' : 'Model'} view · ${view === 'as_planned' ? 'as planned' : 'as executed'}`
  )
  if (view === 'as_executed' && ctx.run) {
    lines.push(`run: ${ctx.run.runId} · outcome: ${ctx.run.outcome}`)
    if (ctx.run.interruption) {
      lines.push(`interrupted: ${describeInterruption(ctx.run.interruption)}`)
    }
  }
  lines.push('')
}

// ── provenance ───────────────────────────────────────────────────────────────
/**
 * Append provenance: the lineage of a cloned or templated plan.
 *
 * @remarks
 * A CLONE must warn that its parent already completed nodes X, Y, Z and that approving it will
 * perform them AGAIN. The completed list is read from `provenance.completedAtClone`, which
 * `clonePlan` snapshotted; needing no store access is what keeps this function pure.
 */
const renderProvenance = (ctx: RenderContext, lines: string[]): void => {
  const p = ctx.plan.provenance
  if (!p) return
  if (p.kind === 'clone') {
    lines.push('Lineage: cloned plan')
    lines.push(`  parent: ${p.parent} (digest ${p.parentDigest}, revision ${p.parentRevision})`)
    if (p.completedAtClone.length > 0) {
      lines.push(
        `  WARNING: the parent already completed ${p.completedAtClone.length} node(s) at clone time —`
      )
      lines.push(`  approving this plan will perform them AGAIN:`)
      for (const id of p.completedAtClone) {
        lines.push(`    · ${id}`)
      }
    } else {
      lines.push(`  the parent had completed no nodes at clone time.`)
    }
    lines.push('')
  } else {
    lines.push('Lineage: instantiated from template')
    lines.push(`  template: ${p.template}`)
    const argKeys = Object.keys(p.args).sort()
    if (argKeys.length > 0) {
      lines.push(`  args:`)
      for (const k of argKeys) {
        lines.push(`    ${k}: ${formatValue(p.args[k], ctx)}`)
      }
    }
    lines.push('')
  }
}

// ── body: traversal ──────────────────────────────────────────────────────────
/**
 * Append the body: every node rendered in traversal order, with branch structure legible.
 *
 * @remarks
 * Traversal starts from the (single) entry node, then walks the graph in a deterministic
 * depth-first order over outgoing edges grouped by handle so a reader sees a step's successors
 * immediately under it. Nodes not reachable from entry (a malformed plan) are still rendered in an
 * "Unreachable" tail so the projection stays TOTAL over the node set.
 */
const renderBody = (ctx: RenderContext, lines: string[]): void => {
  const { plan } = ctx
  const entries = entryNodes(plan)
  const visited = new Set<NodeId>()
  let step = 0

  const renderNodeAt = (node: PlanNode, via: string | undefined, depth: number): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    step += 1
    renderNode(ctx, lines, node, step, via, depth)
    const edges = outgoing(plan, node.id)
    // Deterministic order: by handle then by target id, so the same graph always renders the same.
    const ordered = edges
      .slice()
      .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : a.to < b.to ? -1 : 1))
    for (const edge of ordered) {
      const target = nodeById(plan, edge.to)
      if (!target) continue
      renderEdge(ctx, lines, edge, depth)
      renderNodeAt(target, edge.handle, depth + 1)
    }
  }

  for (const entry of entries) {
    renderNodeAt(entry, undefined, 0)
  }

  const unreachable = plan.nodes.filter((n) => !visited.has(n.id))
  if (unreachable.length > 0) {
    lines.push('Unreachable nodes (not reachable from entry):')
    for (const id of unreachable.map((n) => n.id).sort()) {
      lines.push(`  · \`${id}\``)
    }
    lines.push('')
  }
}

// ── per-node rendering ───────────────────────────────────────────────────────
/**
 * Append one node's prose, indented to `depth` and numbered `step`.
 *
 * @remarks
 * The node-kind switch is exhaustiveness-checked with `const exhaustive: never = kind` so a new
 * node kind cannot silently render as nothing — the compiler refuses an unhandled kind.
 */
const renderNode = (
  ctx: RenderContext,
  lines: string[],
  node: PlanNode,
  step: number,
  via: string | undefined,
  depth: number
): void => {
  const indent = '  '.repeat(depth)
  const kind = node.kind
  const status = nodeStatus(ctx, node.id)

  switch (kind) {
    case 'entry': {
      const def = node.definition
      lines.push(`${indent}${step}. ENTRY — \`${node.id}\`${status ? ` [${status}]` : ''}`)
      if (def.input.length > 0) {
        lines.push(`${indent}    inputs:`)
        for (const field of def.input) {
          lines.push(`${indent}      · ${describeDeclaredField(field)}`)
        }
      } else {
        lines.push(`${indent}    inputs: (none)`)
      }
      break
    }
    case 'call': {
      const def = node.definition
      lines.push(
        `${indent}${step}. CALL — \`${node.id}\` — ${def.tool}(${status ? ` [${status}]` : ''}`
      )
      renderCallArgs(ctx, lines, def.args, indent + '    ')
      renderAuthority(ctx, lines, def.authority, indent + '    ')
      renderCallRecovery(ctx, lines, def, def.authority, indent + '    ')
      if (def.declassifies && def.declassifies.length > 0) {
        lines.push(`${indent}    declassifies: ${def.declassifies.join(', ')}`)
      }
      renderOutputFields(ctx, lines, def.output, indent + '    ')
      renderOutcomesByHandle(ctx, lines, node.id, indent + '    ')
      break
    }
    case 'reason': {
      const def = node.definition
      lines.push(`${indent}${step}. REASON — \`${node.id}\`${status ? ` [${status}]` : ''}`)
      lines.push(`${indent}    prompt:`)
      for (const part of def.prompt) {
        if ('text' in part) {
          lines.push(`${indent}      text: ${JSON.stringify(part.text)}`)
        } else {
          lines.push(`${indent}      ref: ${describeNodeRef(part, ctx)}`)
        }
      }
      lines.push(`${indent}    output schema: ${def.outputSchema}`)
      lines.push(`${indent}    max attempts: ${def.maxAttempts}`)
      renderOutcomesByHandle(ctx, lines, node.id, indent + '    ')
      break
    }
    case 'transform': {
      const def = node.definition
      lines.push(`${indent}${step}. TRANSFORM — \`${node.id}\`${status ? ` [${status}]` : ''}`)
      lines.push(`${indent}    source: ${describeNodeRef(def.source, ctx)}`)
      lines.push(`${indent}    steps:`)
      def.steps.forEach((s, i) => {
        const args = s.args ? ` args: ${formatRecord(s.args, ctx)}` : ''
        lines.push(`${indent}      ${i + 1}. ${s.name}${args}`)
      })
      lines.push(
        `${indent}    emit: ${def.emit.as === 'rows' ? 'rows' : `value → ${def.emit.field}`}`
      )
      renderOutputFields(ctx, lines, def.output, indent + '    ')
      renderOutcomesByHandle(ctx, lines, node.id, indent + '    ')
      break
    }
    case 'branch': {
      const def = node.definition
      lines.push(`${indent}${step}. BRANCH — \`${node.id}\`${status ? ` [${status}]` : ''}`)
      lines.push(`${indent}    evaluator: ${def.evaluator}`)
      lines.push(`${indent}    predicate: ${formatValue(def.predicate, ctx)}`)
      renderOutcomesByHandle(ctx, lines, node.id, indent + '    ')
      break
    }
    case 'select': {
      const def = node.definition
      lines.push(`${indent}${step}. SELECT — \`${node.id}\`${status ? ` [${status}]` : ''}`)
      lines.push(`${indent}    evaluator: ${def.evaluator}`)
      lines.push(`${indent}    predicate: ${formatValue(def.predicate, ctx)}`)
      lines.push(`${indent}    cases: ${def.cases.join(', ')}`)
      renderOutcomesByHandle(ctx, lines, node.id, indent + '    ')
      break
    }
    case 'join': {
      // `via` is unused here but kept in the signature for uniformity.
      void via
      lines.push(`${indent}${step}. JOIN — \`${node.id}\`${status ? ` [${status}]` : ''}`)
      const preds = incoming(ctx.plan, node.id)
      lines.push(`${indent}    awaits ${preds.length} incoming edge(s):`)
      for (const e of preds) {
        lines.push(`${indent}      · ${e.id} from ${e.from} (handle ${e.handle})`)
      }
      renderOutcomesByHandle(ctx, lines, node.id, indent + '    ')
      break
    }
    default: {
      // Exhaustiveness: a new node kind renders as a NAMED gap rather than nothing.
      const exhaustive: never = kind
      void exhaustive
      lines.push(`${indent}${step}. (unrendered node kind: ${String(kind)})`)
    }
  }
}

// ── call arg rendering ───────────────────────────────────────────────────────
/**
 * Append a call's staged arguments. A `NodeRef` renders as its provenance; a literal renders as
 * its value. In `as_executed`, a `NodeRef` is additionally resolved against `run.outputs` so the
 * reader sees what the reference actually produced.
 */
const renderCallArgs = (
  ctx: RenderContext,
  lines: string[],
  args: Record<string, ArgValue>,
  indent: string
): void => {
  const keys = Object.keys(args).sort()
  if (keys.length === 0) {
    lines.push(`${indent}args: (none)`)
    return
  }
  lines.push(`${indent}args:`)
  for (const k of keys) {
    const value = args[k]
    lines.push(`${indent}  ${k}: ${describeArgValue(value, ctx)}`)
  }
}

/**
 * Describe a single staged argument value: provenance for a `NodeRef`, formatted literal
 * otherwise. In `as_executed`, a `NodeRef` is resolved against the run's outputs and the resolved
 * value is shown alongside the provenance.
 */
const describeArgValue = (value: ArgValue, ctx: RenderContext): string => {
  if (NodeRefClass.isNodeRef(value)) {
    const provenance = describeNodeRef(value, ctx)
    if (ctx.view === 'as_executed' && ctx.run) {
      const resolved = resolveNodeRef(value, ctx.run.outputs)
      if (resolved !== undefined) {
        return `${provenance} ⇒ ${resolved}`
      }
    }
    return provenance
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => describeArgValue(v, ctx)).join(', ')}]`
  }
  if (isObject(value)) {
    return formatRecord(value as Record<string, ArgValue>, ctx)
  }
  return formatValue(value as EncodableValue, ctx)
}

/**
 * Format a record of staged values, key-sorted for determinism.
 */
const formatRecord = (rec: Record<string, ArgValue>, ctx: RenderContext): string => {
  const keys = Object.keys(rec).sort()
  const parts = keys.map((k) => `${k}: ${describeArgValue(rec[k], ctx)}`)
  return `{${parts.join(', ')}}`
}

// ── NodeRef provenance ───────────────────────────────────────────────────────
/**
 * Describe a `NodeRef` by its PROVENANCE — the node it reads, the selection, and the path — never
 * by a fabricated value. This is what an operator approves: "what the plan will do with whatever
 * step N produces", and the authority claim is the bound on that.
 */
const describeNodeRef = (ref: NodeRef, ctx: RenderContext): string => {
  const source = ctx.audience === 'operator' ? '←' : '$ref'
  const sel = describeSelect(ref.select)
  const path = ref.path ? ` @ ${ref.path}` : ''
  const branch = ref.branchId ? ` (branch ${describeBranchId(ref.branchId)})` : ''
  const sourceNode = nodeById(ctx.plan, ref.node)
  const sourceTool =
    sourceNode && sourceNode.kind === 'call' ? ` (${sourceNode.definition.tool})` : ''
  if (ctx.audience === 'model') {
    return `${source} {node: ${ref.node}, select: ${sel}${ref.path ? `, path: ${JSON.stringify(ref.path)}` : ''}${ref.branchId ? `, branch: ${describeBranchId(ref.branchId)}` : ''}}`
  }
  return `${source} ${sel} output of step ${ref.node}${sourceTool}${path}${branch}`
}

/**
 * Render the `select` field of a `NodeRef` as prose.
 */
const describeSelect = (select: NodeRef['select']): string => {
  if (typeof select === 'string') {
    switch (select) {
      case 'first':
        return 'the first'
      case 'last':
        return 'the last'
      case 'all':
        return 'every'
      default: {
        const exhaustive: never = select
        void exhaustive
        return String(select)
      }
    }
  }
  return `item ${select.index}`
}

/**
 * Render a `BranchId` as its canonical key form. The segments carry the route; the key is the
 * injective string form the rest of the battery uses, so this matches what an operator would see
 * in any other diagnostic without inventing a second rendering.
 */
const describeBranchId = (branch: BranchId): string => {
  const segs = branch.segments
  if (segs.length === 0) return 'entry'
  return segs.map((s): string => ('edge' in s ? `→${s.edge}` : `→join:${s.join}`)).join('')
}

// ── authority ────────────────────────────────────────────────────────────────
/**
 * Append a call's authority claims, one per line, in the form
 * `capability · scope · verb`. These are the bounds the operator is approving, and they are fully
 * known at approval time even when arguments are staged.
 */
const renderAuthority = (
  _ctx: RenderContext,
  lines: string[],
  claims: AuthorityClaim[],
  indent: string
): void => {
  if (claims.length === 0) {
    lines.push(`${indent}authority: (none claimed)`)
    return
  }
  lines.push(`${indent}authority:`)
  for (const claim of claims) {
    lines.push(`${indent}  · ${describeAuthority(claim)}`)
  }
}

/**
 * Render a single authority claim as `capability · scope · verb`.
 */
const describeAuthority = (claim: AuthorityClaim): string => {
  return `${claim.capability} · ${claim.scope} · ${claim.verb}`
}

// ── call recovery ────────────────────────────────────────────────────────────
/**
 * Mutating authority verbs — those that change state. The five `AuthorityVerb`s have NO
 * implication between them by design (`update` does not imply `read`), so each claim is
 * classified independently rather than by hierarchy.
 */
const MUTATING_VERBS: ReadonlySet<AuthorityVerb> = new Set(['create', 'update', 'delete'])

/**
 * Append a call's recovery behaviour and side-effect notice. The recovery is inside the approved
 * digest, so it is rendered for every audience. `skip` renders its CONSEQUENCE — downstream nodes
 * proceed against a step whose effect is unknown — rather than reading as a clean recovery.
 *
 * The side-effect marker is decided from the node's AUTHORITY VERBS, not pushed unconditionally:
 * `list`/`read` are non-mutating; `create`/`update`/`delete` are mutating. A call with NO claims
 * is treated as UNKNOWN (potentially mutating) — never silently safe — so an unclaimed side
 * effect stays flagged. The replay-safety and interruption lines are meaningful only for steps
 * that change something, so they stay attached to mutating (and unknown) steps.
 */
const renderCallRecovery = (
  _ctx: RenderContext,
  lines: string[],
  def: { replaySafe: boolean; onIndeterminate: 'retry' | 'halt' | 'skip' },
  claims: AuthorityClaim[],
  indent: string
): void => {
  const mutating = claims.some((c) => MUTATING_VERBS.has(c.verb))
  const unclaimed = claims.length === 0
  if (unclaimed) {
    lines.push(
      `${indent}NO AUTHORITY CLAIMED — whether this changes anything is UNKNOWN. Treat as potentially mutating.`
    )
  } else if (mutating) {
    lines.push(
      `${indent}THIS MODIFIES DATA. Repeats are ${def.replaySafe ? 'safe (declared replay-safe)' : 'NOT safe (declared not replay-safe)'}.`
    )
  } else {
    lines.push(`${indent}(no changes made — all declared verbs are read-only)`)
    return
  }
  switch (def.onIndeterminate) {
    case 'retry':
      lines.push(`${indent}If interrupted mid-call, this step will be retried.`)
      break
    case 'halt':
      lines.push(`${indent}If interrupted mid-call, this step will stop and wait for you.`)
      break
    case 'skip':
      lines.push(
        `${indent}If interrupted mid-call, this step will be SKIPPED — downstream nodes proceed against a step whose effect is UNKNOWN.`
      )
      break
    default: {
      const exhaustive: never = def.onIndeterminate
      void exhaustive
      lines.push(`${indent}(unknown recovery: ${String(def.onIndeterminate)})`)
    }
  }
}

// ── output fields ────────────────────────────────────────────────────────────
/**
 * Append a node's declared output fields, one per line. These are what downstream `NodeRef`s may
 * address, so they are part of the review surface.
 */
const renderOutputFields = (
  _ctx: RenderContext,
  lines: string[],
  fields: DeclaredField[],
  indent: string
): void => {
  if (fields.length === 0) {
    lines.push(`${indent}output: (none declared)`)
    return
  }
  lines.push(`${indent}output:`)
  for (const field of fields) {
    lines.push(`${indent}  · ${describeDeclaredField(field)}`)
  }
}

/**
 * Render a declared field as `path: type` (with the enum's values or the string's byte cap where
 * present).
 */
const describeDeclaredField = (field: DeclaredField): string => {
  switch (field.type) {
    case 'string':
      return field.maxBytes !== undefined
        ? `${field.path}: string (≤ ${field.maxBytes} bytes)`
        : `${field.path}: string`
    case 'number':
      return `${field.path}: number`
    case 'boolean':
      return `${field.path}: boolean`
    case 'enum':
      return `${field.path}: enum {${field.values.join(', ')}}`
    default: {
      // Exhaustiveness: DeclaredField's type union is closed, so this branch is unreachable.
      // A new field type cannot silently render as nothing — the compiler refuses it here.
      const exhaustive: never = field
      void exhaustive
      return '(unrendered field type)'
    }
  }
}

// ── edges and outcomes ───────────────────────────────────────────────────────
/**
 * Append a single edge as a one-line annotation of how control leaves a node. An `error` handle
 * renders as an ABORT, never as a confirmation prompt — there is no mid-run gate in this design,
 * and a mid-run need for an answer means the plan was insufficient.
 */
const renderEdge = (ctx: RenderContext, lines: string[], edge: PlanEdge, depth: number): void => {
  const indent = '  '.repeat(depth)
  const label = describeHandle(edge.handle)
  if (edge.handle === 'error') {
    lines.push(`${indent}→ ABORT on error → step ${edge.to} (${label})`)
  } else {
    lines.push(`${indent}→ on ${label} → step ${edge.to}`)
  }
  if (ctx.view === 'as_executed' && ctx.run) {
    const taken = ctx.run.edgesTaken.find((t) => t.edgeId === edge.id)
    if (taken) {
      const ev =
        taken.evidence !== undefined ? ` evidence: ${formatValue(taken.evidence, ctx)}` : ''
      lines.push(`${indent}  [taken · handle ${taken.handle}${ev}]`)
    }
  }
}

/**
 * Append a summary of a node's outgoing edges grouped by handle, so the branch structure is
 * legible even when a reader scans a single node. Mirrors {@link renderEdge} but without depth.
 */
const renderOutcomesByHandle = (
  ctx: RenderContext,
  lines: string[],
  nodeId: NodeId,
  indent: string
): void => {
  const edges = outgoing(ctx.plan, nodeId)
  if (edges.length === 0) {
    lines.push(`${indent}on completion: (terminal — no outgoing edges)`)
    return
  }
  lines.push(`${indent}on completion:`)
  const ordered = edges
    .slice()
    .sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : a.to < b.to ? -1 : 1))
  for (const edge of ordered) {
    const label = describeHandle(edge.handle)
    if (edge.handle === 'error') {
      lines.push(`${indent}  · ABORT on error → step ${edge.to}`)
    } else {
      lines.push(`${indent}  · on ${label} → step ${edge.to}`)
    }
  }
}

/**
 * Render an edge handle as a human-readable label. `case_*` strips the reserved prefix so a
 * `select`'s cases read as their authored labels.
 */
const describeHandle = (handle: EdgeHandle): string => {
  switch (handle) {
    case 'always':
      return 'always'
    case 'match':
      return 'match'
    case 'no_match':
      return 'no match'
    case 'default':
      return 'default'
    case 'error':
      return 'error'
    default:
      if (handle.startsWith('case_')) {
        return `case ${handle.slice('case_'.length)}`
      }
      return handle
  }
}

// ── total authority summary ──────────────────────────────────────────────────
/**
 * Append the "Total authority requested" summary: the deduplicated union of every call's
 * authority claims, grouped by capability. This is the operator's one-glance answer to "what is
 * this plan asking to do".
 */
const renderTotalAuthority = (ctx: RenderContext, lines: string[]): void => {
  const byCapability = new Map<string, AuthorityClaim[]>()
  for (const node of ctx.plan.nodes) {
    if (node.kind !== 'call') continue
    for (const claim of node.definition.authority) {
      const list = byCapability.get(claim.capability)
      if (list) list.push(claim)
      else byCapability.set(claim.capability, [claim])
    }
  }
  lines.push('Total authority requested')
  if (byCapability.size === 0) {
    lines.push('  (no authority claimed by any call)')
    lines.push('')
    return
  }
  const capabilities = [...byCapability.keys()].sort()
  for (const cap of capabilities) {
    const claims = byCapability.get(cap)!
    // Deduplicate by `${scope}|${verb}` and sort for determinism.
    const seen = new Set<string>()
    const unique: AuthorityClaim[] = []
    for (const c of claims) {
      const key = `${c.scope}|${c.verb}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(c)
      }
    }
    unique.sort((a, b) =>
      a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : verbRank(a.verb) - verbRank(b.verb)
    )
    lines.push(`  ${cap}:`)
    for (const c of unique) {
      lines.push(`    · ${c.scope} · ${c.verb}`)
    }
  }
  lines.push('')
}

/**
 * A stable ordering for verbs in the authority summary, so the same claim set always renders in
 * the same order.
 */
const verbRank = (verb: AuthorityVerb): number => {
  switch (verb) {
    case 'list':
      return 0
    case 'read':
      return 1
    case 'create':
      return 2
    case 'update':
      return 3
    case 'delete':
      return 4
    default: {
      const exhaustive: never = verb
      void exhaustive
      return 99
    }
  }
}

// ── value formatting ─────────────────────────────────────────────────────────
/**
 * Format an `EncodableValue` as a stable string. Total over the value domain: every member of
 * `EncodableValue` renders, and the rendering is deterministic so the same value always yields the
 * same bytes.
 *
 * @remarks
 * `Date`, `RegExp`, `Map`, `Set`, typed arrays, `ArrayBuffer`, `DataView`, bigint and the luxon
 * types each have a named rendering rather than collapsing to `{}` (which `JSON.stringify` would
 * do for the class-owned values). Plain records and arrays recurse with sorted keys.
 */
const formatValue = (value: EncodableValue, ctx: RenderContext): string => {
  void ctx
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${value}n`
    case 'undefined':
      return 'undefined'
    case 'symbol':
      // Symbols are outside EncodableValue but `typeof` can still surface one through `unknown`;
      // render the description rather than throwing.
      return String(value)
    case 'function':
      // Functions are outside EncodableValue; render a marker rather than throwing.
      return '<function>'
    case 'object':
      break
    default: {
      const exhaustive: never = value
      void exhaustive
      return String(value)
    }
  }
  if (value === null) return 'null'
  if (isInstanceOf(value, 'Date', Date)) return `Date(${value.toISOString()})`
  if (isInstanceOf(value, 'RegExp', RegExp)) return `RegExp(${value.source})`
  if (isInstanceOf(value, 'ArrayBuffer', ArrayBuffer))
    return `ArrayBuffer(${value.byteLength} bytes)`
  if (isInstanceOf(value, 'DataView', DataView)) return `DataView(${value.byteLength} bytes)`
  if (isInstanceOf(value, 'Map', Map)) {
    const entries = [...value.entries()]
      .map(
        ([k, v]) =>
          `${formatValue(k as EncodableValue, ctx)}: ${formatValue(v as EncodableValue, ctx)}`
      )
      .join(', ')
    return `Map{${entries}}`
  }
  if (isInstanceOf(value, 'Set', Set)) {
    const items = [...value.values()].map((v) => formatValue(v as EncodableValue, ctx)).join(', ')
    return `Set{${items}}`
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatValue(v, ctx)).join(', ')}]`
  }
  if (ArrayBuffer.isView(value) && !isInstanceOf(value, 'DataView', DataView)) {
    // Typed array (Int8Array, Uint8Array, …). Render length plus a byte hint.
    const ctor = value.constructor as { name?: string }
    const name = ctor.name ?? 'TypedArray'
    return `${name}(${(value as unknown as { length: number }).length})`
  }
  if (isObject(value)) {
    // A plain record. Sort keys for determinism.
    return formatEncodableRecord(value as Record<string, EncodableValue>, ctx)
  }
  // An object with a non-plain prototype we did not name above (e.g. a luxon DateTime/Duration/
  // Interval). Render its constructor name and toString rather than collapsing to {}.
  const ctor = (value as { constructor?: { name?: string } }).constructor
  const name = ctor?.name ?? 'object'
  const text = (() => {
    try {
      return String(value)
    } catch {
      return '<unstringifiable>'
    }
  })()
  return `${name}(${text})`
}

/**
 * Format a plain `EncodableValue` record with sorted keys.
 */
const formatEncodableRecord = (rec: Record<string, EncodableValue>, ctx: RenderContext): string => {
  const keys = Object.keys(rec).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}: ${formatValue(rec[k], ctx)}`)
  return `{${parts.join(', ')}}`
}

// ── run projection helpers ───────────────────────────────────────────────────
/**
 * The rolled-up status of a node for the `as_executed` view, or `undefined` for `as_planned`.
 */
const nodeStatus = (ctx: RenderContext, nodeId: NodeId): string | undefined => {
  if (ctx.view !== 'as_executed' || !ctx.run) return undefined
  return ctx.run.nodeStatusById.get(nodeId)
}

/**
 * Resolve a `NodeRef` against an `OutputTable`, returning a formatted string of its selected
 * value(s) or `undefined` when the referenced output is absent (the run did not produce it).
 *
 * @remarks
 * The key is the same `${nodeId}:${branchKey(branchId)}` the rest of the battery uses, so this
 * resolves exactly what the executor would resolve. `select: 'all'` renders a bracketed list;
 * `select: {index}` renders a single item; `first`/`last` render the obvious endpoint.
 */
const resolveNodeRef = (ref: NodeRef, outputs: RunProjection['outputs']): string | undefined => {
  const key = ref.branchId ? `${ref.node}:${branchKeyOfString(ref.branchId)}` : ref.node
  // The OutputTable is keyed `${nodeId}:${branchKey}`; when a ref carries no branchId the
  // executor resolves against the single matching key for that node, so scan for it.
  let entry: { items: { json: Record<string, EncodableValue> }[] } | undefined
  if (ref.branchId) {
    entry = outputs.get(key) as typeof entry
  } else {
    for (const [k, v] of outputs.entries()) {
      if (k.startsWith(`${ref.node}:`)) {
        entry = v as typeof entry
        break
      }
    }
  }
  if (!entry || entry.items.length === 0) return undefined
  const items = entry.items
  const pick = (idx: number): Record<string, EncodableValue> | undefined => {
    const item = items[idx]
    return item ? item.json : undefined
  }
  let selected: unknown
  if (ref.select === 'first') selected = pick(0)
  else if (ref.select === 'last') selected = pick(items.length - 1)
  else if (ref.select === 'all') selected = items.map((i) => i.json)
  else selected = pick(ref.select.index)
  if (selected === undefined) return undefined
  if (ref.path) {
    if (!isObject(selected)) return undefined
    selected = readPath(selected as Record<string, EncodableValue>, ref.path)
    if (selected === undefined) return undefined
  }
  return formatResolvedValue(selected)
}

/**
 * Read a dot-path from a record, returning `undefined` when any segment is absent.
 */
const readPath = (
  root: Record<string, EncodableValue>,
  path: string
): EncodableValue | undefined => {
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (isObject(cur) && seg in cur) {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur as EncodableValue | undefined
}

/**
 * Format a resolved value for inline display next to a ref's provenance.
 */
const formatResolvedValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`
  }
  if (isObject(value)) {
    return JSON.stringify(value)
  }
  return JSON.stringify(value)
}

/**
 * A local re-derivation of the branch-key string for resolution. The canonical `branchKey` lives
 * in the encoding battery and is importable, but to keep this renderer a pure function of the
 * shapes in `./types` plus `./encoding` and `./plan` (and avoid pulling the encoder's
 * registration into a display path), we re-derive the same length-prefixed form the encoding
 * battery documents as its injective key. This mirrors `branchKey` exactly; the encoding battery's
 * own implementation is the authority and this is a display-side echo of it.
 */
const branchKeyOfString = (branch: BranchId): string => {
  if (branch.segments.length === 0) return ''
  let out = ''
  for (const seg of branch.segments) {
    if ('edge' in seg) {
      out += `e${seg.edge.length}:${seg.edge}`
    } else {
      const ofPart = seg.of.map((id: string) => `${id.length}:${id}`).join('')
      out += `j${seg.join.length}:${seg.join}(${ofPart})`
    }
  }
  return out
}

/**
 * Render an interruption cause as a one-line label for the header.
 */
const describeInterruption = (cause: RunProjection['interruption']): string => {
  if (!cause) return 'unknown'
  switch (cause.kind) {
    case 'turn_abort':
      return 'turn abort'
    case 'operator_stop':
      return 'operator stop'
    case 'gate_timeout':
      return 'gate timeout'
    case 'process_death':
      return 'process death'
    case 'budget_exhausted':
      return `step budget exhausted after ${cause.settled} settlement(s)`
    case 'deviation_abort':
      return `deviation abort: ${cause.detail}`
    case 'node_failed':
      return `node ${cause.nodeId} failed (unhandled)`
    case 'predicate_unevaluatable':
      return `predicate unevaluatable at node ${cause.nodeId}`
    case 'join_unsatisfiable':
      return `join ${cause.nodeId} unsatisfiable`
    case 'output_schema_violation':
      return `output schema violated at node ${cause.nodeId}`
    case 'authority_revoked':
      return `authority revoked: ${describeAuthority(cause.claim)}`
    default: {
      const exhaustive: never = cause
      void exhaustive
      return String(cause)
    }
  }
}
