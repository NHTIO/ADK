/**
 * @module @nhtio/adk/batteries/orchestration/executor
 *
 * The breadth-first executor that walks a plan graph to a terminal state and returns a
 * {@link RunProjection} derived entirely from the durable event log.
 *
 * Correctness rests on a strict commit protocol rather than on in-memory bookkeeping. Before a
 * node may be invoked its `node_entered` event is durably appended and awaited; once it settles,
 * `node_settled`, every `edge_taken`, and the fresh `frontier_snapshot` are committed together as
 * one atomic batch. A resume folds the same log, so the projection it produces can never disagree
 * with what a resumed run would observe — the projection is the log, not a shadow copy this
 * executor happens to keep.
 *
 * Concurrency is controlled by `PlanStore.claimRun`, which enforces that a plan has at most one
 * live run for a given digest. The optional lock factory is a weaker, best-effort guard; the
 * durable claim is the contract, and the executor claims before invoking any node.
 */

import { foldRun } from './runs'
import { foldOps, branchKey } from './ops'
import { NodeRef as NodeRefClass } from './encoding'
import { effectiveToolMethods } from './artifact_methods'
import { joinPromptParts, decodeOutputSchema } from './reason'
import { isInstanceOf, isObject, isError } from '../../lib/utils/guards'
import {
  nodeById,
  outgoing,
  incoming,
  entryNodes,
  handleAppliesTo,
  readPath,
  immediateDominator,
} from './plan'
import type { PlanStore } from './store'
import type {
  RunOptions,
  RunEvent,
  RunProjection,
  PendingFrame,
  JoinState,
  FrameRef,
  PlanEdge,
  PlanNodeKind,
  EdgeHandle,
  NodeOutput,
  OutputItem,
  OutputTable,
  ArtifactTable,
  BranchId,
  NodeRef,
  ArgValue,
  EncodableValue,
  NodeOutcome,
  PredicateEvaluator,
  PredicateVerdict,
  CallInvokerFn,
  ReasonerFn,
  SpooledArtifactLike,
  DeclaredField,
  RawPlanView,
  RouteSegment,
} from './types'

/**
 * Upper bound on total node settlements before the executor aborts. Deliberately reported as
 * BUDGET EXHAUSTION, never as a cycle — the two are distinct failures.
 */
const TOTAL_STEPS_BUDGET = 4096

/** The entry route: no segments. Every route in the graph originates here. */
const ENTRY_BRANCH: BranchId = { segments: [] }

const now = (): string => new Date().toISOString()

/** One work-queue item: a frame plus its branch-local value and artifact tables. */
interface RunFrame {
  frame: FrameRef
  outputs: OutputTable
  artifacts: ArtifactTable
  /** The verdict a `branch`/`select` node computed, for edge firing. */
  verdict?: PredicateVerdict
  /**
   * For a `join` frame only: the merged frame its COMPLETING arrival produced.
   *
   * @remarks
   * A join is a barrier, so an arrival that leaves it open settles nothing and fires nothing.
   * This field is how that decision reaches the walk loop, which owns edge firing: `undefined`
   * means the barrier is still open and this frame parks, while a value means it closed and
   * carries the merged identity and unioned tables the successor must inherit.
   */
  merged?: { frame: FrameRef; outputs: OutputTable; artifacts: ArtifactTable }
  /** Ancestor route for runtime cycle defence, excluding the frame's own node. */
  ancestors: string[]
}

/** A fired edge and the successor frame it produced. */
interface FiredEdge {
  to: RunFrame
  edge: PlanEdge
}

/** The canonical table key for a node on a branch. Always built via `branchKey`. */
const tableKey = (nodeId: string, branchId: BranchId): string => `${nodeId}:${branchKey(branchId)}`

/** Fully-resolved execution dependencies. */
interface ResolvedDeps {
  invokeCall: CallInvokerFn
  reason: ReasonerFn
  evaluators: PredicateEvaluator[]
}

/** State threaded through the whole walk; deliberately not module-global. */
interface ExecutorContext {
  store: PlanStore
  planId: string
  runId: string
  plan: RawPlanView
  deps: ResolvedDeps
  options: RunOptions
  entryId: string
  /** Open join barriers, keyed by correlation key. */
  joins: Map<string, JoinState>
  steps: number
}

