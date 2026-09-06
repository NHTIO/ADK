import { describe, it, expect } from 'vitest'
import { executePlan } from '../../../../src/batteries/orchestration/executor'
import { SpooledArtifact } from '../../../../src/lib/classes/spooled_artifact'
import { freezePlan } from '../../../../src/batteries/orchestration/validation'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { InMemorySpoolStore } from '../../../../src/batteries/storage/in_memory/index'
import {
  NodeRef,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/encoding'
import type {
  PlanOp,
  PlanNode,
  PlanEdge,
  RunOptions,
  ApprovalRecord,
  RunProjection,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * The `transform` node reads a REAL artifact instance out of the frame's `ArtifactTable` — it
 * cannot read one from `OutputItem.json`, which is `EncodableValue`-only, because the descriptor
 * methods are async reader-bound methods that need the instance. So the lookup into that table is
 * the node's load-bearing step, and these cases drive it through a real `SpooledArtifact` rather
 * than a stand-in.
 */
describe('a transform reads its source artifact from the branch-local table', () => {
  const artifactOf = (content: string): SpooledArtifact =>
    new SpooledArtifact(new InMemorySpoolStore().write('artifact-1', content))

  const INVOCABLE = {
    has: () => true,
    names: () => ['t'],
    returns: () => ({ kind: 'artifact', artifactClass: SpooledArtifact }),
  }

  /** Author, freeze and approve a plan, then run it — the whole real lifecycle, no shortcuts. */
  const runPlan = async (
    planId: string,
    nodes: PlanNode[],
    edges: PlanEdge[],
    result: unknown
  ): Promise<{ projection: RunProjection; store: InMemoryPlanStore; frozen: boolean }> => {
    const store = new InMemoryPlanStore()
    await store.createPlan(planId)
    let seq = 0
    const op = (body: Record<string, unknown>): PlanOp =>
      ({
        opId: `o${++seq}`,
        actorId: 'author',
        lamport: seq,
        at: 'x',
        ...body,
      }) as unknown as PlanOp

    await store.appendOps(planId, [
      ...nodes.map((node) => op({ op: 'add_node', node })),
      ...edges.map((edge) => op({ op: 'add_edge', edge })),
    ])

    const frozen = await freezePlan(store, planId, {
      invocable: INVOCABLE as never,
      evaluators: [],
    })
    if (!frozen.ok) return { projection: undefined as never, store, frozen: false }

    const state = await store.readState(planId)
    const approval: ApprovalRecord = {
      planId,
      digest: state.digest,
      authoritySet: [],
      decidedBy: 'operator',
      decidedAt: new Date().toISOString(),
      disposition: 'approved',
    }
    await store.transition(planId, {
      from: 'reviewable',
      to: 'executable',
      expectedDigest: state.digest,
      approval,
    })

    const options = {
      input: {},
      invokeCall: async () => result,
      reason: async () => ({}),
      evaluators: [],
    } as unknown as RunOptions

    return { projection: await executePlan(store, planId, options), store, frozen: true }
  }

  const entry: PlanNode = { id: 'entry', kind: 'entry', definition: { input: [] } } as PlanNode
  const producer: PlanNode = {
    id: 'produce',
    kind: 'call',
    definition: {
      tool: 't',
      args: {},
      output: [],
      onMissingValue: 'fail',
      authority: [],
      replaySafe: true,
      onIndeterminate: 'halt',
    },
  } as PlanNode

  const transformNode = (source: NodeRef): PlanNode =>
    ({
      id: 'tr',
      kind: 'transform',
      definition: {
        source,
        steps: [{ name: 'artifact_head', args: { n: 2 } }],
        emit: { as: 'value', field: 'text' },
        output: [{ path: 'text', type: 'string' }],
      },
    }) as PlanNode

  const EDGES: PlanEdge[] = [
    { id: 'e0', from: 'entry', to: 'produce', handle: 'always' },
    { id: 'e1', from: 'produce', to: 'tr', handle: 'always' },
  ]

  const transformOutput = async (store: InMemoryPlanStore, planId: string) => {
    const events = await store.readRunEvents(planId)
    const settled = events.find(
      (e): e is Extract<typeof e, { kind: 'node_settled' }> =>
        e.kind === 'node_settled' && e.frame.nodeId === 'tr'
    )
    return settled?.outcome
  }

  it('resolves a source whose branchId is OMITTED, on a plan with one path', async () => {
    // THE REGRESSION. `NodeRef.branchId` omitted means "do not filter", and freeze permits it
    // exactly when one path reaches the node — so on a linear plan the author cannot be asked to
    // supply one. The artifact lookup nonetheless keyed the ENTRY route, while `produce` (one
    // edge in) stores under `{segments:[{edge:'e0'}]}`. The plan froze clean and then failed at
    // RUN time with "no artifact in this branch", which is the worst place to find it: past the
    // approval gate, with the call's side effect already performed.
    const { projection, store, frozen } = await runPlan(
      'linear',
      [entry, producer, transformNode(new NodeRef('produce', 'first'))],
      EDGES,
      artifactOf('alpha\nbeta\ngamma\n')
    )

    // Freeze accepting it is half the point: the shapes freeze admits are the shapes that must run.
    expect(frozen).toBe(true)
    expect(projection.outcome).toBe('completed')
    expect(await transformOutput(store, 'linear')).toMatchObject({
      status: 'ok',
      output: { items: [{ json: { text: 'alpha\nbeta' } }] },
    })
  })

  it('resolves a source whose branchId is EXPLICIT', async () => {
    const { projection, store } = await runPlan(
      'explicit',
      [
        entry,
        producer,
        transformNode(new NodeRef('produce', 'first', undefined, { segments: [{ edge: 'e0' }] })),
      ],
      EDGES,
      artifactOf('alpha\nbeta\ngamma\n')
    )

    expect(projection.outcome).toBe('completed')
    expect(await transformOutput(store, 'explicit')).toMatchObject({
      status: 'ok',
      output: { items: [{ json: { text: 'alpha\nbeta' } }] },
    })
  })

  it('invokes the descriptor METHOD, not the step NAME', async () => {
    // A step cites `artifact_head`; the runtime must call `head()`. The two vocabularies are
    // disjoint across every core descriptor, so confusing them fails totally rather than subtly —
    // and the emitted value is the proof it called the right one.
    const { store } = await runPlan(
      'method',
      [entry, producer, transformNode(new NodeRef('produce', 'first'))],
      EDGES,
      artifactOf('one\ntwo\nthree\nfour\n')
    )

    // `head({n: 2})` yields the first two lines; `tail` or a no-op would not.
    expect(await transformOutput(store, 'method')).toMatchObject({
      output: { items: [{ json: { text: 'one\ntwo' } }] },
    })
  })

  it('fails as an ordinary node failure when the source produced no artifact', async () => {
    // A `call` returning a string writes an OUTPUT but no ARTIFACT, so a transform over it has
    // nothing to read. That must surface as a node failure naming the source, not a crash.
    const { projection, store } = await runPlan(
      'no-artifact',
      [entry, producer, transformNode(new NodeRef('produce', 'first'))],
      EDGES,
      'a plain string, not an artifact'
    )

    expect(projection.outcome).toBe('aborted')
    const outcome = await transformOutput(store, 'no-artifact')
    expect(outcome).toMatchObject({ status: 'failed', handled: false })
    expect(JSON.stringify(outcome)).toContain('produce')
  })
})
