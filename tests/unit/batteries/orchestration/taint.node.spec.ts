import { describe, it, expect } from 'vitest'
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
  DeclaredField,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * External input is TAINTED, and a tainted value may reach a `reason` prompt but never a `call`
 * node's args — because a staged call is the thing an operator approved, and letting run-time
 * input steer its arguments would mean approving one plan and running another.
 *
 * Taint is static, computed at freeze over the graph, so every case here is a freeze outcome.
 */
describe('taint propagates from external input and only declassification clears it', () => {
  const INVOCABLE = { has: () => true, names: () => ['t'], returns: () => undefined }

  const entry: PlanNode = {
    id: 'entry',
    kind: 'entry',
    definition: { input: [{ path: 'topic', type: 'string' }] },
  } as PlanNode

  const call = (id: string, extra: Record<string, unknown> = {}): PlanNode =>
    ({
      id,
      kind: 'call',
      definition: {
        tool: 't',
        args: {},
        output: [{ path: 'value', type: 'string' }] as DeclaredField[],
        onMissingValue: 'fail',
        authority: [],
        replaySafe: true,
        onIndeterminate: 'halt',
        ...extra,
      },
    }) as PlanNode

  const edge = (id: string, from: string, to: string): PlanEdge =>
    ({ id, from, to, handle: 'always' }) as PlanEdge

  /** Freeze a plan and report the outcome — taint is a freeze-time verdict. */
  const freeze = async (planId: string, nodes: PlanNode[], edges: PlanEdge[]) => {
    const store = new InMemoryPlanStore()
    await store.createPlan(planId)
    let seq = 0
    const op = (body: Record<string, unknown>): PlanOp =>
      ({ opId: `o${++seq}`, actorId: 'a', lamport: seq, at: 'x', ...body }) as unknown as PlanOp
    await store.appendOps(planId, [
      ...nodes.map((node) => op({ op: 'add_node', node })),
      ...edges.map((e) => op({ op: 'add_edge', edge: e })),
    ])
    const result = await freezePlan(store, planId, {
      invocable: INVOCABLE as never,
      evaluators: [],
    })
    return { ok: result.ok, codes: result.issues.map((i) => i.code), issues: result.issues }
  }

  it('refuses entry-derived data reaching a call node’s args', async () => {
    const r = await freeze(
      'direct',
      [entry, call('sink', { args: { v: new NodeRef('entry', 'first', 'topic') } })],
      [edge('e0', 'entry', 'sink')]
    )

    expect(r.ok).toBe(false)
    expect(r.codes).toContain('tainted_call_arg')
    // The message must name both ends and the way out, since a model reads it.
    const message = r.issues.find((i) => i.code === 'tainted_call_arg')!.message
    expect(message).toContain('sink')
    expect(message).toContain('entry')
    expect(message).toContain('declassifies')
  })

  it('ALLOWS the same tainted reference in a reason prompt', async () => {
    // A prompt is text a model reads, not an argument a tool acts on — the distinction the whole
    // rule rests on.
    const reason: PlanNode = {
      id: 'rn',
      kind: 'reason',
      definition: {
        prompt: [{ text: 'Summarise:' }, new NodeRef('entry', 'first', 'topic')],
        outputSchema: '',
        maxAttempts: 1,
      },
    } as PlanNode

    const r = await freeze('prompt', [entry, reason], [edge('e0', 'entry', 'rn')])
    expect(r.ok).toBe(true)
  })

  it('does NOT let an echo node launder', async () => {
    // The loophole an earlier draft had: a node that merely reproduces the entry value unchanged,
    // declaring an output but no `declassifies`, must not clear taint by existing.
    const echo = call('echo', { args: { v: new NodeRef('entry', 'first', 'topic') } })
    const sink = call('sink', { args: { v: new NodeRef('echo', 'first', 'value') } })

    const r = await freeze(
      'echo',
      [entry, echo, sink],
      [edge('e0', 'entry', 'echo'), edge('e1', 'echo', 'sink')]
    )

    expect(r.ok).toBe(false)
    expect(r.codes).toContain('tainted_call_arg')
  })

  it('clears taint through a node that declassifies the field being read', async () => {
    const sanitise = call('sanitise', {
      args: { v: new NodeRef('entry', 'first', 'topic') },
      declassifies: ['value'],
    })
    const sink = call('sink', { args: { v: new NodeRef('sanitise', 'first', 'value') } })

    const r = await freeze(
      'cleared',
      [entry, sanitise, sink],
      [edge('e0', 'entry', 'sanitise'), edge('e1', 'sanitise', 'sink')]
    )

    expect(r.ok).toBe(true)
  })

  describe('declassification is per FIELD, and its SIBLINGS stay tainted', () => {
    // `declassifies` is an author's assertion that a tool sanitised something. The assertion must
    // bind to exactly what it names — a node-granular rule would let one declared-safe field
    // launder every other output of the same node, which is the security-relevant direction.
    const sanitiser = call('san', {
      args: { v: new NodeRef('entry', 'first', 'topic') },
      output: [
        { path: 'safe', type: 'string' },
        { path: 'unsafe', type: 'string' },
      ] as DeclaredField[],
      declassifies: ['safe'],
    })

    it('accepts a call reading the DECLASSIFIED field', async () => {
      const r = await freeze(
        'reads-safe',
        [entry, sanitiser, call('sink', { args: { v: new NodeRef('san', 'first', 'safe') } })],
        [edge('e0', 'entry', 'san'), edge('e1', 'san', 'sink')]
      )

      expect(r.ok).toBe(true)
    })

    it('REFUSES a call reading a sibling the same node did not declassify', async () => {
      const r = await freeze(
        'reads-unsafe',
        [entry, sanitiser, call('sink', { args: { v: new NodeRef('san', 'first', 'unsafe') } })],
        [edge('e0', 'entry', 'san'), edge('e1', 'san', 'sink')]
      )

      expect(r.ok).toBe(false)
      expect(r.codes).toContain('tainted_call_arg')
    })

    it('REFUSES a whole-item read, which cannot avoid the tainted sibling', async () => {
      // No `path`, so the reference takes the entire item — including `unsafe`.
      const r = await freeze(
        'reads-whole',
        [entry, sanitiser, call('sink', { args: { v: new NodeRef('san', 'first') } })],
        [edge('e0', 'entry', 'san'), edge('e1', 'san', 'sink')]
      )

      expect(r.ok).toBe(false)
      expect(r.codes).toContain('tainted_call_arg')
    })
  })

  it('finds a tainted reference nested deep inside a staged structure', async () => {
    // Args are arbitrary encodable structures, so the walk must not stop at the top level.
    const sink = call('sink', {
      args: { outer: { list: [{ inner: new NodeRef('entry', 'first', 'topic') }] } },
    })

    const r = await freeze('nested', [entry, sink], [edge('e0', 'entry', 'sink')])
    expect(r.ok).toBe(false)
    expect(r.codes).toContain('tainted_call_arg')
  })

  it('propagates transitively down a chain of undeclassified nodes', async () => {
    const a = call('a', { args: { v: new NodeRef('entry', 'first', 'topic') } })
    const b = call('b', { args: { v: new NodeRef('a', 'first', 'value') } })
    const c = call('c', { args: { v: new NodeRef('b', 'first', 'value') } })

    const r = await freeze(
      'chain',
      [entry, a, b, c],
      [edge('e0', 'entry', 'a'), edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]
    )

    expect(r.ok).toBe(false)
    // Every hop is a violation, so the author sees the whole contaminated path at once.
    expect(r.codes.filter((code) => code === 'tainted_call_arg').length).toBeGreaterThanOrEqual(3)
  })
})
