import { describe, expect, it } from 'vitest'
import { deCollideToolCallIds } from '@nhtio/adk/batteries/llm/openai_chat_completions'
import type { DispatchContext } from '@nhtio/adk/types'

const contextWithIds = (...ids: string[]): DispatchContext =>
  ({ turnToolCalls: new Set(ids.map((id) => ({ id }))) }) as unknown as DispatchContext

// The absent-hook identity path is covered by the adapter wiring job rather than this spec.
describe('deCollideToolCallIds', () => {
  it('keeps an id unchanged when there is no real collision', () => {
    expect(deCollideToolCallIds('call_0', contextWithIds('call_1'))).toBe('call_0')
  })

  it('rewrites only on a real collision', () => {
    const id = 'call_0'
    const rewritten = deCollideToolCallIds(id, contextWithIds(id))
    expect(rewritten).not.toBe(id)
    expect(rewritten).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('passes a correctly numbered parallel batch through untouched', () => {
    const ids = ['call_0', 'call_1', 'call_2', 'call_3']
    const ctx = contextWithIds()
    const adopted = ids.map((id) => {
      const filtered = deCollideToolCallIds(id, ctx)
      ;(ctx.turnToolCalls as Set<{ id: string }>).add({ id: filtered })
      return filtered
    })
    expect(adopted).toEqual(ids)
  })

  it('rewrites a same-response duplicate', () => {
    const ctx = contextWithIds('call_0')
    const rewritten = deCollideToolCallIds('call_0', ctx)
    expect(rewritten).not.toBe('call_0')
  })
})
