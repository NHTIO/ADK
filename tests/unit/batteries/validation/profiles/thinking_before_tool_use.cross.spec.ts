import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { thinkingBeforeToolUse } from '../../../../../src/batteries/validation/profiles/thinking_before_tool_use'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'
import type { OrderingTimelineEntry } from '../../../../../src/batteries/validation/types'

const time = (seconds: number): DateTime => DateTime.fromMillis(seconds * 1000)
const thought = (id: string, at: number): Thought =>
  new Thought({ id, content: id, createdAt: time(at), updatedAt: time(at) })
const toolCall = (id: string, at: number): ToolCall =>
  new ToolCall({
    id,
    tool: 'sample',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('result'),
    createdAt: time(at),
    updatedAt: time(at),
    completedAt: time(at),
  })
const entry = (kind: OrderingTimelineEntry['kind'], id: string, at: number, seq: number) =>
  ({
    kind,
    id,
    at,
    seq,
    value: { id } as OrderingTimelineEntry['value'],
  }) as OrderingTimelineEntry
const context = (thoughts: Thought[], toolCalls: ToolCall[]) => {
  const values = new Map<string, unknown>()
  const ctx = {
    turnMessages: new Set<Message>(),
    turnThoughts: new Set(thoughts),
    turnToolCalls: new Set(toolCalls),
    stash: {
      get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) : fallback) as T,
      set: (key: string, value: unknown) => values.set(key, value),
    },
    storeMessage: vi.fn(async () => undefined),
    mutateMessage: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async (value: ToolCall) => {
      for (const tc of ctx.turnToolCalls) if (tc.id === value.id) ctx.turnToolCalls.delete(tc)
      ctx.turnToolCalls.add(value)
    }),
    mutateThought: vi.fn(async (value: Thought) => {
      for (const t of ctx.turnThoughts) if (t.id === value.id) ctx.turnThoughts.delete(t)
      ctx.turnThoughts.add(value)
    }),
    nack: vi.fn(),
    abort: vi.fn(),
  }
  return ctx
}

const sabotage = [entry('toolCall', 'call', 1, 1), entry('thought', 'thought', 2, 0)]

/**
 * Shipped ADVISORY by default (OrderRule.severity — a live audit found these rules block turn
 * state their vendors accept). Only a BLOCKING finding reaches `repairViolations`, so the mutation
 * test drives this variant; the advisory tests use the shipped profile unchanged.
 */
const thinkingBeforeToolUseBlocking = {
  ...thinkingBeforeToolUse,
  rules: thinkingBeforeToolUse.rules.map((r) => ({ ...r, severity: 'blocking' as const })),
}

describe('thinking-before-tool-use profile', () => {
  it('happy path has thought before ToolCall in the latest assistant group', () => {
    const result = evaluateOrderingProfile(
      [entry('thought', 'thought', 1, 0), entry('toolCall', 'call', 2, 1)],
      thinkingBeforeToolUse
    )
    expect(result.blocking).toHaveLength(0)
  })

  it('sabotage catches a ToolCall timestamped before its Thought', () => {
    const result = evaluateOrderingProfile(sabotage, thinkingBeforeToolUse)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].ruleId).toBe('thinking-before-tool-use')
  })

  it('mutation reorders the pair and clears the violation end-to-end', async () => {
    const timeline = sabotage
    const violations = evaluateOrderingProfile(timeline, thinkingBeforeToolUseBlocking).blocking
    const repaired = repairViolations(timeline, violations)
    expect(repaired.repaired[0].strategy).toBe('reorder')
    expect(
      evaluateOrderingProfile(repaired.timeline, thinkingBeforeToolUseBlocking).blocking
    ).toHaveLength(0)

    const ctx = context([thought('thought', 2)], [toolCall('call', 1)])
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [thinkingBeforeToolUseBlocking],
      action: 'mutate',
    })(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    const effective = ctx.stash.get<OrderingTimelineEntry[]>(
      ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY
    )
    expect(evaluateOrderingProfile(effective, thinkingBeforeToolUseBlocking).blocking).toHaveLength(
      0
    )

    // The guard's own effectiveTimeline is not enough on its own — the repair must reach the
    // REAL turn state, since that is what an LLM adapter's own history assembly reads from.
    expect(ctx.mutateThought).toHaveBeenCalledOnce()
    const [liveThought] = [...ctx.turnThoughts]
    const [liveToolCall] = [...ctx.turnToolCalls]
    expect(liveThought.createdAt.toMillis()).toBeLessThan(liveToolCall.createdAt.toMillis())
    const rebuilt = buildOrderingTimeline(ctx.turnMessages, ctx.turnThoughts, ctx.turnToolCalls)
    expect(evaluateOrderingProfile(rebuilt, thinkingBeforeToolUseBlocking).blocking).toHaveLength(0)
  })
})
