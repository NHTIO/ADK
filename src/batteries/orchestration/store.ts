import type {
  ApprovalRecord,
  InstantiatedFrom,
  PlanOp,
  PlanProvenance,
  PlanState,
  PlanSummary,
  RunEvent,
} from './types'

/**
 * The one contract for plans and runs — not a second store. **Every method is async**; nothing
 * here is sync-or-async. A durable plan store is I/O by nature, the lifecycle transition is
 * inherently a round-trip, and the cell seam is async too, so a uniform `Promise` surface is one
 * less thing for eleven work packages to get inconsistently right.
 *
 * The store commits; it does not validate. Deciding "is an evaluator wired", "is this tool on the
 * tier-C allowlist", or "does this reference taint a call arg" requires battery knowledge a BYO
 * store has no access to, and putting it here would force every store implementor to reimplement
 * the validator. So the split is: **the battery validates, the store commits.**
 */
export interface PlanStore {
  /**
   * Mint a new plan in `editable` at **revision 0 with a genuinely EMPTY op log**. Rejects a
   * duplicate id.
   *
   * Bounds are **genesis content, not an op**: the fold starts from `DEFAULT_PLAN_BOUNDS` and
   * `set_bounds` ops override it. An earlier draft said the log "begins with an implied
   * `set_bounds`", which was incoherent — a `PlanOp` requires `opId`/`actorId`/`lamport`/`at` and
   * `createPlan` has none of those to mint, and it left `readOps`, `throughRevision` and
   * `rawDiff` ambiguous about whether revision 0 contained an op. So: `readOps` on a fresh plan
   * returns `[]`, revision 0 is the empty fold, and the first authoring op makes revision 1. The
   * fold's *seed* is a constant; the log is exclusively authored ops.
   */
  createPlan(
    planId: string,
    meta?: {
      label?: string
      /** Instantiation lineage, when the plan comes from a template. The store persists it and
       *  `readProvenance` returns it — without this parameter `instantiate()` had nowhere to
       *  write it, since `PlanOp` cannot carry provenance and `clonePlan` writes only clone
       *  lineage. */
      provenance?: InstantiatedFrom
    }
  ): Promise<CreateResult>

  /**
   * Mint `newPlanId` in `editable`, seeded with the folded state of `sourcePlanId` at
   * `atRevision` (default: its current revision), carrying provenance
   * `{parent, parentDigest, parentRevision}`. Inherits NO approval and NO run — a clone is cold
   * by construction. Atomic: either the clone exists complete, or not at all.
   */
  clonePlan(sourcePlanId: string, newPlanId: string, atRevision?: number): Promise<CreateResult>

  /**
   * Append ops. **Rejects unless the plan is `editable`**, checked in the SAME COMMIT as the
   * append — this is what makes `reviewable` and `executable` actually frozen, at the only
   * boundary that can enforce it. `transition()` cannot enforce this because it is not on the
   * append path: without the check, ops could change a frozen plan's content and digest while its
   * stored state stayed frozen, and in the `executable` case the `ApprovalRecord` would remain
   * bound to the PRIOR digest — making the plan executable with content that was never approved.
   * It returns `not_editable` with the actual state rather than throwing, so a stale writer learns
   * what happened.
   *
   * `expectedRevision`, when given, additionally rejects if the log has moved (optimistic
   * concurrency for a single author); omit it for the multi-writer CRDT case, where convergence
   * is the concurrency story.
   */
  appendOps(planId: string, ops: PlanOp[], expectedRevision?: number): Promise<AppendResult>

  /**
   * Read the op log. `sinceLamport` filters by clock; `throughRevision` bounds it to a REVISION
   * PREFIX, which is what `rawPlan({revision})` and `rawDiff(a, b)` need — a Lamport value is not
   * a revision selector, and without this a conforming store could not serve a historical view at
   * all. Rejects a revision the log never reached rather than silently returning everything.
   */
  readOps(
    planId: string,
    opts?: { sinceLamport?: number; throughRevision?: number }
  ): Promise<PlanOp[]>

