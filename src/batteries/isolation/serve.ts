/**
 * Guest-side server — runs a caller's {@link IsolatedImplementation} against a {@link PortLike},
 * dispatching inbound `call`/`stream:start`/`stream:cancel`/`abort`/`shutdown` envelopes via a
 * {@link GuestEndpoint} and encoding results/deltas/errors back across the wire via the tiered codec.
 *
 * @remarks
 * `serveIsolatedOverPort` is the environment-neutral primitive: it takes an already-constructed
 * {@link PortLike}, so it works identically whether that port wraps a Web Worker's global scope, a
 * node `process`, or (as in every WP1 unit spec) a linked in-memory fake port. `serveIsolated` is the
 * convenience wrapper WP2/WP3 guest entry points call directly: it duck-detects the environment
 * (`globalThis.self.postMessage` → Worker; `globalThis.process?.send` → child_process) and builds the
 * matching `PortLike` itself — WITHOUT importing any `node:*` module (a plain `globalThis.process` duck
 * check, never `import 'node:...'`), keeping this module loadable in every environment.
 */

import { GuestEndpoint } from './protocol'
import { E_ISOLATION_UNSUPPORTED_ENV } from './exceptions'
import { validateServeIsolatedOptions } from './validation'
import {
  emitIsolationReport,
  hasIsolationHook,
  type IsolationObservabilityHooks,
} from './observability'
import {
  decodeArgument,
  encodeArgument,
  isEncoderAvailable,
  registerEncodableClasses,
  toWireError,
} from './codec'
import type { WireValue } from './protocol'
import type {
  CodecMode,
  IsolatedEmitter,
  IsolatedImplementation,
  IsolatedServiceSpec,
  IsolationCallContext,
  PortLike,
  StreamHandle,
} from './types'

/** Options accepted by {@link serveIsolated}/{@link serveIsolatedOverPort}. */
export interface ServeIsolatedOptions extends IsolationObservabilityHooks {
  /** Classes to register with `@nhtio/encoder`'s custom-encodable round-trip on this side (sugar over
   *  `registerClass`; lazy — only touches the encoder peer when this array is non-empty). */
  encodables?: ReadonlyArray<{ readonly name: string }>
}

/** The implementation factory `serveIsolated`/`serveIsolatedOverPort` calls once, up front, to obtain
 *  the guest-side method/stream implementations plus the `emit` capability for declared events. */
export type IsolatedImplementationFactory<S extends IsolatedServiceSpec> = (input: {
  emit: IsolatedEmitter<S>
  /** Issue a guest-to-host capability call. */
  hostcall: (method: string, args: WireValue[], maxBytes?: number) => Promise<WireValue | string>
}) => IsolatedImplementation<S>

const codecModeFor = (declared: CodecMode | undefined): CodecMode | undefined => declared

/** Turn an `AsyncIterable`/`ReadableStream` into a uniform async-iterator-like reader with a
 *  best-effort `cancel()`. */
const toStreamReader = <D>(
  source: ReadableStream<D> | AsyncIterable<D>
): { next: () => Promise<IteratorResult<D>>; cancel: () => void } => {
  if (Symbol.asyncIterator in source) {
    const iterator = (source as AsyncIterable<D>)[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      cancel: () => {
        void iterator.return?.()
      },
    }
  }
  const reader = (source as ReadableStream<D>).getReader()
  return {
    next: () => reader.read() as Promise<IteratorResult<D>>,
    cancel: () => {
      void reader.cancel()
    },
  }
}

/**
 * Serve `spec` over an already-constructed {@link PortLike} — the environment-neutral primitive.
 * Builds the implementation via `factory`, wires a {@link GuestEndpoint} to it, and announces
 * readiness (`ready` envelope) once the encoder-availability probe resolves.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_INVALID_ISOLATION_OPTIONS} when `options` fails
 *   validation.
 * @returns A `stop()` function that tears down the endpoint's port subscription. Does NOT itself close
 *   the port — callers own the port's lifecycle.
 */
