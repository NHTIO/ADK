import { Tool } from '@nhtio/adk/common'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { createSkillManager } from '@nhtio/adk/batteries/skills'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import type { SkillDescriptor } from '@nhtio/adk/batteries/skills'
import type { DiscoveredSkill, SkillRef, SkillSource } from '@nhtio/adk/batteries/skills'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const makeTool = (
  name: string,
  value: string,
  entered?: { count: number },
  gate?: Deferred<unknown>
) =>
  new Tool({
    name,
    description: name,
    inputSchema: validator.object({}).unknown(false),
    handler: async () => {
      entered && entered.count++
      if (gate) await gate.promise
      return value
    },
  })

class Source implements SkillSource {
  readonly id = 'test'
  version = '1'
  readonly descriptors = new Map<string, SkillDescriptor>()
  readonly calls: string[] = []
  descriptorGate?: Deferred<void>
  async *discover(): AsyncIterable<DiscoveredSkill> {
    this.calls.push('discover')
    for (const [id, descriptor] of this.descriptors) {
      yield {
        id,
        version: this.version,
        name: descriptor.name,
        description: descriptor.description,
      }
    }
  }
  async descriptor(ref: SkillRef): Promise<SkillDescriptor> {
    this.calls.push('descriptor')
    if (this.descriptorGate) await this.descriptorGate.promise
    return this.descriptors.get(ref.id)!
  }
  async read(): Promise<ReadableStream<Uint8Array>> {
    this.calls.push('read')
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('body'))
        controller.close()
      },
    })
  }
  async stat(ref: SkillRef) {
    return { size: 4, version: ref.version }
  }
}

const descriptor = (id: string, version: string, tool: Tool): SkillDescriptor => ({
  id,
  version,
  name: id,
  description: id,
  tools: [tool],
})
const gate = async () => {}

const sourceWith = (entries: Array<[string, SkillDescriptor]>): Source => {
  const source = new Source()
  for (const [id, value] of entries) source.descriptors.set(id, value)
  return source
}

