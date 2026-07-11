/**
 * Aggregate barrel for bundled context-management batteries — strategies for fitting a large working
 * set of messages, memories, retrievables, thoughts, and tools into a model's context window.
 *
 * @module @nhtio/adk/batteries/context
 *
 * @remarks
 * A context-management battery answers one question: given more candidate content than a dispatch's
 * window can hold, what do you send? Different strategies answer this differently, at different
 * costs:
 *
 * - **`thrift`** (available now, re-exported below): SUBTRACTIVE — start with everything reasonable,
 *   then shed the lowest-signal content first (an image, stale tool results, the RAG tail, low-value
 *   memories, old turns, guidance thoughts, then tools as a last resort) until the dispatch fits.
 *   Every decision is a measured token comparison; **zero extra model calls**. See
 *   {@link @nhtio/adk/batteries/context/thrift} for the full algorithm and its head-to-head evaluation
 *   results.
 * - **`compact`** (available now, re-exported below): SUMMARIZING — instead of shedding old turns
 *   outright, pay for a model call to compress them into a running summary message, trading a real API
 *   cost for retaining compressed signal from everything folded away. `thrift` already carries the one
 *   hook `compact` needs to coexist with it (the `isSummaryMessage` predicate on
 *   {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!SubtractToFitOptions}), so a caller can
 *   run `compact` upstream and `thrift` downstream in the same pipeline without the two strategies
 *   fighting over the same running-summary message. See {@link @nhtio/adk/batteries/context/compact}
 *   for the full algorithm and its head-to-head evaluation results.
 *
 * These are genuinely different trade-offs, not tiers of the same idea — `thrift` is the cost-optimal,
 * always-available default; `compact` is the strategy to reach for when a project can afford (and
 * benefits from, per the honest head-to-head result documented in the `thrift` battery barrel) paying
 * for compression on top of subtraction. Both are meant to be composable, not mutually exclusive.
 */

export * from './thrift'
export * from './compact'
// The one exception class both strategies share (a required injected resolver — estimateTokens, or
// compact's summarize — was omitted); see src/batteries/context/exceptions.ts for why it lives here
// rather than duplicated per-battery. Also re-exported from each battery's own barrel.
export { E_CONTEXT_RESOLVER_MISSING } from './exceptions'
