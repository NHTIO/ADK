import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought } from '@nhtio/adk/common'
import { reasoningPrunedAfterLatestTurn } from '../../../../../src/batteries/validation/profiles/reasoning_pruned_after_latest_turn'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_RESULT_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'
import type { OrderingGuardResult } from '../../../../../src/batteries/validation/types'

const at = (n: number) => DateTime.fromMillis(n * 1000)
const message = (id: string, n: number) =>
  new Message({ id, role: 'user', content: id, createdAt: at(n), updatedAt: at(n) })
const thought = (id: string, n: number) =>
  new Thought({ id, content: id, createdAt: at(n), updatedAt: at(n) })
const context = (stash: Map<string, unknown>, messages: Message[], thoughts: Thought[]) => ({
  turnMessages: new Set(messages),
  turnThoughts: new Set(thoughts),
  turnToolCalls: new Set(),
  stash: {
    get: <T>(key: string, fallback?: T) => (stash.has(key) ? stash.get(key) : fallback) as T,
    set: (key: string, value: unknown) => stash.set(key, value),
  },
  storeMessage: vi.fn(async () => undefined),
  mutateThought: vi.fn(async () => undefined),
  mutateToolCall: vi.fn(async () => undefined),
  nack: vi.fn(),
  abort: vi.fn(),
})
const options = (action?: 'mutate' | 'enforce') => ({
  action,
  profiles: [reasoningPrunedAfterLatestTurn],
})

describe('reasoning pruning preservation profile', () => {
  it('accepts a baseline and retained recent reasoning', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(stash, [message('old', 1), message('latest', 3)], [thought('recent', 4)])
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware(options())
    await middleware(ctx as never, next)
    await middleware(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('allows reasoning older than the latest user turn to be pruned', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(
      stash,
      [message('old', 1), message('latest', 3)],
      [thought('old-thought', 2), thought('recent', 4)]
    )
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware(options())
    await middleware(ctx as never, next)
    ctx.turnThoughts.clear()
    ctx.turnThoughts.add(thought('recent', 4))
    await middleware(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('rejects dropped recent reasoning', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(stash, [message('old', 1), message('latest', 3)], [thought('recent', 4)])
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware(options())
    await middleware(ctx as never, next)
    ctx.turnThoughts.clear()
    await middleware(ctx as never, next)
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect((ctx.nack.mock.calls[0][0] as { violations: { ruleId: string }[] }).violations).toEqual([
      expect.objectContaining({ ruleId: 'reasoning-pruned-after-latest-turn' }),
    ])
  })

  it('does not repair dropped recent reasoning in mutate mode', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(stash, [message('latest', 3)], [thought('recent', 4)])
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware(options('mutate'))
    await middleware(ctx as never, next)
    ctx.turnThoughts.clear()
    await middleware(ctx as never, next)
    const result = stash.get(ORDERING_GUARD_RESULT_STASH_KEY) as OrderingGuardResult
    expect(result.repaired).toHaveLength(0)
    expect(result.unrepaired).toEqual([
      expect.objectContaining({ ruleId: 'reasoning-pruned-after-latest-turn' }),
    ])
    expect(ctx.nack).toHaveBeenCalledOnce()
  })
})
