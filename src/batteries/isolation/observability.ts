/**
 * Shared observability contract for the isolation battery — spawn/dispose/recycle/crash/call/stream
 * lifecycle, wire-level tracing, and codec-escalation reporting.
 *
 * @remarks
 * Mirrors the shape of the LLM batteries' `BatteryLifecycleHooks`/`emitLifecycle` pattern
 * (`src/batteries/llm/chat_common/lifecycle.ts`): an aggregate firehose ({@link
 * IsolationObservabilityHooks.onIsolation}) fires on EVERY report, alongside a per-phase-group hook.
 * All hooks are optional and additive — omitting every hook leaves the battery's behavior byte-for-byte
 * unchanged, and {@link emitIsolationReport} skips assembling a report entirely when no relevant hook is
 * registered (zero overhead when unhooked).
 *
 * This module has zero imports beyond the language itself — `host.ts`/`serve.ts`/`protocol.ts` depend on
 * it, never the reverse.
 */

/** The coarse phase groups an isolation report can belong to. */
export type IsolationReportPhase =
  | 'spawn:start'
  | 'spawn:ready'
  | 'spawn:error'
  | 'dispose:start'
  | 'dispose:done'
  | 'recycle:start'
  | 'recycle:done'
  | 'crash'
  | 'respawn:auto'
  | 'call:start'
  | 'call:settle'
  | 'stream:start'
  | 'stream:end'
  | 'stream:error'
  | 'stream:cancel'
  | 'abort:sent'
  | 'wire:out'
  | 'wire:in'
  | 'codec:escalate'

/**
 * A single normalized isolation observability report. Every phase stamps `phase`/`at`/`spawnCount` plus
 * its own extra fields (see the per-phase hook docs on {@link IsolationObservabilityHooks} for which
 * extra fields a given `phase` populates).
 */
export interface IsolationReport {
  /** The phase this report describes. */
  phase: IsolationReportPhase
  /** ISO-8601 timestamp stamped when the report was emitted. */
  at: string
  /** The service's `name` (from its spec), when available. */
  serviceName?: string
  /** How many times this service's guest has been (re)spawned, including the current spawn. */
  spawnCount: number
  /** `spawn:ready` — time from `connect()` call to the `ready` envelope, in ms. */
  bootMs?: number
  /** `spawn:error` / `crash` — the underlying error/reason. */
  error?: unknown
  /** `dispose:done` — `true` when the grace period elapsed and `transport.terminate()` was forced. */
  forced?: boolean
  /** `crash` — the transport-reported crash reason. */
  reason?: string
  /** `crash` — process exit code, when known. */
  code?: number | null
  /** `crash` — process exit signal, when known. */
  signal?: string | null
  /** `crash` — number of calls that were in flight (and rejected) at the moment of the crash. */
  inFlight?: number
  /** `respawn:auto` — the crash-policy verdict that was consulted. */
  verdict?: 'respawn' | 'giveUp'
  /** `call:start` / `call:settle` — the method name. */
  method?: string
  /** `call:start` / `call:settle` — the correlation id. */
  id?: string
  /** `call:settle` — wall-clock duration of the call, in ms. */
  durationMs?: number
  /** `call:settle` — `true` when the call resolved; `false` when it rejected. */
  ok?: boolean
  /** `call:settle` (when `ok` is `false`) — the rejection's message. */
  errorMessage?: string
  /** `stream:start` / `stream:end` / `stream:error` / `stream:cancel` — the stream name. */
  streamName?: string
  /** `stream:end` / `stream:cancel` — total deltas observed before end/cancel. */
  deltaCount?: number
  /** `stream:end` — ms from `stream:start` to the first delta (`undefined` if none arrived). */
  firstDeltaMs?: number
  /** `stream:error` — the stream's terminal error. */
  streamError?: unknown
  /** `wire:out` / `wire:in` — the envelope's discriminant (`'call'`, `'result'`, `'stream:delta'`, …). */
  kind?: string
  /** `wire:out` / `wire:in` — which codec tier carried the payload (`'raw'` or `'nhtio'`), when known. */
  tier?: string
  /** `wire:out` / `wire:in` — a cheap `JSON.stringify(...).length`-style size estimate; computed ONLY
   *  when a wire hook is registered (see {@link emitIsolationReport}). */
  approxBytes?: number
  /** `codec:escalate` — the argument path that needed to escalate past the `'raw'` tier. */
  argPath?: string
  /** `codec:escalate` — why it escalated (e.g. `'function'`, `'error'`, `'custom-encodable'`). */
  escalateReason?: string
  /** With `debugPayloads: true` on a `call:*`/`wire:*` report — the raw payload body. */
  payload?: unknown
}

/** An isolation report consumer. */
export type IsolationReportCallback = (report: IsolationReport) => void

/**
 * The opt-in observability option block mixed into `createIsolatedService`/`serveIsolated` options.
 * Every reported phase fires {@link onIsolation} (the firehose) AND its matching per-phase-group hook;
 * subscribe to either or both. All optional — omitting them leaves behavior byte-for-byte unchanged.
 */
