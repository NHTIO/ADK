import type { GuestLimits, HostcallQuotas, GuestOutcome } from '../types'

/** A declared capability kept in the host runner. */
export interface GuestGlobal {
  /**
   * Host implementation invoked by the guest-facing capability stub.
   *
   * @remarks
   * The signal is lifecycle-scoped, not per call: expiry of `hostcallTimeoutMs` does not
   * fire it. Arguments and results must be structured-clone/codec serialisable, and every
   * guest call is asynchronous even when this host function is synchronous.
   */
  readonly fn: (args: unknown[], signal: AbortSignal) => unknown | Promise<unknown>
  /**
   * Completion policy for an in-flight capability call.
   *
   * @remarks
   * This is required with no default. `killable` kills its child, `cooperative` is
   * best-effort, and `atomic` must finish before recycling; guessing `cooperative` for a
   * capability that spawns a child is unsafe.
   */
  readonly cancellation: 'killable' | 'cooperative' | 'atomic'
}
/** Configuration for the JavaScript guest battery. */
export interface EvaluateJavascriptConfig {
  /**
   * Required approval callback for every evaluation.
   *
   * @remarks
   * Evaluation is a capability-bearing operation, so construction rejects its omission;
   * invoking the gate is a real suspension and a harness with no decider waits indefinitely.
   */
  readonly gate: (ctx: unknown, call: { tool: string; args: unknown }) => void | Promise<void>
  /**
   * Named host capabilities exposed to the guest.
   *
   * @remarks
   * These are declarations, never bare functions: functions cannot cross structured clone.
   * Each name becomes an in-guest asynchronous stub that posts a `hostcall`, even when the
   * host implementation itself is synchronous.
   */
  readonly globals?: Readonly<Record<string, GuestGlobal>>
  /**
   * Allow-listed module specifiers and their host-side values.
   *
   * @remarks
   * Specifiers are re-checked inside the guest. Injecting a module grants the guest whatever
   * that module can reach, and transitive import graphs are deliberately not policed.
   */
  readonly modules?: Readonly<Record<string, unknown>>
  /**
   * Guest resource limits, resolved once by the tool factory.
   *
   * @remarks
   * Defaults are merged and floors validated; invalid values name the field, value, and
   * bound in `E_INVALID_SANDBOX_CONFIG`. The enforcing runtime receives the fully resolved
   * limits and never re-derives a default.
   */
  readonly limits?: Partial<GuestLimits>
  /**
   * Hostcall quotas, resolved once by the tool factory.
   *
   * @remarks
   * Defaults are merged and floors validated; invalid values name the field, value, and
   * bound in `E_INVALID_SANDBOX_CONFIG`. The enforcing layer receives resolved quotas rather
   * than inventing its own defaults.
   */
  readonly hostcallQuotas?: Partial<HostcallQuotas>
  /**
   * Whether to apply lockdown to the host realm.
   *
   * @remarks
   * This governs only the host realm and is process-global and irreversible. The guest's own
   * `lockdown()` always runs; that guest lockdown is the security guarantee.
   */
  readonly hostLockdown?: boolean
  /** Runtime seam used instead of the default SES runtime, typically by an adapter. */
  readonly runtime?: GuestRuntimeLike
}
/** Minimal runtime seam used by the tool and by browser/Node adapters. */
export interface GuestRuntimeLike {
  /**
   * Start an isolated guest with the declared modules, globals, limits, and lifecycle signal.
   *
   * @param o - Fully resolved runtime inputs and the names/shapes of injected capabilities;
   * functions themselves do not cross the boundary.
   * @returns A guest handle whose evaluation can be timed out and whose process can be killed.
   */
  spawn(o: {
    modules: string[]
    globals: ReadonlyArray<{ name: string; kind: 'async-fn' }>
    limits: GuestLimits
    signal?: AbortSignal
  }): Promise<{
    evaluate(source: string, o: { timeoutMs: number }): Promise<GuestOutcome>
    kill(): Promise<void>
  }>
}
