/**
 * Compact — summarize-over-threshold context management. Instead of shedding old turns outright, pay
 * for a model call to fold them into a running summary, trading a real API cost for retaining
 * compressed signal from everything folded away.
 *
 * @module @nhtio/adk/batteries/context/compact
 *
 * @remarks
 * ## The thesis
 *
 * Where {@link @nhtio/adk/batteries/context/thrift} is a zero-model-call subtractive algorithm — shed
 * the lowest-signal content until the dispatch fits, never pay for compression — Compact takes the
 * opposite bet: keep the most recent `keepVerbatim` turns in full, and once everything OLDER than that
 * grows past a token threshold, pay for ONE summarization call to compress it into a running summary
 * message that stands in for all of it. On the next threshold crossing, the prior summary is folded
 * BACK into the next summarization request (a rolling summary), so detail degrades gracefully across
 * many compactions rather than being recomputed from scratch or lost outright.
 *
 * This is a direct extraction of the flagship reference agent's production "compact" baseline — the
 * faithful Claude Code auto-compaction schema, lifted verbatim (see
 * {@link @nhtio/adk/batteries/context/compact/summarizer!COMPACTION_SYSTEM_PROMPT}) — evaluated
 * HEAD-TO-HEAD against Token Thrift and a naive-recency baseline on a shared 94-turn stress corpus
 * across five models.
 *
 * ## The evaluation (honest, both ways)
 *
 * - **The one win**: on a SINGLE reasoning-model cell, Compact beat Thrift 1.48 vs. 1.13 (3-judge
 *   committee scoring) — a reasoning model made better use of a paid compression step than of
 *   subtraction alone. Compact also led at the 128k-window control condition, 1.40 vs. Thrift's 1.27.
 * - **The price**: ~80-89 summarizer calls and roughly 380k-550k EXTRA tokens over a 94-turn run,
 *   compared to Thrift's zero. This is the fundamental trade-off, not an implementation detail —
 *   Compact is a paid strategy by construction.
 * - **Where it degenerates**: on a 1M-token window, the older-region threshold never triggered across
 *   the whole run (0 summarizer calls) — with that much headroom, Compact never fires and behaves
 *   identically to naive unbounded accumulation. It only earns its cost at real context pressure.
 * - **Under a TIGHT budget, an honest caveat**: this extraction's message-shedding (whatever a caller
 *   layers on top to fit the FINAL dispatch, e.g. Thrift's own subtractive pass running downstream)
 *   is UNFAITHFUL to what real compaction products do under pressure — it drops verbatim recent turns
 *   outright rather than triggering an earlier/tighter re-summarization. Real Claude-Code-style
 *   compaction re-summarizes more aggressively as the wall approaches; a caller who needs that
 *   fidelity under tight budgets should tune `summariseAtTokens` down rather than rely on a downstream
 *   shed to save them.
 *
 * See {@link @nhtio/adk/batteries/context/thrift} for the full Thrift-side account of this same
 * evaluation, including where Thrift wins (cost, everywhere; quality, almost everywhere).
 *
 * ## Choosing between the two
 *
 * Reach for `compact` when: the target model is a reasoning model, the pipeline can afford a
 * summarizer budget (extra latency + tokens per compaction), and the window is small enough that the
 * threshold will actually fire. Reach for `thrift` (the always-safe default) when: cost matters, the
 * window is large enough that compaction would degenerate anyway, or the model doesn't specifically
 * benefit from compressed-prose continuity over raw subtraction. The two are COMPOSABLE, not
 * mutually exclusive — Thrift ships an `isSummaryMessage` predicate (default `id === '__compact-summary'`)
 * that recognizes and protects Compact's synthetic summary message from being shed like an ordinary
 * old turn, so a pipeline can run `compact` upstream (turn-level assembly) and `thrift` downstream
 * (final budget fit) together. See
 * {@link @nhtio/adk/batteries/context/compact/summarizer!DEFAULT_SUMMARY_MESSAGE_ID} for that
 * contract's exact terms.
 *
 * ## Zero-coupling, one unavoidable seam
 *
 * Every structural type here is a local, duck-typed declaration (zero core imports — see
 * {@link @nhtio/adk/batteries/context/compact/contracts}) except for the turn/message shapes, which
 * are reused directly from {@link @nhtio/adk/batteries/context/thrift/relevance} via a relative,
 * battery-internal import (compact operates on the SAME upstream turn shape thrift's relevance
 * selection produces — no need to redeclare it). The one capability this battery truly cannot bundle
 * is the model call itself: {@link @nhtio/adk/batteries/context/compact/contracts!SummarizeFn} is an
 * injected function, never a bundled transport — see its TSDoc for the canonical ADK recipe (a
 * `DispatchRunner.dispatch` call with an all-noop `RawTurnContext`).
 *
 * ## Usage sketch
 *
 * ```ts
 * import { assembleCompactedTurns, type SummarizeFn } from '@nhtio/adk/batteries/context/compact'
 * import { groupHistoryIntoTurns } from '@nhtio/adk/batteries/context/thrift'
 * import { Tokenizable } from '@nhtio/adk'
 *
 * // A stub SummarizeFn — see the contract's TSDoc for the real DispatchRunner recipe.
 * const summarize: SummarizeFn = async ({ system, text }) => {
 *   const completion = await myLlmCall({ system, prompt: text })
 *   return completion.trim()
 * }
 *
 * const turns = groupHistoryIntoTurns(myMessages, myToolCalls)
 * let priorState: { summary: string | null; coveredOlder: number } | undefined
 *
 * const result = await assembleCompactedTurns(turns, {
 *   summarize,
 *   estimateTokens: (value, encoding, ctx) => Tokenizable.estimateTokens(value, encoding, ctx),
 *   priorState,
 *   onCost: (event) => trackCompactionCost(event), // replaces globalThis.__agentCompactionCost
 * })
 *
 * priorState = { summary: result.summary, coveredOlder: result.coveredOlder } // persist for next turn
 * // result.turns: [syntheticSummaryTurn?, ...recentVerbatimTurns] — feed downstream (e.g. into
 * // thrift's subtractToFit) exactly like any other grouped-turn history.
 * ```
 */

export * from './contracts'
export * from './summarizer'

// Shared with `thrift` (both batteries throw this when a required injected resolver —
// `summarize`/`estimateTokens` here, `estimateTokens` too in thrift's case — is omitted); minted
// once at the `context` domain level so neither battery depends on the other. See
// {@link @nhtio/adk/batteries/context/exceptions} for the full rationale.
export { E_CONTEXT_RESOLVER_MISSING } from '../exceptions'