/**
 * Execute a plan against external input and return the projection folded from the durable event
 * log. External input is materialised as the entry frame's `node_settled` before any other node
 * runs, so it is addressable by `NodeRef` exactly like any other node output and is rebuilt from
 * events on resume.
 *
 * @remarks
 * **ORDER OF OPERATIONS, because it is observable and load-bearing.** Everything that can refuse
 * a request happens BEFORE `claimRun`: the plan is read and folded, the entry node is located,
 * and `RunOptions.input` is validated against its `DeclaredField[]`. Only then is the run claimed.
 *
 * That ordering is not an optimisation. `claimRun` is irreversible by design — a plan admits one
 * run EVER and the store exposes no release — so a check that ran after it would burn the plan's
 * only run on a request that never invoked a single tool, leaving it permanently
 * `run_already_claimed` with `clonePlan` the only recovery. A rejected request must cost the plan
 * nothing.
 *
 * So a caller can rely on this: **if this function throws on invalid input, the plan is still
 * runnable.** Fix the input and call again.
 *
 * The budget is the PLAN'S `bounds.maxSteps`, not a library constant — bounds are plan content,
 * digested and approved by the operator. Exhausting it settles the run `halted` with
 * `budget_exhausted{settled}`, never `process_death`: the executor knows why it stopped, and a
 * resume re-reports the same cause rather than looping, because the bound has not changed.
 *
 * @param store The plan store backing the run.
 * @param planId The id of the plan to execute.
 * @param options Per-run input and override dependencies.
 * @returns The {@link RunProjection} folded from the run's event log.
 * @throws If `RunOptions.input` violates the entry node's declared fields — before any claim.
 */
