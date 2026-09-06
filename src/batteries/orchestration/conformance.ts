/**
 * The shared conformance suite for {@link PlanStore} backends.
 *
 * A consumer who owns their own plan store imports {@link runPlanStoreConformance} and drives it
 * with a factory that mints a fresh store per case. Each case is a contract assertion written
 * against the {@link PlanStore} interface only — never against in-memory internals — so a passing
 * suite proves the backend honours the same contract the shipped reference implementation does.
 *
 * Public, deep-import-only (`@nhtio/adk/batteries/orchestration/conformance`). It imports
 * `vitest`, an optional peer you install to run the suite; it is never pulled in by the battery
 * barrel.
 *
 * @module @nhtio/adk/batteries/orchestration/conformance
 */

import { foldOps } from './ops'
import { isObject } from '@nhtio/adk/guards'
import { describe, expect, it } from 'vitest'
import type { PlanStore, TransitionRequest } from './store'
import type {
  ApprovalRecord,
  ArtifactTable,
  PlanOp,
  PlanNode,
  PendingFrame,
  RunEvent,
  SpooledArtifactLike,
} from './types'

/**
 * Drive a plan store through the shared contract suite.
 *
 * @param label - A human label for the store under test, used in the suite title.
 * @param makeStore - A factory returning a FRESH store for each case, so no case shares state with
 *   another. May be async.
 */
