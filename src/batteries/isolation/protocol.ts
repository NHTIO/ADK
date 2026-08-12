/**
 * Wire protocol — envelope shapes and the transport-agnostic {@link HostEndpoint}/{@link GuestEndpoint}
 * correlation engines built on top of {@link PortLike}.
 *
 * @remarks
 * Generalizes the pattern hand-rolled per-battery in
 * `docs/.vitepress/theme/components/agent/litert_lm_worker_proxy.ts` +
 * `litert_lm_worker.ts` (id-correlated one-shot calls, a persistent stream-sink map fed by unsolicited
 * events, string-only error crossing) into a reusable, method/stream/event-name-generic core. Both
 * endpoint classes are PURE over {@link PortLike} — no `Worker`/`postMessage`/`process.send` reference
 * anywhere in this module; WP2/WP3 supply concrete `PortLike` adapters, WP1 exercises this file only
 * against linked in-memory fake ports (see the unit specs).
 *
 * `HostEndpoint` queues every outbound call/stream-start made before the guest's `ready` envelope
 * arrives, then flushes the queue in order once it does. `GuestEndpoint` requires no such queueing (it
 * only ever reacts to inbound envelopes).
 */

import { isError } from '@nhtio/adk/guards'
import type { PortLike } from './types'

// ── Wire value + error shapes ────────────────────────────────────────────────────────────────────────

/**
 * A single argument/result value as it crosses the wire — the codec's (`codec.ts`) output shape. `enc:
 * 'raw'` ships the value (mostly) untouched; `enc: 'nhtio'` ships an `@nhtio/encoder`-encoded string
 * (or a BYO-codec-encoded string). `transfer` is a pass-through marker WP2's browser transport unwraps
 * into a `postMessage` transfer list; node transports ignore it.
 */
export type WireValue =
  | { enc: 'raw'; v: unknown; transfer?: unknown[] }
  | { enc: 'nhtio'; v: string }

/**
 * An error as it crosses the wire. `message`/`name`/`stack` are ALWAYS present baseline string fields
 * (never omitted, regardless of encoder availability) so error-classification-by-message-signature
 * always works even when the encoder is unavailable or fails to decode. `nhtio` carries the
 * `@nhtio/encoder`-encoded original `Error` instance when BOTH sides advertised `encoderAvailable` on
 * `ready` — the receiving side decodes it for full fidelity (custom error subclasses, extra
 * properties) and falls back silently to the baseline fields on any decode failure.
 */
export interface WireError {
  /** Baseline error message — always populated, even when `nhtio` is absent or fails to decode. */
  message: string
  /** Baseline error name (e.g. `'TypeError'`) — always populated. */
  name: string
  /** Baseline stack trace, when the original error had one — always forwarded as-is (never re-derived). */
  stack?: string
  /** `@nhtio/encoder`-encoded original `Error`, when both sides have the encoder. */
  nhtio?: string
}

// ── Envelopes ────────────────────────────────────────────────────────────────────────────────────────

/** Host → guest envelopes. */
export type HostToGuestEnvelope =
  | { t: 'call'; id: string; method: string; args: WireValue[] }
  | { t: 'hostresult'; id: string; ok: true; value: WireValue | string }
  | { t: 'hostresult'; id: string; ok: false; error?: WireError; value?: string }
  | { t: 'abort'; id: string }
  | { t: 'stream:start'; id: string; stream: string; args: WireValue[] }
  | { t: 'stream:cancel'; id: string; reason?: WireValue }
  | { t: 'shutdown' }

/** Guest → host envelopes. */
export type GuestToHostEnvelope =
  | { t: 'ready'; encoderAvailable: boolean }
  | { t: 'hostcall'; id: string; method: string; args: WireValue[] }
  | { t: 'result'; id: string; ok: true; value: WireValue }
  | { t: 'result'; id: string; ok: false; error: WireError }
  | { t: 'stream:delta'; id: string; delta: WireValue }
  | { t: 'stream:end'; id: string }
  | { t: 'stream:error'; id: string; error: WireError }
  | { t: 'event'; channel: string; payload: WireValue }

/** Either direction's envelope — used by generic wire-tracing hooks. */
export type WireEnvelope = HostToGuestEnvelope | GuestToHostEnvelope

let idSeq = 0
/** Monotonic id generator shared by both endpoints (module-scoped counter — fine across many
 *  instances in one realm since ids are only ever compared within a single connection). */
