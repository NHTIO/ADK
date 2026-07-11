/**
 * Shared exception for the context-management batteries — the one failure class `thrift` and
 * `compact` have in common.
 *
 * @module @nhtio/adk/batteries/context/exceptions
 *
 * @remarks
 * Both `thrift` (`subtractToFit`) and `compact` (`summariseTurns`, `assembleCompactedTurns`) require
 * a caller-injected resolver (`estimateTokens`, and for `compact` also `summarize`) because neither
 * battery bundles a tokenizer or a model transport of its own — see each battery's `contracts.ts` for
 * the "surface, don't impose" rationale. A missing resolver is the SAME failure shape in both
 * batteries (a required injected function wasn't supplied), so it is minted ONCE here rather than
 * duplicated per-battery. This module lives at the `context` domain level (a sibling of `thrift/` and
 * `compact/`, not inside either) specifically so both can import it without either depending on the
 * other, and re-exports from `../index.ts` so a consumer of either battery's public barrel sees it
 * without a deep import. Minted via `createException` from `@nhtio/adk/factories`, matching every
 * other battery's exception convention.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when a context-management battery function is called without a REQUIRED injected resolver
 * (`estimateTokens`, or — for Compact's `summarize` seam — the model-call function).
 *
 * @remarks
 * Both `@nhtio/adk/batteries/context/thrift` and `@nhtio/adk/batteries/context/compact` ship with no
 * bundled tokenizer and (for Compact) no bundled model transport — every capability they cannot
 * perform themselves is an INJECTED function the caller must supply. Omitting one is a caller
 * programming error (a wiring mistake, not a runtime condition to recover from): rather than let the
 * omission surface later as a confusing `undefined is not a function` deep inside the algorithm, every
 * entry point checks eagerly and throws this, naming both the missing option and the function that
 * needed it, so the fix is obvious at the call site. Fatal — construct the missing resolver and retry;
 * there is no degrade-and-continue path, because a battery with no way to measure tokens (or, for
 * Compact, no way to call a model) cannot make progress at all.
 *
 * Printf args: `[functionName, missingOption]` — e.g. `['subtractToFit', 'estimateTokens']` or
 * `['summariseTurns', 'summarize']`.
 *
 * @example
 * ```ts
 * import { isInstanceOf } from '@nhtio/adk'
 *
 * try {
 *   subtractToFit(ws, contextWindow, relevantToolNames, {} as never)
 * } catch (err) {
 *   if (isInstanceOf(err, 'E_CONTEXT_RESOLVER_MISSING')) {
 *     // err.message: "subtractToFit: options.estimateTokens is required — this context-management
 *     // battery ships with no bundled tokenizer/model transport of its own."
 *   }
 * }
 * ```
 */
export const E_CONTEXT_RESOLVER_MISSING = createException<[string, string]>(
  'E_CONTEXT_RESOLVER_MISSING',
  '%s: options.%s is required — this context-management battery ships with no bundled tokenizer/model transport of its own.',
  'E_CONTEXT_RESOLVER_MISSING',
  422,
  true
)