export const runPlanStoreConformance = (
  label: string,
  makeStore: () => PlanStore | Promise<PlanStore>
): void => {
  describe(`PlanStore conformance: ${label}`, () => {
    // ── helpers ────────────────────────────────────────────────────────────────
    /** A minimal, well-shaped `entry` node for authoring ops. */
    const entryNode = (id: string): PlanNode => ({
      id,
      kind: 'entry',
      definition: { input: [] },
    })

    /** An `add_node` op for the given node, with a unique identity. */
    const addNodeOp = (node: PlanNode, lamport: number): PlanOp => ({
      op: 'add_node',
      node,
      opId: `op-${lamport}`,
      actorId: 'conformance',
      lamport,
      at: '2024-01-01T00:00:00.000Z',
    })

    /** A valid approval record bound to a digest. */
    const approvalFor = (planId: string, digest: string): ApprovalRecord => ({
      planId,
      digest,
      authoritySet: [],
      decidedBy: 'conformance',
      decidedAt: '2024-01-01T00:00:00.000Z',
      disposition: 'approved',
    })

    /** Append a single node and return the resulting digest, asserting the append succeeded. */
    const appendNode = async (
      store: PlanStore,
      planId: string,
      node: PlanNode,
      lamport: number
    ) => {
      const result = await store.appendOps(planId, [addNodeOp(node, lamport)])
      expect(result).toMatchObject({ ok: true })
      return (result as { digest: string }).digest
    }

    /** Drive a plan to `executable` at the digest of a single authored node, and return that digest. */
    const makeExecutable = async (store: PlanStore, planId: string) => {
      const digest = await appendNode(store, planId, entryNode('entry'), 1)
      await store.transition(planId, { from: 'editable', to: 'reviewable', expectedDigest: digest })
      await store.transition(planId, {
        from: 'reviewable',
        to: 'executable',
        expectedDigest: digest,
        approval: approvalFor(planId, digest),
      })
      return digest
    }

    // ── 1. genesis ─────────────────────────────────────────────────────────────
    it('createPlan mints editable at revision 0 with an empty op log and a non-empty digest', async () => {
      const store = await makeStore()
      const created = await store.createPlan('p1')
      expect(created).toMatchObject({ ok: true, revision: 0 })
      const state = await store.readState('p1')
      expect(state.state).toBe('editable')
      expect(state.revision).toBe(0)
      expect(state.digest.length).toBeGreaterThan(0)
      expect(await store.readOps('p1')).toEqual([])

      const appended = await store.appendOps('p1', [addNodeOp(entryNode('entry'), 1)])
      expect(appended).toMatchObject({ ok: true, revision: 1 })
    })

    // ── 2. duplicate id ────────────────────────────────────────────────────────
    it('createPlan refuses a duplicate id with reason duplicate_id', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const dup = await store.createPlan('p1')
      expect(dup).toMatchObject({ ok: false, reason: 'duplicate_id' })
    })

    // ── 3. appendOps refused in reviewable ────────────────────────────────────
    it('appendOps is refused in reviewable with reason not_editable and the real state', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await appendNode(store, 'p1', entryNode('entry'), 1)
      await store.transition('p1', { from: 'editable', to: 'reviewable', expectedDigest: d1 })

      const result = await store.appendOps('p1', [addNodeOp(entryNode('entry2'), 2)])
      expect(result).toMatchObject({
        ok: false,
        reason: 'not_editable',
        actual: { state: 'reviewable' },
      })
    })

    // ── 4. appendOps refused in executable, digest unchanged ─────────────────
    it('appendOps is refused in executable with not_editable and leaves the digest unchanged', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await makeExecutable(store, 'p1')

      const result = await store.appendOps('p1', [addNodeOp(entryNode('entry2'), 2)])
      expect(result).toMatchObject({
        ok: false,
        reason: 'not_editable',
        actual: { state: 'executable' },
      })
      const state = await store.readState('p1')
      expect(state.digest).toBe(d1)
    })

    // ── 5. stale expectedRevision ─────────────────────────────────────────────
    it('appendOps with a stale expectedRevision returns revision_moved', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      await appendNode(store, 'p1', entryNode('entry'), 1)
      const result = await store.appendOps('p1', [addNodeOp(entryNode('entry2'), 2)], 0)
      expect(result).toMatchObject({ ok: false, reason: 'revision_moved' })
    })

    // ── 6. stale-approval interleaving ────────────────────────────────────────
    it('a transition gated on a stale digest is refused with digest_mismatch and leaves the plan reviewable', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await appendNode(store, 'p1', entryNode('entry'), 1)
      await store.transition('p1', { from: 'editable', to: 'reviewable', expectedDigest: d1 })

      // Unfreeze, append, refreeze — the plan now sits at a NEW digest D2.
      await store.transition('p1', { from: 'reviewable', to: 'editable', expectedDigest: d1 })
      const d2 = await appendNode(store, 'p1', entryNode('entry2'), 2)
      await store.transition('p1', { from: 'editable', to: 'reviewable', expectedDigest: d2 })

      // Gate with the STALE digest D1 — must be refused, not silently approved.
      const gate = await store.transition('p1', {
        from: 'reviewable',
        to: 'executable',
        expectedDigest: d1,
        approval: approvalFor('p1', d1),
      })
      expect(gate).toMatchObject({ ok: false, reason: 'digest_mismatch' })

      const state = await store.readState('p1')
      expect(state.state).toBe('reviewable')
      expect(await store.readApproval('p1')).toBeUndefined()
    })

    // ── 7. approval persists in the same commit ───────────────────────────────
    it('a successful gate persists the approval bound to the gated digest', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await appendNode(store, 'p1', entryNode('entry'), 1)
      await store.transition('p1', { from: 'editable', to: 'reviewable', expectedDigest: d1 })
      const gate = await store.transition('p1', {
        from: 'reviewable',
        to: 'executable',
        expectedDigest: d1,
        approval: approvalFor('p1', d1),
      })
      expect(gate).toMatchObject({ ok: true })
      const approval = await store.readApproval('p1')
      expect(approval?.digest).toBe(d1)
    })

    // ── 8. illegal transition pair ────────────────────────────────────────────
    it('an illegal transition pair is answered with ok:false and reason illegal_transition, not thrown', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      await makeExecutable(store, 'p1')

      // Pass the plan's REAL current digest so state and digest can never be the reason —
      // only the illegal pair (executable -> editable) can be. This isolates the legality
      // check from the store's state/digest-first ordering.
      const { digest } = await store.readState('p1')

      // A BYO store may receive a request the type system did not police (e.g. over a wire).
      const request = {
        from: 'executable',
        to: 'editable',
        expectedDigest: digest,
      } as unknown as TransitionRequest
      const result = await store.transition('p1', request)
      expect(result).toMatchObject({ ok: false, reason: 'illegal_transition' })
    })

    // ── 8b. stale digest on a legal pair ───────────────────────────────────────
    it('a well-formed pair with a stale digest is refused with digest_mismatch', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      // Drive the plan to `reviewable`, so that `reviewable -> executable` below is a LEGAL pair
      // and the digest is the only thing wrong with the request.
      const digest = await appendNode(store, 'p1', entryNode('entry'), 1)
      await store.transition('p1', { from: 'editable', to: 'reviewable', expectedDigest: digest })

      // A legal pair gated on a bogus digest must be refused with digest_mismatch — the check the
      // store performs before it considers applying the pair.
      const result = await store.transition('p1', {
        from: 'reviewable',
        to: 'executable',
        expectedDigest: 'stale',
        approval: approvalFor('p1', 'stale'),
      })
      expect(result).toMatchObject({ ok: false, reason: 'digest_mismatch' })

      // The refusal left the plan untouched: still reviewable, still at its real digest.
      const state = await store.readState('p1')
      expect(state.state).toBe('reviewable')
      expect(state.digest).toBe(digest)
    })

    // ── 9. claimRun exactly once ──────────────────────────────────────────────
    it('claimRun succeeds exactly once under concurrent claimants', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await makeExecutable(store, 'p1')

      const [a, b] = await Promise.all([store.claimRun('p1', d1), store.claimRun('p1', d1)])
      const winners = [a, b].filter((r) => r.ok === true)
      const losers = [a, b].filter((r) => r.ok === false)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0]).toMatchObject({ ok: false, reason: 'run_already_claimed' })
      expect((losers[0] as { existingRunId?: string }).existingRunId).toBe(
        (winners[0] as { runId: string }).runId
      )
    })

    // ── 10. claimRun re-entry ─────────────────────────────────────────────────
    it('claimRun re-enters a run with resumeRunId, and refuses unknown or settled runs', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await makeExecutable(store, 'p1')

      const first = await store.claimRun('p1', d1)
      expect(first).toMatchObject({ ok: true, resumed: false })
      const runId = (first as { runId: string }).runId

      const resumed = await store.claimRun('p1', d1, runId)
      expect(resumed).toMatchObject({ ok: true, resumed: true })

      const unknown = await store.claimRun('p1', d1, 'no-such-run')
      expect(unknown).toMatchObject({ ok: false, reason: 'run_not_found' })

      await store.appendRunEvents('p1', runId, [
        { kind: 'run_settled', outcome: 'completed', at: '2024-01-01T00:00:00.000Z' },
      ])
      const settled = await store.claimRun('p1', d1, runId)
      expect(settled).toMatchObject({ ok: false, reason: 'run_already_settled' })
    })

    it('claimRun re-enters after an ABORTED or HALTED run, but not after a completed one', async () => {
      // `aborted` and `halted` are STOPPING POINTS, not endings. The interruption taxonomy
      // classifies a turn abort as resumable with the frontier intact at the same digest, so a
      // store that treats every `run_settled` as terminal makes `resumeRunId` unusable for
      // exactly the cases it exists to serve — which is what the reference store did, and what
      // this case would have caught.
      for (const outcome of ['aborted', 'halted'] as const) {
        const store = await makeStore()
        await store.createPlan(`resumable-${outcome}`)
        const digest = await makeExecutable(store, `resumable-${outcome}`)

        const started = await store.claimRun(`resumable-${outcome}`, digest)
        const runId = (started as { runId: string }).runId
        await store.appendRunEvents(`resumable-${outcome}`, runId, [
          {
            kind: 'run_interrupted',
            cause: { kind: 'turn_abort' },
            at: '2024-01-01T00:00:00.000Z',
          },
          { kind: 'run_settled', outcome, at: '2024-01-01T00:00:00.000Z' },
        ])

        const again = await store.claimRun(`resumable-${outcome}`, digest, runId)
        expect(again).toMatchObject({ ok: true, resumed: true })
      }
    })

    it('a CLONED plan can be frozen — every state fold carries provenance', async () => {
      // A clone carries `PlanProvenance`, and provenance is DIGESTED. So a store whose
      // `transition`/`readState` folds omit it computes a different digest than `freezePlan`
      // does, the `expectedDigest` check fails, and the clone can never leave `editable`.
      //
      // That breaks the documented recovery path outright: `clonePlan` is what you do after a
      // halting failure, and a clone that cannot be frozen cannot be re-approved or re-run. The
      // reference store had exactly this bug — five folds omitted `record.provenance` while
      // `readProvenance` supplied it everywhere else.
      const store = await makeStore()
      await store.createPlan('conf-clone-src')
      await store.appendOps('conf-clone-src', [addNodeOp(entryNode('entry'), 1)])

      const cloned = await store.clonePlan('conf-clone-src', 'conf-clone-dst')
      expect(cloned).toMatchObject({ ok: true })

      const provenance = await store.readProvenance('conf-clone-dst')
      expect(provenance).toBeDefined()

      // The digest the store reports must be the one a provenance-aware fold produces — that is
      // what `freezePlan` computes and passes as `expectedDigest`.
      const ops = await store.readOps('conf-clone-dst')
      const expected = foldOps('conf-clone-dst', ops, provenance).view.digest
      const state = await store.readState('conf-clone-dst')
      expect(state.digest).toBe(expected)

      // And the transition must actually commit at that digest.
      const moved = await store.transition('conf-clone-dst', {
        from: 'editable',
        to: 'reviewable',
        expectedDigest: expected,
      })
      expect(moved).toMatchObject({ ok: true })
    })

    // ── 11. claimRun preconditions ────────────────────────────────────────────
    it('claimRun is refused with not_executable when not executable and digest_mismatch when the digest moved', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await appendNode(store, 'p1', entryNode('entry'), 1)

      const notExecutable = await store.claimRun('p1', d1)
      expect(notExecutable).toMatchObject({ ok: false, reason: 'not_executable' })

      await makeExecutable(store, 'p1')
      const moved = await store.claimRun('p1', 'stale-digest')
      expect(moved).toMatchObject({ ok: false, reason: 'digest_mismatch' })
    })

    // ── 12. appendRunEvents is one batch ─────────────────────────────────────
    it('appendRunEvents commits its array as one batch so all three events are read back', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await makeExecutable(store, 'p1')
      const claimed = await store.claimRun('p1', d1)
      const runId = (claimed as { runId: string }).runId

      // The commit protocol depends on node_settled + every edge_taken + the new
      // frontier_snapshot landing in a SINGLE commit — a store that commits them one at a time
      // and could interleave is non-conforming.
      const batch: RunEvent[] = [
        { kind: 'run_started', runId, digest: d1, at: '2024-01-01T00:00:00.000Z' },
        {
          kind: 'node_entered',
          frame: {
            nodeId: 'entry',
            kind: 'entry',
            branchId: { segments: [] },
            viaEdgeId: undefined,
          },
          at: '2024-01-01T00:00:00.000Z',
        },
        {
          kind: 'node_settled',
          frame: {
            nodeId: 'entry',
            kind: 'entry',
            branchId: { segments: [] },
            viaEdgeId: undefined,
          },
          outcome: {
            status: 'ok',
            output: { items: [{ json: { ok: true } }], branchId: { segments: [] } },
          },
          at: '2024-01-01T00:00:00.000Z',
        },
      ]
      await store.appendRunEvents('p1', runId, batch)
      const events = await store.readRunEvents('p1', runId)
      expect(events).toHaveLength(3)
      expect(events.map((e) => e.kind)).toEqual(['run_started', 'node_entered', 'node_settled'])
    })

    // ── 13. readOps revision prefix ───────────────────────────────────────────
    it('readOps throughRevision serves a revision prefix and rejects a revision the log never reached', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      await appendNode(store, 'p1', entryNode('entry'), 1)
      await appendNode(store, 'p1', entryNode('entry2'), 2)

      const prefix = await store.readOps('p1', { throughRevision: 1 })
      expect(prefix).toHaveLength(1)
      expect(prefix[0].opId).toBe('op-1')

      await expect(store.readOps('p1', { throughRevision: 99 })).rejects.toThrow()
    })

    // ── 14. clonePlan ─────────────────────────────────────────────────────────
    it('clonePlan yields an editable, unapproved, run-less clone with parent provenance', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await appendNode(store, 'p1', entryNode('entry'), 1)

      const cloned = await store.clonePlan('p1', 'p2')
      expect(cloned).toMatchObject({ ok: true })

      const state = await store.readState('p2')
      expect(state.state).toBe('editable')
      expect(await store.readApproval('p2')).toBeUndefined()
      await expect(store.readRunEvents('p2')).rejects.toThrow()

      const provenance = await store.readProvenance('p2')
      expect(provenance).toMatchObject({
        kind: 'clone',
        parent: 'p1',
        parentDigest: d1,
        parentRevision: 1,
      })

      const missing = await store.clonePlan('no-such', 'p3')
      expect(missing).toMatchObject({ ok: false, reason: 'source_missing' })
    })

    // ── 15. frontier_snapshot artifact handles round-trip ────────────────────
    it('a round-tripped frontier_snapshot preserves artifact handles', async () => {
      const store = await makeStore()
      await store.createPlan('p1')
      const d1 = await makeExecutable(store, 'p1')
      const claimed = await store.claimRun('p1', d1)
      const runId = (claimed as { runId: string }).runId

      // A handle is a pointer, never bytes — the encoding is the store's business, so we assert
      // the PROPERTY (the entry survives the round-trip) rather than any representation.
      const artifact: SpooledArtifactLike = {
        constructor: { toolMethods: [] },
        marker: 'handle',
      }
      const artifacts: ArtifactTable = new Map([['entry:root', artifact]])
      const frame: PendingFrame = {
        frame: {
          nodeId: 'entry',
          kind: 'entry',
          branchId: { segments: [] },
          viaEdgeId: undefined,
        },
        outputs: new Map(),
        artifacts,
      }
      const snapshot: RunEvent = {
        kind: 'frontier_snapshot',
        frames: [frame],
        joins: [],
        at: '2024-01-01T00:00:00.000Z',
      }
      await store.appendRunEvents('p1', runId, [snapshot])

      const events = await store.readRunEvents('p1', runId)
      const readBack = events.find((e) => e.kind === 'frontier_snapshot')
      expect(readBack).toBeDefined()
      const readFrame = (readBack as { frames: PendingFrame[] }).frames[0]
      const entry = readFrame.artifacts.get('entry:root')
      expect(entry).toBeDefined()
      expect(isObject(entry)).toBe(true)
    })
  })
}
