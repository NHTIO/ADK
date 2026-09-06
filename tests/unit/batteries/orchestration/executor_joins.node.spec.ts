import { describe, it, expect } from 'vitest'
import { executePlan } from '../../../../src/batteries/orchestration/executor'
import { freezePlan } from '../../../../src/batteries/orchestration/validation'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import {
  NodeRef,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/encoding'
import type {
  PlanOp,
  PlanNode,
  PlanEdge,
  RunEvent,
  BranchId,
  RunOptions,
  ApprovalRecord,
  PredicateEvaluator,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * Joins are the subtlest rule in this design, and the one place where "the run completed" and
 * "the run was correct" look identical from outside — a join that fires on every arrival instead
 * of at its barrier still reports `completed`, having run everything downstream once per route.
 * That is exactly how a broken join shipped: WP 07 landed with none of its specified suites, and
 * the one committed executor test covered a two-node plan.
 *
 * So every case here asserts a COUNT or an IDENTITY rather than an outcome.
 */
describe('join barriers correlate, merge and fire exactly once', () => {
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
  const join = (id: string): PlanNode => ({ id, kind: 'join', definition: {} }) as PlanNode
  const edge = (id: string, from: string, to: string, handle = 'always'): PlanEdge =>
    ({ id, from, to, handle }) as PlanEdge

  interface RunResult {
    frozen: boolean
    issues: string[]
    outcome?: string
    interruption?: unknown
    events: RunEvent[]
    invoked: { tool: string; args: Record<string, unknown> }[]
  }

  /** The real lifecycle, written out rather than over-abstracted so a failure is readable. */
  const execute = async (
    planId: string,
    nodes: PlanNode[],
    edges: PlanEdge[],
    evaluators: PredicateEvaluator[] = []
  ): Promise<RunResult> => {
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
      ...edges.map((e) => op({ op: 'add_edge', edge: e })),
    ])

    const frozen = await freezePlan(store, planId, {
      invocable: INVOCABLE as never,
      evaluators,
    })
    if (!frozen.ok) {
      return { frozen: false, issues: frozen.issues.map((i) => i.code), events: [], invoked: [] }
    }

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

    const invoked: { tool: string; args: Record<string, unknown> }[] = []
    const options = {
      input: {},
      invokeCall: async (req: { tool: string; args: Record<string, unknown> }) => {
        invoked.push({ tool: req.tool, args: req.args })
        return `from-${req.tool}`
      },
      reason: async () => ({}),
      evaluators,
    } as unknown as RunOptions

    const projection = await executePlan(store, planId, options)
    return {
      frozen: true,
      issues: [],
      outcome: projection.outcome,
      interruption: projection.interruption,
      events: await store.readRunEvents(planId),
      invoked,
    }
  }

  const settledIds = (events: RunEvent[]): string[] =>
    events.filter((e) => e.kind === 'node_settled').map((e) => e.frame.nodeId)

  const settlementsOf = (events: RunEvent[], nodeId: string) =>
    events.filter(
      (e): e is Extract<RunEvent, { kind: 'node_settled' }> =>
        e.kind === 'node_settled' && e.frame.nodeId === nodeId
    )

  /** The canonical diamond: `entry→a; a→b; a→c; b→j; c→j; j→after`. */
  const DIAMOND_NODES = [entry, call('a'), call('b'), call('c'), join('j'), call('after')]
  const DIAMOND_EDGES = [
    edge('e0', 'entry', 'a'),
    edge('e1', 'a', 'b'),
    edge('e2', 'a', 'c'),
    edge('e3', 'b', 'j'),
    edge('e4', 'c', 'j'),
    edge('e5', 'j', 'after'),
  ]

  describe('the canonical diamond', () => {
    it('is ACCEPTED at freeze, and its two arrivals share ONE barrier', async () => {
      // The case an immediate-predecessor rule wrongly refused and a drop-last-segment
      // correlation key wrongly split.
      const r = await execute('diamond', DIAMOND_NODES, DIAMOND_EDGES)

      expect(r.frozen).toBe(true)
      expect(r.outcome).toBe('completed')
      // ONE settlement for the join — not one per arrival.
      expect(settlementsOf(r.events, 'j')).toHaveLength(1)
    })

    it('runs the post-join node EXACTLY ONCE, however many routes converged', async () => {
      // THE REGRESSION. A join that settles per arrival fires its outgoing edge per arrival, so
      // `after` ran twice — while the run still reported `completed`. For a staged tool call past
      // an approval gate, that is a duplicated side effect.
      const r = await execute('once', DIAMOND_NODES, DIAMOND_EDGES)

      expect(r.invoked.filter((i) => i.tool === 'after')).toHaveLength(1)
      expect(settlementsOf(r.events, 'after')).toHaveLength(1)
      expect(settledIds(r.events)).toEqual(['entry', 'a', 'b', 'c', 'j', 'after'])
    })

    it('settles under a MERGED identity that retains the correlation prefix', async () => {
      const r = await execute('identity', DIAMOND_NODES, DIAMOND_EDGES)
      const merged = settlementsOf(r.events, 'j')[0]!.frame.branchId

      // The prefix is retained and the join segment APPENDED. A bare join segment is a graph
      // constant, so two executions of one fork would render identically and collide.
      expect(merged.segments).toEqual([
        { edge: 'e0' },
        { join: 'j', of: ['e3', 'e4'] },
      ] as BranchId['segments'])
    })

    it('names ALL incoming edges in `of`, not merely the arrived subset', async () => {
      // `of` being a graph constant is what makes a downstream `NodeRef` to a post-join node
      // authorable at freeze, before anyone knows which routes will fire.
      const r = await execute('of-const', DIAMOND_NODES, DIAMOND_EDGES)
      const segment = settlementsOf(r.events, 'j')[0]!.frame.branchId.segments[1]!

      expect(segment).toMatchObject({ of: ['e3', 'e4'] })
    })

    it('emits one provenance item per incoming edge, sorted by `via`', async () => {
      // A join contributes no data of its own — it is a barrier — so its items are provenance,
      // the only thing it actually knows. Leaving the shape unstated would let one implementation
      // emit `{}` and another wrap arrival tables: incompatible observable APIs.
      const r = await execute('items', DIAMOND_NODES, DIAMOND_EDGES)
      const items = settlementsOf(r.events, 'j')[0]!.outcome as {
        output: { items: { json: Record<string, unknown> }[] }
      }

      expect(items.output.items).toHaveLength(2)
      expect(items.output.items.map((i) => i.json.via)).toEqual(['e3', 'e4'])
      expect(items.output.items.map((i) => i.json.from)).toEqual(['b', 'c'])
      for (const item of items.output.items) expect(typeof item.json.branch).toBe('string')
    })
  })

  describe('the successor inherits a UNION of the contributing branches', () => {
    it('resolves a NodeRef against an output produced on EITHER branch', async () => {
      // Without the union `after` can see at most one contributor, and the whole point of a join
      // — bringing two branches' results together — is unreachable.
      const after = call('after', {
        args: {
          fromB: new NodeRef('b', 'first', 'value'),
          fromC: new NodeRef('c', 'first', 'value'),
        },
      })
      const r = await execute(
        'union',
        [entry, call('a'), call('b'), call('c'), join('j'), after],
        DIAMOND_EDGES
      )

      expect(r.outcome).toBe('completed')
      expect(r.invoked.find((i) => i.tool === 'after')?.args).toEqual({
        fromB: 'from-b',
        fromC: 'from-c',
      })
    })

    it("lets a downstream node read the join's own provenance by naming the merged branch", async () => {
      // The merged identity is a graph constant, so it is authorable at freeze — which is what
      // makes "which routes converged?" answerable in a downstream predicate.
      const mergedBranch = {
        segments: [{ edge: 'e0' }, { join: 'j', of: ['e3', 'e4'] }],
      } as unknown as BranchId
      const after = call('after', {
        args: { routes: new NodeRef('j', 'all', undefined, mergedBranch) },
      })
      const r = await execute(
        'provenance',
        [entry, call('a'), call('b'), call('c'), join('j'), after],
        DIAMOND_EDGES
      )

      expect(r.outcome).toBe('completed')
      const routes = r.invoked.find((i) => i.tool === 'after')?.args.routes as Record<
        string,
        unknown
      >[]
      expect(routes.map((x) => x.via)).toEqual(['e3', 'e4'])
    })

    it('does not collide two nodes reached via different POST-JOIN paths', async () => {
      // The route-reset bug: a join segment must EXTEND the route, not replace it. If it
      // replaced, `x` and `y` would share a branch key and overwrite each other's outputs.
      const r = await execute(
        'post-paths',
        [entry, call('a'), call('b'), call('c'), join('j'), call('x'), call('y')],
        [...DIAMOND_EDGES.slice(0, 5), edge('e5', 'j', 'x'), edge('e6', 'j', 'y')]
      )

      const branches = [...settlementsOf(r.events, 'x'), ...settlementsOf(r.events, 'y')].map((e) =>
        JSON.stringify(e.frame.branchId)
      )

      expect(branches).toHaveLength(2)
      expect(new Set(branches).size).toBe(2)
    })
  })

  describe('correlation keeps unrelated barriers apart', () => {
    it('gives a diamond DOWNSTREAM of another diamond its own barrier that closes', async () => {
      // Found a real bug in the first draft of this implementation: the fork walk did not advance
      // across an earlier JOIN segment, so the inner diamond's two arrivals truncated to
      // different prefixes, opened two barriers holding one arrival each, and the run halted
      // `join_unsatisfiable` — a deadlock on a plan freeze had accepted.
      const nodes = [
        entry,
        call('o'),
        call('p1'),
        call('p2'),
        join('jo'),
        call('fork'),
        call('l'),
        call('r'),
        join('ji'),
        call('tail'),
      ]
      const edges = [
        edge('a0', 'entry', 'o'),
        edge('a1', 'o', 'p1'),
        edge('a2', 'o', 'p2'),
        edge('a3', 'p1', 'jo'),
        edge('a4', 'p2', 'jo'),
        edge('a5', 'jo', 'fork'),
        edge('a6', 'fork', 'l'),
        edge('a7', 'fork', 'r'),
        edge('a8', 'l', 'ji'),
        edge('a9', 'r', 'ji'),
        edge('a10', 'ji', 'tail'),
      ]
      const r = await execute('nested', nodes, edges)

      expect(r.frozen).toBe(true)
      expect(r.outcome).toBe('completed')
      expect(settlementsOf(r.events, 'ji')).toHaveLength(1)
      expect(settlementsOf(r.events, 'tail')).toHaveLength(1)
      expect(r.invoked.filter((i) => i.tool === 'tail')).toHaveLength(1)
    })

    it('fires ONCE on an ASYMMETRIC diamond, where one route is far longer', async () => {
      // Every diamond above is symmetric — both routes are one hop. This one is 1 hop against 3,
      // so the short branch arrives and PARKS while the long branch is still three nodes from the
      // join. It is the shape that would expose a barrier keyed on anything time- or
      // arrival-order-dependent, and the shape a real plan actually has: work of uneven cost
      // converging on a single gather step.
      const nodes = [
        entry,
        call('fork'),
        call('short'),
        call('l1'),
        call('l2'),
        call('l3'),
        join('j'),
        call('after'),
      ]
      const edges = [
        edge('e0', 'entry', 'fork'),
        edge('e1', 'fork', 'short'),
        edge('e2', 'fork', 'l1'),
        edge('e3', 'l1', 'l2'),
        edge('e4', 'l2', 'l3'),
        edge('e5', 'short', 'j'),
        edge('e6', 'l3', 'j'),
        edge('e7', 'j', 'after'),
      ]
      const r = await execute('asymmetric', nodes, edges)

      expect(r.frozen).toBe(true)
      expect(r.outcome).toBe('completed')
      expect(settlementsOf(r.events, 'j')).toHaveLength(1)
      expect(r.invoked.filter((i) => i.tool === 'after')).toHaveLength(1)
      // The long branch really did run to completion before the join settled.
      expect(r.invoked.map((i) => i.tool)).toEqual(['fork', 'short', 'l1', 'l2', 'l3', 'after'])
    })

    it('halts rather than hangs when a branch leaves a route unfired', async () => {
      // A `branch` inside a diamond can leave a route unfired, so the barrier never completes.
      // That is not a hang: the run settles `halted` with `join_unsatisfiable` naming the join.
      const cell: PredicateEvaluator = {
        id: 'cell',
        load: async () => {},
        validate: async () => {},
        evaluate: async () => ({ kind: 'branch', matched: true }),
      }
      const branchNode: PlanNode = {
        id: 'br',
        kind: 'branch',
        definition: { evaluator: 'cell', predicate: {} },
      } as PlanNode
      const nodes = [
        entry,
        call('fork'),
        branchNode,
        call('taken'),
        call('skipped'),
        join('j2'),
        call('after2'),
      ]
      const edges = [
        edge('b0', 'entry', 'fork'),
        edge('b1', 'fork', 'br'),
        edge('b2', 'fork', 'taken'),
        edge('b3', 'br', 'skipped', 'no_match'),
        edge('b4', 'taken', 'j2'),
        edge('b5', 'skipped', 'j2'),
        edge('b6', 'j2', 'after2'),
      ]
      const r = await execute('unsatisfiable', nodes, edges, [cell])

      expect(r.outcome).toBe('halted')
      expect(r.interruption).toMatchObject({ kind: 'join_unsatisfiable', nodeId: 'j2' })
      // And crucially: the successor never ran on a partial barrier.
      expect(r.invoked.filter((i) => i.tool === 'after2')).toHaveLength(0)
    })
  })

  describe('both degenerate shapes are refused at FREEZE', () => {
    it('refuses `entry→a→join` — only one fork→join route', async () => {
      const r = await execute(
        'degenerate-linear',
        [entry, call('a'), join('j'), call('after')],
        [edge('e0', 'entry', 'a'), edge('e1', 'a', 'j'), edge('e2', 'j', 'after')]
      )

      expect(r.frozen).toBe(false)
      expect(r.issues).toContain('join_not_diamond')
    })

    it('refuses a diamond that reconverged before the join', async () => {
      // `fork→left|right→shared→join`: the dominator slides down to `shared`, so the join again
      // sees a single route. Refusing this at freeze is what makes "the immediate dominator IS
      // the divergence point" true rather than accidental.
      const r = await execute(
        'degenerate-reconverged',
        [entry, call('fork'), call('l'), call('r'), call('shared'), join('j'), call('after')],
        [
          edge('e0', 'entry', 'fork'),
          edge('e1', 'fork', 'l'),
          edge('e2', 'fork', 'r'),
          edge('e3', 'l', 'shared'),
          edge('e4', 'r', 'shared'),
          edge('e5', 'shared', 'j'),
          edge('e6', 'j', 'after'),
        ]
      )

      expect(r.frozen).toBe(false)
      expect(r.issues.some((c) => c === 'join_not_diamond' || c === 'join_reconvergence')).toBe(
        true
      )
    })
  })
})