  /** Clone lineage, for `RawPlanView.provenance`. `undefined` for a plan that is not a clone. */
  readProvenance(planId: string): Promise<PlanProvenance | undefined>

  /**
   * The ONE atomic lifecycle operation, and deliberately a NARROW one: it proves the plan is in
   * `expected.state` at `expectedDigest`, checks the target is a legal successor, and applies it —
   * persisting `approval` in the SAME COMMIT for `reviewable → executable`. It returns the losing
   * outcome rather than throwing, so a caller that lost can read what actually happened.
   *
   * A store does NOT evaluate policy. It cannot: deciding "is an evaluator wired", "is this tool
   * on the tier-C allowlist", or "does this reference taint a call arg" requires battery knowledge
   * a BYO store has no access to, and putting it here would force every store implementor to
   * reimplement the validator. So the split is: **the battery validates, the store commits.**
   *
   * The digest is what makes that safe rather than racy: the battery validates content at digest
   * D and the store commits only if the plan is still at D, so a concurrent edit invalidates the
   * transition instead of slipping past an already-passed check. A direct caller bypassing
   * `freezePlan` can still reach `transition` — that is a misuse the docs name, not a hole the
   * store can close, exactly as a direct `appendOps` caller can bypass the authoring tools.
   */
  transition(planId: string, t: TransitionRequest): Promise<TransitionResult>

  /**
   * The plan's lifecycle state NOW, alongside its current digest and revision. `state` is not a
   * `PlanOp`, so it cannot be folded from the log; it lives here, and a historical revision has
   * none to report. `readState` exists because `list({state})` needs a durable, race-safe state
   * read.
   */
  readState(planId: string): Promise<{ state: PlanState; digest: string; revision: number }>

  /**
   * Claim the plan's ONE run, or RE-ENTER it to resume. Conditional and durable: requires the
   * plan `executable` at `expectedDigest`. Without `resumeRunId` it starts a run and succeeds
   * only if none has ever been claimed. With `resumeRunId` it re-enters that specific run and
   * succeeds only if that run exists and is not already settled — this is the contractual
   * difference between a permitted re-entry and a prohibited second run, which a start-only
   * operation could not express.
   *
   * "Settled" here means COMPLETED, and the distinction is load-bearing. `aborted` and `halted`
   * are stopping points, not endings: the interruption taxonomy classifies a turn abort as
   * resumable with the frontier intact at the same digest, so a store that treats every
   * `run_settled` as terminal makes `resumeRunId` answer `run_already_settled` for exactly the
   * cases it exists to serve. A conforming store must admit re-entry after `aborted`/`halted`
   * and refuse it after `completed`.
   *
   * This — not the optional lock — is what enforces "one plan, at most one run, ever": the lock
   * seam is an availability measure a deployment may omit, so the invariant cannot rest on it.
   * The executor MUST claim before invoking any node.
   */
  claimRun(planId: string, expectedDigest: string, resumeRunId?: string): Promise<ClaimRunResult>

  /**
   * Ordered, atomic-as-a-batch, and scoped to the claimed run. Takes an ARRAY and commits it
   * atomically as a batch, because the commit protocol depends on it: `node_settled` + every
   * `edge_taken` + the new `frontier_snapshot` are ONE commit. A backend that cannot do this is
   * not conforming.
   */
  appendRunEvents(planId: string, runId: string, events: RunEvent[]): Promise<void>

  /** The claimed run's event log. `runId` omitted reads the plan's only run. */
  readRunEvents(planId: string, runId?: string): Promise<RunEvent[]>

