/**
 * Node `child_process`-backed {@link @nhtio/adk/batteries/isolation!IsolationTransport} — forks (or
 * BYO-spawns) a guest process and wraps its IPC channel in the `PortLike` duck the wire protocol is
 * built over.
 *
 * @remarks
 * This module is NODE-ONLY: it imports `node:child_process` directly (unlike `serve.ts`'s guest-side
 * duck detection, which never imports `node:*` so it stays loadable in a Worker/browser bundle). See
 * this subpath's `index.ts` for why a real process — rather than a `worker_threads` `Worker` — is the
 * right host-side primitive for WP3.
 *
 * Two ways to obtain the child:
 *
 * - `{ modulePath, forkOptions? }` — the common case. Calls node's own `child_process.fork(modulePath,
 *   forkOptions)`. Unless the caller's `forkOptions` explicitly sets `serialization`, this pins
 *   `serialization: 'advanced'` (V8's structured-clone algorithm over the IPC channel) rather than
 *   node's default `'json'`. This matters because `codec.ts` treats `TypedArray`/`ArrayBuffer`/
 *   `DataView`/`Date`/`RegExp`/`Map`/`Set` as OPAQUE traversal leaves that ship **raw**, trusting the
 *   transport to carry them faithfully — under default JSON serialization a `Float32Array` argument
 *   would silently degrade to a plain `{0: ..., 1: ...}` object on arrival (empirically confirmed: a
 *   `fork()` with no `serialization` override loses `instanceof Float32Array` across the wire). If a
 *   caller forces `forkOptions: { serialization: 'json' }` anyway, tier-0 (`raw`) round-trips are
 *   restricted to JSON-safe values for THOSE exotic containers; the codec's auto-escalation to tier-1/2
 *   still carries functions/Errors/custom-encodables correctly (just paying the `@nhtio/encoder`
 *   encode/decode cost) — only raw-tier TypedArray/Map/Set/Date/RegExp fidelity is at risk, and only
 *   when the caller opted out of the default explicitly.
 * - `{ spawn }` — a {@link ChildResolver} BYO-spawner seam for callers who need their own process
 *   manager (pooling, custom stdio wiring, sandboxing) or who spawn via a wrapper library instead of
 *   `fork()` directly. The resolver must return (or resolve to) an {@link IsolatedChildLike} — see that
 *   type's doc for the exact surface this module was empirically verified against, including execa≥9.
 *
 * These two forms are mutually exclusive and validated eagerly (this subpath's own local joi schema —
 * WP1's `validation.ts` is not touched).
 *
 * `terminate()` sends `SIGTERM` (or the caller's configured signal) and does NOT itself wait for exit
 * or run any grace period of its own — `host.ts`'s `dispose()` already sends a `shutdown` envelope and
 * waits `disposeGraceMs` for the guest to exit voluntarily before calling `transport.terminate()`
 * unconditionally; duplicating a grace window here would just double it. An `'exit'` that fires while
 * `terminate()`/`recycle()` is in progress is expected and never reported as a crash; any other exit
 * (including a non-zero code, e.g. `process.exit(7)` in the guest) or an `'error'` event on the child
 * fires {@link @nhtio/adk/batteries/isolation!IsolationTransport.onCrash}. `recycle()` (driven by
 * `host.ts`, not implemented in this module) re-enters this same transport's `connect()`, which forks
 * (or re-invokes the resolver) a brand-new child every time — there is no child reuse across recycles.
 */

import { fork } from 'node:child_process'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { validator, ValidationError } from '@nhtio/validation'
import {
  createIsolatedService,
  E_INVALID_ISOLATION_OPTIONS,
  E_ISOLATION_UNSUPPORTED_ENV,
} from '@nhtio/adk/batteries/isolation'
import type { ForkOptions } from 'node:child_process'
import type {
  CrashInfo,
  IsolatedService,
  IsolatedServiceOptions,
  IsolatedServiceSpec,
  IsolationTransport,
  PortLike,
} from '@nhtio/adk/batteries/isolation'