export const serveIsolatedOverPort = <S extends IsolatedServiceSpec>(
  spec: S,
  factory: IsolatedImplementationFactory<S>,
  port: PortLike,
  options?: ServeIsolatedOptions
): { stop: () => void } => {
  const resolved = validateServeIsolatedOptions(options)
  let spawnCount = 1
  const emitReport = (
    phase: Parameters<typeof emitIsolationReport>[1],
    extra?: Parameters<typeof emitIsolationReport>[3]
  ): void => emitIsolationReport(resolved, phase, { serviceName: spec.name, spawnCount }, extra)

  let encoderAvailable = false
  const openStreams = new Map<string, { cancel: () => void }>()

  let endpoint: GuestEndpoint
  const emitter = new Proxy(
    {},
    {
      get: (_target, channel: string) => (payload: unknown) => {
        void (async () => {
          const wire = await encodeArgument(payload, {
            label: `event ${channel}`,
            onEscalate: (path, reason) =>
              emitReport('codec:escalate', {
                argPath: `${channel}${pathSuffix(path)}`,
                escalateReason: reason,
              }),
          })
          endpoint.emit(channel, wire)
        })()
      },
    }
  ) as IsolatedEmitter<S>

  endpoint = new GuestEndpoint(port, {
    onEnvelope: (dir, envelope) => {
      if (!hasIsolationHook(resolved, dir === 'out' ? 'wire:out' : 'wire:in')) return
      emitReport(dir === 'out' ? 'wire:out' : 'wire:in', { kind: envelope.t })
    },
    onCall: (id, methodName, args, signal) => {
      void handleCall(id, methodName, args, signal)
    },
    onStreamStart: (id, streamName, args, signal) => {
      void handleStreamStart(id, streamName, args, signal)
    },
    onStreamCancel: (id) => {
      openStreams.get(id)?.cancel()
      openStreams.delete(id)
    },
    onShutdown: () => {
      // Best-effort: nothing more to clean up at this layer; the guest process/worker exit is the
      // caller's responsibility (serveIsolated's environment-specific wrapper, or the consumer script).
    },
  })

  // CONSTRUCTED BEFORE THE FACTORY RUNS, deliberately. The factory receives a `hostcall` capability
  // that closes over `endpoint`, and a factory may legitimately invoke it SYNCHRONOUSLY — to fetch the
  // configuration it needs in order to build the implementation. Calling the factory first left that
  // closure reading an unassigned binding, so such a factory threw instead of producing a service.
  //
  // Safe in this order because the endpoint's handlers reach `implementation` only from inside
  // `handleCall`/`handleStreamStart`, which run when a call arrives — never during construction — and
  // there is no await between these two statements for an inbound message to interleave into.
  const implementation = factory({
    emit: emitter,
    hostcall: (method, args, maxBytes) => endpoint.hostcall(method, args, maxBytes).promise,
  })

  const handleCall = async (
    id: string,
    methodName: string,
    args: WireValue[],
    signal: AbortSignal
  ): Promise<void> => {
    const descriptor = spec.methods[methodName]
    const start = Date.now()
    emitReport('call:start', { method: methodName, id })
    try {
      if (!descriptor) {
        throw new Error(`Unknown method "${methodName}" on isolated service "${spec.name}"`)
      }
      const mode = codecModeFor(descriptor.codec)
      const decodedArgs = await Promise.all(
        args.map((a, i) => decodeArgument(a, mode, `${methodName} args[${i}]`))
      )
      const fn = (implementation as Record<string, (...a: unknown[]) => unknown>)[methodName]
      const callArgs = descriptor.signal
        ? [...decodedArgs, { signal } satisfies IsolationCallContext]
        : decodedArgs
      const result = await fn(...callArgs)
      const wireResult = await encodeArgument(result, {
        mode,
        label: `${methodName} result`,
        onEscalate: (path, reason) =>
          emitReport('codec:escalate', {
            argPath: `${methodName} result${pathSuffix(path)}`,
            escalateReason: reason,
          }),
      })
      endpoint.settleOk(id, wireResult)
      emitReport('call:settle', {
        method: methodName,
        id,
        durationMs: Date.now() - start,
        ok: true,
      })
    } catch (err) {
      const wireError = await toWireError(err, encoderAvailable)
      endpoint.settleError(id, wireError)
      emitReport('call:settle', {
        method: methodName,
        id,
        durationMs: Date.now() - start,
        ok: false,
        errorMessage: wireError.message,
      })
    }
  }

  const handleStreamStart = async (
    id: string,
    streamName: string,
    args: WireValue[],
    signal: AbortSignal
  ): Promise<void> => {
    emitReport('stream:start', { streamName, id })
    const descriptor = spec.streams[streamName]
    let deltaCount = 0
    const startedAt = Date.now()
    let firstDeltaMs: number | undefined
    try {
      if (!descriptor) {
        throw new Error(`Unknown stream "${streamName}" on isolated service "${spec.name}"`)
      }
      const mode = codecModeFor(descriptor.codec)
      const decodedArgs = await Promise.all(
        args.map((a, i) => decodeArgument(a, mode, `${streamName} args[${i}]`))
      )
      const fn = (implementation as Record<string, (...a: unknown[]) => unknown>)[streamName]
      const handle: StreamHandle = { signal }
      const source = (await fn(...decodedArgs, handle)) as
        | ReadableStream<unknown>
        | AsyncIterable<unknown>
      const reader = toStreamReader(source)
      openStreams.set(id, { cancel: reader.cancel })
      while (true) {
        const { value, done } = await reader.next()
        if (done) break
        deltaCount += 1
        if (firstDeltaMs === undefined) firstDeltaMs = Date.now() - startedAt
        const wireDelta = await encodeArgument(value, {
          mode,
          label: `${streamName} delta`,
          onEscalate: (path, reason) =>
            emitReport('codec:escalate', {
              argPath: `${streamName} delta${pathSuffix(path)}`,
              escalateReason: reason,
            }),
        })
        endpoint.pushDelta(id, wireDelta)
      }
      openStreams.delete(id)
      endpoint.endStream(id)
      emitReport('stream:end', { streamName, id, deltaCount, firstDeltaMs })
    } catch (err) {
      openStreams.delete(id)
      const wireError = await toWireError(err, encoderAvailable)
      endpoint.errorStream(id, wireError)
      emitReport('stream:error', { streamName, id, streamError: wireError })
    }
  }

  // Probe encoder availability then announce readiness. Kept async but fire-and-forget from the
  // constructor's perspective — `serveIsolatedOverPort` returns synchronously; the host's own queued-
  // before-ready flush means no call is lost while this resolves.
  void (async () => {
    encoderAvailable = await isEncoderAvailable()
    if (resolved.encodables && resolved.encodables.length > 0) {
      await registerEncodableClasses(resolved.encodables)
    }
    endpoint.ready(encoderAvailable)
    emitReport('spawn:ready', { bootMs: 0 })
  })()

  return {
    stop: () => {
      // `terminate()` FIRST: a pending `hostcall` lives in the endpoint's own map, not in
      // `openStreams`, so cancelling streams alone left the guest's capability promise unsettled and
      // whatever awaited it hanging for the life of the process. Stopping must settle every promise it
      // owns, and a rejection is the honest outcome — the result is never coming.
      endpoint.terminate('Isolated service stopped')
      for (const [, s] of openStreams) s.cancel()
      openStreams.clear()
    },
  }
}

