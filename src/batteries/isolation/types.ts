/**
 * Spec DSL + mapped facade/implementation types for the isolation battery.
 *
 * @remarks
 * This module has **zero imports** — not even a type-only import from `@nhtio/adk` core
 * (CONTRIBUTING.md Design Decision #13, tier 2: locally-declared structural duck-types). A caller
 * describes an isolated service once, with {@link defineIsolatedService}, and gets back a spec object
 * that:
 *
 * - the HOST side maps to an {@link IsolatedFacade} (a plain object of promise-returning methods +
 *   stream-returning functions) via `createIsolatedService` (see `host.ts`);
 * - the GUEST side maps to an {@link IsolatedImplementation} the caller must provide via `serveIsolated`
 *   (see `serve.ts`).
 *
 * The descriptor factories ({@link method}, {@link stream}, {@link event}) are phantom-typed: at
 * runtime they return a small plain object carrying only the declared runtime options (`signal`,
 * `codec`); the `A`/`R`/`D`/`P` type parameters never materialize as runtime values — they exist purely
 * so the mapped types below can recover the exact argument/return/delta/payload shapes from a spec
 * object's inferred type.
 */

/**
 * Serialization strategy for a single method/stream call's arguments — see `codec.ts` for the tiered
 * codec this selects. `'auto'` (the default when omitted) traverses each argument and escalates only
 * the exotic leaves it finds; `'raw'` skips traversal entirely (trust the caller — cheapest, but unsafe
 * for values containing functions/Errors/custom-encodables); `'encoded'` whole-value encodes every
 * argument via the optional `@nhtio/encoder` peer. A caller may also inject a literal `{ encode, decode
 * }` pair to bring their own codec, bypassing both the traversal and the encoder peer entirely.
 */
export type CodecMode =
  | 'auto'
  | 'raw'
  | 'encoded'
  | {
      /** Serialize a single value to a wire-safe string. May be sync or async. */
      encode: (value: unknown) => string | Promise<string>
      /** Reconstruct a value from a string produced by this codec's `encode`. May be sync or async. */
      decode: (encoded: string) => unknown | Promise<unknown>
    }

/** Runtime options accepted by {@link method}. */
export interface MethodOptions {
  /**
   * When `true`, the facade's generated method accepts a trailing `AbortSignal` and the guest
   * implementation receives a trailing {@link IsolationCallContext} carrying that signal. When
   * omitted/`false`, a trailing signal argument is still accepted on the facade (for call-site
   * uniformity) but is not forwarded anywhere meaningful — the implementation is never given a context
   * parameter.
   */
  signal?: boolean
  /** Override the codec tier for this method's arguments and return value. Default: `'auto'`. */
  codec?: CodecMode
}

/** Runtime options accepted by {@link stream}. */
export interface StreamOptions {
  /** Override the codec tier for this stream's arguments and deltas. Default: `'auto'`. */
  codec?: CodecMode
}

/**
 * A method descriptor produced by {@link method}. Carries the declared runtime options plus phantom
 * (never-constructed) fields that pin down the argument tuple and return type for the mapped types
 * below — reading `descriptor.__args`/`descriptor.__result` at the TYPE level only, never at runtime.
 */
export interface MethodDescriptor<
  A extends unknown[] = unknown[],
  R = unknown,
> extends MethodOptions {
  /** Discriminant identifying this descriptor as a method (vs. a stream or event). */
  readonly kind: 'method'
  /** Phantom-only: never assigned a real value. Pins the argument tuple type. */
  readonly __args?: A
  /** Phantom-only: never assigned a real value. Pins the resolved result type. */
  readonly __result?: R
}

/** A stream descriptor produced by {@link stream}. Phantom-typed like {@link MethodDescriptor}. */
export interface StreamDescriptor<
  A extends unknown[] = unknown[],
  D = unknown,
> extends StreamOptions {
  /** Discriminant identifying this descriptor as a stream (vs. a method or event). */
  readonly kind: 'stream'
  /** Phantom-only: never assigned a real value. Pins the argument tuple type. */
  readonly __args?: A
  /** Phantom-only: never assigned a real value. Pins the per-chunk delta type. */
  readonly __delta?: D
}

