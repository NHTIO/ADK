import { describe, it, expect } from 'vitest'
import { foldOps } from '../../../../src/batteries/orchestration/ops'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import {
  validateTemplate,
  instantiateTemplate,
} from '../../../../src/batteries/orchestration/templates'
import {
  ParamRef,
  registerOrchestrationEncodables,
} from '../../../../src/batteries/orchestration/encoding'
import type {
  PlanTemplate,
  TemplateNode,
  InvocableTools,
} from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * A template is a plan SHAPE the consuming application defines in TypeScript and registers at
 * construction, so it versions with their app and is validated ONCE AT BOOT — a misconfigured
 * deployment fails at startup with a named error rather than at first use months later. It exists
 * because a small model does far better filling in five declared parameters than authoring forty
 * nodes.
 */
describe('plan templates', () => {
  const INVOCABLE = {
    has: (tool: string) => tool === 'archive',
    names: () => ['archive'],
    returns: () => undefined,
  } as unknown as InvocableTools

  const entry = {
    id: 'entry',
    kind: 'entry',
    definition: { input: [{ path: 'folder', type: 'string' }] },
  } as unknown as TemplateNode

  const callNode = (
    id: string,
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) =>
    ({
      id,
      kind: 'call',
      definition: {
        tool: 'archive',
        args,
        output: [{ path: 'value', type: 'string' }],
        onMissingValue: 'fail',
        authority: [],
        replaySafe: true,
        onIndeterminate: 'halt',
        ...extra,
      },
    }) as unknown as TemplateNode

  /**
   * Edges matter here: the laundering check is ROUTE-based — it asks whether EVERY route from
   * entry to the call passes a node declassifying the field — so a call with no route from entry
   * is skipped as an unreachable-node concern belonging to the plan validator, not this rule.
   * A template with no edges therefore proves nothing about laundering.
   */
  const EDGES = [{ id: 'e0', from: 'entry', to: 'archive', handle: 'always' }]

  const template = (nodes: TemplateNode[], edges: unknown[] = EDGES): PlanTemplate =>
    ({
      id: 'archive-folder',
      summary: 'Archive a folder',
      params: [{ path: 'folder', type: 'string' }],
      nodes,
      edges,
    }) as unknown as PlanTemplate

  describe('THE LAUNDERING CHECK — why validation runs over the template', () => {
    // Validation runs over the TEMPLATE rather than over an instantiation, and that is decidable
    // and TOTAL precisely because a registered template is IMMUTABLE: the graph cannot change
    // after the check, so the answer cannot go stale.
    it('refuses a raw ParamRef reaching a call node’s args', () => {
      const issues = validateTemplate(
        template([entry, callNode('archive', { path: new ParamRef('folder') })]),
        INVOCABLE
      )

      expect(issues.map((i) => i.code)).toContain('param_not_declassified')
    })

    it('accepts it when a node ON EVERY ROUTE declassifies the field first', () => {
      // The call's own `declassifies` names its OUTPUT, never its input, so a call cannot
      // declassify its own argument — the sanitising step must come BEFORE it on every route.
      const sanitise = callNode('sanitise', {}, { declassifies: ['folder'] })
      const issues = validateTemplate(
        template(
          [entry, sanitise, callNode('archive', { path: new ParamRef('folder') })],
          [
            { id: 'e0', from: 'entry', to: 'sanitise', handle: 'always' },
            { id: 'e1', from: 'sanitise', to: 'archive', handle: 'always' },
          ]
        ),
        INVOCABLE
      )

      expect(issues.map((i) => i.code)).not.toContain('param_not_declassified')
    })

    it('states the invariant NARROWLY: a template cannot launder its own parameters', () => {
      // It does NOT claim a substituted value's template origin is tracked through arbitrary
      // later edits, because nothing in a freely-mutable graph can do that. An identical literal
      // authored directly must therefore be ACCEPTED — an earlier draft claimed the stronger
      // thing and its own specified test disproved it.
      const issues = validateTemplate(
        template([entry, callNode('archive', { path: '/literal/path' })]),
        INVOCABLE
      )

      expect(issues.map((i) => i.code)).not.toContain('param_not_declassified')
    })

    it('does not treat a LOOK-ALIKE record as a hole', () => {
      // `ParamRef` is a class and `isParamRef` is instanceof-backed, which is the entire reason
      // it is not a `{path: 'folder'}` marker: a record can wear that shape.
      const issues = validateTemplate(
        template([entry, callNode('archive', { path: { path: 'folder' } })]),
        INVOCABLE
      )

      expect(issues.map((i) => i.code)).not.toContain('param_not_declassified')
    })
  })

  describe('validation at construction, not at first use', () => {
    it('refuses a ParamRef naming a param the template never declared', () => {
      const issues = validateTemplate(
        template([entry, callNode('archive', { path: new ParamRef('undeclared') })]),
        INVOCABLE
      )

      expect(issues.map((i) => i.code)).toContain('unknown_param')
    })

    it('refuses a tool outside the Tier-C allowlist, naming what IS available', () => {
      const issues = validateTemplate(
        template([entry, callNode('archive', {}, { tool: 'rm_rf' })]),
        INVOCABLE
      )

      const issue = issues.find((i) => i.code === 'unknown_tool')
      expect(issue).toBeDefined()
      expect(issue!.message).toContain('archive')
    })

    it('accepts a well-formed template with no issues at all', () => {
      expect(validateTemplate(template([entry, callNode('archive', {})]), INVOCABLE)).toEqual([])
    })
  })

  describe('instantiation', () => {
    const goodTemplate = template(
      [
        entry,
        callNode('sanitise', {}, { declassifies: ['folder'] }),
        callNode('archive', { path: new ParamRef('folder') }),
      ],
      [
        { id: 'e0', from: 'entry', to: 'sanitise', handle: 'always' },
        { id: 'e1', from: 'sanitise', to: 'archive', handle: 'always' },
      ]
    )

    it('substitutes the arg and leaves NO ParamRef behind', async () => {
      const store = new InMemoryPlanStore()
      const result = await instantiateTemplate(store, goodTemplate, { folder: '/tmp/x' }, 'model')

      expect(result.ok).toBe(true)
      const planId = (result as { planId: string }).planId
      const ops = await store.readOps(planId)
      const { view } = foldOps(planId, ops)
      const args = (
        view.nodes.find((n) => n.id === 'archive')!.definition as { args: Record<string, unknown> }
      ).args

      expect(args.path).toBe('/tmp/x')
      expect(ParamRef.isParamRef(args.path)).toBe(false)
      expect(JSON.stringify(ops)).not.toContain('ParamRef')
    })

    it('refuses a missing or wrong-typed arg as a VALUE, not a throw', async () => {
      // A model reads this result, so failure is data rather than an exception.
      const store = new InMemoryPlanStore()

      const missing = await instantiateTemplate(store, goodTemplate, {}, 'model')
      expect(missing).toMatchObject({ ok: false, reason: 'invalid_args' })
      expect((missing as { detail: string }).detail).toContain('folder')

      const wrongType = await instantiateTemplate(store, goodTemplate, { folder: 42 }, 'model')
      expect(wrongType).toMatchObject({ ok: false, reason: 'invalid_args' })
    })

    it('mints an EDITABLE, unapproved plan recording its template provenance', async () => {
      const store = new InMemoryPlanStore()
      const result = await instantiateTemplate(store, goodTemplate, { folder: '/tmp/x' }, 'model')
      const planId = (result as { planId: string }).planId

      const state = await store.readState(planId)
      expect(state.state).toBe('editable')

      const provenance = await store.readProvenance(planId)
      expect(provenance).toMatchObject({ template: 'archive-folder' })
    })

    it('gives ops FRESH identity: distinct opIds and monotonic lamports', async () => {
      // A static literal cannot carry opId/actorId/lamport/at — the same reason bounds are a fold
      // seed rather than an implied op. Identity is minted at instantiation.
      const store = new InMemoryPlanStore()
      const result = await instantiateTemplate(store, goodTemplate, { folder: '/tmp/x' }, 'model')
      const ops = await store.readOps((result as { planId: string }).planId)

      expect(new Set(ops.map((o) => o.opId)).size).toBe(ops.length)
      for (const op of ops) expect(op.actorId).toBe('model')
      const lamports = ops.map((o) => o.lamport)
      expect([...lamports].sort((a, b) => a - b)).toEqual(lamports)
    })

    it('yields INDEPENDENT plans on two instantiations', async () => {
      const store = new InMemoryPlanStore()
      const first = await instantiateTemplate(store, goodTemplate, { folder: '/a' }, 'model')
      const second = await instantiateTemplate(store, goodTemplate, { folder: '/b' }, 'model')

      const firstId = (first as { planId: string }).planId
      const secondId = (second as { planId: string }).planId
      expect(firstId).not.toBe(secondId)

      const firstView = foldOps(firstId, await store.readOps(firstId)).view
      const secondView = foldOps(secondId, await store.readOps(secondId)).view
      expect(firstView.digest).not.toBe(secondView.digest)
    })
  })
})
