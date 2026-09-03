import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { orderingGuardDispatchMiddleware } from '../../../../../src/batteries/validation/middleware'
import {
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'
import { roleRemapSplitToolRoles } from '../../../../../src/batteries/validation/profiles/role_remap_split_tool_roles'
import type { OrderingTimelineEntry } from '../../../../../src/batteries/validation/types'

const entry = (id: string, payload?: unknown): OrderingTimelineEntry => ({
  kind: 'toolCall',
  at: 0,
  seq: 0,
  value: { id, payload } as OrderingTimelineEntry['value'],
})

// The evaluator checks the generic marker string, not a vendor wire-role name.
//
// NOTE the payload shape. `expectedRoleTag` is resolved INSIDE `value.payload`, so the tag lives at
// `payload.roleTag` — one level, exactly as a caller would write it. These fixtures previously
// double-nested it (`{ payload: { roleTag } }`) to satisfy a rule that declared the path as
// `'payload.roleTag'` and therefore read `payload.payload.roleTag`. That made the profile
// unsatisfiable for every real ToolCall: the middleware assertion below used a SINGLY-nested
// payload and "passed" only because it nacked — the fixtures encoded the bug rather than catching it.
const valid = [entry('call', { roleTag: 'granite-3.x' })]
const sabotage = [entry('call', { roleTag: 'assistant_tool_call' })]

// The profile is a FACTORY: the caller supplies which payload field carries the tag, what
// value to require, and the severity. Defaults reproduce the documented Granite shape.
const profile = roleRemapSplitToolRoles()

describe('role-remap-split-tool-roles profile', () => {
  it('accepts a ToolCall carrying the Granite 3.x marker', () => {
    expect(evaluateOrderingProfile(valid, profile).blocking).toHaveLength(0)
  })

  it('reports a wrong role marker as an ADVISORY without blocking dispatch', () => {
    const result = evaluateOrderingProfile(sabotage, profile)
    // `payload.roleTag` is a consumer-supplied annotation that nothing in the ADK writes, so this
    // rule defaults to advisory: a missing/mismatched tag is reported, never gated on.
    expect(result.blocking).toHaveLength(0)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].ruleId).toBe('granite-3-x-split-tool-roles')
    expect(result.advisories[0].severity).toBe('advisory')
  })

  it('permits dispatch: nothing to repair, nothing to block', async () => {
    const result = repairViolations(sabotage, evaluateOrderingProfile(sabotage, profile).blocking)
    // Nothing reaches the repair path at all now — the finding is an advisory, not a violation.
    expect(result.repaired).toHaveLength(0)
    expect(result.unrepaired).toHaveLength(0)

    const date = DateTime.fromMillis(1000)
    const call = new ToolCall({
      id: 'call',
      tool: 'sample',
      args: {},
      checksum: 'call',
      isComplete: true,
      isError: false,
      results: new Tokenizable('result'),
      payload: { roleTag: 'assistant_tool_call' },
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
      profiles: [profile],
      action: 'mutate',
    })(ctx as never, next)
    // Before the fix this nacked, making both Granite families unable to dispatch ANY tool call.
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
  })
})
