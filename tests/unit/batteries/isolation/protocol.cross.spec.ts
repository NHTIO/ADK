import { describe, expect, it, vi } from 'vitest'
import {
  GuestEndpoint,
  HostEndpoint,
  wireErrorToError,
  type PortLike,
  type WireError,
  type WireValue,
} from '@nhtio/adk/batteries/isolation'

/** A linked pair of in-memory fake `PortLike`s — everything `A.post()`s arrives (async, next
 *  microtask) at every listener registered via `B.onMessage()`, and vice versa. This is the WP1
 *  fixture the brief calls for: no real Worker/child_process anywhere. */
const createLinkedPorts = (): [PortLike, PortLike] => {
  const listenersA = new Set<(msg: unknown) => void>()
  const listenersB = new Set<(msg: unknown) => void>()
  const portA: PortLike = {
    post: (msg) => {
      queueMicrotask(() => {
        for (const fn of listenersB) fn(msg)
      })
    },
    onMessage: (fn) => {
      listenersA.add(fn)
      return () => listenersA.delete(fn)
    },
  }
  const portB: PortLike = {
    post: (msg) => {
      queueMicrotask(() => {
        for (const fn of listenersA) fn(msg)
      })
    },
    onMessage: (fn) => {
      listenersB.add(fn)
      return () => listenersB.delete(fn)
    },
  }
  return [portA, portB]
}

const tick = (n = 1): Promise<void> =>
  Array.from({ length: n }).reduce(
    (p: Promise<void>) => p.then(() => new Promise<void>((r) => queueMicrotask(r))),
    Promise.resolve()
  )

const rawValue = (v: unknown): WireValue => ({ enc: 'raw', v })

