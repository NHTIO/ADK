import { describe, it, expect } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemoryPlanStore } from '../../../../src/batteries/orchestration/in_memory'
import { forgeOrchestrationTools } from '../../../../src/batteries/orchestration/forge'
import { createStructuredCell } from '../../../../src/batteries/orchestration/cells/structured'
import { registerOrchestrationEncodables } from '../../../../src/batteries/orchestration/encoding'
import type { InvocableTools, PlanTemplate } from '../../../../src/batteries/orchestration/types'

registerOrchestrationEncodables()

/**
 * The forge is the model-facing surface, and its tier split is a threat-model boundary rather
 * than an organisational one: a conversational agent sees tier A and must NOT be handed graph
 * mechanics, while tier C — what a staged `call` may invoke — is deliberately not a tool tier at
 * all. These cases pin that boundary and the behaviours where a convenient shortcut would
 * reintroduce a defect the design was shaped to avoid.
 */
describe('forgeOrchestrationTools', () => {
  const invocable: InvocableTools = {
    has: (tool) => tool === 'ok_tool',
    names: () => ['ok_tool'],
    returns: () => ({ kind: 'text' }),
  }

  const template = {
    id: 'archive',
    summary: 'Archive stale invoices',
    params: [{ path: 'folder', type: 'string' }],
    nodes: [{ id: 'entry', kind: 'entry', definition: { input: [] } }],
    edges: [],
  } as unknown as PlanTemplate

  const runtime = () => ({
    store: new InMemoryPlanStore(),
    invocable,
    evaluators: [createStructuredCell()],
    templates: [template],
    actorId: 'actor_1',
  })

  /**
   * Invoke a forged tool the way the runner does. `Tool.executor(ctx)` is CURRIED — it takes the
   * dispatch context and returns the function that takes the args — so the context is bound
   * once per dispatch rather than passed per call.
   */
  const invoke = async (
    tools: Record<string, { executor: (ctx: unknown) => (args: unknown) => Promise<unknown> }>,
    name: string,
    args: unknown
  ): Promise<string> => {
    const tool = tools[name]
    if (!tool) throw new Error(`no such tool: ${name}`)
    const result = await tool.executor(makeDispatchContext())(args)
    return typeof result === 'string' ? result : JSON.stringify(result)
  }

  it('does not erase Date/Map/Set/RegExp from a staged argument', async () => {
    // Found by the AI review panel. `hydrateRefs`/`dehydrateRefs` guarded on `isObject`, which is
    // TRUE for Date, Map, Set, RegExp and typed arrays — so the "recurse into a plain object"
    // branch caught them and rebuilt each from `Object.keys`. A Date has no enumerable own keys,
    // so it came back `{}`: a staged argument silently erased on its way into the plan, and shown
    // back to the model as `{}` on the way out.
    //
    // This is the same data loss that disqualified `canonicalStringify` as the digest strategy,
    // reappearing one layer up. Driven through the real tool path, since the hydration helpers are
    // module-private — which is also how a model actually reaches them.
    const rt = runtime()
    const tools = forgeOrchestrationTools(rt, { tier: 'authoring' }) as never

    await invoke(tools, 'create_plan', { planId: 'plan-hydration' })
    await invoke(tools, 'add_node', {
      planId: 'plan-hydration',
      node: { id: 'entry', kind: 'entry', definition: { input: [] } },
    })
    await invoke(tools, 'add_node', {
      planId: 'plan-hydration',
      node: {
        id: 'act',
        kind: 'call',
        definition: {
          tool: 'ok_tool',
          args: {
            when: new Date('2020-01-01T00:00:00.000Z'),
            tags: new Set(['a']),
            lookup: new Map([['k', 1]]),
            pattern: /^inv-\d+$/i,
          },
          output: [],
          onMissingValue: 'fail',
          authority: [],
          replaySafe: true,
          onIndeterminate: 'halt',
        },
      },
    })

    const ops = await rt.store.readOps('plan-hydration')
    const added = ops.find(
      (o): o is Extract<typeof o, { op: 'add_node' }> => o.op === 'add_node' && o.node.id === 'act'
    )
    const args = (added!.node.definition as unknown as { args: Record<string, unknown> }).args

    // Each must survive as its real class. Before the fix every one of these was `{}`.
    expect(args.when).toBeInstanceOf(Date)
    expect((args.when as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z')
    expect(args.tags).toBeInstanceOf(Set)
    expect(args.lookup).toBeInstanceOf(Map)
    expect(args.pattern).toBeInstanceOf(RegExp)
  })

  it('tier A is the conversational surface and withholds graph mechanics', () => {
    const front = Object.keys(forgeOrchestrationTools(runtime(), { tier: 'front' }))
    expect(front).toContain('list_templates')
    expect(front).toContain('instantiate_plan')
    expect(front).toContain('author_plan')
    // Adding an agent tool must never add graph mechanics to the conversational surface.
    expect(front).not.toContain('add_node')
    expect(front).not.toContain('connect_nodes')
    expect(front).not.toContain('freeze_plan')
  })

  it('tier B exposes the full authoring vocabulary', () => {
    const authoring = Object.keys(forgeOrchestrationTools(runtime(), { tier: 'authoring' }))
    for (const name of [
      'create_plan',
      'add_node',
      'set_node_config',
      'connect_nodes',
      'remove_node',
      'disconnect_edge',
      'clone_plan',
      'get_plan',
      'validate_plan',
      'freeze_plan',
      'unfreeze_plan',
      'submit_plan',
      'plan_status',
      'raw_plan',
      'raw_diff',
      'plan_outline',
      'plan_read',
    ]) {
      expect(authoring).toContain(name)
    }
  })

  it('every forged tool carries a name, a description and a schema', () => {
    const all = {
      ...forgeOrchestrationTools(runtime(), { tier: 'front' }),
      ...forgeOrchestrationTools(runtime(), { tier: 'authoring' }),
    }
    for (const tool of Object.values(all)) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
    }
  })

  it('states the node vocabulary rather than leaving the grammar to be guessed', () => {
    const authoring = forgeOrchestrationTools(runtime(), { tier: 'authoring' })
    const described = Object.values(authoring).some((t) =>
      /entry|call|reason|transform|branch|select|join/.test(t.description)
    )
    expect(described).toBe(true)
  })

  it('honours a name override without losing the tool', () => {
    const renamed = forgeOrchestrationTools(runtime(), {
      tier: 'front',
      overrides: { list_templates: { name: 'templates_list' } },
    })
    expect(Object.keys(renamed)).toContain('templates_list')
  })

  it('list_templates reports each registered template and its declared params', async () => {
    const front = forgeOrchestrationTools(runtime(), { tier: 'front' })
    const out = await invoke(front as never, 'list_templates', {})
    expect(out).toContain('archive')
    expect(out).toContain('folder')
  })

  it('a mutation returns SCOPED prose, bounded regardless of plan size', async () => {
    const authoring = forgeOrchestrationTools(runtime(), { tier: 'authoring' })
    // The forge validates plan ids against /^plan-[A-Za-z0-9_-]+$/ — a model-authored id cannot
    // be path-shaped or collide with an internal key.
    await invoke(authoring as never, 'create_plan', { planId: 'plan-p1' })
    const out = await invoke(authoring as never, 'add_node', {
      planId: 'plan-p1',
      node: { id: 'entry_node', kind: 'entry', definition: { input: [] } },
    })
    // Returning the whole projected plan is what the prior art did; that was written for a
    // large window and echoes forty nodes on every edit.
    expect(out.length).toBeLessThan(1200)
    expect(out).toContain('entry_node')
  })
})
