import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemorySkillSource } from '@nhtio/adk/batteries/skills/in_memory'
import { createSkillManager, forgeSkillTools } from '@nhtio/adk/batteries/skills'
import {
  Tool,
  Tokenizable,
  SpooledMarkdownArtifact,
  ArtifactTool,
  ToolCall,
} from '@nhtio/adk/common'
import type { SkillWorkspace } from '@nhtio/adk/batteries/skills'
import type { SkillDescriptor } from '@nhtio/adk/batteries/skills'
import type { DispatchExecutorFn, TurnPipelineMiddlewareFn } from '@nhtio/adk'
import type { SandboxHandle, SandboxPolicy } from '../../../../src/batteries/sandbox'
import type { DiscoveredSkill, SkillRef, SkillSource } from '@nhtio/adk/batteries/skills'

const descriptor = (tools: Tool[] = [], channel?: 'handle' | 'inline'): SkillDescriptor => ({
  id: 'demo',
  name: 'Demo',
  description: 'A test skill',
  version: '1.0.0',
  ...(tools.length ? { tools } : {}),
  ...(channel ? { channel } : {}),
})

const sourceFor = (skillDescriptor: SkillDescriptor = descriptor()) =>
  new InMemorySkillSource('memory', [
    {
      id: 'demo',
      version: '1.0.0',
      manifest: '---\nname: Demo\ndescription: A test skill\n---\n\nBody text\n',
      descriptor: skillDescriptor,
    },
  ])

const gate = async () => {}

const skillTool = (calls: { count: number }): Tool =>
  new Tool({
    name: 'demo_run',
    description: 'run demo',
    inputSchema: validator.object({}).unknown(false),
    handler: async () => {
      calls.count++
      return 'ok'
    },
  })

const runTurn = (
  executorCallback: DispatchExecutorFn,
  tools: Tool[],
  pipeline: TurnPipelineMiddlewareFn[]
) => makeFixtureRunner({ executorCallback, tools, turnInputPipeline: pipeline })

