import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'

describe('DispatchContext.onAck', () => {
  it('fires registered handlers when ack() is called', () => {
    const ctx = makeDispatchContext()
    const handler = vi.fn()
    ctx.onAck(handler)
    ctx.ack()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('does not fire handlers when nack() is called', () => {
    const ctx = makeDispatchContext()
    const handler = vi.fn()
    ctx.onAck(handler)
    ctx.nack(new Error('boom'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns an unsubscribe function that removes the handler', () => {
    const ctx = makeDispatchContext()
    const handler = vi.fn()
    const unsub = ctx.onAck(handler)
    unsub()
    ctx.ack()
    expect(handler).not.toHaveBeenCalled()
  })

  it('invokes multiple handlers in registration order', () => {
    const ctx = makeDispatchContext()
    const order: string[] = []
    ctx.onAck(() => order.push('a'))
    ctx.onAck(() => order.push('b'))
    ctx.onAck(() => order.push('c'))
    ctx.ack()
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('does not re-fire a removed handler when other handlers remain', () => {
    const ctx = makeDispatchContext()
    const kept = vi.fn()
    const removed = vi.fn()
    ctx.onAck(kept)
    const unsub = ctx.onAck(removed)
    unsub()
    ctx.ack()
    expect(kept).toHaveBeenCalledOnce()
    expect(removed).not.toHaveBeenCalled()
  })
})
