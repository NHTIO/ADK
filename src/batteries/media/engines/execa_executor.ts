/**
 * A {@link @nhtio/adk/batteries/media/contracts!BinaryExecutor} implementation that runs
 * invocations as local child processes via execa.
 *
 * @module @nhtio/adk/batteries/media/engines/execa_executor
 *
 * @remarks
 * The bundled local-process executor. `execa` is an optional peer dependency acquired through
 * an async resolver (default: a lazy dynamic import) — importing this module pulls nothing;
 * constructing the executor is what resolves the peer, and only on first `exec`.
 *
 * Process execution is a movable seam: anything implementing the `BinaryExecutor` contract —
 * a remote runner, a sandbox, a container shim — composes into binary engines exactly like
 * this one. The paired `ScratchWorkspace` must produce paths this executor can open; for the
 * local-process case, the bundled `fs_workspace` is the natural pair.
 */

import { isError, isObject } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type { BinaryExecutor, BinaryInvocation, BinaryExecResult } from '../contracts'

/**
 * The subprocess handle execa returns: promise-shaped AND carrying the live OS process.
 *
 * @remarks
 * Kept minimal for BYO substitution in tests — a consumer may supply any function of this shape
 * instead of execa. The default resolver returns execa's own subprocess, which is a promise with
 * `pid`/`kill` merged in; the group-kill path reads `pid` and only ever calls `kill`, so a
 * hand-rolled fake without them simply falls back to execa's own kill behaviour.
 */
export interface ExecaSubprocessLike {
  /** The spawned process id; `undefined` when the process failed to spawn. */
  readonly pid?: number
  /** Send a signal to the process. Execa's own kill honours `forceKillAfterDelay`. */
  kill: (signal?: string) => boolean
  /** The promise-style completion surface (`then`/`catch` merged onto the subprocess). */
  then: Promise<ExecaResultLike>['then']
  /** The promise-style rejection surface. */
  catch: Promise<ExecaResultLike>['catch']
}

/** The settled result slice this executor reads from execa. */
export interface ExecaResultLike {
  /** The process exit code; `undefined` when a signal or spawn failure ended it. */
  exitCode?: number
  /** Captured standard output (execa returns a string by default). */
  stdout?: unknown
  /** Captured standard error. */
  stderr?: unknown
  /** The signal that terminated the process, when one did (execa reports names like `'SIGKILL'`). */
  signal?: unknown
  /** `true` when the invocation failed (non-zero exit, signal kill, timeout, spawn failure). Executor-owned timeouts always report true, even if the process exits 0 after termination. */
  failed: boolean
}

/** The slice of execa this executor uses (kept minimal for BYO substitution in tests). */
export interface ExecaLike {
  (
    cmd: string,
    args: readonly string[],
    options: {
      timeout?: number
      cancelSignal?: AbortSignal
      reject: false
      stripFinalNewline?: boolean
      cwd?: string
      env?: Record<string, string>
      extendEnv?: boolean
      killSignal?: string
      forceKillAfterDelay?: number | false
      detached?: boolean
    }
  ): ExecaSubprocessLike & ExecaResultLike
}

/** Resolver forms accepted for the execa module. */
export type ExecaResolver =
  | ExecaLike
  | (() => ExecaLike | { execa: ExecaLike } | Promise<ExecaLike | { execa: ExecaLike }>)

