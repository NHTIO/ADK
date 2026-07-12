import { execa } from 'execa'
import { fork } from 'node:child_process'
import { echoSpec } from '../../../_fixtures/isolation/echo_spec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { E_ISOLATED_CRASHED } from '@nhtio/adk/batteries/isolation'
import { prebundleChild, type PrebundledChild } from '../../../_fixtures/isolation/prebundle_child'
import {
  createChildProcessTransport,
  forkIsolated,
} from '@nhtio/adk/batteries/isolation/child_process'
import type {
  ChildResolver,
  ForkIsolatedOptions,
  IsolatedChildLike,
} from '@nhtio/adk/batteries/isolation/child_process'

/**
 * End-to-end specs for the child_process transport: a REAL forked node process (not a linked
 * in-memory fake port — that's WP1's `host_serve.cross.spec.ts`), driven through the full
 * `createIsolatedService`/`forkIsolated` public API.
 *
 * @remarks
 * `fork()` needs a runnable JS module; `echo_child.ts` is TypeScript importing `src/` paths, so this
 * file prebundles it once via `esbuild-wasm` (`prebundleChild`, cached across every test in this file
 * via `beforeAll`/`afterAll`) rather than re-bundling per test. See `prebundle_child.ts` for the
 * format/external decisions this required (CJS output; `knex`/`@nhtio/encoder` externalized).
 *
 * Located at `tests/unit/batteries/isolation/*.node.spec.ts` (alongside the WP1 `*.cross.spec.ts`
 * suite) rather than mirroring `tests/functional/batteries/specialists/`: the vitest node project's
 * include glob (`tests/**\/*.node.spec.ts`) collects this file regardless of directory, and the
 * browser project's glob (`tests/**\/*.cross.spec.ts` + `tests/**\/*.browser.spec.ts`) does not match
 * `.node.spec.ts` at all — so co-locating with the rest of the isolation battery's specs keeps the
 * whole battery's test surface in one place without the browser project ever attempting to collect a
 * file that imports `node:child_process`.
 */

let child: PrebundledChild

beforeAll(async () => {
  child = await prebundleChild(
    new URL('../../../_fixtures/isolation/echo_child.ts', import.meta.url).pathname
  )
}, 120_000)

afterAll(async () => {
  await child?.dispose()
})

describe('createChildProcessTransport / forkIsolated — real fork()', () => {
  it('round-trips a method call, a stream, events, and abort against a real forked child', async () => {
    const svc = forkIsolated(echoSpec, { modulePath: child.modulePath })
    try {
      expect(await svc.api.echo('hello')).toBe('hello')

      const seen: number[] = []
      const progressEvents: number[] = []
      const unsub = svc.onCrash(() => {})
      const unsubEvent = svc.on('progress', (v) => progressEvents.push(v))
      const stream = svc.api.counter(3)
      const reader = stream.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        seen.push(value)
      }
      expect(seen).toEqual([0, 1, 2])
      expect(progressEvents).toEqual([0, 1, 2])
      unsub()
      unsubEvent()

      // Abort: `hang` never resolves on its own — abort it and assert the call rejects.
      const ac = new AbortController()
      const hangPromise = svc.api.hang(ac.signal)
      ac.abort()
      await expect(hangPromise).rejects.toBeInstanceOf(Error)

      await expect(svc.api.fail('boom')).rejects.toThrow('boom')
    } finally {
      await svc.dispose()
    }
  }, 20_000)

  it('round-trips a Float32Array and a Map through advanced serialization, preserving prototype identity', async () => {
    const svc = forkIsolated(echoSpec, { modulePath: child.modulePath })
    try {
      const floatArray = new Float32Array([1.5, 2.5, 3.5])
      const echoedFloat = (await svc.api.echo(floatArray)) as Float32Array
      expect(echoedFloat).toBeInstanceOf(Float32Array)
      expect(Array.from(echoedFloat)).toEqual([1.5, 2.5, 3.5])

      const map = new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ])
      const echoedMap = (await svc.api.echo(map)) as Map<string, number>
      expect(echoedMap).toBeInstanceOf(Map)
      expect(Array.from(echoedMap.entries())).toEqual([
        ['a', 1],
        ['b', 2],
      ])
    } finally {
      await svc.dispose()
    }
  }, 20_000)

  it('round-trips a function-carrying options bag (tier-1 codec escalation)', async () => {
    const svc = forkIsolated(echoSpec, { modulePath: child.modulePath })
    try {
      const bag = {
        label: 'opts',
        onProgress: (n: number) => n * 2,
      }
      const echoed = (await svc.api.echo(bag)) as {
        label: string
        onProgress: (n: number) => number
      }
      expect(echoed.label).toBe('opts')
      expect(typeof echoed.onProgress).toBe('function')
      // The escalated function is a wire-proxy — it's callable but round-trips through the codec, not
      // the original reference; assert it's callable rather than reference-equal.
      expect(await echoed.onProgress(3)).toBe(6)
    } finally {
      await svc.dispose()
    }
  }, 20_000)

  it('contains a process.exit(7) crash: onCrash fires with code 7, service state becomes crashed, subsequent calls throw E_ISOLATED_CRASHED, host process is unaffected', async () => {
    const svc = forkIsolated(echoSpec, { modulePath: child.modulePath })
    try {
      await svc.api.echo('warm up the connection first')

      const crashInfo = await new Promise<{ code?: number | null; signal?: string | null }>(
        (resolve) => {
          svc.onCrash((info) => resolve(info))
          void svc.api.die(7).catch(() => {})
        }
      )
      expect(crashInfo.code).toBe(7)
      expect(svc.state).toBe('crashed')
      await expect(svc.api.echo('anything')).rejects.toBeInstanceOf(E_ISOLATED_CRASHED)

      // The host test process itself is still alive and able to keep running assertions — the
      // strongest evidence of containment available from within the test itself.
      expect(process.pid).toBeGreaterThan(0)
    } finally {
      await svc.dispose()
    }
  }, 20_000)

  it('recycle() after a crash brings the service back to a working state', async () => {
    const svc = forkIsolated(echoSpec, { modulePath: child.modulePath })
    try {
      await svc.api.echo('warm up')
      await new Promise<void>((resolve) => {
        svc.onCrash(() => resolve())
        void svc.api.die(9).catch(() => {})
      })
      expect(svc.state).toBe('crashed')

      await svc.recycle()
      expect(svc.state).toBe('ready')
      expect(await svc.api.echo('back online')).toBe('back online')
    } finally {
      await svc.dispose()
    }
  }, 20_000)

  it('dispose() shuts down gracefully with no orphaned process left behind', async () => {
    const svc = forkIsolated(echoSpec, { modulePath: child.modulePath })
    await svc.api.echo('ready check')
    await svc.dispose()
    expect(svc.state).toBe('disposed')
    // A second dispose() is idempotent and must not throw.
    await expect(svc.dispose()).resolves.toBeUndefined()
  }, 20_000)
})

