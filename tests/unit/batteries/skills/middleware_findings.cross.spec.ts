import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemorySkillSource } from '@nhtio/adk/batteries/skills/in_memory'
import {
  createSkillManager,
  forgeSkillTools,
  skillsTurnInputMiddleware,
  skillsTurnOutputMiddleware,
} from '@nhtio/adk/batteries/skills'
import type { DispatchExecutorFn } from '@nhtio/adk'
import type { SkillDescriptor } from '@nhtio/adk/batteries/skills'

const gate = async () => {}
const skillTool = () =>
  new Tool({
    name: 'demo_run',
    description: 'run demo',
    inputSchema: validator.object({}).unknown(false),
    handler: async () => 'ok',
  })
const descriptor: SkillDescriptor = {
  id: 'demo',
  name: 'Demo',
  description: 'A test skill',
  version: '1.0.0',
  tools: [skillTool()],
}
const sourceFor = () =>
  new InMemorySkillSource('memory', [
    {
      id: 'demo',
      version: '1.0.0',
      manifest: '---\nname: Demo\ndescription: A test skill\n---\n\nBody\n',
      descriptor,
    },
  ])

describe('skills middleware — AI-review findings', () => {
  it('standalone turnInput/turnOutput factories share projection state for one manager', async () => {
    const manager = await createSkillManager({ sources: [sourceFor()], gate })
    // Two SEPARATE standalone factory calls — the composition the finding is about.
    const turnInput = skillsTurnInputMiddleware(manager)
    const turnOutput = skillsTurnOutputMiddleware(manager)

    const lifecycle = Object.values(forgeSkillTools(manager))
    let turn = 0
    const seenBefore: boolean[] = []
    const seenAfter: boolean[] = []
    const executor: DispatchExecutorFn = async (ctx) => {
      if (turn++ === 0) await ctx.tools.get('load_skill')!.executor(ctx)({ skill: 'demo' })
      ctx.ack()
    }
    const observer = async (ctx: never, next: () => Promise<void>) => {
      seenBefore.push(
        (ctx as { tools: { get(n: string): unknown } }).tools.get('demo_run') !== undefined
      )
      await next()
      seenAfter.push(
        (ctx as { tools: { get(n: string): unknown } }).tools.get('demo_run') !== undefined
      )
    }
    const runner = makeFixtureRunner({
      executorCallback: executor,
      tools: lifecycle,
      turnInputPipeline: [turnInput],
      turnOutputPipeline: [observer as never, turnOutput],
    })
    await runner.run()
    await runner.run()
    // Turn 2: turnInput (one factory) projected demo_run; turnOutput (the OTHER factory) must
    // see and strip it. With per-factory WeakMaps, turnOutput saw nothing and this stayed true.
    expect(seenBefore).toEqual([false, true])
    expect(seenAfter).toEqual([false, false])
    await manager.dispose()
  })

  it('strips the projection before any downstream turn-output middleware observes it', async () => {
    // The guarantee the battery rests on: a middleware placed AFTER turnOutput (more downstream —
    // a consumer's persistence or observation) must never see the skill body or tools, because
    // turnOutput strips at the head of the pipeline, before its own next(). If the strip ran after
    // next() instead, this downstream stage would observe the projection and could persist it —
    // the exact "the body never leaves" leak this battery exists to prevent.
    const manager = await createSkillManager({ sources: [sourceFor()], gate })
    const turnInput = skillsTurnInputMiddleware(manager)
    const turnOutput = skillsTurnOutputMiddleware(manager)

    const lifecycle = Object.values(forgeSkillTools(manager))
    let turn = 0
    const executor: DispatchExecutorFn = async (ctx) => {
      if (turn++ === 0) await ctx.tools.get('load_skill')!.executor(ctx)({ skill: 'demo' })
      ctx.ack()
    }
    const downstreamSaw: boolean[] = []
    const downstream = async (ctx: never, next: () => Promise<void>) => {
      // Runs INSIDE turnOutput's next(), i.e. after the strip has already happened.
      downstreamSaw.push(
        (ctx as { tools: { get(n: string): unknown } }).tools.get('demo_run') !== undefined
      )
      await next()
    }
    const runner = makeFixtureRunner({
      executorCallback: executor,
      tools: lifecycle,
      turnInputPipeline: [turnInput],
      // turnOutput is UPSTREAM of downstream: it strips, then calls next() into downstream.
      turnOutputPipeline: [turnOutput, downstream as never],
    })
    await runner.run()
    await runner.run()
    // Turn 1 never loaded; turn 2 loaded demo but the strip runs before downstream — so downstream
    // sees the tool gone in BOTH turns. It must never observe a projected skill tool.
    expect(downstreamSaw).toEqual([false, false])
    await manager.dispose()
  })

  it('reconcile does not unregister a same-named tool a later projection replaced', async () => {
    const manager = await createSkillManager({ sources: [sourceFor()], gate })
    const ctx = makeDispatchContext()
    // Project the skill's tool via a real load, then unload so reconcile wants to remove it.
    await manager.load('demo', ctx)
    // A different owner registers its own demo_run AFTER ours, replacing the registry entry.
    const foreign = new Tool({
      name: 'demo_run',
      description: 'foreign',
      inputSchema: validator.object({}).unknown(false),
      meta: { skill: 'other' },
      handler: async () => 'foreign',
    })
    ctx.tools.register(foreign, true)
    await manager.unload('demo', ctx)
    // reconcile runs on the dispatchInput middleware; drive it directly.
    await manager.middleware.dispatchInput(ctx as never, async () => {})
    // The foreign tool must survive — cleanup keyed on our object identity, not the name.
    expect(ctx.tools.get('demo_run')).toBe(foreign)
    await manager.dispose()
  })
})