export async function executePlan(
  store: PlanStore,
  planId: string,
  options: RunOptions
): Promise<RunProjection> {
  // 1. EVERYTHING THAT CAN REFUSE, BEFORE THE CLAIM.
  //
  // `claimRun` is irreversible by design — a plan admits one run, EVER, and there is no release
  // API to undo it. So every check that can reject a request has to happen first, or a rejected
  // request burns the plan's only run: a malformed `input` would leave the plan permanently
  // `run_already_claimed`, unrunnable for a request that never invoked a single tool, with
  // `clonePlan` the only recovery. Reading and validating first costs one extra `readOps` on the
  // refusal path and nothing on the success path, since the fold is reused below.
  const state = await store.readState(planId)
  const ops = await store.readOps(planId)
  const { view: plan } = foldOps(planId, ops)

  const entries = entryNodes(plan)
  const entryNode = entries[0]
  if (!entryNode) throw new Error(`plan "${planId}" has no entry node`)
  if (entryNode.kind !== 'entry') throw new Error(`plan "${planId}" entry node is malformed`)
  const entryDef = entryNode.definition

  // Validate external input before any side effect AND before the claim.
  validateInput(options.input, entryDef.input)

  // 2. CLAIM. The durable claim — not the optional lock — enforces one plan, one run, ever.
  const claim = await store.claimRun(planId, state.digest, options.resumeRunId)
  if (!claim.ok) {
    // A non-ok claim aborts the run and surfaces the reason, never proceeds. Every failure —
    // `not_executable`, `digest_mismatch`, `run_already_claimed`, `run_not_found`,
    // `run_already_settled` — is a hard refusal. Returning a projection for an existing run
    // would silently mask a `run_already_claimed` and let a second caller observe (or appear
    // to drive) a run that the durable claim exists to keep singular.
    throw new Error(`cannot run plan "${planId}": ${claim.reason}`)
  }

  const runId = claim.runId
  const deps = resolveDeps(options)

  const ctx: ExecutorContext = {
    store,
    planId,
    runId,
    plan,
    deps,
    options,
    entryId: entryNode.id,
    joins: new Map(),
    steps: 0,
  }

  const already = claim.resumed ? await store.readRunEvents(planId, runId) : []

  const entryKey = tableKey(entryNode.id, ENTRY_BRANCH)
  const entryOutput: NodeOutput = {
    items: [{ json: { ...options.input } }],
    branchId: ENTRY_BRANCH,
  }
  const entryFrame: RunFrame = {
    frame: {
      nodeId: entryNode.id,
      kind: 'entry',
      branchId: ENTRY_BRANCH,
      viaEdgeId: undefined,
    },
    outputs: new Map([[entryKey, entryOutput]]),
    artifacts: new Map(),
    ancestors: [],
  }

  // Seed the work queue: from the folded log on resume, from the entry frame on a fresh run.
  const queue: RunFrame[] = []
  const seenFrames = new Set<string>()
  if (claim.resumed) {
    const projection = foldRun(already)
    for (const pf of projection.frontier.frames) {
      queue.push({ frame: pf.frame, outputs: pf.outputs, artifacts: pf.artifacts, ancestors: [] })
    }
    for (const j of projection.frontier.joins) {
      ctx.joins.set(j.correlationKey, j)
    }
    ctx.steps = Math.max(0, countSettled(already))
    if (!frameSettled(already, entryFrame.frame)) {
      queue.unshift(entryFrame)
    }
  } else {
    // A fresh run begins with run_started — the fold's required first event.
    await store.appendRunEvents(planId, runId, [
      { kind: 'run_started', runId, digest: state.digest, at: now() },
    ])
    queue.push(entryFrame)
  }

  let aborted = false

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      await finish(ctx, { cause: { kind: 'turn_abort' }, outcome: 'aborted' })
      aborted = true
      break
    }
    const current = queue.shift()!
    const key = frameIdentity(current.frame)
    if (seenFrames.has(key)) continue
    seenFrames.add(key)

    // Budget exhaustion is reported as BUDGET EXHAUSTION, never as a cycle — freeze proves the
    // graph acyclic, so a plan can exhaust a budget through legitimate fan-out.
    //
    // The bound is the PLAN'S OWN `maxSteps`, not a module constant: bounds are plan content, so
    // they are digested and the operator approved them. `TOTAL_STEPS_BUDGET` remains the fallback
    // for a view with no bounds at all.
    const stepBudget = ctx.plan.bounds?.maxSteps ?? TOTAL_STEPS_BUDGET
    if (ctx.steps >= stepBudget) {
      // NOT `process_death`. The executor knows precisely why it stopped, and mislabelling it
      // sends an operator hunting a crash that never happened — while `foldRun` is explicit that
      // process death is never inferred, only recorded by whoever resumes.
      await finish(ctx, {
        cause: { kind: 'budget_exhausted', settled: ctx.steps },
        outcome: 'halted',
      })
      aborted = true
      break
    }
    ctx.steps++

    // 3a. BEFORE invoking: append `node_entered` durably and await the write.
    await store.appendRunEvents(planId, runId, [
      { kind: 'node_entered', frame: current.frame, at: now() },
    ])

    try {
      await executeNode(ctx, current)

      // A `join` whose barrier is still OPEN parks: it contributed its tables to the barrier and
      // produces no settlement, no edge and no successor. The arrival that closes the barrier
      // settles the join once, under the MERGED identity, so the successor is enqueued exactly
      // once however many routes converged.
      if (current.frame.kind === 'join') {
        if (!current.merged) {
          // Record the contribution durably (the barrier rides in `frontier_snapshot`) without
          // settling the frame — an unsettled entered frame is exactly "in flight", which is what
          // a parked arrival is.
          await appendJoinParked(ctx, queue)
          continue
        }
        // Re-key this frame to the merged identity before settling, so the settlement, the
        // outgoing edges and the successor's tables all speak the merged route.
        current.frame = current.merged.frame
        current.outputs = current.merged.outputs
        current.artifacts = current.merged.artifacts
      }

      // 3b. AFTER settling: settle + every edge_taken + snapshot as ONE atomic batch.
      const successors = fireSuccess(ctx, current)
      const nextRunFrames: FiredEdge[] = []
      for (const s of successors) {
        // Runtime cycle defence in depth: re-entering a node already on THIS frame's path is a
        // true cycle. A diamond fan-in is not, because its paths differ.
        if (current.ancestors.includes(s.to.frame.nodeId)) {
          throw new Error(`runtime cycle: re-entering node "${s.to.frame.nodeId}"`)
        }
        const withAncestors: RunFrame = {
          ...s.to,
          ancestors: [...current.ancestors, current.frame.nodeId],
        }
        nextRunFrames.push({ to: withAncestors, edge: s.edge })
        queue.push(withAncestors)
      }
      const settledOutcome: NodeOutcome = { status: 'ok', output: currentOutput(current) }
      await appendSettledBatch(ctx, current, settledOutcome, nextRunFrames, queue)
    } catch (err) {
      const error = isError(err)
        ? { name: err.name, message: err.message }
        : { name: 'Error', message: String(err) }
      const errorEdge = outgoing(plan, current.frame.nodeId).filter((e) => e.handle === 'error')
      if (errorEdge.length > 0) {
        // A HANDLED failure: record it, traverse error edges, and the run may still complete.
        const failedOutcome: NodeOutcome = { status: 'failed', handled: true, error }
        const successors = errorEdge.map((edge) => deriveTarget(ctx, current, edge))
        for (const s of successors) {
          const withAncestors: RunFrame = {
            ...s.to,
            ancestors: [...current.ancestors, current.frame.nodeId],
          }
          queue.push(withAncestors)
        }
        await appendSettledBatch(ctx, current, failedOutcome, successors, queue)
      } else {
        // No error edge: unhandled halt.
        const failedOutcome: NodeOutcome = { status: 'failed', handled: false, error }
        await store.appendRunEvents(planId, runId, [
          { kind: 'node_settled', frame: current.frame, outcome: failedOutcome, at: now() },
        ])
        await finish(ctx, {
          cause: { kind: 'node_failed', nodeId: current.frame.nodeId, handled: false },
          outcome: 'aborted',
        })
        aborted = true
        break
      }
    }
  }

  if (!aborted) {
    // A join no live frame can still satisfy halts rather than hangs.
    const unsatisfiable = [...ctx.joins.values()].find((j) => j.arrivals.length < j.required)
    if (unsatisfiable) {
      await finish(ctx, {
        cause: { kind: 'join_unsatisfiable', nodeId: unsatisfiable.nodeId },
        outcome: 'halted',
      })
    } else {
      await finish(ctx, { outcome: 'completed' })
    }
  }

  return foldRun(await store.readRunEvents(planId, runId))
}

