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

/**
 * Shipped ADVISORY by default (OrderRule.severity — a live audit found these rules block turn
 * state their vendors accept). Only a BLOCKING finding reaches `repairViolations`, so the mutation
 * test drives this variant; the advisory tests use the shipped profile unchanged.
 */
const functionResponseAdjacencyBlocking = {
  ...functionResponseAdjacency,
  rules: functionResponseAdjacency.rules.map((r) => ({ ...r, severity: 'blocking' as const })),
}

describe('function response adjacency profile', () => {
  it('accepts a tool call followed by a non-message successor', () => {
    expect(result([], [call]).blocking).toHaveLength(0)
  })

  it('rejects a message immediately after a tool call', () => {
    // Advisory by default — the finding is reported, not gated.
    expect(result([message], [call]).blocking).toHaveLength(0)
    expect(result([message], [call]).advisories).toEqual([
      expect.objectContaining({ ruleId: 'message-not-immediately-after-function-call' }),
    ])
  })

  it('does not report a final tool call as an adjacency violation', () => {
    expect(result([], [call]).blocking).toHaveLength(0)
  })

  it('repairs an adjacency violation by reordering, and lets the dispatch proceed', async () => {
    const timeline = buildOrderingTimeline([message], [], [call])
    const violations = evaluateOrderingProfile(timeline, functionResponseAdjacencyBlocking).blocking
    const repaired = repairViolations(timeline, violations)
    // Driven with the BLOCKING variant, so the finding reaches the repair path. Issue #15 defect 1
    // was that adjacency had NO repair strategy there, making `mutate` identical to `enforce`; it
    // now reorders, so the violation is repaired rather than fatal.
    expect(repaired.unrepaired).toHaveLength(0)
    expect(repaired.repaired).toEqual([
      expect.objectContaining({ strategy: 'reorder-adjacent', targetId: message.id }),
    ])
    // The repair MOVES the successor rather than dropping it: every primitive survives.
    expect(repaired.timeline.map((entry) => entry.kind)).toEqual(['message', 'toolCall'])

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
      mutateMessage: vi.fn(async () => undefined),
      nack: vi.fn(),
      abort: vi.fn(),
    }
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      action: 'mutate',
      profiles: [functionResponseAdjacencyBlocking],
    })(ctx as never, next)
    // The repair is re-evaluated before the dispatch is allowed through, so `next` running is
    // evidence the reorder actually cleared the violation — not merely that it was reported.
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    // Reordering a Message is materialised as a createdAt nudge, since history assembly sorts by
    // timestamp — an in-memory splice alone would never reach the wire.
    expect(ctx.mutateMessage).toHaveBeenCalledOnce()
  })
})
