import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
} from '../../../../src/batteries/validation/helpers'
import {
  orderingGuardDispatchMiddleware,
  orderingGuardTurnMiddleware,
  ORDERING_GUARD_RESULT_STASH_KEY,
  ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY,
} from '../../../../src/batteries/validation/middleware'
import type { OrderingGuardOptions } from '../../../../src/batteries/validation/types'

const time = (seconds: number): DateTime => DateTime.fromMillis(seconds * 1000)

const message = (id: string, role: 'user' | 'assistant', at: number): Message =>
  new Message({
    id,
    role,
    content: id,
    createdAt: time(at),
    updatedAt: time(at),
  })

const thought = (id: string, at: number): Thought =>
  new Thought({
    id,
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

type MockContext = {
  turnMessages: Set<Message>
  turnThoughts: Set<Thought>
  turnToolCalls: Set<ToolCall>
  stash: { get: <T>(key: string, fallback?: T) => T; set: (key: string, value: unknown) => void }
  storeMessage: (value: Message) => Promise<void>
  mutateMessage: ReturnType<typeof vi.fn>
  mutateThought: ReturnType<typeof vi.fn>
  mutateToolCall: ReturnType<typeof vi.fn>
  nack: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
}

const context = (input?: {
  messages?: Message[]
  thoughts?: Thought[]
  toolCalls?: ToolCall[]
  stash?: Map<string, unknown>
}): MockContext => {
  const values = input?.stash ?? new Map<string, unknown>()
  const ctx: MockContext = {
    turnMessages: new Set(input?.messages ?? []),
    turnThoughts: new Set(input?.thoughts ?? []),
    turnToolCalls: new Set(input?.toolCalls ?? []),
    stash: {
      get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
      set: (key: string, value: unknown): void => {
        values.set(key, value)
      },
    },
    storeMessage: async (value: Message): Promise<void> => {
      ctx.turnMessages.add(value)
    },
    mutateMessage: vi.fn(async (value: Message) => {
      for (const m of ctx.turnMessages) if (m.id === value.id) ctx.turnMessages.delete(m)
      ctx.turnMessages.add(value)
    }),
    mutateThought: vi.fn(async (value: Thought) => {
      for (const t of ctx.turnThoughts) if (t.id === value.id) ctx.turnThoughts.delete(t)
      ctx.turnThoughts.add(value)
    }),
    mutateToolCall: vi.fn(async (value: ToolCall) => {
      for (const tc of ctx.turnToolCalls) if (tc.id === value.id) ctx.turnToolCalls.delete(tc)
      ctx.turnToolCalls.add(value)
    }),
    nack: vi.fn(),
    abort: vi.fn(),
  }
  return ctx
}

const alternation: OrderingGuardOptions = {
  profiles: [
    {
      name: 'strict',
      description: 'test',
      rules: [
        {
          type: 'alternation',
          id: 'strict-alternation',
          roles: ['user', 'assistant'],
          mode: 'strict',
        },
      ],
    },
  ],
}

const order: OrderingGuardOptions = {
  profiles: [
    {
      name: 'thinking-order',
      description: 'test',
      rules: [
        {
          type: 'order',
          id: 'thought-before-tool',
          before: 'thought',
          after: 'toolCall',
          scope: 'entire-turn',
        },
      ],
    },
  ],
  action: 'mutate',
}

const preservation: OrderingGuardOptions = {
  profiles: [
    {
      name: 'history',
      description: 'test',
      rules: [
        {
          type: 'preservation',
          id: 'keep-tools',
          kind: 'toolCall',
          invariant: 'count-non-decreasing',
        },
      ],
    },
  ],
}

const advisory: OrderingGuardOptions = {
  profiles: [
    {
      name: 'advisory',
      description: 'test',
      rules: [
        {
          type: 'staleContentAdvisory',
          id: 'stale-thought',
          kind: 'thought',
          scope: 'before-latest-user-turn',
          optOutOptionKey: 'preserveThinking',
        },
      ],
    },
  ],
}

describe('ordering guard middleware', () => {
  it('resolves atomic and family profile strings through the profile registries', async () => {
    const atomicCtx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const familyCtx = context({ toolCalls: [toolCall('missing-signature', 1)] })
    const next = vi.fn(async () => undefined)

    await orderingGuardDispatchMiddleware({ profiles: ['strict_alternation'] })(
      atomicCtx as never,
      next
    )
    await orderingGuardDispatchMiddleware({ profiles: ['gemini-3'] })(familyCtx as never, next)

    expect(atomicCtx.nack).toHaveBeenCalledOnce()
    expect(familyCtx.nack).toHaveBeenCalledOnce()
    expect(
      (familyCtx.nack.mock.calls[0][0] as Error & { violations: { ruleId: string }[] }).violations
    ).toEqual([expect.objectContaining({ ruleId: 'thought-signature-required' })])
    expect(next).not.toHaveBeenCalled()
  })

  it('aborts a turn by default and throws only when explicitly configured', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const turnCtx = { ...ctx, nack: undefined }
    const next = vi.fn(async () => undefined)

    await orderingGuardTurnMiddleware(alternation)(turnCtx as never, next)
    expect(ctx.abort).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()

    const throwingCtx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const throwingTurnCtx = { ...throwingCtx, nack: undefined }
    await expect(
      orderingGuardTurnMiddleware({ ...alternation, onViolation: 'throw' })(
        throwingTurnCtx as never,
        next
      )
    ).rejects.toMatchObject({ code: 'E_ORDERING_VIOLATION' })
    expect(throwingCtx.abort).not.toHaveBeenCalled()
  })

  it('nacks and does not call next for blocking enforce violations', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware(alternation)(ctx as never, next)

    expect(ctx.nack).toHaveBeenCalledOnce()
    const error = ctx.nack.mock.calls[0][0] as Error & { violations?: unknown[]; code?: string }
    expect(error.message).toContain('Ordering guard rejected dispatch')
    expect(error.violations).toHaveLength(1)
    expect(next).not.toHaveBeenCalled()
  })

  it('records and applies a reorder repair without rejecting, and the fix reaches the live turn state', async () => {
    const ctx = context({ thoughts: [thought('thought-1', 2)], toolCalls: [toolCall('call-1', 1)] })
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware(order)(ctx as never, next)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    expect(
      ctx.stash.get<{ repaired: { strategy: string }[] }>(ORDERING_GUARD_RESULT_STASH_KEY).repaired
    ).toEqual([expect.objectContaining({ strategy: 'reorder' })])
    const effective = ctx.stash.get<{ value: { id: string } }[]>(
      ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY
    )
    expect(effective.map((entry) => entry.value.id)).toEqual(['thought-1', 'call-1'])

    // The guard's own effectiveTimeline proving itself is not enough — the repair must reach
    // the REAL turn state, since that is what an LLM adapter's own history assembly reads from.
    expect(ctx.mutateThought).toHaveBeenCalledOnce()
    const repairedThought = (ctx.mutateThought.mock.calls[0] as [Thought])[0]
    expect(repairedThought.id).toBe('thought-1')
    const [liveToolCall] = [...ctx.turnToolCalls]
    expect(repairedThought.createdAt.toMillis()).toBeLessThan(liveToolCall.createdAt.toMillis())

    // Rebuilding the timeline from ctx.turnThoughts/turnToolCalls directly (as any real adapter
    // would on its next history-assembly pass) must now show the corrected order with ZERO
    // violations — not just the guard's own in-memory copy from the iteration that repaired it.
    const rebuilt = buildOrderingTimeline(ctx.turnMessages, ctx.turnThoughts, ctx.turnToolCalls)
    expect(evaluateOrderingProfile(rebuilt, order.profiles[0] as never).blocking).toHaveLength(0)
  })

  it('reorder repair still resolves the violation when the blocker sits at epoch zero (clamp cannot go negative)', async () => {
    // The blocker's createdAt is Unix epoch 0 — the timestamp shift (blockerEntry.at - 1) would
    // go negative here, so the guard clamps to 0 and the moved primitive TIES with the blocker
    // rather than strictly preceding it. This proves that tie still resolves the violation, via
    // the timeline's own tie-break (Set insertion position), rather than silently claiming success.
    const ctx = context({
      thoughts: [thought('thought-1', 1)],
      toolCalls: [toolCall('call-1', 0)],
    })
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware(order)(ctx as never, next)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    const repairedThought = (ctx.mutateThought.mock.calls[0] as [Thought])[0]
    expect(repairedThought.createdAt.toMillis()).toBe(0)
    const rebuilt = buildOrderingTimeline(ctx.turnMessages, ctx.turnThoughts, ctx.turnToolCalls)
    expect(evaluateOrderingProfile(rebuilt, order.profiles[0] as never).blocking).toHaveLength(0)
  })

  it('resolves the grok family name to the permissive profile', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({ profiles: ['grok'] })(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('repairs an alternation violation with a positioned opposite-role filler', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 3)] })
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({ ...alternation, action: 'mutate' })(ctx as never, next)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    const result = ctx.stash.get<{ unrepaired: unknown[]; repaired: { strategy: string }[] }>(
      ORDERING_GUARD_RESULT_STASH_KEY
    )
    expect(result.repaired).toEqual([
      expect.objectContaining({ strategy: 'insert-alternation-filler' }),
    ])
    expect(result.unrepaired).toHaveLength(0)
    const effective = ctx.stash.get<{ role: 'user' | 'assistant'; value: { id: string } }[]>(
      ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY
    )
    expect(effective.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('repairs alternation when violating messages share an identical timestamp', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 1)] })
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({ ...alternation, action: 'mutate' })(ctx as never, next)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    expect(
      ctx.stash.get<{ unrepaired: unknown[] }>(ORDERING_GUARD_RESULT_STASH_KEY).unrepaired
    ).toHaveLength(0)
    expect(
      ctx.stash
        .get<{ role: string }[]>(ORDERING_GUARD_EFFECTIVE_TIMELINE_STASH_KEY)
        .map((entry) => entry.role)
    ).toEqual(['user', 'assistant', 'user'])
  })

  it('nacks when post-repair evaluation still finds a blocking violation', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const next = vi.fn(async () => undefined)
    const impossible: OrderingGuardOptions = {
      ...alternation,
      action: 'mutate',
      profiles: [
        {
          name: 'impossible',
          description: 'test',
          rules: [
            {
              type: 'order',
              id: 'message-before-message',
              before: 'message',
              after: 'message',
              scope: 'entire-turn',
            },
          ],
        },
      ],
    }
    await orderingGuardDispatchMiddleware(impossible)(ctx as never, next)
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
    expect(
      ctx.stash.get<{ unrepaired: { ruleId: string }[] }>(ORDERING_GUARD_RESULT_STASH_KEY)
        .unrepaired
    ).toEqual([expect.objectContaining({ ruleId: 'message-before-message' })])
  })

  it('uses abort rather than throwing for turn middleware default violations', async () => {
    const ctx = context({ messages: [message('u1', 'user', 1), message('u2', 'user', 2)] })
    const next = vi.fn(async () => undefined)
    ctx.nack = undefined as never
    await orderingGuardTurnMiddleware(alternation)(ctx as never, next)
    expect(ctx.abort).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('nacks genuinely unrepairable preservation loss in mutate mode', async () => {
    const shared = new Map<string, unknown>()
    const ctx = context({ toolCalls: [toolCall('call-1', 1)], stash: shared })
    const firstNext = vi.fn(async () => undefined)
    const secondNext = vi.fn(async () => undefined)

    await orderingGuardDispatchMiddleware({ ...preservation, action: 'mutate' })(
      ctx as never,
      firstNext
    )
    ctx.turnToolCalls.clear()
    await orderingGuardDispatchMiddleware({ ...preservation, action: 'mutate' })(
      ctx as never,
      secondNext
    )

    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(firstNext).toHaveBeenCalledOnce()
    expect(secondNext).not.toHaveBeenCalled()
    expect(
      ctx.stash.get<{ unrepaired: { ruleId: string }[] }>(ORDERING_GUARD_RESULT_STASH_KEY)
        .unrepaired
    ).toEqual([expect.objectContaining({ ruleId: 'keep-tools' })])
  })

  it('only reports preservation loss on the second shared-stash invocation', async () => {
    const shared = new Map<string, unknown>()
    const ctx = context({ toolCalls: [toolCall('call-1', 1)], stash: shared })
    const firstNext = vi.fn(async () => undefined)
    const secondNext = vi.fn(async () => undefined)

    await orderingGuardDispatchMiddleware(preservation)(ctx as never, firstNext)
    ctx.turnToolCalls.clear()
    await orderingGuardDispatchMiddleware(preservation)(ctx as never, secondNext)

    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(firstNext).toHaveBeenCalledOnce()
    expect(secondNext).not.toHaveBeenCalled()
  })

  it.each([{ action: 'enforce' as const }, { action: 'mutate' as const }])(
    'keeps advisory findings non-blocking in $action mode',
    async ({ action }) => {
      const ctx = context({
        messages: [message('old-user', 'user', 1), message('new-user', 'user', 3)],
        thoughts: [thought('old-thought', 2)],
      })
      const next = vi.fn(async () => undefined)
      await orderingGuardDispatchMiddleware({ ...advisory, action })(ctx as never, next)

      expect(ctx.nack).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledOnce()
      const result = ctx.stash.get<{ unrepaired: unknown[]; advisories: { ruleId: string }[] }>(
        ORDERING_GUARD_RESULT_STASH_KEY
      )
      expect(result.unrepaired).toHaveLength(0)
      expect(result.advisories).toEqual([expect.objectContaining({ ruleId: 'stale-thought' })])
    }
  )
})
