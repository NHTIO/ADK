import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import {
  ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY,
  ORDERING_GUARD_RESULT_STASH_KEY,
  orderingGuardDispatchMiddleware,
  orderingGuardTurnMiddleware,
} from '../../../../src/batteries/validation/middleware'
import type {
  OrderingGuardOptions,
  OrderingRepair,
} from '../../../../src/batteries/validation/types'

const at = (n: number) => DateTime.fromMillis(n * 1000)

const toolCall = (id: string, n: number): ToolCall =>
  new ToolCall({
    id,
    tool: 'sample',
    args: { n },
    checksum: `checksum-${n}`,
    isComplete: true,
    isError: false,
    results: new Tokenizable('ok'),
    createdAt: at(n),
    updatedAt: at(n),
    completedAt: at(n),
  })

type Result = {
  repaired: OrderingRepair[]
  unrepaired: { ruleId: string; primitiveIds: string[] }[]
  repairFailures: { ruleId: string; primitiveIds: string[]; deletedIds: string[] }[]
}

const options = (
  renameStrategy?: (previousId: string, memberIndex: number) => string
): OrderingGuardOptions => ({
  action: 'mutate',
  onRepair: 'silent',
  profiles: [
    {
      name: 'ids',
      description: 'identifier repair test',
      rules: [
        {
          type: 'identifierUniqueness',
          id: 'unique-tool-call-ids',
          kind: 'toolCall',
          severity: 'blocking',
          surface: 'dispatch',
          renameStrategy,
        },
      ],
    },
  ],
})

/** A persistence-shaped context: deletion is deliberately DELETE WHERE id = ?, not Set.delete. */
const persistenceContext = (
  calls: ToolCall[],
  config: { failStore?: () => boolean; failAfterDeletes?: boolean } = {}
) => {
  const rows = calls.map((call) => ({ id: call.id, call }))
  const stash = new Map<string, unknown>()
  const ctx = {
    turnMessages: new Set<never>(),
    turnThoughts: new Set<never>(),
    turnToolCalls: new Set<ToolCall>(calls),
    stash: {
      get: <T>(key: string, fallback?: T) => (stash.has(key) ? stash.get(key) : fallback) as T,
      set: (key: string, value: unknown) => stash.set(key, value),
    },
    storeMessage: vi.fn(async () => undefined),
    mutateMessage: vi.fn(async () => undefined),
    mutateThought: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
    deleteToolCall: vi.fn(async (id: string) => {
      // This is the persistence operation under test. It removes every matching database row.
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.id === id) rows.splice(i, 1)
      for (const call of [...ctx.turnToolCalls]) if (call.id === id) ctx.turnToolCalls.delete(call)
    }),
    storeToolCall: vi.fn(async (call: ToolCall) => {
      if (config.failStore?.()) throw new Error('database write failed')
      rows.push({ id: call.id, call })
      ctx.turnToolCalls.add(call)
    }),
    replaceToolCallGroup: vi.fn(
      async (ids: readonly string[], replacements: readonly ToolCall[]) => {
        // Model the context's persistence path: DELETE WHERE id = ? for every old member,
        // followed by inserts. No Set-only shortcut is allowed here.
        const deletedIds: string[] = []
        try {
          for (const id of ids) {
            await ctx.deleteToolCall(id)
            deletedIds.push(id)
          }
          for (const replacement of replacements) await ctx.storeToolCall(replacement)
        } catch (error) {
          if (config.failAfterDeletes) {
            ;(error as Error & { deletedIds?: string[] }).deletedIds = deletedIds
          }
          throw error
        }
        // The real DispatchContext updates its live turn set after persistence commits.
        for (const id of ids) {
          for (const call of [...ctx.turnToolCalls])
            if (call.id === id) ctx.turnToolCalls.delete(call)
        }
        for (const replacement of replacements) ctx.turnToolCalls.add(replacement)
      }
    ),
    nack: vi.fn(),
    abort: vi.fn(),
    rows,
  }
  return ctx
}

const resultOf = (ctx: ReturnType<typeof persistenceContext>): Result =>
  ctx.stash.get<Result>(ORDERING_GUARD_RESULT_STASH_KEY) as Result

const run = async (ctx: ReturnType<typeof persistenceContext>, opts = options()) => {
  await orderingGuardDispatchMiddleware(opts)(
    ctx as never,
    vi.fn(async () => undefined)
  )
  return resultOf(ctx)
}

