/**
 * Covers the reference roleRemap renderer — the consumer-side half of the `role_remap_*` contract.
 *
 * The point being proven: `payload.roleTag` is NOT provider-invisible. It is invisible under the
 * DEFAULT renderer and visible under a renderer that reads it, and message assembly is injectable
 * on every LLM battery. That distinction is what makes step 1 of the Granite audit testable.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { readRoleTag, renderGraniteToolCall } from '../../../_fixtures/ordering/granite_renderer'

const at = DateTime.fromMillis(2000)
const call = (payload?: Record<string, unknown>): ToolCall =>
  new ToolCall({
    id: 'c1',
    tool: 'get_file_diff',
    args: { path: 'src/retry.ts' },
    checksum: 'c1',
    isComplete: true,
    isError: false,
    results: new Tokenizable('@@ -12,7 +12,9 @@'),
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    ...(payload ? { payload, replayCompatibility: 'ordering-audit-v1' } : {}),
  } as never)

const RESULT = '@@ -12,7 +12,9 @@'
/** The battery default (helpers.ts:439-442): id + result only, payload never read. */
const defaultRender = (tc: ToolCall) => [{ role: 'tool', content: String(tc.results ?? '') }]

describe('granite roleTag renderer', () => {
  describe('tag extraction', () => {
    it('reads the tag from the configured payload field', () => {
      expect(readRoleTag(call({ roleTag: 'granite-3.x' }))).toBe('granite-3.x')
      expect(readRoleTag(call({ wireRole: 'granite-4.x' }), 'wireRole')).toBe('granite-4.x')
    })
    it('returns undefined for an absent payload or a non-string tag', () => {
      expect(readRoleTag(call(undefined))).toBeUndefined()
      expect(readRoleTag(call({ roleTag: 42 }))).toBeUndefined()
    })
  })

  describe('the tag is invisible under the DEFAULT renderer', () => {
    it('renders tagged and untagged calls to identical bytes', () => {
      const untagged = JSON.stringify(defaultRender(call(undefined)))
      const tagged = JSON.stringify(defaultRender(call({ roleTag: 'granite-3.x' })))
      // This is why the cell would measure nothing without a custom renderer: the independent
      // variable never varies at the wire.
      expect(untagged).toBe(tagged)
    })
  })

  describe('the tag is VISIBLE under the roleTag-aware renderer', () => {
    it('renders 3.x as split roles and 4.x as an inlined call', () => {
      const v3 = renderGraniteToolCall(call({ roleTag: 'granite-3.x' }), RESULT)
      const v4 = renderGraniteToolCall(call({ roleTag: 'granite-4.x' }), RESULT)
      expect(v3).toHaveLength(2)
      expect(v3[0]).toEqual({ role: 'assistant', content: '<tool_call>get_file_diff</tool_call>' })
      expect(v3[1]).toEqual({ role: 'tool_response', content: RESULT })
      expect(v4).toHaveLength(1)
      expect(v4[0].content).toContain('<|tool_call|>')
      // Different bytes => the model sees different input => step 1 is falsifiable.
      expect(JSON.stringify(v3)).not.toBe(JSON.stringify(v4))
    })

    it('falls back to the inline form when the tag is absent, matching 4.x exactly', () => {
      const untagged = renderGraniteToolCall(call(undefined), RESULT)
      const v4 = renderGraniteToolCall(call({ roleTag: 'granite-4.x' }), RESULT)
      // The fallback is a GUESS, which is precisely what the guard's advisory reports.
      expect(JSON.stringify(untagged)).toBe(JSON.stringify(v4))
    })

    it('honours a consumer-named payload field, matching the profile parameter', () => {
      // A consumer passing 'wireRole' to BOTH the renderer and the profile token keeps the two
      // halves of the contract in agreement.
      const rendered = renderGraniteToolCall(call({ wireRole: 'granite-3.x' }), RESULT, 'wireRole')
      expect(rendered).toHaveLength(2)
      expect(rendered[1].role).toBe('tool_response')
    })
  })
})
