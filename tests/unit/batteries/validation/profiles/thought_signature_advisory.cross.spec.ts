import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import { thoughtSignatureAdvisory } from '../../../../../src/batteries/validation/profiles/thought_signature_advisory'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'

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
  return {
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
}

describe('thought-signature-advisory profile', () => {
  it('happy path has no findings when thoughtSignature is present', () => {
    const value = toolCall({ thoughtSignature: 'sig' })
    const result = evaluateOrderingProfile(
      buildOrderingTimeline([], [], [value]),
      thoughtSignatureAdvisory
    )
    expect(result.blocking).toHaveLength(0)
    expect(result.advisories).toHaveLength(0)
  })

  it('sabotage reports missing thoughtSignature as advisory only', () => {
    const result = evaluateOrderingProfile(
      buildOrderingTimeline([], [], [toolCall()]),
      thoughtSignatureAdvisory
    )
    expect(result.blocking).toHaveLength(0)
    expect(result.advisories).toEqual([
      expect.objectContaining({
        severity: 'advisory',
        ruleId: 'thought-signature-advisory',
      }),
    ])
  })

  it('mutation never sends advisory findings through repair machinery', async () => {
    const value = toolCall()
    const timeline = buildOrderingTimeline([], [], [value])
    const evaluated = evaluateOrderingProfile(timeline, thoughtSignatureAdvisory)
    expect(repairViolations(timeline, evaluated.blocking).repaired).toHaveLength(0)
    const ctx = context(value)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [thoughtSignatureAdvisory],
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(ctx as never, next)
    expect(ctx.mutateToolCall).not.toHaveBeenCalled()
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })
})
