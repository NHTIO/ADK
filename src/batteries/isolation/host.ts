/**
 * Host-side facade builder — `createIsolatedService(spec, transport, options?)` drives an
 * {@link IsolationTransport} (spawn/terminate/crash duck), wires a {@link HostEndpoint} to the
 * connected {@link PortLike}, and returns an {@link IsolatedService} whose `.api` is a plain object of
 * promise-returning methods / `ReadableStream`-returning streams matching `spec`.
 *
 * @remarks
 * `.api` is built once, up front, by iterating `spec.methods`/`spec.streams` — NOT a `Proxy` — so every
 * call site gets ordinary, debuggable function properties. Calls/stream-starts made before the guest's
 * `ready` envelope arrives queue transparently inside `HostEndpoint`; a `readyTimeoutMs` watchdog (default
 * 30s) rejects the connection attempt with `E_ISOLATION_READY_TIMEOUT` if `ready` never arrives.
 *
 * `dispose()` asks the guest to shut down gracefully, gives it `disposeGraceMs` (default 2000ms) to exit
 * on its own, then forces `transport.terminate()` regardless. `recycle()` terminates and reconnects
 * through the SAME `transport.connect()` — the returned `IsolatedService` object's identity and every
 * `.on(...)` subscription survive a recycle; only in-flight work is rejected with `E_ISOLATED_TERMINATED`.
 *
 * A transport-reported crash (`transport.onCrash`) rejects in-flight calls/streams with
 * `E_ISOLATED_CRASHED`, flips `state` to `'crashed'`, and fans out to `.onCrash(...)` subscribers.  With
 * `autoRespawn: { policy }` opted in, a crash instead consults `policy.record()`: `'respawn'` triggers an
 * automatic `recycle()`, `'giveUp'` leaves the service crashed. Default: off.
 */

import { HostEndpoint } from './protocol'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { validateIsolatedServiceOptions } from './validation'
import { decodeArgument, encodeArgument, fromWireError } from './codec'
import { E_ISOLATED_CRASHED, E_ISOLATED_TERMINATED, E_ISOLATION_READY_TIMEOUT } from './exceptions'
import {
  emitIsolationReport,
  hasIsolationHook,
  type IsolationObservabilityHooks,
} from './observability'
import type { CrashPolicy } from './crash_policy'
import type {
  CodecMode,
  CrashInfo,
  IsolatedEventListener,
  IsolatedFacade,
  IsolatedServiceSpec,
  IsolationTransport,
} from './types'

/** Options accepted by {@link createIsolatedService}. */
export interface IsolatedServiceOptions extends IsolationObservabilityHooks {
  /** Max time to wait for the guest's `ready` envelope after `transport.connect()` resolves. Default
   *  `30_000`. Rejects the pending `connect`/first call with `E_ISOLATION_READY_TIMEOUT`. */
  readyTimeoutMs?: number
  /** Grace period `dispose()` gives the guest to exit cleanly after `shutdown` before forcing
   *  `transport.terminate()`. Default `2000`. */
  disposeGraceMs?: number
  /** Opt-in automatic recovery: on a transport-reported crash, consult `policy.record()` and `recycle()`
   *  automatically when it returns `'respawn'`. Default: not set (crashes are surfaced, never auto-healed). */
  autoRespawn?: { policy: CrashPolicy }
  /** Classes to register with `@nhtio/encoder`'s custom-encodable round-trip on this side. */
  encodables?: ReadonlyArray<{ readonly name: string }>
}

/** Lifecycle state of an {@link IsolatedService}. */
export type IsolatedServiceState = 'starting' | 'ready' | 'crashed' | 'disposed'

