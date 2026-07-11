/**
 * Runtime-binding shims — use `@nhtio/adk` (or any bundle) WITHOUT importing it into your module
 * graph.
 *
 * @module @nhtio/adk/shims
 *
 * @remarks
 * ## Why this exists
 *
 * Most consumers `import` the ADK directly and let the bundler wire it in. Some cannot: importing
 * ADK **source** eagerly evaluates its entire module graph, and on constrained runtimes that eager
 * evaluation is itself a problem — the motivating case is this repository's own docs site, which
 * hand-rolled this exact pattern four times (~590 lines, one drifting hand-maintained manifest type
 * per copy) after discovering that importing `@nhtio/adk` into the VitePress app's graph overflowed
 * the JS call stack on iOS WebKit ("Maximum call stack size exceeded") — see
 * `docs/.vitepress/repl/index.ts` for the full account of that failure and the compiled-bundle
 * workaround it settled on. The same shape recurs anywhere a module must reference ADK types and
 * values without eagerly linking to an ADK build at import time: CDN / no-bundler pages, Worker
 * threads, plugin systems that inject a host-provided implementation, code-split lazy chunks, and
 * version hot-swap (retiring one loaded bundle for another without reloading every importer).
 *
 * This module ships the **mechanism** those call sites all rediscover independently — a resolver
 * seam plus a memoizing handle — and nothing else. It has no opinion on *how* you load a bundle
 * (`fetch` + dynamic `import()`, a bundler-native `import()`, a Worker `postMessage` handshake, a
 * host-injected global); that policy is entirely yours, supplied as a single function.
 *
 * ## The pattern
 *
 * You hand {@link createAdkShim} an {@link AdkResolverFn} — a zero-argument function that produces
 * your bundle, synchronously or asynchronously. The returned {@link AdkShim} gives you four ways to
 * consume it:
 *
 * - `await shim.resolve()` — the async, always-correct path. Single-flight: concurrent callers
 *   during an in-flight resolution share one resolver invocation, not one each.
 * - `shim.get()` — the sync path, for code that has already awaited `resolve()` at least once
 *   and now wants to read the bundle without re-awaiting. Throws
 *   {@link E_SHIM_NOT_RESOLVED} if nothing is resolved yet.
 * - `shim.proxy` — a `Proxy<TBundle>` that transparently delegates every property read to the
 *   resolved bundle once one exists, and throws {@link E_SHIM_NOT_RESOLVED} (naming the exact
 *   property that was touched) if read too early. This directly replaces the `export let Foo:
 *   typeof AdkModule.Foo` holder pattern the docs app hand-wrote per symbol — one `proxy` object
 *   stands in for the whole bundle's worth of holders, and destructuring `const { Foo } =
 *   shim.proxy` reads through it exactly the same way a real module namespace would.
 * - `shim.resolved` — a live boolean for "is there currently a dereferenceable bundle", for call
 *   sites that want to branch without risking a throw.
 *
 * ## API CONTRACT: importing this module evaluates essentially nothing
 *
 * `@nhtio/adk/shims` is a **leaf**: aside from {@link createException} (used only to mint the three
 * exception classes below, and itself graph-free — see the note at the bottom of this remarks
 * block), it has zero runtime imports from the rest of the ADK. Every ADK *type* used here —
 * {@link AdkNamespace} — is an erased `typeof import(...)` type query, which the compiler discards
 * entirely; it costs nothing at runtime and pulls in no value bindings. `import * as shims from
 * '@nhtio/adk/shims'` therefore does not construct a single ADK class, does not touch a single
 * battery, and cannot itself be the thing that overflows a call stack. That is the entire point:
 * this module is safe to import eagerly from anywhere — including the eager, top-of-file position
 * a `resolve()`-calling module needs — precisely because it never touches the graph it is a seam
 * for.
 *
 * ## Why `shims` is NOT re-exported from the root `@nhtio/adk` barrel
 *
 * Root-barrel re-export would defeat the entire purpose. If `@nhtio/adk/shims` were exported from
 * `@nhtio/adk` itself, then `import { createAdkShim } from '@nhtio/adk'` would drag in the very
 * module graph this subpath exists to let you avoid — you cannot get "a seam for deferring ADK's
 * import" without importing ADK. Keeping `shims` a sibling **subpath**, never re-exported upward,
 * is what lets a leaf-conscious consumer write `import { createAdkShim } from '@nhtio/adk/shims'`
 * and mean it.
 *
 * ## GC-safe memoization
 *
 * A resolved bundle is held via `WeakRef` (constraining `TBundle extends object`, since only
 * objects are valid `WeakRef` targets) — never strongly retained by the shim itself, so a shim you
 * hold onto cannot alone keep an entire ADK bundle (and everything it closes over) alive forever.
 * Only the in-flight resolution *promise* is held strongly, and only for the duration of that one
 * flight. If the bundle is collected (or, for a resolver like the canonical dynamic-import one, was
 * never going to be collected in practice — the JS module registry itself caches an imported module
 * strongly for the life of the realm; the `WeakRef` here only releases the *shim's own handle* to
 * it), the shim degrades predictably:
 *
 * - `resolved` reports `false`.
 * - `get()` and `proxy` property reads throw {@link E_SHIM_NOT_RESOLVED}.
 * - `resolve()` transparently re-invokes the resolver (idempotent for the dynamic-import case —
 *   re-`import()`-ing an already-loaded module resolves instantly from the registry cache — and a
 *   correctness requirement for any other resolver you supply, since this path can legitimately
 *   run twice).
 *
 * Long-lived synchronous consumers — anything that reads `get()` / `proxy` on a timer or from an
 * event handler without ever `await`-ing `resolve()` again — should either hold their own strong
 * reference to the value they read out of the bundle, or re-`await resolve()` before each sync
 * read, rather than assuming a resolved bundle stays resolved indefinitely.
 *
 * Environments without `WeakRef` (checked once, with `typeof WeakRef === 'function'`, at
 * {@link createAdkShim} construction time) fall back to an ordinary strong reference for that
 * shim's lifetime — documented behavior, not a silent downgrade: such a shim's bundle lives as long
 * as the shim does.
 *
 * ## Example resolvers (illustrative only — this module ships no loading policy)
 *
 * URL dynamic-import, guarded against SSR (mirrors the docs app's real loader):
 * ```ts
 * const shim = createAdkShim(() => {
 *   if (typeof window === 'undefined') {
 *     throw new Error('this bundle is client-only (no SSR)')
 *   }
 *   const url = new URL('/repl/adk-repl.es.js', window.location.origin).href
 *   return import(/* @vite-ignore *\/ url)
 * })
 * ```
 *
 * Same-graph passthrough (no deferral at all — useful as a drop-in when the caller doesn't need
 * one, e.g. tests):
 * ```ts
 * const shim = createAdkShim(() => import('@nhtio/adk'))
 * ```
 *
 * Worker / plugin injection sketch (the resolver awaits a handshake instead of an import):
 * ```ts
 * const shim = createAdkShim(
 *   () => new Promise((resolvePromise) => {
 *     worker.postMessage({ type: 'request-adk-bundle' })
 *     worker.addEventListener('message', function onMsg(e) {
 *       if (e.data?.type !== 'adk-bundle') return
 *       worker.removeEventListener('message', onMsg)
 *       resolvePromise(e.data.bundle)
 *     })
 *   })
 * )
 * ```
 *
 * ## `TBundle` is a compile-time contract, not a runtime guarantee
 *
 * The generic `TBundle` you supply to {@link createAdkShim} (or, at the ambient
 * {@link registerAdkResolver} / {@link adk} call sites, the default `AdkNamespace`) tells the
 * compiler what shape to expect back from your resolver — it performs no runtime validation of the
 * value your resolver actually produces. Getting this contract right is on you, exactly as it would
 * be for a real `import` statement whose resolved module happens not to match its `.d.ts`. Compose
 * it with `&` when your resolver's bundle carries more than the root namespace, e.g. a battery
 * bundled alongside core:
 * ```ts
 * type MyBundle = AdkNamespace & typeof import('@nhtio/adk/batteries/context/thrift')
 * const shim = createAdkShim<MyBundle>(() => loadMyPrecompiledBundle())
 * ```
 *
 * ## A note on `createException`'s own leaf-ness
 *
 * `createException`'s import closure was verified (not assumed) to be graph-free before this module
 * was written: `../lib/utils/exceptions` imports only `./validation` (which imports only
 * `../classes/base_exception` + the external `@nhtio/validation` package), the external
 * `@nhtio/validation` package itself, the external `fast-printf` package, and
 * `../classes/base_exception` directly (which imports nothing at all). None of those files reach
 * into `lib/contracts`, `lib/classes` beyond `base_exception`, `batteries`, or any other part of the
 * ADK's runtime graph — so importing it here does not compromise this module's leaf guarantee.
 */