  /**
   * The approval record persisted with the `reviewable → executable` transition, if the plan is
   * `executable`.
   *
   * @remarks
   * **The DIGEST on this record is bound; the AUTHORITY SET is only as trustworthy as the caller
   * that wrote it.** `transition` proves the plan is at `expectedDigest` before it commits, so a
   * record whose `digest` disagrees with the plan cannot be persisted. It does NOT — and cannot —
   * check that `authoritySet` matches the plan's reachable claims: recomputing that set requires
   * walking the graph and knowing what a `call` node is, which is battery knowledge a BYO store
   * does not have. That check lives in {@link approvePlan}, which recomputes the set and asserts
   * set-equality BEFORE calling `transition`.
   *
   * So a caller that bypasses `approvePlan` and calls `transition` directly can persist a record
   * claiming an authority set the plan never had. **That forged set grants nothing**: the executor
   * never reads `authoritySet`, and what a run may actually invoke is bounded by the tier-C
   * `InvocableTools` allowlist enforced at freeze. The damage is to the AUDIT TRAIL — anyone
   * reading this record back is told the operator approved something they did not.
   *
   * Treat `approvePlan` as the only supported way to reach `executable`. If you display or audit
   * this record, recompute the authority set from the plan with `computeAuthoritySet` rather than
   * trusting the stored copy.
   */
  readApproval(planId: string): Promise<ApprovalRecord | undefined>

  /** Summaries of every plan, optionally filtered by lifecycle state. */
  list(filter?: { state?: PlanState }): Promise<PlanSummary[]>
}

/**
 * The outcome of minting a plan (`createPlan` / `clonePlan`). On success it carries the new
 * plan's revision and digest; on failure it names which precondition was violated.
 */
export type CreateResult =
  | { ok: true; planId: string; revision: number; digest: string }
  | { ok: false; reason: 'duplicate_id' | 'source_missing' | 'revision_missing' }

/**
 * The outcome of an `appendOps` call. On success it carries the new revision and digest; on
 * failure it names whether the plan was not `editable` (frozen) or the log had moved past
 * `expectedRevision`, and carries the actual state so a stale writer learns what happened.
 */
export type AppendResult =
  | { ok: true; revision: number; digest: string }
  | {
      ok: false
      reason: 'not_editable' | 'revision_moved'
      actual: { state: PlanState; revision: number }
    }

/**
 * The transition request, as a DISCRIMINATED UNION over the legal pairs — so an illegal target
 * genuinely is a type error at the call site, rather than a claim the signature does not back.
 * `expected.state` is fixed per variant (it is implied by `from`), and `approval` is required
 * exactly where it is meaningful. A BYO store receiving a malformed request over a wire still
 * answers `illegal_transition` at runtime; the type is the first line, not the only one.
 */
export type TransitionRequest =
  | { from: 'editable'; to: 'reviewable'; expectedDigest: string } // freeze
  | { from: 'reviewable'; to: 'editable'; expectedDigest: string } // unfreeze; free
  | {
      from: 'reviewable'
      to: 'executable'
      expectedDigest: string // THE GATE
      approval: ApprovalRecord
    }

/**
 * The outcome of a `transition` call. On success it carries the new revision; on failure it names
 * whether the plan was not in the expected state, its digest had moved, or the request was not a
 * legal pair — carrying the actual state/digest so a caller that lost can read what happened.
 */
export type TransitionResult =
  | { ok: true; revision: number }
  | {
      ok: false
      reason: 'state_mismatch' | 'digest_mismatch'
      actual: { state: PlanState; digest: string }
    }
  /** For a BYO store handed a request the type system did not police (e.g. over a wire). */
  | { ok: false; reason: 'illegal_transition'; from: PlanState; to: PlanState }

/**
 * The outcome of a `claimRun` call. On success it carries the run id and whether this call
 * resumed an existing run; on failure it names whether the plan was not `executable`, its digest
 * had moved, a run was already claimed, the named run did not exist, or the named run was already
 * settled — carrying the existing run id where one exists.
 */
export type ClaimRunResult =
  | { ok: true; runId: string; resumed: boolean }
  | {
      ok: false
      reason:
        | 'not_executable'
        | 'digest_mismatch'
        | 'run_already_claimed'
        | 'run_not_found'
        | 'run_already_settled'
      existingRunId?: string
    }