/** Append the terminal run events (`run_interrupted` when a cause is supplied, then `run_settled`). */
async function finish(
  ctx: ExecutorContext,
  r: { outcome: 'completed' | 'halted' | 'aborted'; cause?: InterruptionCauseType }
): Promise<void> {
  const events: RunEvent[] = []
  if (r.cause !== undefined) {
    events.push({ kind: 'run_interrupted', cause: r.cause, at: now() })
  }
  events.push({ kind: 'run_settled', outcome: r.outcome, at: now() })
  await ctx.store.appendRunEvents(ctx.planId, ctx.runId, events)
}

type InterruptionCauseType = NonNullable<Extract<RunEvent, { kind: 'run_interrupted' }>['cause']>

/**
 * Append the `frontier_snapshot` for a join arrival that PARKED at an open barrier.
 *
 * @remarks
 * The arrival settles nothing — an entered-but-unsettled frame is exactly "in flight", which is
 * what a contributed-and-waiting arrival is. What must reach the log is the BARRIER, because the
 * contributing branch's outputs and artifacts were consumed into it and exist nowhere else in the
 * frontier; without this a resume from a half-satisfied join could not rebuild its successor's
 * dataflow context.
 *
 * @param ctx - The executor context holding the open barriers.
 * @param queue - The live work queue, for the frontier's pending frames.
 */
async function appendJoinParked(ctx: ExecutorContext, queue: RunFrame[]): Promise<void> {
  const frames: PendingFrame[] = queue.map((f) => ({
    frame: f.frame,
    outputs: f.outputs,
    artifacts: f.artifacts,
  }))
  await ctx.store.appendRunEvents(ctx.planId, ctx.runId, [
    { kind: 'frontier_snapshot', frames, joins: [...ctx.joins.values()], at: now() },
  ])
}

/** Append `node_settled` + every `edge_taken` + the new `frontier_snapshot` as one batch. */
async function appendSettledBatch(
  ctx: ExecutorContext,
  current: RunFrame,
  outcome: NodeOutcome,
  successors: FiredEdge[],
  queue: RunFrame[]
): Promise<void> {
  const events: RunEvent[] = [{ kind: 'node_settled', frame: current.frame, outcome, at: now() }]
  for (const s of successors) {
    events.push({
      kind: 'edge_taken',
      edgeId: s.edge.id,
      handle: s.edge.handle,
      from: current.frame,
      to: s.to.frame,
      outputs: s.to.outputs,
      artifacts: s.to.artifacts,
      at: now(),
    })
  }
  const frames: PendingFrame[] = queue.map((f) => ({
    frame: f.frame,
    outputs: f.outputs,
    artifacts: f.artifacts,
  }))
  const joins: JoinState[] = [...ctx.joins.values()]
  events.push({ kind: 'frontier_snapshot', frames, joins, at: now() })
  await ctx.store.appendRunEvents(ctx.planId, ctx.runId, events)
}

/** Count node settlements present in an existing log (a resume's step budget start). */
function countSettled(events: RunEvent[]): number {
  let n = 0
  for (const e of events) if (e.kind === 'node_settled') n++
  return n
}

/** Whether the log already contains a settlement for the given frame. */
function frameSettled(events: RunEvent[], frame: FrameRef): boolean {
  const key = frameIdentity(frame)
  return events.some((e) => e.kind === 'node_settled' && frameIdentity(e.frame) === key)
}

/** Stable identity of a frame across the walk (node + route). */
function frameIdentity(frame: FrameRef): string {
  return tableKey(frame.nodeId, frame.branchId)
}

/** The settled `NodeOutput` a frame carries after a successful execution. */
function currentOutput(current: RunFrame): NodeOutput {
  return (
    current.outputs.get(tableKey(current.frame.nodeId, current.frame.branchId)) ?? {
      items: [],
      branchId: current.frame.branchId,
    }
  )
}

/** Resolve per-run deps, supplying a safe default for anything missing. */
function resolveDeps(options: RunOptions): ResolvedDeps {
  const invokeCall: CallInvokerFn =
    options.invokeCall ?? (() => Promise.reject(new Error('no invokeCall provided')))
  const reason: ReasonerFn =
    options.reason ?? (() => Promise.reject(new Error('no reason provided')))
  return { invokeCall, reason, evaluators: options.evaluators ?? [] }
}

/** Validate external input against the entry node's declared fields. */
function validateInput(
  input: Record<string, EncodableValue>,
  fields: readonly DeclaredField[]
): void {
  for (const field of fields) {
    if (!(field.path in input)) {
      throw new Error(`input is missing required declared field "${field.path}" for the entry node`)
    }
  }
}