/** Options for {@link execaExecutor}. */
export interface ExecaExecutorOptions {
  /**
   * The execa function or an async resolver for it. Defaults to a lazy dynamic import of the
   * `execa` package (optional peer).
   */
  execa?: ExecaResolver
  /**
   * Default timeout in milliseconds when an invocation does not specify one (default: 120,000).
   * `0`, `Infinity`, and finite values above 2,147,483,647 mean no deadline; negative values and
   * `NaN` reject before spawning.
   */
  defaultTimeoutMs?: number
  /** Default {@link BinaryInvocation.killSignal} applied when an invocation does not specify one. */
  defaultKillSignal?: string
  /**
   * Default {@link BinaryInvocation.forceKillAfterDelay} (milliseconds before `SIGKILL`; `false`
   * or `Infinity` disables escalation) applied when an invocation does not specify one.
   *
   * @remarks
   * The delay is measured on the MONOTONIC clock from the moment the first kill signal is sent,
   * and settlement follows {@link ExecaExecutorOptions.defaultSettleEscalation}: wait (default),
   * cancel, or post-return polling. See {@link ExecaExecutorOptions.detached} for process targeting.
   * Because the clock is monotonic, a wall-clock (NTP) step cannot move the deadline or strand
   * the timer. `Infinity` disables escalation, like an infinite timeout disables its deadline.
   */
  defaultForceKillAfterDelay?: number | false
  /**
   * Default settlement policy when abort/timeout has begun and escalation is armed. Defaults to
   * `'wait'`: no survivors, but settlement may be delayed up to the escalation deadline. `'cancel'`
   * returns fastest but survivors may remain; `'poll'` returns fastest and kills a surviving
   * target later, with a narrow PGID-reuse risk after return. Normal exits are unaffected.
   * Wait and poll apply only with finite escalation and a known pid. Both probe numeric PGIDs:
   * empty-and-reused between probes can mis-signal an unrelated group, bounded to the wait window
   * in wait mode. With `detached: false`, settlement cancels escalation in every mode.
   */
  defaultSettleEscalation?: 'wait' | 'cancel' | 'poll'
  /**
   * Whether children are spawned as process-group leaders (`detached: true` in POSIX terms).
   * Defaults to `true`.
   *
   * @remarks
   * Group-kill is the executor's cancellation story: a binary behind a wrapper (sandbox → shell →
   * command) leaves grandchildren, and a plain `kill(pid)` kills only the direct child. Spawning
   * detached costs nothing at run time — the child keeps running like any other — and in exchange
   * every termination path can signal the group (`kill(-pid, …)`) so those grandchildren die too.
   *
   * `detached: false` selects the direct-child termination story instead, and it is not merely a
   * weaker group kill: the child is NOT a process-group leader, so `-pid` does not name its group.
   * Every path then signals the direct child alone (`subprocess.kill(sig)`), probes the direct
   * child's liveness (never the group's), and escalates `SIGKILL` to that same child.
   *
   * Settlement after termination is controlled by `defaultSettleEscalation` (default `'wait'`).
   * `wait` holds settlement until the detached group empties or SIGKILL is sent; `cancel` returns
   * immediately and may leave descendants; `poll` returns immediately and watches the group later.
   */
  detached?: boolean
}

/**
 * Terminate a spawned process group: the direct child AND everything it wrapped.
 *
 * @remarks
 * ONLY for `detached: true`. When the executor spawns `detached: false` the child is not a group
 * leader, so `-pid` names no group and the group paths (this function and {@link groupAlive}) are
 * never used — signalling that way would ESRCH and, worse, make the liveness probe report the
 * group as dead so a `SIGKILL` escalation silently never fires.
 *
 * `process.kill(-pid, sig)` signals the whole GROUP the child leads (it is its own group leader
 * because the child was spawned `detached`); a child that has already been reaped makes that throw
 * `ESRCH`, which is fine — nothing is left to kill, so the per-process fallback still runs and
 * fails equally quietly. Absent `pid` (spawn failure, or a BYO `ExecaLike` that does not expose
 * one) falls back to execa's own `kill`, which is still correct for the direct child.
 */
const killGroup = (pid: number | undefined, signal: string, fallback: () => void): void => {
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal as never)
      return
    } catch {
      // ESRCH (already gone) or a platform without negative-pid semantics: fall through.
    }
  }
  fallback()
}