/** An event descriptor produced by {@link event}. Phantom-typed like {@link MethodDescriptor}. */
export interface EventDescriptor<P = unknown> {
  /** Discriminant identifying this descriptor as an event (vs. a method or stream). */
  readonly kind: 'event'
  /** Phantom-only: never assigned a real value. Pins the event payload type. */
  readonly __payload?: P
}

/**
 * Declare a request/response method on an isolated service's spec — the host gets a
 * `(...args) => Promise<R>` facade method; the guest implementation returns (or resolves to) `R`
 * directly (or throws/rejects, crossing back as a rejected promise on the host).
 *
 * @typeParam A - The method's argument tuple, e.g. `[MyArgs]` or `[string, number]`.
 * @typeParam R - The method's resolved result type.
 * @param opts - See {@link MethodOptions}. `opts.signal` opts this method into abort-signal plumbing.
 */
export const method = <A extends unknown[], R>(
  opts: MethodOptions = {}
): MethodDescriptor<A, R> => ({
  kind: 'method',
  signal: opts.signal,
  codec: opts.codec,
})

/**
 * Declare a fire-and-forward streaming method on an isolated service's spec — the host gets a
 * `(...args) => ReadableStream<D>` facade method (synchronous: the stream is returned immediately, fed
 * by deltas as they cross the wire); the guest implementation returns (or is called to produce) a
 * `ReadableStream<D>` or `AsyncIterable<D>`.
 *
 * @typeParam A - The stream's argument tuple.
 * @typeParam D - The type of each streamed delta/chunk.
 * @param opts - See {@link StreamOptions}.
 */
export const stream = <A extends unknown[], D>(
  opts: StreamOptions = {}
): StreamDescriptor<A, D> => ({
  kind: 'stream',
  codec: opts.codec,
})

/**
 * Declare an unsolicited event channel on an isolated service's spec — the guest-side implementation
 * factory receives an `emit(payload)` function for this channel; the host subscribes via
 * `service.on(channel, fn)`. Events are never implemented by the guest's per-method object (there is no
 * "handler" to provide) — they are purely an outbound notification channel.
 *
 * @typeParam P - The event payload type.
 */
export const event = <P>(): EventDescriptor<P> => ({ kind: 'event' })

/** The shape of a `methods` map passed to {@link defineIsolatedService}: request/response descriptors
 *  keyed by method name. */
export type MethodMap = Record<string, MethodDescriptor<unknown[], unknown>>
/** The shape of a `streams` map passed to {@link defineIsolatedService}: fire-and-forward streaming
 *  descriptors keyed by stream name. */
export type StreamMap = Record<string, StreamDescriptor<unknown[], unknown>>
/** The shape of an `events` map passed to {@link defineIsolatedService}: unsolicited-notification
 *  descriptors keyed by channel name. */
export type EventMap = Record<string, EventDescriptor<unknown>>

/** Input shape accepted by {@link defineIsolatedService}. */
export interface IsolatedServiceSpecInput<
  M extends MethodMap = MethodMap,
  S extends StreamMap = StreamMap,
  E extends EventMap = EventMap,
> {
  /** Used in error messages and observability reports to identify this service. */
  name: string
  /** Request/response methods, keyed by name. Default `{}`. */
  methods?: M
  /** Fire-and-forward streaming methods, keyed by name. Default `{}`. */
  streams?: S
  /** Unsolicited event channels, keyed by name. Default `{}`. */
  events?: E
}

/**
 * A fully-resolved isolated-service spec, as returned by {@link defineIsolatedService}. Consumed by
 * both `createIsolatedService` (host.ts) and `serveIsolated` (serve.ts) to type-check the facade /
 * implementation respectively, and read at runtime for wire validation (method/stream/event name
 * lookups).
 */
export interface IsolatedServiceSpec<
  M extends MethodMap = MethodMap,
  S extends StreamMap = StreamMap,
  E extends EventMap = EventMap,
