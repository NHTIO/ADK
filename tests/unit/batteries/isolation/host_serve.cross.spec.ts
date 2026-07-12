import { describe, expect, it } from 'vitest'
import {
  createCrashPolicy,
  createIsolatedService,
  defineIsolatedService,
  E_ISOLATION_READY_TIMEOUT,
  event,
  method,
  serveIsolatedOverPort,
  stream,
  type CrashInfo,
  type IsolatedEmitter,
  type IsolatedImplementationFactory,
  type IsolatedServiceSpec,
  type IsolationCallContext,
  type IsolationReport,
  type IsolationTransport,
  type PortLike,
  type ServeIsolatedOptions,
  type StreamHandle,
} from '@nhtio/adk/batteries/isolation'

/**
 * Full end-to-end integration specs: `createIsolatedService` (host.ts) driving
 * `serveIsolatedOverPort` (serve.ts) through the complete wire-protocol + tiered-codec stack, over
 * linked in-memory fake `PortLike` pairs — never a real Worker/child_process (that's WP2/WP3). Where
 * `protocol.cross.spec.ts` exercises `HostEndpoint`/`GuestEndpoint` directly, these specs exercise the
 * full public API surface a real caller uses.
 */

/** A linked pair of in-memory fake `PortLike`s — everything `A.post()`s arrives (async, next
 *  microtask) at every listener registered via `B.onMessage()`, and vice versa. Same fixture used in
 *  protocol.cross.spec.ts. */
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

/** Real (not microtask-counted) delay — several layers here involve a lazy dynamic `import('@nhtio/
 *  encoder')` the first time any argument is encoded, so a fixed microtask-tick count is fragile;
 *  a short real timer reliably flushes everything in flight. */
const wait = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A host-side `IsolationTransport` whose `connect()` spawns a FRESH linked port pair and serves
 *  `spec`/`factory` over the guest side of it via `serveIsolatedOverPort` — simulating a real
 *  Worker/child_process spawn closely enough for WP1's protocol-substrate-level integration tests.
 *  `recycle()`/manual `dispose()` naturally exercise this transport's `terminate()` + a fresh
 *  `connect()`. `crash()` lets a test simulate `IsolationTransport.onCrash` firing. */
interface TestTransport extends IsolationTransport {
  crash: (info: CrashInfo) => void
  connectCount: () => number
  terminateCount: () => number
}

const createLinkedTransport = <S extends IsolatedServiceSpec>(
  spec: S,
  factory: IsolatedImplementationFactory<S>,
  serveOptions?: ServeIsolatedOptions
): TestTransport => {
  let connectCount = 0
  let terminateCount = 0
  const crashHandlers = new Set<(info: CrashInfo) => void>()
  let currentStop: (() => void) | undefined

  const connect = async (): Promise<PortLike> => {
    connectCount += 1
    const [hostPort, guestPort] = createLinkedPorts()
    const { stop } = serveIsolatedOverPort(spec, factory, guestPort, serveOptions)
    currentStop = stop
    return hostPort
  }
  const terminate = async (): Promise<void> => {
    terminateCount += 1
    currentStop?.()
  }
  const onCrash = (fn: (info: CrashInfo) => void): (() => void) => {
    crashHandlers.add(fn)
    return () => crashHandlers.delete(fn)
  }

  return {
    connect,
    terminate,
    onCrash,
    crash: (info) => {
      for (const fn of crashHandlers) fn(info)
    },
    connectCount: () => connectCount,
    terminateCount: () => terminateCount,
  }
}

/** A transport whose guest never signals `ready` — for exercising `E_ISOLATION_READY_TIMEOUT`. */
const createNeverReadyTransport = (): IsolationTransport => ({
  connect: async () => ({
    post: () => {},
    onMessage: () => () => {},
  }),
  terminate: async () => {},
  onCrash: () => () => {},
})

