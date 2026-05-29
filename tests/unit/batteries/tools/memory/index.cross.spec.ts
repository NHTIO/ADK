import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Memory } from '../../../../../src/lib/classes/memory'
import {
  deleteMemoryTool,
  listMemoriesTool,
  memoryTools,
  storeMemoryTool,
  updateMemoryTool,
} from '../../../../../src/batteries/tools/memory'
import type { DispatchContext } from '../../../../../src/lib/contracts/dispatch_context'

interface CtxStubState {
  memories: Memory[]
  stored: Memory[]
  mutated: Memory[]
  deleted: string[]
}

const makeCtxStub = (initial: Memory[] = []): { ctx: DispatchContext; state: CtxStubState } => {
  const state: CtxStubState = {
    memories: [...initial],
    stored: [],
    mutated: [],
    deleted: [],
  }
  const ctx = {
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
    fetchMemories: async () => state.memories,
    storeMemory: async (m: Memory) => {
      state.stored.push(m)
      state.memories.push(m)
    },
    mutateMemory: async (m: Memory) => {
      state.mutated.push(m)
      state.memories = state.memories.map((existing) => (existing.id === m.id ? m : existing))
    },
    deleteMemory: async (id: string) => {
      state.deleted.push(id)
      state.memories = state.memories.filter((existing) => existing.id !== id)
    },
  } as unknown as DispatchContext
  return { ctx, state }
}

const sampleMemory = (overrides: Partial<{ id: string; content: string }> = {}) =>
  new Memory({
    id: overrides.id ?? 'mem-1',
    content: overrides.content ?? 'first memory',
    confidence: 0.9,
    importance: 0.5,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  })

describe('listMemoriesTool', () => {
  it('has name `list_memories` and a JSON artifact constructor', () => {
    expect(listMemoriesTool.name).toBe('list_memories')
    expect(listMemoriesTool.artifactConstructor).toBeDefined()
  })

  it('returns a JSON array of memory records', async () => {
    const { ctx } = makeCtxStub([sampleMemory(), sampleMemory({ id: 'mem-2', content: 'second' })])
    const result = await listMemoriesTool.executor(ctx)({})
    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'mem-1', content: 'first memory', confidence: 0.9 })
    expect(parsed[1]).toMatchObject({ id: 'mem-2', content: 'second' })
  })

  it('returns `[]` when no memories are present', async () => {
    const { ctx } = makeCtxStub()
    const result = await listMemoriesTool.executor(ctx)({})
    expect(JSON.parse(result as string)).toEqual([])
  })

  it('returns an error string when fetchMemories throws', async () => {
    const ctx = {
      id: 'turn-1',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
      fetchMemories: async () => {
        throw new Error('boom')
      },
    } as unknown as DispatchContext
    const result = await listMemoriesTool.executor(ctx)({})
    expect(result).toMatch(/^Error: /)
    expect(result).toContain('boom')
  })
})

describe('storeMemoryTool', () => {
  it('has name `store_memory`', () => {
    expect(storeMemoryTool.name).toBe('store_memory')
  })

  it('persists a new memory and auto-generates id + timestamps when omitted', async () => {
    const { ctx, state } = makeCtxStub()
    const before = DateTime.now()
    const result = await storeMemoryTool.executor(ctx)({
      content: 'remember this',
      confidence: 0.8,
      importance: 0.6,
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.memory.id).toBeTruthy()
    expect(parsed.memory.content).toBe('remember this')
    expect(parsed.memory.confidence).toBe(0.8)
    expect(state.stored).toHaveLength(1)
    const after = DateTime.now()
    const createdAt = DateTime.fromISO(parsed.memory.createdAt)
    expect(createdAt >= before && createdAt <= after).toBe(true)
  })

  it('uses an explicit id when supplied', async () => {
    const { ctx, state } = makeCtxStub()
    const result = await storeMemoryTool.executor(ctx)({
      id: 'explicit-id',
      content: 'x',
      confidence: 0.5,
      importance: 0.5,
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.memory.id).toBe('explicit-id')
    expect(state.stored[0].id).toBe('explicit-id')
  })

  it('rejects out-of-range confidence', async () => {
    const { ctx } = makeCtxStub()
    await expect(
      storeMemoryTool.executor(ctx)({ content: 'x', confidence: 1.5, importance: 0.5 })
    ).rejects.toThrow()
  })

  it('returns an error string when storeMemory rejects', async () => {
    const ctx = {
      id: 'turn-1',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
      storeMemory: async () => {
        throw new Error('persistence failure')
      },
    } as unknown as DispatchContext
    const result = await storeMemoryTool.executor(ctx)({
      content: 'x',
      confidence: 0.5,
      importance: 0.5,
    })
    expect(result).toMatch(/^Error: /)
    expect(result).toContain('persistence failure')
  })
})

describe('updateMemoryTool', () => {
  it('has name `update_memory`', () => {
    expect(updateMemoryTool.name).toBe('update_memory')
  })

  it('mutates an existing memory and bumps updatedAt', async () => {
    const initial = sampleMemory()
    const { ctx, state } = makeCtxStub([initial])
    const result = await updateMemoryTool.executor(ctx)({
      id: 'mem-1',
      content: 'updated content',
      confidence: 0.1,
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.memory.content).toBe('updated content')
    expect(parsed.memory.confidence).toBe(0.1)
    expect(parsed.memory.importance).toBe(0.5)
    expect(parsed.memory.createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(parsed.memory.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')
    expect(state.mutated).toHaveLength(1)
    expect(state.mutated[0].id).toBe('mem-1')
  })

  it('returns an error string when the id is not found', async () => {
    const { ctx, state } = makeCtxStub([sampleMemory()])
    const result = await updateMemoryTool.executor(ctx)({
      id: 'unknown',
      content: 'x',
    })
    expect(result).toMatch(/^Error: /)
    expect(result).toContain('unknown')
    expect(state.mutated).toHaveLength(0)
  })
})

describe('deleteMemoryTool', () => {
  it('has name `delete_memory`', () => {
    expect(deleteMemoryTool.name).toBe('delete_memory')
  })

  it('delegates to ctx.deleteMemory and reports the id', async () => {
    const { ctx, state } = makeCtxStub([sampleMemory()])
    const result = await deleteMemoryTool.executor(ctx)({ id: 'mem-1' })
    const parsed = JSON.parse(result as string)
    expect(parsed).toEqual({ ok: true, id: 'mem-1' })
    expect(state.deleted).toEqual(['mem-1'])
  })

  it('is idempotent when the id is unknown (harness-level)', async () => {
    const { ctx, state } = makeCtxStub()
    const result = await deleteMemoryTool.executor(ctx)({ id: 'nope' })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(state.deleted).toEqual(['nope'])
  })

  it('returns an error string when ctx.deleteMemory throws', async () => {
    const ctx = {
      id: 'turn-1',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
      deleteMemory: async () => {
        throw new Error('cannot delete')
      },
    } as unknown as DispatchContext
    const result = await deleteMemoryTool.executor(ctx)({ id: 'mem-1' })
    expect(result).toMatch(/^Error: /)
  })
})

describe('memoryTools tuple', () => {
  it('contains every CRUD tool in declaration order', () => {
    expect(memoryTools).toEqual([
      listMemoriesTool,
      storeMemoryTool,
      updateMemoryTool,
      deleteMemoryTool,
    ])
  })
})