export const nextCorrelationId = (): string => `c${(idSeq += 1)}`

// ── Host endpoint ────────────────────────────────────────────────────────────────────────────────────

interface PendingCall {
  resolve: (value: WireValue) => void
  reject: (err: Error) => void
}

interface StreamSink {
  push: (delta: WireValue) => void
  end: () => void
  error: (err: WireError) => void
}

/** Hooks {@link HostEndpoint} invokes on protocol-level events; `host.ts` wires these to the
 *  observability layer + guest-event fan-out. All optional. */
export interface HostcallQuotas {
  /** Per-request deadline in milliseconds. */
  hostcallTimeoutMs: number
  /** Maximum accepted requests for one evaluation. */
  maxHostcallsPerEvaluation: number
  /** Maximum concurrently running requests. */
  maxConcurrentHostcalls: number
}

/** Host-side capability registry. The handler receives decoded wire arguments. */
export type HostcallHandler = (
  args: WireValue[],
  signal: AbortSignal
) => WireValue | Promise<WireValue>

/** UTF-8 producer-side measurement used by both RPC realms. */
export const measureHostcallBytes = (value: unknown): number => {
  const text = JSON.stringify(value)
  return new TextEncoder().encode(text === undefined ? 'undefined' : text).byteLength
}

/**
 * Callback surface for observing host-endpoint lifecycle and guest-originated events.
 *
 * @remarks Hooks are notifications only; dispatch and correlation remain owned by the endpoint.
 */
export interface HostEndpointHooks {
  /** The guest's `ready` envelope arrived. */
  onReady?: (info: { encoderAvailable: boolean }) => void
  /** An `event` envelope arrived for `channel`. */
  onEvent?: (channel: string, payload: WireValue) => void
  /** A guest-to-host capability request arrived. It is deliberately independent of `call`. */
  onHostcall?: (id: string, method: string, args: WireValue[]) => void
  /** Any envelope was sent (`dir: 'out'`) or received (`dir: 'in'`) — for wire tracing. */
  onEnvelope?: (dir: 'out' | 'in', envelope: WireEnvelope) => void
}

/**
 * Host-side correlation engine over a {@link PortLike}. Queues calls/stream-starts made before `ready`
 * and flushes them in order once it arrives; tracks in-flight calls (one-shot, resolved/rejected by a
 * `result` envelope) and open streams (persistent, fed by `stream:delta`/`stream:end`/`stream:error`
 * until closed). `terminate()` rejects every in-flight call and errors every open stream with a
 * caller-supplied reason (the message text `host.ts` uses is `E_ISOLATED_TERMINATED`'s message).
 */
export class HostEndpoint {
  readonly #port: PortLike
  readonly #hooks: HostEndpointHooks
  readonly #pending = new Map<string, PendingCall>()
  readonly #streams = new Map<string, StreamSink>()
  readonly #outbox: HostToGuestEnvelope[] = []
  readonly #hostcallHandlers: ReadonlyMap<string, HostcallHandler>
  readonly #hostcallQuotas: HostcallQuotas | undefined
  readonly #maxHostcallBytes: number | undefined
  #acceptedHostcalls = 0
  #concurrentHostcalls = 0
  #ready = false
  #unsubscribe: () => void
  #terminated = false

  constructor(
    port: PortLike,
    hooks: HostEndpointHooks = {},
    hostcalls: {
      handlers?: ReadonlyMap<string, HostcallHandler>
      quotas?: HostcallQuotas
      maxHostcallBytes?: number
    } = {}
  ) {
    this.#port = port
    this.#hooks = hooks
    this.#hostcallHandlers = hostcalls.handlers ?? new Map()
    this.#hostcallQuotas = hostcalls.quotas
    this.#maxHostcallBytes = hostcalls.maxHostcallBytes
    this.#unsubscribe = port.onMessage(this.#onMessage)
  }

  /** Whether the guest has signaled `ready` yet. */
  get isReady(): boolean {
    return this.#ready
  }

  /** Number of calls currently awaiting a `result` envelope. Used by `host.ts` to report an accurate
   *  `inFlight` count on a crash before `terminate()` clears the pending map. */
  get pendingCallCount(): number {
    return this.#pending.size
  }

  /** Number of streams currently open (started, not yet ended/errored). Used by `host.ts` alongside
   *  {@link pendingCallCount} to report an accurate `inFlight` count on a crash. */
  get openStreamCount(): number {
    return this.#streams.size
  }

