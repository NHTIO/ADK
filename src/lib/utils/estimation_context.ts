import { isInstanceOf } from './guards'
import type { TokenEncoding } from '../classes/tokenizable'

/**
 * Ambient channel that lets a leaf token estimator ({@link @nhtio/adk!Tokenizable.estimateTokens} and the
 * primitives that delegate to it) discover whether it is running inside a runner execution — and, if so,
 * surface a non-fatal warning instead of throwing.
 *
 * @remarks
 * **Why this exists.** `estimateTokens(encoding)` takes only an encoding — it is never handed the
 * {@link @nhtio/adk!DispatchContext}. JavaScript closures are lexical, so the runner's context (a
 * different module) is NOT in scope inside the estimator; the estimator cannot check it directly. The
 * behavioural contract we need is:
 *
 * - **inside a TurnRunner run or DispatchRunner dispatch** — a token-estimation failure must DEGRADE to a
 *   cheap char-based guesstimate AND emit a `warning` (never kill the turn/dispatch);
 * - **outside those executions** — FAIL LOUD (throw), because a genuine encoder failure in non-runner code
 *   is a real bug that must surface.
 *
 * A runner publishes its warn-emit capability here for the duration of its run; the estimator reads
 * {@link currentEstimationWarnEmitter} in its catch — present ⇒ degrade + warn, absent ⇒ throw. The
 * ambient scope IS the definition of "am I in a runner execution?".
 *
 * **Stack, not a single slot.** `DispatchRunner.dispatch()` is a public entry point called both standalone
 * AND nested inside `TurnRunner.run()`. A LIFO stack means the innermost active runner wins: a dispatch
 * running inside a turn pushes on top of the turn's emitter, so estimations during the dispatch route to
 * the (richer, dispatch-scoped) emitter, and the turn's is restored when the dispatch returns. "Prefer the
 * dispatch channel when both are active" is the stack order, not a special case.
 *
 * **Synchronous by design.** Token estimation is synchronous, so the emitter on top of the stack is always
 * the one for the currently-executing estimation. {@link runWithEstimationWarnings} still restores the
 * stack in a `finally`, so an async runner body that awaits (with no synchronous estimation crossing the
 * await) remains correct: the push/pop bracket the whole body. No `async_hooks` — this runs in the browser
 * bundle too.
 */
export interface EstimationWarning {
  /** The encoding whose real tokenizer failed, triggering the degrade. */
  encoding: TokenEncoding
  /** The underlying error thrown by the encoder (surfaced for diagnostics). */
  error: unknown
  /** A short, bounded preview of the text being estimated — never the full value. */
  textPreview: string
}

/** Sink invoked by the estimator when it degrades inside a runner. */
export type EstimationWarnEmitter = (warning: EstimationWarning) => void

// Module-level LIFO of active warn-emit sinks. Empty ⇒ no runner execution is active ⇒ estimators throw.
const stack: EstimationWarnEmitter[] = []

/**
 * Run `body` with `emit` published as the active estimation warn-sink, restoring the previous state
 * afterwards. Runners bracket their whole run/dispatch in this so any token estimation performed within
 * (in an executor, a pipeline, a gate) can degrade-and-warn instead of throwing.
 *
 * @param emit - Sink the leaf estimator calls when it degrades; the runner forwards it to its `warning` bus.
 * @param body - The runner's work. May be sync or return a Promise; the sink stays active until it settles.
 * @returns Whatever `body` returns (including a Promise, which is awaited so the `finally` pops after it).
 */
export function runWithEstimationWarnings<T>(emit: EstimationWarnEmitter, body: () => T): T {
  stack.push(emit)
  let popped = false
  const pop = (): void => {
    if (popped) return
    popped = true
    // Pop OUR entry specifically (by identity) rather than blindly truncating, so a misuse elsewhere
    // cannot desynchronise the stack.
    const idx = stack.lastIndexOf(emit)
    if (idx !== -1) stack.splice(idx, 1)
  }
  try {
    const result = body()
    // Cross-realm-safe Promise check (bare `instanceof Promise` is fragile across realms — see
    // CONTRIBUTING §Class identity guards). Runner bodies are async, so this is the live path.
    if (isInstanceOf<Promise<unknown>>(result, 'Promise', Promise)) {
      // Keep the sink active until the async body settles, then pop regardless of outcome.
      return result.finally(pop) as unknown as T
    }
    pop()
    return result
  } catch (err) {
    pop()
    throw err
  }
}

/**
 * The warn-sink for the innermost active runner execution, or `undefined` when none is active. A leaf
 * estimator reads this in its catch: `undefined` is the signal to THROW (outside any runner); a defined
 * sink is the signal to emit a warning and return the char-based guesstimate.
 */
export function currentEstimationWarnEmitter(): EstimationWarnEmitter | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined
}
