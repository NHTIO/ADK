/**
 * @module @nhtio/adk/batteries/orchestration/in_memory
 */

import { foldOps } from './ops'
import type {
  PlanStore,
  CreateResult,
  AppendResult,
  TransitionRequest,
  TransitionResult,
  ClaimRunResult,
} from './store'
import type {
  PlanOp,
  PlanState,
  PlanSummary,
  PlanProvenance,
  InstantiatedFrom,
  ApprovalRecord,
  RunEvent,
} from './types'

/**
 * A plan held entirely in memory.
 *
 * The op log is the single source of truth for content: revision and digest are always derived
 * from it by folding, never stored alongside it, so they cannot drift from what the log actually
 * contains. Lifecycle state, approval, provenance and the run are the parts that are not `PlanOp`s
 * and therefore cannot be folded, so they live here as first-class fields.
 */
interface PlanRecord {
  /** The ordered authoring log. */
  ops: PlanOp[]
  /** The lifecycle state of the plan. */
  state: PlanState
  /** The approval record, present only once the plan has been approved. */
  approval?: ApprovalRecord
  /** Provenance, present only for plans that were cloned or instantiated. */
  provenance?: PlanProvenance
  /** A human label for the plan. */
  label?: string
  /** The last time the plan was touched, as an ISO timestamp. */
  updatedAt: string
  /** The run bound to this plan, if one has ever been claimed. */
  run?: {
    runId: string
    events: RunEvent[]
    settled: boolean
  }
}

/**
 * The reference in-memory implementation of the {@link PlanStore} contract.
 *
 * Every operation is asynchronous and returns a structured result rather than throwing for the
 * expected, precondition-style failures the contract names — so a caller can branch on the
 * outcome without exception handling. Lifecycle transitions and run claiming are atomic with
 * respect to the single-threaded event loop: a plan is mutated only through these methods, so no
 * interleaving can observe a half-applied change.
 *
 * The store commits; it does not validate. Deciding whether a plan is well-formed, whether an
 * evaluator is wired, or whether a tool is on the allowlist is battery knowledge this class has
 * no access to, so those checks live upstream and this class only records the outcome.
 */
export class InMemoryPlanStore implements PlanStore {
  readonly #plans = new Map<string, PlanRecord>()