/**
 * The minimal Node `ChildProcess`-shaped duck this transport drives. Structurally satisfied by BOTH:
 *
 * - the object returned by `node:child_process`'s own `fork()`, and
 * - an `execa`≥9 subprocess spawned with `{ ipc: true }` — empirically verified: execa's
 *   `Subprocess<OptionsType>` type is `Omit<ChildProcess, keyof ExecaCustomSubprocess<OptionsType>> &
 *   ExecaCustomSubprocess<OptionsType>`, i.e. it keeps the classic Node `ChildProcess` EventEmitter
 *   surface (`.send()`, `.on('message'|'exit'|'error', ...)`, `.kill()`, `.connected`) alongside
 *   execa's own promise-based `sendMessage()`/`getEachMessage()` API. This transport only ever uses the
 *   classic EventEmitter surface, so an execa `{ ipc: true }` subprocess satisfies this duck WITHOUT
 *   any adapter.
 *
 * execa's channel, like node's own `fork()`, defaults to JSON-style serialization unless the
 * subprocess is spawned with `serialization: 'advanced'` (execa forwards that option straight to the
 * underlying `child_process.fork()` it uses internally for `ipc: true`) — the same "pin `advanced` for
 * exotic-value fidelity" requirement documented on {@link ForkIsolatedOptions} applies whether the
 * child came from this module's own `fork()` call or from a caller-supplied {@link ChildResolver}.
 *
 * @remarks
 * A {@link ChildResolver} must NOT itself attach a `'message'` listener to the child it returns before
 * handing it back to this transport (e.g. for logging). Node buffers a child's `message`/`ipc` events
 * until the FIRST listener is attached, then flushes the whole buffer to that one listener exactly
 * once — a resolver-side listener attached first (even just to log) permanently steals the buffered
 * `ready` envelope from `connect()`'s own listener, which then waits out `readyTimeoutMs` for a `ready`
 * that already came and went. execa's `Subprocess` additionally proxies raw child events through its
 * own internal debounced `message` re-emitter (see execa's `lib/ipc/forward.js`), so this applies to
 * execa subprocesses too — empirically confirmed by instrumenting a resolver with a diagnostic
 * `subprocess.on('message', ...)` and observing the resulting connection hang.
 *
 * A {@link ChildResolver} that returns an execa `{ ipc: true }` subprocess should attach its own
 * no-op `.catch(() => {})` to it before returning. execa's subprocess is ITSELF a promise (via
 * `mergePromise`) that settles REJECTED on a non-zero exit or termination signal — including the
 * ordinary `SIGTERM` this transport's `terminate()` sends on every `dispose()`/`recycle()`. Since this
 * transport only ever drives the classic EventEmitter surface (never awaits/`.then()`s the child
 * itself — see this module's `spawnChild` remarks for why an unguarded `await`/`return` of a thenable
 * child is unsafe in the first place), nothing else ever attaches a rejection handler; without one, a
 * routine `terminate()` reports as an unhandled promise rejection.
 */
export interface IsolatedChildLike {
  /** Send a message across the IPC channel. Returns `false` (or void, depending on the implementation)
   *  when the channel is closed/backed-up; this transport does not currently act on that return value. */
  send?(msg: unknown): boolean | void
  /** Subscribe to a child lifecycle/IPC event (`'message'`, `'exit'`, `'error'`). Listener param typed
   *  `any[]` to structurally match node's own `ChildProcess#on` overload set (whose listener signatures
   *  are themselves `(...args: any[]) => void`). */
  on(event: string, fn: (...args: any[]) => void): unknown
  /** Unsubscribe, mirroring `.on`. Optional — some resolvers may return a duck without it; this
   *  transport degrades to leaking the listener rather than throwing (the process is short-lived and
   *  torn down on `terminate()`/`recycle()` regardless). */
  off?(event: string, fn: (...args: any[]) => void): unknown
  /** Alias some ducks expose instead of/alongside `off`. */
  removeListener?(event: string, fn: (...args: any[]) => void): unknown
  /** Send a termination signal to the child. */
  kill(signal?: NodeJS.Signals | number): boolean | void
  /** Whether the IPC channel is currently open. Read once at connect time for a `send`-before-`connect`
   *  sanity check; not polled thereafter. */
  connected?: boolean
}

