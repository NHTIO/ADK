import { DateTime } from 'luxon'
import { Message } from '@nhtio/adk/common'
import { describe, expect, it, vi } from 'vitest'
import { strictAlternation } from '../../../../../src/batteries/validation/profiles/strict_alternation'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY,
  ORDERING_GUARD_RESULT_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'

const message = (id: string, role: 'user' | 'assistant', second: number): Message => {
  const date = DateTime.fromMillis(second * 1000)
  return new Message({
    id,
    role,
    content: id,
    createdAt: date,
    updatedAt: date,
  })
}
const timeline = (messages: Message[]) => buildOrderingTimeline(messages, [], [])
const context = (messages: Message[]) => {
  const values = new Map<string, unknown>()
  const ctx = {
    turnMessages: new Set(messages),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    stash: {
      get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
      set: (key: string, value: unknown) => values.set(key, value),
    },
    storeMessage: async (value: Message) => {
      ctx.turnMessages.add(value)
    },
    nack: vi.fn(),
    abort: vi.fn(),
  }
  return ctx
}

describe('strict alternation profile', () => {
  describe('happy path', () => {
    it('accepts alternating user and assistant turns', () => {
      const result = evaluateOrderingProfile(
        timeline([
          message('u1', 'user', 1),
          message('a1', 'assistant', 2),
          message('u2', 'user', 3),
        ]),
        strictAlternation
      )
      expect(result.blocking).toHaveLength(0)
      expect(result.advisories).toHaveLength(0)
    })
  })
  describe('sabotage', () => {
    it('reports one same-role alternation violation', () => {
      const entries = timeline([message('u1', 'user', 1), message('u2', 'user', 2)])
      const result = evaluateOrderingProfile(entries, strictAlternation)
      expect(result.blocking).toHaveLength(1)
      expect(result.blocking[0]).toEqual(
        expect.objectContaining({
          ruleId: 'strict-user-assistant-alternation',
          ruleType: 'alternation',
        })
      )
    })
  })
  describe('mutation', () => {
    it('repairs the violation and clears it through dispatch middleware', async () => {
      const entries = timeline([message('u1', 'user', 1), message('u2', 'user', 2)])
      const repair = repairViolations(
        entries,
        evaluateOrderingProfile(entries, strictAlternation).blocking
      )
      expect(repair.repaired).toEqual([
        expect.objectContaining({ strategy: 'insert-alternation-filler' }),
      ])
      const ctx = context([message('u1', 'user', 1), message('u2', 'user', 2)])
      const next = vi.fn(async () => undefined)
      await orderingGuardDispatchMiddleware({
        profiles: [strictAlternation],
        action: 'mutate',
        onRepair: 'silent',
      })(ctx as never, next)
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      expect(
        ctx.stash.get<{ repaired: unknown[]; unrepaired: unknown[] }>(
          ORDERING_GUARD_RESULT_STASH_KEY
        )
      ).toEqual(
        expect.objectContaining({
          repaired: [expect.objectContaining({ strategy: 'insert-alternation-filler' })],
          unrepaired: [],
        })
      )
      expect(
        ctx.stash
          .get<{ role: string }[]>(ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY)
          .map((entry) => entry.role)
      ).toEqual(['user', 'assistant', 'user'])
    })
  })
})
