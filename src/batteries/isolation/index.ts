/**
 * @module @nhtio/adk/batteries/isolation
 *
 * Opt-in, transport-agnostic protocol substrate for running heavy work off-thread (Web Worker) or
 * out-of-process (node `child_process`). A caller declares a service once with {@link
 * defineIsolatedService} (methods, fire-and-forward streams, unsolicited events), implements it once on
 * the guest side via {@link serveIsolated}/{@link serveIsolatedOverPort}, and drives it from the host side
 * via {@link createIsolatedService} — over any {@link IsolationTransport} that can spawn a guest and hand
 * back a {@link PortLike}.
 *
 * @remarks
 * This module ships the full isolation battery: the protocol substrate itself — wire envelopes,
 * correlation engines, the tiered codec, crash-escalation policy, and observability — plus a real
 * browser Web Worker {@link IsolationTransport} ({@link spawnIsolated}/{@link createWorkerTransport})
 * and the blob-URL {@link isolateFunction} escape hatch. Both implement `IsolationTransport`/`PortLike`
 * against the real environment and plug straight into `createIsolatedService`/`serveIsolated`
 * unmodified.
 *
 * This barrel **is** re-exported from `src/batteries/index.ts` — it is reachable via
 * `import { ... } from '@nhtio/adk/batteries'` like every other battery domain. Opt-in still applies
 * at the usage level: importing the batteries barrel (or this subpath directly via
 * `@nhtio/adk/batteries/isolation`) is what pulls the code into a consumer's bundle, and a consumer
 * who imports neither pays nothing.
 *
 * The node `child_process` {@link IsolationTransport} is the one exception: it is **not** re-exported
 * here (or from the batteries barrel) because it touches `node:child_process`, which is unsafe to pull
 * into a browser-loadable entry point. It remains reachable only via the deep import
 * `@nhtio/adk/batteries/isolation/child_process`.
 */

// ── Spec DSL ─────────────────────────────────────────────────────────────────────────────────────────
export {
  event,
  method,
  resolveIsolatedServiceSpec,
  stream,
  type CodecMode,
  type EventDescriptor,
  type EventMap,
  type IsolatedEmitter,
  type IsolatedEventListener,
  type IsolatedFacade,
  type IsolatedImplementation,
  type IsolatedServiceSpec,
  type IsolatedServiceSpecInput,
  type IsolationCallContext,
  type MethodDescriptor,
  type MethodMap,
  type MethodOptions,
  type StreamDescriptor,
  type StreamHandle,
  type StreamMap,
  type StreamOptions,
} from './types'

// ── Transport-facing duck contracts ─────────────────────────────────────────────────────────────────
export type { CrashInfo, IsolationTransport, PortLike } from './types'

// ── Validated public entry point ────────────────────────────────────────────────────────────────────
export { defineIsolatedServiceValidated as defineIsolatedService } from './validation'

// ── Wire protocol (advanced/testing use — most callers never touch these directly) ─────────────────
export {
  GuestEndpoint,
  HostEndpoint,
  nextCorrelationId,
  wireErrorToError,
  type GuestEndpointHooks,
  type GuestToHostEnvelope,
  type HostEndpointHooks,
  type HostToGuestEnvelope,
  type WireEnvelope,
  type WireError,
  type WireValue,
} from './protocol'

// ── Tiered codec (advanced/testing use) ─────────────────────────────────────────────────────────────
export {
  isEncoderAvailable,
  registerEncodableClasses,
  transfer,
  type EncoderLoader,
  type EncoderModule,
} from './codec'

// ── Crash-escalation policy ──────────────────────────────────────────────────────────────────────────
export {
  createCrashPolicy,
  DEFAULT_CRASH_POLICY_MAX_CRASHES,
  DEFAULT_CRASH_POLICY_WINDOW_MS,
  type CrashPolicy,
  type CrashPolicyOptions,
  type CrashVerdict,
} from './crash_policy'

// ── Observability ────────────────────────────────────────────────────────────────────────────────────
export {
  emitIsolationReport,
  hasIsolationHook,
  type IsolationObservabilityHooks,
  type IsolationReport,
  type IsolationReportCallback,
  type IsolationReportPhase,
} from './observability'

// ── Exceptions ───────────────────────────────────────────────────────────────────────────────────────
export {
  E_INVALID_ISOLATION_OPTIONS,
  E_ISOLATED_CRASHED,
  E_ISOLATED_TERMINATED,
  E_ISOLATION_ENCODER_REQUIRED,
  E_ISOLATION_READY_TIMEOUT,
  E_ISOLATION_UNENCODABLE,
  E_ISOLATION_UNSUPPORTED_ENV,
} from './exceptions'

// ── Guest server ─────────────────────────────────────────────────────────────────────────────────────
export {
  serveIsolated,
  serveIsolatedOverPort,
  type IsolatedImplementationFactory,
  type ServeIsolatedOptions,
} from './serve'

// ── Host facade builder ──────────────────────────────────────────────────────────────────────────────
export {
  createIsolatedService,
  type IsolatedService,
  type IsolatedServiceOptions,
  type IsolatedServiceState,
} from './host'

// ── Browser transport (WP2) ──────────────────────────────────────────────────────────────────────────
export {
  createWorkerTransport,
  spawnIsolated,
  type BrowserErrorEvent,
  type BrowserMessageEvent,
  type BrowserWorker,
  type BrowserWorkerOptions,
  type SpawnIsolatedOptions,
  type WorkerResolver,
} from './browser'

// ── Blob-URL escape hatch (WP2) ─────────────────────────────────────────────────────────────────────
export {
  E_ISOLATE_FUNCTION_ARG_UNSUPPORTED,
  E_ISOLATE_FUNCTION_REQUIRES_SOURCE_REHYDRATION,
  E_ISOLATE_FUNCTION_UNSERIALIZABLE,
  isolateFunction,
  type IsolateFunctionOptions,
  type IsolatedFunctionHandle,
} from './isolate_function'