/**
 * A BYO-spawner resolver — the seam for callers who need their own process manager (a pool, custom
 * stdio, a sandboxing wrapper, or a library like `execa`) instead of this module's own default
 * `fork()`. Invoked once per `connect()` (including every `recycle()`), i.e. once per guest spawn.
 *
 * @remarks
 * The resolver receives the fully-resolved {@link
 * @nhtio/adk/batteries/isolation!IsolatedServiceSpec} so it can name/label the spawned process (e.g. for
 * logging), but is otherwise free to spawn however it likes — this transport only requires the
 * returned value to satisfy {@link IsolatedChildLike}.
 *
 * A returned execa `{ ipc: true }` subprocess is itself thenable (execa mixes `.then`/`.catch`/
 * `.finally` onto it so it can double as "the child" and "a promise for its exit result"). This
 * transport's own `spawnChild` internals guard against that value being mistaken for a real `Promise`
 * and adopted (which would silently defer "spawned" until the child EXITS) — a resolver author does not
 * need to do anything special here, this is called out purely so the mechanism is documented in one
 * place close to where a resolver returns its child.
 */
export type ChildResolver = (ctx: {
  spec: IsolatedServiceSpec
}) => IsolatedChildLike | Promise<IsolatedChildLike>

/** The `{ modulePath, forkOptions? }` variant of {@link ForkIsolatedOptions} — spawns via this
 *  module's own `node:child_process.fork()` call. */
export interface ForkIsolatedModuleOptions {
  /** Path to the guest's entry module — passed straight through to `child_process.fork()`. Must be a
   *  runnable module (already bundled/transpiled if it isn't plain CommonJS/ESM node can load
   *  directly — `fork()` cannot load a `.ts` file itself). */
  modulePath: string | URL
  /** Forwarded to `child_process.fork()`. Unless this sets `serialization` explicitly, this transport
   *  pins `serialization: 'advanced'` — see this module's top-level remarks. */
  forkOptions?: ForkOptions
  /** Absent in this variant — mutually exclusive with `modulePath`/`forkOptions`. See {@link
   *  ForkIsolatedResolverOptions} for the BYO-spawner variant. */
  spawn?: never
}

/** The `{ spawn }` variant of {@link ForkIsolatedOptions} — spawns via a caller-supplied {@link
 *  ChildResolver} instead of this module's own `fork()`. */
export interface ForkIsolatedResolverOptions {
  /** Absent in this variant — mutually exclusive with `spawn`. See {@link ForkIsolatedModuleOptions}. */
  modulePath?: never
  /** Absent in this variant — mutually exclusive with `spawn`. See {@link ForkIsolatedModuleOptions}. */
  forkOptions?: never
  /** BYO-spawner resolver, invoked once per `connect()`/`recycle()`. See {@link ChildResolver}. */
  spawn: ChildResolver
}

/**
 * Options accepted by {@link forkIsolated}/{@link createChildProcessTransport} — extends `host.ts`'s
 * {@link @nhtio/adk/batteries/isolation!IsolatedServiceOptions} with exactly one of the two mutually
 * exclusive spawn shapes: {@link ForkIsolatedModuleOptions} (the common `fork()`-a-module case) or
 * {@link ForkIsolatedResolverOptions} (BYO spawner). Supplying both `modulePath`/`forkOptions` AND
 * `spawn` (or neither) fails eager validation with {@link
 * @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS}.
 */
export type ForkIsolatedOptions = IsolatedServiceOptions &
  (ForkIsolatedModuleOptions | ForkIsolatedResolverOptions)

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/** Local (this-subpath-only) validator for the spawn-shape half of {@link ForkIsolatedOptions} — WP1's
 *  shared `validation.ts` is not modified; this schema only covers the fields this module adds. */
const forkIsolatedSpawnShapeSchema = validator
  .object<{ modulePath?: string | URL; forkOptions?: object; spawn?: unknown }>({
    modulePath: validator
      .alternatives(
        validator.string().min(1),
        validator.custom((v, h) => (isInstanceOf(v, 'URL', URL) ? v : h.error('any.invalid')))
      )
      .optional(),
    forkOptions: validator.object().unknown(true).optional(),
    spawn: validator.function().optional(),
  })
  .unknown(true)
  .xor('modulePath', 'spawn')
  .with('forkOptions', 'modulePath')

