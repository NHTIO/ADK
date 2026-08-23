import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
} from '../../../../../src/batteries/validation/helpers'
import { thoughtSignatureRequired } from '../../../../../src/batteries/validation/profiles/thought_signature_required'

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

  it('mutation requires both opt-ins before filling the fallback signature', async () => {
    const withoutOptIn = context(missing)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [thoughtSignatureRequired],
      action: 'mutate',
    })(withoutOptIn as never, next)
    expect(withoutOptIn.mutateToolCall).not.toHaveBeenCalled()
    expect(withoutOptIn.nack).toHaveBeenCalledOnce()

    const withOptIn = context(missing)
    await orderingGuardDispatchMiddleware({
      profiles: [thoughtSignatureRequired],
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(withOptIn as never, next)
    const repaired = (withOptIn.mutateToolCall.mock.calls as unknown[][])[0]?.[0] as ToolCall
    expect((repaired.payload as { thoughtSignature?: unknown })?.thoughtSignature).toBe(
      'skip_thought_signature_validator'
    )
    expect(withOptIn.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    expect(
      evaluateOrderingProfile(buildOrderingTimeline([], [], [repaired]), thoughtSignatureRequired)
        .blocking
    ).toHaveLength(0)
  })
})