/** Look up the plan's evaluator cell by id. */
function evaluatorById(deps: ResolvedDeps, id: string): PredicateEvaluator | undefined {
  return deps.evaluators.find((e) => e.id === id)
}

/** Execute a single node according to its kind, mutating the frame's tables. */
async function executeNode(ctx: ExecutorContext, current: RunFrame): Promise<void> {
  const node = nodeById(ctx.plan, current.frame.nodeId)
  if (!node) throw new Error(`unknown node "${current.frame.nodeId}"`)
  const def = node.definition

  switch (current.frame.kind) {
    case 'entry':
      // External input is already materialised as the entry frame's output; nothing to run.
      return
    case 'call': {
      const args: Record<string, EncodableValue> = {}
      for (const [k, v] of Object.entries((def as CallDef).args)) {
        args[k] = resolveArg(current, v) as EncodableValue
      }
      const result = await ctx.deps.invokeCall({
        tool: (def as CallDef).tool,
        args,
        signal: ctx.options.signal,
      })
      settleCallResult(current, result, (def as CallDef).output)
      return
    }
    case 'reason': {
      const rdef = def as ReasonDef
      const prompt = joinPromptParts(rdef.prompt as { text: string }[], (ref) => {
        const v = resolveRef(current, ref)
        return v === undefined ? undefined : (v as EncodableValue)
      })
      const captured = await ctx.deps.reason({
        prompt: String(prompt),
        outputSchema: decodeOutputSchema(rdef.outputSchema),
        maxAttempts: rdef.maxAttempts,
        signal: ctx.options.signal,
      })
      setOutput(current, { items: [{ json: captured }] })
      return
    }
    case 'transform': {
      const tdef = def as TransformDef
      const sourceArtifact = resolveArtifact(current, tdef.source)
      if (!sourceArtifact) {
        throw new Error(`transform source "${tdef.source.node}" has no artifact in this branch`)
      }
      const methods = effectiveToolMethods(sourceArtifact.constructor)
      let value: unknown = sourceArtifact
      for (const step of tdef.steps) {
        const desc = methods.find((m) => m.name === step.name)
        if (!desc) throw new Error(`unknown transform step "${step.name}" for artifact`)
        const method = (value as Record<string, unknown>)[desc.method]
        if (typeof method !== 'function') {
          throw new Error(`artifact method "${desc.method}" is missing`)
        }
        value = await (method as (...a: unknown[]) => unknown).apply(
          value,
          step.args ? Object.values(step.args) : []
        )
      }
      const items: OutputItem[] = []
      if (tdef.emit.as === 'rows') {
        if (!Array.isArray(value)) throw new Error(`transform emit 'rows' requires an array result`)
        for (const row of value) {
          items.push({
            json: isObject(row)
              ? (row as Record<string, EncodableValue>)
              : { value: row as EncodableValue },
          })
        }
      } else {
        const out = typeof value === 'string' ? value : defaultSerialise(value)
        items.push({ json: { [tdef.emit.field]: out } })
      }
      setOutput(current, { items })
      return
    }
    case 'branch':
    case 'select': {
      const sdef = def as BranchDef | SelectDef
      const cell = evaluatorById(ctx.deps, sdef.evaluator)
      if (!cell) throw new Error(`no evaluator cell "${sdef.evaluator}" is registered`)
      const verdict = await cell.evaluate(node, {
        outputs: current.outputs,
        frame: current.frame,
      })
      current.verdict = verdict
      return
    }
    case 'join':
      joinBarrier(ctx, current)
      return
  }
}

interface CallDef {
  tool: string
  args: Record<string, ArgValue>
  output: DeclaredField[]
}
interface ReasonDef {
  prompt: ({ text: string } | NodeRef)[]
  outputSchema: string
  maxAttempts: number
}
interface TransformDef {
  source: NodeRef
  steps: { name: string; args?: Record<string, EncodableValue> }[]
  emit: { as: 'value'; field: string } | { as: 'rows' }
}
interface BranchDef {
  evaluator: string
}
interface SelectDef {
  evaluator: string
}

/** Write a frame's branch-local output under its canonical key. */
function setOutput(
  current: RunFrame,
  item: { items?: OutputItem[]; json?: Record<string, EncodableValue> }
): void {
  const key = tableKey(current.frame.nodeId, current.frame.branchId)
  const items =
    item.items ?? (item.json !== undefined ? [{ json: item.json }] : ([] as OutputItem[]))
  const outputs = new Map<string, NodeOutput>(current.outputs)
  outputs.set(key, { items, branchId: current.frame.branchId })
  current.outputs = outputs
}