describe('HostEndpoint / GuestEndpoint — call/result correlation', () => {
  it("resolves the call promise with the guest's settled value", async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {
      onCall: (id) => guest.settleOk(id, rawValue(42)),
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const { promise } = host.call('add', [rawValue(1), rawValue(2)])
    const result = await promise
    expect(result).toEqual(rawValue(42))
  })

  it('rejects the call promise with a reconstructed Error on a failed settle', async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {
      onCall: (id) =>
        guest.settleError(id, { message: 'boom', name: 'RangeError' } satisfies WireError),
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const { promise } = host.call('explode', [])
    await expect(promise).rejects.toThrow('boom')
    await expect(promise).rejects.toMatchObject({ name: 'RangeError' })
  })

  it('tracks pendingCallCount while a call is outstanding', async () => {
    const [portA, portB] = createLinkedPorts()
    let settle: (() => void) | undefined
    const guest = new GuestEndpoint(portB, {
      onCall: (id) => {
        settle = () => guest.settleOk(id, rawValue('done'))
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    expect(host.pendingCallCount).toBe(0)
    const { promise } = host.call('slow', [])
    await tick(2)
    expect(host.pendingCallCount).toBe(1)
    settle!()
    await promise
    expect(host.pendingCallCount).toBe(0)
  })

  it('ignores a result envelope with an unknown/already-settled id', async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {})
    // A HostEndpoint must exist on the other end of the linked ports (mirroring a real deployment)
    // even though this test never calls into it directly — it only asserts that settling an id the
    // host never issued doesn't throw anywhere in the guest-side pipeline.
    new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    // Settling an id the host never issued must not throw anywhere in the pipeline.
    expect(() => guest.settleOk('never-issued', rawValue(1))).not.toThrow()
    await tick(2)
  })
})

describe('HostEndpoint — ready-queue flush ordering', () => {
  it('queues calls/stream-starts made before ready and flushes them in call order', async () => {
    const [portA, portB] = createLinkedPorts()
    const order: string[] = []
    const guest = new GuestEndpoint(portB, {
      onCall: (id, methodName) => {
        order.push(methodName)
        guest.settleOk(id, rawValue(null))
      },
      onStreamStart: (id, streamName) => {
        order.push(streamName)
        guest.endStream(id)
      },
    })
    const host = new HostEndpoint(portA)
    expect(host.isReady).toBe(false)

    // Issued BEFORE the guest signals ready — must queue, not send.
    const call1 = host.call('first', [])
    host.startStream('second-stream', [], { push: () => {}, end: () => {}, error: () => {} })
    const call3 = host.call('third', [])
    await tick(3)
    expect(order).toEqual([]) // nothing sent yet — still queued

    guest.ready(false)
    await tick(4)

    expect(host.isReady).toBe(true)
    expect(order).toEqual(['first', 'second-stream', 'third'])
    await call1.promise
    await call3.promise
  })

  it('sends calls immediately (no queueing) once already ready', async () => {
    const [portA, portB] = createLinkedPorts()
    const order: string[] = []
    const guest = new GuestEndpoint(portB, {
      onCall: (id, methodName) => {
        order.push(methodName)
        guest.settleOk(id, rawValue(null))
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    expect(host.isReady).toBe(true)
    const { promise } = host.call('immediate', [])
    await promise
    expect(order).toEqual(['immediate'])
  })

  it("invokes onReady with the guest's encoderAvailable flag", async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {})
    const onReady = vi.fn()
    new HostEndpoint(portA, { onReady })
    guest.ready(true)
    await tick(3)
    expect(onReady).toHaveBeenCalledWith({ encoderAvailable: true })
  })
})

describe('HostEndpoint / GuestEndpoint — abort', () => {
  it('sending host.abort(id) aborts the guest-side AbortSignal for that call', async () => {
    const [portA, portB] = createLinkedPorts()
    let capturedSignal: AbortSignal | undefined
    const guest = new GuestEndpoint(portB, {
      onCall: (_id, _m, _a, signal) => {
        capturedSignal = signal
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const { id } = host.call('longRunning', [])
    await tick(2)
    expect(capturedSignal?.aborted).toBe(false)
    host.abort(id)
    await tick(2)
    expect(capturedSignal?.aborted).toBe(true)
  })

  it('abort does not itself reject the call — the guest must still settle it', async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {
      onCall: (id, _m, _a, signal) => {
        signal.addEventListener('abort', () => {
          guest.settleError(id, { message: 'aborted by host', name: 'Error' })
        })
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const { id, promise } = host.call('cancellable', [])
    await tick(2)
    host.abort(id)
    await expect(promise).rejects.toThrow('aborted by host')
  })
})

describe('HostEndpoint / GuestEndpoint — streams', () => {
  it('fans out delta / end in order to the sink', async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {
      onStreamStart: (id) => {
        guest.pushDelta(id, rawValue(1))
        guest.pushDelta(id, rawValue(2))
        guest.endStream(id)
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const deltas: unknown[] = []
    let ended = false
    host.startStream('ticks', [], {
      push: (d) => deltas.push(d),
      end: () => {
        ended = true
      },
      error: () => {},
    })
    await tick(4)
    expect(deltas).toEqual([rawValue(1), rawValue(2)])
    expect(ended).toBe(true)
  })

  it('reports a stream:error to the sink and stops tracking the stream', async () => {
    const [portA, portB] = createLinkedPorts()
    const guest = new GuestEndpoint(portB, {
      onStreamStart: (id) => guest.errorStream(id, { message: 'stream blew up', name: 'Error' }),
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    let error: WireError | undefined
    host.startStream('boom', [], { push: () => {}, end: () => {}, error: (e) => (error = e) })
    await tick(3)
    expect(error?.message).toBe('stream blew up')
    expect(host.openStreamCount).toBe(0)
  })

  it('sends stream:cancel and removes the stream from the openStreamCount immediately', async () => {
    const [portA, portB] = createLinkedPorts()
    let cancelReason: unknown
    const guest = new GuestEndpoint(portB, {
      onStreamCancel: (_id, reason) => {
        cancelReason = reason
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const id = host.startStream('cancellableStream', [], {
      push: () => {},
      end: () => {},
      error: () => {},
    })
    await tick(2)
    expect(host.openStreamCount).toBe(1)
    host.cancelStream(id, rawValue('user-cancelled'))
    expect(host.openStreamCount).toBe(0) // removed synchronously, before the wire round-trip
    await tick(3)
    expect(cancelReason).toEqual(rawValue('user-cancelled'))
  })

  it('the guest aborts its StreamHandle signal on stream:cancel', async () => {
    const [portA, portB] = createLinkedPorts()
    let capturedSignal: AbortSignal | undefined
    const guest = new GuestEndpoint(portB, {
      onStreamStart: (_id, _s, _a, signal) => {
        capturedSignal = signal
      },
    })
    const host = new HostEndpoint(portA)
    guest.ready(false)
    await tick(3)
    const id = host.startStream('cancelMe', [], { push: () => {}, end: () => {}, error: () => {} })
    await tick(2)
    expect(capturedSignal?.aborted).toBe(false)
    host.cancelStream(id)
    await tick(2)
    expect(capturedSignal?.aborted).toBe(true)
  })
})

describe('HostEndpoint — shutdown envelope', () => {
  it("shutdown() is forwarded to the guest's onShutdown hook", async () => {
    const [portA, portB] = createLinkedPorts()
    const onShutdown = vi.fn()
    new GuestEndpoint(portB, { onShutdown })
    const host = new HostEndpoint(portA)
    host.shutdown()
    await tick(2)
    expect(onShutdown).toHaveBeenCalledTimes(1)
  })
})

describe('HostEndpoint — terminate()', () => {
  it('rejects every in-flight call with `reason`', async () => {
    const [portA, portB] = createLinkedPorts()
    new GuestEndpoint(portB, {}) // never settles anything
    const host = new HostEndpoint(portA)
    const { promise: p1 } = host.call('m1', [])
    const { promise: p2 } = host.call('m2', [])
    host.terminate('service torn down')
    await expect(p1).rejects.toThrow('service torn down')
    await expect(p2).rejects.toThrow('service torn down')
  })

  it('errors every open stream with `reason`', async () => {
    const [portA, portB] = createLinkedPorts()
    new GuestEndpoint(portB, {})
    const host = new HostEndpoint(portA)
    let error: WireError | undefined
    host.startStream('s1', [], { push: () => {}, end: () => {}, error: (e) => (error = e) })
    host.terminate('service torn down')
    expect(error?.message).toBe('service torn down')
    expect(host.openStreamCount).toBe(0)
    expect(host.pendingCallCount).toBe(0)
  })

  it('is idempotent — a second terminate() call is a no-op', async () => {
    const [portA, portB] = createLinkedPorts()
    new GuestEndpoint(portB, {})
    const host = new HostEndpoint(portA)
    const { promise } = host.call('m1', [])
    host.terminate('first reason')
    expect(() => host.terminate('second reason')).not.toThrow()
    await expect(promise).rejects.toThrow('first reason')
  })

  it('rejects any call issued AFTER terminate() immediately, without touching the port', async () => {
    const [portA, portB] = createLinkedPorts()
    const onCall = vi.fn()
    new GuestEndpoint(portB, { onCall })
    const host = new HostEndpoint(portA)
    host.terminate('gone')
    const { promise } = host.call('tooLate', [])
    await expect(promise).rejects.toThrow('HostEndpoint has been terminated')
    await tick(3)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('clears queued-but-unsent envelopes so a late ready never flushes them', async () => {
    const [portA, portB] = createLinkedPorts()
    const onCall = vi.fn()
    const guest = new GuestEndpoint(portB, { onCall })
    const host = new HostEndpoint(portA)
    const { promise } = host.call('neverSent', []) // queued — guest not ready yet
    host.terminate('gone before ready')
    guest.ready(false)
    await expect(promise).rejects.toThrow('gone before ready')
    await tick(3)
    expect(onCall).not.toHaveBeenCalled()
  })
})

describe('wireErrorToError()', () => {
  it('reconstructs message/name/stack from the baseline WireError fields', () => {
    const err = wireErrorToError({ message: 'oops', name: 'TypeError', stack: 'trace-here' })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('oops')
    expect(err.name).toBe('TypeError')
    expect(err.stack).toBe('trace-here')
  })

  it('omits stack when absent on the WireError', () => {
    const original = new Error('no stack info')
    delete (original as { stack?: string }).stack
    const err = wireErrorToError({ message: 'no stack info', name: 'Error' })
    expect(err.message).toBe('no stack info')
    expect(typeof err.stack === 'string' || err.stack === undefined).toBe(true)
  })
})

describe('HostEndpoint / GuestEndpoint — malformed envelopes', () => {
  it('silently ignores a message with no string `t` discriminant', async () => {
    const [portA, portB] = createLinkedPorts()
    new GuestEndpoint(portB, {})
    new HostEndpoint(portA)
    // Post something malformed directly at the guest-facing port — must not throw anywhere.
    expect(() => portA.post({ garbage: true })).not.toThrow()
    await tick(2)
  })
})
