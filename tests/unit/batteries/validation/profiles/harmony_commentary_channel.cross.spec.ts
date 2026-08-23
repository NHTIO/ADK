import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { evaluateOrderingProfile } from '../../../../../src/batteries/validation/helpers'
import { harmonyCommentaryChannel } from '../../../../../src/batteries/validation/profiles/harmony_commentary_channel'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_RESULT_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'
import type { OrderingTimelineEntry } from '../../../../../src/batteries/validation/types'

const entry = (id: string, at: number, payload?: unknown): OrderingTimelineEntry => ({
  kind: 'toolCall',
  at,
  seq: at,
  value: { id, payload } as OrderingTimelineEntry['value'],
})
const context = (entries: OrderingTimelineEntry[]) => {
  const calls = entries.map((item) => ({
    id: String(item.value.id),
    payload: (item.value as { payload?: unknown }).payload,
    createdAt: DateTime.fromMillis(item.at + 1000),
  }))
  const stash = new Map<string, unknown>()
  return {
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(calls),
    stash: {
      get: <T>(key: string, fallback?: T) => (stash.has(key) ? stash.get(key) : fallback) as T,
      set: (key: string, value: unknown) => stash.set(key, value),
    },
    storeMessage: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
    mutateThought: vi.fn(async () => undefined),
    nack: vi.fn(),
    abort: vi.fn(),
  }
}

const withChannel = [entry('call', 0, { channel: 'commentary' })]
const missingSecond = [entry('first', 0, { channel: 'analysis' }), entry('second', 1, {})]

describe('harmony-commentary-channel profile', () => {
  it('accepts channel presence regardless of its value', () => {
    expect(evaluateOrderingProfile(withChannel, harmonyCommentaryChannel).blocking).toHaveLength(0)
    expect(
      evaluateOrderingProfile([entry('call', 0, { channel: 'analysis' })], harmonyCommentaryChannel)
        .blocking
    ).toHaveLength(0)
  })

  it('checks every ToolCall and reports only the second missing channel', () => {
    const result = evaluateOrderingProfile(missingSecond, harmonyCommentaryChannel)
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0].primitiveIds).toEqual(['second'])
    expect(result.blocking[0].ruleId).toBe('harmony-commentary-channel')
  })

  it('does not use fallback repair when this profile has no fallback value', async () => {
    const ctx = context([entry('call', 0, {})])
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [harmonyCommentaryChannel],
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(ctx as never, next)
    expect(ctx.mutateToolCall).not.toHaveBeenCalled()
    const guardResult = ctx.stash.get<{
      repaired: unknown[]
      unrepaired: { ruleId: string }[]
    }>(ORDERING_GUARD_RESULT_STASH_KEY)
    expect(guardResult.unrepaired).toEqual([
      expect.objectContaining({ ruleId: 'harmony-commentary-channel' }),
    ])
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })
})