/** Store a call's result respecting the ToolResult narrowing rules. */
function settleCallResult(
  current: RunFrame,
  result: unknown,
  fields: readonly DeclaredField[]
): void {
  const key = tableKey(current.frame.nodeId, current.frame.branchId)
  if (typeof result === 'string') {
    const field = fields[0]?.path ?? 'value'
    const outputs = new Map<string, NodeOutput>(current.outputs)
    outputs.set(key, {
      items: [{ json: { [field]: result } }],
      branchId: current.frame.branchId,
    })
    current.outputs = outputs
    return
  }
  // A SpooledArtifactLike goes into the ArtifactTable under the same key AND settles with
  // whatever its declared `output` describes. Bytes/media were refused at freeze here.
  const instance = instanceOfArtifact(result)
  if (instance) {
    const artifacts = new Map<string, SpooledArtifactLike>(current.artifacts)
    artifacts.set(key, instance)
    current.artifacts = artifacts
    const json: Record<string, EncodableValue> = {}
    for (const f of fields) {
      const v = readPath(instance, f.path)
      json[f.path] = (v !== undefined ? v : defaultSerialise(instance)) as EncodableValue
    }
    const outputs = new Map<string, NodeOutput>(current.outputs)
    outputs.set(key, { items: [{ json }], branchId: current.frame.branchId })
    current.outputs = outputs
    return
  }
  throw new Error(`node "${current.frame.nodeId}" returned an unsupported result shape`)
}

/** Structural `SpooledArtifactLike` guard. */
function instanceOfArtifact(v: unknown): SpooledArtifactLike | undefined {
  if (isInstanceOf<SpooledArtifactLike>(v, 'SpooledArtifactLike')) return v
  if (isObject(v) && typeof v.constructor === 'function') {
    return v as SpooledArtifactLike
  }
  return undefined
}

/**
 * Resolve a `NodeRef` against the frame's branch-local `ArtifactTable`.
 *
 * @remarks
 * This mirrors {@link resolveRef}'s lookup EXACTLY, and must: the two tables are keyed
 * identically (`${nodeId}:${branchKey(branchId)}`) and `NodeRef.branchId` means the same thing
 * for both — WHICH EXECUTION of the node to read. An omitted `branchId` means "do not filter",
 * which is legal precisely when one path reaches the node, and freeze refuses it when more than
 * one does. So the omitted case must scan by node id rather than assume a route.
 *
 * Assuming the ENTRY route instead is wrong for every node except the entry node itself: a `call`
 * one edge in already carries `{segments:[{edge:'e0'}]}`, so its artifact is stored under that
 * key and an entry-keyed lookup misses it. That was a real defect — a linear
 * `entry → call → transform` plan froze clean and then failed at run time with "no artifact in
 * this branch", which is why the lookup lives in one function shared with the value path.
 *
 * @param frame - The live frame whose branch-local table is being read.
 * @param ref - The reference naming the producing node, and optionally which execution of it.
 * @returns The artifact instance, or `undefined` when the frame's table holds none for it.
 */
function resolveArtifact(frame: RunFrame, ref: NodeRef): SpooledArtifactLike | undefined {
  if (ref.branchId) return frame.artifacts.get(tableKey(ref.node, ref.branchId))
  for (const [k, artifact] of frame.artifacts) {
    if (k.startsWith(`${ref.node}:`)) return artifact
  }
  return undefined
}

/** Resolve a `NodeRef` against a frame's branch-local tables. */
function resolveRef(frame: RunFrame, ref: NodeRef): unknown {
  let output: NodeOutput | undefined
  if (ref.branchId) {
    output = frame.outputs.get(tableKey(ref.node, ref.branchId))
  } else {
    for (const [k, o] of frame.outputs) {
      if (k.startsWith(`${ref.node}:`)) {
        output = o
        break
      }
    }
  }
  if (!output) return undefined
  const items = output.items
  let base: unknown
  if (ref.select === 'first') base = items[0]?.json
  else if (ref.select === 'last') base = items[items.length - 1]?.json
  else if (ref.select === 'all') base = items.map((i) => i.json)
  else base = items[ref.select.index as number]?.json
  if (base === undefined) return undefined
  return ref.path ? readPath(base, ref.path) : base
}

/** Resolve an `ArgValue` (which may contain `NodeRef`s) to a plain encodable. */
function resolveArg(frame: RunFrame, value: ArgValue): unknown {
  if (NodeRefClass.isNodeRef(value)) return resolveRef(frame, value)
  if (Array.isArray(value)) return value.map((v) => resolveArg(frame, v as ArgValue))
  if (isInstanceOf<SpooledArtifactLike>(value, 'SpooledArtifactLike')) return value
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value)) {
      out[k] = resolveArg(frame, value[k] as ArgValue)
    }
    return out
  }
  return value
}

