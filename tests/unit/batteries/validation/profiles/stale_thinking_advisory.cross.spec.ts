import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import { staleThinkingAdvisory } from '../../../../../src/batteries/validation/profiles/stale_thinking_advisory'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'

const time = (seconds: number): DateTime => DateTime.fromMillis(seconds * 1000)
const thought = (id: string, at: number): Thought =>
  new Thought({ id, content: id, createdAt: time(at), updatedAt: time(at) })
const message = (id: string, role: 'user' | 'assistant', at: number): Message =>
  new Message({
    id,
    role,
    content: id,
    createdAt: time(at),
    updatedAt: time(at),
  })
const timeline = (thoughts: Thought[], messages: Message[]) =>
  buildOrderingTimeline(messages, thoughts, [])
const stale = timeline([thought('old', 1)], [message('user', 'user', 2)])

describe('stale-thinking-advisory profile', () => {
  it('has no advisory for thought after the latest user turn', () => {
    const result = evaluateOrderingProfile(
      timeline([thought('new', 3)], [message('user', 'user', 2)]),
      staleThinkingAdvisory
    )
    expect(result.advisories).toHaveLength(0)
  })

  it('reports stale thought content as advisory-only', () => {
    const result = evaluateOrderingProfile(stale, staleThinkingAdvisory)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].primitiveIds).toEqual(['old'])
    expect(result.advisories[0].ruleId).toBe('stale-thinking-gemma4')
    expect(result.blocking).toHaveLength(0)
    expect(result.advisories[0].severity).toBe('advisory')
  })

  it('never sends advisory findings to repair or nack paths', async () => {
    const evaluated = evaluateOrderingProfile(stale, staleThinkingAdvisory)
    const repaired = repairViolations(stale, evaluated.blocking)
    expect(repaired.repaired).toHaveLength(0)
    expect(repaired.unrepaired).toHaveLength(0)

    const stash = new Map<string, unknown>()
    const ctx = {
      turnMessages: new Set([message('user', 'user', 2)]),
      turnThoughts: new Set([thought('old', 1)]),
      turnToolCalls: new Set(),
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
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [staleThinkingAdvisory],
      action: 'mutate',
    })(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.abort).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })
})
