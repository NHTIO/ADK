import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../_fixtures/dispatch_context'
import {
  Memory,
  Message,
  Thought,
  ToolCall,
  Retrievable,
  Tokenizable,
  implementsSpoolReader,
  implementsMediaReader,
} from '@nhtio/adk/common'

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

describe('DispatchContext mutate* replaces the stale primitive by id', () => {
  const now = DateTime.now()

  it('mutateMessage replaces the prior instance sharing the same id', async () => {
    const ctx = makeDispatchContext()
    const seeded = new Message({
      id: 'msg-1',
      role: 'user',
      content: 'first',
      createdAt: now,
      updatedAt: now,
    })
    ;(ctx as unknown as { turnMessages: Set<Message> }).turnMessages.add(seeded)
    const updated = new Message({
      id: 'msg-1',
      role: 'user',
      content: 'updated',
      createdAt: now,
      updatedAt: now,
    })
    await ctx.mutateMessage(updated)
    expect(ctx.turnMessages.size).toBe(1)
    expect([...ctx.turnMessages][0]).toBe(updated)
  })

  it('mutateMessage removes EVERY stale same-id instance, not just the first', async () => {
    const ctx = makeDispatchContext()
    const stale1 = new Message({
      id: 'msg-dup',
      role: 'user',
      content: 'stale-1',
      createdAt: now,
      updatedAt: now,
    })
    const stale2 = new Message({
      id: 'msg-dup',
      role: 'user',
      content: 'stale-2',
      createdAt: now,
      updatedAt: now,
    })
    // A pre-existing duplicate is exactly what the OLD add-only store*/mutate* bug could produce;
    // the fix must not stop at removing only the first same-id match it encounters.
    ;(ctx as unknown as { turnMessages: Set<Message> }).turnMessages.add(stale1)
    ;(ctx as unknown as { turnMessages: Set<Message> }).turnMessages.add(stale2)
    const updated = new Message({
      id: 'msg-dup',
      role: 'user',
      content: 'updated',
      createdAt: now,
      updatedAt: now,
    })
    await ctx.mutateMessage(updated)
    expect(ctx.turnMessages.size).toBe(1)
    expect([...ctx.turnMessages][0]).toBe(updated)
  })

  it('mutateMessage preserves the original insertion-order position of the replaced id', async () => {
    const ctx = makeDispatchContext()
    const first = new Message({
      id: 'msg-a',
      role: 'user',
      content: 'a',
      createdAt: now,
      updatedAt: now,
    })
    const second = new Message({
      id: 'msg-b',
      role: 'assistant',
      content: 'b',
      createdAt: now,
      updatedAt: now,
    })
    const third = new Message({
      id: 'msg-c',
      role: 'user',
      content: 'c',
      createdAt: now,
      updatedAt: now,
    })
    const messages = (ctx as unknown as { turnMessages: Set<Message> }).turnMessages
    messages.add(first)
    messages.add(second)
    messages.add(third)
    const updatedSecond = new Message({
      id: 'msg-b',
      role: 'assistant',
      content: 'b-updated',
      createdAt: now,
      updatedAt: now,
    })
    await ctx.mutateMessage(updatedSecond)
    // Several adapters, and this battery's own ordering-guard helpers, use Set iteration order as
    // the deterministic tie-break for same-timestamp primitives — a mutation must not silently
    // relocate the primitive to the end of iteration order just because it went through delete+add.
    expect([...ctx.turnMessages].map((m) => m.id)).toEqual(['msg-a', 'msg-b', 'msg-c'])
    expect([...ctx.turnMessages][1]).toBe(updatedSecond)
  })

  it('mutateThought replaces the prior instance sharing the same id', async () => {
    const ctx = makeDispatchContext()
    const original = new Thought({
      id: 'thought-1',
      content: 'first',
      createdAt: now,
      updatedAt: now,
    })
    ;(ctx as unknown as { turnThoughts: Set<Thought> }).turnThoughts.add(original)
    const updated = new Thought({
      id: 'thought-1',
      content: 'updated',
      createdAt: now,
      updatedAt: now,
    })
    await ctx.mutateThought(updated)
    expect(ctx.turnThoughts.size).toBe(1)
    expect([...ctx.turnThoughts][0]).toBe(updated)
  })

  it('mutateToolCall replaces the prior instance sharing the same id', async () => {
    const ctx = makeDispatchContext()
    const original = new ToolCall({
      id: 'call-1',
      tool: 'sample',
      args: {},
      checksum: 'call-1-checksum',
      isComplete: true,
      isError: false,
      results: new Tokenizable('pending'),
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    })
    ;(ctx as unknown as { turnToolCalls: Set<ToolCall> }).turnToolCalls.add(original)
    const updated = new ToolCall({
      id: 'call-1',
      tool: 'sample',
      args: {},
      checksum: 'call-1-checksum',
      isComplete: true,
      isError: false,
      results: new Tokenizable('done'),
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    })
    await ctx.mutateToolCall(updated)
    expect(ctx.turnToolCalls.size).toBe(1)
    expect([...ctx.turnToolCalls][0]).toBe(updated)
  })

  it('mutateToolCall reconciles #toolCallChecksums when the replacement carries a DIFFERENT checksum', async () => {
    const ctx = makeDispatchContext()
    const original = new ToolCall({
      id: 'call-2',
      tool: 'sample',
      args: { x: 1 },
      checksum: 'checksum-a',
      isComplete: true,
      isError: false,
      results: new Tokenizable('pending'),
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    })
    // Establish the baseline via the real store path so #toolCallChecksums is seeded correctly.
    await ctx.storeToolCall(original)
    expect(ctx.toolCallCount('checksum-a')).toBe(1)

    // A replacement with a DIFFERENT checksum (different tool/args) — an edge case the "checksum
    // is stable across mutation" comment assumed away, but the public mutateToolCall signature
    // accepts any ToolCall, so nothing actually prevents a caller from constructing one.
    const updated = new ToolCall({
      id: 'call-2',
      tool: 'sample',
      args: { x: 2 },
      checksum: 'checksum-b',
      isComplete: true,
      isError: false,
      results: new Tokenizable('done'),
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    })
    await ctx.mutateToolCall(updated)
    expect(ctx.turnToolCalls.size).toBe(1)
    expect([...ctx.turnToolCalls][0]).toBe(updated)
    // The displaced checksum must be decremented to zero (not left stranded at 1 forever), and the
    // replacement's checksum must be credited — otherwise toolCallCount silently lies about both.
    expect(ctx.toolCallCount('checksum-a')).toBe(0)
    expect(ctx.toolCallCount('checksum-b')).toBe(1)
  })

  it('mutateRetrievable replaces the prior instance sharing the same id', async () => {
    const ctx = makeDispatchContext()
    const original = new Retrievable({
      id: 'ret-1',
      content: 'first',
      trustTier: 'first-party',
      source: 'src://ret-1',
      createdAt: now.toISO() as string,
      updatedAt: now.toISO() as string,
    })
    ;(ctx as unknown as { turnRetrievables: Set<Retrievable> }).turnRetrievables.add(original)
    const updated = new Retrievable({
      id: 'ret-1',
      content: 'updated',
      trustTier: 'first-party',
      source: 'src://ret-1',
      createdAt: now.toISO() as string,
      updatedAt: now.toISO() as string,
    })
    await ctx.mutateRetrievable(updated)
    expect(ctx.turnRetrievables.size).toBe(1)
    expect([...ctx.turnRetrievables][0]).toBe(updated)
  })

  it('mutateMemory replaces the prior instance sharing the same id (via fetchMemories seeding)', async () => {
    const original = new Memory({
      id: 'mem-1',
      content: 'first',
      confidence: 0.5,
      importance: 0.5,
      createdAt: now,
      updatedAt: now,
    })
    const ctx = makeDispatchContext()
    ;(ctx as unknown as { turnMemories: Set<Memory> }).turnMemories.add(original)
    const updated = new Memory({
      id: 'mem-1',
      content: 'updated',
      confidence: 0.9,
      importance: 0.9,
      createdAt: now,
      updatedAt: now,
    })
    await ctx.mutateMemory(updated)
    expect(ctx.turnMemories.size).toBe(1)
    expect([...ctx.turnMemories][0]).toBe(updated)
  })
})
