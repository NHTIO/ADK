import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { fullHistoryPreservation } from '../../../../../src/batteries/validation/profiles/full_history_preservation'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_RESULT_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'
import type { OrderingGuardResult } from '../../../../../src/batteries/validation/types'

const at = (n: number) => DateTime.fromMillis(n * 1000)
const message = (id: string) =>
  new Message({ id, role: 'user', content: id, createdAt: at(0), updatedAt: at(0) })
const thought = (id: string, n: number) =>
  new Thought({ id, content: id, createdAt: at(n), updatedAt: at(n) })
const call = (id: string, n: number) =>
  new ToolCall({
    id,
    tool: 'search',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('ok'),
    createdAt: at(n),
    updatedAt: at(n),
    completedAt: at(n),
  })

const context = (stash: Map<string, unknown>, kind: 'toolCall' | 'thought', present: boolean) => ({
  turnMessages: new Set([message('user')]),
  turnThoughts: new Set(present && kind === 'thought' ? [thought('thinking', 1)] : []),
  turnToolCalls: new Set(present && kind === 'toolCall' ? [call('search-call', 1)] : []),
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

/**
 * Shipped ADVISORY by default (OrderRule.severity — a live audit found the catalog's rules block
 * turn state their vendors accept). Only a BLOCKING finding gates dispatch or reaches the repair
 * path, so tests asserting those drive this helper; the reporting tests use the shipped profile.
 */
const blocking = (profile: { rules: readonly unknown[] }) => ({
  ...profile,
  rules: (profile.rules as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    severity: 'blocking' as const,
  })),
})

describe('full history preservation profiles', () => {
  it.each(['toolCall', 'thought'] as const)(
    'accepts an established and retained %s history',
    async (kind) => {
      const stash = new Map<string, unknown>()
      const ctx = context(stash, kind, true)
      const next = vi.fn(async () => undefined)
      const middleware = orderingGuardDispatchMiddleware({
        profiles: [blocking(fullHistoryPreservation(kind)) as never],
      })
      await middleware(ctx as never, next)
      await middleware(ctx as never, next)
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['toolCall', 'thought'] as const)(
    'reports only iteration two when %s history disappears',
    async (kind) => {
      const stash = new Map<string, unknown>()
      const ctx = context(stash, kind, true)
      const next = vi.fn(async () => undefined)
      const middleware = orderingGuardDispatchMiddleware({
        profiles: [blocking(fullHistoryPreservation(kind)) as never],
      })
      await middleware(ctx as never, next)
      expect(ctx.nack).not.toHaveBeenCalled()
      const entries = kind === 'thought' ? ctx.turnThoughts : ctx.turnToolCalls
      entries.clear()
      await middleware(ctx as never, next)
      expect(ctx.nack).toHaveBeenCalledOnce()
      expect(
        (ctx.nack.mock.calls[0][0] as { violations: { ruleId: string }[] }).violations
      ).toEqual([expect.objectContaining({ ruleId: `full-history-preservation-${kind}` })])
    }
  )

  it.each(['toolCall', 'thought'] as const)(
    'does not repair lost %s history in mutate mode',
    async (kind) => {
      const stash = new Map<string, unknown>()
      const ctx = context(stash, kind, true)
      const next = vi.fn(async () => undefined)
      const middleware = orderingGuardDispatchMiddleware({
        action: 'mutate',
        profiles: [blocking(fullHistoryPreservation(kind)) as never],
      })
      await middleware(ctx as never, next)
      const entries = kind === 'thought' ? ctx.turnThoughts : ctx.turnToolCalls
      entries.clear()
      await middleware(ctx as never, next)
      const result = stash.get(ORDERING_GUARD_RESULT_STASH_KEY) as OrderingGuardResult
      expect(result.repaired).toHaveLength(0)
      expect(result.unrepaired).toEqual([
        expect.objectContaining({ ruleId: `full-history-preservation-${kind}` }),
      ])
      expect(ctx.nack).toHaveBeenCalledOnce()
      expect(next).toHaveBeenCalledOnce()
    }
  )
})