const pathSuffix = (path: PropertyKey[]): string =>
  path.length === 0 ? '' : `.${path.map(String).join('.')}`

/** Duck-detect a Web Worker global scope: `self.postMessage` present and NOT a node `process`. */
const detectWorkerScope = (): PortLike | undefined => {
  const g = globalThis as unknown as {
    self?: { postMessage?: (msg: unknown, ...rest: unknown[]) => void; addEventListener?: unknown }
    postMessage?: (msg: unknown, ...rest: unknown[]) => void
    addEventListener?: (type: string, fn: (ev: unknown) => void) => void
    removeEventListener?: (type: string, fn: (ev: unknown) => void) => void
  }
  const scope = g.self ?? g
  if (typeof scope.postMessage !== 'function' || typeof g.addEventListener !== 'function') {
    return undefined
  }
  return {
    post: (msg) => scope.postMessage!(msg),
    onMessage: (fn) => {
      const listener = (ev: unknown): void => fn((ev as { data: unknown }).data)
      g.addEventListener!('message', listener)
      return () => g.removeEventListener?.('message', listener)
    },
  }
}

/** Duck-detect a node child_process guest: `process.send` present. Accessed ONLY via `globalThis` —
 *  this module never `import`s `node:*` so it stays loadable unmodified in a Worker/browser bundle. */
const detectChildProcessScope = (): PortLike | undefined => {
  const proc = (globalThis as unknown as { process?: NodeProcessLike }).process
  if (!proc || typeof proc.send !== 'function') return undefined
  return {
    post: (msg) => proc.send!(msg),
    onMessage: (fn) => {
      const listener = (msg: unknown): void => fn(msg)
      proc.on('message', listener)
      return () => proc.off?.('message', listener)
    },
  }
}

/** Minimal structural shape of node's `process` this module reads — never imports `node:process`. */
interface NodeProcessLike {
  send?: (msg: unknown) => void
  on: (event: 'message', fn: (msg: unknown) => void) => void
  off?: (event: 'message', fn: (msg: unknown) => void) => void
}

/**
 * Serve `spec` in the CURRENT environment, duck-detecting a Web Worker global scope
 * (`globalThis.self.postMessage`) or a node child_process (`globalThis.process.send`) — in that
 * order — and building the matching {@link PortLike} automatically. This module never imports any
 * `node:*` builtin, so it is safe to bundle for either target; the detection is a pure `globalThis`
 * duck check.
 *
 * @throws {@link @nhtio/adk/batteries/isolation!E_ISOLATION_UNSUPPORTED_ENV} when neither environment
 *   is detected (e.g. called on a plain main-thread browser tab, or in a test with no fake `self`/
 *   `process.send`) — use {@link serveIsolatedOverPort} directly there instead.
 */
export const serveIsolated = <S extends IsolatedServiceSpec>(
  spec: S,
  factory: IsolatedImplementationFactory<S>,
  options?: ServeIsolatedOptions
): { stop: () => void } => {
  const port = detectWorkerScope() ?? detectChildProcessScope()
  if (!port) {
    throw new E_ISOLATION_UNSUPPORTED_ENV([
      'neither a Web Worker global scope (self.postMessage) nor a node child_process (process.send) was detected — use serveIsolatedOverPort with an explicit PortLike instead',
    ])
  }
  return serveIsolatedOverPort(spec, factory, port, options)
}