describe('skills manager central claims', () => {
  it('hydrates a loaded skill across turn boundaries, and does not without turnInput', async () => {
    const calls = { count: 0 }
    const manager = await createSkillManager({
      sources: [sourceFor(descriptor([skillTool(calls)]))],
      gate,
    })
    const lifecycle = Object.values(forgeSkillTools(manager))
    let turn = 0
    const seen: Array<string | undefined> = []
    const executor: DispatchExecutorFn = async (ctx) => {
      if (turn++ === 0) {
        await ctx.tools.get('load_skill')!.executor(ctx)({ skill: 'demo' })
      } else {
        const tool = ctx.tools.get('demo_run')
        seen.push(tool?.name)
        if (tool) await tool.executor(ctx)({})
      }
      ctx.ack()
    }
    const runner = runTurn(executor, lifecycle, [manager.middleware.turnInput])
    await runner.run()
    await runner.run()
    expect(seen).toEqual(['demo_run'])
    expect(calls.count).toBe(1)
    await manager.dispose()

    const negativeManager = await createSkillManager({
      sources: [sourceFor(descriptor([skillTool(calls)]))],
      gate,
    })
    const negativeLifecycle = Object.values(forgeSkillTools(negativeManager))
    let negativeTurn = 0
    const negativeSeen: Array<string | undefined> = []
    const negativeExecutor: DispatchExecutorFn = async (ctx) => {
      if (negativeTurn++ === 0) {
        await ctx.tools.get('load_skill')!.executor(ctx)({ skill: 'demo' })
      } else {
        negativeSeen.push(ctx.tools.get('demo_run')?.name)
      }
      ctx.ack()
    }
    const negativeRunner = runTurn(negativeExecutor, negativeLifecycle, [])
    await negativeRunner.run()
    await negativeRunner.run()
    expect(negativeSeen).toEqual([undefined])
    await negativeManager.dispose()
  })

  it('projects bodies through the byte spool without calling consumer storeRetrievable', async () => {
    const stored = vi.fn()
    const manager = await createSkillManager({ sources: [sourceFor()], gate })
    const ctx = makeDispatchContext({ storeRetrievable: stored })
    await manager.load('demo', ctx)
    expect(stored).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('turnOutput strips the body and tools hydrated by turnInput', async () => {
    const manager = await createSkillManager({
      sources: [sourceFor(descriptor([skillTool({ count: 0 })]))],
      gate,
    })
    const result = await manager.load('demo', makeDispatchContext())
    const seenBeforeStrip: Array<{ body: boolean; tool: boolean }> = []
    const seenAfterStrip: Array<{ body: boolean; tool: boolean }> = []
    const executor: DispatchExecutorFn = async (ctx) => {
      ctx.ack()
    }
    const stripObserver: TurnPipelineMiddlewareFn = async (ctx, next) => {
      seenBeforeStrip.push({
        body: ctx.turnRetrievables.has(result.retrievable!),
        tool: ctx.tools.get('demo_run') !== undefined,
      })
      await next()
      seenAfterStrip.push({
        body: ctx.turnRetrievables.has(result.retrievable!),
        tool: ctx.tools.get('demo_run') !== undefined,
      })
    }
    const runner = makeFixtureRunner({
      executorCallback: executor,
      tools: [],
      turnInputPipeline: [manager.middleware.turnInput],
      turnOutputPipeline: [stripObserver, manager.middleware.turnOutput],
    })
    await runner.run()
    expect(seenBeforeStrip).toEqual([{ body: true, tool: true }])
    expect(seenAfterStrip).toEqual([{ body: false, tool: false }])
    await manager.dispose()
  })

  it('autoRefresh reports an updated loaded skill without swapping its version', async () => {
    let version = '1'
    let currentDescriptor: SkillDescriptor = {
      ...descriptor([skillTool({ count: 0 })]),
      version: '1',
    }
    const source: SkillSource = {
      id: 'memory',
      async *discover(): AsyncIterable<DiscoveredSkill> {
        yield {
          id: 'demo',
          version,
          name: 'Demo',
          description: 'A test skill',
        }
      },
      async descriptor(_ref: SkillRef): Promise<SkillDescriptor> {
        return currentDescriptor
      },
      async read(_ref: SkillRef): Promise<ReadableStream<Uint8Array>> {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('Body text\\n'))
            controller.close()
          },
        })
      },
      async stat(ref: SkillRef): Promise<{ size: number; version: string }> {
        return { size: 10, version: ref.version }
      },
    }
    const manager = await createSkillManager({ sources: [source], gate, autoRefresh: true })
    const lifecycle = Object.values(forgeSkillTools(manager))
    let turn = 0
    let listed: unknown
    let loadedVersion: unknown
    let firstContext: Parameters<DispatchExecutorFn>[0] | undefined
    const executor: DispatchExecutorFn = async (ctx) => {
      if (turn++ === 0) {
        firstContext = ctx
        await ctx.tools.get('load_skill')!.executor(ctx)({ skill: 'demo' })
      }
      ctx.ack()
    }
    const runner = runTurn(executor, lifecycle, [manager.middleware.turnInput])
    await runner.run()
    version = '2'
    currentDescriptor = {
      ...descriptor([skillTool({ count: 0 })]),
      version: '2',
    }
    await runner.run()
    loadedVersion = manager.projected(firstContext!)[0].tools[0].meta.get('skillVersion')
    listed = await forgeSkillTools(manager).list_skills.executor(makeDispatchContext())({
      refresh: false,
      query: 'demo',
    })

    expect(loadedVersion).toBe('1')
    expect(manager.catalog()[0]).toMatchObject({
      ref: { version: '2' },
      updateAvailable: true,
    })
    expect(listed).toBeDefined()
    const listPayload = JSON.parse(String(listed)) as {
      skills: Array<{ id: string; version: string; updateAvailable?: boolean }>
    }
    expect(listPayload.skills).toContainEqual({
      id: 'demo',
      name: 'Demo',
      description: 'A test skill',
      version: '2',
      sourceId: 'memory',
      loaded: true,
      updateAvailable: true,
    })
    await manager.dispose()
  })

  it('integrates tier-3 scripts through createSkillManager', async () => {
    const materialize = vi.fn(async () => '/workspace/demo')
    const workspace = {
      materialize,
      dispose: vi.fn(async () => {}),
      fileSystem: {} as SkillWorkspace['fileSystem'],
      root: '/workspace',
    } satisfies SkillWorkspace
    const handle = {} as SandboxHandle
    const scriptDescriptor: SkillDescriptor = {
      id: 'demo',
      name: 'Demo',
      description: 'A test skill',
      version: '1.0.0',
      scripts: [
        {
          name: 'check',
          path: 'bin/check.sh',
          description: 'Check the skill',
          interpreter: 'sh',
        },
      ],
    }
    const manager = await createSkillManager({
      sources: [
        new InMemorySkillSource('memory', [
          {
            id: 'demo',
            version: '1.0.0',
            manifest: '---\\nname: Demo\\ndescription: A test skill\\n---\\n\\nBody\\n',
            descriptor: scriptDescriptor,
            files: { 'bin/check.sh': '#!/bin/sh\\necho ok' },
          },
        ]),
      ],
      gate,
      scripts: {
        handle,
        workspace,
        policy: {} as SandboxPolicy,
        translator: {} as never,
        interpreters: { sh: ['/bin/sh'] },
        interpreterReadPaths: [],
        maxTimeoutSeconds: 3,
        defaultTimeoutSeconds: 1,
        maxOutputBytes: 1000,
        hostEnvIsolated: true,
      },
    })
    const result = await manager.load('demo', makeDispatchContext())
    expect(result.tools.map((tool) => tool.name)).toContain('run_demo_check')
    expect(materialize).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('forwards ctx.abortSignal into the running script (parent abort stops it)', async () => {
    let capturedSignal: AbortSignal | undefined
    const materialize = vi.fn(async () => '/workspace/demo')
    const workspace = {
      materialize,
      dispose: vi.fn(async () => {}),
      // stat returns a non-symlink so the symlink guard passes for any path segment.
      fileSystem: {
        stat: async () => ({ kind: 'file' as const }),
      } as unknown as SkillWorkspace['fileSystem'],
      root: '/workspace',
    } satisfies SkillWorkspace
    const handle = {
      run: vi.fn(async (op: { signal?: AbortSignal }) => {
        capturedSignal = op.signal
        const empty = new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        })
        return {
          stdout: empty,
          stderr: new ReadableStream<Uint8Array>({
            start(c) {
              c.close()
            },
          }),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      }),
    } as unknown as SandboxHandle
    const scriptDescriptor: SkillDescriptor = {
      id: 'demo',
      name: 'Demo',
      description: 'A test skill',
      version: '1.0.0',
      scripts: [{ name: 'check', path: 'check.sh', description: 'Check', interpreter: 'sh' }],
    }
    const manager = await createSkillManager({
      sources: [
        new InMemorySkillSource('memory', [
          {
            id: 'demo',
            version: '1.0.0',
            manifest: '---\nname: Demo\ndescription: A test skill\n---\n\nBody\n',
            descriptor: scriptDescriptor,
            files: { 'check.sh': '#!/bin/sh\necho ok' },
          },
        ]),
      ],
      gate,
      scripts: {
        handle,
        workspace,
        // A permissive session policy the derived per-skill policy is a subset of.
        policy: {
          filesystem: { denyRead: ['/'], allowRead: ['/'], allowWrite: ['/workspace/demo/tmp'] },
          network: {},
        } as SandboxPolicy,
        translator: {} as never,
        interpreters: { sh: ['/bin/sh'] },
        interpreterReadPaths: [],
        maxTimeoutSeconds: 5,
        defaultTimeoutSeconds: 2,
        maxOutputBytes: 1000,
        hostEnvIsolated: true,
      },
    })
    // A context whose turn is already aborted; the run signal handed to handle.run must reflect it.
    const turnAbortController = new AbortController()
    turnAbortController.abort('cancelled')
    const ctx = makeDispatchContext({ turnAbortController })
    const load = await manager.load('demo', ctx)
    const runTool = load.tools.find((t) => t.name === 'run_demo_check')!
    await runTool.executor(ctx)({ timeout_seconds: 2 })
    expect(handle.run).toHaveBeenCalledTimes(1)
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(true)
    await manager.dispose()
  })

  it('unload removes body-reader results but preserves unrelated tool results', async () => {
    const manager = await createSkillManager({ sources: [sourceFor()], gate })
    const ctx = makeDispatchContext()
    const result = await manager.load('demo', ctx)
    const readers = SpooledMarkdownArtifact.forgeTools(ctx)
    const reader = readers.get('artifact_md_sections') as ArtifactTool
    const readerResult = await reader.executor(ctx)({ callId: result.retrievable!.id })
    const bodyRead = new ToolCall({
      id: 'body-read',
      tool: 'artifact_md_sections',
      args: { callId: result.retrievable!.id },
      checksum: 'body-read',
      isComplete: true,
      isError: false,
      results: new Tokenizable(String(readerResult)),
      fromArtifactTool: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    const differentArtifact = new ToolCall({
      id: 'different-artifact',
      tool: 'artifact_md_sections',
      args: { callId: 'some-other-artifact' },
      checksum: 'different-artifact',
      isComplete: true,
      isError: false,
      results: new Tokenizable('keep this script output'),
      fromArtifactTool: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    const oldRead = new ToolCall({
      id: 'old-read',
      tool: 'artifact_md_sections',
      args: { callId: result.retrievable!.id },
      checksum: 'old-read',
      isComplete: true,
      isError: false,
      results: new Tokenizable('keep this old read'),
      fromArtifactTool: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      completedAt: new Date(0),
    })
    const ordinarySameId = new ToolCall({
      id: 'ordinary-same-id',
      tool: 'other_tool',
      args: { callId: result.retrievable!.id },
      checksum: 'ordinary-same-id',
      isComplete: true,
      isError: false,
      results: new Tokenizable('keep this ordinary result'),
      fromArtifactTool: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    await ctx.storeToolCall(bodyRead)
    await ctx.storeToolCall(differentArtifact)
    await ctx.storeToolCall(oldRead)
    await ctx.storeToolCall(ordinarySameId)

    await manager.unload('demo', ctx)

    expect([...ctx.turnToolCalls].map((call) => call.id)).toEqual([
      'different-artifact',
      'old-read',
      'ordinary-same-id',
    ])
    await manager.dispose()
  })

  it('unload removes an inline body from the context', async () => {
    const manager = await createSkillManager({
      sources: [sourceFor(descriptor([], 'inline'))],
      gate,
    })
    const ctx = makeDispatchContext()
    const result = await manager.load('demo', ctx)
    expect(result.retrievable?.inline).toBe(true)
    expect(ctx.turnRetrievables.has(result.retrievable!)).toBe(true)
    await manager.unload('demo', ctx)
    expect(ctx.turnRetrievables.has(result.retrievable!)).toBe(false)
    expect(ctx.tools.all().some((tool) => tool.meta.get('skill') === 'demo')).toBe(false)
    expect(manager.loaded()).toEqual([])
    await manager.dispose()
  })

  it('does not treat an inherited toolOutputs key as a declared output kind', async () => {
    // A tool named after an inherited Object key ('toString') with NO own toolOutputs entry must
    // not pick up Function.prototype.toString as its declared output kind — that would reject every
    // valid string return as a shape mismatch and make the tool undispatchable.
    const toStringTool = new Tool({
      name: 'toString',
      description: 'a tool with a reserved-key name',
      inputSchema: validator.object({}).unknown(false),
      handler: async () => 'ok',
    })
    const manager = await createSkillManager({
      // toolOutputs is present but has no OWN 'toString' entry.
      sources: [sourceFor({ ...descriptor([toStringTool]), toolOutputs: { demo_run: 'text' } })],
      gate,
    })
    const ctx = makeDispatchContext()
    const load = await manager.load('demo', ctx)
    const tool = load.tools.find((t) => t.name === 'toString')!
    // The tool resolves and returns its string; no spurious declared-mismatch rejection.
    await expect(tool.executor(ctx)({})).resolves.toBe('ok')
    await manager.dispose()
  })
})
