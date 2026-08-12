import { describe, expect, it } from 'vitest'
import { HostEndpoint } from '../../../../src/batteries/isolation/protocol'
import {
  defineIsolatedService,
  method,
  serveIsolatedOverPort,
  type PortLike,
} from '@nhtio/adk/batteries/isolation'

/**
 * `serveIsolatedOverPort`'s two lifecycle edges: a factory that hostcalls immediately, and a `stop()`
 * that must not leave a guest awaiting a capability result forever.
 */
const pair = (): [PortLike, PortLike] => {
  const a = new Set<(m: unknown) => void>()
  const b = new Set<(m: unknown) => void>()
  return [
    {
      post: (m) => queueMicrotask(() => b.forEach((f) => f(m))),
      onMessage: (f) => (a.add(f), () => a.delete(f)),
    },
    {
      post: (m) => queueMicrotask(() => a.forEach((f) => f(m))),
      onMessage: (f) => (b.add(f), () => b.delete(f)),
    },
  ]
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5))

describe('serveIsolatedOverPort lifecycle', () => {
  it('gives the factory a usable `hostcall` even when it calls it synchronously', async () => {
    // The factory runs BEFORE the endpoint is constructed, so a closure that reads the binding eagerly
    // observes it unassigned. A factory calling its capability synchronously — to fetch config it needs
    // in order to build the implementation — is an ordinary thing to do, and it must not throw a
    // TDZ/undefined error instead of producing a service.
    const [hostPort, guestPort] = pair()
    const spec = defineIsolatedService({
      name: 'lifecycle-sync',
      methods: { ping: method<[], string>() },
    })
    const host = new HostEndpoint(hostPort)

    let thrown: unknown
    let served: { stop: () => void } | undefined
    try {
      served = serveIsolatedOverPort(
        spec,
        ({ hostcall }) => {
          // Deliberately synchronous: no await before the call. The rejection handler is attached here
          // because `stop()` legitimately terminates this call — without it the (correct) rejection
          // surfaces as an unhandled rejection and fails the run for the wrong reason.
          hostcall('config', []).catch(() => undefined)
          return { ping: () => 'pong' }
        },
        guestPort
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeUndefined()
    expect(served).toBeDefined()

    served?.stop()
    host.terminate('done')
    await flush()
  })

  it('rejects a pending hostcall when the service is stopped', async () => {
    // A hostcall's promise lives in the endpoint's pending map. If `stop()` only cancels open streams,
    // that promise never settles and whatever awaited it hangs for the life of the process.
    const [hostPort, guestPort] = pair()
    const spec = defineIsolatedService({
      name: 'lifecycle-stop',
      methods: { ping: method<[], string>() },
    })
    // A host that receives the hostcall and deliberately never answers it.
    const host = new HostEndpoint(
      hostPort,
      {},
      { handlers: new Map([['never', () => new Promise<never>(() => {})]]) }
    )

    // The hostcall is issued FROM THE FACTORY, synchronously, so it is registered in the endpoint's
    // pending map the moment `serveIsolatedOverPort` returns.
    //
    // Deliberately NOT driven through a `ping` round-trip: the host queues calls until the guest posts
    // `ready`, and `serve.ts` posts that only after awaiting the optional-encoder probe — a dynamic
    // import that is fast in node and slow in a browser. Depending on it made this test pass locally and
    // fail under firefox on a timing budget that has nothing to do with the property under test.
    let pending: Promise<unknown> | undefined
    const served = serveIsolatedOverPort(
      spec,
      ({ hostcall }) => {
        pending = hostcall('never', [])
        return { ping: () => 'pong' }
      },
      guestPort
    )

    expect(pending).toBeDefined()

    // Observe settlement rather than awaiting it: an unsettled promise would hang the test instead of
    // failing it, which would make this assertion useless as a regression guard.
    let settled = false
    void pending?.then(
      () => (settled = true),
      () => (settled = true)
    )

    served.stop()
    await flush()

    expect(settled).toBe(true)
    await expect(pending).rejects.toThrow()

    host.terminate('done')
  })
})