import { createException } from '../lib/utils/exceptions'
import type * as AdkNamespaceModule from '../index'

/**
 * Erased, type-only alias for the full `@nhtio/adk` root namespace. Declared via a top-of-file
 * `import type * as` (rather than an inline `typeof import(...)` type query) so it is a single,
 * lintable reference — but it is exactly as free at runtime either way: a type-only import is
 * erased entirely, no value import is emitted for it, which is what makes it safe to use as the
 * default `TBundle` throughout this module without compromising the leaf guarantee documented
 * above.
 */
type AdkNamespace = typeof AdkNamespaceModule

/**
 * Thrown when {@link AdkShim.get} or a {@link AdkShim.proxy} property read is attempted before the
 * shim has a dereferenceable bundle — either because {@link AdkShim.resolve} has never been awaited
 * to completion, or because a previously resolved bundle's `WeakRef` has since been garbage
 * collected. The message names the exact accessor that triggered the throw (`"get()"` for the
 * `get()` method itself, or the property name for a `proxy` read) so the failure points straight at
 * the offending call site.
 *
 * @remarks
 * Recoverable by the caller: `await shim.resolve()` (or re-register a resolver and resolve, for the
 * ambient {@link adk} shim) and retry the sync read.
 */
export const E_SHIM_NOT_RESOLVED = createException<[string]>(
  'E_SHIM_NOT_RESOLVED',
  'Cannot access "%s" on this ADK shim: it has no resolved bundle right now (either resolve() has ' +
    'never completed, or the previously resolved bundle was garbage collected). Await ' +
    'shim.resolve() before reading synchronously via get() or proxy.',
  'E_SHIM_NOT_RESOLVED',
  425,
  true
)

