import { describe, it, expect } from 'vitest'
import { foldRun } from '../../../../src/batteries/orchestration/runs'
import { executePlan } from '../../../../src/batteries/orchestration/executor'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'
import type {
  PlanOp,
  PlanNode,
  PlanNodeKind,
  ApprovalRecord,
  RunOptions,
  ToolResult,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * The executor WRITES run events and `foldRun` READS them. They were built from one
 * specification in separate jobs, and the first draft agreed on the event STRUCTURE while
 * disagreeing on the discriminator NAME — the executor stamped `_kind`, the fold switches on
 * `kind`. Both files type-checked, linted and doc-covered clean, because the seam passes
 * through `Record<string, unknown>`.
 *
 * These cases exist to make that class of disagreement impossible to reintroduce silently:
 * they run the producer against the real consumer rather than testing either alone.
 */
describe('executor <-> foldRun interoperate over real run events', () => {
  const entry = {
    id: 'entry',
    kind: 'entry' as PlanNodeKind,
    definition: { input: [] },
  } as unknown as PlanNode

  const callNode = (id: string): PlanNode =>
    ({
      id,
      kind: 'call' as PlanNodeKind,
      definition: {
        tool: 'echo',
        args: {},
        output: [],
        onMissingValue: 'fail',
        authority: [],
        replaySafe: true,
        onIndeterminate: 'halt',
      },
    }) as unknown as PlanNode

  const op = (i: number, extra: Record<string, unknown>) =>
    ({ opId: `o${i}`, actorId: 'a', lamport: i, at: 'x', ...extra }) as unknown as PlanOp

  /** A frozen, approved plan of `entry -> a`, plus the digest it was approved at. */
  const approvedPlan = async () => {
    const store = new InMemoryPlanStore()
    await store.createPlan('p')
    await store.appendOps('p', [
      op(1, { op: 'add_node', node: entry }),
      op(2, { op: 'add_node', node: callNode('a') }),
      op(3, { op: 'add_edge', edge: { id: 'e1', from: 'entry', to: 'a', handle: 'always' } }),
    ])
    const { digest: editable } = await store.readState('p')
    await store.transition('p', {
      from: 'editable',
      to: 'reviewable',
      expectedDigest: editable,
    })
    const { digest } = await store.readState('p')
    const approval: ApprovalRecord = {
      planId: 'p',
      digest,
      authoritySet: [],
      decidedBy: 'operator',
      decidedAt: new Date().toISOString(),
      disposition: 'approved',
    }
    await store.transition('p', {
      from: 'reviewable',
      to: 'executable',
      expectedDigest: digest,
      approval,
    })
    return { store, digest }
  }

  const runOptions = (invoked: string[]): RunOptions =>
    ({
      input: {},
      invokeCall: async (req: { tool: string }): Promise<ToolResult> => {
        invoked.push(req.tool)
        return 'ok'
      },
      reason: async () => ({}),
      evaluators: [],
    }) as unknown as RunOptions

  it('executes the plan and invokes the call node', async () => {
    const { store } = await approvedPlan()
    const invoked: string[] = []
    await executePlan(store, 'p', runOptions(invoked))
    expect(invoked).toContain('echo')
  })

  it('writes events the real foldRun can read, discriminated on `kind`', async () => {
    const { store } = await approvedPlan()
    await executePlan(store, 'p', runOptions([]))
    const events = await store.readRunEvents('p')

    expect(events.length).toBeGreaterThan(0)
    // The discriminator must be the contract's `kind`, not a local alias.
    for (const event of events) {
      expect(event).toHaveProperty('kind')
    }
    expect(events[0]!.kind).toBe('run_started')

    // The real consumer must accept them without throwing.
    const projection = foldRun(events)
    expect(projection.runId).toBeTruthy()
  })

  it('stamps run_started with the digest the plan was approved at', async () => {
    const { store, digest } = await approvedPlan()
    await executePlan(store, 'p', runOptions([]))
    const events = await store.readRunEvents('p')
    const started = events.find((e) => e.kind === 'run_started')
    expect(started).toBeDefined()
    // A synthesised identity here would defeat claimRun's resume guard.
    expect((started as { digest: string }).digest).toBe(digest)
  })

  it('commits node_entered before that node settles', async () => {
    const { store } = await approvedPlan()
    await executePlan(store, 'p', runOptions([]))
    const events = await store.readRunEvents('p')
    const kinds = events.map((e) => e.kind)
    const entered = kinds.indexOf('node_entered')
    const settled = kinds.indexOf('node_settled')
    expect(entered).toBeGreaterThanOrEqual(0)
    expect(settled).toBeGreaterThan(entered)
  })

  it('refuses a second run on the same plan', async () => {
    const { store } = await approvedPlan()
    const first: string[] = []
    await executePlan(store, 'p', runOptions(first))
    expect(first).toContain('echo')

    const second: string[] = []
    // One plan, at most one run, ever — enforced by claimRun, not by the optional lock.
    await expect(executePlan(store, 'p', runOptions(second))).rejects.toThrow()
    expect(second).toHaveLength(0)
  })
})