describe('identifier uniqueness repair lifecycle', () => {
  it('is inert on the turn surface but active on the dispatch surface (D2)', async () => {
    const turn = persistenceContext([toolCall('same', 1), toolCall('same', 2)])
    const { nack: ignoredNack, ...turnContext } = turn
    void ignoredNack
    const turnNext = vi.fn(async () => undefined)
    await orderingGuardTurnMiddleware({ ...options(), action: 'enforce' })(
      turnContext as never,
      turnNext
    )
    expect(turn.abort).not.toHaveBeenCalled()
    expect(turnNext).toHaveBeenCalledOnce()

    const dispatch = persistenceContext([toolCall('same', 1), toolCall('same', 2)])
    await orderingGuardDispatchMiddleware({ ...options(), action: 'enforce' })(
      dispatch as never,
      vi.fn(async () => undefined)
    )
    expect(dispatch.nack).toHaveBeenCalledOnce()
  })

  it('renames every member of a collision group, including the first', async () => {
    const ctx = persistenceContext([toolCall('collision', 1), toolCall('collision', 2)])
    let n = 0
    const result = await run(
      ctx,
      options(() => `fresh-${n++}`)
    )
    const ids = [...ctx.turnToolCalls].map((call) => call.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids).not.toContain('collision')
    expect(result.repaired).toHaveLength(1)
    expect(result.unrepaired).toHaveLength(0)
  })

  it('reconciles each repaired member into its own effective-timeline slot by seq', async () => {
    let n = 0
    const ctx = persistenceContext([toolCall('call_0', 1), toolCall('call_0', 2)])
    const result = await run(
      ctx,
      options(() => `fresh-${n++}`)
    )
    expect(result.repaired).toHaveLength(1)
    expect(result.repairFailures).toHaveLength(0)

    const effective = ctx.stash.get<{ value: { id: string } }[]>(
      ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY
    )
    expect(effective.map((entry) => entry.value.id)).toEqual(['fresh-0', 'fresh-1'])
  })

  it('records a failed store as unrepaired and never as repaired', async () => {
    const ctx = persistenceContext([toolCall('collision', 1), toolCall('collision', 2)], {
      failStore: () => true,
    })
    const result = await run(ctx)
    expect(result.repaired).toHaveLength(0)
    expect(result.unrepaired).toEqual([expect.objectContaining({ ruleId: 'unique-tool-call-ids' })])
    expect(result.repairFailures).toEqual([
      expect.objectContaining({
        ruleId: 'unique-tool-call-ids',
        primitiveIds: ['collision', 'collision'],
        deletedIds: [],
      }),
    ])
    expect(ctx.nack).toHaveBeenCalledOnce()
  })

  it('reports partial deletion progress in the failure record and cause chain', async () => {
    const ctx = persistenceContext([toolCall('collision', 1), toolCall('collision', 2)], {
      failStore: () => true,
      failAfterDeletes: true,
    })
    const result = await run(ctx)
    expect(result.repaired).toHaveLength(0)
    expect(result.repairFailures).toEqual([
      expect.objectContaining({
        primitiveIds: ['collision', 'collision'],
        deletedIds: ['collision', 'collision'],
      }),
    ])
    const rejection = ctx.nack.mock.calls[0]?.[0] as Error & { cause?: Error }
    expect(rejection.name).toBe('E_ORDERING_VIOLATION')
    expect(rejection.cause?.name).toBe('E_ORDERING_REPAIR_FAILED')
    expect(rejection.cause?.cause).toEqual(
      expect.objectContaining({ message: 'database write failed' })
    )
    expect((rejection.cause as Error & { deletedIds?: string[] }).deletedIds).toEqual([
      'collision',
      'collision',
    ])
  })

  it('does not abandon a second collision group when the first group fails', async () => {
    let stores = 0
    const ctx = persistenceContext(
      [toolCall('first', 1), toolCall('first', 2), toolCall('second', 3), toolCall('second', 4)],
      { failStore: () => stores++ < 1 }
    )
    const result = await run(ctx)
    expect(result.repaired).toHaveLength(1)
    expect(result.repairFailures).toHaveLength(1)
    expect(result.unrepaired).toHaveLength(1)
    expect(result.unrepaired[0]?.primitiveIds).toEqual(['first', 'first'])
  })

  it('preserves both members through real DELETE WHERE id = ? persistence', async () => {
    const ctx = persistenceContext([toolCall('collision', 1), toolCall('collision', 2)])
    let n = 0
    const result = await run(
      ctx,
      options(() => `persisted-${n++}`)
    )
    expect(result.unrepaired).toHaveLength(0)
    expect(ctx.rows).toHaveLength(2)
    expect(new Set(ctx.rows.map((row) => row.id)).size).toBe(2)
    expect(ctx.rows.map((row) => row.id)).not.toContain('collision')
    expect(ctx.deleteToolCall).toHaveBeenCalledWith('collision')
  })

  it('repairs with a PURE rename strategy, which needs the member index to tell members apart', async () => {
    // The documented contract is "pure and total": same input, same output. Every member of a
    // collision group shares one id, so a strategy given only `previousId` returns the SAME
    // replacement for every member and the materialiser rejects its own repair. Pinning purity
    // here — the other specs close over a mutable counter, which is impure and would pass even if
    // `memberIndex` were never supplied.
    const ctx = persistenceContext([toolCall('collision', 1), toolCall('collision', 2)])
    const result = await run(
      ctx,
      options((previousId, memberIndex) => `${previousId}-${memberIndex}`)
    )
    expect(result.unrepaired).toHaveLength(0)
    expect(result.repairFailures).toHaveLength(0)
    expect(ctx.rows.map((row) => row.id).sort()).toEqual(['collision-0', 'collision-1'])
  })

  it('fails the repair when a strategy returns an id already held OUTSIDE the group', async () => {
    // Uniqueness within the group is not enough: handing back an unrelated call's id would
    // re-point that call's results, which is the corruption this rule exists to prevent.
    const ctx = persistenceContext([
      toolCall('collision', 1),
      toolCall('collision', 2),
      toolCall('bystander', 3),
    ])
    const result = await run(
      ctx,
      options((_previousId, memberIndex) => (memberIndex === 0 ? 'bystander' : 'fine'))
    )
    expect(result.unrepaired).toHaveLength(1)
    expect(result.repairFailures).toHaveLength(1)
    expect(ctx.rows.some((row) => row.id === 'bystander')).toBe(true)
  })
})