/**
 * Thrown when an {@link AdkResolverFn} rejects (or throws synchronously). The original failure is
 * preserved on `.cause` so callers can inspect the underlying reason (a failed `fetch`, a malformed
 * bundle, a Worker handshake that never completed, …); the message additionally embeds its `.message`
 * for log lines that only surface the top-level error.
 *
 * @remarks
 * Non-fatal by design: a resolver failure is an environmental/runtime condition (a bad network, a
 * missing asset, an unregistered ambient resolver), not a programming error, and the memo is cleared
 * on this path — the very next {@link AdkShim.resolve} call re-invokes the resolver and can still
 * succeed. The ambient {@link adk} shim raises this same exception, with a distinct cause message,
 * when {@link AdkShim.resolve} is called before any {@link registerAdkResolver} registration.
 */
export const E_SHIM_RESOLUTION_FAILED = createException<[string]>(
  'E_SHIM_RESOLUTION_FAILED',
  'The registered resolver failed to produce a bundle: %s',
  'E_SHIM_RESOLUTION_FAILED',
  500,
  false
)

/**
 * Thrown by {@link registerAdkResolver} when it is called again after the ambient {@link adk} shim
 * has already resolved once successfully.
 *
 * @remarks
 * This is a split-brain guard, not a general "can't change your mind" restriction: re-registering
 * a resolver **before** the first successful resolution silently overwrites the previous
 * registration (last writer wins, no throw) — that path is expected during application bootstrap,
 * where a resolver might be registered speculatively and then replaced before anything ever reads
 * `adk`. Once a real bundle has been handed out through the ambient shim, though, swapping the
 * resolver underneath already-resolved consumers risks two different call sites silently observing
 * two different ADK builds through the same shared `adk` handle — a bug that is far harder to
 * diagnose than a loud, immediate throw at the mis-timed `registerAdkResolver` call site. If you
 * need a second, independently swappable binding, construct a fresh {@link createAdkShim} instance
 * instead of trying to repoint the ambient one.
 */
