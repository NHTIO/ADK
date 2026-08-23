import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { Message, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { validateOptions } from '../../../../src/batteries/validation/validation'
import { orderingGuardDispatchMiddleware } from '../../../../src/batteries/validation/middleware'
import type { OrderingGuardOptions } from '../../../../src/batteries/validation/types'

const profile = (kind: 'toolCall' | 'message' = 'toolCall'): OrderingGuardOptions => ({
  profiles: [
    {
      name: 'fallback',
      description: 'test',
      rules: [
        {
          type: 'requiredMetadata',
          id: 'required',
          kind,
          applyTo: 'every',
          requiredPayloadKey: 'thoughtSignature',
          fallbackPayloadValue: 'skip_thought_signature_validator',
          fallbackReplayCompatibility: 'gemini-thought-signature-sentinel-v1',
        },
      ],
    },
  ],
})

const nestedProfile = (): OrderingGuardOptions => ({
  profiles: [
    {
      name: 'nested-fallback',
      description: 'test',
      rules: [
        {
          type: 'requiredMetadata',
          id: 'nested-required',
          kind: 'toolCall',
          applyTo: 'every',
          requiredPayloadKey: 'signature.value',
          fallbackPayloadValue: 'nested-sentinel',
          fallbackReplayCompatibility: 'nested-fallback-sentinel-v1',
        },
      ],
    },
  ],
})

const tool = new ToolCall({
  id: 'call',
  tool: 'sample',
  args: {},
  checksum: 'call',
  isComplete: true,
  isError: false,
  results: new Tokenizable('result'),
  createdAt: DateTime.now(),
  updatedAt: DateTime.now(),
  completedAt: DateTime.now(),
})

const context = (value: ToolCall | Message) => {
  const stash = new Map<string, unknown>()
  const ctx = {
    turnMessages: new Set(Message.isMessage(value) ? [value] : []),
    turnThoughts: new Set(),
    turnToolCalls: new Set(ToolCall.isToolCall(value) ? [value] : []),
    stash: {
      get: <T>(key: string, fallback?: T) => (stash.has(key) ? stash.get(key) : fallback) as T,
      set: (key: string, v: unknown) => stash.set(key, v),
    },
    storeMessage: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
    mutateThought: vi.fn(async () => undefined),
    nack: vi.fn(),
    abort: vi.fn(),
  }
  return ctx
}

describe('metadata fallback repair', () => {
  it('requires the stronger opt-in even in mutate mode', async () => {
    const ctx = context(tool)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({ ...profile(), action: 'mutate' })(ctx as never, next)
    expect(ctx.mutateToolCall).not.toHaveBeenCalled()
    expect(ctx.nack).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('fills a missing ToolCall sentinel with both opt-ins', async () => {
    const ctx = context(tool)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      ...profile(),
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(ctx as never, next)
    const repaired = (ctx.mutateToolCall.mock.calls as unknown[][])[0]?.[0] as ToolCall | undefined
    expect(repaired).toBeInstanceOf(ToolCall)
    expect(repaired?.payload).toEqual({
      thoughtSignature: 'skip_thought_signature_validator',
    })
    expect(repaired?.replayCompatibility).toBe('gemini-thought-signature-sentinel-v1')
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('fills a nested dot-path key at the exact location the evaluator reads', async () => {
    const ctx = context(tool)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      ...nestedProfile(),
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(ctx as never, next)
    const repaired = (ctx.mutateToolCall.mock.calls as unknown[][])[0]?.[0] as ToolCall | undefined
    expect(repaired).toBeInstanceOf(ToolCall)
    expect(
      (repaired?.payload as { signature?: { value?: string } } | undefined)?.signature
    ).toEqual({ value: 'nested-sentinel' })
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })

  it('accepts fallback options and never fabricates payload on Message', async () => {
    expect(() => validateOptions({ ...profile(), allowMetadataFallbackRepair: true })).not.toThrow()
    expect(() =>
      validateOptions({ ...profile(), allowMetadataFallbackRepair: false })
    ).not.toThrow()
    expect(() => validateOptions(profile())).not.toThrow()
    const date = DateTime.now()
    const message = new Message({
      id: 'message',
      role: 'user',
      content: 'x',
      createdAt: date,
      updatedAt: date,
    })
    const ctx = context(message)
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      ...profile('message'),
      action: 'mutate',
      allowMetadataFallbackRepair: true,
    })(ctx as never, next)
    // Message has no payload field, so the defensive branch leaves this violation unrepaired.
    expect(ctx.mutateToolCall).not.toHaveBeenCalled()
    expect(ctx.nack).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})
