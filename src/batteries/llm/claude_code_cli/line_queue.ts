/**
 * Tiny serial async task queue. Wrapper-only — never imported by `adapter.ts` (mirrors
 * `message_id_state.ts`'s and `cli_protocol.ts`'s own self-containment: no `@nhtio/adk/*` imports
 * anywhere, safe for the wrapper's self-contained-process boundary — Decision A/C).
 *
 * @remarks
 * Extracted out of `wrapper.ts`'s `startTurn` closure (issue #43, fix B follow-up, HIGH
 * verification finding against f3d7fde) so the queue's ordering guarantee is directly,
 * deterministically testable without spawning any process or racing real timers.
 *
 * The bug this exists to make structurally impossible: `wrapper.ts`'s NDJSON line reader invokes
 * its callback SYNCHRONOUSLY, once per complete line, in input order — but the original handler
 * dispatch was `void handleClaudeLine(line)`, unawaited. Since `handleClaudeLine` is `async` and
 * `await`s (e.g. `writeEvent`, which resolves on a real stdout-write callback — not necessarily on
 * the same tick, and not necessarily in call order under backpressure), firing it unawaited let a
 * SECOND line's handler start running, reach its own synchronous prefix, and even fully complete,
 * WHILE the first line's handler was still suspended at an `await`. Any mutable state shared
 * across calls (e.g. `message_id_state.ts`'s per-spawn id counter) could then be read or reset out
 * of order, and any output written from inside the handler (e.g. `message_delta` events) could be
 * written out of input order too.
 *
 * `createSerialQueue` fixes both by construction: every `enqueue`d task is chained strictly
 * after the FULL completion (including every `await` inside it) of the task before it, via a
 * single running `Promise` tail. A task that throws/rejects is caught by `onError` so one bad
 * line can never break the chain for every line enqueued after it — the tail promise itself is
 * never allowed to become rejected, or every subsequent `.then()` chained onto it would skip
 * straight to its own catch, silently dropping every later task.
 */

/** A serial queue: `enqueue`d tasks run strictly one at a time, in the order they were enqueued. */
export interface SerialQueue {
  /** Schedule `task` to run after every previously enqueued task has fully settled. */
  enqueue: (task: () => Promise<void>) => void
}

/**
 * Create a fresh, empty serial queue. `onError` is invoked (never thrown/rejected further) for
 * any task that rejects, so the queue's own tail promise stays perpetually resolved and later
 * tasks are never skipped.
 */
export const createSerialQueue = (onError: (err: unknown) => void): SerialQueue => {
  let tail: Promise<void> = Promise.resolve()
  return {
    enqueue: (task) => {
      tail = tail.then(task).catch(onError)
    },
  }
}
