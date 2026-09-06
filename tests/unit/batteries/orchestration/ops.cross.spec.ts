import { describe, it, expect } from 'vitest'
import { foldOps } from '../../../../src/batteries/orchestration/ops'
import { DEFAULT_PLAN_BOUNDS } from '../../../../src/batteries/orchestration/types'
import {
  NodeRef,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/encoding'
import type { PlanOp, PlanNode, PlanEdge } from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * A plan IS the fold of its op log, so the fold's contract is what makes a plan a well-defined
 * object at all: two actors holding the same op SET must reach the same state, whatever order
 * the ops arrived in and however many times they arrived.
 *
 * Every case here is therefore a statement about CONVERGENCE rather than about any one op's
 * behaviour, and the ordering cases are written so that a two-part `(lamport, actorId)` key —
 * the plausible simplification — fails them.
 *
 * ONE LIMIT OF THAT CONVERGENCE, pinned rather than papered over: the fold is documented as "a
 * pure function of the op SET", but `revision` is the number of ops FOLDED, so a log that
 * received the same op twice folds to identical CONTENT at a DIFFERENT revision — and since
 * `revision` is a digested field, to a different digest. Content converges; the counter does not.
 * Whether that matters depends on whether a duplicate `opId` can reach one log, which is a store
 * question rather than a fold question. Recorded here so the behaviour is a decision on the
 * record rather than an accident.
 */
describe('foldOps is a deterministic, convergent fold of the op set', () => {
  const callNode = (id: string, tool = 'echo'): PlanNode =>
    ({
      id,
      kind: 'call',
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

  const edge = (id: string, from: string, to: string): PlanEdge => ({
    id,
    from,
    to,
    handle: 'always',
  })

  const op = (
    parts: { opId: string; actorId: string; lamport: number },
    body: Record<string, unknown>
  ): PlanOp => ({ ...parts, at: '2026-01-01T00:00:00.000Z', ...body }) as unknown as PlanOp

  /** Every permutation of a small list, for asserting arrival-order independence exhaustively. */
  const permutations = <T>(items: T[]): T[][] => {
    if (items.length <= 1) return [items]
    const out: T[][] = []
    for (let i = 0; i < items.length; i++) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)]
      for (const p of permutations(rest)) out.push([items[i]!, ...p])
    }
    return out
  }

  describe('the total order is (lamport, actorId, opId) — all three parts', () => {
    it('breaks a tie between two ops from ONE actor at the SAME lamport by opId', () => {
      // This is the case a two-part (lamport, actorId) key cannot decide: one actor may author
      // several edits at a single logical instant, and arrival order must not pick the winner.
      const base = op(
        { opId: 'o0', actorId: 'alice', lamport: 1 },
        {
          op: 'add_node',
          node: callNode('n1'),
        }
      )
      const lowerId = op(
        { opId: 'aaa', actorId: 'alice', lamport: 7 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'from-aaa',
        }
      )
      const higherId = op(
        { opId: 'zzz', actorId: 'alice', lamport: 7 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'from-zzz',
        }
      )

      // The higher opId is applied last and therefore wins, in EVERY arrival order.
      for (const arrival of permutations([base, lowerId, higherId])) {
        const { view } = foldOps('p', arrival)
        const node = view.nodes.find((n) => n.id === 'n1')!
        expect((node.definition as { tool: string }).tool).toBe('from-zzz')
      }
    })

    it('orders by lamport before actorId, and by actorId before opId', () => {
      const add = op(
        { opId: 'o0', actorId: 'a', lamport: 1 },
        {
          op: 'add_node',
          node: callNode('n1'),
        }
      )
      // Higher lamport wins even though its actorId and opId both sort lower.
      const early = op(
        { opId: 'zzz', actorId: 'zoe', lamport: 5 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'early',
        }
      )
      const late = op(
        { opId: 'aaa', actorId: 'amy', lamport: 6 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'late',
        }
      )

      const { view } = foldOps('p', [late, early, add])
      expect((view.nodes[0]!.definition as { tool: string }).tool).toBe('late')

      // At equal lamport, the higher actorId wins regardless of opId.
      const zoe = op(
        { opId: 'aaa', actorId: 'zoe', lamport: 9 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'zoe',
        }
      )
      const amy = op(
        { opId: 'zzz', actorId: 'amy', lamport: 9 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'amy',
        }
      )
      const { view: byActor } = foldOps('p', [amy, zoe, add])
      expect((byActor.nodes[0]!.definition as { tool: string }).tool).toBe('zoe')
    })

    it('folds every arrival order of a whole log to a byte-identical digest', () => {
      const ops = [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'add_node', node: callNode('n1') }),
        op({ opId: 'o2', actorId: 'b', lamport: 2 }, { op: 'add_node', node: callNode('n2') }),
        op(
          { opId: 'o3', actorId: 'a', lamport: 3 },
          {
            op: 'add_edge',
            edge: edge('e1', 'n1', 'n2'),
          }
        ),
      ]

      const digests = new Set(permutations(ops).map((arrival) => foldOps('p', arrival).view.digest))
      expect(digests.size).toBe(1)
    })

    it('folds a duplicated op to identical CONTENT, though not an identical digest', () => {
      // The contract says ops may arrive "out of order or twice", and every element of plan
      // CONTENT is idempotent under a repeat: applying one op twice in a total order lands the
      // same value. That is asserted here.
      //
      // The DIGEST is deliberately not asserted equal, and the reason is worth stating rather
      // than hiding behind a weaker assertion. `revision` is defined as the number of ops FOLDED
      // (the store's `revision` is likewise its log length, which is what makes
      // `readOps({throughRevision})` a prefix selector), so a log carrying the same op twice is
      // at a different revision than one carrying it once — and `revision` is a digested field.
      // Content converges; the revision counter distinguishes the two logs. See the note in the
      // suite header.
      const ops = [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'add_node', node: callNode('n1') }),
        op({ opId: 'o2', actorId: 'a', lamport: 2 }, { op: 'add_node', node: callNode('n2') }),
      ]
      const once = foldOps('p', ops).view
      const twice = foldOps('p', [...ops, ops[0]!]).view

      expect(twice.nodes).toEqual(once.nodes)
      expect(twice.edges).toEqual(once.edges)
      expect(twice.bounds).toEqual(once.bounds)
      // The one field that differs, pinned explicitly so a change to either side is visible.
      expect(once.revision).toBe(2)
      expect(twice.revision).toBe(3)
    })
  })

  describe('element semantics are LWW-element, not add-wins', () => {
    it('lets the highest-key op decide whether a node exists, in either direction', () => {
      const add = op(
        { opId: 'o1', actorId: 'a', lamport: 1 },
        {
          op: 'add_node',
          node: callNode('n1'),
        }
      )
      const removeLater = op(
        { opId: 'o2', actorId: 'a', lamport: 2 },
        {
          op: 'remove_node',
          nodeId: 'n1',
          incidentEdgeIds: [],
        }
      )
      expect(foldOps('p', [add, removeLater]).view.nodes).toHaveLength(0)
      // Arrival order must not change that.
      expect(foldOps('p', [removeLater, add]).view.nodes).toHaveLength(0)

      // And a re-add at a HIGHER key wins over the removal — that is LWW, not remove-wins.
      const readd = op(
        { opId: 'o3', actorId: 'a', lamport: 3 },
        {
          op: 'add_node',
          node: callNode('n1'),
        }
      )
      expect(foldOps('p', [add, removeLater, readd]).view.nodes).toHaveLength(1)
    })

    it('cascades a node removal to its recorded incident edges, order-independently', () => {
      // `incidentEdgeIds` is recorded ON the op precisely so the cascade does not depend on the
      // edges being present in the fold at the moment the removal is applied.
      const ops = [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'add_node', node: callNode('n1') }),
        op({ opId: 'o2', actorId: 'a', lamport: 2 }, { op: 'add_node', node: callNode('n2') }),
        op(
          { opId: 'o3', actorId: 'a', lamport: 3 },
          {
            op: 'add_edge',
            edge: edge('e1', 'n1', 'n2'),
          }
        ),
        op(
          { opId: 'o4', actorId: 'a', lamport: 4 },
          {
            op: 'remove_node',
            nodeId: 'n2',
            incidentEdgeIds: ['e1'],
          }
        ),
      ]

      for (const arrival of permutations(ops)) {
        const { view } = foldOps('p', arrival)
        expect(view.nodes.map((n) => n.id)).toEqual(['n1'])
        expect(view.edges).toHaveLength(0)
      }
    })
  })

  describe('bounds are the fold SEED, not an op', () => {
    it('folds an empty log to revision 0 with default bounds and a stable digest', () => {
      const empty = foldOps('p', []).view
      expect(empty.revision).toBe(0)
      expect(empty.bounds).toEqual(DEFAULT_PLAN_BOUNDS)
      expect(empty.digest).toBe(foldOps('p', []).view.digest)
      expect(empty.nodes).toHaveLength(0)
    })

    it('makes the first authoring op revision 1, and counts ops folded thereafter', () => {
      const one = foldOps('p', [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'add_node', node: callNode('n1') }),
      ]).view
      expect(one.revision).toBe(1)
    })

    it('lets set_bounds override the seed by LWW', () => {
      const bounds = { ...DEFAULT_PLAN_BOUNDS, maxNodes: 9 }
      const { view } = foldOps('p', [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'set_bounds', bounds }),
      ])
      expect(view.bounds.maxNodes).toBe(9)
    })
  })

  describe('ops are strictly read-only input', () => {
    it('does not mutate the caller op objects, so a prefix fold stays truthful', () => {
      // The regression this pins: when the fold wrote through to the caller's node object, a
      // historical prefix returned the LATER value and every past revision was silently corrupted.
      const add = op(
        { opId: 'o1', actorId: 'a', lamport: 1 },
        {
          op: 'add_node',
          node: callNode('n1', 'original'),
        }
      )
      const change = op(
        { opId: 'o2', actorId: 'a', lamport: 2 },
        {
          op: 'set_node_field',
          nodeId: 'n1',
          path: 'tool',
          value: 'changed',
        }
      )

      const full = foldOps('p', [add, change]).view
      expect((full.nodes[0]!.definition as { tool: string }).tool).toBe('changed')

      // Folding the PREFIX afterwards must still see the original value.
      const prefix = foldOps('p', [add]).view
      expect((prefix.nodes[0]!.definition as { tool: string }).tool).toBe('original')

      // And the op itself is untouched.
      const node = (add as unknown as { node: PlanNode }).node
      expect((node.definition as { tool: string }).tool).toBe('original')
    })

    it('carries encoder-owned values across by reference rather than rebuilding them', () => {
      // A JSON round-trip or naive recursive copy would flatten these to {} and change the
      // digest — the plan digest depends on them surviving intact.
      const when = new Date('2026-01-01T00:00:00.000Z')
      const ref = new NodeRef('n0', 'first')
      const node = {
        id: 'n1',
        kind: 'call',
        definition: {
          tool: 'echo',
          args: { when, ref, pattern: /x/g, tags: new Set(['a']) },
          output: [],
          onMissingValue: 'fail',
          authority: [],
          replaySafe: true,
          onIndeterminate: 'halt',
        },
      } as unknown as PlanNode

      const { view } = foldOps('p', [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'add_node', node }),
      ])
      const args = (view.nodes[0]!.definition as { args: Record<string, unknown> }).args

      expect(args.when).toBeInstanceOf(Date)
      expect(NodeRef.isNodeRef(args.ref)).toBe(true)
      expect(args.pattern).toBeInstanceOf(RegExp)
      expect(args.tags).toBeInstanceOf(Set)
    })
  })

  describe('a same-id edge collision converges rather than throwing', () => {
    it('resolves by LWW and surfaces the loser as an advisory issue naming the id', () => {
      // Refusing "whichever arrived second" would make the fold order-dependent, and two offline
      // writers can each legally append before their logs meet. So uniqueness is a freeze-time
      // invariant, and the fold's job is to stay convergent and report.
      const ops = [
        op({ opId: 'o1', actorId: 'a', lamport: 1 }, { op: 'add_node', node: callNode('n1') }),
        op({ opId: 'o2', actorId: 'a', lamport: 2 }, { op: 'add_node', node: callNode('n2') }),
        op({ opId: 'o3', actorId: 'a', lamport: 3 }, { op: 'add_node', node: callNode('n3') }),
        op(
          { opId: 'o4', actorId: 'a', lamport: 4 },
          {
            op: 'add_edge',
            edge: edge('dup', 'n1', 'n2'),
          }
        ),
        op(
          { opId: 'o5', actorId: 'b', lamport: 5 },
          {
            op: 'add_edge',
            edge: edge('dup', 'n1', 'n3'),
          }
        ),
      ]

      const results = permutations(ops).map((arrival) => foldOps('p', arrival))

      // Convergent: one digest across every arrival order, and one surviving edge.
      expect(new Set(results.map((r) => r.view.digest)).size).toBe(1)
      expect(results[0]!.view.edges).toHaveLength(1)
      expect(results[0]!.view.edges[0]!.to).toBe('n3') // the higher key wins

      // Reported, not silently dropped, and the issue names the colliding id.
      const issues = results[0]!.issues
      expect(issues.some((i) => i.code === 'duplicate_edge_id')).toBe(true)
      expect(issues.find((i) => i.code === 'duplicate_edge_id')!.message).toContain('dup')
      // Advisory at fold time; `collectIssues` owns it as a blocking check at freeze.
      expect(issues.find((i) => i.code === 'duplicate_edge_id')!.severity).not.toBe('blocking')
    })
  })
})