describe('createIsolatedService() + serveIsolatedOverPort() — call/result round-trip', () => {
  it('round-trips a synchronous request/response call through the full stack', async () => {
    const spec = defineIsolatedService({
      name: 'calc',
      methods: { add: method<[number, number], number>() },
    })
    const transport = createLinkedTransport(spec, () => ({ add: (a: number, b: number) => a + b }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    await expect(service.api.add(2, 3)).resolves.toBe(5)
    await service.dispose()
  })

  it('supports an async guest implementation', async () => {
    const spec = defineIsolatedService({
      name: 'calc-async',
      methods: { addAsync: method<[number, number], number>() },
    })
    const transport = createLinkedTransport(spec, () => ({
      addAsync: async (a: number, b: number) => a + b,
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    await expect(service.api.addAsync(4, 5)).resolves.toBe(9)
    await service.dispose()
  })
})

describe('error crossing', () => {
  it('crosses a synchronously thrown Error back as a rejected promise, message preserved', async () => {
    const spec = defineIsolatedService({ name: 'fails', methods: { boom: method<[], void>() } })
    const transport = createLinkedTransport(spec, () => ({
      boom: () => {
        throw new Error('kaboom')
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    await expect(service.api.boom()).rejects.toThrow('kaboom')
    await service.dispose()
  })

  it('crosses a rejected promise the same way as a synchronous throw', async () => {
    const spec = defineIsolatedService({
      name: 'fails-async',
      methods: { boomAsync: method<[], void>() },
    })
    const transport = createLinkedTransport(spec, () => ({
      boomAsync: async () => {
        throw new Error('async kaboom')
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    await expect(service.api.boomAsync()).rejects.toThrow('async kaboom')
    await service.dispose()
  })

  it('crosses a bare Error passed as a method ARGUMENT (auto-tier exotic escalation)', async () => {
    const spec = defineIsolatedService({
      name: 'error-arg-svc',
      methods: { describeError: method<[Error], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({
      describeError: (err: Error) => `${err.name}: ${err.message}`,
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const result = await service.api.describeError(new TypeError('bad'))
    // Per codec.cross.spec.ts's confirmed finding: the real @nhtio/encoder's default (non-registered)
    // Error round-trip loses subclass/name fidelity — the guest sees a generic Error named 'Error', not
    // 'TypeError'. Documenting that consequence at the full integration level too.
    expect(result).toBe('Error: bad')
    await service.dispose()
  })
})

describe('events', () => {
  it('fans out an emitted event to a subscribed host-side listener, and stops after unsubscribe', async () => {
    const spec = defineIsolatedService({ name: 'ticker', events: { tick: event<number>() } })
    let capturedEmit: IsolatedEmitter<typeof spec> | undefined
    const transport = createLinkedTransport(spec, ({ emit }) => {
      capturedEmit = emit
      return {}
    })
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const received: number[] = []
    const unsubscribe = service.on('tick', (n) => received.push(n))
    capturedEmit!.tick(7)
    await wait()
    expect(received).toEqual([7])
    unsubscribe()
    capturedEmit!.tick(8)
    await wait()
    expect(received).toEqual([7]) // unsubscribed — no further delivery
    await service.dispose()
  })
})

describe('streams', () => {
  it('fans out deltas in order and closes the ReadableStream on end', async () => {
    const spec = defineIsolatedService({
      name: 'ticks-svc',
      streams: { ticks: stream<[number], number>() },
    })
    const transport = createLinkedTransport(spec, () => ({
      ticks: async function* (count: number) {
        for (let i = 0; i < count; i++) yield i
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const reader = service.api.ticks(3).getReader()
    const deltas: number[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      deltas.push(value)
    }
    expect(deltas).toEqual([0, 1, 2])
    await service.dispose()
  })

  it('a synchronous throw inside the guest stream factory surfaces as a stream error', async () => {
    const spec = defineIsolatedService({
      name: 'boom-stream-svc',
      streams: { boomStream: stream<[], void>() },
    })
    const transport = createLinkedTransport(spec, () => ({
      boomStream: () => {
        throw new Error('stream setup exploded')
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const reader = service.api.boomStream().getReader()
    await expect(reader.read()).rejects.toThrow('stream setup exploded')
    await service.dispose()
  })

  it('cancelling the host ReadableStream stops an async-generator guest via iterator.return()', async () => {
    const spec = defineIsolatedService({
      name: 'cancellable-stream-svc',
      streams: { count: stream<[], number>() },
    })
    let ranFinally = false
    const transport = createLinkedTransport(spec, () => ({
      count: async function* (_handle: StreamHandle) {
        try {
          let i = 0
          while (true) {
            yield i
            i += 1
            await wait(5)
          }
        } finally {
          ranFinally = true
        }
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const reader = service.api.count().getReader()
    await reader.read() // ensure the stream is open and has produced at least one delta
    await reader.cancel('client done')
    await wait(30)
    expect(ranFinally).toBe(true)
    await service.dispose()
  })

  it('cancelling the host ReadableStream aborts the guest StreamHandle.signal for a ReadableStream-returning guest', async () => {
    const spec = defineIsolatedService({
      name: 'rs-stream-svc',
      streams: { count2: stream<[], number>() },
    })
    let capturedSignal: AbortSignal | undefined
    const transport = createLinkedTransport(spec, () => ({
      count2: (handle: StreamHandle) => {
        capturedSignal = handle.signal
        return new ReadableStream<number>({
          start: (controller) => controller.enqueue(1),
        })
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const reader = service.api.count2().getReader()
    await reader.read()
    await reader.cancel()
    await wait(30)
    expect(capturedSignal?.aborted).toBe(true)
    await service.dispose()
  })
})

describe('method abort (trailing AbortSignal)', () => {
  it('forwards abort to the guest ctx.signal ONLY when the descriptor declared { signal: true }', async () => {
    const spec = defineIsolatedService({
      name: 'abortable',
      methods: { cancellable: method<[], string>({ signal: true }) },
    })
    let capturedSignal: AbortSignal | undefined
    const transport = createLinkedTransport(spec, () => ({
      cancellable: (ctx?: IsolationCallContext) =>
        new Promise<string>((_resolve, reject) => {
          capturedSignal = ctx!.signal
          ctx!.signal.addEventListener('abort', () => reject(new Error('cancelled by host')))
        }),
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const controller = new AbortController()
    const pending = service.api.cancellable(controller.signal)
    await wait()
    expect(capturedSignal?.aborted).toBe(false)
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled by host')
    await service.dispose()
  })

  it('a trailing signal is accepted on the facade uniformly but NOT forwarded when the descriptor did not opt in', async () => {
    const spec = defineIsolatedService({
      name: 'not-abortable',
      methods: { plain: method<[], string>() },
    })
    let argsSeen: unknown[] = []
    const transport = createLinkedTransport(spec, () => ({
      plain: (...args: unknown[]) => {
        argsSeen = args
        return 'ok'
      },
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const controller = new AbortController()
    await expect(service.api.plain(controller.signal)).resolves.toBe('ok')
    expect(argsSeen).toEqual([]) // the signal was stripped — never forwarded as a ctx param
    await service.dispose()
  })
})

describe('ready-timeout', () => {
  it('rejects a call with E_ISOLATION_READY_TIMEOUT when the guest never signals ready', async () => {
    const spec = defineIsolatedService({
      name: 'never-ready',
      methods: { ping: method<[], string>() },
    })
    const transport = createNeverReadyTransport()
    const service = createIsolatedService(spec, transport, { readyTimeoutMs: 20 })
    await expect(service.api.ping()).rejects.toThrow(E_ISOLATION_READY_TIMEOUT)
  })
})

describe('dispose()', () => {
  it('graceful dispose (guest already ready) reports forced:false and terminates the transport', async () => {
    const spec = defineIsolatedService({
      name: 'disposable',
      methods: { ping: method<[], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({ ping: () => 'pong' }))
    const reports: IsolationReport[] = []
    const service = createIsolatedService(spec, transport, {
      disposeGraceMs: 10,
      onDispose: (r) => reports.push(r),
    })
    await service.api.ping() // ensures ready
    await service.dispose()
    expect(transport.terminateCount()).toBe(1)
    const done = reports.find((r) => r.phase === 'dispose:done')
    expect(done?.forced).toBe(false)
  })

  it('dispose called before the guest has signaled ready is forced (forced:true)', async () => {
    const spec = defineIsolatedService({
      name: 'disposable-not-ready',
      methods: { ping: method<[], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({ ping: () => 'pong' }))
    const reports: IsolationReport[] = []
    const service = createIsolatedService(spec, transport, { onDispose: (r) => reports.push(r) })
    expect(service.state).toBe('starting') // captured before the guest's ready envelope can arrive
    await service.dispose()
    const done = reports.find((r) => r.phase === 'dispose:done')
    expect(done?.forced).toBe(true)
  })

  it('is idempotent — a second dispose() is a no-op', async () => {
    const spec = defineIsolatedService({
      name: 'disposable-twice',
      methods: { ping: method<[], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({ ping: () => 'pong' }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    await service.api.ping()
    await service.dispose()
    await expect(service.dispose()).resolves.toBeUndefined()
    expect(transport.terminateCount()).toBe(1) // NOT called a second time
  })
})

describe('recycle()', () => {
  it('rejects in-flight calls as terminated, then a fresh call after recycle succeeds against a NEW guest', async () => {
    const spec = defineIsolatedService({
      name: 'recyclable',
      methods: { hang: method<[], string>(), ping: method<[], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({
      hang: () => new Promise<string>(() => {}), // never resolves on its own
      ping: () => 'pong',
    }))
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    await service.api.ping() // ensure ready
    const pending = service.api.hang()
    await wait()
    const recyclePromise = service.recycle()
    await expect(pending).rejects.toThrow('was terminated')
    await recyclePromise
    await expect(service.api.ping()).resolves.toBe('pong')
    expect(transport.connectCount()).toBe(2)
    await service.dispose()
  })

  it('event subscriptions survive recycle — the same listener is fed by the NEW guest instance', async () => {
    const spec = defineIsolatedService({
      name: 'recyclable-events',
      events: { tick: event<number>() },
    })
    const emits: IsolatedEmitter<typeof spec>[] = []
    const transport = createLinkedTransport(spec, ({ emit }) => {
      emits.push(emit)
      return {}
    })
    const service = createIsolatedService(spec, transport, { disposeGraceMs: 10 })
    const received: number[] = []
    service.on('tick', (n) => received.push(n))
    emits[0].tick(1)
    await wait()
    expect(received).toEqual([1])
    await service.recycle()
    expect(emits.length).toBe(2) // a new guest instance was spawned
    emits[1].tick(2)
    await wait()
    expect(received).toEqual([1, 2]) // same subscription, now fed by the new guest
    await service.dispose()
  })
})

describe('crash handling + autoRespawn', () => {
  it('a transport-reported crash rejects in-flight calls, flips state to crashed, and reports an accurate inFlight count', async () => {
    const spec = defineIsolatedService({ name: 'crashy', methods: { hang: method<[], string>() } })
    const transport = createLinkedTransport(spec, () => ({
      hang: () => new Promise<string>(() => {}),
    }))
    const reports: IsolationReport[] = []
    const service = createIsolatedService(spec, transport, {
      onCrashReport: (r) => reports.push(r),
    })
    const pending = service.api.hang()
    await wait()
    const crashInfos: CrashInfo[] = []
    service.onCrash((info) => crashInfos.push(info))
    transport.crash({ reason: 'guest process died', code: 1, signal: null })
    await expect(pending).rejects.toThrow(/crashed/)
    expect(service.state).toBe('crashed')
    expect(crashInfos).toEqual([{ reason: 'guest process died', code: 1, signal: null }])
    const crashReport = reports.find((r) => r.phase === 'crash')
    expect(crashReport?.inFlight).toBe(1)
    await service.dispose()
  })

  it('autoRespawn: a "respawn" verdict triggers an automatic recycle()', async () => {
    const spec = defineIsolatedService({
      name: 'auto-respawn-svc',
      methods: { ping: method<[], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({ ping: () => 'pong' }))
    const policy = createCrashPolicy({ maxCrashes: 5 })
    const service = createIsolatedService(spec, transport, {
      autoRespawn: { policy },
      disposeGraceMs: 10,
    })
    await service.api.ping()
    expect(transport.connectCount()).toBe(1)
    transport.crash({ reason: 'transient blip' })
    await wait(40)
    expect(transport.connectCount()).toBe(2) // recycled automatically
    expect(service.state).toBe('ready')
    await expect(service.api.ping()).resolves.toBe('pong')
    await service.dispose()
  })

  it('autoRespawn: a "giveUp" verdict leaves the service crashed (no automatic recycle)', async () => {
    const spec = defineIsolatedService({
      name: 'give-up-svc',
      methods: { ping: method<[], string>() },
    })
    const transport = createLinkedTransport(spec, () => ({ ping: () => 'pong' }))
    const policy = createCrashPolicy({ maxCrashes: 1 }) // the very first crash already gives up
    const service = createIsolatedService(spec, transport, {
      autoRespawn: { policy },
      disposeGraceMs: 10,
    })
    await service.api.ping()
    transport.crash({ reason: 'fatal' })
    await wait(40)
    expect(transport.connectCount()).toBe(1) // no recycle attempted
    expect(service.state).toBe('crashed')
    await expect(service.api.ping()).rejects.toThrow()
    await service.dispose()
  })
})