/** The host-side handle `createIsolatedService` returns. */
export interface IsolatedService<S extends IsolatedServiceSpec> {
  /** The callable facade — one function per declared method/stream. */
  readonly api: IsolatedFacade<S>
  /** Subscribe to a declared event channel. Returns an unsubscribe function. Subscriptions survive
   *  `recycle()` (the same underlying map is reused across guest respawns). */
  on<K extends keyof S['events'] & string>(channel: K, fn: IsolatedEventListener<S, K>): () => void
  /** Subscribe to crash notifications. Returns an unsubscribe function. */
  onCrash(fn: (info: CrashInfo) => void): () => void
  /** Current lifecycle state. */
  readonly state: IsolatedServiceState
  /** Send `shutdown`, wait up to `disposeGraceMs` for the guest to exit on its own, then force
   *  `transport.terminate()` regardless. Idempotent past the first call. */
  dispose(): Promise<void>
  /** Terminate the current guest and reconnect through the same `transport.connect()`. Object identity
   *  and `.on(...)` subscriptions survive; in-flight calls/streams reject with `E_ISOLATED_TERMINATED`. */
  recycle(): Promise<void>
}

const codecModeFor = (declared: CodecMode | undefined): CodecMode | undefined => declared

/**
 * Build an {@link IsolatedService} over `transport` for `spec`. Connection + the first `ready` handshake
 * begin immediately (fire-and-forget internally); calls made before `ready` queue inside the underlying
 * {@link HostEndpoint} and flush in order once it arrives.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} when `options` fails
 *   validation.
 */