export const E_SHIM_RESOLVER_ALREADY_RESOLVED = createException(
  'E_SHIM_RESOLVER_ALREADY_RESOLVED',
  'registerAdkResolver() was called after the ambient `adk` shim already resolved once. ' +
    'Re-registering post-resolution risks a split-brain state where different call sites observe ' +
    'different bundles through the same shared handle. Construct a fresh createAdkShim() instance ' +
    'instead if you need an independently swappable resolver.',
  'E_SHIM_RESOLVER_ALREADY_RESOLVED',
  409,
  true
)

/**
 * The seam: a zero-argument, consumer-supplied function that produces the bundle a shim wraps,
 * synchronously or asynchronously. All environment-specific loading knowledge — where the bundle
 * lives, how it's fetched, whether it's cached upstream — lives inside this one function; the shim
 * itself is entirely agnostic to how `TBundle` gets produced.
 *
 * @typeParam TBundle - The shape of the value this resolver produces. Defaults to
 *   {@link AdkNamespace} (the full `@nhtio/adk` root namespace) since that is the motivating case,
 *   but any object shape works — see {@link createAdkShim}'s battery-intersection example.
 * @returns The bundle, or a `Promise` of it. Rejecting (or throwing synchronously) surfaces as
 *   {@link E_SHIM_RESOLUTION_FAILED} from the owning shim's `resolve()`.
 */
export type AdkResolverFn<TBundle = AdkNamespace> = () => TBundle | Promise<TBundle>

/**
 * A memoizing handle over a lazily-resolved bundle, returned by {@link createAdkShim}. See the
 * module-level remarks for the full GC-safety contract and the rationale for each accessor.
 *
 * @typeParam TBundle - The shape of the wrapped bundle. Must extend `object` — only objects are
 *   valid `WeakRef` targets, and this shim's memoization relies on `WeakRef` where available.
 */
export interface AdkShim<TBundle extends object> {
  /**
   * Resolve the bundle, awaiting the underlying {@link AdkResolverFn} if necessary.
   *
   * @remarks
   * Single-flight: if a resolution is already in progress, concurrent callers share that one
   * in-flight promise rather than triggering a second resolver invocation. Already-resolved calls
   * (including after re-resolving following a garbage-collected memo) return the cached bundle via
   * an already-settled promise without touching the resolver at all.
   *
   * @returns A promise settling with the resolved bundle.
   * @throws {@link E_SHIM_RESOLUTION_FAILED} if the resolver rejects or throws. The memo is cleared
   *   on this path, so a subsequent call re-invokes the resolver.
   */
  resolve(): Promise<TBundle>
  /**
   * Synchronously read the currently resolved bundle.
   *
   * @remarks
   * For code that has already `await`-ed {@link resolve} at least once (directly, or transitively
   * via something that did) and now wants to read the bundle without paying for another `await`.
   * There is no synchronous equivalent of running an async resolver — if nothing is resolved yet
   * (or the memo was garbage collected), this throws rather than blocking or returning a stale
   * value.
   *
   * @returns The resolved bundle.
   * @throws {@link E_SHIM_NOT_RESOLVED} if there is no currently dereferenceable bundle.
   */
  get(): TBundle
  /**
   * `true` when the bundle is currently dereferenceable (resolved, and — where `WeakRef` is
   * available — not yet garbage collected). Live: re-evaluated on every read, so this can flip from
   * `true` back to `false` between two reads with no code in between, if the collector runs.
   */
  readonly resolved: boolean
  /**
   * A `Proxy<TBundle>` that delegates every property read to the resolved bundle. Reading a
   * property before anything has resolved (or after the memo has been collected) throws
   * {@link E_SHIM_NOT_RESOLVED} naming the exact property that was touched, instead of returning
   * `undefined` — the failure points at the call site instead of surfacing as a confusing
   * "cannot call undefined" a few frames later.
   *
   * @remarks
   * Bound function properties: reading a method off `proxy` returns it pre-bound to the resolved
   * bundle, so `const { foo } = shim.proxy; foo()` behaves the same as `shim.get().foo()` — you can
   * destructure without losing `this`. This is the direct replacement for the hand-rolled `export
   * let Foo: typeof AdkModule.Foo` holder pattern: one `proxy` stands in for an entire bundle's
   * worth of individually-declared holders, populated the same way (assign real values once
   * resolved) but without the drift risk of hand-maintaining one `let` per symbol.
   */
  readonly proxy: TBundle
}