> {
  /** Identifies this service in error messages and observability reports. */
  readonly name: string
  /** Request/response method descriptors, keyed by name. */
  readonly methods: M
  /** Fire-and-forward streaming descriptors, keyed by name. */
  readonly streams: S
  /** Unsolicited event-channel descriptors, keyed by name. */
  readonly events: E
}

/**
 * Resolve an isolated-service spec input into its final {@link IsolatedServiceSpec} shape — filling in
 * `{}` defaults for omitted `methods`/`streams`/`events`. Pure and zero-import: performs NO validation
 * (no duplicate-name check, no empty-`name` check). This is the primitive the public,
 * validating `defineIsolatedService` (exported from `validation.ts` and re-exported from this
 * battery's `index.ts` barrel) delegates to after it validates the input — call this directly only
 * from tests that intentionally want to bypass validation.
 */
export const resolveIsolatedServiceSpec = <
  M extends MethodMap = Record<never, never>,
  S extends StreamMap = Record<never, never>,
  E extends EventMap = Record<never, never>,
>(
  input: IsolatedServiceSpecInput<M, S, E>
): IsolatedServiceSpec<M, S, E> => ({
  name: input.name,
  methods: (input.methods ?? {}) as M,
  streams: (input.streams ?? {}) as S,
  events: (input.events ?? {}) as E,
})

// ── Call context / stream handle (guest-side) ───────────────────────────────────────────────────────

/**
 * Trailing parameter a guest method implementation receives when its descriptor declared
 * `{ signal: true }`. Carries the {@link AbortSignal} the host aborts to cancel this in-flight call.
 */
export interface IsolationCallContext {
  /** Aborts when the host sends an `abort` envelope for this call's id. */
  signal: AbortSignal
}

/**
 * Trailing parameter every guest stream implementation receives (regardless of declared options).
 * Carries the {@link AbortSignal} the host aborts (via `stream:cancel`) when the reader cancels the
 * host-side `ReadableStream`.
 */
export interface StreamHandle {
  /** Aborts when the host sends a `stream:cancel` envelope for this stream's id. */
  signal: AbortSignal
}

// ── Mapped facade / implementation types ────────────────────────────────────────────────────────────

/** Recover a method descriptor's argument tuple type. */
type MethodArgs<D> = D extends MethodDescriptor<infer A, unknown> ? A : never
/** Recover a method descriptor's result type. */
type MethodResult<D> = D extends MethodDescriptor<unknown[], infer R> ? R : never
/** Recover a stream descriptor's argument tuple type. */
type StreamArgs<D> = D extends StreamDescriptor<infer A, unknown> ? A : never
/** Recover a stream descriptor's delta type. */
type StreamDelta<D> = D extends StreamDescriptor<unknown[], infer Dl> ? Dl : never
/** Recover an event descriptor's payload type. */
type EventPayload<D> = D extends EventDescriptor<infer P> ? P : never

/**
 * The host-side callable facade a {@link IsolatedServiceSpec} maps to — `.api` on the
 * `IsolatedService` returned by `createIsolatedService`. Every declared method becomes an async
 * function returning `Promise<R>` and accepting an optional trailing `AbortSignal` (accepted uniformly
 * regardless of whether the method declared `{ signal: true }` — a signal handed to a method that
 * didn't opt in is simply not forwarded to the guest). Every declared stream becomes a synchronous
 * function returning a `ReadableStream<D>` immediately.
 */
export type IsolatedFacade<S extends IsolatedServiceSpec> = {
  [K in keyof S['methods']]: (
    ...args: [...MethodArgs<S['methods'][K]>, signal?: AbortSignal]
  ) => Promise<MethodResult<S['methods'][K]>>
} & {
  [K in keyof S['streams']]: (
    ...args: StreamArgs<S['streams'][K]>
  ) => ReadableStream<StreamDelta<S['streams'][K]>>
}