/**
 * Barrier bookkeeping for a `join` node.
 *
 * @remarks
 * A join is a BARRIER, so the arrival that does not complete it must not settle the node: it
 * records itself and parks. Only the completing arrival produces a merged frame. `RunFrame.merged`
 * carries that decision back to the walk loop, which is where edge firing lives — a join whose
 * barrier is open fires nothing, and its successor is enqueued exactly once, by the arrival that
 * closed it.
 *
 * Late arrivals cannot occur, which is what makes this total: `required` is the join's in-degree,
 * and the diamond restriction makes that equal the number of fork→join routes, so the barrier
 * fires when every route has arrived and never before. There is no fired-barrier state to keep and
 * no second firing to guard against.
 *
 * A repeat of the same `(branchKey, edgeId)` pair is idempotent — a resumed run re-entering a
 * frame it already contributed must not count twice, or a two-route barrier would fire on one
 * branch arriving twice.
 *
 * @param ctx - The executor context holding the open barriers.
 * @param current - The arriving frame.
 */
function joinBarrier(ctx: ExecutorContext, current: RunFrame): void {
  const joinId = current.frame.nodeId
  const fork = immediateDominator(ctx.plan, ctx.entryId, joinId) ?? ctx.entryId
  const key = correlationKey(ctx, current.frame.branchId, joinId, fork)
  const incomingEdges = incoming(ctx.plan, joinId)
  const required = incomingEdges.length

  const state: JoinState = ctx.joins.get(key) ?? {
    nodeId: joinId,
    correlationKey: key,
    arrivals: [],
    required,
  }
  const arrival: JoinState['arrivals'][number] = {
    branch: current.frame.branchId,
    edgeId: current.frame.viaEdgeId ?? '',
    outputs: current.outputs,
    artifacts: current.artifacts,
  }
  if (
    !state.arrivals.some(
      (a) => a.edgeId === arrival.edgeId && branchKey(a.branch) === branchKey(arrival.branch)
    )
  ) {
    state.arrivals.push(arrival)
  }
  ctx.joins.set(key, state)

  if (state.arrivals.length < state.required) {
    // The barrier is still open. This frame contributes and parks: no output, no edges, no
    // successor. It stays in `ctx.joins`, so a `frontier_snapshot` persists it and a resume
    // restores it.
    current.merged = undefined
    return
  }

  ctx.joins.delete(key)

  // ── the merged identity ────────────────────────────────────────────────────
  // The correlation prefix is RETAINED and the join segment appended. A bare join segment is a
  // graph constant, so two executions of one fork would render identically and collide; and the
  // segment EXTENDS the route rather than replacing it, or two nodes reached by different
  // post-join paths would collide in turn. `of` is the sorted list of ALL incoming edge ids — a
  // graph constant, independent of which predicates fired, which is what makes a downstream
  // `NodeRef` to a post-join node authorable at freeze.
  const prefix = truncateAtFork(ctx, current.frame.branchId, fork)
  const mergedBranch: BranchId = {
    segments: [
      ...prefix,
      { join: joinId, of: incomingEdges.map((e) => e.id).sort((a, b) => (a < b ? -1 : 1)) },
    ],
  }

  // ── the merged tables ──────────────────────────────────────────────────────
  // The union of the arrivals' tables. Keys are `${nodeId}:${branchKey}`, path-unique, so the
  // union cannot collide and needs no merge policy — which is what lets a downstream `NodeRef`
  // resolve against an output produced on EITHER contributing branch.
  const outputs = new Map<string, NodeOutput>()
  const artifacts = new Map<string, SpooledArtifactLike>()
  for (const a of state.arrivals) {
    for (const [k, v] of a.outputs) outputs.set(k, v)
    for (const [k, v] of a.artifacts) artifacts.set(k, v)
  }

  // ── the join's own output: provenance, and only provenance ─────────────────
  // A join contributes no data of its own; it is a barrier. Its items say WHICH ROUTES converged,
  // which is the only thing it actually knows, and is readable by a downstream predicate. The
  // contributing nodes' real outputs are reached by referencing those nodes directly, which the
  // unioned table above makes possible. Sorted by `via` then `branch` for a total order.
  const items: OutputItem[] = state.arrivals
    .map((a) => ({
      json: {
        via: a.edgeId,
        from: sourceOfEdge(ctx, a.edgeId) ?? '',
        branch: branchKey(a.branch),
      } as Record<string, EncodableValue>,
    }))
    .sort((x, y) => {
      const viaX = String(x.json.via)
      const viaY = String(y.json.via)
      if (viaX !== viaY) return viaX < viaY ? -1 : 1
      return String(x.json.branch) < String(y.json.branch) ? -1 : 1
    })

  outputs.set(tableKey(joinId, mergedBranch), { items, branchId: mergedBranch })

  current.merged = {
    frame: {
      nodeId: joinId,
      kind: 'join',
      branchId: mergedBranch,
      viaEdgeId: current.frame.viaEdgeId,
    },
    outputs,
    artifacts,
  }
}

