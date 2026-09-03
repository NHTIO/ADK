/**
 * Regression coverage for issue #15 — three defects in `action: 'mutate'` that nacked otherwise
 * dispatchable turn state. The scenarios below are the issue's own reproductions, promoted into the
 * suite so the fixed behaviour is pinned rather than merely observed once.
 */
import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { strictAlternation } from '../../../../src/batteries/validation/profiles/strict_alternation'
import { openaiShapeBaseline } from '../../../../src/batteries/validation/profiles/openai_shape_baseline'
import {
  ORDERING_GUARD_RESULT_STASH_KEY,
  orderingGuardDispatchMiddleware,
} from '../../../../src/batteries/validation/middleware'
import type { OrderingProfile, OrderingRepair } from '../../../../src/batteries/validation/types'

const FILLER_PREFIX = '__ordering-guard-filler-'
const at = (seconds: number) => DateTime.fromMillis(seconds * 1000)

const message = (id: string, role: 'user' | 'assistant', seconds: number): Message =>
  new Message({ id, role, content: id, createdAt: at(seconds), updatedAt: at(seconds) })

/**
 * The profiles under test ship ADVISORY, because a live audit found most vendors accept the shapes
 * they describe. Only a BLOCKING finding reaches the repair path, so these tests drive blocking
 * variants: the subject here is the repair machinery, not the shipped severity.
 */
const blockingVariant = (profile: OrderingProfile): OrderingProfile => ({
  ...profile,
  rules: profile.rules.map((rule) => ({ ...rule, severity: 'blocking' as const })),
})

/** A DispatchContext double implementing only what `runGuard` touches, with a real message store. */
const harness = (messages: Message[], toolCalls: ToolCall[] = []) => {
  const store = new Map<string, unknown>()
  return {
    get turnMessages() {
      return new Set(messages)
    },
    turnThoughts: new Set(),
    turnToolCalls: new Set(toolCalls),
    stash: {
      get: <T>(key: string, fallback?: T) => (store.has(key) ? store.get(key) : fallback) as T,
      set: (key: string, value: unknown) => {
        store.set(key, value)
      },
    },
    storeMessage: async (created: Message) => {
      messages.push(created)
    },
    deleteMessage: async (id: string) => {
      const index = messages.findIndex((candidate) => candidate.id === id)
      if (index >= 0) messages.splice(index, 1)
    },
    mutateMessage: vi.fn(async () => undefined),
    mutateThought: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
    nack: vi.fn(),
    abort: vi.fn(),
    result: () =>
      store.get(ORDERING_GUARD_RESULT_STASH_KEY) as {
        repaired: OrderingRepair[]
        unrepaired: { ruleId: string }[]
      },
  }
}

describe('mutate-mode repair lifecycle (issue #15)', () => {
  it('keeps alternation fillers bounded across repeated dispatches', async () => {
    // Defect 2: fillers were stored and never removed, so each dispatch re-evaluated the previous
    // dispatch's output — generating fillers BETWEEN its own fillers, with ids nesting
    // exponentially, until the guard reported repaired AND unrepaired and nacked anyway. The issue
    // measured 2 -> 5 -> 9 fillers with duplicate ids and a 139-character id by iteration 1.
    const messages: Message[] = []
    const ctx = harness(messages)
    const guard = orderingGuardDispatchMiddleware({
      profiles: [blockingVariant(strictAlternation)],
      action: 'mutate',
    })
    // Three consecutive role:'user' bookends, re-stamped under stable ids each dispatch — the shape
    // any consumer injecting per-dispatch notices produces.
    const bookends = ['review-briefing', 'job-clock-notice', 'batching-guidance']
    for (let iteration = 0; iteration < 3; iteration++) {
      bookends.forEach((id, index) => {
        const replacement = message(id, 'user', iteration * 1000 + index * 10)
        const existing = messages.findIndex((candidate) => candidate.id === id)
        if (existing >= 0) messages[existing] = replacement
        else messages.push(replacement)
      })
      const next = vi.fn(async () => undefined)
      await guard(ctx as never, next)
      const fillers = messages.filter((candidate) => candidate.id.startsWith(FILLER_PREFIX))
      // Two gaps in the bookends, so two fillers — on EVERY iteration, not a growing count.
      expect(fillers).toHaveLength(2)
      expect(ctx.result().unrepaired).toHaveLength(0)
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      // Ids are drawn from a per-dispatch counter rather than built from neighbour ids, so they
      // cannot nest; the old scheme reached 139 characters by the second iteration.
      expect(Math.max(...fillers.map((filler) => filler.id.length))).toBeLessThan(40)
      expect(new Set(fillers.map((filler) => filler.id)).size).toBe(fillers.length)
    }
  })

  it('sends real content in a filler, never the filler id', async () => {
    // The filler reaches the model as an ordinary user turn, so its content is read. It used to be
    // its own `__ordering-guard-filler-…` id.
    const messages = [message('first', 'user', 1), message('second', 'user', 2)]
    const ctx = harness(messages)
    await orderingGuardDispatchMiddleware({
      profiles: [blockingVariant(strictAlternation)],
      action: 'mutate',
    })(
      ctx as never,
      vi.fn(async () => undefined)
    )
    const filler = messages.find((candidate) => candidate.id.startsWith(FILLER_PREFIX))
    expect(filler?.role).toBe('assistant')
    // `content` is a Tokenizable, so read the resolved string rather than the wrapper.
    const content = filler?.content?.valueOf()
    expect(content).not.toContain(FILLER_PREFIX)
    expect(content).toBe('Understood.')
  })

  it('repairs an adjacency violation instead of rejecting the dispatch', async () => {
    // Defect 1: `openai_shape_baseline` carries a single adjacency rule and is used by 25 of the 38
    // family recipes, none of which had a repair — `mutate` was identical to `enforce` for all of
    // them. The issue's repro is a tool call followed by a per-dispatch notice, which sorts after
    // it by construction.
    const call = new ToolCall({
      id: 'tc-1',
      tool: 'read_file',
      args: {},
      checksum: 'x',
      isComplete: true,
      isError: false,
      results: new Tokenizable('ok'),
      completedAt: at(150),
      createdAt: at(100),
      updatedAt: at(100),
    })
    const notice = message('job-clock-notice', 'user', 200)
    const ctx = harness([notice], [call])
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [blockingVariant(openaiShapeBaseline)],
      action: 'mutate',
    })(ctx as never, next)
    expect(ctx.result().unrepaired).toHaveLength(0)
    expect(ctx.result().repaired).toEqual([
      expect.objectContaining({ strategy: 'reorder-adjacent', targetId: 'job-clock-notice' }),
    ])
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })
})