export interface IsolationObservabilityHooks {
  /** Fires on EVERY report (the firehose). */
  onIsolation?: IsolationReportCallback
  /** `spawn:start` / `spawn:ready` / `spawn:error` — guest connect lifecycle. */
  onSpawn?: IsolationReportCallback
  /** `dispose:start` / `dispose:done` — graceful-then-forced teardown. */
  onDispose?: IsolationReportCallback
  /** `recycle:start` / `recycle:done` — terminate + reconnect through the same transport. */
  onRecycle?: IsolationReportCallback
  /** `crash` — the transport reported an unexpected guest exit/termination. */
  onCrashReport?: IsolationReportCallback
  /** `respawn:auto` — an `autoRespawn` crash-policy verdict was consulted and acted on. */
  onRespawnAuto?: IsolationReportCallback
  /** `call:start` / `call:settle` — a single request/response method call. */
  onCall?: IsolationReportCallback
  /** `stream:start` / `stream:end` / `stream:error` / `stream:cancel` — a streaming method call. */
  onStream?: IsolationReportCallback
  /** `abort:sent` — the host sent an `abort` envelope for an in-flight call. */
  onAbort?: IsolationReportCallback
  /** `wire:out` / `wire:in` — every envelope crossing the wire (verbose; opt in deliberately). */
  onWire?: IsolationReportCallback
  /** `codec:escalate` — the codec escalated an argument past the `'raw'` tier. */
  onCodecEscalate?: IsolationReportCallback
  /** Include payload bodies on `call:*`/`wire:*` reports (see {@link IsolationReport.payload}).
   *  Default `false` — payloads may be large/sensitive, so this is opt-in even when hooks are wired. */
  debugPayloads?: boolean
}

/** The subset of {@link IsolationObservabilityHooks} keys that are per-phase-group report callbacks
 *  (excludes the firehose `onIsolation` and the non-callback `debugPayloads` flag). */
type PerPhaseGroupHookKey = Exclude<
  keyof IsolationObservabilityHooks,
  'onIsolation' | 'debugPayloads'
>

/** Map each phase to its per-phase-group hook key on {@link IsolationObservabilityHooks}. */
const PER_PHASE_GROUP_HOOK: Record<IsolationReportPhase, PerPhaseGroupHookKey> = {
  'spawn:start': 'onSpawn',
  'spawn:ready': 'onSpawn',
  'spawn:error': 'onSpawn',
  'dispose:start': 'onDispose',
  'dispose:done': 'onDispose',
  'recycle:start': 'onRecycle',
  'recycle:done': 'onRecycle',
  'crash': 'onCrashReport',
  'respawn:auto': 'onRespawnAuto',
  'call:start': 'onCall',
  'call:settle': 'onCall',
  'stream:start': 'onStream',
  'stream:end': 'onStream',
  'stream:error': 'onStream',
  'stream:cancel': 'onStream',
  'abort:sent': 'onAbort',
  'wire:out': 'onWire',
  'wire:in': 'onWire',
  'codec:escalate': 'onCodecEscalate',
}

/** Invoke a consumer callback, swallowing any throw so a misbehaving hook never breaks the battery. */
const safeInvoke = (cb: IsolationReportCallback | undefined, report: IsolationReport): void => {
  if (typeof cb !== 'function') return
  try {
    cb(report)
  } catch {
    // A throwing consumer hook must never abort a spawn, call, or stream. Intentionally swallowed.
  }
}

/**
 * Returns `true` when at least one hook relevant to `phase` is registered — the guard
 * {@link emitIsolationReport} uses to skip assembling a report entirely (zero overhead when unhooked).
 */
export const hasIsolationHook = (
  hooks: IsolationObservabilityHooks | undefined,
  phase: IsolationReportPhase
): boolean => Boolean(hooks && (hooks.onIsolation || hooks[PER_PHASE_GROUP_HOOK[phase]]))

/**
 * Build an {@link IsolationReport} (stamping `at`) and dispatch it to the firehose
 * ({@link IsolationObservabilityHooks.onIsolation}) AND the per-phase-group hook for `phase`. A no-op
 * when `hooks` is undefined or carries no relevant callbacks — callers should additionally guard
 * expensive `extra` computation (e.g. `approxBytes` sizing) behind {@link hasIsolationHook} so it is
 * never computed when unhooked. Each callback is invoked through {@link safeInvoke}, so a throwing
 * consumer never disrupts the battery.
 *
 * @param hooks - The isolation observability hooks (may be undefined).
 * @param phase - The phase being reported.
 * @param base - `serviceName` + `spawnCount`, common to every report.
 * @param extra - Phase-specific fields (see {@link IsolationReport}).
 * @param now - Injectable clock for tests; defaults to `new Date().toISOString()`.
 */
export const emitIsolationReport = (
  hooks: IsolationObservabilityHooks | undefined,
  phase: IsolationReportPhase,
  base: { serviceName?: string; spawnCount: number },
  extra?: Omit<Partial<IsolationReport>, 'phase' | 'at' | 'serviceName' | 'spawnCount'>,
  now: () => string = () => new Date().toISOString()
): void => {
  if (!hasIsolationHook(hooks, phase)) return
  const report: IsolationReport = {
    phase,
    at: now(),
    serviceName: base.serviceName,
    spawnCount: base.spawnCount,
    ...(extra ?? {}),
  }
  safeInvoke(hooks!.onIsolation, report)
  safeInvoke(hooks![PER_PHASE_GROUP_HOOK[phase]], report)
}
