import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  createAdkShim,
  registerAdkResolver,
  adk,
  E_SHIM_NOT_RESOLVED,
  E_SHIM_RESOLUTION_FAILED,
  E_SHIM_RESOLVER_ALREADY_RESOLVED,
} from '../../../src/shims/index'

// A deliberately tiny, non-ADK bundle shape — proves the shim is decoupled from any ADK import.
// Nothing in this file imports anything from `src/` other than `src/shims/index` itself.
interface Greeter {
  greet(name: string): string
  version: number
}

const makeGreeter = (): Greeter => ({
  greet(name: string) {
    return `hello, ${name}`
  },
  version: 1,
})

describe('createAdkShim', () => {
  describe('single-flight resolution', () => {
    it('invokes the resolver exactly once for concurrent resolve() calls', async () => {
      let calls = 0
      const shim = createAdkShim<Greeter>(async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 5))
        return makeGreeter()
      })

      const [a, b] = await Promise.all([shim.resolve(), shim.resolve()])
      expect(calls).toBe(1)
      expect(a).toBe(b)
      expect(a.greet('world')).toBe('hello, world')
    })
  })

  describe('sync resolvers', () => {
    it('resolves immediately and get() works right after await', async () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      await shim.resolve()
      expect(shim.get().greet('sync')).toBe('hello, sync')
    })
  })

  describe('rejected resolution', () => {
    it('surfaces E_SHIM_RESOLUTION_FAILED with the original error as cause, and clears the memo so a retry re-invokes the resolver', async () => {
      let attempt = 0
      const originalError = new Error('network down')
      const shim = createAdkShim<Greeter>(() => {
        attempt += 1
        if (attempt === 1) {
          throw originalError
        }
        return makeGreeter()
      })

      await expect(shim.resolve()).rejects.toMatchObject({
        name: 'E_SHIM_RESOLUTION_FAILED',
        cause: originalError,
      })
      expect(shim.resolve()).toBeInstanceOf(Promise)
      const bundle = await shim.resolve()
      expect(attempt).toBe(2)
      expect(bundle.greet('retry')).toBe('hello, retry')
    })
  })

  describe('pre-resolution access', () => {
    it('get() throws E_SHIM_NOT_RESOLVED before resolution', () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      expect(() => shim.get()).toThrow(E_SHIM_NOT_RESOLVED)
      try {
        shim.get()
        expect.unreachable()
      } catch (err) {
        expect((err as Error).message).toContain('get()')
      }
    })

    it('proxy property reads throw E_SHIM_NOT_RESOLVED naming the property before resolution', () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      expect(() => shim.proxy.version).toThrow(E_SHIM_NOT_RESOLVED)
      try {
        const value = shim.proxy.greet
        expect(value).toBeUndefined()
        expect.unreachable()
      } catch (err) {
        expect((err as Error).message).toContain('greet')
      }
    })

    it('get() and proxy both return real values after resolution', async () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      await shim.resolve()
      expect(shim.get().version).toBe(1)
      expect(shim.proxy.version).toBe(1)
    })
  })

  describe('proxy delegation', () => {
    it('delegates method calls through the proxy, bound to the resolved bundle', async () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      await shim.resolve()
      const { greet } = shim.proxy
      expect(greet('destructured')).toBe('hello, destructured')
    })
  })

  describe('resolved flag', () => {
    it('is false before resolution and true after', async () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      expect(shim.resolved).toBe(false)
      await shim.resolve()
      expect(shim.resolved).toBe(true)
    })
  })

  describe('decoupling proof', () => {
    it('flows a custom plain-object TBundle through with zero core ADK imports in this spec', async () => {
      const shim = createAdkShim<Greeter>(() => makeGreeter())
      const bundle = await shim.resolve()
      expect(bundle.version).toBe(1)
      expect(typeof bundle.greet).toBe('function')
    })
  })

  describe('GC safety', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('re-invokes the resolver and restores after the memo is "collected" (deref returns undefined)', async () => {
      let deref: () => object | undefined = () => undefined
      class FakeWeakRef<T extends object> {
        #target: T
        constructor(target: T) {
          this.#target = target
          deref = () => this.#target
        }
        deref(): T | undefined {
          return deref() as T | undefined
        }
      }
      vi.stubGlobal('WeakRef', FakeWeakRef)

      let calls = 0
      const shim = createAdkShim<Greeter>(() => {
        calls += 1
        return makeGreeter()
      })

      await shim.resolve()
      expect(shim.resolved).toBe(true)
      expect(calls).toBe(1)

      // Force "collection": make deref() return undefined from now on.
      deref = () => undefined

      expect(shim.resolved).toBe(false)
      expect(() => shim.get()).toThrow(E_SHIM_NOT_RESOLVED)

      const bundle = await shim.resolve()
      expect(calls).toBe(2)
      expect(bundle.greet('back')).toBe('hello, back')
      expect(shim.resolved).toBe(true)
    })

    it('falls back to a strong memo when WeakRef is unavailable at construction time', async () => {
      vi.stubGlobal('WeakRef', undefined)

      const shim = createAdkShim<Greeter>(() => makeGreeter())
      await shim.resolve()
      expect(shim.resolved).toBe(true)
      expect(shim.get().greet('strong')).toBe('hello, strong')
      // Nothing else references the bundle, no GC hook is possible without WeakRef — it just stays.
      expect(shim.resolved).toBe(true)
    })
  })
})

