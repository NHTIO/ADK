import { describe, it, expect } from 'vitest'
import { foldOps } from '../../../../src/batteries/orchestration/ops'
import { freezePlan } from '../../../../src/batteries/orchestration/validation'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'
import { approvePlan, computeAuthoritySet } from '../../../../src/batteries/orchestration/approval'
import type {
  PlanOp,
  PlanNode,
  PlanEdge,
  AuthorityClaim,
  ApprovalRecord,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * The permission gate IS the `reviewable → executable` transition, so "approved" and "executable"
 * are one fact and a re-gate needs no enforcement code. What the operator approves is the
 * AUTHORITY SET — the canonicalised union of what the reachable calls claim they may do — bound to
 * the digest of the content they were shown.
 *
 * The failure this exists to prevent is approving a plan nobody saw, so the cases are written
 * against `approvePlan` rather than `transition`: by contract the store checks only lifecycle
 * state and digest, and asserting the authority gate against it would test the wrong component.
 */
describe('the approval gate binds the authority set', () => {
  const claim = (capability: string, scope: string, verb: string): AuthorityClaim =>
    ({ capability, scope, verb }) as AuthorityClaim

  const entry: PlanNode = { id: 'entry', kind: 'entry', definition: { input: [] } } as PlanNode
  const call = (id: string, authority: AuthorityClaim[]): PlanNode =>
    ({
      id,
      kind: 'call',
      definition: {
        tool: 't',
        args: {},
        output: [],
        onMissingValue: 'fail',
        authority,
        replaySafe: true,
        onIndeterminate: 'halt',
      },
    }) as PlanNode
  const edge = (id: string, from: string, to: string): PlanEdge =>
    ({ id, from, to, handle: 'always' }) as PlanEdge

  const viewOf = (nodes: PlanNode[], edges: PlanEdge[] = []) => {
    const ops = [
      ...nodes.map(
        (node, i) =>
          ({
            opId: `n${i}`,
            actorId: 'a',
            lamport: i + 1,
            at: 'x',
            op: 'add_node',
            node,
          }) as unknown as PlanOp
      ),
      ...edges.map(
        (e, i) =>
          ({
            opId: `e${i}`,
            actorId: 'a',
            lamport: 100 + i,
            at: 'x',
            op: 'add_edge',
            edge: e,
          }) as unknown as PlanOp
      ),
    ]
    return { view: foldOps('p', ops).view, ops }
  }

  describe('computeAuthoritySet canonicalises', () => {
    it('de-duplicates and sorts stably, whatever order the claims were authored in', () => {
      const forward = viewOf(
        [
          entry,
          call('a', [claim('file', '/tmp', 'read'), claim('net', 'api', 'update')]),
          call('b', [claim('net', 'api', 'update'), claim('file', '/tmp', 'read')]),
        ],
        [edge('e0', 'entry', 'a'), edge('e1', 'a', 'b')]
      ).view
      const reversed = viewOf(
        [
          entry,
          call('a', [claim('net', 'api', 'update'), claim('file', '/tmp', 'read')]),
          call('b', [claim('file', '/tmp', 'read'), claim('net', 'api', 'update')]),
        ],
        [edge('e0', 'entry', 'a'), edge('e1', 'a', 'b')]
      ).view

      const set = computeAuthoritySet(forward)
      expect(set).toHaveLength(2)
      // Stable across input order — otherwise "the same plan" would present two different sets.
      expect(computeAuthoritySet(reversed)).toEqual(set)
    })

    it('unions over REACHABLE calls only', () => {
      // An unreachable node cannot run, so binding its authority would make the operator approve
      // a power the plan can never exercise.
      const { view } = viewOf(
        [
          entry,
          call('reached', [claim('file', '/a', 'read')]),
          call('orphan', [claim('file', '/b', 'delete')]),
        ],
        [edge('e0', 'entry', 'reached')]
      )

      const set = computeAuthoritySet(view)
      expect(set).toEqual([claim('file', '/a', 'read')])
      expect(set.some((c) => c.verb === 'delete')).toBe(false)
    })

    it('omits a claim an authority layer reports already live', () => {
      const { view } = viewOf(
        [entry, call('a', [claim('file', '/a', 'read'), claim('net', 'api', 'create')])],
        [edge('e0', 'entry', 'a')]
      )

      const set = computeAuthoritySet(view, (c) => c.capability === 'file')
      expect(set).toEqual([claim('net', 'api', 'create')])
    })
  })

  describe('approvePlan refuses what the operator did not see', () => {
    /** A frozen, `reviewable` plan and the store holding it. */
    const frozenPlan = async (planId: string, nodes: PlanNode[], edges: PlanEdge[]) => {
      const store = new InMemoryPlanStore()
      await store.createPlan(planId)
      const { ops } = viewOf(nodes, edges)
      await store.appendOps(planId, ops)
      const frozen = await freezePlan(store, planId, {
        invocable: { has: () => true, names: () => ['t'], returns: () => undefined } as never,
        evaluators: [],
      })
      return { store, frozen }
    }

    const LINEAR_NODES = [entry, call('a', [claim('file', '/tmp', 'update')])]
    const LINEAR_EDGES = [edge('e0', 'entry', 'a')]

    const record = (
      planId: string,
      digest: string,
      authoritySet: AuthorityClaim[]
    ): ApprovalRecord => ({
      planId,
      digest,
      authoritySet,
      decidedBy: 'operator',
      decidedAt: new Date().toISOString(),
      disposition: 'approved',
    })

    it('refuses a record whose authoritySet OMITS a claim the plan carries', async () => {
      // The core failure: approving a narrower power than the plan will actually exercise.
      const { store, frozen } = await frozenPlan('omits', LINEAR_NODES, LINEAR_EDGES)
      expect(frozen.ok).toBe(true)
      const state = await store.readState('omits')

      const result = await approvePlan(store, 'omits', record('omits', state.digest, []))

      expect(result.ok).toBe(false)
      // And the refusal happened BEFORE the store was touched: the plan is still reviewable.
      const after = await store.readState('omits')
      expect(after.state).toBe('reviewable')
    })

    it('refuses a record claiming MORE authority than the plan carries', async () => {
      const { store } = await frozenPlan('more', LINEAR_NODES, LINEAR_EDGES)
      const state = await store.readState('more')

      const result = await approvePlan(
        store,
        'more',
        record('more', state.digest, [
          claim('file', '/tmp', 'update'),
          claim('file', '/etc', 'delete'),
        ])
      )

      expect(result.ok).toBe(false)
      const after = await store.readState('more')
      expect(after.state).toBe('reviewable')
    })

    it('accepts the exact set, order-insensitively, and activates the plan', async () => {
      const nodes = [
        entry,
        call('a', [claim('file', '/tmp', 'update'), claim('net', 'api', 'read')]),
      ]
      const { store } = await frozenPlan('exact', nodes, LINEAR_EDGES)
      const state = await store.readState('exact')

      // Deliberately supplied in the opposite order to the canonical one.
      const set = [
        ...computeAuthoritySet(foldOps('exact', await store.readOps('exact')).view),
      ].reverse()
      const result = await approvePlan(store, 'exact', record('exact', state.digest, set))

      expect(result.ok).toBe(true)
      const after = await store.readState('exact')
      expect(after.state).toBe('executable')
    })

    it('PASSES for a purely linear plan with a side effect and no branch or select', async () => {
      // The case that must not be broken by any of the above: the ordinary plan.
      const { store } = await frozenPlan('linear', LINEAR_NODES, LINEAR_EDGES)
      const state = await store.readState('linear')

      const result = await approvePlan(
        store,
        'linear',
        record('linear', state.digest, [claim('file', '/tmp', 'update')])
      )

      expect(result.ok).toBe(true)
    })

    it('activates all-or-nothing: a refused approval leaves no partial state', async () => {
      const { store } = await frozenPlan('atomic', LINEAR_NODES, LINEAR_EDGES)
      const before = await store.readState('atomic')

      await approvePlan(store, 'atomic', record('atomic', before.digest, []))

      const after = await store.readState('atomic')
      expect(after.state).toBe('reviewable')
      expect(after.digest).toBe(before.digest)
      expect(after.revision).toBe(before.revision)
    })

    it('REFUSES an approval record carrying a stale digest', async () => {
      // Found by the AI review panel, at severity critical, and it was right.
      //
      // `approvePlan` validated the authority set and then passed `view.digest` — the CURRENT
      // fold — as `expectedDigest`, never comparing `record.digest`. Two revisions can carry
      // IDENTICAL authority while differing in the staged arguments an operator actually read,
      // so an approval for D1 committed against D2: operator approves a call on `/tmp/SAFE`,
      // someone unfreezes and rewrites the arg to `/tmp/DANGEROUS`, refreezes, and the D1
      // approval activates the modified plan. That is the exact failure the digest exists to
      // prevent.
      //
      // My own suite missed it because the existing stale-approval case drove
      // `store.transition` — which DOES check the digest — instead of `approvePlan`, which did
      // not. The suite's own header says to assert the gate against `approvePlan`.
      const { store } = await frozenPlan('stale-digest', LINEAR_NODES, LINEAR_EDGES)
      const d1 = await store.readState('stale-digest')

      // Unfreeze, change a staged ARGUMENT (authority is untouched), refreeze.
      await store.transition('stale-digest', {
        from: 'reviewable',
        to: 'editable',
        expectedDigest: d1.digest,
      })
      await store.appendOps('stale-digest', [
        {
          opId: 'edit',
          actorId: 'b',
          lamport: 500,
          at: 'x',
          op: 'set_node_field',
          nodeId: 'a',
          path: 'args.path',
          value: '/tmp/DANGEROUS',
        } as unknown as PlanOp,
      ])
      await freezePlan(store, 'stale-digest', {
        invocable: { has: () => true, names: () => ['t'], returns: () => undefined } as never,
        evaluators: [],
      })
      const d2 = await store.readState('stale-digest')
      expect(d2.digest).not.toBe(d1.digest)

      // The operator's decision, still carrying D1 — and the SAME authority set, so the
      // set-equality check alone cannot catch it.
      const result = await approvePlan(
        store,
        'stale-digest',
        record('stale-digest', d1.digest, [claim('file', '/tmp', 'update')])
      )

      expect(result.ok).toBe(false)
      const after = await store.readState('stale-digest')
      expect(after.state).toBe('reviewable')
    })

    it('REFUSES an approval record naming a different plan', async () => {
      const { store } = await frozenPlan('wrong-plan', LINEAR_NODES, LINEAR_EDGES)
      const state = await store.readState('wrong-plan')

      const result = await approvePlan(store, 'wrong-plan', {
        ...record('some-other-plan', state.digest, [claim('file', '/tmp', 'update')]),
      })

      expect(result.ok).toBe(false)
      const after = await store.readState('wrong-plan')
      expect(after.state).toBe('reviewable')
    })

    it('persists a FORGED authority set via a direct transition — and grants nothing by it', async () => {
      // Surfaced by the AI review panel, and the finding is half right, which is the useful half.
      //
      // TRUE: `transition` does not validate `authoritySet`. A caller that bypasses `approvePlan`
      // can persist a record claiming authority the plan never had. That is by design — the store
      // cannot recompute the set without battery knowledge — but it means `readApproval` can hand
      // back a record that misdescribes the plan, which is an AUDIT-TRAIL defect.
      //
      // FALSE: that it authorises anything. The executor never reads `authoritySet`; what a run
      // may invoke is bounded by the tier-C allowlist at freeze. This case pins BOTH halves, so
      // neither can drift: if a future change ever lets a forged set widen what runs, the second
      // assertion fails.
      const { store } = await frozenPlan('forged', LINEAR_NODES, LINEAR_EDGES)
      const state = await store.readState('forged')

      const forged = record('forged', state.digest, [
        claim('file', '/etc', 'delete'), // never claimed by any node in this plan
      ])
      const committed = await store.transition('forged', {
        from: 'reviewable',
        to: 'executable',
        expectedDigest: state.digest,
        approval: forged,
      })

      // Half one: it IS persisted, and reads back exactly as written.
      expect(committed.ok).toBe(true)
      const stored = await store.readApproval('forged')
      expect(stored?.authoritySet).toEqual([claim('file', '/etc', 'delete')])

      // Half two: the plan's REAL reachable authority is unchanged by it. Recomputing from the
      // graph — which is what an auditor should do — disagrees with the stored copy.
      const ops = await store.readOps('forged')
      const actual = computeAuthoritySet(foldOps('forged', ops).view)
      expect(actual).toEqual([claim('file', '/tmp', 'update')])
      expect(actual).not.toEqual(stored?.authoritySet)
    })

    it('binds to the digest, so an edit between freeze and approve invalidates the decision', async () => {
      // The stale-approval interleaving: A reads reviewable@D1, B unfreezes/edits/refreezes to D2,
      // and A's approval for D1 must not commit.
      const { store } = await frozenPlan('stale', LINEAR_NODES, LINEAR_EDGES)
      const d1 = await store.readState('stale')

      await store.transition('stale', {
        from: 'reviewable',
        to: 'editable',
        expectedDigest: d1.digest,
      })
      await store.appendOps('stale', [
        {
          opId: 'later',
          actorId: 'b',
          lamport: 999,
          at: 'x',
          op: 'add_node',
          node: call('b', [claim('file', '/tmp', 'update')]),
        } as unknown as PlanOp,
        {
          opId: 'later-e',
          actorId: 'b',
          lamport: 1000,
          at: 'x',
          op: 'add_edge',
          edge: edge('e1', 'a', 'b'),
        } as unknown as PlanOp,
      ])
      await freezePlan(store, 'stale', {
        invocable: { has: () => true, names: () => ['t'], returns: () => undefined } as never,
        evaluators: [],
      })

      const d2 = await store.readState('stale')
      expect(d2.digest).not.toBe(d1.digest)

      // A's decision, still carrying D1.
      const result = await store.transition('stale', {
        from: 'reviewable',
        to: 'executable',
        expectedDigest: d1.digest,
        approval: record('stale', d1.digest, [claim('file', '/tmp', 'update')]),
      })

      expect(result.ok).toBe(false)
      const stillReviewable = await store.readState('stale')
      expect(stillReviewable.state).toBe('reviewable')
    })
  })
})
