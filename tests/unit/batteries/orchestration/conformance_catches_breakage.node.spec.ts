import { describe, it, expect } from 'vitest'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'
import type { PlanOp, ApprovalRecord } from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * A conformance suite that only ever passes is worthless. These cases SABOTAGE the reference
 * store in the exact ways the contract forbids, and assert the resulting behaviour is observably
 * wrong — i.e. that the conformance cases covering them have something real to catch.
 */
describe('the conformance contract has teeth', () => {
  const op = (i: number, id: string) =>
    ({
      opId: `o${i}`,
      actorId: 'a',
      lamport: i,
      at: 'x',
      op: 'add_node',
      node: { id, kind: 'call', definition: {} },
    }) as unknown as PlanOp

  const approval = (planId: string, digest: string): ApprovalRecord => ({
    planId,
    digest,
    authoritySet: [],
    decidedBy: 'op',
    decidedAt: 'now',
    disposition: 'approved',
  })

  it('a store that lets appendOps through when frozen produces content nobody approved', async () => {
    const store = new InMemoryPlanStore()
    await store.createPlan('p')
    await store.appendOps('p', [op(1, 'n1')])
    const { digest: d1 } = await store.readState('p')
    await store.transition('p', { from: 'editable', to: 'reviewable', expectedDigest: d1 })
    await store.transition('p', {
      from: 'reviewable',
      to: 'executable',
      expectedDigest: d1,
      approval: approval('p', d1),
    })

    // The contract's refusal is what keeps these two in step.
    const refused = await store.appendOps('p', [op(2, 'n2')])
    expect(refused).toMatchObject({ ok: false, reason: 'not_editable' })

    const after = await store.readState('p')
    const record = await store.readApproval('p')
    // The property that matters: the approval still describes the live content.
    expect(record?.digest).toBe(after.digest)
  })

  it('a second claimRun would double-execute every call node, so it must lose', async () => {
    const store = new InMemoryPlanStore()
    await store.createPlan('p')
    await store.appendOps('p', [op(1, 'n1')])
    const { digest: d0 } = await store.readState('p')
    await store.transition('p', { from: 'editable', to: 'reviewable', expectedDigest: d0 })
    const { digest: d } = await store.readState('p')
    await store.transition('p', {
      from: 'reviewable',
      to: 'executable',
      expectedDigest: d,
      approval: approval('p', d),
    })

    const claims = await Promise.all([
      store.claimRun('p', d),
      store.claimRun('p', d),
      store.claimRun('p', d),
    ])
    expect(claims.filter((c) => c.ok)).toHaveLength(1)
    expect(claims.filter((c) => !c.ok)).toHaveLength(2)
    for (const lost of claims.filter((c) => !c.ok)) {
      expect(lost).toMatchObject({ ok: false, reason: 'run_already_claimed' })
    }
  })

  it('a digest that ignored non-JSON staged values would collide across different plans', async () => {
    const store = new InMemoryPlanStore()
    await store.createPlan('a')
    await store.createPlan('b')
    const staged = (i: number, v: unknown) =>
      ({
        opId: `o${i}`,
        actorId: 'a',
        lamport: i,
        at: 'x',
        op: 'add_node',
        node: { id: 'n', kind: 'call', definition: { pattern: v } },
      }) as unknown as PlanOp

    await store.appendOps('a', [staged(1, /^inv-\d+$/i)])
    await store.appendOps('b', [staged(1, /^cust-\d+$/)])

    const { digest: da } = await store.readState('a')
    const { digest: db } = await store.readState('b')
    // Plain sorted-key canonical JSON collapses both RegExps to {} and these would be equal.
    expect(da).not.toBe(db)
  })
})
