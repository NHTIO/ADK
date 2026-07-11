/**
 * Token Thrift — subtractive context management. A pure, model-free algorithm that holds a large
 * WORKING set (messages, memories, retrievables, thoughts, an image, tools) and SUBTRACTS it down to
 * the highest-signal slice that fits the active model's context window.
 *
 * @module @nhtio/adk/batteries/context/thrift
 *
 * @remarks
 * ## The thesis
 *
 * A context window is not a chat history — it is only what you send for ONE dispatch. Most
 * context-management strategies either accumulate (append everything, truncate blindly when it
 * overflows) or pay a model call to compress (summarize). Token Thrift does neither: it is a
 * **zero-model-call** algorithm — every decision is a measured, evidence-based subtraction (a token
 * count compared against a budget), never a guess and never a paid LLM round-trip. The same function
 * runs identically at `contextWindow: 4096` and `contextWindow: 1_000_000`; the window span is a
 * parameter, not a rewrite.
 *
 * The subtraction order (lowest-signal, most-recoverable content first): an image attachment → stale
 * prior-turn tool results (oldest first, this-turn results protected by a newest-N backstop) → the
 * tail of a RAG ranking → low-importance memories → stale ephemeral control messages → the oldest
 * conversation turns → surviving guidance thoughts (oldest first) → visible tools (last resort, driven
 * toward zero). See
 * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit} for the full,
 * step-by-step account with the rationale for each cut.
 *
 * Upstream of the subtractive pass, {@link @nhtio/adk/batteries/context/thrift/relevance!selectRelevantTurns}
 * offers a smarter alternative to plain recency for deciding which history turns are worth replaying
 * at all — walking the ENTIRE history and keeping anything lexically relevant to the current query,
 * not just the last N turns.
 *
 * ## The evaluation
 *
 * This battery is a direct extraction of the flagship reference agent's production subtractive pass —
 * evaluated HEAD-TO-HEAD across five models against alternative context-management strategies
 * (recency-only truncation, and a paid summarizing "compact" strategy) on a shared stress corpus.
 * Honest results, both wins and the one loss:
 *
 * - **Cost**: thrift is the outright cost winner across the matrix — roughly HALF the tokens per
 *   answer of the alternatives, since it never pays for a summarizer call and never carries dead
 *   weight forward.
 * - **Quality at the constrained edge**: at tight context budgets, thrift scored 0.82 vs. 0.75 for
 *   the next-best strategy.
 * - **Quality at a large (128k) window under control conditions**: 1.27 vs. 1.11.
 * - **The one honest loss**: on a SINGLE reasoning-model cell, a paid summarizing ("compact")
 *   strategy beat thrift 1.48 vs. 1.13 — reasoning models can, in some configurations, make better use
 *   of a paid compression step than of subtraction alone. Thrift does not claim to dominate every
 *   cell; it is the stronger strategy on cost everywhere and on quality almost everywhere, honestly
 *   including where it wasn't.
 *
 * A paid summarizing sibling strategy ("compact") — the strategy that won that one cell — is planned
 * as a future addition to the `@nhtio/adk/batteries/context` domain (see
 * {@link @nhtio/adk/batteries/context} for the domain-level framing). This battery already carries the
 * one cross-cutting hook a future compact strategy needs from thrift: the `isSummaryMessage` predicate
 * on {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!SubtractToFitOptions}, which protects
 * a summarizing strategy's running-summary message from being shed like an ordinary old turn.
 *
 * ## Zero-model-call guarantee
 *
 * Every export in this battery is synchronous, pure with respect to its inputs (aside from mutating
 * the working set it's handed), and makes no network or model calls of any kind. The only capability
 * this battery cannot perform itself — tokenization — is an INJECTED function
 * ({@link @nhtio/adk/batteries/context/thrift/contracts!EstimateTokensFn}), never a bundled tokenizer
 * and never a model call.
 *
 * ## Usage sketch
 *
 * ```ts
 * import { subtractToFit, type WorkingSet } from '@nhtio/adk/batteries/context/thrift'
 * import { Tokenizable } from '@nhtio/adk'
 *
 * const ws: WorkingSet = {
 *   systemPrompt: mySystemPrompt, // a Tokenizable, or a plain string
 *   messages: myMessages,
 *   memories: myMemories,
 *   retrievables: myRagChunks,
 *   thoughts: myThoughts,
 *   tools: myToolRegistry,
 * }
 *
 * const trace = subtractToFit(ws, model.contextWindow, myShortlistedToolNames, {
 *   // Inject Tokenizable's own estimator so thrift measures byte-for-byte what your
 *   // own overflow guard counts — including ctx-resolved dynamic content.
 *   estimateTokens: (value, encoding, ctx) => Tokenizable.estimateTokens(value, encoding, ctx),
 *   outputReserve: model.maxOutputTokens,
 * })
 *
 * if (!trace.fits) {
 *   // Even the irreducible floor (system prompt + newest turn + output reserve) exceeds the
 *   // window — a bounded refusal, not a truncated/incoherent dispatch.
 * }
 * ```
 */

export * from './contracts'
export * from './subtractive_pass'
export * from './relevance'

// Shared with `compact` (both batteries throw this when a required injected resolver —
// `estimateTokens` here, `summarize` too in compact's case — is omitted); minted once at the
// `context` domain level so neither battery depends on the other. See
// {@link @nhtio/adk/batteries/context/exceptions} for the full rationale.
export { E_CONTEXT_RESOLVER_MISSING } from '../exceptions'
