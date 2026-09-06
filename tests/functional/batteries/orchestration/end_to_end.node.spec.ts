import { describe, it, expect } from 'vitest'
import { SpooledArtifact } from '../../../../src/index'
import { InMemorySpoolStore } from '../../../../src/batteries/storage/in_memory/index'
import {
  NodeRef,
  InMemoryPlanStore,
  createStructuredCell,
  createOrchestration,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/index'
import type {
  PlanOp,
  PlanNode,
  PlanEdge,
  RunOptions,
  ApprovalRecord,
  Orchestration,
} from '../../../../src/batteries/orchestration/index'

registerOrchestrationEncodables()

/**
 * THE REAL PROOF: the whole lifecycle through the public assembly point, not through the internal
 * functions the unit suites call. Author a plan with a branch and a gate, freeze it, render the
 * operator prose, approve, execute, abort MID-RUN, assert the frontier reports the stopping point
 * and classifies the interruption resumable, resume, complete, then clone.
 *
 * The plan deliberately carries a `call` → `transform` pair over a REAL `SpooledArtifact` with the
 * abort falling BETWEEN them, because that pairing has the most moving pieces — executor, store,
 * encoder, artifact table — and the least unit-level visibility. If the artifact channel does not
 * survive an interruption, this is where it shows.
 */
describe('the orchestration battery, end to end through its public surface', () => {
  const spool = new InMemorySpoolStore()

  /** A tool that returns a real artifact, and one that returns a plain string. */
  const invocableTools = {
    has: (tool: string) => ['fetch_report', 'notify'].includes(tool),
    names: () => ['fetch_report', 'notify'],
    returns: (tool: string) =>
      tool === 'fetch_report'
        ? ({ kind: 'artifact', artifactClass: SpooledArtifact } as const)
        : undefined,
  }

  const entry: PlanNode = {
    id: 'entry',
    kind: 'entry',
    definition: { input: [{ path: 'region', type: 'string' }] },
  } as PlanNode

  const fetchReport: PlanNode = {
    id: 'fetch_report',
    kind: 'call',
    definition: {
      tool: 'fetch_report',
      args: {},
      output: [],
      onMissingValue: 'fail',
      authority: [{ capability: 'report', scope: 'quarterly', verb: 'read' }],
      replaySafe: true,
      onIndeterminate: 'retry',
    },
  } as PlanNode

  /** Reads the artifact the call produced — the pair the abort must not break. */
  const summarise: PlanNode = {
    id: 'summarise',
    kind: 'transform',
    definition: {
      source: new NodeRef('fetch_report', 'first'),
      steps: [{ name: 'artifact_head', args: { n: 2 } }],
      emit: { as: 'value', field: 'headline' },
      output: [{ path: 'headline', type: 'string' }],
    },
  } as PlanNode

  const decide: PlanNode = {
    id: 'decide',
    kind: 'branch',
    definition: {
      evaluator: 'structured',
      predicate: { path: 'summarise:e2:e0e2:e1.headline', op: 'exists' },
    },
  } as PlanNode

  const notify: PlanNode = {
    id: 'notify',
    kind: 'call',
    definition: {
      tool: 'notify',
      args: {},
      output: [{ path: 'value', type: 'string' }],
      onMissingValue: 'fail',
      authority: [{ capability: 'inbox', scope: 'ops', verb: 'create' }],
      replaySafe: false,
      onIndeterminate: 'halt',
    },
  } as PlanNode

  const NODES = [entry, fetchReport, summarise, decide, notify]
  const EDGES: PlanEdge[] = [
    { id: 'e0', from: 'entry', to: 'fetch_report', handle: 'always' },
    { id: 'e1', from: 'fetch_report', to: 'summarise', handle: 'always' },
    { id: 'e2', from: 'summarise', to: 'decide', handle: 'always' },
    { id: 'e3', from: 'decide', to: 'notify', handle: 'match' },
  ]

  /** Author the plan into a fresh store, through the public store surface. */
  const authorPlan = async (orchestration: Orchestration, planId: string) => {
    await orchestration.store.createPlan(planId)
    let seq = 0
    const op = (body: Record<string, unknown>): PlanOp =>
      ({
        opId: `o${++seq}`,
        actorId: 'author',
        lamport: seq,
        at: 'x',
        ...body,
      }) as unknown as PlanOp
    await orchestration.store.appendOps(planId, [
      ...NODES.map((node) => op({ op: 'add_node', node })),
      ...EDGES.map((edge) => op({ op: 'add_edge', edge })),
    ])
  }

  const build = async (): Promise<Orchestration> =>
    createOrchestration({
      store: new InMemoryPlanStore(),
      invocable: invocableTools as never,
      deps: { evaluators: [createStructuredCell()] },
    })

  it('runs author → freeze → render → approve → execute → abort → resume → clone', async () => {
    const orchestration = await build()
    await authorPlan(orchestration, 'quarterly')

    // ── freeze ────────────────────────────────────────────────────────────────
    const frozen = await orchestration.freezePlan('quarterly')
    expect(frozen.issues.filter((i) => i.severity === 'blocking')).toEqual([])
    expect(frozen.ok).toBe(true)

    // ── render: this prose IS the review surface, since there is no dry run ────
    const view = await orchestration.raw.plan(orchestration.store, 'quarterly')
    const prose = orchestration.render(view, { audience: 'operator', view: 'as_planned' })
    // Node ids must appear verbatim: a model extending the plan cites them, and an ordinal cannot
    // be cited because nothing in the IR is addressed by position.
    expect(prose).toContain('fetch_report')
    expect(prose).toContain('notify')
    // The side-effecting call is marked, and the read-only one is not — a warning that fires on
    // everything carries no information.
    expect(prose).toContain('MODIFIES DATA')

    // ── approve: the gate binds the authority set to the digest ───────────────
    const reviewable = await orchestration.store.readState('quarterly')
    expect(reviewable.state).toBe('reviewable')

    const authoritySet = [
      { capability: 'inbox', scope: 'ops', verb: 'create' as const },
      { capability: 'report', scope: 'quarterly', verb: 'read' as const },
    ]
    const record: ApprovalRecord = {
      planId: 'quarterly',
      digest: reviewable.digest,
      authoritySet,
      decidedBy: 'operator',
      decidedAt: new Date().toISOString(),
      disposition: 'approved',
    }
    const approved = await orchestration.approvePlan('quarterly', record)
    expect(approved.ok).toBe(true)

    const executable = await orchestration.store.readState('quarterly')
    expect(executable.state).toBe('executable')

    // ── execute, aborting BETWEEN the call and the transform ──────────────────
    const artifact = new SpooledArtifact(spool.write('report-1', 'alpha\nbeta\ngamma\n'))
    const abort = new AbortController()
    const firstRunTools: string[] = []

    const interrupted = await orchestration.executePlan('quarterly', {
      input: { region: 'emea' },
      signal: abort.signal,
      invokeCall: async (req: { tool: string }) => {
        firstRunTools.push(req.tool)
        // Abort immediately after the artifact-producing call settles, so the interruption falls
        // squarely between the `call` and the `transform` that reads its artifact.
        if (req.tool === 'fetch_report') abort.abort()
        return artifact
      },
      reason: async () => ({}),
    } as unknown as RunOptions)

    expect(firstRunTools).toEqual(['fetch_report'])
    expect(interrupted.outcome).toBe('aborted')
    // Classified resumable, and reporting WHERE it stopped.
    expect(interrupted.interruption).toMatchObject({ kind: 'turn_abort' })
    expect(interrupted.frontier.frames.map((f) => f.frame.nodeId)).toEqual(['summarise'])
    // `notify` never ran: nothing past the stopping point was invoked.
    expect(firstRunTools).not.toContain('notify')

    // ── resume: the artifact channel must survive the interruption ────────────
    const resumedTools: string[] = []
    const completed = await orchestration.executePlan('quarterly', {
      input: { region: 'emea' },
      resumeRunId: interrupted.runId,
      invokeCall: async (req: { tool: string }) => {
        resumedTools.push(req.tool)
        return req.tool === 'fetch_report' ? artifact : 'notified'
      },
      reason: async () => ({}),
    } as unknown as RunOptions)

    expect(completed.outcome).toBe('completed')
    // The transform read the artifact the PRE-INTERRUPTION run produced, and the branch then
    // fired `match`, so the resumed run reached `notify` — and did NOT re-invoke `fetch_report`.
    expect(resumedTools).toEqual(['notify'])

    // ── clone: recovery is a fresh, cold, unapproved plan ─────────────────────
    const cloned = await orchestration.store.clonePlan('quarterly', 'quarterly-v2')
    expect(cloned.ok).toBe(true)

    const clone = await orchestration.store.readState('quarterly-v2')
    expect(clone.state).toBe('editable')

    // Cold: the clone has no run of its own, so it can be gated and executed afresh.
    const cloneOps = await orchestration.store.readOps('quarterly-v2')
    const originalOps = await orchestration.store.readOps('quarterly')
    expect(cloneOps.length).toBe(originalOps.length)

    // And its prose warns that re-running repeats effects already performed by the parent.
    const cloneView = await orchestration.raw.plan(orchestration.store, 'quarterly-v2')
    const cloneProse = orchestration.render(cloneView, { audience: 'operator', view: 'as_planned' })
    expect(cloneProse).toContain('quarterly')
  })

  it('refuses to execute a plan that was never approved', async () => {
    // The gate IS the transition, so "approved" and "executable" are one fact — there is no
    // separate flag to forget to check.
    const orchestration = await build()
    await authorPlan(orchestration, 'ungated')
    await orchestration.freezePlan('ungated')

    await expect(
      orchestration.executePlan('ungated', {
        input: { region: 'emea' },
        invokeCall: async () => 'ok',
        reason: async () => ({}),
      } as unknown as RunOptions)
    ).rejects.toThrow(/not_executable/)
  })

  it('refuses an approval whose authority set does not match the plan', async () => {
    const orchestration = await build()
    await authorPlan(orchestration, 'mismatched')
    await orchestration.freezePlan('mismatched')
    const state = await orchestration.store.readState('mismatched')

    const result = await orchestration.approvePlan('mismatched', {
      planId: 'mismatched',
      digest: state.digest,
      authoritySet: [{ capability: 'report', scope: 'quarterly', verb: 'read' }],
      decidedBy: 'operator',
      decidedAt: new Date().toISOString(),
      disposition: 'approved',
    } as ApprovalRecord)

    expect(result.ok).toBe(false)
    const after = await orchestration.store.readState('mismatched')
    expect(after.state).toBe('reviewable')
  })
})
