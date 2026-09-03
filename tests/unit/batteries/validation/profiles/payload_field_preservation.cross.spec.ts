import { DateTime } from 'luxon'
import { Thought } from '@nhtio/adk/common'
import { describe, expect, it, vi } from 'vitest'
import { payloadFieldPreservation } from '../../../../../src/batteries/validation/profiles/payload_field_preservation'
import {
  orderingGuardDispatchMiddleware,
  ORDERING_GUARD_RESULT_STASH_KEY,
} from '../../../../../src/batteries/validation/middleware'
import type { OrderingGuardResult } from '../../../../../src/batteries/validation/types'

const thought = (signature: string) =>
  new Thought({
    id: 'thinking',
    content: 'reasoning',
    payload: { signature },
    replayCompatibility: 'anthropic-messages-thinking-v1',
    createdAt: DateTime.fromMillis(1000),
    updatedAt: DateTime.fromMillis(1000),
  })
const context = (stash: Map<string, unknown>, signature: string) => ({
  turnMessages: new Set(),
  turnThoughts: new Set([thought(signature)]),
  turnToolCalls: new Set(),
  stash: {
    get: <T>(key: string, fallback?: T) => (stash.has(key) ? stash.get(key) : fallback) as T,
    set: (key: string, value: unknown) => stash.set(key, value),
  },
  storeMessage: vi.fn(async () => undefined),
  mutateThought: vi.fn(async () => undefined),
  mutateToolCall: vi.fn(async () => undefined),
  nack: vi.fn(),
  abort: vi.fn(),
})

/**
 * Shipped ADVISORY by default (OrderRule.severity — a live audit found the catalog's rules block
 * turn state their vendors accept). Only a BLOCKING finding gates dispatch or reaches the repair
 * path, so tests asserting those drive this helper; the reporting tests use the shipped profile.
 */
const blocking = (profile: { rules: readonly unknown[] }) => ({
  ...profile,
  rules: (profile.rules as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    severity: 'blocking' as const,
  })),
})

describe('payload field preservation profile', () => {
  it('accepts an established thought signature that remains stable', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(stash, 'abc')
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware({
      profiles: [blocking(payloadFieldPreservation('signature')) as never],
    })
    await middleware(ctx as never, next)
    await middleware(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('reports a changed signature only after the baseline invocation', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(stash, 'abc')
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware({
      profiles: [blocking(payloadFieldPreservation('signature')) as never],
    })
    await middleware(ctx as never, next)
    ctx.turnThoughts.clear()
    ctx.turnThoughts.add(thought('xyz'))
    await middleware(ctx as never, next)
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect((ctx.nack.mock.calls[0][0] as { violations: { ruleId: string }[] }).violations).toEqual([
      expect.objectContaining({ ruleId: 'payload-field-preservation-thought-signature' }),
    ])
  })

  it('keeps a changed signature unrepaired and rejects mutate mode', async () => {
    const stash = new Map<string, unknown>()
    const ctx = context(stash, 'abc')
    const next = vi.fn(async () => undefined)
    const middleware = orderingGuardDispatchMiddleware({
      action: 'mutate',
      profiles: [blocking(payloadFieldPreservation('signature')) as never],
    })
    await middleware(ctx as never, next)
    ctx.turnThoughts.clear()
    ctx.turnThoughts.add(thought('xyz'))
    await middleware(ctx as never, next)
    const result = stash.get(ORDERING_GUARD_RESULT_STASH_KEY) as OrderingGuardResult
    expect(result.repaired).toHaveLength(0)
    expect(result.unrepaired).toEqual([
      expect.objectContaining({ ruleId: 'payload-field-preservation-thought-signature' }),
    ])
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledOnce()
  })
})
