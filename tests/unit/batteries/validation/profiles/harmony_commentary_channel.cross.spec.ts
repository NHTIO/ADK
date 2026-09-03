import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { evaluateOrderingProfile } from '../../../../../src/batteries/validation/helpers'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import { harmonyCommentaryChannel } from '../../../../../src/batteries/validation/profiles/harmony_commentary_channel'
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
    // Advisory: the live audit measured gpt-oss ACCEPTING an untagged ToolCall, so the finding is
    // reported without gating. Identity and target are still exact.
    expect(result.blocking).toHaveLength(0)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].primitiveIds).toEqual(['second'])
    expect(result.advisories[0].ruleId).toBe('harmony-commentary-channel')
  })

  it('does not gate dispatch, because the rule is advisory', async () => {
    const ctx = context([entry('call', 0, {})])
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [harmonyCommentaryChannel],
      action: 'mutate',
    })(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('is now REPAIRABLE: the rule carries a fallback value', () => {
    // Defect #4 from issue #15: this rule declared no `fallbackPayloadValue`, so mutate-mode
    // repair skipped it at helpers.ts's `fallbackPayloadValue !== undefined` guard and every
    // gpt-oss tool dispatch landed in `unrepaired` — unrepairable by construction. It now carries
    // `'commentary'`, Harmony's own channel name for a function call.
    //
    // Asserted at the RULE level rather than by driving the middleware: `applyRepairs` needs real
    // `ToolCall` instances (it round-trips them through ENCODE_METHOD), and this spec's fixtures
    // are plain timeline entries. `metadata_fallback_repair.cross.spec.ts` covers the end-to-end
    // repair with real primitives.
    const rule = harmonyCommentaryChannel.rules[0] as {
      fallbackPayloadValue?: unknown
      requiredPayloadKey?: string
    }
    expect(rule.fallbackPayloadValue).toBe('commentary')
    expect(rule.requiredPayloadKey).toBe('channel')
  })
})
