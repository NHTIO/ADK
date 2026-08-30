import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Retrievable } from '../../../../../src/lib/classes/retrievable'
import {
  deleteRetrievableTool,
  listRetrievablesTool,
  retrievableTools,
  storeRetrievableTool,
  updateRetrievableTool,
} from '../../../../../src/batteries/tools/retrievables'
import type { DispatchContext } from '../../../../../src/lib/contracts/dispatch_context'

interface CtxStubState {
  retrievables: Retrievable[]
  stored: Retrievable[]
  mutated: Retrievable[]
  deleted: string[]
}

const makeCtxStub = (
  initial: Retrievable[] = []
): { ctx: DispatchContext; state: CtxStubState } => {
  const state: CtxStubState = {
    retrievables: [...initial],
    stored: [],
    mutated: [],
    deleted: [],
  }
  const ctx = {
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
    fetchRetrievables: async () => state.retrievables,
    storeRetrievable: async (r: Retrievable) => {
      state.stored.push(r)
      state.retrievables.push(r)
    },
    mutateRetrievable: async (r: Retrievable) => {
      state.mutated.push(r)
      state.retrievables = state.retrievables.map((existing) =>
        existing.id === r.id ? r : existing
      )
    },
    deleteRetrievable: async (id: string) => {
      state.deleted.push(id)
      state.retrievables = state.retrievables.filter((existing) => existing.id !== id)
    },
  } as unknown as DispatchContext
  return { ctx, state }
}

const sampleRetrievable = (
  overrides: Partial<{
    id: string
    content: string
    trustTier: 'first-party' | 'third-party-public' | 'third-party-private'
    source: string
    kind: string
    score: number
  }> = {}
) =>
  new Retrievable({
    id: overrides.id ?? 'ret-1',
    content: overrides.content ?? 'policy body',
    trustTier: overrides.trustTier ?? 'first-party',
    source: overrides.source ?? 'kb://policy/1',
    kind: overrides.kind ?? 'policy',
    score: overrides.score ?? 0.7,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  })

describe('listRetrievablesTool', () => {
  it('has name `list_retrievables`', () => {
    expect(listRetrievablesTool.name).toBe('list_retrievables')
  })

  it('returns a JSON array of retrievable records', async () => {
    const { ctx } = makeCtxStub([
      sampleRetrievable(),
      sampleRetrievable({ id: 'ret-2', trustTier: 'third-party-public' }),
    ])
    const result = await listRetrievablesTool.executor(ctx)({})
    const parsed = JSON.parse(result as string)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'ret-1', trustTier: 'first-party', kind: 'policy' })
    expect(parsed[1].trustTier).toBe('third-party-public')
  })

  it('returns `[]` when no retrievables are present', async () => {
    const { ctx } = makeCtxStub()
    const result = await listRetrievablesTool.executor(ctx)({})
    expect(JSON.parse(result as string)).toEqual([])
  })
})