/**
 * Whether the process group led by `pid` still has members.
 *
 * @remarks
 * Only meaningful for a `detached: true` child (the group it leads). The `detached: false` path
 * probes the direct child instead, see {@link childAlive}.
 *
 * Signal `0` performs the permission/existence probe without delivering anything. The deadline
 * probe guards an in-flight SIGKILL escalation against an already-gone target.
 */
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the DIRECT child `pid` is still running — the `detached: false` counterpart of
 * {@link groupAlive}.
 *
 * @remarks
 * Signal `0` with a POSITIVE pid probes that one process, which is exactly the target the
 * non-detached path signals; a negative pid would probe a group the child does not lead.
 */
const childAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The escalation clock: MONOTONIC milliseconds, so a wall-clock (NTP) step can neither move a
 * deadline nor strand a timer that is waiting for one.
 *
 * @remarks
 * `performance.now()` is the monotonic clock the runtime exposes in Node (>=16) and in every
 * browser bundle, and it advances with the timer heap — which is exactly the property the
 * deadline timer needs. `Date.now()` is deliberately NOT used anywhere in the escalation: a
 * backwards wall-clock step (or a timer firing a fraction of a millisecond before the wall-clock
 * deadline it was scheduled for) makes a wall comparison say "not due" at a moment when nothing
 * will ever re-check it.
 */
const monotonicNow = (): number => performance.now()

/** Probe cadence while settlement is held or post-return polling is enabled. */
const ESCALATION_POLL_MS = 100

/** The terminal states of an escalation: `armed` becomes `cancelled` or `fired`, never both. */
type EscalationState = 'armed' | 'cancelled' | 'fired'

/**
 * The one-shot `SIGKILL` escalation for a single invocation.
 *
 * @remarks
 * A monotonic deadline timer drives escalation; wait and poll add liveness probes at settlement.
 * An early timer fire re-arms for the remaining time. Cancellation and firing are terminal.
 * Wait timers are ref'd; in-flight and post-return poll timers are unref'd.
 */
interface Escalation {
  /** Start the deadline timer, `delay` monotonic-clock milliseconds from now. */
  arm(): void
  /** Wait mode: keep probing until empty or the one SIGKILL is sent. */
  wait(): Promise<void>
  /** Poll mode: probe after return, latching off once empty. */
  poll(): void
  /** Cancel permanently; nothing is signalled after this. */
  cancel(): void
}

/**
 * `unref` a timer so it cannot keep the event loop alive on its own account.
 *
 * @remarks
 * Node's `Timeout` always has `unref`; the shape check covers exotic runtimes without holding the
 * process open on them.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const unrefTimer = (timer: { unref?: () => void } | undefined): void => {
  if (typeof timer?.unref === 'function') timer.unref()
}

/**
 * Build the `SIGKILL` escalation state machine for one invocation.
 *
 * @remarks
 * The probe and kill are injected so the machine serves both termination stories: the process
 * group and the direct child. All modes share one deadline and terminal-state latch.
 */