/** The source node of an edge id, for a join item's `from` provenance. */
function sourceOfEdge(ctx: ExecutorContext, edgeId: string): string | undefined {
  return ctx.plan.edges.find((e) => e.id === edgeId)?.from
}

/**
 * The arriving route truncated at the divergence fork — the barrier's shared prefix.
 *
 * @remarks
 * Every sibling route passes through the fork, so truncating there yields a prefix every arrival
 * to this join shares, while two executions of the fork reached by different outer routes keep
 * different prefixes and so keep separate barriers. The truncation point is the segment whose
 * edge ENTERS the fork; segments before and including it are kept.
 *
 * @param ctx - The executor context, for walking edges.
 * @param branch - The arriving route.
 * @param fork - The join's immediate dominator.
 * @returns The retained prefix segments.
 */
function truncateAtFork(ctx: ExecutorContext, branch: BranchId, fork: string): RouteSegment[] {
  const prefix: RouteSegment[] = []
  let current = ctx.entryId
  for (const seg of branch.segments) {
    if (!('edge' in seg)) {
      // An EARLIER join on this route. Keep the segment whole and advance the walk to that join
      // node — the route continues from there, so failing to advance leaves `current` stale and
      // the fork is never recognised, which splits what should be one barrier into two that can
      // never close. (Found exactly that way: a diamond downstream of another diamond halted
      // `join_unsatisfiable` with two barriers each holding one arrival.)
      prefix.push(seg)
      current = seg.join
      if (current === fork) break
      continue
    }
    prefix.push({ edge: seg.edge })
    const edge = outgoing(ctx.plan, current).find((e) => e.id === seg.edge)
    current = edge ? edge.to : current
    if (current === fork) break
  }
  return prefix
}

/**
 * The arriving route truncated at the statically-known fork, rendered through the injective
 * `branchKey`, and namespaced by the join id.
 *
 * @param ctx - The executor context, for walking edges.
 * @param branch - The arriving route.
 * @param joinId - The join whose barrier is being keyed.
 * @param fork - The join's immediate dominator.
 * @returns The barrier's correlation key.
 */
function correlationKey(
  ctx: ExecutorContext,
  branch: BranchId,
  joinId: string,
  fork: string
): string {
  return `${joinId}@${branchKey({ segments: truncateAtFork(ctx, branch, fork) })}`
}

/** Which success-path edges fire for a settled node. */
function fireSuccess(ctx: ExecutorContext, current: RunFrame): FiredEdge[] {
  const kind = current.frame.kind
  const edges = outgoing(ctx.plan, current.frame.nodeId)
  const result: FiredEdge[] = []
  // `default` fires only when no match/case handled.
  let anyMatchFired = false

  for (const edge of edges) {
    if (edge.handle === 'error') continue
    if (edge.handle === 'default') continue
    const fires = firesOnSuccess(kind, edge.handle, current)
    if (fires) {
      anyMatchFired = true
      result.push(deriveTarget(ctx, current, edge))
    }
  }
  if (!anyMatchFired) {
    for (const edge of edges) {
      if (edge.handle === 'default') {
        result.push(deriveTarget(ctx, current, edge))
      }
    }
  }
  return result
}

/** Whether a non-error, non-default handle fires for the given success verdict. */
function firesOnSuccess(kind: PlanNodeKind, handle: EdgeHandle, current: RunFrame): boolean {
  // entry/call/reason/transform/join: only a success-path `always` fires.
  if (kind !== 'branch' && kind !== 'select') {
    return handle === 'always' && handleAppliesTo(kind, handle)
  }
  const v = current.verdict
  if (!v) return false
  if (kind === 'branch') {
    if (v.kind !== 'branch') return false
    if (handle === 'match') return v.matched
    if (handle === 'no_match') return !v.matched
    return false
  }
  if (v.kind !== 'select') return false
  if (handle.startsWith('case_')) return v.caseLabel === handle.slice('case_'.length)
  return false
}

/** Derive the successor frame for a fired edge, cloning branch-local tables. */
function deriveTarget(ctx: ExecutorContext, current: RunFrame, edge: PlanEdge): FiredEdge {
  const targetNode = nodeById(ctx.plan, edge.to)
  const branchId: BranchId = { segments: [...current.frame.branchId.segments, { edge: edge.id }] }
  const to: RunFrame = {
    frame: {
      nodeId: edge.to,
      kind: targetNode?.kind ?? 'call',
      branchId,
      viaEdgeId: edge.id,
    },
    outputs: new Map(current.outputs),
    artifacts: new Map(current.artifacts),
    verdict: undefined,
    ancestors: [],
  }
  return { to, edge }
}

/** Serialise an unknown value for a `value`-emitting transform field. */
function defaultSerialise(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return '(undefined)'
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? '(empty list)' : v.join('\n')
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