describe('storeRetrievableTool', () => {
  it('has name `store_retrievable`', () => {
    expect(storeRetrievableTool.name).toBe('store_retrievable')
  })

  it('persists a new retrievable and auto-generates id + timestamps when omitted', async () => {
    const { ctx, state } = makeCtxStub()
    const before = DateTime.now()
    const result = await storeRetrievableTool.executor(ctx)({
      content: 'doc body',
      trustTier: 'first-party',
      source: 'kb://x',
      kind: 'reference',
      score: 0.42,
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.retrievable.id).toBeTruthy()
    expect(parsed.retrievable.trustTier).toBe('first-party')
    expect(parsed.retrievable.content).toBe('doc body')
    expect(parsed.retrievable.score).toBe(0.42)
    expect(state.stored).toHaveLength(1)
    const after = DateTime.now()
    const createdAt = DateTime.fromISO(parsed.retrievable.createdAt)
    expect(createdAt >= before && createdAt <= after).toBe(true)
  })

  it('auto-generates an id when an empty string is supplied instead of omitted', async () => {
    const { ctx, state } = makeCtxStub()
    const result = await storeRetrievableTool.executor(ctx)({
      id: '',
      content: 'doc body',
      trustTier: 'first-party',
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.retrievable.id).not.toBe('')
    expect(parsed.retrievable.id).toBeTruthy()
    expect(state.stored[0].id).toBe(parsed.retrievable.id)
  })

  it("stores source/kind as undefined, not literal empty strings, when supplied as ''", async () => {
    const { ctx, state } = makeCtxStub()
    const result = await storeRetrievableTool.executor(ctx)({
      content: 'doc body',
      trustTier: 'first-party',
      source: '',
      kind: '',
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.retrievable.source).toBeUndefined()
    expect(parsed.retrievable.kind).toBeUndefined()
    expect(state.stored[0].source).toBeUndefined()
    expect(state.stored[0].kind).toBeUndefined()
  })

  it('accepts each of the three trust tiers', async () => {
    for (const tier of ['first-party', 'third-party-public', 'third-party-private'] as const) {
      const { ctx } = makeCtxStub()
      const result = await storeRetrievableTool.executor(ctx)({
        content: 'x',
        trustTier: tier,
      })
      expect(JSON.parse(result as string).retrievable.trustTier).toBe(tier)
    }
  })

  it('rejects an unknown trust tier', async () => {
    const { ctx } = makeCtxStub()
    await expect(
      storeRetrievableTool.executor(ctx)({ content: 'x', trustTier: 'user-supplied' })
    ).rejects.toThrow()
  })

  it('returns an error string when storeRetrievable rejects', async () => {
    const ctx = {
      id: 'turn-1',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
      storeRetrievable: async () => {
        throw new Error('persistence error')
      },
    } as unknown as DispatchContext
    const result = await storeRetrievableTool.executor(ctx)({
      content: 'x',
      trustTier: 'first-party',
    })
    expect(result).toMatch(/^Error: /)
  })
})

describe('updateRetrievableTool', () => {
  it('has name `update_retrievable`', () => {
    expect(updateRetrievableTool.name).toBe('update_retrievable')
  })

  it('mutates an existing retrievable and bumps updatedAt', async () => {
    const initial = sampleRetrievable()
    const { ctx, state } = makeCtxStub([initial])
    const result = await updateRetrievableTool.executor(ctx)({
      id: 'ret-1',
      content: 'new body',
      score: 0.1,
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.retrievable.content).toBe('new body')
    expect(parsed.retrievable.score).toBe(0.1)
    expect(parsed.retrievable.trustTier).toBe('first-party')
    expect(parsed.retrievable.createdAt).toBe('2024-01-01T00:00:00.000Z')
    expect(parsed.retrievable.updatedAt).not.toBe('2024-01-01T00:00:00.000Z')
    expect(state.mutated).toHaveLength(1)
  })

  it('allows promoting a retrievable across trust tiers when the model requests it', async () => {
    const initial = sampleRetrievable({ trustTier: 'third-party-public' })
    const { ctx } = makeCtxStub([initial])
    const result = await updateRetrievableTool.executor(ctx)({
      id: 'ret-1',
      trustTier: 'first-party',
    })
    expect(JSON.parse(result as string).retrievable.trustTier).toBe('first-party')
  })

  it('returns an error string when the id is not found', async () => {
    const { ctx, state } = makeCtxStub([sampleRetrievable()])
    const result = await updateRetrievableTool.executor(ctx)({
      id: 'unknown',
      content: 'x',
    })
    expect(result).toMatch(/^Error: /)
    expect(result).toContain('unknown')
    expect(state.mutated).toHaveLength(0)
  })

  it('treats empty-string content/source/kind as "no change" and keeps existing values', async () => {
    const initial = sampleRetrievable({
      content: 'original body',
      source: 'kb://original',
      kind: 'policy',
    })
    const { ctx, state } = makeCtxStub([initial])
    const result = await updateRetrievableTool.executor(ctx)({
      id: 'ret-1',
      content: '',
      source: '',
      kind: '',
      score: 0.3,
    })
    const parsed = JSON.parse(result as string)
    expect(parsed.ok).toBe(true)
    expect(parsed.retrievable.content).toBe('original body')
    expect(parsed.retrievable.source).toBe('kb://original')
    expect(parsed.retrievable.kind).toBe('policy')
    expect(parsed.retrievable.score).toBe(0.3)
    expect(state.mutated).toHaveLength(1)
  })
})

describe('deleteRetrievableTool', () => {
  it('has name `delete_retrievable`', () => {
    expect(deleteRetrievableTool.name).toBe('delete_retrievable')
  })

  it('delegates to ctx.deleteRetrievable and reports the id', async () => {
    const { ctx, state } = makeCtxStub([sampleRetrievable()])
    const result = await deleteRetrievableTool.executor(ctx)({ id: 'ret-1' })
    expect(JSON.parse(result as string)).toEqual({ ok: true, id: 'ret-1' })
    expect(state.deleted).toEqual(['ret-1'])
  })

  it('is idempotent when the id is unknown', async () => {
    const { ctx, state } = makeCtxStub()
    const result = await deleteRetrievableTool.executor(ctx)({ id: 'nope' })
    expect(JSON.parse(result as string).ok).toBe(true)
    expect(state.deleted).toEqual(['nope'])
  })
})

describe('retrievableTools tuple', () => {
  it('contains every CRUD tool in declaration order', () => {
    expect(retrievableTools).toEqual([
      listRetrievablesTool,
      storeRetrievableTool,
      updateRetrievableTool,
      deleteRetrievableTool,
    ])
  })
})
