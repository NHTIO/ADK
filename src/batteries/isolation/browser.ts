/**
 * Web Worker {@link IsolationTransport} + `spawnIsolated` convenience — WP2 of the isolation battery.
 *
 * @remarks
 * Implements the `IsolationTransport`/`PortLike` ducks declared (and treated as a read-only contract) in
 * `types.ts` against a real browser `Worker`, and nothing else: this module never touches `protocol.ts`,
 * `host.ts`, `serve.ts`, or `codec.ts` directly — it only produces the transport `createIsolatedService`
 * (from `host.ts`) drives.
 *
 * The project's tsconfig limits `lib` to `ESNext`, so the DOM `Worker`/`WorkerOptions` types referenced
 * below are not in scope by default (`ErrorEvent`/`MessageEvent` ARE ambiently available via
 * `@types/node`'s `web-globals/*.d.ts` global augmentation, but the DOM `Worker` class is not — only
 * node's unrelated `worker_threads.Worker` is). Re-declare here the **minimum** surface this module
 * touches, mirroring the OPFS storage battery's established convention (`src/batteries/storage/opfs/
 * index.ts`) — structurally compatible with the real DOM types, so callers pass real `Worker` instances
 * straight through.
 */

import { isObject } from '@nhtio/adk/guards'
import { createIsolatedService } from './host'
import { E_ISOLATION_UNSUPPORTED_ENV } from './exceptions'
import { validateSpawnIsolatedOptions } from './validation'
import type { IsolatedService, IsolatedServiceOptions } from './host'
import type { CrashInfo, IsolatedServiceSpec, IsolationTransport, PortLike } from './types'

// ── Minimal locally-declared DOM surface (no `lib: "dom"` in this project's tsconfig) ──────────────────

/** Minimal subset of the DOM `MessageEvent` interface this module touches. */
export interface BrowserMessageEvent {
  /** The message payload delivered via `postMessage`. */
  readonly data: unknown
}

/** Minimal subset of the DOM `ErrorEvent` interface this module touches — fired on a `Worker` instance
 *  when an uncaught error escapes the worker's top-level scope. */
export interface BrowserErrorEvent {
  /** Human-readable error message. */
  readonly message: string
}

/** Minimal subset of the DOM `WorkerOptions` dictionary this module forwards verbatim to `new
 *  Worker(url, options)` — used ONLY for the `string | URL` spawn form (a caller-supplied
 *  {@link WorkerResolver} constructs its own `Worker` however it likes, this dictionary never applies
 *  there). Classic scripts are the default (`type` omitted) — matching this repo's own LiteRT-LM Worker
 *  prototype (`docs/.vitepress/theme/components/agent/litert_lm_worker_proxy.ts`), which deliberately
 *  avoids `{ type: 'module' }` because Emscripten-style glue calls `importScripts()`, illegal in a module
 *  worker. Pass `{ type: 'module' }` explicitly when the guest script is an ES module. */
export interface BrowserWorkerOptions {
  /** `'classic'` (default when omitted) or `'module'`. */
  type?: 'classic' | 'module'
  /** Worker credentials mode, forwarded verbatim. */
  credentials?: 'omit' | 'same-origin' | 'include'
  /** A developer-facing name for the worker (surfaced in devtools). */
  name?: string
}

/** Minimal subset of the DOM `Worker` interface this module touches. Structurally compatible with the
 *  real DOM `Worker` — callers (and {@link WorkerResolver} implementations) pass/construct real `Worker`
 *  instances directly. */
export interface BrowserWorker {
  /** Post a message to the worker, optionally transferring ownership of listed transferables. */
  postMessage(message: unknown, transfer?: unknown[]): void
  /** Subscribe to the worker's `'message'` event (fired on every `postMessage` received from the guest). */
  addEventListener(type: 'message', listener: (ev: BrowserMessageEvent) => void): void
  /** Subscribe to the worker's `'error'` event (fired when an uncaught error escapes the guest's
   *  top-level scope). */
  addEventListener(type: 'error', listener: (ev: BrowserErrorEvent) => void): void
  /** Subscribe to the worker's `'messageerror'` event (fired when a received message could not be
   *  deserialized). */
  addEventListener(type: 'messageerror', listener: (ev: BrowserMessageEvent) => void): void
  /** Unsubscribe a previously-added listener. */
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (ev: never) => void
  ): void
  /** Terminate the worker immediately — no further events, no graceful shutdown at this layer. */
  terminate(): void
}

