import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { singleToolCallPerTurn } from '../../../../../src/batteries/validation/profiles/single_tool_call_per_turn'
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
import type { OrderingStashedTimelineEntry } from '../../../../../src/batteries/validation/types'

const at = (second: number): DateTime => DateTime.fromMillis(second * 1000)
const message = (id: string, role: 'user' | 'assistant', second: number): Message =>
  new Message({
    id,
    role,
    content: id,
    createdAt: at(second),
    updatedAt: at(second),
  })
const call = (id: string, second: number): ToolCall =>
  new ToolCall({
    id,
    tool: 'sample',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('result'),
    createdAt: at(second),
    updatedAt: at(second),
    completedAt: at(second),
  })
const timeline = (messages: Message[], calls: ToolCall[]) =>
  buildOrderingTimeline(messages, [], calls)

/**
 * The shipped profile is ADVISORY by default (OrderRule.severity — a live audit found these rules
 * block turn state their vendors accept). Only a BLOCKING finding reaches `repairViolations`, so
 * the mutation tests drive this explicitly-blocking variant of the same rule; the advisory tests
 * use the shipped profile unchanged.
 */
const singleToolCallPerTurnBlocking = {
  ...singleToolCallPerTurn,
  rules: singleToolCallPerTurn.rules.map((r) => ({ ...r, severity: 'blocking' as const })),
}

describe('single tool call per turn profile', () => {
  describe('happy path', () => {
    it('accepts one tool call in an assistant group', () => {
      const result = evaluateOrderingProfile(
        timeline([message('u1', 'user', 1), message('a1', 'assistant', 4)], [call('c1', 2)]),
        singleToolCallPerTurn
      )
      expect(result.blocking).toHaveLength(0)
      expect(result.advisories).toHaveLength(0)
    })
  })
  describe('sabotage', () => {
    it('reports the maxPerGroup cardinality violation for two calls', () => {
      const entries = timeline(
        [message('u1', 'user', 1), message('a1', 'assistant', 5)],
        [call('c1', 2), call('c2', 3)]
      )
      const result = evaluateOrderingProfile(entries, singleToolCallPerTurn)
      expect(result.advisories).toHaveLength(1)
      expect(result.advisories[0]).toEqual(
        expect.objectContaining({
          ruleId: 'single-tool-call-per-turn',
          ruleType: 'alternation',
        })
      )
    })
  })
  describe('mutation', () => {
    it('records the filler strategy but leaves the maxPerGroup violation present', async () => {
      const entries = timeline(
        [message('u1', 'user', 1), message('a1', 'assistant', 5)],
        [call('c1', 2), call('c2', 3)]
      )
      const result = repairViolations(
        entries,
        evaluateOrderingProfile(entries, singleToolCallPerTurnBlocking).blocking
      )
      expect(result.repaired).toEqual([
        expect.objectContaining({ strategy: 'insert-alternation-filler' }),
      ])
      expect(result.unrepaired).toHaveLength(0)

      const values = new Map<string, unknown>()
      const ctx = {
        turnMessages: new Set([message('u1', 'user', 1), message('a1', 'assistant', 5)]),
        turnThoughts: new Set(),
        turnToolCalls: new Set([call('c1', 2), call('c2', 3)]),
        stash: {
          get: <T>(key: string, fallback?: T): T =>
            (values.has(key) ? values.get(key) : fallback) as T,
          set: (key: string, value: unknown): void => {
            values.set(key, value)
          },
        },
        storeMessage: async (value: Message): Promise<void> => {
          ctx.turnMessages.add(value)
        },
        nack: vi.fn(),
        abort: vi.fn(),
      }
      const next = vi.fn(async () => undefined)
      await orderingGuardDispatchMiddleware({
        profiles: [singleToolCallPerTurnBlocking],
        action: 'mutate',
        onRepair: 'silent',
      })(ctx as never, next)

      const effective = values.get(
        ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY
      ) as OrderingStashedTimelineEntry[]
      const postRepair = evaluateOrderingProfile(
        effective as unknown as ReturnType<typeof buildOrderingTimeline>,
        singleToolCallPerTurnBlocking
      )
      expect(values.get(ORDERING_GUARD_RESULT_STASH_KEY)).toEqual(
        expect.objectContaining({
          repaired: [expect.objectContaining({ strategy: 'insert-alternation-filler' })],
        })
      )
      expect(postRepair.blocking).toEqual([
        expect.objectContaining({
          ruleId: 'single-tool-call-per-turn',
          ruleType: 'alternation',
        }),
      ])
      // Driven with the BLOCKING variant: the alternation filler repairs the role sequence but
      // cannot reduce the tool-call COUNT, so the maxPerGroup finding survives the repair and
      // gates the dispatch. That asymmetry is what this test pins. The SHIPPED profile is
      // advisory and would proceed here — see OrderRule.severity.
      expect(ctx.nack).toHaveBeenCalledOnce()
      expect(next).not.toHaveBeenCalled()
    })
  })
})