/**
 * Construct a new {@link AdkShim} around a resolver.
 *
 * @remarks
 * Every call returns an independent shim with its own private memoization state — nothing is
 * shared between instances, and constructing one never invokes `resolveFn` eagerly (resolution
 * happens lazily, on first {@link AdkShim.resolve} call). Use this directly when you want a scoped,
 * non-ambient binding (e.g. one shim per loaded plugin version); use {@link registerAdkResolver} /
 * {@link adk} instead for the "one shared binding used across many files" ergonomics the docs app's
 * flagship agent needs.
 *
 * @typeParam TBundle - The shape of the bundle this shim wraps. Defaults to {@link AdkNamespace}.
 * @param resolveFn - The resolver this shim wraps. See {@link AdkResolverFn} and the module-level
 *   `@example` fences for the supported shapes (URL dynamic-import, same-graph passthrough, Worker
 *   handshake).
 * @returns A new, independently-memoized {@link AdkShim}.
 *
 * @example
 * Composing a battery into the resolved shape (the "battery-intersection" recipe):
 * ```ts
 * type MyBundle = AdkNamespace & typeof import('@nhtio/adk/batteries/context/thrift')
 * const shim = createAdkShim<MyBundle>(() => loadMyPrecompiledBundle())
 * const { subtractToFit } = await shim.resolve()
 * ```
 */
export function createAdkShim<TBundle extends object = AdkNamespace>(
  resolveFn: AdkResolverFn<TBundle>
): AdkShim<TBundle> {
  // Captured once at construction (not re-checked per call) so a shim's GC-safety strategy is fixed
  // for its lifetime, and so tests can deterministically stub the global before constructing a shim.
  const WeakRefCtor: typeof WeakRef | undefined =
    typeof WeakRef === 'function' ? WeakRef : undefined

  let weakRef: WeakRef<TBundle> | undefined
  let strongRef: TBundle | undefined
  let inFlight: Promise<TBundle> | null = null

  const peek = (): TBundle | undefined => {
    return WeakRefCtor ? weakRef?.deref() : strongRef
  }

  const remember = (bundle: TBundle): void => {
    if (WeakRefCtor) {
      weakRef = new WeakRefCtor(bundle)
    } else {
      strongRef = bundle
    }
  }

  const resolve = (): Promise<TBundle> => {
    const cached = peek()
    if (cached !== undefined) {
      return Promise.resolve(cached)
    }
    if (inFlight) {
      return inFlight
    }
    const attempt: Promise<TBundle> = Promise.resolve()
      .then(() => resolveFn())
      .then(
        (bundle) => {
          inFlight = null
          remember(bundle)
          return bundle
        },
        (err: unknown) => {
          inFlight = null
          // Leaf module (src/shims): importing ../lib/utils/guards for isError() would add a
          // second value import, breaking the zero-runtime-import leaf contract this module
          // documents and its spec enforces.
          // eslint-disable-next-line adk/prefer-is-error -- see comment above
          const reason = err instanceof Error ? err.message : String(err)
          throw new E_SHIM_RESOLUTION_FAILED([reason], { cause: err })
        }
      )
    inFlight = attempt
    return attempt
  }

  const get = (): TBundle => {
    const cached = peek()
    if (cached === undefined) {
      throw new E_SHIM_NOT_RESOLVED(['get()'])
    }
    return cached
  }

  const proxy = new Proxy({} as TBundle, {
    get(_target, prop) {
      const cached = peek()
      if (cached === undefined) {
        throw new E_SHIM_NOT_RESOLVED([String(prop)])
      }
      const value = Reflect.get(cached as object, prop)
      return typeof value === 'function' ? value.bind(cached) : value
    },
  }) as TBundle

  return {
    resolve,
    get,
    get resolved(): boolean {
      return peek() !== undefined
    },
    proxy,
  }
}

