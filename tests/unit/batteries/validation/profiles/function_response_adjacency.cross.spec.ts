import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import { functionResponseAdjacency } from '../../../../../src/batteries/validation/profiles/function_response_adjacency'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'

const at = (n: number) => DateTime.fromMillis(n * 1000)
const message = new Message({
  id: 'message',
  role: 'assistant',
  content: 'response',
  createdAt: at(2),
  updatedAt: at(2),
})
const call = new ToolCall({
  id: 'call',
  tool: 'search',
  args: {},
  checksum: 'call',
  isComplete: true,
  isError: false,
  results: new Tokenizable('ok'),
  createdAt: at(1),
  updatedAt: at(1),
  completedAt: at(1),
})
const result = (messages: Message[], calls: ToolCall[]) =>
  evaluateOrderingProfile(buildOrderingTimeline(messages, [], calls), functionResponseAdjacency)

describe('function response adjacency profile', () => {
  it('accepts a tool call followed by a non-message successor', () => {
    expect(result([], [call]).blocking).toHaveLength(0)
  })

  it('rejects a message immediately after a tool call', () => {
    expect(result([message], [call]).blocking).toEqual([
      expect.objectContaining({ ruleId: 'message-not-immediately-after-function-call' }),
    ])
  })

  it('does not report a final tool call as an adjacency violation', () => {
    expect(result([], [call]).blocking).toHaveLength(0)
  })

  it('leaves adjacency violations unrepaired and blocks mutate dispatch', async () => {
    const timeline = buildOrderingTimeline([message], [], [call])
    const violations = evaluateOrderingProfile(timeline, functionResponseAdjacency).blocking
    const repaired = repairViolations(timeline, violations)
    expect(repaired.repaired).toHaveLength(0)
    expect(repaired.unrepaired).toEqual([
      expect.objectContaining({ ruleId: 'message-not-immediately-after-function-call' }),
    ])

    const stash = new Map<string, unknown>()
    const ctx = {
      turnMessages: new Set([message]),
      turnThoughts: new Set(),
      turnToolCalls: new Set([call]),
      stash: {
        get: <T>(key: string, fallback?: T) => (stash.has(key) ? stash.get(key) : fallback) as T,
        set: (key: string, value: unknown) => stash.set(key, value),
      },
      storeMessage: vi.fn(async () => undefined),
      mutateThought: vi.fn(async () => undefined),
      mutateToolCall: vi.fn(async () => undefined),
      nack: vi.fn(),
      abort: vi.fn(),
    }
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      action: 'mutate',
      profiles: [functionResponseAdjacency],
    })(ctx as never, next)
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
    expect((ctx.nack.mock.calls[0][0] as { violations: { ruleId: string }[] }).violations).toEqual([
      expect.objectContaining({ ruleId: 'message-not-immediately-after-function-call' }),
    ])
  })
})