const createEscalation = (config: {
  /** Probe the escalation target: the process group, or the direct child in direct-child mode. */
  alive: () => boolean
  /** Deliver the one-shot `SIGKILL` to the target. */
  kill: () => void
  /** Milliseconds from `arm()` until the `SIGKILL` is due. */
  delay: number
}): Escalation => {
  let state: EscalationState = 'armed'
  /**
   * When the `SIGKILL` is due, in monotonic-clock milliseconds — fixed at `arm()` time, never
   * re-based on settlement.
   */
  let deadline = 0
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let waiting = false

  const stop = (next: 'cancelled' | 'fired'): void => {
    if (state !== 'armed') return
    state = next
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer)
      deadlineTimer = undefined
    }
    if (interval !== undefined) {
      clearInterval(interval)
      interval = undefined
    }
    resolveDone()
  }

  /**
   * At the deadline, cancel if the target is already gone; otherwise send one `SIGKILL`.
   *
   * @remarks
   * A timer can fire before the monotonic deadline (for example, due to sub-millisecond rounding).
   * In that case, re-arm it for the remaining time; otherwise, cancel if the target is gone or
   * send the one `SIGKILL`.
   */
  const check = (): void => {
    if (state !== 'armed') return
    // Empty is terminal: a later reappearance may be a reused PGID, not our target.
    if (!config.alive()) return stop('cancelled')
    const remaining = deadline - monotonicNow()
    if (remaining > 0) {
      // An early timer fire re-arms for the remainder of the deadline.
      //
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      deadlineTimer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS))
      if (!waiting) unrefTimer(deadlineTimer)
      return
    }
    config.kill()
    stop('fired')
  }

  return {
    arm: (): void => {
      if (state !== 'armed') return
      deadline = monotonicNow() + config.delay
      deadlineTimer = setTimeout(check, Math.min(config.delay, MAX_TIMER_DELAY_MS))
      unrefTimer(deadlineTimer)
    },
    wait: (): Promise<void> => {
      if (state !== 'armed') return Promise.resolve()
      waiting = true
      const timer = deadlineTimer as
        | (ReturnType<typeof setTimeout> & { ref?: () => void })
        | undefined
      timer?.ref?.()
      const probe = (): void => {
        if (state !== 'armed') return
        if (!config.alive()) stop('cancelled')
      }
      probe()
      if (state === 'armed' && interval === undefined)
        interval = setInterval(probe, ESCALATION_POLL_MS)
      return done
    },
    poll: (): void => {
      if (state !== 'armed') return
      check()
      if (state === 'armed' && interval === undefined) {
        interval = setInterval(check, ESCALATION_POLL_MS)
        unrefTimer(interval)
      }
    },
    cancel: (): void => stop('cancelled'),
  }
}

const resolveExeca = async (supplied: ExecaResolver | undefined): Promise<ExecaLike> => {
  let value: unknown =
    supplied ??
    ((): Promise<{ execa: ExecaLike }> =>
      import('execa') as unknown as Promise<{ execa: ExecaLike }>)
  if (typeof value === 'function' && !('exec' in (value as object))) {
    try {
      value = await (value as () => unknown)()
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `execa resolver failed: ${detail} — install the optional peer dependency "execa" or supply your own`,
      ])
    }
  }
  if (isObject(value) && 'execa' in value) {
    value = (value as { execa: unknown }).execa
  }
  if (typeof value !== 'function') {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG(['execa resolver did not resolve to a function'])
  }
  return value as ExecaLike
}

/**
 * Construct the bundled local-process {@link BinaryExecutor}.
 *
 * @remarks
 * Termination follows the `detached` flag on every abort and timeout path. With `detached: true`
 * (the default) it is a PROCESS-GROUP kill: the child is spawned detached (its own group leader)
 * and `killGroup` — `kill(-pid, killSignal)` — reaches everything behind a wrapper (sandbox →
 * shell → command). Once termination begins, `settleEscalation` defaults to `'wait'`: settlement
 * waits until the group is empty or the one SIGKILL is sent, at most the remaining escalation
 * delay. `'cancel'` returns fastest but may leave survivors; `'poll'` returns fastest and watches
 * survivors after return with unref'd timers. Both probing modes have a narrow PGID-reuse risk
 * between probes; wait bounds it to before return. Normal exits never wait or poll.
 * With `detached: false` only the DIRECT child is signalled (`subprocess.kill`) and probed
 * (`process.kill(pid, 0)`); all modes cancel at settlement because that child is already reaped.
 * execa's own abort machinery still runs underneath: it kills the direct child at roughly
 * the same moment, so the promise settles whichever mechanism wins the race — in group mode the
 * group signal is what the WRAPPER and its grandchildren die from. execa's `forceKillAfterDelay`
 * is forwarded as given so its own kill escalates identically when IT is the one that fires.
 * The executor owns the timeout (never forwarded to execa), so every timeout terminates the group
 * or direct child through the same escalation path. Its deadline timer stays ref'd until settlement.
 * `0` and `Infinity` mean no deadline. Finite timeouts above 2,147,483,647 milliseconds also
 * disable the deadline rather than overflowing Node's timer into an immediate kill. Negative
 * values and `NaN` reject with a `TypeError` before spawning, as execa 9 did.
 * Non-zero exits are DATA: `reject: false` keeps execa from throwing and every settlement —
 * spawn failure, timeout, abort, non-zero exit — lands in the returned record, never a rejection.
 * `signalCode` is surfaced additively when execa reports the terminating signal.
 *
 * @param options - The execa resolver and defaults (timeout, kill signal/escalation, detached).
 * @returns A `BinaryExecutor` running invocations as local child processes.
 */
