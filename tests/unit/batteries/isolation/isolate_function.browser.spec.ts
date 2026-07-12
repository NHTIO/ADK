/// <reference lib="dom" />

import { afterEach, describe, expect, it } from 'vitest'
import {
  E_ISOLATED_TERMINATED,
  E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION,
  E_ISOLATE_FUNCTION_UNSERIALIZABLE,
  isolateFunction,
  type IsolatedFunctionHandle,
} from '@nhtio/adk/batteries/isolation'

/**
 * End-to-end specs for `isolateFunction` (WP2's Blob-URL escape hatch) against a REAL, throwaway,
 * source-rehydrated Worker — no fixture file needed here (unlike `browser_transport.browser.spec.ts`):
 * the guest source is entirely generated/embedded by `isolateFunction` itself via a hand-rolled Blob
 * URL, so these specs only ever drive the public `invoke`/`dispose` handle.
 */

const handles: IsolatedFunctionHandle<never, unknown>[] = []

afterEach(() => {
  for (const h of handles.splice(0)) h.dispose()
})

const track = <A extends unknown[], R>(
  handle: IsolatedFunctionHandle<A, R>
): IsolatedFunctionHandle<A, R> => {
  handles.push(handle as unknown as IsolatedFunctionHandle<never, unknown>)
  return handle
}

describe('isolateFunction()', () => {
  it('runs a simple pure function inside the isolated Worker', async () => {
    const handle = track(
      isolateFunction((a: number, b: number) => a + b, {
        allowSourceRehydration: true,
      })
    )
    await expect(handle.invoke(2, 3)).resolves.toBe(5)
  })

  it('supports an async function', async () => {
    const handle = track(
      isolateFunction(
        async (n: number) => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          return n * 2
        },
        { allowSourceRehydration: true }
      )
    )
    await expect(handle.invoke(21)).resolves.toBe(42)
  })

  it('propagates a thrown error back as a rejected promise', async () => {
    const handle = track(
      isolateFunction(
        () => {
          throw new Error('isolated boom')
        },
        { allowSourceRehydration: true }
      )
    )
    await expect(handle.invoke()).rejects.toThrow('isolated boom')
  })

  it('reuses the same Worker across multiple invoke() calls', async () => {
    // `fn.toString()` captures NO closures (see isolate_function.ts's module doc), so the counter must
    // be entirely self-contained: it parks its state on the GUEST realm's own `globalThis`. That state
    // persisting across invoke() calls is exactly what proves the Worker is reused, not respawned.
    const counter = (): number => {
      const g = globalThis as { __isolationSpecCount?: number }
      g.__isolationSpecCount = (g.__isolationSpecCount ?? 0) + 1
      return g.__isolationSpecCount
    }
    const handle = track(isolateFunction(counter, { allowSourceRehydration: true }))
    await expect(handle.invoke()).resolves.toBe(1)
    await expect(handle.invoke()).resolves.toBe(2)
    await expect(handle.invoke()).resolves.toBe(3)
  })

  it('rejects with E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION when the opt-in is missing', () => {
    expect(() => isolateFunction((x: number) => x, {} as never)).toThrow(
      E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION
    )
  })

  it('rejects a native/bound function with E_ISOLATE_FUNCTION_UNSERIALIZABLE', async () => {
    const handle = track(isolateFunction(Math.max.bind(Math), { allowSourceRehydration: true }))
    await expect(handle.invoke()).rejects.toThrow(E_ISOLATE_FUNCTION_UNSERIALIZABLE)
  })

  it('dispose() terminates the Worker and rejects further invoke() calls with E_ISOLATED_TERMINATED', async () => {
    const handle = isolateFunction((x: number) => x * 10, { allowSourceRehydration: true })
    await expect(handle.invoke(4)).resolves.toBe(40)
    handle.dispose()
    await expect(handle.invoke(5)).rejects.toThrow(E_ISOLATED_TERMINATED)
  })

  it('dispose() is idempotent', async () => {
    const handle = isolateFunction((x: number) => x, { allowSourceRehydration: true })
    handle.dispose()
    expect(() => handle.dispose()).not.toThrow()
  })
})