describe('skills group 2: concurrency and liveness', () => {
  it('serializes concurrent loads and releases a reservation after preparation fails', async () => {
    const source = sourceWith([
      ['a', descriptor('a', '1', makeTool('x', 'a'))],
      ['b', descriptor('b', '1', makeTool('x', 'b'))],
    ])
    const d = deferred<void>()
    source.descriptorGate = d
    const manager = await createSkillManager({ sources: [source], gate })
    const a = makeDispatchContext()
    const b = makeDispatchContext()
    const loadA = manager.load('a', a)
    const loadB = manager.load('b', b)
    d.resolve(undefined)
    await loadA
    // This collision is prevented by synchronous check-and-claim, not by the manager mutex;
    // it would still pass if the mutex were removed.
    await expect(loadB).rejects.toThrow()

    source.descriptorGate = undefined
    source.descriptors.set('a', descriptor('a', '2', makeTool('y', 'a')))
    source.version = '2'
    await manager.unload('a', a)
    await expect(manager.load('b', b)).resolves.toBeDefined()

    const failing = sourceWith([['c', descriptor('c', '1', makeTool('z', 'c'))]])
    const originalRead = failing.read.bind(failing)
    failing.read = async () => {
      throw new Error('materialize failed')
    }
    const second = await createSkillManager({ sources: [failing], gate })
    const c = makeDispatchContext()
    await expect(second.load('c', c)).rejects.toThrow('materialize failed')
    failing.read = originalRead
    await expect(second.load('c', c)).resolves.toBeDefined()
    await manager.dispose()
    await second.dispose()
  })

  it('holds refresh behind an in-flight load', async () => {
    const source = sourceWith([['a', descriptor('a', '1', makeTool('a_tool', 'old'))]])
    const d = deferred<void>()
    source.descriptorGate = d
    const manager = await createSkillManager({ sources: [source], gate })
    const ctx = makeDispatchContext()
    const loading = manager.load('a', ctx)
    source.version = '2'
    const refreshing = manager.refresh()
    d.resolve(undefined)
    await loading
    await refreshing
    const descriptorIndex = source.calls.lastIndexOf('descriptor')
    const readIndex = source.calls.lastIndexOf('read')
    const refreshIndex = source.calls.findIndex(
      (call, index) => index > descriptorIndex && call === 'discover'
    )
    expect(descriptorIndex).toBeLessThan(readIndex)
    expect(readIndex).toBeLessThan(refreshIndex)
    expect(manager.catalog()[0].ref.version).toBe('2')
    await manager.dispose()
  })

  it('refreshes a loaded skill over its own names, rejects another owner, and preserves old state on failure', async () => {
    const source = sourceWith([
      ['a', descriptor('a', '1', makeTool('shared', 'old'))],
      ['b', descriptor('b', '1', makeTool('other', 'other'))],
    ])
    const manager = await createSkillManager({ sources: [source], gate })
    const ctx = makeDispatchContext()
    await manager.load('a', ctx)
    source.version = '2'
    source.descriptors.set('a', descriptor('a', '2', makeTool('shared', 'new')))
    await manager.refreshAndProject(ctx, 'a')
    expect(ctx.tools.get('shared')?.meta.get('skillVersion')).toBe('2')

    await manager.load('b', makeDispatchContext())
    source.version = '3'
    source.descriptors.set('a', descriptor('a', '3', makeTool('other', 'collision')))
    await expect(manager.refreshAndProject(ctx, 'a')).rejects.toThrow()
    expect(manager.loaded()).toContain('a')
    expect(ctx.tools.get('shared')).toBeDefined()

    source.version = '4'
    source.descriptors.set('a', descriptor('a', '4', makeTool('shared', 'newer')))
    const old = ctx.tools.get('shared')
    const originalRead = source.read.bind(source)
    source.read = async () => {
      throw new Error('materialize failed')
    }
    await expect(manager.refreshAndProject(ctx, 'a')).rejects.toThrow('materialize failed')
    expect(ctx.tools.get('shared')).toBe(old)
    expect(manager.loaded()).toContain('a')
    source.read = originalRead
    await manager.refreshAndProject(ctx, 'a')
    expect(ctx.tools.get('shared')).not.toBe(old)
    await manager.dispose()
  })

  it('refreshes and reprojects every loaded skill when the id is omitted', async () => {
    const source = sourceWith([
      ['a', descriptor('a', '1', makeTool('a_tool', 'old'))],
      ['b', descriptor('b', '1', makeTool('b_tool', 'old'))],
    ])
    const manager = await createSkillManager({ sources: [source], gate })
    const ctx = makeDispatchContext()
    await manager.load('a', ctx)
    await manager.load('b', ctx)
    expect(ctx.tools.get('a_tool')?.meta.get('skillVersion')).toBe('1')
    expect(ctx.tools.get('b_tool')?.meta.get('skillVersion')).toBe('1')

    source.version = '2'
    source.descriptors.set('a', descriptor('a', '2', makeTool('a_tool', 'new')))
    source.descriptors.set('b', descriptor('b', '2', makeTool('b_tool', 'new')))

    // A bare refresh must swap AND reproject every loaded skill — not merely re-discover the
    // catalog. Before the fix, the `if (id)` guard skipped the swap entirely and both projected
    // tools stayed on version 1 despite the tool reporting a successful refresh.
    const result = await manager.refreshAndProject(ctx)
    expect([...result.ids].sort()).toEqual(['a', 'b'])
    expect(ctx.tools.get('a_tool')?.meta.get('skillVersion')).toBe('2')
    expect(ctx.tools.get('b_tool')?.meta.get('skillVersion')).toBe('2')
    await manager.dispose()
  })

  it('unregisters an in-flight tool immediately but lets its call settle', async () => {
    const call = deferred<string>()
    const entered = { count: 0 }
    const source = sourceWith([['a', descriptor('a', '1', makeTool('x', 'done', entered, call))]])
    const manager = await createSkillManager({ sources: [source], gate })
    const ctx = makeDispatchContext()
    await manager.load('a', ctx)
    const tool = ctx.tools.get('x')!
    const running = tool.executor(ctx)({})
    while (entered.count === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await manager.unload('a', ctx)
    expect(ctx.tools.get('x')).toBeUndefined()
    call.resolve('done')
    await expect(running).resolves.toBe('done')
    await manager.dispose()
  })

  it('retires a hydrated wrapper in another context before it can spawn or enter', async () => {
    const entered = { count: 0 }
    const source = sourceWith([['a', descriptor('a', '1', makeTool('x', 'ok', entered))]])
    const manager = await createSkillManager({ sources: [source], gate })
    const first = makeDispatchContext()
    const second = makeDispatchContext()
    await manager.load('a', first)
    const wrapper = await manager.load('a', second).catch(() => undefined)
    // The manager is global, so hydrate the second context through the projected record.
    const secondTool = manager.projected(second)[0].tools[0]
    await manager.unload('a', first)
    const staleError = await secondTool
      .executor(second)({})
      .then(
        () => undefined,
        (error: unknown) => error
      )
    expect(staleError).toBeDefined()
    const errorText = JSON.stringify(staleError, (_key, value) =>
      value && typeof value === 'object' && 'name' in value && 'message' in value
        ? {
            name: (value as { name: unknown }).name,
            message: (value as { message: unknown }).message,
            cause: (value as { cause?: unknown }).cause,
          }
        : value
    )
    expect(errorText).toContain('E_SKILL_NOT_LOADED')
    expect(entered.count).toBe(0)
    void wrapper
    await manager.dispose()
  })

  it('does not swap an updated version during autoRefresh turn hydration', async () => {
    const source = sourceWith([['a', descriptor('a', '1', makeTool('x', 'old'))]])
    const manager = await createSkillManager({ sources: [source], gate, autoRefresh: true })
    const ctx = makeDispatchContext()
    await manager.load('a', ctx)
    source.version = '2'
    source.descriptors.set('a', descriptor('a', '2', makeTool('x', 'new')))
    const next = makeDispatchContext()
    await manager.middleware.turnInput(
      next as unknown as Parameters<typeof manager.middleware.turnInput>[0],
      async () => {}
    )
    expect(next.tools.get('x')?.meta.get('skillVersion')).toBe('1')
    expect(manager.catalog()[0].ref.version).toBe('2')
    await manager.dispose()
  })
})