export const createIsolatedService = <S extends IsolatedServiceSpec>(
  spec: S,
  transport: IsolationTransport,
  options?: IsolatedServiceOptions
): IsolatedService<S> => {
  const resolved = validateIsolatedServiceOptions(options)
  const readyTimeoutMs = resolved.readyTimeoutMs ?? 30_000
  const disposeGraceMs = resolved.disposeGraceMs ?? 2000

  let spawnCount = 0
  let state: IsolatedServiceState = 'starting'
  let endpoint: HostEndpoint | undefined
  let disposed = false
  let unsubscribeCrash: (() => void) | undefined

  const eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  const crashListeners = new Set<(info: CrashInfo) => void>()
  const inFlightStreamCancels = new Set<() => void>()

  const emitReport = (
    phase: Parameters<typeof emitIsolationReport>[1],
    extra?: Parameters<typeof emitIsolationReport>[3]
  ): void => emitIsolationReport(resolved, phase, { serviceName: spec.name, spawnCount }, extra)

  /** Resolves once the current guest connection is `ready` (or rejects on timeout/crash-before-ready). */
  let connectPromise: Promise<void> = Promise.resolve()

  const connect = (): Promise<void> => {
    spawnCount += 1
    state = 'starting'
    emitReport('spawn:start')
    const startedAt = Date.now()
    connectPromise = (async () => {
      const port = await transport.connect()
      endpoint = new HostEndpoint(port, {
        onReady: () => {
          // The guest's `encoderAvailable` flag only matters to the guest's own `toWireError` rich-path
          // decision (see serve.ts) — the host only ever DECODES wire errors (`fromWireError`), which
          // self-describes via `WireError.nhtio` being present or absent, so nothing here needs to track
          // it.
          state = 'ready'
        },
        onEvent: (channel, payload) => {
          void (async () => {
            const decoded = await decodeArgument(payload, undefined, `event ${channel}`)
            for (const fn of eventListeners.get(channel) ?? []) fn(decoded)
          })()
        },
        onEnvelope: (dir, envelope) => {
          if (!hasIsolationHook(resolved, dir === 'out' ? 'wire:out' : 'wire:in')) return
          emitReport(dir === 'out' ? 'wire:out' : 'wire:in', { kind: envelope.t })
        },
      })
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new E_ISOLATION_READY_TIMEOUT([readyTimeoutMs]))
        }, readyTimeoutMs)
        const poll = (): void => {
          if (settled) return
          if (endpoint?.isReady) {
            settled = true
            clearTimeout(timer)
            resolve()
            return
          }
          // A guest that crashes BEFORE its `ready` envelope (bogus worker URL, top-level throw in the
          // guest module, immediate child exit) must fail the connection immediately as a crash — not
          // sit out the full ready timeout only to misreport it as E_ISOLATION_READY_TIMEOUT.
          if (state === 'crashed') {
            settled = true
            clearTimeout(timer)
            reject(new E_ISOLATED_CRASHED([spec.name]))
            return
          }
          setTimeout(poll, 0)
        }
        poll()
      })
      emitReport('spawn:ready', { bootMs: Date.now() - startedAt })
    })().catch((err) => {
      state = 'crashed'
      emitReport('spawn:error', { error: err })
      throw err
    })
    return connectPromise
  }

  unsubscribeCrash = transport.onCrash((info) => {
    handleCrash(info)
  })

  const handleCrash = (info: CrashInfo): void => {
    if (state === 'disposed') return
    const inFlight = (endpoint?.pendingCallCount ?? 0) + (endpoint?.openStreamCount ?? 0)
    endpoint?.terminate(`Isolated service "${spec.name}" crashed: ${info.reason}`)
    for (const cancel of inFlightStreamCancels) cancel()
    inFlightStreamCancels.clear()
    state = 'crashed'
    emitReport('crash', { reason: info.reason, code: info.code, signal: info.signal, inFlight })
    for (const fn of crashListeners) {
      try {
        fn(info)
      } catch {
        // A throwing crash subscriber must never break the fan-out to the remaining subscribers.
      }
    }
    if (resolved.autoRespawn) {
      const verdict = resolved.autoRespawn.policy.record()
      emitReport('respawn:auto', { verdict })
      if (verdict === 'respawn') {
        void recycle()
      }
    }
  }

  const ensureReadyOrThrow = (): HostEndpoint => {
    if (state === 'disposed') throw new E_ISOLATED_TERMINATED([spec.name])
    if (state === 'crashed') throw new E_ISOLATED_CRASHED([spec.name])
    if (!endpoint) throw new E_ISOLATED_TERMINATED([spec.name])
    return endpoint
  }

  const callMethod = async (methodName: string, args: unknown[]): Promise<unknown> => {
    await connectPromise
    const ep = ensureReadyOrThrow()
    const descriptor = spec.methods[methodName]
    const mode = codecModeFor(descriptor?.codec)
    // The facade accepts an optional trailing AbortSignal uniformly, regardless of whether the method
    // declared `{ signal: true }` (see `IsolatedFacade` in types.ts). Since descriptors are phantom-typed
    // (no runtime-recoverable argument arity), detect the trailing signal by instance check rather than
    // by position — a signal handed to a method that didn't opt in is simply not forwarded to the guest.
    const trailing = args[args.length - 1]
    const hasTrailingSignal =
      args.length > 0 &&
      typeof AbortSignal !== 'undefined' &&
      isInstanceOf(trailing, 'AbortSignal', AbortSignal)
    const signal = hasTrailingSignal && descriptor?.signal ? (trailing as AbortSignal) : undefined
    const callArgs = hasTrailingSignal ? args.slice(0, -1) : args
    const wireArgs = await Promise.all(
      callArgs.map((a, i) =>
        encodeArgument(a, {
          mode,
          label: `${methodName} args[${i}]`,
          onEscalate: (path, reason) =>
            emitReport('codec:escalate', {
              argPath: `${methodName} args[${i}]${path.length ? `.${path.map(String).join('.')}` : ''}`,
              escalateReason: reason,
            }),
        })
      )
    )
    const start = Date.now()
    emitReport('call:start', { method: methodName })
    const { id, promise } = ep.call(methodName, wireArgs)
    if (signal) {
      const onAbort = (): void => {
        ep.abort(id)
        emitReport('abort:sent', { method: methodName, id })
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const wireResult = await promise
      const result = await decodeArgument(wireResult, mode, `${methodName} result`)
      emitReport('call:settle', {
        method: methodName,
        id,
        durationMs: Date.now() - start,
        ok: true,
      })
      return result
    } catch (err) {
      emitReport('call:settle', {
        method: methodName,
        id,
        durationMs: Date.now() - start,
        ok: false,
        errorMessage: isError(err) ? err.message : String(err),
      })
      throw err
    }
  }

  const startStream = (streamName: string, args: unknown[]): ReadableStream<unknown> => {
    const descriptor = spec.streams[streamName]
    const mode = codecModeFor(descriptor?.codec)
    let deltaCount = 0
    let firstDeltaMs: number | undefined
    const startedAt = Date.now()
    let cancelFn: (() => void) | undefined

    return new ReadableStream<unknown>({
      start: (controller) => {
        void (async () => {
          try {
            await connectPromise
            const ep = ensureReadyOrThrow()
            const wireArgs = await Promise.all(
              args.map((a, i) =>
                encodeArgument(a, {
                  mode,
                  label: `${streamName} args[${i}]`,
                  onEscalate: (path, reason) =>
                    emitReport('codec:escalate', {
                      argPath: `${streamName} args[${i}]${path.length ? `.${path.map(String).join('.')}` : ''}`,
                      escalateReason: reason,
                    }),
                })
              )
            )
            emitReport('stream:start', { streamName })
            const id = ep.startStream(streamName, wireArgs, {
              push: (delta) => {
                void (async () => {
                  deltaCount += 1
                  if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - startedAt
                  try {
                    const decoded = await decodeArgument(delta, mode, `${streamName} delta`)
                    controller.enqueue(decoded)
                  } catch (err) {
                    controller.error(err)
                  }
                })()
              },
              end: () => {
                inFlightStreamCancels.delete(cancelFn!)
                emitReport('stream:end', { streamName, deltaCount, firstDeltaMs })
                controller.close()
              },
              error: (wireError) => {
                void (async () => {
                  inFlightStreamCancels.delete(cancelFn!)
                  const err = await fromWireError(wireError)
                  emitReport('stream:error', { streamName, streamError: err })
                  controller.error(err)
                })()
              },
            })
            cancelFn = () => ep.cancelStream(id)
            inFlightStreamCancels.add(cancelFn)
          } catch (err) {
            controller.error(err)
          }
        })()
      },
      cancel: () => {
        if (cancelFn) {
          inFlightStreamCancels.delete(cancelFn)
          cancelFn()
          emitReport('stream:cancel', { streamName, deltaCount, firstDeltaMs })
        }
      },
    })
  }

  const api = {} as Record<string, (...a: unknown[]) => unknown>
  for (const methodName of Object.keys(spec.methods)) {
    api[methodName] = (...args: unknown[]) => callMethod(methodName, args)
  }
  for (const streamName of Object.keys(spec.streams)) {
    api[streamName] = (...args: unknown[]) => startStream(streamName, args)
  }

  const dispose = async (): Promise<void> => {
    if (state === 'disposed') return
    emitReport('dispose:start')
    const ep = endpoint
    // Ask nicely first (when there's a live, ready endpoint), then give the guest `disposeGraceMs` to
    // exit on its own before forcing `transport.terminate()` unconditionally. Nothing at this layer
    // reports "the guest process/worker actually exited" short of the transport's crash callback (which
    // is reserved for UNEXPECTED exits) — so a graceful shutdown always ends in `transport.terminate()`
    // being called, and `forced` reflects whether shutdown was even attempted vs. skipped outright.
    const attemptedGraceful = Boolean(ep && state === 'ready')
    if (attemptedGraceful) {
      ep!.shutdown()
      await new Promise<void>((resolve) => setTimeout(resolve, disposeGraceMs))
    }
    state = 'disposed'
    unsubscribeCrash?.()
    ep?.terminate(new E_ISOLATED_TERMINATED([spec.name]).message)
    for (const cancel of inFlightStreamCancels) cancel()
    inFlightStreamCancels.clear()
    disposed = true
    await transport.terminate()
    emitReport('dispose:done', { forced: !attemptedGraceful })
  }

  const recycle = async (): Promise<void> => {
    if (disposed) return
    emitReport('recycle:start')
    endpoint?.terminate(new E_ISOLATED_TERMINATED([spec.name]).message)
    for (const cancel of inFlightStreamCancels) cancel()
    inFlightStreamCancels.clear()
    await transport.terminate()
    await connect()
    emitReport('recycle:done')
  }

  connect()

  return {
    api: api as IsolatedFacade<S>,
    on: <K extends keyof S['events'] & string>(
      channel: K,
      fn: IsolatedEventListener<S, K>
    ): (() => void) => {
      let set = eventListeners.get(channel)
      if (!set) {
        set = new Set()
        eventListeners.set(channel, set)
      }
      const wrapped = fn as (payload: unknown) => void
      set.add(wrapped)
      return () => set!.delete(wrapped)
    },
    onCrash: (fn) => {
      crashListeners.add(fn)
      return () => crashListeners.delete(fn)
    },
    get state() {
      return state
    },
    dispose,
    recycle,
  }
}
