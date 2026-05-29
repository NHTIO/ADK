import { describe, expect, it } from 'vitest'
import { calculateTool } from '@nhtio/adk/batteries/tools/math'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { Message, SpooledArtifact, ToolRegistry, isMessage, version } from '@nhtio/adk'

describe('@nhtio/adk published package smoke check', () => {
  it('loads the root entrypoint and constructs common primitives', () => {
    const message = new Message({
      id: 'smoke-user-message',
      role: 'user',
      content: 'hello from the smoke test',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })

    expect(version).toEqual(expect.any(String))
    expect(isMessage(message)).toBe(true)
    expect(message.identity.identifier).toBe('user')
  })

  it('loads exported batteries and runs a tool through the public executor surface', async () => {
    const events: string[] = []
    const ctx = {
      id: 'smoke-turn',
      emitToolExecutionStart: ({ toolName }: { toolName: string }) =>
        events.push(`start:${toolName}`),
      emitToolExecutionEnd: ({ toolName }: { toolName: string }) => events.push(`end:${toolName}`),
    } as any

    const result = await calculateTool.executor(ctx)({ expression: '2 + 3 * 4' })

    expect(result).toContain('Result: 14')
    expect(events).toEqual(['start:calculate', 'end:calculate'])
  })

  it('uses the published storage battery with spooled artifacts', async () => {
    const store = new InMemorySpoolStore()
    const reader = store.write('artifact-1', 'alpha\nbeta\ngamma\n')
    const artifact = new SpooledArtifact(reader)

    expect(store.size).toBe(1)
    expect(await artifact.head(2)).toEqual(['alpha', 'beta'])
    expect(await artifact.grep(/mm/)).toEqual(['gamma'])
    expect(await artifact.asString()).toBe('alpha\nbeta\ngamma\n')
  })

  it('registers published tools through the public package API', async () => {
    const registry = new ToolRegistry([calculateTool])

    expect(registry.has('calculate')).toBe(true)
    expect(registry.get('calculate')?.describe().name).toBe('calculate')
  })
})
