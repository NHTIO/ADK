import { describe, it, expect } from 'vitest'
import { renderPlan } from '../../../../src/batteries/orchestration/render'
import {
  NodeRef,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/encoding'
import type {
  RawPlanView,
  PlanNode,
  PlanEdge,
  PlanNodeKind,
  EdgeHandle,
  AuthorityClaim,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * The renderer is load-bearing: this design has NO dry run, so its prose IS the review surface —
 * what an operator reads at the approval gate and what a model reads to re-consume a plan it did
 * not author. These cases pin the properties where a plausible-looking rendering would actively
 * mislead one of those two audiences.
 */
describe('renderPlan', () => {
  const claim = (capability: string, scope: string, verb: string): AuthorityClaim =>
    ({ capability, scope, verb }) as AuthorityClaim

  const entry = {
    id: 'entry_node',
    kind: 'entry' as PlanNodeKind,
    definition: { input: [] },
  } as unknown as PlanNode

  const callNode = (id: string, over: Record<string, unknown> = {}): PlanNode =>
    ({
      id,
      kind: 'call' as PlanNodeKind,
      definition: {
        tool: 'move_drive_file',
        args: {},
        output: [],
        onMissingValue: 'fail',
        authority: [claim('google_drive', 'Archive/2024/**', 'update')],
        replaySafe: true,
        onIndeterminate: 'retry',
        ...over,
      },
    }) as unknown as PlanNode

  const edge = (id: string, from: string, to: string, handle = 'always'): PlanEdge => ({
    id,
    from,
    to,
    handle: handle as EdgeHandle,
  })

  const view = (nodes: PlanNode[], edges: PlanEdge[], provenance?: unknown): RawPlanView =>
    ({
      planId: 'p',
      digest: '4f1cabcd',
      revision: 7,
      nodes,
      edges,
      bounds: {},
      provenance,
    }) as unknown as RawPlanView

  const operator = { audience: 'operator' as const, view: 'as_planned' as const }
  const model = { audience: 'model' as const, view: 'as_planned' as const }

  const simple = () =>
    view([entry, callNode('archive_files')], [edge('e1', 'entry_node', 'archive_files')])

  it('prints every node id VERBATIM, for both audiences', () => {
    // A model extending a plan must write NodeRef{node:'archive_files'}, citing the id exactly.
    // A step ORDINAL cannot be cited: nothing in the IR is addressed by position, and the
    // ordinal shifts the moment a node is inserted.
    for (const options of [operator, model]) {
      const out = renderPlan(simple(), options)
      expect(out).toContain('entry_node')
      expect(out).toContain('archive_files')
    }
  })

  it('renders a NodeRef argument as PROVENANCE, never as a value', () => {
    const ref = new NodeRef('list_files', 'all')
    const plan = view(
      [
        entry,
        callNode('list_files', { tool: 'list_drive_files' }),
        callNode('archive_files', { args: { from: ref, to: 'Archive/2024' } }),
      ],
      [edge('e1', 'entry_node', 'list_files'), edge('e2', 'list_files', 'archive_files')]
    )
    const out = renderPlan(plan, operator)
    // Approval happens before any run, so there is no OutputTable to resolve from. The reference
    // must name where the value will come from, and must never print a fabricated stand-in.
    expect(out).toContain('list_files')
    expect(out).not.toMatch(/from:\s*(undefined|null|\[object)/)
    // A literal in the same call still renders as its value.
    expect(out).toContain('Archive/2024')
  })

  it('renders each onIndeterminate behaviour distinctly, and skip states its consequence', () => {
    const retry = renderPlan(simple(), operator)
    expect(retry).toMatch(/retried/i)

    const halt = renderPlan(
      view([entry, callNode('a', { onIndeterminate: 'halt' })], [edge('e1', 'entry_node', 'a')]),
      operator
    )
    expect(halt).toMatch(/stop and wait|wait for you/i)

    // `skip` must not read as a clean recovery: downstream nodes proceed against a step whose
    // effect is unknown, and an operator approving it needs to see that.
    const skip = renderPlan(
      view([entry, callNode('a', { onIndeterminate: 'skip' })], [edge('e1', 'entry_node', 'a')]),
      operator
    )
    expect(skip).toMatch(/unknown|proceed/i)
  })

  it('warns that approving a clone repeats work its parent already completed', () => {
    const out = renderPlan(
      view([entry, callNode('a')], [edge('e1', 'entry_node', 'a')], {
        kind: 'clone',
        parent: 'parent_plan',
        parentDigest: 'abc',
        parentRevision: 4,
        completedAtClone: ['fetch_invoices', 'archive_files'],
      }),
      operator
    )
    expect(out).toMatch(/parent_plan|already completed/i)
    expect(out).toContain('fetch_invoices')
    expect(out).toMatch(/again|repeat/i)
  })

  it('is TOTAL over every node kind', () => {
    const ref = new NodeRef('src_node', 'first')
    const all = [
      entry,
      callNode('call_node'),
      {
        id: 'reason_node',
        kind: 'reason',
        definition: { prompt: [{ text: 'why?' }], outputSchema: 'encoded', maxAttempts: 2 },
      },
      {
        id: 'transform_node',
        kind: 'transform',
        definition: {
          source: ref,
          steps: [{ name: 'artifact_json_get', args: { path: 'a' } }],
          emit: { as: 'rows' },
          output: [],
        },
      },
      {
        id: 'branch_node',
        kind: 'branch',
        definition: { evaluator: 'structured', predicate: { path: 'x', op: 'truthy' } },
      },
      {
        id: 'select_node',
        kind: 'select',
        definition: {
          evaluator: 'structured',
          predicate: { path: 'x', op: 'eq', value: 1 },
          cases: ['a'],
        },
      },
      { id: 'join_node', kind: 'join', definition: {} },
    ].map((n) => n as unknown as PlanNode)

    const out = renderPlan(view(all, []), operator)
    for (const node of all) expect(out).toContain(node.id)
  })

  it('marks a mutating step, and does NOT mark a read-only one', () => {
    // The marker exists so an operator can see WHICH steps have side effects. Firing it on
    // every call destroys that signal: someone scanning a twenty-step plan for the three
    // dangerous ones finds twenty, and stops reading it. So the negative case matters as much
    // as the positive one — asserting only the positive is what let this ship.
    const mutating = renderPlan(
      view(
        [
          entry,
          callNode('archive_files', { authority: [claim('google_drive', 'A/**', 'update')] }),
        ],
        [edge('e1', 'entry_node', 'archive_files')]
      ),
      operator
    )
    expect(mutating).toMatch(/MODIFIES DATA/)

    const readOnly = renderPlan(
      view(
        [
          entry,
          callNode('list_files', {
            tool: 'list_drive_files',
            authority: [claim('google_drive', 'I/**', 'list')],
          }),
        ],
        [edge('e1', 'entry_node', 'list_files')]
      ),
      operator
    )
    expect(readOnly).not.toMatch(/MODIFIES DATA/)
    expect(readOnly).toMatch(/no changes|changes nothing/i)
  })

  it('renders an unclaimed call as UNKNOWN rather than as safe', () => {
    // An unclaimed side effect is the thing an operator most needs flagged, so the absence of
    // an authority claim must never read as reassurance.
    const out = renderPlan(
      view([entry, callNode('mystery', { authority: [] })], [edge('e1', 'entry_node', 'mystery')]),
      operator
    )
    expect(out).toMatch(/unknown|unclaimed|not declared|none claimed/i)
    expect(out).not.toMatch(/no changes made/i)
  })

  it('is deterministic: the same plan and options render byte-identically', () => {
    expect(renderPlan(simple(), operator)).toBe(renderPlan(simple(), operator))
  })

  it('ends the operator view with a total-authority summary', () => {
    expect(renderPlan(simple(), operator)).toMatch(/total authority/i)
  })

  it('never emits a section heading with an empty body', () => {
    const out = renderPlan(simple(), operator)
    const lines = out.split('\n')
    lines.forEach((line, i) => {
      if (/:$/.test(line.trim()) && line.trim().length > 1) {
        const next = (lines[i + 1] ?? '').trim()
        // A bare heading reads as a rendering failure to an operator told this is the whole
        // review surface.
        expect(next).not.toBe('')
      }
    })
  })
})