// ── Ambient registry ──────────────────────────────────────────────────────────
//
// Module-scope ergonomics for the "many files, one shared binding" case (the flagship agent's
// docs/.vitepress/theme/components/agent/agent_adk.ts use-case): every file imports the same `adk`
// value instead of each constructing (and separately resolving) its own shim.

let registeredResolver: AdkResolverFn<AdkNamespace> | null = null
let ambientResolvedOnce = false

/**
 * Register (or replace) the resolver the ambient {@link adk} shim delegates to.
 *
 * @remarks
 * Call once, early, before anything reads {@link adk}. Re-registering **before** the ambient shim's
 * first successful resolution silently overwrites the previous registration — the newest call wins,
 * no throw, no warning; this is the expected shape for a speculative registration made during
 * bootstrap that gets superseded before anything actually resolves. Re-registering **after** the
 * first successful resolution throws {@link E_SHIM_RESOLVER_ALREADY_RESOLVED} — see that
 * exception's docs for why swapping resolvers under already-resolved consumers is treated as a
 * hard error rather than a silent replace.
 *
 * @typeParam TBundle - The shape the supplied resolver produces. Defaults to {@link AdkNamespace}.
 * @param resolver - The resolver {@link adk} will delegate to going forward.
 * @throws {@link E_SHIM_RESOLVER_ALREADY_RESOLVED} if the ambient shim already resolved once.
 */
export function registerAdkResolver<TBundle extends object = AdkNamespace>(
  resolver: AdkResolverFn<TBundle>
): void {
  if (ambientResolvedOnce) {
    throw new E_SHIM_RESOLVER_ALREADY_RESOLVED()
  }
  registeredResolver = resolver as unknown as AdkResolverFn<AdkNamespace>
}

/**
 * The ambient, module-scope {@link AdkShim} instance. Delegates to whatever resolver was last
 * passed to {@link registerAdkResolver} — resolving before any registration raises
 * {@link E_SHIM_RESOLUTION_FAILED} with a cause explaining that no resolver has been registered yet.
 *
 * @remarks
 * Use this when many files across a module graph want to share one binding (import `adk` and read
 * `adk.proxy` / `await adk.resolve()` from anywhere) rather than threading a shim instance through
 * every call site. For an independent, separately-resolvable binding — e.g. loading two different
 * bundle versions side by side — construct your own via {@link createAdkShim} instead.
 */
export const adk: AdkShim<AdkNamespace> = createAdkShim<AdkNamespace>(async () => {
  if (!registeredResolver) {
    throw new Error(
      'No resolver has been registered for the ambient `adk` shim. Call registerAdkResolver(resolve) ' +
        'before adk.resolve(), adk.get(), or reading adk.proxy.'
    )
  }
  const bundle = await registeredResolver()
  ambientResolvedOnce = true
  return bundle
})
