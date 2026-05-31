import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'
import { implementsSpoolReader } from '../../../src/lib/contracts/spool_reader'
import { implementsMediaReader } from '../../../src/lib/contracts/media_reader'

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

describe('DispatchContext byte-persistence conduits', () => {
  it('storeMediaBytes delegates to the configured callback with (ctx, id, bytes)', async () => {
    const spy = vi.fn(
      async (_ctx: unknown, _id: string, _bytes: unknown) =>
        ({
          stream: () => new ReadableStream<Uint8Array>(),
          byteLength: () => 3,
        }) as never
    )
    const ctx = makeDispatchContext({ storeMediaBytes: spy })
    const bytes = new Uint8Array([1, 2, 3])
    await ctx.storeMediaBytes('media-1', bytes)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.calls[0][0]).toBe(ctx)
    expect(spy.mock.calls[0][1]).toBe('media-1')
    expect(spy.mock.calls[0][2]).toBe(bytes)
  })

  it('storeMediaBytes returns a MediaReader (default fixture conduit)', async () => {
    const ctx = makeDispatchContext()
    const reader = await ctx.storeMediaBytes('media-1', new Uint8Array([0xff, 0x00, 0xfe]))
    expect(implementsMediaReader(reader)).toBe(true)
    expect(await reader.byteLength()).toBe(3)
  })

  it('storeRetrievableBytes returns a SpoolReader over the persisted text', async () => {
    const ctx = makeDispatchContext()
    const reader = await ctx.storeRetrievableBytes('ret-1', 'line one\nline two')
    expect(implementsSpoolReader(reader)).toBe(true)
    expect(await reader.line(0)).toBe('line one')
    expect(await reader.line(1)).toBe('line two')
  })

  it('conduits do NOT add to the turn Sets (low-level persistence, not mutation)', async () => {
    const ctx = makeDispatchContext()
    await ctx.storeMediaBytes('m', new Uint8Array([1]))
    await ctx.storeRetrievableBytes('r', 'text')
    expect(ctx.turnMessages.size).toBe(0)
    expect(ctx.turnToolCalls.size).toBe(0)
    expect(ctx.turnRetrievables.size).toBe(0)
  })
})
