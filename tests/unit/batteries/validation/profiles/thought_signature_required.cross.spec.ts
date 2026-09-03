import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
} from '../../../../../src/batteries/validation/helpers'
import { thoughtSignatureRequired } from '../../../../../src/batteries/validation/profiles/thought_signature_required'
import type { OrderingProfile } from '../../../../../src/batteries/validation/types'

const toolCall = (payload?: unknown): ToolCall => {
  const at = DateTime.fromMillis(1000)
  return new ToolCall({
    id: 'call',
    tool: 'sample',
    args: {},
    checksum: 'call',
    isComplete: true,
    isError: false,
    results: new Tokenizable('result'),
    payload,
    replayCompatibility: payload === undefined ? undefined : 'test-replay',
    createdAt: at,
    updatedAt: at,
    completedAt: at,
  })
}
const context = (tool: ToolCall) => {
  const values = new Map<string, unknown>()
  const ctx = {
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set([tool]),
    stash: {
      get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) : fallback) as T,
      set: (key: string, value: unknown) => values.set(key, value),
    },
    storeMessage: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
    mutateThought: vi.fn(async () => undefined),
    nack: vi.fn(),
    abort: vi.fn(),
  }
  return ctx
}

const missing = toolCall()

describe('thought-signature-required profile', () => {
  it('happy path accepts a ToolCall carrying thoughtSignature', () => {
    const timeline = buildOrderingTimeline([], [], [toolCall({ thoughtSignature: 'sig' })])
    expect(evaluateOrderingProfile(timeline, thoughtSignatureRequired).blocking).toHaveLength(0)
  })

  it('sabotage treats a missing thoughtSignature as blocking', () => {
    const timeline = buildOrderingTimeline([], [], [missing])
    const result = evaluateOrderingProfile(timeline, thoughtSignatureRequired)
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0].severity).toBe('blocking')
    expect(result.blocking[0].ruleId).toBe('thought-signature-required')
  })

  it('fills the vendor sentinel in mutate mode WITHOUT the global fallback opt-in', async () => {
    // Issue #15 defect 3. This rule is blocking and its only repair used to sit behind the global
    // `allowMetadataFallbackRepair`, so gemini-3 could not dispatch replayed tool-call history
    // under ANY configuration. The rule now authorizes its own fallback, because the value is
    // Google's published sentinel rather than a fabricated provenance claim.
    const ctx = context(missing)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [thoughtSignatureRequired],
      action: 'mutate',
    })(ctx as never, next)
    const repaired = (ctx.mutateToolCall.mock.calls as unknown[][])[0]?.[0] as ToolCall
    expect((repaired.payload as { thoughtSignature?: unknown })?.thoughtSignature).toBe(
      'skip_thought_signature_validator'
    )
    // The replay tag rides along, so a downstream adapter can tell a sentinel from a real signature.
    expect(repaired.replayCompatibility).toBe('gemini-thought-signature-sentinel-v1')
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    expect(
      evaluateOrderingProfile(buildOrderingTimeline([], [], [repaired]), thoughtSignatureRequired)
        .blocking
    ).toHaveLength(0)
  })

  it('does not repair a rule that neither authorizes itself nor is globally opted in', async () => {
    // The authorization is per-RULE, so enabling one vendor's documented sentinel must not widen
    // the surface to any other rule carrying a fallback value.
    const unauthorized: OrderingProfile = {
      ...thoughtSignatureRequired,
      rules: thoughtSignatureRequired.rules.map((rule) => ({
        ...rule,
        fallbackRepairAuthorized: false,
      })),
    }
    const ctx = context(missing)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({ profiles: [unauthorized], action: 'mutate' })(
      ctx as never,
      next
    )
    expect(ctx.mutateToolCall).not.toHaveBeenCalled()
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()

    // ...and the global flag still reaches it, unchanged.
    const globallyEnabled = context(missing)
    await orderingGuardDispatchMiddleware({
      profiles: [unauthorized],
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(
      globallyEnabled as never,
      vi.fn(async () => undefined)
    )
    expect(globallyEnabled.mutateToolCall).toHaveBeenCalledOnce()
    expect(globallyEnabled.nack).not.toHaveBeenCalled()
  })
})