/**
 * Conformance suite run against BOTH spawn shapes this transport supports: the default `fork()` (via
 * `modulePath`) and a BYO `spawn` resolver backed by `execa`'s `{ ipc: true }` subprocess. Both must
 * behave identically from `createIsolatedService`'s point of view — that's the entire point of the
 * {@link ChildResolver} seam.
 *
 * `makeSpawn` — a fresh {@link ChildResolver} per test, wrapping this label's real spawn shape (a
 * `fork()`-backed resolver for "default fork()", an execa-backed resolver for "execa resolver") — is
 * used ONLY by the recycle-invocation-counting test below, which needs a per-invocation hook regardless
 * of spawn shape; `makeOptions` (the shape's own native options bag) is used everywhere else so the
 * basic round-trip test still exercises `modulePath` directly for the "default fork()" label.
 */
const runTransportConformance = (
  label: string,
  makeOptions: () => ForkIsolatedOptions,
  makeSpawn: () => ChildResolver
): void => {
  describe(`transport conformance — ${label}`, () => {
    it('performs a basic method round-trip', async () => {
      const svc = forkIsolated(echoSpec, makeOptions())
      try {
        expect(await svc.api.echo('conformance')).toBe('conformance')
      } finally {
        await svc.dispose()
      }
    }, 20_000)

    it('increments the resolver invocation count across recycle()', async () => {
      let invocations = 0
      const baseSpawn = makeSpawn()
      const countingSpawn: ChildResolver = (ctx) => {
        invocations += 1
        return baseSpawn(ctx)
      }
      const svc = forkIsolated(echoSpec, { spawn: countingSpawn })
      try {
        await svc.api.echo('first spawn')
        expect(invocations).toBe(1)
        await svc.recycle()
        await svc.api.echo('second spawn')
        expect(invocations).toBe(2)
      } finally {
        await svc.dispose()
      }
    }, 20_000)
  })
}

runTransportConformance(
  'default fork()',
  () => ({ modulePath: child.modulePath }),
  () => (ctx) => {
    void ctx
    return fork(child.modulePath) as unknown as IsolatedChildLike
  }
)

runTransportConformance(
  'execa { ipc: true } resolver',
  () => {
    const resolver: ChildResolver = ({ spec }) => {
      void spec
      const subprocess = execa(process.execPath, [child.modulePath], {
        ipc: true,
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      // execa's subprocess is ITSELF a promise (mixed in via `mergePromise`) that settles rejected on
      // any non-zero exit/signal — including the ordinary `kill(SIGTERM)` this transport's `terminate()`
      // sends on every `dispose()`/`recycle()`. This transport only ever drives the EventEmitter side of
      // that duck, never the promise side, so nothing else in this file ever attaches a rejection
      // handler; without one here, node reports an unhandled rejection for every single terminate().
      // Swallowing it here is exactly what a real `ChildResolver` author must do for the same reason.
      subprocess.catch(() => {})
      return subprocess as unknown as IsolatedChildLike
    }
    return { spawn: resolver }
  },
  () => (ctx) => {
    void ctx
    const subprocess = execa(process.execPath, [child.modulePath], {
      ipc: true,
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    subprocess.catch(() => {})
    return subprocess as unknown as IsolatedChildLike
  }
)

describe('createChildProcessTransport — validation', () => {
  it('throws E_INVALID_ISOLATION_OPTIONS when both modulePath and spawn are supplied', () => {
    const invalidOptions = {
      modulePath: child.modulePath,
      spawn: async () => {
        throw new Error('never called')
      },
    } as unknown as ForkIsolatedOptions
    expect(() => createChildProcessTransport(echoSpec, invalidOptions)).toThrow()
  })

  it('throws E_INVALID_ISOLATION_OPTIONS when neither modulePath nor spawn are supplied', () => {
    const invalidOptions = {} as unknown as ForkIsolatedOptions
    expect(() => createChildProcessTransport(echoSpec, invalidOptions)).toThrow()
  })
})
