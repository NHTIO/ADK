import { describe, it, expect } from 'vitest'
import { foldRun } from '../../../../src/batteries/orchestration/runs'
import { executePlan } from '../../../../src/batteries/orchestration/executor'
import { freezePlan } from '../../../../src/batteries/orchestration/validation'
import { DEFAULT_PLAN_BOUNDS } from '../../../../src/batteries/orchestration/types'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'
import type {
  PlanOp,
  PlanBounds,
  PlanNode,
  PlanEdge,
  RunEvent,
  RunOptions,
  ApprovalRecord,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * `foldRun` answers "where did it stop and what happened" from the EVENT LIST ALONE — no graph,
 * no store, no side channel. That is what lets an operator, a UI or a resuming executor all reach
 * the same conclusion from the durable log, so these cases hand it events directly wherever the
 * property is about the fold, and run the real executor wherever it is about resume.
 */
describe('the run fold and the resume path', () => {
  const INVOCABLE = { has: () => true, names: () => ['t'], returns: () => undefined }

  const entry: PlanNode = { id: 'entry', kind: 'entry', definition: { input: [] } } as PlanNode
  const call = (id: string, extra: Record<string, unknown> = {}): PlanNode =>
    ({
      id,
      kind: 'call',
      definition: {
        tool: id,
        args: {},
        output: [{ path: 'value', type: 'string' }],
        onMissingValue: 'fail',
        authority: [],
        replaySafe: true,
        onIndeterminate: 'halt',
        ...extra,
      },
    }) as PlanNode
  const edge = (id: string, from: string, to: string): PlanEdge =>
    ({ id, from, to, handle: 'always' }) as PlanEdge

  const executable = async (
    planId: string,
    nodes: PlanNode[],
    edges: PlanEdge[],
    bounds?: PlanBounds
  ) => {
    const store = new InMemoryPlanStore()
    await store.createPlan(planId)
    let seq = 0
    const op = (body: Record<string, unknown>): PlanOp =>
      ({ opId: `o${++seq}`, actorId: 'a', lamport: seq, at: 'x', ...body }) as unknown as PlanOp
    await store.appendOps(planId, [
      ...nodes.map((node) => op({ op: 'add_node', node })),
      ...edges.map((e) => op({ op: 'add_edge', edge: e })),
      ...(bounds ? [op({ op: 'set_bounds', bounds })] : []),
    ])
    const frozen = await freezePlan(store, planId, {
      invocable: INVOCABLE as never,
      evaluators: [],
    })
    expect(frozen.ok).toBe(true)
    const state = await store.readState(planId)
    await store.transition(planId, {
      from: 'reviewable',
      to: 'executable',
      expectedDigest: state.digest,
      approval: {
        planId,
        digest: state.digest,
        authoritySet: [],
        decidedBy: 'operator',
        decidedAt: new Date().toISOString(),
        disposition: 'approved',
      } as ApprovalRecord,
    })
    return store
  }

  const frame = (nodeId: string, kind = 'call') =>
    ({ nodeId, kind, branchId: { segments: [] } }) as unknown as RunEvent extends never
      ? never
      : { nodeId: string; kind: string; branchId: { segments: [] } }

  describe('every field derives from the events alone', () => {
    it('throws on a list that does not begin with run_started', () => {
      expect(() =>
        foldRun([{ kind: 'node_entered', frame: frame('a'), at: 'x' } as never])
      ).toThrow()
      expect(() => foldRun([])).toThrow()
    })

    it('reports `running` with NO interruption for run_started + node_entered', () => {
      // The retraction that matters: a crashed executor's log is BYTE-IDENTICAL to a healthy one
      // currently inside that call. No fold over events can tell them apart, because the
      // difference is liveness, not history — so the fold does not guess.
      const projection = foldRun([
        { kind: 'run_started', runId: 'r1', digest: 'd', at: 'x' },
        { kind: 'node_entered', frame: frame('a'), at: 'x' },
      ] as never)

      expect(projection.outcome).toBe('running')
      expect(projection.interruption).toBeUndefined()
    })

    it('reports process death only once someone RECORDED it', () => {
      // Process death reaches the history when whoever resumes appends it — never by inference.
      const projection = foldRun([
        { kind: 'run_started', runId: 'r1', digest: 'd', at: 'x' },
        { kind: 'node_entered', frame: frame('a'), at: 'x' },
        { kind: 'run_interrupted', cause: { kind: 'process_death' }, at: 'x' },
        { kind: 'run_settled', outcome: 'aborted', at: 'x' },
      ] as never)

      expect(projection.interruption).toMatchObject({ kind: 'process_death' })
      expect(projection.outcome).toBe('aborted')
    })

    it('carries runId and digest out of run_started', () => {
      const projection = foldRun([
        { kind: 'run_started', runId: 'r-42', digest: 'deadbeef', at: 'x' },
      ] as never)

      expect(projection.runId).toBe('r-42')
      expect(projection.digest).toBe('deadbeef')
    })
  })

  describe('the indeterminate set is exactly the entered-unsettled CALL frames', () => {
    it('holds an in-flight call', () => {
      const projection = foldRun([
        { kind: 'run_started', runId: 'r1', digest: 'd', at: 'x' },
        { kind: 'node_entered', frame: frame('a'), at: 'x' },
      ] as never)

      expect(projection.indeterminate.map((f) => f.nodeId)).toEqual(['a'])
    })

    it('excludes every other kind, which is re-entered unconditionally', async () => {
      // Only a `call` has an external effect that might have half-happened. `branch`/`select` are
      // pure reads over the persisted table, `transform` is a pure read, `join` restores from the
      // frontier, and `reason` costs tokens but performs no external effect.
      for (const kind of ['reason', 'transform', 'branch', 'select', 'join']) {
        const projection = foldRun([
          { kind: 'run_started', runId: 'r1', digest: 'd', at: 'x' },
          { kind: 'node_entered', frame: frame('n', kind), at: 'x' },
        ] as never)
        expect(projection.indeterminate).toEqual([])
      }
    })

    it('excludes a PARKED join arrival on a completed run', async () => {
      // A join arrival that did not close the barrier is entered-and-never-settled by design, so
      // it looks exactly like an in-flight frame in the log. It must not be reported as
      // indeterminate work: nothing was half-done, the arrival simply contributed and waited.
      const store = await executable(
        'parked',
        [
          entry,
          call('a'),
          call('b'),
          call('c'),
          { id: 'j', kind: 'join', definition: {} } as PlanNode,
          call('after'),
        ],
        [
          edge('e0', 'entry', 'a'),
          edge('e1', 'a', 'b'),
          edge('e2', 'a', 'c'),
          edge('e3', 'b', 'j'),
          edge('e4', 'c', 'j'),
          edge('e5', 'j', 'after'),
        ]
      )
      const projection = await executePlan(store, 'parked', {
        input: {},
        invokeCall: async () => 'ok',
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(projection.outcome).toBe('completed')
      expect(projection.indeterminate).toEqual([])
    })
  })

  describe('resume', () => {
    it('re-enters an ABORTED run and finishes only the remaining work', async () => {
      // The defect this pins: the reference store marked a run terminally settled on ANY
      // `run_settled`, so `claimRun(resumeRunId)` answered `run_already_settled` and an aborted
      // run — which the interruption taxonomy calls resumable with the frontier intact — could
      // never be resumed. `resumeRunId` was unusable for exactly the case it exists to serve.
      const store = await executable(
        'resume',
        [entry, call('a'), call('b'), call('c')],
        [edge('e0', 'entry', 'a'), edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]
      )

      const abort = new AbortController()
      let invocations = 0
      const first = await executePlan(store, 'resume', {
        input: {},
        signal: abort.signal,
        invokeCall: async () => {
          if (++invocations === 2) abort.abort()
          return 'ok'
        },
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(first.outcome).toBe('aborted')
      expect(first.interruption).toMatchObject({ kind: 'turn_abort' })
      expect(first.frontier.frames.map((f) => f.frame.nodeId)).toEqual(['c'])

      // Resuming runs the stopping point and nothing already done.
      const resumed: string[] = []
      const second = await executePlan(store, 'resume', {
        input: {},
        resumeRunId: first.runId,
        invokeCall: async (req: { tool: string }) => {
          resumed.push(req.tool)
          return 'ok'
        },
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(second.outcome).toBe('completed')
      expect(resumed).toEqual(['c'])
    })

    it("does NOT burn the plan's only run on invalid input", async () => {
      // Found by the AI review panel. `claimRun` ran BEFORE `validateInput`, and the claim is
      // irreversible by design — a plan admits one run ever, and there is no release API. So a
      // malformed request took the claim, threw on validation, and left the plan permanently
      // `run_already_claimed`: unrunnable, for a request that never invoked a single tool, with
      // `clonePlan` the only recovery.
      //
      // Everything that can refuse now happens BEFORE the claim.
      const store = await executable(
        'bad-input',
        [
          {
            id: 'entry',
            kind: 'entry',
            definition: { input: [{ path: 'folder', type: 'string' }] },
          } as PlanNode,
          call('a'),
        ],
        [edge('e0', 'entry', 'a')]
      )

      // A request missing the declared field is refused...
      await expect(
        executePlan(store, 'bad-input', {
          input: {},
          invokeCall: async () => 'ok',
          reason: async () => ({}),
          evaluators: [],
        } as unknown as RunOptions)
      ).rejects.toThrow(/folder/)

      // ...and the plan is still runnable. This is the assertion that matters: before the fix
      // this threw `run_already_claimed` and the plan was bricked.
      const invoked: string[] = []
      const projection = await executePlan(store, 'bad-input', {
        input: { folder: '/tmp' },
        invokeCall: async (req: { tool: string }) => {
          invoked.push(req.tool)
          return 'ok'
        },
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(projection.outcome).toBe('completed')
      expect(invoked).toEqual(['a'])
    })

    it('refuses to re-enter a COMPLETED run', async () => {
      // The other half: one plan, at most one run, ever. A finished run is finished.
      const store = await executable('finished', [entry, call('a')], [edge('e0', 'entry', 'a')])
      const first = await executePlan(store, 'finished', {
        input: {},
        invokeCall: async () => 'ok',
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)
      expect(first.outcome).toBe('completed')

      await expect(
        executePlan(store, 'finished', {
          input: {},
          resumeRunId: first.runId,
          invokeCall: async () => 'ok',
          reason: async () => ({}),
          evaluators: [],
        } as unknown as RunOptions)
      ).rejects.toThrow(/run_already_settled/)
    })

    it('refuses a SECOND run on a plan that already has one', async () => {
      const store = await executable('single', [entry, call('a')], [edge('e0', 'entry', 'a')])
      await executePlan(store, 'single', {
        input: {},
        invokeCall: async () => 'ok',
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      await expect(
        executePlan(store, 'single', {
          input: {},
          invokeCall: async () => 'ok',
          reason: async () => ({}),
          evaluators: [],
        } as unknown as RunOptions)
      ).rejects.toThrow(/run_already_claimed/)
    })
  })

  describe('budget exhaustion is its own cause, not a death', () => {
    it("reports budget_exhausted with the count, and honours the PLAN's maxSteps", async () => {
      // Found by the AI review panel. Two defects in one line: budget exhaustion was reported as
      // `process_death`, and the bound was a module constant rather than the plan's own
      // `maxSteps`.
      //
      // The misclassification matters because `foldRun` is explicit that process death is NEVER
      // inferred — it reaches the log only when a resuming caller records it. Reporting a known,
      // deliberate stop as a death sends an operator hunting a crash that never happened.
      //
      // The bound matters because `maxSteps` is plan CONTENT: digested, and approved by the
      // operator. Ignoring it silently overrides a decision they made.
      const nodes: PlanNode[] = [entry]
      for (let i = 0; i < 6; i++) nodes.push(call(`c${i}`))
      const edges: PlanEdge[] = [edge('e0', 'entry', 'c0')]
      for (let i = 0; i < 5; i++) edges.push(edge(`e${i + 1}`, `c${i}`, `c${i + 1}`))

      const store = await executable('budget', nodes, edges, {
        ...DEFAULT_PLAN_BOUNDS,
        maxSteps: 3,
      })
      const projection = await executePlan(store, 'budget', {
        input: {},
        invokeCall: async () => 'ok',
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(projection.outcome).toBe('halted')
      expect(projection.interruption).toMatchObject({ kind: 'budget_exhausted', settled: 3 })
    })

    it('does not loop forever when a budget-exhausted run is resumed', async () => {
      // The resume restores the settlement count, so the very first check re-trips. That is
      // CORRECT — the bound has not changed, so neither has the answer — but it must halt with
      // the real reason rather than spin or mislabel. Recovery is raising `maxSteps` and cloning.
      const nodes: PlanNode[] = [entry]
      for (let i = 0; i < 6; i++) nodes.push(call(`c${i}`))
      const edges: PlanEdge[] = [edge('e0', 'entry', 'c0')]
      for (let i = 0; i < 5; i++) edges.push(edge(`e${i + 1}`, `c${i}`, `c${i + 1}`))

      const store = await executable('budget-resume', nodes, edges, {
        ...DEFAULT_PLAN_BOUNDS,
        maxSteps: 3,
      })
      const opts = {
        input: {},
        invokeCall: async () => 'ok',
        reason: async () => ({}),
        evaluators: [],
      }
      const first = await executePlan(store, 'budget-resume', opts as unknown as RunOptions)
      const resumed = await executePlan(store, 'budget-resume', {
        ...opts,
        resumeRunId: first.runId,
      } as unknown as RunOptions)

      expect(resumed.outcome).toBe('halted')
      expect(resumed.interruption).toMatchObject({ kind: 'budget_exhausted' })
    })
  })

  describe('interruption causes are classified, not flattened', () => {
    it('reports a turn abort as turn_abort', async () => {
      const store = await executable(
        'abort',
        [entry, call('a'), call('b')],
        [edge('e0', 'entry', 'a'), edge('e1', 'a', 'b')]
      )
      const abort = new AbortController()
      const projection = await executePlan(store, 'abort', {
        input: {},
        signal: abort.signal,
        invokeCall: async () => {
          abort.abort()
          return 'ok'
        },
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(projection.interruption).toMatchObject({ kind: 'turn_abort' })
    })

    it('reports an unhandled node failure as node_failed, naming the node', async () => {
      const store = await executable('failed', [entry, call('a')], [edge('e0', 'entry', 'a')])
      const projection = await executePlan(store, 'failed', {
        input: {},
        invokeCall: async () => {
          throw new Error('boom')
        },
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(projection.interruption).toMatchObject({
        kind: 'node_failed',
        nodeId: 'a',
        handled: false,
      })
    })

    it('reports NO interruption for a handled failure that the run recovered from', async () => {
      // A node that throws WITH an `error` edge is a handled failure, not an interruption — the
      // run traverses the edge and its outcome may still be `completed`.
      const store = await executable(
        'handled',
        [entry, call('a'), call('recovery')],
        [
          edge('e0', 'entry', 'a'),
          { id: 'e1', from: 'a', to: 'recovery', handle: 'error' } as PlanEdge,
        ]
      )
      const invoked: string[] = []
      const projection = await executePlan(store, 'handled', {
        input: {},
        invokeCall: async (req: { tool: string }) => {
          invoked.push(req.tool)
          if (req.tool === 'a') throw new Error('boom')
          return 'ok'
        },
        reason: async () => ({}),
        evaluators: [],
      } as unknown as RunOptions)

      expect(projection.outcome).toBe('completed')
      expect(projection.interruption).toBeUndefined()
      expect(invoked).toEqual(['a', 'recovery'])
    })
  })
})