  /**
   * Mint a new plan in the `editable` state at revision 0.
   *
   * The op log is genuinely empty: revision 0 is the fold seed, not an implied op, so `readOps`
   * returns `[]` and the first authoring op produces revision 1. Instantiation lineage is
   * persisted when supplied.
   *
   * @param planId - The id of the new plan.
   * @param meta - Optional label and instantiation lineage to attach.
   * @returns A success result carrying the new plan's revision and digest, or `duplicate_id` if
   *   the id is already taken.
   */
  async createPlan(
    planId: string,
    meta?: { label?: string; provenance?: InstantiatedFrom }
  ): Promise<CreateResult> {
    if (this.#plans.has(planId)) {
      return { ok: false, reason: 'duplicate_id' }
    }
    const provenance: PlanProvenance | undefined = meta?.provenance
      ? { kind: 'template', ...meta.provenance }
      : undefined
    this.#plans.set(planId, {
      ops: [],
      state: 'editable',
      label: meta?.label,
      provenance,
      updatedAt: new Date().toISOString(),
    })
    return {
      ok: true,
      planId,
      revision: 0,
      digest: foldOps(planId, []).view.digest,
    }
  }

  /**
   * Clone an existing plan into a new id, seeded with the source's folded state at a given
   * revision.
   *
   * The clone is minted in `editable` and inherits no approval and no run — it is cold by
   * construction. Its provenance records the parent, the parent's digest, the parent's revision,
   * and the node ids that had settled `ok` when the clone was taken (or `[]` if the source never
   * ran). The operation is atomic: either the clone exists complete or not at all.
   *
   * @param sourcePlanId - The plan to clone from.
   * @param newPlanId - The id for the new plan.
   * @param atRevision - The source revision to clone at; defaults to the source's current
   *   revision.
   * @returns A success result carrying the clone's revision and digest, or `source_missing` /
   *   `revision_missing` / `duplicate_id`.
   */
  async clonePlan(
    sourcePlanId: string,
    newPlanId: string,
    atRevision?: number
  ): Promise<CreateResult> {
    const source = this.#plans.get(sourcePlanId)
    if (!source) {
      return { ok: false, reason: 'source_missing' }
    }
    if (this.#plans.has(newPlanId)) {
      return { ok: false, reason: 'duplicate_id' }
    }
    const targetRevision = atRevision ?? source.ops.length
    if (targetRevision < 0 || targetRevision > source.ops.length) {
      return { ok: false, reason: 'revision_missing' }
    }
    const prefix = source.ops.slice(0, targetRevision)
    const completedAtClone: string[] = []
    if (source.run) {
      for (const event of source.run.events) {
        if (event.kind === 'node_settled' && event.outcome.status === 'ok') {
          completedAtClone.push(event.frame.nodeId)
        }
      }
    }
    const provenance: PlanProvenance = {
      kind: 'clone',
      parent: sourcePlanId,
      parentDigest: foldOps(sourcePlanId, prefix).view.digest,
      parentRevision: targetRevision,
      completedAtClone,
    }
    this.#plans.set(newPlanId, {
      ops: prefix,
      state: 'editable',
      provenance,
      label: source.label,
      updatedAt: new Date().toISOString(),
    })
    return {
      ok: true,
      planId: newPlanId,
      revision: targetRevision,
      digest: foldOps(newPlanId, prefix).view.digest,
    }
  }

  /**
   * Append ops to a plan's log.
   *
   * The plan must be `editable`; this is checked in the same operation as the append, which is
   * what keeps `reviewable` and `executable` plans frozen at the only boundary that can enforce
   * it. Without the check, ops could change a frozen plan's content and digest while its stored
   * state stayed frozen, and an executable plan's approval would remain bound to a prior digest —
   * a plan executable with content nobody approved.
   *
   * @param planId - The plan to append to.
   * @param ops - The ops to append.
   * @param expectedRevision - If given, the log must still be at this revision (optimistic
   *   concurrency for a single author); omit it for the multi-writer CRDT case.
   * @returns A success result carrying the new revision and digest, or `not_editable` /
   *   `revision_moved` with the actual state.
   */
  async appendOps(planId: string, ops: PlanOp[], expectedRevision?: number): Promise<AppendResult> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`appendOps: no plan "${planId}"`)
    }
    if (record.state !== 'editable') {
      return {
        ok: false,
        reason: 'not_editable',
        actual: { state: record.state, revision: record.ops.length },
      }
    }
    if (expectedRevision !== undefined && record.ops.length !== expectedRevision) {
      return {
        ok: false,
        reason: 'revision_moved',
        actual: { state: record.state, revision: record.ops.length },
      }
    }
    record.ops.push(...ops)
    record.updatedAt = new Date().toISOString()
    return {
      ok: true,
      revision: record.ops.length,
      digest: foldOps(planId, record.ops, record.provenance).view.digest,
    }
  }

  /**
   * Read the ops of a plan's log.
   *
   * `sinceLamport` filters by clock; `throughRevision` bounds the result to a revision prefix
   * (the first N ops in sorted order), which is what a historical view needs. A revision the log
   * never reached is rejected rather than silently returning everything.
   *
   * @param planId - The plan to read from.
   * @param opts - Optional filtering options.
   * @returns The matching ops.
   */
  async readOps(
    planId: string,
    opts?: { sinceLamport?: number; throughRevision?: number }
  ): Promise<PlanOp[]> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`readOps: no plan "${planId}"`)
    }
    if (opts?.throughRevision !== undefined) {
      if (opts.throughRevision < 0 || opts.throughRevision > record.ops.length) {
        throw new Error(`readOps: plan "${planId}" never reached revision ${opts.throughRevision}`)
      }
    }
    let ops = record.ops
    if (opts?.throughRevision !== undefined) {
      ops = ops.slice(0, opts.throughRevision)
    }
    if (opts?.sinceLamport !== undefined) {
      ops = ops.filter((op) => op.lamport > (opts.sinceLamport as number))
    }
    return ops
  }

  /**
   * Read the provenance of a plan.
   *
   * @param planId - The plan to read from.
   * @returns The provenance, or `undefined` for a plan that is not a clone or was not
   *   instantiated.
   */
  async readProvenance(planId: string): Promise<PlanProvenance | undefined> {
    return this.#plans.get(planId)?.provenance
  }

  /**
   * Read the current lifecycle state, digest, and revision of a plan.
   *
   * @param planId - The plan to read from.
   * @returns The state, digest, and revision.
   */
  async readState(planId: string): Promise<{ state: PlanState; digest: string; revision: number }> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`readState: no plan "${planId}"`)
    }
    return {
      state: record.state,
      digest: foldOps(planId, record.ops, record.provenance).view.digest,
      revision: record.ops.length,
    }
  }

  /**
   * Read the approval record bound to a plan's current digest.
   *
   * @param planId - The plan to read from.
   * @returns The approval, or `undefined` if the plan has not been approved.
   */
  async readApproval(planId: string): Promise<ApprovalRecord | undefined> {
    return this.#plans.get(planId)?.approval
  }

  /**
   * List plans, optionally filtered by lifecycle state.
   *
   * @param filter - Optional state filter.
   * @returns A summary of each matching plan.
   */
  async list(filter?: { state?: PlanState }): Promise<PlanSummary[]> {
    const summaries: PlanSummary[] = []
    for (const [planId, record] of this.#plans) {
      if (filter?.state && record.state !== filter.state) {
        continue
      }
      const folded = foldOps(planId, record.ops, record.provenance).view
      summaries.push({
        planId,
        state: record.state,
        digest: folded.digest,
        revision: record.ops.length,
        nodeCount: folded.nodes.length,
        label: record.label,
        provenance: record.provenance,
        updatedAt: record.updatedAt,
      })
    }
    return summaries
  }

  /**
   * Perform the single atomic lifecycle transition.
   *
   * The plan must be in the state `t.from` implies and at `t.expectedDigest`; the pair must be a
   * legal transition. For `reviewable` → `executable`, the approval is persisted in the same
   * operation. No policy is evaluated here — the battery validates, the store commits.
   *
   * @param planId - The plan to transition.
   * @param t - The transition request.
   * @returns A success result carrying the new revision, or `state_mismatch` / `digest_mismatch`
   *   with the actual state and digest, or `illegal_transition` for a request the type system did
   *   not police.
   */
  async transition(planId: string, t: TransitionRequest): Promise<TransitionResult> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`transition: no plan "${planId}"`)
    }
    const folded = foldOps(planId, record.ops, record.provenance).view
    if (record.state !== t.from) {
      return {
        ok: false,
        reason: 'state_mismatch',
        actual: { state: record.state, digest: folded.digest },
      }
    }
    if (folded.digest !== t.expectedDigest) {
      return {
        ok: false,
        reason: 'digest_mismatch',
        actual: { state: record.state, digest: folded.digest },
      }
    }
    if (!isLegalTransition(t.from, t.to)) {
      return { ok: false, reason: 'illegal_transition', from: t.from, to: t.to }
    }
    record.state = t.to
    if (t.from === 'reviewable' && t.to === 'executable') {
      record.approval = t.approval
    }
    record.updatedAt = new Date().toISOString()
    return { ok: true, revision: record.ops.length }
  }

  /**
   * Claim a run for a plan.
   *
   * The plan must be `executable` at `expectedDigest`. Without a resume id, a run is started only
   * if none was ever claimed; with a resume id, that specific run is re-entered only if it exists
   * and is not settled. This is what enforces one plan, at most one run, ever.
   *
   * @param planId - The plan to run.
   * @param expectedDigest - The digest the plan must be at.
   * @param resumeRunId - Optional id of a run to resume.
   * @returns A success result carrying the run id and whether it was resumed, or a structured
   *   failure.
   */
  async claimRun(
    planId: string,
    expectedDigest: string,
    resumeRunId?: string
  ): Promise<ClaimRunResult> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`claimRun: no plan "${planId}"`)
    }
    const folded = foldOps(planId, record.ops, record.provenance).view
    if (record.state !== 'executable') {
      return { ok: false, reason: 'not_executable' }
    }
    if (folded.digest !== expectedDigest) {
      return { ok: false, reason: 'digest_mismatch' }
    }
    if (resumeRunId === undefined) {
      if (record.run) {
        return { ok: false, reason: 'run_already_claimed', existingRunId: record.run.runId }
      }
      const runId = crypto.randomUUID()
      record.run = { runId, events: [], settled: false }
      record.updatedAt = new Date().toISOString()
      return { ok: true, runId, resumed: false }
    }
    if (!record.run || record.run.runId !== resumeRunId) {
      return { ok: false, reason: 'run_not_found' }
    }
    if (record.run.settled) {
      return { ok: false, reason: 'run_already_settled' }
    }
    record.updatedAt = new Date().toISOString()
    return { ok: true, runId: resumeRunId, resumed: true }
  }

  /**
   * Append a batch of run events atomically.
   *
   * The whole array is committed as one batch, so the commit protocol can land `node_settled`,
   * every `edge_taken`, and the new `frontier_snapshot` in a single commit.
   *
   * A run is marked TERMINALLY settled only by `run_settled{outcome: 'completed'}`. `aborted` and
   * `halted` are STOPPING POINTS, not endings: the interruption taxonomy classifies a turn abort
   * as resumable with the frontier intact and the same digest, and a halted run is resumable once
   * whatever halted it is addressed. Marking those terminal made `claimRun(resumeRunId)` answer
   * `run_already_settled` and `resumeRunId` unusable for the exact cases it exists to serve.
   *
   * A run that later resumes and completes is settled then, which is the point at which no
   * further work can follow.
   *
   * @param planId - The plan the run belongs to.
   * @param runId - The run to append to.
   * @param events - The events to append.
   */
  async appendRunEvents(planId: string, runId: string, events: RunEvent[]): Promise<void> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`appendRunEvents: no plan "${planId}"`)
    }
    if (!record.run || record.run.runId !== runId) {
      throw new Error(`appendRunEvents: no run "${runId}" on plan "${planId}"`)
    }
    record.run.events.push(...events)
    if (events.some((e) => e.kind === 'run_settled' && e.outcome === 'completed')) {
      record.run.settled = true
    }
    record.updatedAt = new Date().toISOString()
  }

  /**
   * Read the events of a run.
   *
   * @param planId - The plan the run belongs to.
   * @param runId - The run to read; omitted reads the plan's only run.
   * @returns The events.
   */
  async readRunEvents(planId: string, runId?: string): Promise<RunEvent[]> {
    const record = this.#plans.get(planId)
    if (!record) {
      throw new Error(`readRunEvents: no plan "${planId}"`)
    }
    if (!record.run) {
      throw new Error(`readRunEvents: no run on plan "${planId}"`)
    }
    if (runId !== undefined && record.run.runId !== runId) {
      throw new Error(`readRunEvents: no run "${runId}" on plan "${planId}"`)
    }
    return record.run.events
  }
}

/**
 * Whether a lifecycle transition is legal.
 *
 * @param from - The current state.
 * @param to - The requested state.
 * @returns True if the pair is a legal transition.
 */
function isLegalTransition(from: PlanState, to: PlanState): boolean {
  switch (from) {
    case 'editable':
      return to === 'reviewable'
    case 'reviewable':
      return to === 'executable' || to === 'editable'
    case 'executable':
      return to === 'reviewable'
    default:
      return false
  }
}