/**
 * Validate the spawn-shape half of a {@link ForkIsolatedOptions} bag: exactly one of `modulePath` /
 * `spawn` must be present, and `forkOptions` may only accompany `modulePath`.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} on failure.
 */
const validateForkIsolatedOptions = (input: object): void => {
  const { error } = forkIsolatedSpawnShapeSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error && isValidationError(error)) {
    throw new E_INVALID_ISOLATION_OPTIONS([formatValidationDetails(error)])
  }
}

/** Structural check for whether the current process can host a `child_process`-backed transport at
 *  all (i.e. we are actually running under node, not e.g. a browser polyfill of parts of this module's
 *  imports). Mirrors `serve.ts`'s guest-side duck check, but on the HOST side: node's own `process`
 *  global always exposes `.pid`, which a browser/worker `globalThis.process` shim would not. */
const isNodeHost = (): boolean =>
  typeof globalThis.process?.pid === 'number' && typeof fork === 'function'

/** Reason string threaded into `onCrash` when the child's `'exit'` fires unexpectedly (i.e. not during
 *  `terminate()`/`recycle()`). */
const exitReason = (code: number | null, signal: NodeJS.Signals | null): string =>
  signal
    ? `child process exited via signal ${signal}`
    : `child process exited with code ${code ?? 'null'}`

/**
 * Build a real {@link @nhtio/adk/batteries/isolation!IsolationTransport} over a node `child_process`
 * (or BYO-resolved) child. `connect()` spawns a fresh child every call (including every `recycle()` —
 * there is no child reuse); `terminate()` sends `SIGTERM` (or `forkOptions.killSignal`/the resolver's
 * own convention) without waiting for exit or imposing any grace period of its own (`host.ts` already
 * owns that via `disposeGraceMs`).
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_UNSUPPORTED_ENV} when called outside node
 *   (no `process.pid` / no `child_process.fork`).
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} when `options` fails the
 *   mutual-exclusivity check documented on {@link ForkIsolatedOptions}.
 */
