import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import {
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'
import { roleRemapInlineToolCall } from '../../../../../src/batteries/validation/profiles/role_remap_inline_tool_call'
import type { OrderingTimelineEntry } from '../../../../../src/batteries/validation/types'

const entry = (id: string, payload?: unknown): OrderingTimelineEntry => ({
  kind: 'toolCall',
  at: 0,
  seq: 0,
  value: { id, payload } as OrderingTimelineEntry['value'],
})

// The evaluator checks the generic marker string, not a vendor wire-role name.
const valid = [entry('call', { payload: { roleTag: 'granite-4.x' } })]
const sabotage = [entry('call', { payload: { roleTag: 'tool_response' } })]

describe('role-remap-inline-tool-call profile', () => {
  it('accepts a ToolCall carrying the Granite 4.x marker', () => {
    expect(evaluateOrderingProfile(valid, roleRemapInlineToolCall).blocking).toHaveLength(0)
  })

  it('blocks a ToolCall carrying the wrong role marker', () => {
    const result = evaluateOrderingProfile(sabotage, roleRemapInlineToolCall)
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0].ruleId).toBe('granite-4-x-inline-tool-call')
  })

  it('leaves the role-remap violation unrepaired and blocks dispatch', async () => {
    const result = repairViolations(
      sabotage,
      evaluateOrderingProfile(sabotage, roleRemapInlineToolCall).blocking
    )
    expect(result.repaired).toHaveLength(0)
    expect(result.unrepaired).toHaveLength(1)

    const date = DateTime.fromMillis(1000)
    const call = new ToolCall({
      id: 'call',
      tool: 'sample',
      args: {},
      checksum: 'call',
      isComplete: true,
      isError: false,
      results: new Tokenizable('result'),
      payload: { roleTag: 'tool_response' },
      replayCompatibility: 'test-replay',
      createdAt: date,
      updatedAt: date,
      completedAt: date,
    })
    const values = new Map<string, unknown>()
    const ctx = {
      turnMessages: new Set(),
      turnThoughts: new Set(),
      turnToolCalls: new Set([call]),
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
    const next = vi.fn(async () => undefined)
    await orderingGuardDispatchMiddleware({
      profiles: [roleRemapInlineToolCall],
      action: 'mutate',
    })(ctx as never, next)
    expect(ctx.nack).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })
})
