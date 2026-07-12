/// <reference lib="dom" />

import { afterEach, describe, expect, it } from 'vitest'
import { browserEchoSpec } from '../../../_fixtures/isolation/browser_echo_spec'
import {
  createWorkerTransport,
  E_ISOLATED_CRASHED,
  E_ISOLATION_UNSUPPORTED_ENV,
  spawnIsolated,
  transfer,
  type BrowserWorker,
  type IsolatedService,
  type SpawnIsolatedOptions,
  type WorkerResolver,
} from '@nhtio/adk/batteries/isolation'

/**
 * End-to-end specs for the browser Worker transport (WP2): a REAL `Worker` (not a linked in-memory fake
 * port — that's WP1's `host_serve.cross.spec.ts`), driven through the full public
 * `spawnIsolated`/`createWorkerTransport` API against a real `serveIsolatedOverPort`-backed guest.
 *
 * @remarks
 * The guest fixtures are served PREBUNDLED (esbuild-wasm, single flat ESM file) by the
 * `adk:isolation-worker-prebundle` dev-server middleware in `vite.config.mts` at
 * `/@isolation-worker/<fixture>.js`, rather than letting the Vite dev server serve the raw
 * un-bundled `.ts` module graph to `new Worker(...)`. WebKit's worker module loader stack-overflows
 * (`RangeError: Maximum call stack size exceeded`) on the deep un-bundled `@nhtio/adk` ESM graph
 * before a single fixture line runs (chromium/firefox load the identical graph fine) — see the
 * middleware's doc comment for the empirical bisect. This is the browser analogue of WP3's
 * esbuild-wasm prebundle for `child_process.fork()`.
 */

const workerUrl = new URL('/@isolation-worker/browser_echo_worker.js', import.meta.url)
const crashWorkerUrl = new URL('/@isolation-worker/browser_crash_worker.js', import.meta.url)

const services: IsolatedService<typeof browserEchoSpec>[] = []

const spawnEcho = (
  overrides: Partial<SpawnIsolatedOptions> = {}
): IsolatedService<typeof browserEchoSpec> => {
  const service = spawnIsolated(browserEchoSpec, {
    worker: workerUrl,
    workerOptions: { type: 'module' },
    disposeGraceMs: 10,
    ...overrides,
  })
  services.push(service)
  return service
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()))
})

describe('spawnIsolated() / createWorkerTransport() — real Worker round-trip', () => {
  it('round-trips a method call through a real Worker', async () => {
    const service = spawnEcho()
    await expect(service.api.echo('hello')).resolves.toBe('hello')
  })

  it('round-trips a structured value (fidelity across a real postMessage boundary)', async () => {
    const service = spawnEcho()
    const payload = { a: 1, b: [1, 2, 3], c: { nested: true } }
    await expect(service.api.echo(payload)).resolves.toEqual(payload)
  })

  it('crosses a thrown Error back as a rejected promise', async () => {
    const service = spawnEcho()
    await expect(service.api.fail('boom')).rejects.toThrow('boom')
  })

  it('fans out stream deltas in order and closes the ReadableStream on end', async () => {
    const service = spawnEcho()
    const reader = service.api.counter(3).getReader()
    const deltas: number[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      deltas.push(value)
    }
    expect(deltas).toEqual([0, 1, 2])
  })

  it('fans out an emitted event to a subscribed host-side listener', async () => {
    const service = spawnEcho()
    const received: number[] = []
    const unsubscribe = service.on('progress', (n) => received.push(n))
    const reader = service.api.counter(3).getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    expect(received).toEqual([0, 1, 2])
    unsubscribe()
  })

  it('forwards abort to the guest ctx.signal for a { signal: true } method', async () => {
    const service = spawnEcho()
    const controller = new AbortController()
    const pending = service.api.hang(controller.signal)
    // Give the guest a moment to actually receive the call before aborting.
    await new Promise((resolve) => setTimeout(resolve, 25))
    controller.abort()
    await expect(pending).rejects.toThrow('hang aborted')
  })
})

