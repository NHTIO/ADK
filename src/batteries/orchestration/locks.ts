/**
 * The execution lease seam — a BYO, OPTIONAL lock for RUNNING a plan.
 *
 * This file is **types only — no implementation**. It is a seam a deployment may satisfy with
 * Verrou directly (memory / Redis / Postgres drivers) or with anything else; the battery adds no
 * dependency. A deployment that omits it and only ever runs one executor process is unaffected.
 *
 * ## Execution only, never editing
 *
 * The lock is for **execution**, not for editing. Editing is deliberately multi-writer: the op
 * log converges, so a model and an operator (or two sub-dispatches) can all contribute to an
 * `editable` plan concurrently, and that is the intended workflow, not a hazard. Execution is the
 * opposite — a run has real side effects and one plan has at most one run, so two processes
 * driving the same run would double-execute every `call` node. The lock exists to make that
 * concurrent execution unlikely.
 *
 * ## Coordination, not mutual exclusion
 *
 * This is **coordination, not mutual exclusion**. A TTL lease without a
 * fencing token cannot prevent a partitioned or GC-stalled holder from continuing past expiry
 * while a second executor legitimately acquires the lease. That is the classic lease-without-
 * fencing hazard, and no TTL tuning fixes it. We deliberately do **not** add a fencing token:
 * closing the gap properly needs a monotonic epoch issued with the lease, carried on every
 * durable write, with the store rejecting stale-epoch writes — which would change every
 * `PlanStore` implementation.
 *
 * The residual, stated plainly: **a partitioned original executor CAN double-invoke a node.** The
 * defence against that is the per-node `onIndeterminate` policy plus `replaySafe`, which already
 * exist for exactly this class of ambiguity. Supplying a lock makes concurrent execution UNLIKELY
 * rather than impossible.
 *
 * ## What `claimRun` does versus what the lock does
 *
 * `claimRun` in the store — not the lock — is what enforces "one plan, at most one run, ever",
 * because the lock is an availability measure a deployment may omit, so the invariant cannot rest
 * on it. The executor MUST claim before invoking any node; the lock is an additional, optional
 * guard against two processes racing to claim the same run.
 */

/**
 * A single execution lease on one plan.
 *
 * A `PlanLock` is a TTL lease (coordination, not mutual exclusion — see the module docs). It is
 * held by the process driving a run and released when the run settles or the lease expires. It
 * does not fence: a partitioned or GC-stalled holder can continue past expiry while a second
 * executor legitimately acquires the lease, so a node may still be double-invoked; the per-node
 * `onIndeterminate` policy plus `replaySafe` are the real defence against that ambiguity.
 */
export interface PlanLock {
  /**
   * Acquire the lease, retrying on contention.
   *
   * Returns `true` when this process now holds the lease, `false` when it could not acquire it
   * within the retry budget. `retry.timeout` bounds the whole attempt (a number of milliseconds
   * or a duration string), `retry.delay` is the pause between attempts, and `retry.attempts`
   * caps the number of tries. A caller that gets `false` must treat the run as executing
   * elsewhere and not start a duplicate.
   */
  acquire(o?: {
    retry?: { timeout?: number | string; delay?: number; attempts?: number }
  }): Promise<boolean>

  /**
   * Acquire the lease with a single, non-retrying attempt.
   *
   * Returns `true` when this process now holds the lease, `false` when it is held elsewhere.
   * Useful for a fast, best-effort check before committing to a run.
   */
  acquireImmediately(): Promise<boolean>

  /**
   * Release the lease.
   *
   * Idempotent and safe to call when the lease is already expired or held by another process —
   * it must not release a lease this process does not hold. Called when a run settles or is
   * abandoned.
   */
  release(): Promise<void>

  /**
   * Run `fn` while holding the lease.
   *
   * Returns `[executed, result]` as a tuple: `[false]` when the lease is held elsewhere, so a
   * second process reports "already executing elsewhere" rather than starting a duplicate; on
   * success it returns `[true, result]` with `fn`'s resolved value. The lease is released when
   * `fn` settles, whether it resolves or rejects.
   */
  run<T>(fn: () => Promise<T>): Promise<[executed: boolean, result?: T]>

  /**
   * Extend the lease's TTL.
   *
   * Exists so a long `call` node keeps its lease alive past the original TTL. `duration` is the
   * new remaining time (a number of milliseconds or a duration string); when omitted, the lease
   * is extended by its configured TTL. A no-op if this process no longer holds the lease.
   */
  extend(duration?: number | string): Promise<void>

  /**
   * The lease's remaining time-to-live in milliseconds.
   *
   * Exists so a long `call` node can decide whether to `extend()` before the lease lapses. A
   * non-positive value means the lease has expired (or is held elsewhere).
   */
  getRemainingTime(): Promise<number>

  /**
   * Whether the lease is currently held (by any process).
   *
   * A best-effort liveness probe; it does not tell the caller whether THIS process holds the
   * lease, and it is subject to the same partition/GC blind spot as every TTL lease.
   */
  isLocked(): Promise<boolean>

  /**
   * The identity of the current holder, or an empty string when the lease is free.
   *
   * Synchronous and best-effort — it reflects the last observed state, not a fresh read.
   */
  getOwner(): string

  /**
   * Serialize the lease to a string.
   *
   * Exists so a lease can be handed from the process that started a run to the one resuming it:
   * the resuming process passes the serialized lease to `PlanLockFactory.restoreLock` and
   * continues holding the same lease rather than racing to re-acquire it.
   */
  serialize(): string
}

/**
 * Creates and restores `PlanLock` instances for a deployment.
 *
 * A BYO seam: a consumer can satisfy it with Verrou directly (memory / Redis / Postgres drivers)
 * or with anything else; the battery adds no dependency. Supplying a factory makes concurrent
 * execution UNLIKELY rather than impossible — it does not fence, and a partitioned holder can
 * still double-invoke a node (see the module docs).
 */
export interface PlanLockFactory {
  /**
   * Create a new lease for `key`, with an optional TTL (a number of milliseconds or a duration
   * string). The lease is not acquired until `acquire`/`acquireImmediately`/`run` is called.
   */
  createLock(key: string, ttl?: number | string): PlanLock

  /**
   * Rehydrate a lease from a string produced by `PlanLock.serialize`.
   *
   * Exists so a lease can be handed from the process that started a run to the one resuming it,
   * letting the resuming process continue holding the same lease rather than racing to re-acquire
   * it. The restored lock must behave as the original for the remainder of its TTL.
   */
  restoreLock(serialized: string): PlanLock
}
