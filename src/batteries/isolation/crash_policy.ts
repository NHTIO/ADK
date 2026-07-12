/**
 * Sliding-window crash-escalation policy for isolated services.
 *
 * @remarks
 * Generalizes the flagship agent's `GpuLossPolicy`
 * (`docs/.vitepress/theme/components/agent/gpu_loss_policy.ts`) — a 2-rung ladder specific to WebGPU
 * device loss — into a domain-neutral N-rung decider any `IsolationTransport` crash can consult. Pure
 * (no DOM/process access beyond the injected clock), so it is unit-testable in isolation and reusable
 * across the Worker (WP2) and child_process (WP3) transports without either depending on the other's
 * crash semantics.
 *
 * This module has zero imports beyond the language itself.
 */

/** The escalation {@link CrashPolicy.record} decided for a single crash event. */
export type CrashVerdict = 'respawn' | 'giveUp'

/** How long a run of crashes must fall within to count toward the same escalation window. */
export const DEFAULT_CRASH_POLICY_WINDOW_MS = 120_000

/** How many crashes inside the window are tolerated (with `'respawn'`) before `'giveUp'`. */
export const DEFAULT_CRASH_POLICY_MAX_CRASHES = 3

/** Options accepted by {@link createCrashPolicy}. */
export interface CrashPolicyOptions {
  /** Sliding window, in ms; a crash older than this no longer counts toward escalation. Default 120_000. */
  windowMs?: number
  /** Crashes tolerated inside the window (inclusive) before `record()` returns `'giveUp'`. Default 3. */
  maxCrashes?: number
  /** Injectable clock (for tests). Default `Date.now`. */
  now?: () => number
}

/** A sliding-window crash-escalation decider, as returned by {@link createCrashPolicy}. */
export interface CrashPolicy {
  /**
   * Record a crash event and return the escalation verdict: `'respawn'` while the number of crashes
   * inside the current window (including this one) is still under `maxCrashes`, `'giveUp'` once it
   * reaches `maxCrashes`. Prunes crashes older than the window before deciding, so a crash burst that
   * cools off resets the count.
   */
  record(): CrashVerdict
  /** Number of crashes currently inside the window (observability/tests). */
  readonly recentCount: number
  /** Clear the crash history (e.g. after a clean recovery + a settled session). */
  reset(): void
}

/**
 * Build a sliding-window crash-escalation policy: the first `maxCrashes - 1` crashes inside `windowMs`
 * each return `'respawn'`; the `maxCrashes`-th (and every crash after it, while still inside the
 * window) returns `'giveUp'`. Two crashes spaced further apart than `windowMs` are each treated as a
 * fresh, first-in-window crash — an occasional isolated crash over a long-running session never
 * escalates.
 *
 * @param options - See {@link CrashPolicyOptions}.
 */
export const createCrashPolicy = (options: CrashPolicyOptions = {}): CrashPolicy => {
  const windowMs = options.windowMs ?? DEFAULT_CRASH_POLICY_WINDOW_MS
  const maxCrashes = options.maxCrashes ?? DEFAULT_CRASH_POLICY_MAX_CRASHES
  const now = options.now ?? Date.now
  let timestamps: number[] = []

  const prune = (): void => {
    const t = now()
    timestamps = timestamps.filter((ts) => t - ts < windowMs)
  }

  return {
    record(): CrashVerdict {
      prune()
      timestamps.push(now())
      return timestamps.length >= maxCrashes ? 'giveUp' : 'respawn'
    },
    get recentCount(): number {
      prune()
      return timestamps.length
    },
    reset(): void {
      timestamps = []
    },
  }
}