export const execaExecutor = (options: ExecaExecutorOptions = {}): BinaryExecutor => {
  let execaPromise: Promise<ExecaLike> | undefined
  const getExeca = (): Promise<ExecaLike> => {
    execaPromise ??= resolveExeca(options.execa)
    return execaPromise
  }
  const detached = options.detached ?? true
  return {
    async exec(invocation: BinaryInvocation): Promise<BinaryExecResult> {
      const execa = await getExeca()
      const pidOf = (target: { pid?: number }): number | undefined => target.pid
      const signal = invocation.killSignal ?? options.defaultKillSignal ?? 'SIGTERM'
      // `false` is a MEANINGFUL value (never escalate); only `undefined` falls back to the
      // executor default — coalescing the two would make "no escalation" unexpressible.
      const forceKillAfterDelay =
        invocation.forceKillAfterDelay !== undefined
          ? invocation.forceKillAfterDelay
          : (options.defaultForceKillAfterDelay ?? 5_000)
      const timeout = invocation.timeoutMs ?? options.defaultTimeoutMs ?? 120_000
      const settleEscalation =
        invocation.settleEscalation ?? options.defaultSettleEscalation ?? 'wait'
      if (
        settleEscalation !== 'wait' &&
        settleEscalation !== 'cancel' &&
        settleEscalation !== 'poll'
      )
        throw new TypeError(
          `Expected settleEscalation to be 'wait', 'cancel', or 'poll', got ${String(settleEscalation)}`
        )
      if (Number.isNaN(timeout) || timeout < 0) {
        throw new TypeError(`Expected timeoutMs to be a non-negative number, got ${timeout}`)
      }
      if (
        forceKillAfterDelay !== false &&
        (Number.isNaN(forceKillAfterDelay) || forceKillAfterDelay < 0)
      ) {
        throw new TypeError(
          `Expected forceKillAfterDelay to be a non-negative number, got ${forceKillAfterDelay}`
        )
      }
      // The executor owns escalation; don't give execa a disabled or overflowing timer. Execa
      // rejects Infinity and Node clamps delays above MAX_TIMER_DELAY_MS to an early 1ms timer.
      const execaForceKillAfterDelay =
        forceKillAfterDelay === false ||
        forceKillAfterDelay === Infinity ||
        forceKillAfterDelay > MAX_TIMER_DELAY_MS
          ? false
          : forceKillAfterDelay
      let terminate: (() => void) | undefined
      /** The `SIGKILL` escalation for this invocation, including its settlement policy. */
      let escalation: Escalation | undefined
      /** The executor-owned deadline for group (or direct-child) termination. */
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      let subprocess: ReturnType<ExecaLike> | undefined
      let terminating = false
      let timedOut = false
      /** Set once the invocation has settled, preventing any further termination. */
      let settled = false
      try {
        subprocess = execa(invocation.cmd, invocation.args, {
          cancelSignal: invocation.signal,
          reject: false,
          stripFinalNewline: true,
          ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
          ...(invocation.env === undefined ? {} : { env: invocation.env }),
          extendEnv: invocation.extendEnv ?? true,
          killSignal: signal,
          forceKillAfterDelay: execaForceKillAfterDelay,
          detached,
        })
        // Abort or timeout: terminate the group (including grandchildren) when detached, or the
        // direct child otherwise. Only abort also runs execa's own kill machinery. Fired when the
        // invocation is actually being torn down — a child that exits inside the window never
        // needs it. `terminating` guards the double path (both abort and timeout firing, or execa
        // completing in between).
        terminate = (): void => {
          if (settled || terminating || !subprocess) return
          terminating = true
          const pid = pidOf(subprocess)
          // Only the detached child leads a group `-pid` could name: with `detached: false` a
          // group signal would ESRCH and the liveness probe would wrongly report the target as
          // dead, so the child is signalled DIRECTLY on every path instead.
          const child = subprocess
          if (detached && pid !== undefined) {
            killGroup(pid, signal, () => {
              try {
                child?.kill(signal)
              } catch {
                // The child may already be gone; nothing left to do.
              }
            })
          } else {
            try {
              child.kill(signal)
            } catch {
              // The child may already be gone; nothing left to do.
            }
          }
          if (
            forceKillAfterDelay !== false &&
            Number.isFinite(forceKillAfterDelay) &&
            pid !== undefined
          ) {
            escalation = createEscalation({
              delay: forceKillAfterDelay,
              // Group mode probes the GROUP; direct-child mode probes that one pid before the
              // in-flight escalation. An empty observation cancels the escalation.
              alive: () => (detached ? groupAlive(pid) : childAlive(pid)),
              kill: () => {
                if (detached) {
                  try {
                    process.kill(-pid, 'SIGKILL')
                  } catch {
                    try {
                      child.kill('SIGKILL')
                    } catch {
                      // Gone already.
                    }
                  }
                } else {
                  try {
                    child.kill('SIGKILL')
                  } catch {
                    // Gone already.
                  }
                }
              },
            })
            // A single deadline timer drives escalation while the invocation is in flight.
            escalation.arm()
          }
        }
        if (invocation.signal) {
          if (invocation.signal.aborted) terminate()
          else
            invocation.signal.addEventListener('abort', terminate, {
              once: true,
            })
        }
        // The executor owns the timeout so EVERY timeout terminates the group (or direct child)
        // through `terminate`, including escalation. Keep this timer ref'd: a pending invocation
        // must hold the event loop alive, just as execa's timeout would.
        // It is skipped when the caller's signal starts out aborted (already terminating), and
        // `terminate` is then a no-op anyway.
        // Disable zero/infinite/oversized deadlines: Node clamps timer overflow to 1ms.
        if (
          !terminating &&
          Number.isFinite(timeout) &&
          timeout > 0 &&
          timeout <= MAX_TIMER_DELAY_MS
        )
          deadlineTimer = setTimeout(() => {
            timedOut = true
            terminate?.()
          }, timeout)
        const result = await subprocess
        return {
          exitCode: result.exitCode ?? -1,
          stdout: typeof result.stdout === 'string' ? result.stdout : '',
          stderr: typeof result.stderr === 'string' ? result.stderr : '',
          failed: result.failed || timedOut,
          ...(typeof result.signal === 'string' ? { signalCode: result.signal } : {}),
        }
      } finally {
        // Prevent further abort/timeout handling before settlement policy handles the one armed
        // escalation. Wait mode drives the existing state machine here; no second probe is created.
        settled = true
        // The deadline timer belongs to THIS call only; an invocation that finished on its own
        // (or was already torn down) must never arm a group kill for later.
        if (deadlineTimer !== undefined) {
          clearTimeout(deadlineTimer)
          deadlineTimer = undefined
        }
        // Detach the caller's abort listener on EVERY exit path, so a completed invocation never
        // fires a kill into an already-reaped process (group or direct child).
        if (terminate && invocation.signal)
          invocation.signal.removeEventListener('abort', terminate)
        terminate = undefined
        // Termination-only policy: normal exits always cancel; wait and poll share the same machine.
        if (escalation !== undefined && terminating) {
          if (settleEscalation === 'wait' && detached) await escalation.wait()
          else if (settleEscalation === 'poll' && detached) escalation.poll()
          else escalation.cancel()
        } else escalation?.cancel()
      }
    },
  }
}