  #send(envelope: HostToGuestEnvelope): void {
    this.#hooks.onEnvelope?.('out', envelope)
    this.#port.post(envelope)
  }

  #sendOrQueue(envelope: HostToGuestEnvelope): void {
    if (this.#ready) {
      this.#send(envelope)
    } else {
      this.#outbox.push(envelope)
    }
  }

  #onMessage = (msg: unknown): void => {
    const envelope = msg as GuestToHostEnvelope
    if (!envelope || typeof (envelope as { t?: unknown }).t !== 'string') return
    this.#hooks.onEnvelope?.('in', envelope)
    switch (envelope.t) {
      case 'ready': {
        this.#ready = true
        this.#hooks.onReady?.({ encoderAvailable: envelope.encoderAvailable })
        // Flush queued calls/stream-starts in the exact order they were made.
        const queued = this.#outbox.splice(0, this.#outbox.length)
        for (const q of queued) this.#send(q)
        return
      }
      case 'hostcall': {
        this.#hooks.onHostcall?.(envelope.id, envelope.method, envelope.args)
        void this.#dispatchHostcall(envelope)
        return
      }
      case 'result': {
        const pending = this.#pending.get(envelope.id)
        if (!pending) return
        this.#pending.delete(envelope.id)
        if (envelope.ok) {
          pending.resolve(envelope.value)
        } else {
          pending.reject(wireErrorToError(envelope.error))
        }
        return
      }
      case 'stream:delta': {
        this.#streams.get(envelope.id)?.push(envelope.delta)
        return
      }
      case 'stream:end': {
        const sink = this.#streams.get(envelope.id)
        this.#streams.delete(envelope.id)
        sink?.end()
        return
      }
      case 'stream:error': {
        const sink = this.#streams.get(envelope.id)
        this.#streams.delete(envelope.id)
        sink?.error(envelope.error)
        return
      }
      case 'event': {
        this.#hooks.onEvent?.(envelope.channel, envelope.payload)
        return
      }
    }
  }

  /**
   * Issue a request/response call. Resolves with the guest's returned {@link WireValue}, rejects with a
   * reconstructed `Error` (see {@link wireErrorToError}) on failure or on `terminate()`.
   */
  call(method: string, args: WireValue[]): { id: string; promise: Promise<WireValue> } {
    if (this.#terminated) {
      const id = nextCorrelationId()
      return { id, promise: Promise.reject(new Error('HostEndpoint has been terminated')) }
    }
    const id = nextCorrelationId()
    const promise = new Promise<WireValue>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
    this.#sendOrQueue({ t: 'call', id, method, args })
    return { id, promise }
  }

  async #dispatchHostcall(
    envelope: Extract<GuestToHostEnvelope, { t: 'hostcall' }>
  ): Promise<void> {
    const handler = this.#hostcallHandlers.get(envelope.method)
    if (!handler) {
      this.hostresult(envelope.id, {
        ok: false,
        error: { name: 'Error', message: `Unknown host method "${envelope.method}"` },
      })
      return
    }
    const quotas = this.#hostcallQuotas
    if (
      quotas &&
      (this.#acceptedHostcalls >= quotas.maxHostcallsPerEvaluation ||
        this.#concurrentHostcalls >= quotas.maxConcurrentHostcalls)
    ) {
      this.hostresult(envelope.id, {
        ok: false,
        error: { name: 'Error', message: 'Hostcall quota exceeded' },
      })
      return
    }
    this.#acceptedHostcalls += 1
    this.#concurrentHostcalls += 1
    let released = false
    const release = (): void => {
      if (!released) {
        released = true
        this.#concurrentHostcalls -= 1
      }
    }
    const capabilityAbort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = quotas?.hostcallTimeoutMs
    const timedOut = new Promise<never>((_, reject) => {
      if (timeout === undefined) return
      timer = setTimeout(() => reject(new Error('Hostcall timed out')), timeout)
    })
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => handler(envelope.args, capabilityAbort.signal)),
        timedOut,
      ])
      if (timer) clearTimeout(timer)
      release()
      if (
        this.#maxHostcallBytes !== undefined &&
        measureHostcallBytes(value) > this.#maxHostcallBytes
      ) {
        this.hostresult(envelope.id, { ok: false, value: 'too-many-bytes' })
      } else {
        this.hostresult(envelope.id, { ok: true, value })
      }
    } catch (error) {
      if (timer) clearTimeout(timer)
      release()
      this.hostresult(envelope.id, {
        ok: false,
        error: { name: 'Error', message: isError(error) ? error.message : String(error) },
      })
    }
  }

  /** Post a guest capability result. Unknown/late ids are harmlessly ignored by the guest. */
  hostresult(
    id: string,
    result:
      | { ok: true; value: WireValue | string }
      | { ok: false; error?: WireError; value?: string }
  ): void {
    if (this.#terminated) return
    this.#send({ t: 'hostresult', id, ...result })
  }

  /** Send an `abort` envelope for an in-flight call's id. Does not itself reject the call — the guest
   *  is expected to respond with a `result` (ok:false) once it observes the abort. */
  abort(id: string): void {
    this.#sendOrQueue({ t: 'abort', id })
  }

  /**
   * Start a fire-and-forward stream. Returns the correlation id immediately (before the guest
   * necessarily even exists, if not yet `ready`) and a `sink` the caller wires to a `ReadableStream`
   * controller.
   */
  startStream(stream: string, args: WireValue[], sink: StreamSink): string {
    const id = nextCorrelationId()
    this.#streams.set(id, sink)
    this.#sendOrQueue({ t: 'stream:start', id, stream, args })
    return id
  }

  /** Send a `stream:cancel` envelope and stop tracking the stream locally. */
  cancelStream(id: string, reason?: WireValue): void {
    this.#streams.delete(id)
    this.#sendOrQueue({ t: 'stream:cancel', id, reason })
  }

  /** Send a `shutdown` envelope (graceful-exit request; does not itself tear down the port). */
  shutdown(): void {
    this.#send({ t: 'shutdown' })
  }

  /**
   * Reject every in-flight call and error every open stream with `reason`, clear all queued-but-unsent
   * envelopes, and unsubscribe from the port. Idempotent.
   */
  terminate(reason: string): void {
    if (this.#terminated) return
    this.#terminated = true
    this.#outbox.length = 0
    for (const [, p] of this.#pending) p.reject(new Error(reason))
    this.#pending.clear()
    const err: WireError = { message: reason, name: 'Error' }
    for (const [, s] of this.#streams) s.error(err)
    this.#streams.clear()
    this.#unsubscribe()
  }
}

/** Reconstruct an `Error` from a {@link WireError} baseline (name/message/stack only — the `nhtio`-rich
 *  path is decoded separately by the caller when an encoder is available; see `host.ts`). */
export const wireErrorToError = (wireError: WireError): Error => {
  const err = new Error(wireError.message)
  err.name = wireError.name
  if (wireError.stack) err.stack = wireError.stack
  return err
}

// ── Guest endpoint ───────────────────────────────────────────────────────────────────────────────────

/** Hooks {@link GuestEndpoint} invokes for the guest server (`serve.ts`) to react to. */
export interface GuestEndpointHooks {
  /** A `call` envelope arrived — resolve/reject `settle` with the method's outcome. */
  onCall?: (id: string, method: string, args: WireValue[], signal: AbortSignal) => void
  /** A host capability result arrived. */
  onHostResult?: (
    id: string,
    result:
      | { ok: true; value: WireValue | string }
      | { ok: false; error?: WireError; value?: string }
  ) => void
  /** A `stream:start` envelope arrived — the handler pushes deltas via the returned sink. */
  onStreamStart?: (id: string, stream: string, args: WireValue[], signal: AbortSignal) => void
  /** A `stream:cancel` envelope arrived for an open stream id. */
  onStreamCancel?: (id: string, reason?: WireValue) => void
  /** A `shutdown` envelope arrived. */
  onShutdown?: () => void
  /** Any envelope was sent (`dir: 'out'`) or received (`dir: 'in'`) — for wire tracing. */
  onEnvelope?: (dir: 'out' | 'in', envelope: WireEnvelope) => void
}

/**
 * Guest-side correlation engine over a {@link PortLike}. Owns per-call `AbortController`s (aborted on
 * an inbound `abort`/`stream:cancel` envelope) and exposes `settleCall`/`pushDelta`/`endStream`/
 * `errorStream` for `serve.ts` to report outcomes back across the wire.
 */
export class GuestEndpoint {
  readonly #port: PortLike
  readonly #hooks: GuestEndpointHooks
  readonly #callAborts = new Map<string, AbortController>()
  readonly #streamAborts = new Map<string, AbortController>()
  readonly #hostcalls = new Map<
    string,
    { resolve: (value: WireValue | string) => void; reject: (error: Error) => void }
  >()

  constructor(port: PortLike, hooks: GuestEndpointHooks = {}) {
    this.#port = port
    this.#hooks = hooks
    port.onMessage(this.#onMessage)
  }

  #send(envelope: GuestToHostEnvelope): void {
    this.#hooks.onEnvelope?.('out', envelope)
    this.#port.post(envelope)
  }

  #onMessage = (msg: unknown): void => {
    const envelope = msg as HostToGuestEnvelope
    if (!envelope || typeof (envelope as { t?: unknown }).t !== 'string') return
    this.#hooks.onEnvelope?.('in', envelope)
    switch (envelope.t) {
      case 'hostresult': {
        const pending = this.#hostcalls.get(envelope.id)
        if (!pending) return
        this.#hostcalls.delete(envelope.id)
        if (envelope.ok) pending.resolve(envelope.value)
        else if (envelope.value !== undefined) pending.reject(new Error(envelope.value))
        else pending.reject(wireErrorToError(envelope.error!))
        this.#hooks.onHostResult?.(envelope.id, envelope)
        return
      }
      case 'call': {
        const controller = new AbortController()
        this.#callAborts.set(envelope.id, controller)
        this.#hooks.onCall?.(envelope.id, envelope.method, envelope.args, controller.signal)
        return
      }
      case 'abort': {
        this.#callAborts.get(envelope.id)?.abort()
        return
      }
      case 'stream:start': {
        const controller = new AbortController()
        this.#streamAborts.set(envelope.id, controller)
        this.#hooks.onStreamStart?.(envelope.id, envelope.stream, envelope.args, controller.signal)
        return
      }
      case 'stream:cancel': {
        this.#streamAborts.get(envelope.id)?.abort()
        this.#hooks.onStreamCancel?.(envelope.id, envelope.reason)
        return
      }
      case 'shutdown': {
        this.#hooks.onShutdown?.()
        return
      }
    }
  }

  /** Issue a guest-to-host capability request using the separate hostcall id space. */
  hostcall(
    method: string,
    args: WireValue[],
    maxBytes?: number
  ): { id: string; promise: Promise<WireValue | string> } {
    const id = `h${nextCorrelationId()}`
    if (maxBytes !== undefined && measureHostcallBytes({ method, args }) > maxBytes) {
      return { id, promise: Promise.reject(new Error('Hostcall arguments exceed byte limit')) }
    }
    const promise = new Promise<WireValue | string>((resolve, reject) => {
      this.#hostcalls.set(id, { resolve, reject })
      this.#send({ t: 'hostcall', id, method, args })
    })
    return { id, promise }
  }

  /** Announce readiness. Must be sent exactly once, before any `result`/`stream:*`/`event` envelope. */
  ready(encoderAvailable: boolean): void {
    this.#send({ t: 'ready', encoderAvailable })
  }

  /** Report a successful call outcome and release the call's abort controller. */
  settleOk(id: string, value: WireValue): void {
    this.#callAborts.delete(id)
    this.#send({ t: 'result', id, ok: true, value })
  }

  /** Report a failed call outcome and release the call's abort controller. */
  settleError(id: string, error: WireError): void {
    this.#callAborts.delete(id)
    this.#send({ t: 'result', id, ok: false, error })
  }

  /** Push a stream delta. */
  pushDelta(id: string, delta: WireValue): void {
    this.#send({ t: 'stream:delta', id, delta })
  }

  /** Signal a stream's clean end and release its abort controller. */
  endStream(id: string): void {
    this.#streamAborts.delete(id)
    this.#send({ t: 'stream:end', id })
  }

  /** Signal a stream's terminal error and release its abort controller. */
  errorStream(id: string, error: WireError): void {
    this.#streamAborts.delete(id)
    this.#send({ t: 'stream:error', id, error })
  }

  /** Reject all guest capability requests when this endpoint is stopped. */
  terminate(reason = 'GuestEndpoint has been terminated'): void {
    for (const pending of this.#hostcalls.values()) pending.reject(new Error(reason))
    this.#hostcalls.clear()
  }

  /** Emit an unsolicited event on `channel`. */
  emit(channel: string, payload: WireValue): void {
    this.#send({ t: 'event', channel, payload })
  }
}