export const createChildProcessTransport = <S extends IsolatedServiceSpec>(
  spec: S,
  options: ForkIsolatedOptions
): IsolationTransport => {
  if (!isNodeHost()) {
    throw new E_ISOLATION_UNSUPPORTED_ENV([
      'createChildProcessTransport requires a node host (process.pid / child_process.fork unavailable) — this transport cannot run in a browser/worker environment',
    ])
  }
  validateForkIsolatedOptions(options)

  let child: IsolatedChildLike | undefined
  let terminating = false
  const crashListeners = new Set<(info: CrashInfo) => void>()
  let messageListener: ((msg: unknown) => void) | undefined
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let errorListener: ((err: Error) => void) | undefined

  const detachChildListeners = (): void => {
    if (!child) return
    const off = (event: string, fn: ((...a: never[]) => void) | undefined): void => {
      if (!fn) return
      if (child!.off) child!.off(event, fn as never)
      else if (child!.removeListener) child!.removeListener(event, fn as never)
    }
    off('message', messageListener as never)
    off('exit', exitListener as never)
    off('error', errorListener as never)
    messageListener = undefined
    exitListener = undefined
    errorListener = undefined
  }

  // Deliberately NOT an `async function`, and deliberately returns a BOXED `{ child }` wrapper rather
  // than the child itself. A resolver-supplied child (e.g. an execa `{ ipc: true }` subprocess) is
  // ITSELF thenable — execa's `mergePromise` mixes `.then`/`.catch`/`.finally` onto the subprocess
  // object so `execa(...)`'s return value can be both "the child" and "awaited for its exit result".
  // `return`ing (or `await`ing) that value directly from inside an `async function` triggers the
  // language's thenable-ADOPTION rule: the engine treats the returned/awaited thenable as a real
  // Promise and defers settling until IT resolves — which for an execa subprocess is when the CHILD
  // PROCESS EXITS, not when it spawns. That silently turns "spawn a child" into "wait for the child to
  // exit", hanging every caller of `connect()` for the child's entire lifetime. Empirically confirmed:
  // an `async spawnChild` doing `return options.spawn({ spec })` hangs even when the resolver itself is
  // a plain (non-async) function — the adoption happens at `spawnChild`'s own `return`, not the
  // resolver's. Boxing the child inside a fresh plain object (which has no `.then` of its own) before
  // it ever crosses a `return`/`await` boundary avoids triggering adoption anywhere in the chain.
  const spawnChild = (): Promise<{ child: IsolatedChildLike }> => {
    if ('spawn' in options && options.spawn) {
      const maybe = options.spawn({ spec })
      // A genuine `Promise` (the resolver itself is async/needs to await setup) must still be awaited;
      // a resolver-returned execa subprocess is thenable-DUCK (see this function's remarks) but is not
      // actually `instanceof Promise`, so this check correctly tells the two apart without adopting the
      // duck.
      return isInstanceOf(maybe, 'Promise', Promise)
        ? maybe.then((resolvedChild) => ({ child: resolvedChild }))
        : Promise.resolve({ child: maybe })
    }
    const forkOptions = options.forkOptions ?? {}
    const resolvedForkOptions: ForkOptions =
      forkOptions.serialization !== undefined
        ? forkOptions
        : { ...forkOptions, serialization: 'advanced' }
    return Promise.resolve({ child: fork(options.modulePath!, resolvedForkOptions) })
  }

  const connect = async (): Promise<PortLike> => {
    terminating = false
    const { child: spawned } = await spawnChild()
    child = spawned

    const port: PortLike = {
      post: (msg) => {
        spawned.send?.(msg)
      },
      onMessage: (fn) => {
        const listener = (msg: unknown): void => fn(msg)
        messageListener = listener
        spawned.on('message', listener as never)
        return () => {
          if (spawned.off) spawned.off('message', listener as never)
          else if (spawned.removeListener) spawned.removeListener('message', listener as never)
        }
      },
    }

    exitListener = (code, signal) => {
      if (terminating) return
      const info: CrashInfo = { reason: exitReason(code, signal), code: code ?? null, signal }
      for (const fn of crashListeners) fn(info)
    }
    errorListener = (err) => {
      if (terminating) return
      const info: CrashInfo = { reason: err.message, code: null, signal: null }
      for (const fn of crashListeners) fn(info)
    }
    spawned.on('exit', exitListener as never)
    spawned.on('error', errorListener as never)

    return port
  }

  const terminate = (): void => {
    terminating = true
    detachChildListeners()
    if (child) {
      const signal = ('forkOptions' in options && options.forkOptions?.killSignal) || 'SIGTERM'
      child.kill(signal as NodeJS.Signals)
    }
    child = undefined
  }

  return {
    connect,
    terminate,
    onCrash: (fn) => {
      crashListeners.add(fn)
      return () => crashListeners.delete(fn)
    },
  }
}

/**
 * Sugar over {@link createChildProcessTransport} + {@link
 * @nhtio/adk/batteries/isolation!createIsolatedService} — the one-call entry point most callers want:
 * fork a guest module (or BYO-spawn one) and get back a ready-to-use {@link
 * @nhtio/adk/batteries/isolation!IsolatedService}.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_UNSUPPORTED_ENV} when called outside node.
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} when `options` fails the
 *   mutual-exclusivity check documented on {@link ForkIsolatedOptions}, or when `createIsolatedService`'s
 *   own option validation fails.
 */
export const forkIsolated = <S extends IsolatedServiceSpec>(
  spec: S,
  options: ForkIsolatedOptions
): IsolatedService<S> => {
  const transport = createChildProcessTransport(spec, options)
  // `options` also carries this subpath's own spawn-shape fields (`modulePath`/`forkOptions`/`spawn`),
  // which `createIsolatedService` must never see — `host.ts` validates its options bag against WP1's
  // `isolatedServiceOptionsSchema` with `.unknown(false)`, so passing the raw bag through would fail
  // eager validation on fields that schema (correctly) doesn't know about. Strip them here rather than
  // loosen WP1's shared schema.
  const spawnShapeKeys = new Set(['modulePath', 'forkOptions', 'spawn'])
  const hostOptions = Object.fromEntries(
    Object.entries(options).filter(([key]) => !spawnShapeKeys.has(key))
  ) as IsolatedServiceOptions
  return createIsolatedService(spec, transport, hostOptions)
}
