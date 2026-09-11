import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { Tool, SpooledArtifact } from '@nhtio/adk/common'
import { createSkillManager } from '@nhtio/adk/batteries/skills'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemorySpoolReader } from '../../../../src/batteries/storage/in_memory'
import type { SkillDescriptor } from '@nhtio/adk/batteries/skills'
import type { DiscoveredSkill, SkillRef, SkillSource } from '@nhtio/adk/batteries/skills'

const gate = vi.fn(async () => {})

class FixtureSource implements SkillSource {
  readonly id = 'hostile-fixtures'
  readonly entries: Map<string, SkillDescriptor>
  constructor(entries: SkillDescriptor[]) {
    this.entries = new Map(entries.map((entry) => [entry.id, entry]))
  }
  async *discover(): AsyncIterable<DiscoveredSkill> {
    for (const descriptor of this.entries.values())
      yield {
        id: descriptor.id,
        version: descriptor.version,
        name: descriptor.name,
        description: descriptor.description,
      }
  }
  async descriptor(ref: SkillRef): Promise<unknown> {
    return this.entries.get(ref.id)
  }
  async read(): Promise<ReadableStream<Uint8Array>> {
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

const descriptor = (id: string, tools: Tool[]): SkillDescriptor => ({
  id,
  name: id,
  description: 'hostile fixture',
  version: '1',
  tools,
})
const tool = (name: string, handler: () => unknown, trusted = true) =>
  new Tool({
    name,
    description: name,
    inputSchema: validator.object({}).unknown(false),
    trusted,
    handler: handler as () => string,
  })
const loadAndCall = async (t: Tool) => {
  const manager = await createSkillManager({
    sources: [new FixtureSource([descriptor('fixture', [t])])],
    gate,
  })
  const ctx = makeDispatchContext()
  await manager.load('fixture', ctx)
  return { manager, ctx, call: () => ctx.tools.get(t.name)!.executor(ctx)({}) }
}
const chain = (error: unknown): unknown[] => {
  const result: unknown[] = []
  let current: unknown = error
  while (current) {
    result.push(current)
    current = isError(current) ? current.cause : undefined
  }
  return result
}
const names = (error: unknown): string[] =>
  chain(error).flatMap((item) => (isError(item) ? [item.name] : []))
const causes = (error: unknown): string =>
  JSON.stringify(error, (_key, value) => {
    if (isError(value)) return { name: value.name, message: value.message, cause: value.cause }
    return value
  })

describe('skills group 3: hostile imported tools', () => {
  it('enforces the gate even when the hostile handler never calls it', async () => {
    const calls = { handler: 0 }
    const { manager, call } = await loadAndCall(
      tool('never_gates', () => {
        calls.handler++
        return 'ok'
      })
    )
    await call()
    expect(gate).toHaveBeenCalled()
    expect(calls.handler).toBe(1)
    await manager.dispose()
  })

  it.each([
    ['undefined', () => undefined],
    ['object', () => ({})],
    ['function', () => () => 'no'],
  ])('rejects %s as E_SKILL_TOOL_BAD_RESPONSE', async (_label, handler) => {
    const { manager, call } = await loadAndCall(tool('bad_response', handler))
    const error = await call().catch((value: unknown) => value)
    expect(names(error)).toContain('E_SKILL_TOOL_BAD_RESPONSE')
    await manager.dispose()
  })

  it('identifies a prebuilt SpooledArtifact as the bad response', async () => {
    const { manager, call } = await loadAndCall(
      tool('bad_response', () => new SpooledArtifact(new InMemorySpoolReader('not yours')))
    )
    const error = await call().catch((value: unknown) => value)
    expect(names(error)).toContain('E_SKILL_TOOL_BAD_RESPONSE')
    expect(causes(error)).toContain('bad_response returned a SpooledArtifact')
    await manager.dispose()
  })

  it('wraps Error throws with the documented four-level cause chain', async () => {
    const { manager, call } = await loadAndCall(
      tool('error_throw', () => {
        throw new Error('secret-error')
      })
    )
    const error = await call().catch((value: unknown) => value)
    expect(names(error)).toContain('E_SKILL_TOOL_FAILED')
    expect(causes(error)).toContain('secret-error')
    await manager.dispose()
  })

  it('does not make a bare string throw recoverable through the cause chain', async () => {
    const { manager, call } = await loadAndCall(
      tool('string_throw', () => {
        throw 'secret-string'
      })
    )
    const error = await call().catch((value: unknown) => value)
    expect(names(error)).toContain('E_SKILL_TOOL_FAILED')
    expect(causes(error)).not.toContain('secret-string')
    await manager.dispose()
  })

  it('forces imported tools to untrusted, and refuses the reserved artifact reader names', async () => {
    const trusted = tool('ordinary', () => 'ok', true)
    const manager = await createSkillManager({
      sources: [new FixtureSource([descriptor('fixture', [trusted])])],
      gate,
    })
    const ctx = makeDispatchContext()
    await manager.load('fixture', ctx)
    expect(ctx.tools.get('ordinary')!.trusted).toBe(false)
    await manager.dispose()

    for (const name of ['artifact_grep', 'artifact_md_sections']) {
      const collisionManager = await createSkillManager({
        sources: [new FixtureSource([descriptor('fixture', [tool(name, () => 'no')])])],
        gate,
      })
      await expect(collisionManager.load('fixture', makeDispatchContext())).rejects.toMatchObject({
        name: 'E_SKILL_TOOL_COLLISION',
      })
      await collisionManager.dispose()
    }
  })

  it('refuses invalid imported names without normalising the offending pair', async () => {
    for (const name of ['1tool', '-tool', 'tool.id', `${'a'.repeat(40)}${'b'.repeat(30)}`]) {
      const manager = await createSkillManager({
        sources: [new FixtureSource([descriptor('fixture', [tool(name, () => 'no')])])],
        gate,
      })
      await expect(manager.load('fixture', makeDispatchContext())).rejects.toThrow(
        new RegExp(name.replace('.', '\\.'))
      )
      await manager.dispose()
    }
  })

  it('honestly leaves a never-settling handler pending rather than inventing cancellation', async () => {
    const { call } = await loadAndCall(tool('hangs', () => new Promise(() => undefined)))
    await expect(
      Promise.race([
        call(),
        new Promise((resolve) => setTimeout(() => resolve('still pending'), 25)),
      ])
    ).resolves.toBe('still pending')
  }, 200)
})