describe('crash surfacing', () => {
  it(
    'a guest that throws at top level fires onCrash, marks the service crashed, and rejects calls',
    { timeout: 120_000 },
    async () => {
      const service = spawnIsolated(browserEchoSpec, {
        worker: crashWorkerUrl,
        workerOptions: { type: 'module' },
        // Generous on purpose: this bound only needs to be an upper limit the crash beats. Under full-
        // suite parallelism (three browsers + the vite dev server transforming/prebundling), worker
        // load-then-crash can take well over 2s — a tight timeout makes the ready-timeout win the race
        // and the test flake with E_ISOLATION_READY_TIMEOUT instead of the crash it's asserting.
        readyTimeoutMs: 60_000,
        disposeGraceMs: 10,
      })
      services.push(service)
      const crashInfos: unknown[] = []
      service.onCrash((info) => crashInfos.push(info))
      // The guest crashes BEFORE ever signalling ready: the crash fans out to onCrash, flips `state` to
      // 'crashed', and the connect gate observes it immediately — the in-flight call rejects with
      // E_ISOLATED_CRASHED right away rather than waiting out the ready timeout.
      await expect(service.api.echo('never arrives')).rejects.toThrow(E_ISOLATED_CRASHED)
      expect(crashInfos.length).toBeGreaterThan(0)
      expect(service.state).toBe('crashed')
    }
  )
})

describe('spawn failure', () => {
  it('a bogus worker URL crashes the connection rather than hanging forever', async () => {
    const bogusUrl = new URL('./this-file-does-not-exist-at-all.ts', import.meta.url)
    const service = spawnIsolated(browserEchoSpec, {
      worker: bogusUrl,
      workerOptions: { type: 'module' },
      readyTimeoutMs: 2000,
      disposeGraceMs: 10,
    })
    services.push(service)
    await expect(service.api.echo('x')).rejects.toThrow()
  })
})

describe('WorkerResolver seam', () => {
  it('uses the resolver-provided Worker, and invokes the resolver again on recycle()', async () => {
    let calls = 0
    const resolver: WorkerResolver = () => {
      calls += 1
      return new Worker(workerUrl, { type: 'module' }) as unknown as BrowserWorker
    }
    const service = spawnIsolated(browserEchoSpec, { worker: resolver, disposeGraceMs: 10 })
    services.push(service)
    await expect(service.api.echo('via-resolver')).resolves.toBe('via-resolver')
    expect(calls).toBe(1)
    await service.recycle()
    await expect(service.api.echo('via-resolver-2')).resolves.toBe('via-resolver-2')
    expect(calls).toBe(2)
  })
})

describe('transfer() zero-copy', () => {
  it('detaches the original ArrayBuffer after posting via transfer()', async () => {
    const service = spawnEcho()
    const buffer = new ArrayBuffer(16)
    const marked = transfer(buffer, [buffer])
    await service.api.echo(marked)
    // A transferred ArrayBuffer is detached (byteLength drops to 0) on the sending realm the instant
    // postMessage() actually transfers it — this is the zero-copy proof: a structurally-CLONED buffer
    // would remain intact (byteLength still 16) on the host side.
    expect(buffer.byteLength).toBe(0)
  })
})

describe('E_ISOLATION_UNSUPPORTED_ENV', () => {
  it('createWorkerTransport throws when no Worker global is present', () => {
    const realWorker = globalThis.Worker
    // @ts-expect-error -- deliberately simulating an environment with no Worker global
    delete globalThis.Worker
    try {
      expect(() => createWorkerTransport(browserEchoSpec, { worker: workerUrl })).toThrow(
        E_ISOLATION_UNSUPPORTED_ENV
      )
    } finally {
      globalThis.Worker = realWorker
    }
  })
})

describe('recycle()', () => {
  it('rejects in-flight calls as terminated, then a fresh call after recycle succeeds against a NEW guest', async () => {
    const service = spawnEcho()
    await service.api.echo('warm-up') // ensure ready
    const pending = service.api.hang()
    await new Promise((resolve) => setTimeout(resolve, 25))
    const recyclePromise = service.recycle()
    await expect(pending).rejects.toThrow()
    await recyclePromise
    await expect(service.api.echo('after-recycle')).resolves.toBe('after-recycle')
  })
})
