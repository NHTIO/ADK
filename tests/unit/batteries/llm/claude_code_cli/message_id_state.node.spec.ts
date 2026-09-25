import { describe, expect, it, vi } from 'vitest'
import { createSerialQueue } from '../../../../../src/batteries/llm/claude_code_cli/line_queue'
import {
  createMessageIdState,
  claimPartialDeltaId,
  claimCompleteMessageId,
} from '../../../../../src/batteries/llm/claude_code_cli/message_id_state'

// Direct, deterministic unit coverage for the two modules `wrapper.ts` was refactored to use for
// its issue #43 fix-B follow-up (a verification pass caught a race in the original fix-B patch —
// see both modules' own header remarks). No process spawning, no real timers: the whole point of
// extracting this state machine and queue out of `wrapper.ts`'s closure was to make them provable
// synchronously — this file is that proof. The end-to-end race reproduction/fix proof against the
// REAL built wrapper lives in `wrapper.node.spec.ts`'s "message-id race across lines in one stdout
// chunk" test.

describe('claude_code_cli message_id_state', () => {
  it('claimPartialDeltaId assigns a fresh id on the first call and reuses it on subsequent calls for the same in-progress message', () => {
    const state = createMessageIdState()
    const id1 = claimPartialDeltaId(state)
    const id2 = claimPartialDeltaId(state)
    const id3 = claimPartialDeltaId(state)
    expect(id1).toBe('message-0')
    expect(id2).toBe('message-0')
    expect(id3).toBe('message-0')
  })

  it('claimCompleteMessageId reuses the in-progress id, reports hadPriorPartialDelta=true, and resets state for the next message', () => {
    const state = createMessageIdState()
    claimPartialDeltaId(state)
    const { id, hadPriorPartialDelta } = claimCompleteMessageId(state)
    expect(id).toBe('message-0')
    expect(hadPriorPartialDelta).toBe(true)
    // State is reset: the NEXT message mints a fresh, distinct id.
    const next = claimCompleteMessageId(state)
    expect(next.id).toBe('message-1')
    expect(next.hadPriorPartialDelta).toBe(false)
  })

  it('claimCompleteMessageId with no prior partial delta mints its own fresh id and reports hadPriorPartialDelta=false', () => {
    const state = createMessageIdState()
    const { id, hadPriorPartialDelta } = claimCompleteMessageId(state)
    expect(id).toBe('message-0')
    expect(hadPriorPartialDelta).toBe(false)
  })

  it('every claim call is a single synchronous state transition — the id/reset are visible to the very next synchronous call with no intervening tick', () => {
    // This is the crux of the fix: a claim call, and the state transition it performs, must
    // complete in one tick with no `await` in between — so back-to-back SYNCHRONOUS calls (as a
    // caller would make BEFORE its own first `await`) always observe a fully-transitioned state,
    // never a partially-applied one.
    const state = createMessageIdState()
    const first = claimCompleteMessageId(state)
    const second = claimCompleteMessageId(state)
    const third = claimCompleteMessageId(state)
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    expect([first.id, second.id, third.id]).toEqual(['message-0', 'message-1', 'message-2'])
  })
})

describe('claude_code_cli line_queue (createSerialQueue)', () => {
  it('runs enqueued tasks strictly one at a time, in enqueue order, even when an earlier task awaits something that resolves AFTER a later task was enqueued', async () => {
    // Mirrors the exact shape of the bug: task A is `async` and does real work across an `await`
    // that resolves on a LATER tick than when task B gets enqueued. Pre-fix (unawaited dispatch),
    // B's body could start and even finish while A was still suspended. The queue must guarantee
    // A's ENTIRE body (including that await) completes before B's body starts at all.
    const order: string[] = []
    const queue = createSerialQueue(() => {
      throw new Error('queue task should not reject in this test')
    })

    const deferredA = deferred<void>()
    queue.enqueue(async () => {
      order.push('A-start')
      await deferredA.promise
      order.push('A-end')
    })
    queue.enqueue(async () => {
      order.push('B-start')
      order.push('B-end')
    })

    // Give the queue a macrotask tick — if the queue were broken (unawaited dispatch), B's
    // synchronous body would already have run by now, before A resolves.
    await macrotask()
    expect(order).toEqual(['A-start'])

    // Only now does A's await resolve.
    deferredA.resolve()
    await macrotask()

    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
  })

  it('a task that rejects is caught by onError and does not break the chain for tasks enqueued after it', async () => {
    const onError = vi.fn()
    const queue = createSerialQueue(onError)
    const order: string[] = []

    queue.enqueue(async () => {
      order.push('first')
      throw new Error('first task blew up')
    })
    queue.enqueue(async () => {
      order.push('second')
    })
    queue.enqueue(async () => {
      order.push('third')
    })

    await macrotask()

    expect(order).toEqual(['first', 'second', 'third'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('first task blew up')
  })

  it('a task that throws synchronously (before its first await) is still caught by onError, not an unhandled rejection', async () => {
    const onError = vi.fn()
    const queue = createSerialQueue(onError)
    const order: string[] = []

    queue.enqueue(() => {
      order.push('sync-throw')
      throw new Error('synchronous failure')
    })
    queue.enqueue(async () => {
      order.push('after')
    })

    await macrotask()

    expect(order).toEqual(['sync-throw', 'after'])
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

/** Flushes both the microtask queue and one macrotask turn — enough for any depth of `.then()` chaining a serial queue might build up. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A promise plus its externally-callable resolve, for precisely controlling WHEN an async task's await resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
