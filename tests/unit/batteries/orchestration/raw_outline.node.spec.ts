import { describe, it, expect } from 'vitest'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { rawPlan, rawOps, rawDiff } from '../../../../src/batteries/orchestration/raw'
import { planOutline, planRead } from '../../../../src/batteries/orchestration/outline'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'
import type { PlanOp, PlanNode } from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * Prose is for humans and for a model re-consuming a plan; a UI showing "here is what changed and
 * what will be applied" needs machine-readable state instead, and the op log is what makes that
 * well-defined. `outline`/`planRead` are the scoped reading surface — one flat index, then a
 * bounded slice — so a model can navigate a large plan without pulling the whole graph into its
 * window.
 */
describe('the raw views and the scoped reading surface', () => {
  const call = (id: string, tool: string, phase?: string): PlanNode =>
    ({
      id,
      kind: 'call',
      ...(phase === undefined ? {} : { phase }),
      definition: {
        tool,
        args: {},
        output: [],
        onMissingValue: 'fail',
        authority: [],
        replaySafe: true,
        onIndeterminate: 'halt',
      },
    }) as PlanNode

  /** A plan whose HISTORY matters: a node added late, and a field changed later still. */
  const historicalPlan = async () => {
    const store = new InMemoryPlanStore()
    await store.createPlan('p')
    let seq = 0
    const op = (body: Record<string, unknown>): PlanOp =>
      ({ opId: `o${++seq}`, actorId: 'a', lamport: seq, at: 'x', ...body }) as unknown as PlanOp

    await store.appendOps('p', [
      op({ op: 'add_node', node: { id: 'entry', kind: 'entry', definition: { input: [] } } }),
      op({ op: 'add_node', node: call('first', 'original', 'gather') }),
      op({ op: 'add_edge', edge: { id: 'e0', from: 'entry', to: 'first', handle: 'always' } }),
      // revision 4: a node that did not exist earlier
      op({ op: 'add_node', node: call('late', 'late_tool', 'act') }),
      // revision 5: a field changed
      op({ op: 'set_node_field', nodeId: 'first', path: 'tool', value: 'changed' }),
    ])
    return store
  }

  describe('rawPlan serves a HISTORICAL revision truthfully', () => {
    it('omits a node added later and reports a field at its ORIGINAL value', async () => {
      // A direct regression test for the op-log mutation defect: when the fold rewrote the
      // caller's ops in place, a prefix fold returned the LATER value and every historical view
      // was silently corrupted.
      const store = await historicalPlan()

      const atThree = await rawPlan(store, 'p', { revision: 3 })
      expect(atThree.nodes.map((n) => n.id)).not.toContain('late')
      const firstNode = atThree.nodes.find((n) => n.id === 'first')!
      expect((firstNode.definition as { tool: string }).tool).toBe('original')

      const current = await rawPlan(store, 'p')
      expect(current.nodes.map((n) => n.id)).toContain('late')
      const currentFirst = current.nodes.find((n) => n.id === 'first')!
      expect((currentFirst.definition as { tool: string }).tool).toBe('changed')
    })

    it('re-reading one revision yields an identical digest', async () => {
      // Which is what makes a digest meaningful at all.
      const store = await historicalPlan()
      const once = await rawPlan(store, 'p', { revision: 3 })
      const twice = await rawPlan(store, 'p', { revision: 3 })
      expect(twice.digest).toBe(once.digest)
    })

    it('carries NO lifecycle `state`, which cannot be folded from the log', async () => {
      // Lifecycle state is not a `PlanOp`, so a historical revision has none to report: a view at
      // revision 3 answers what the CONTENT looked like then, not what state it was in.
      const store = await historicalPlan()
      const view = await rawPlan(store, 'p', { revision: 3 })
      expect(view).not.toHaveProperty('state')
      // It lives on readState instead.
      const state = await store.readState('p')
      expect(state.state).toBe('editable')
    })

    it('rejects a revision the log never reached', async () => {
      const store = await historicalPlan()
      await expect(rawPlan(store, 'p', { revision: 99 })).rejects.toThrow()
    })
  })

  describe('rawOps serves the log or a prefix', () => {
    it('returns the whole log, and a bounded prefix', async () => {
      const store = await historicalPlan()
      expect(await rawOps(store, 'p')).toHaveLength(5)
      expect(await rawOps(store, 'p', { throughRevision: 3 })).toHaveLength(3)
    })
  })

  describe('rawDiff is a FINAL-STATE delta, not a history of edits', () => {
    it('reports nodes added and fields changed between two revisions', async () => {
      const store = await historicalPlan()
      const diff = await rawDiff(store, 'p', 3, 5)

      // `nodesAdded` carries whole NODES, not ids — a UI rendering "what will be applied" needs
      // the content, and an id alone would send it back to the store for every addition.
      expect(diff.nodesAdded.map((n) => n.id)).toContain('late')
      expect(diff.nodesChanged.map((c) => c.nodeId)).toContain('first')
      const changed = diff.nodesChanged.find((c) => c.nodeId === 'first')!
      expect(JSON.stringify(changed)).toContain('changed')
      expect(JSON.stringify(changed)).toContain('original')
    })

    it('yields an EMPTY diff comparing a revision with itself', async () => {
      const store = await historicalPlan()
      const diff = await rawDiff(store, 'p', 5, 5)

      expect(diff.nodesAdded).toEqual([])
      expect(diff.nodesRemoved).toEqual([])
      expect(diff.nodesChanged).toEqual([])
    })
  })

  describe('the scoped reading surface', () => {
    it('outlines ONE flat level, printing node ids VERBATIM', async () => {
      // Ids are printed verbatim because a model must cite them exactly to extend the plan; an
      // abbreviation or an ordinal cannot be cited.
      const store = await historicalPlan()
      const outline = await planOutline(store, 'p')

      const rendered = JSON.stringify(outline)
      expect(rendered).toContain('first')
      expect(rendered).toContain('late')
      expect(rendered).toContain('entry')
    })

    it('reads a bounded slice by PHASE', async () => {
      const store = await historicalPlan()
      const slice = await planRead(store, 'p', { phase: 'gather' })

      expect(slice.nodes.map((n) => n.id)).toEqual(['first'])
      expect(slice.nodes.map((n) => n.id)).not.toContain('late')
    })

    it('reads a bounded slice by NODE', async () => {
      const store = await historicalPlan()
      const slice = await planRead(store, 'p', { node: 'late' })

      expect(slice.nodes.map((n) => n.id)).toContain('late')
    })

    it('refuses a selection that is not an object', async () => {
      const store = await historicalPlan()
      await expect(planRead(store, 'p', 'first' as never)).rejects.toThrow()
    })
  })
})
