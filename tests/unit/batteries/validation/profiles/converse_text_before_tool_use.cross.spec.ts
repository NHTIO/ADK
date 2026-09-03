import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { converseTextBeforeToolUse } from '../../../../../src/batteries/validation/profiles/converse_text_before_tool_use'
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
const message = (id: string, role: 'user' | 'assistant', at: number): Message =>
  new Message({
    id,
    role,
    content: id,
    createdAt: time(at),
    updatedAt: time(at),
  })
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
const context = (messages: Message[], toolCalls: ToolCall[]) => {
  const values = new Map<string, unknown>()
  const ctx = {
    turnMessages: new Set(messages),
    turnThoughts: new Set<Thought>(),
    turnToolCalls: new Set(toolCalls),
    stash: {
      get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) : fallback) as T,
      set: (key: string, value: unknown) => values.set(key, value),
    },
    storeMessage: vi.fn(async () => undefined),
    mutateMessage: vi.fn(async (value: Message) => {
      for (const m of ctx.turnMessages) if (m.id === value.id) ctx.turnMessages.delete(m)
      ctx.turnMessages.add(value)
    }),
    mutateToolCall: vi.fn(async (value: ToolCall) => {
      for (const tc of ctx.turnToolCalls) if (tc.id === value.id) ctx.turnToolCalls.delete(tc)
      ctx.turnToolCalls.add(value)
    }),
    mutateThought: vi.fn(async () => undefined),
    nack: vi.fn(),
    abort: vi.fn(),
  }
  return ctx
}
const entry = (
  kind: OrderingTimelineEntry['kind'],
  id: string,
  at: number,
  seq: number,
  role?: 'user' | 'assistant'
) =>
  ({
    kind,
    at,
    seq,
    role,
    value: { id } as OrderingTimelineEntry['value'],
  }) as OrderingTimelineEntry

/**
 * The shipped profile is ADVISORY by default (OrderRule.severity — a live audit found these rules
 * block turn state their vendors accept). Only a BLOCKING finding reaches `repairViolations`, so
 * the mutation tests drive this explicitly-blocking variant of the same rule; the advisory tests
 * use the shipped profile unchanged.
 */
const converseTextBeforeToolUseBlocking = {
  ...converseTextBeforeToolUse,
  rules: converseTextBeforeToolUse.rules.map((r) => ({ ...r, severity: 'blocking' as const })),
}

describe('converse-text-before-tool-use profile', () => {
  it('happy path places assistant text before tool use', () => {
    expect(
      evaluateOrderingProfile(
        [entry('message', 'text', 1, 0, 'assistant'), entry('toolCall', 'call', 2, 1)],
        converseTextBeforeToolUse
      ).blocking
    ).toHaveLength(0)
  })

  it('sabotage catches a ToolCall preceding a message across role-group boundaries', () => {
    const timeline = [
      entry('message', 'm-user0', 0, 0, 'user'),
      entry('message', 'm-assistant0', 1, 1, 'assistant'),
      entry('toolCall', 'tc-old', 2, 2),
      entry('message', 'm-user1', 3, 3, 'user'),
      entry('message', 'm-assistant1', 4, 4, 'assistant'),
      entry('toolCall', 'tc-latest', 5, 5),
    ]
    // Per-group evaluation would find zero violations; this isolates that entire-turn scope catches the earlier cross-group ordering failure.
    const adjacentProfile = {
      ...converseTextBeforeToolUse,
      rules: converseTextBeforeToolUse.rules.map((rule) =>
        rule.type === 'order' ? { ...rule, scope: 'adjacent-same-role-group' as const } : rule
      ),
    }
    expect(evaluateOrderingProfile(timeline, adjacentProfile).blocking).toHaveLength(0)
    const result = evaluateOrderingProfile(timeline, converseTextBeforeToolUse)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].ruleId).toBe('converse-text-before-tool-use')
  })

  it('mutation reorders the message and ToolCall and clears the violation end-to-end', async () => {
    const timeline = [entry('toolCall', 'call', 1, 1), entry('message', 'text', 2, 0, 'assistant')]
    const violations = evaluateOrderingProfile(timeline, converseTextBeforeToolUseBlocking).blocking
    const repaired = repairViolations(timeline, violations)
    expect(repaired.repaired[0].strategy).toBe('reorder')
    expect(
      evaluateOrderingProfile(repaired.timeline, converseTextBeforeToolUseBlocking).blocking
    ).toHaveLength(0)
    const ctx = context([message('text', 'assistant', 2)], [toolCall('call', 1)])
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [converseTextBeforeToolUseBlocking],
      action: 'mutate',
    })(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    const effective = ctx.stash.get<OrderingTimelineEntry[]>(
      ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY
    )
    expect(
      evaluateOrderingProfile(effective, converseTextBeforeToolUseBlocking).blocking
    ).toHaveLength(0)

    // The guard's own effectiveTimeline is not enough on its own — the repair must reach the
    // REAL turn state, since that is what an LLM adapter's own history assembly reads from.
    expect(ctx.mutateMessage).toHaveBeenCalledOnce()
    const [liveToolCall] = [...ctx.turnToolCalls]
    const [liveMessage] = [...ctx.turnMessages]
    expect(liveMessage.createdAt.toMillis()).toBeLessThan(liveToolCall.createdAt.toMillis())
    const rebuilt = buildOrderingTimeline(ctx.turnMessages, ctx.turnThoughts, ctx.turnToolCalls)
    expect(
      evaluateOrderingProfile(rebuilt, converseTextBeforeToolUseBlocking).blocking
    ).toHaveLength(0)
  })
})
