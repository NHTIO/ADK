import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { openaiShapeBaseline } from '../../../../../src/batteries/validation/profiles/openai_shape_baseline'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'

const at = (second: number): DateTime => DateTime.fromMillis(second * 1000)
const message = (id: string, role: 'user' | 'assistant', second: number): Message =>
  new Message({
    id,
    role,
    content: id,
    createdAt: at(second),
    updatedAt: at(second),
  })
const thought = (id: string, second: number): Thought =>
  new Thought({
    id,
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
const timeline = (messages: Message[], thoughts: Thought[], calls: ToolCall[]) =>
  buildOrderingTimeline(messages, thoughts, calls)

describe('openai shape baseline profile', () => {
  describe('happy path', () => {
    it('allows a tool call followed by thought content', () => {
      const result = evaluateOrderingProfile(
        timeline([message('u1', 'user', 1)], [thought('t1', 3)], [call('c1', 2)]),
        openaiShapeBaseline
      )
      expect(result.blocking).toHaveLength(0)
      expect(result.advisories).toHaveLength(0)
    })
  })
  describe('sabotage', () => {
    it('reports exactly the stray message immediately after a tool call', () => {
      const result = evaluateOrderingProfile(
        timeline([message('m1', 'assistant', 2)], [], [call('c1', 1)]),
        openaiShapeBaseline
      )
      expect(result.advisories).toHaveLength(1)
      expect(result.advisories[0]).toEqual(
        expect.objectContaining({
          ruleId: 'message-not-immediately-after-tool-call',
          ruleType: 'adjacency',
        })
      )
    })
  })
  describe('mutation', () => {
    it('leaves the adjacency violation unrepaired and blocks dispatch', async () => {
      const entries = timeline([message('m1', 'assistant', 2)], [], [call('c1', 1)])
      const result = repairViolations(
        entries,
        evaluateOrderingProfile(entries, openaiShapeBaseline).blocking
      )
      expect(result.repaired).toHaveLength(0)
      // An advisory never reaches the repair path, so there is nothing to leave unrepaired.
      expect(result.unrepaired).toHaveLength(0)

      const values = new Map<string, unknown>()
      const ctx = {
        turnMessages: new Set([message('m1', 'assistant', 2)]),
        turnThoughts: new Set<Thought>(),
        turnToolCalls: new Set([call('c1', 1)]),
        stash: {
          get: <T>(key: string, fallback?: T): T =>
            (values.has(key) ? values.get(key) : fallback) as T,
          set: (key: string, value: unknown): void => {
            values.set(key, value)
          },
        },
        storeMessage: async (): Promise<void> => undefined,
        nack: vi.fn(),
        abort: vi.fn(),
      }
      const next = vi.fn(async () => undefined)
      await orderingGuardDispatchMiddleware({
        profiles: [openaiShapeBaseline],
        action: 'mutate',
      })(ctx as never, next)

      // Advisory by default: the finding is REPORTED, dispatch PROCEEDS. Before the severity
      // default flipped this nacked — and a live audit showed the vendor accepts this shape, so
      // the nack was rejecting a dispatch the model would have served.
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      expect(values.has(ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY)).toBe(true)
    })
  })
})