/**
 * The guest-side implementation object a caller of `serveIsolated` must provide — one function per
 * declared method/stream. Method implementations may return their result synchronously or as a
 * `Promise`. Every method implementation accepts an optional trailing {@link IsolationCallContext}
 * uniformly (a deliberate typing simplification — see remarks below); at RUNTIME a context is only ever
 * constructed and passed when the method descriptor declared `{ signal: true }`, so an implementation
 * that ignores the parameter for a non-`signal` method simply never receives one. Stream implementations
 * may return a `ReadableStream<D>` or any `AsyncIterable<D>` (e.g. an async generator), and always
 * receive a trailing {@link StreamHandle}. Declared `events` are NOT part of this object — see
 * `serveIsolated`'s factory `emit` parameter.
 *
 * @remarks
 * Conditioning the trailing parameter's presence on `S['methods'][K] extends { signal: true }` at the
 * type level runs into a genuine TypeScript inference gap: the `method<A, R>({ signal: true })` factory
 * can't carry `signal`'s literal-`true` value through to the mapped type without the descriptor's
 * optional `signal?: boolean` property widening back to `boolean` (or `true | undefined`) well before the
 * conditional type gets to test it, making the `extends { signal: true }` branch either never trigger or
 * trigger unconditionally. Rather than reach for `const`-generic phantom-typing surgery to fight that,
 * this mapped type intentionally accepts the simpler, slightly-less-precise contract: the trailing
 * context is always optionally typed, regardless of the descriptor's declared `signal` option.
 */
export type IsolatedImplementation<S extends IsolatedServiceSpec> = {
  [K in keyof S['methods']]: (
    ...args: [...MethodArgs<S['methods'][K]>, ctx?: IsolationCallContext]
  ) => MethodResult<S['methods'][K]> | Promise<MethodResult<S['methods'][K]>>
} & {
  [K in keyof S['streams']]: (
    ...args: [...StreamArgs<S['streams'][K]>, handle: StreamHandle]
  ) => ReadableStream<StreamDelta<S['streams'][K]>> | AsyncIterable<StreamDelta<S['streams'][K]>>
}

/** Emit an event declared on a spec — the guest-side capability handed alongside the implementation. */
export type IsolatedEmitter<S extends IsolatedServiceSpec> = {
  [K in keyof S['events']]: (payload: EventPayload<S['events'][K]>) => void
}

/** A typed event-channel listener for the host-side `IsolatedService.on(channel, fn)`. */
export type IsolatedEventListener<S extends IsolatedServiceSpec, K extends keyof S['events']> = (
  payload: EventPayload<S['events'][K]>
) => void

// ── Transport-facing duck contracts (PortLike / IsolationTransport) ────────────────────────────────

/**
 * The minimal message-passing duck the wire protocol (`protocol.ts`) is built over. A `Worker` /
 * `MessagePort` (`post` = `postMessage`, `onMessage` wraps `addEventListener('message', ...)`) and a
 * Node `ChildProcess` / `process` (`post` = `.send`, `onMessage` wraps `.on('message', ...)`) both
 * satisfy this structurally — WP1 exercises it only against linked in-memory fake ports; WP2/WP3 wire
 * it to the real transports.
 */
export interface PortLike {
  /** Send a message across the port. Fire-and-forget — no delivery confirmation at this layer. */
  post(msg: unknown): void
  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(fn: (msg: unknown) => void): () => void
}

/** Information about a crashed isolated guest, reported via `IsolationTransport.onCrash`. */
export interface CrashInfo {
  /** Human-readable crash reason (exit signal, uncaught exception message, etc.). */
  reason: string
  /** Process exit code, when known (child_process transports). */
  code?: number | null
  /** Process exit signal, when known (child_process transports). */
  signal?: string | null
}

/**
 * The environment-specific spawn/lifecycle duck a host-side transport implements — WP2 (Web Worker)
 * and WP3 (node child_process) each provide one; `createIsolatedService` (host.ts) drives only this
 * interface, never a concrete Worker/ChildProcess type.
 */
export interface IsolationTransport {
  /** Spawn (or reuse) the guest and resolve once a {@link PortLike} is ready to exchange envelopes. */
  connect(): Promise<PortLike>
  /** Tear down the guest unconditionally (kill/terminate). May be sync or async. */
  terminate(): void | Promise<void>
  /** Subscribe to crash notifications (unexpected exit/termination). Returns an unsubscribe function. */
  onCrash(fn: (info: CrashInfo) => void): () => void
}
