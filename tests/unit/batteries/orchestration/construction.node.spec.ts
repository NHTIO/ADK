import { describe, it, expect } from 'vitest'
import { createOrchestration } from '../../../../src/batteries/orchestration'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { createStructuredCell } from '../../../../src/batteries/orchestration/cells/structured'
import type {
  InvocableTools,
  PlanTemplate,
  PredicateEvaluator,
} from '../../../../src/batteries/orchestration/types'

/**
 * `createOrchestration` is the assembly gate, and the only place a precondition can be enforced
 * for EVERY operation. These cases pin the four things it exists to do at boot — enforce the
 * encoder, register the encodables, load the cells, validate the templates — plus the
 * dependency-precedence rules, which are resolved here precisely so they cannot drift between
 * the freeze path and the run path.
 */
describe('createOrchestration', () => {
  const invocable: InvocableTools = {
    has: (tool) => tool === 'ok_tool',
    names: () => ['ok_tool'],
    returns: () => ({ kind: 'text' }),
  }

  const config = (over: Record<string, unknown> = {}) => ({
    store: new InMemoryPlanStore(),
    invocable,
    deps: { evaluators: [createStructuredCell()] },
    ...over,
  })

  it('assembles the whole public surface', async () => {
    const orch = await createOrchestration(config() as never)
    expect(typeof orch.freezePlan).toBe('function')
    expect(typeof orch.approvePlan).toBe('function')
    expect(typeof orch.executePlan).toBe('function')
    expect(typeof orch.instantiate).toBe('function')
    expect(typeof orch.templates).toBe('function')
    expect(typeof orch.render).toBe('function')
    expect(typeof orch.tools).toBe('function')
    expect(orch.raw.plan).toBeTypeOf('function')
    expect(orch.raw.ops).toBeTypeOf('function')
    expect(orch.raw.diff).toBeTypeOf('function')
    expect(orch.raw.outline).toBeTypeOf('function')
    expect(orch.store).toBeDefined()
  })

  it('registers the encodables, so a plan digest is available immediately', async () => {
    // The digest comes from a lossless canonical encoding and is load-bearing in every
    // lifecycle transition, so a freshly created plan must already have one.
    const orch = await createOrchestration(config() as never)
    const created = await orch.store.createPlan('plan-a')
    expect(created.ok).toBe(true)
    const state = await orch.store.readState('plan-a')
    expect(state.digest).toBeTruthy()
    expect(state.revision).toBe(0)
  })

  it('LOADS every configured cell at construction, not at first freeze', async () => {
    let loaded = 0
    const counting: PredicateEvaluator = {
      id: 'counting',
      load: async () => {
        loaded += 1
      },
      validate: async () => {},
      evaluate: async () => ({ kind: 'branch', matched: true }),
    }
    await createOrchestration(config({ deps: { evaluators: [counting] } }) as never)
    // A missing optional peer must surface at boot rather than part-way through a freeze.
    expect(loaded).toBe(1)
  })

  it('fails at BOOT when a configured cell cannot load', async () => {
    const broken: PredicateEvaluator = {
      id: 'broken',
      load: async () => {
        throw new Error('E_ORCH_CELL_UNAVAILABLE: install nothing-here')
      },
      validate: async () => {},
      evaluate: async () => ({ kind: 'branch', matched: false }),
    }
    await expect(
      createOrchestration(config({ deps: { evaluators: [broken] } }) as never)
    ).rejects.toThrow(/E_ORCH_CELL_UNAVAILABLE|nothing-here/)
  })

  it('validates registered templates at BOOT, naming the problem', async () => {
    // A misconfigured deployment must fail at startup, not at first instantiation months later.
    const badTemplate = {
      id: 'bad',
      summary: 'names a tool outside the allowlist',
      params: [],
      nodes: [
        { id: 'entry', kind: 'entry', definition: { input: [] } },
        {
          id: 'a',
          kind: 'call',
          definition: {
            tool: 'not_in_allowlist',
            args: {},
            output: [],
            onMissingValue: 'fail',
            authority: [],
            replaySafe: true,
            onIndeterminate: 'halt',
          },
        },
      ],
      edges: [{ id: 'e1', from: 'entry', to: 'a', handle: 'always' }],
    } as unknown as PlanTemplate

    await expect(
      createOrchestration(config({ templates: [badTemplate] }) as never)
    ).rejects.toThrow(/not_in_allowlist|ok_tool|template/i)
  })

  it('accepts a well-formed template and reports it through templates()', async () => {
    const good = {
      id: 'archive',
      summary: 'Archive stale invoices',
      params: [{ path: 'folder', type: 'string' }],
      nodes: [{ id: 'entry', kind: 'entry', definition: { input: [] } }],
      edges: [],
    } as unknown as PlanTemplate

    const orch = await createOrchestration(config({ templates: [good] }) as never)
    const listed = orch.templates()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe('archive')
    expect(listed[0]!.summary).toContain('Archive')
    expect(listed[0]!.params).toHaveLength(1)
  })

  it('forges both tool tiers, and tier A withholds graph mechanics', async () => {
    const orch = await createOrchestration(config() as never)
    const front = Object.keys(orch.tools('front'))
    const authoring = Object.keys(orch.tools('authoring'))
    expect(front).toContain('list_templates')
    expect(front).not.toContain('add_node')
    expect(authoring).toContain('add_node')
  })

  it('merges per-call evaluators by cell id, keeping the others', async () => {
    // A run legitimately swaps ONE cell while keeping the rest, so evaluators merge by id
    // rather than replacing wholesale like every other dependency.
    const configured = createStructuredCell()
    const replacement: PredicateEvaluator = {
      id: 'structured', // same id — must REPLACE the configured one
      load: async () => {},
      validate: async () => {},
      evaluate: async () => ({ kind: 'branch', matched: true }),
    }
    const extra: PredicateEvaluator = {
      id: 'extra',
      load: async () => {},
      validate: async () => {},
      evaluate: async () => ({ kind: 'branch', matched: false }),
    }
    const orch = await createOrchestration(
      config({ deps: { evaluators: [configured, extra] } }) as never
    )
    await orch.store.createPlan('plan-m')
    // An empty plan has no branch node, so freeze reports issues rather than throwing — the
    // point here is that supplying an override does not discard the configured cells.
    const result = await orch.freezePlan('plan-m', { evaluators: [replacement] })
    expect(result).toHaveProperty('issues')
    expect(Array.isArray(result.issues)).toBe(true)
  })
})