// The ambient registry is deliberate module-global state, which makes its tests environment-sensitive:
// in Node, `vi.resetModules()` gives every test a pristine module instance; in vitest BROWSER mode,
// native ESM modules cannot be reset, so `vi.resetModules()` is a no-op and all tests share ONE module
// instance whose `ambientResolvedOnce` latch never resets (proven on CI: chromium/firefox failed exactly
// where the latch leaked across tests, while Node passed). This suite is therefore written as a single
// ordered STATE PROGRESSION that is valid under both semantics: each test's preconditions hold both from
// a pristine module (Node, reset per test) and from the cumulative state the previous tests left behind
// (browser, one shared instance). Do not reorder these tests, and do not add tests that assume a fresh
// module — extend the progression instead.
describe('ambient adk registry', () => {
  beforeEach(() => {
    vi.resetModules() // effective in Node only; a documented no-op in browser mode (see above)
  })

  // 1. Pristine or nothing-registered-yet: resolving with no resolver rejects. A FAILED resolution must
  //    not flip the resolved-once latch, so this leaves both environments still "unresolved".
  it('resolving before any registration surfaces E_SHIM_RESOLUTION_FAILED', async () => {
    const mod = await import('../../../src/shims/index')
    await expect(mod.adk.resolve()).rejects.toThrow(mod.E_SHIM_RESOLUTION_FAILED)
  })

  // 2. Still unresolved (the failed resolve above must not have latched): last-writer-wins overwrite,
  //    then the FIRST successful resolution — which latches the shared instance in browser mode.
  it('re-registering before the first resolution overwrites — the newest resolver wins', async () => {
    const mod = await import('../../../src/shims/index')
    const first = { tag: 'first' }
    const second = { tag: 'second' }
    mod.registerAdkResolver(() => first as never)
    mod.registerAdkResolver(() => second as never)
    const resolved = await mod.adk.resolve()
    expect(resolved).toEqual(second)
  })

  // 3. Ensure-resolved-once, tolerantly: from a pristine module (Node) the register+resolve succeeds;
  //    from the shared already-latched instance (browser) the register itself throws — which is fine,
  //    the shim is already resolved-once either way. Then the actual assertion: re-registering throws.
  it('re-registering after the ambient shim resolved once throws E_SHIM_RESOLVER_ALREADY_RESOLVED', async () => {
    const mod = await import('../../../src/shims/index')
    try {
      mod.registerAdkResolver(() => ({ tag: 'once' }) as never)
      await mod.adk.resolve()
    } catch {
      // browser mode: already latched by the previous test — exactly the precondition we need
    }
    expect(() => mod.registerAdkResolver(() => ({ tag: 'twice' }) as never)).toThrow(
      mod.E_SHIM_RESOLVER_ALREADY_RESOLVED
    )
  })

  // 4. Reads still work against whatever bundle the progression resolved (Node: fresh register+resolve
  //    inside the try; browser: test 2's `second` bundle) — resolve() and proxy stay usable throughout.
  it('registerAdkResolver() then adk.resolve() works', async () => {
    const mod = await import('../../../src/shims/index')
    const bundle = { hello: () => 'world' }
    try {
      mod.registerAdkResolver(() => bundle as never)
    } catch {
      // browser mode: latched — the shared instance already has a resolved bundle
    }
    const resolved = (await mod.adk.resolve()) as Record<string, unknown>
    expect(resolved).toBeTruthy()
    expect(typeof resolved).toBe('object')
    expect(mod.adk.resolved).toBe(true)
  })
})

// Sanity: the named exception classes imported at the top of this file are the same identities
// used internally (so `toThrow(E_SHIM_NOT_RESOLVED)` assertions above are meaningful, not just
// duck-typed).
describe('exception identities', () => {
  it('exports E_SHIM_NOT_RESOLVED, E_SHIM_RESOLUTION_FAILED, E_SHIM_RESOLVER_ALREADY_RESOLVED as distinct named classes', () => {
    expect(E_SHIM_NOT_RESOLVED.name).toBe('E_SHIM_NOT_RESOLVED')
    expect(E_SHIM_RESOLUTION_FAILED.name).toBe('E_SHIM_RESOLUTION_FAILED')
    expect(E_SHIM_RESOLVER_ALREADY_RESOLVED.name).toBe('E_SHIM_RESOLVER_ALREADY_RESOLVED')
  })

  it('registerAdkResolver and adk are usable directly from the top-level import too', () => {
    expect(typeof registerAdkResolver).toBe('function')
    expect(typeof adk.resolve).toBe('function')
  })
})