/** Ambient DOM globals this module reads. Declared locally (see the module doc) rather than pulled in
 *  via a `lib: "dom"` tsconfig change — `Worker`/`URL`'s constructor overload taking `WorkerOptions` are
 *  the only DOM-shaped pieces this file touches beyond what `@types/node`'s web-globals already provide
 *  (`ErrorEvent`/`MessageEvent`/`URL`/`Blob` are ambient there). */
declare const Worker: {
  new (scriptURL: string | URL, options?: BrowserWorkerOptions): BrowserWorker
}

// ── BYO spawner seam ────────────────────────────────────────────────────────────────────────────────

/**
 * Bring-your-own Worker spawner — the first-class seam for handing {@link spawnIsolated}/{@link
 * createWorkerTransport} a `Worker` constructed however the caller's bundler/pooling strategy demands
 * (a `new Worker(new URL(...), import.meta.url)` Vite/webpack pattern, a worker pool that recycles
 * threads, a test harness's Blob-URL worker, etc.). Called once per `connect()` (including every
 * `recycle()`) — see {@link createWorkerTransport}'s remarks for why this makes a resolver the SINGLE
 * source of Worker creation for a given transport.
 */
export type WorkerResolver = (ctx: {
  spec: IsolatedServiceSpec
}) => BrowserWorker | Promise<BrowserWorker>

/** Options accepted by {@link spawnIsolated}/{@link createWorkerTransport}, layered on top of {@link
 *  IsolatedServiceOptions}. */
export interface SpawnIsolatedOptions extends IsolatedServiceOptions {
  /**
   * How to obtain the guest `Worker`:
   *
   * - A `string | URL` — the guest script's URL; `createWorkerTransport` constructs `new Worker(url,
   *   workerOptions)` itself on every `connect()`.
   * - A {@link WorkerResolver} — full control: bring a `Worker` from any bundler pattern or pool. Invoked
   *   with `{ spec }` and may return a `Worker` synchronously or via a `Promise`.
   */
  worker: string | URL | WorkerResolver
  /** Forwarded verbatim to `new Worker(url, workerOptions)` — used ONLY for the `string | URL` spawn
   *  form (ignored when `worker` is a {@link WorkerResolver}, which constructs its own `Worker`).
   *  Default: classic script (no `type`) — see {@link BrowserWorkerOptions}'s doc for why. */
  workerOptions?: BrowserWorkerOptions
}

const isWorkerResolver = (worker: string | URL | WorkerResolver): worker is WorkerResolver =>
  typeof worker === 'function'

const isUrlLike = (value: unknown): value is URL =>
  isObject(value) && typeof (value as { href?: unknown }).href === 'string'

// ── Transfer-marker unwrapping ──────────────────────────────────────────────────────────────────────

/** A single {@link WireValue}-shaped slot this module scans for a `transfer` marker. Deliberately NOT
 *  imported from `protocol.ts` (this module must not depend on the wire envelope shapes beyond this one
 *  structural field) — see {@link collectTransferables}'s remarks. */
interface WireValueLike {
  enc?: unknown
  v?: unknown
  transfer?: unknown[]
}

const asWireValueLike = (value: unknown): WireValueLike | undefined =>
  isObject(value) ? (value as WireValueLike) : undefined

/**
 * Collect every `transfer` list found on an outbound envelope's known `WireValue` positions —
 * `call.args[]` / `stream:start.args[]` (arrays), `result.value` (single), `stream:delta.delta` (single)
 * — into one flat transferables list for `postMessage(msg, transferables)`. Deliberately narrow and
 * cheap: rather than deep-traverse the whole envelope, this only reads the handful of top-level fields
 * the wire protocol ever puts a `WireValue` in, so envelopes without those fields (`ready`, `abort`,
 * `stream:cancel`, `shutdown`, `stream:end`, error variants) are skipped in O(1) with no property access
 * beyond the initial shape check.
 */
const collectTransferables = (envelope: unknown): unknown[] => {
  const msg = asWireValueLike(envelope)
  if (!msg) return []
  const found: unknown[] = []
  const take = (candidate: unknown): void => {
    const wv = asWireValueLike(candidate)
    if (wv && Array.isArray(wv.transfer)) found.push(...wv.transfer)
  }
  const args = (msg as { args?: unknown }).args
  if (Array.isArray(args)) {
    for (const a of args) take(a)
  }
  take((msg as { value?: unknown }).value)
  take((msg as { delta?: unknown }).delta)
  return found
}

// ── Worker transport ─────────────────────────────────────────────────────────────────────────────────

/**
 * Build an {@link IsolationTransport} that spawns/re-spawns a real browser `Worker` per {@link
 * SpawnIsolatedOptions.worker}.
 *
 * @remarks
 * `connect()` resolves the `Worker` (constructing it for a `string | URL` spec, or awaiting a {@link
 * WorkerResolver}), wraps it in a {@link PortLike} (`post` → `postMessage` with any {@link
 * @nhtio/adk/batteries/isolation!transfer}-marked values unwrapped into the transfer list; `onMessage` →
 * `addEventListener('message', ...)`), and wires the worker's `'error'`/`'messageerror'` events to the
 * transport's `onCrash` handlers. `terminate()` calls `worker.terminate()`. `createIsolatedService`'s
 * `recycle()` re-enters this SAME `connect()` — since a resolver is invoked fresh on every call, it is
 * the single source of Worker creation for the service's whole lifetime (every respawn goes through it,
 * never a cached instance).
 */
export const createWorkerTransport = (
  spec: IsolatedServiceSpec,
  options: SpawnIsolatedOptions
): IsolationTransport => {
  const resolved = validateSpawnIsolatedOptions(options)
  if (typeof Worker === 'undefined') {
    throw new E_ISOLATION_UNSUPPORTED_ENV([
      'createWorkerTransport requires a browser Worker global — none was found on globalThis',
    ])
  }

  let currentWorker: BrowserWorker | undefined
  let onErrorListener: ((ev: BrowserErrorEvent) => void) | undefined
  let onMessageErrorListener: ((ev: BrowserMessageEvent) => void) | undefined
  const crashHandlers = new Set<(info: CrashInfo) => void>()

  const resolveWorker = async (): Promise<BrowserWorker> => {
    const { worker, workerOptions } = resolved
    if (isWorkerResolver(worker)) {
      return await worker({ spec })
    }
    const url = typeof worker === 'string' || isUrlLike(worker) ? worker : String(worker)
    return new Worker(url, workerOptions)
  }

  const teardownListeners = (): void => {
    if (currentWorker && onErrorListener) {
      currentWorker.removeEventListener('error', onErrorListener)
    }
    if (currentWorker && onMessageErrorListener) {
      currentWorker.removeEventListener('messageerror', onMessageErrorListener)
    }
    onErrorListener = undefined
    onMessageErrorListener = undefined
  }

  const connect = async (): Promise<PortLike> => {
    const worker = await resolveWorker()
    currentWorker = worker

    onErrorListener = (ev: BrowserErrorEvent): void => {
      const reason = ev.message || `Isolated Worker for service "${spec.name}" crashed`
      for (const fn of crashHandlers) fn({ reason })
    }
    onMessageErrorListener = (): void => {
      for (const fn of crashHandlers) {
        fn({
          reason: `Isolated Worker for service "${spec.name}" sent an undeserializable message`,
        })
      }
    }
    worker.addEventListener('error', onErrorListener)
    worker.addEventListener('messageerror', onMessageErrorListener)

    const port: PortLike = {
      post: (msg) => {
        const transferables = collectTransferables(msg)
        if (transferables.length > 0) {
          worker.postMessage(msg, transferables)
        } else {
          worker.postMessage(msg)
        }
      },
      onMessage: (fn) => {
        const listener = (ev: BrowserMessageEvent): void => fn(ev.data)
        worker.addEventListener('message', listener)
        return () => worker.removeEventListener('message', listener as never)
      },
    }
    return port
  }

  const terminate = (): void => {
    teardownListeners()
    currentWorker?.terminate()
    currentWorker = undefined
  }

  return {
    connect,
    terminate,
    onCrash: (fn) => {
      crashHandlers.add(fn)
      return () => crashHandlers.delete(fn)
    },
  }
}

/**
 * Sugar for `createIsolatedService(spec, createWorkerTransport(spec, options), options)` — spawn a
 * real Worker-backed {@link IsolatedService} in one call.
 *
 * @remarks
 * The transport-only keys (`worker`/`workerOptions`) are stripped before the remaining options reach
 * `createIsolatedService` — its validator is deliberately strict (unknown keys rejected), accepting
 * only the base {@link IsolatedServiceOptions} shape; the transport-only keys were already validated
 * (and consumed) by {@link createWorkerTransport}.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_UNSUPPORTED_ENV} when no browser `Worker`
 *   global is present.
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} when `options` fails
 *   validation.
 */
export const spawnIsolated = <S extends IsolatedServiceSpec>(
  spec: S,
  options: SpawnIsolatedOptions
): IsolatedService<S> => {
  const transport = createWorkerTransport(spec, options)
  const serviceOptions: IsolatedServiceOptions = { ...options }
  delete (serviceOptions as Partial<SpawnIsolatedOptions>).worker
  delete (serviceOptions as Partial<SpawnIsolatedOptions>).workerOptions
  return createIsolatedService(spec, transport, serviceOptions)
}
