/**
 * Structural contracts for the Compact (summarize-over-threshold) context-management battery — the
 * seams it invokes via injected functions, and the one cost-observability shape it hands back.
 *
 * @module @nhtio/adk/batteries/context/compact/contracts
 *
 * @remarks
 * This module has **zero imports** — not even a type-only import from `@nhtio/adk` core. Same
 * discipline as {@link @nhtio/adk/batteries/context/thrift/contracts}: every capability this battery
 * cannot perform itself is an INJECTED function, and every shape it reads or writes is a local
 * structural declaration.
 *
 * Compact needs exactly TWO capabilities it cannot bundle itself:
 *
 * 1. **Summarization** ({@link SummarizeFn}) — an actual model call. Unlike Token Thrift, which is a
 *    zero-model-call algorithm end-to-end, Compact's entire thesis is PAYING for a model call to
 *    compress old turns into a running summary — so this seam is unavoidable, and the battery never
 *    pretends otherwise.
 * 2. **Token estimation** ({@link EstimateTokensFn}, re-exported from
 *    {@link @nhtio/adk/batteries/context/thrift/contracts} — same signature, same rationale: no
 *    bundled tokenizer, ever).
 */

export type { EstimateTokensFn } from '../thrift/contracts'

/**
 * THE model-call seam this battery cannot perform itself: given a system prompt and a body of text to
 * summarize, return the summary text.
 *
 * @remarks
 * The battery never names `DispatchRunner`, an adapter, or an executor — it has no idea how the
 * caller talks to a model, and it must not. The canonical ADK recipe for building one (the recipe the
 * production flagship agent this battery was extracted from actually uses, and the one the docs page
 * for this battery walks through in full) is:
 *
 * ```ts
 * const summarize: SummarizeFn = async ({ system, text }) => {
 *   let out = ''
 *   const noop = async (): Promise<void> => undefined
 *   const noopArr = async (): Promise<never[]> => []
 *   await DispatchRunner.dispatch({
 *     raw: {
 *       systemPrompt: new Tokenizable(system),
 *       standingInstructions: [],
 *       messages: [new Message({ id: `__compact-${Date.now()}`, role: 'user', content: text, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })],
 *       // Every other RawTurnContext capability is a noop — this dispatch never reads or writes any
 *       // OTHER persisted state, it only wants the model's completion text.
 *       fetchMemories: noopArr, fetchRetrievables: noopArr, fetchMessages: noopArr,
 *       fetchThoughts: noopArr, fetchToolCalls: noopArr, fetchTools: noopArr,
 *       refreshStandingInstructions: noopArr,
 *       storeStandingInstruction: noop, mutateStandingInstruction: noop, deleteStandingInstruction: noop,
 *       storeMemory: noop, mutateMemory: noop, deleteMemory: noop,
 *       storeRetrievable: noop, mutateRetrievable: noop, deleteRetrievable: noop,
 *       storeMessage: async (_c, v) => { out += v.content?.toString?.() ?? '' },
 *       mutateMessage: noop, deleteMessage: noop,
 *       storeThought: noop, mutateThought: noop, deleteThought: noop,
 *       storeToolCall: noop, mutateToolCall: noop, deleteToolCall: noop,
 *       storeMediaBytes: noop, storeRetrievableBytes: noop,
 *     } as never,
 *     executor: await adapter.executor({ maxTokens: 1200, toolCallParser: 'none', stream: false, autoAck: true, enableThinking: false }),
 *   })
 *   return out.trim()
 * }
 * ```
 *
 * A caller with a different transport (a direct HTTP call to an LLM API, a queue-backed worker, a
 * mocked test double) supplies whatever function satisfies this signature — the battery only ever
 * awaits the returned string.
 *
 * @param req - `system`: the compaction instructions (see {@link @nhtio/adk/batteries/context/compact/summarizer!COMPACTION_SYSTEM_PROMPT}
 *   for the shipped default); `text`: the body of older conversation (and, on a rolling re-summarize,
 *   the prior summary folded in — see {@link @nhtio/adk/batteries/context/compact/summarizer!summariseTurns}) to compress.
 * @returns The summary text, awaited. A rejected promise propagates to the caller of
 *   `summariseTurns`/`assembleCompactedTurns` uncaught — this battery does not swallow summarizer
 *   failures; a caller wanting graceful degradation (e.g. "fall back to the prior summary") implements
 *   that inside their own `SummarizeFn`, exactly as the production flagship agent's own summarizer did.
 */
export type SummarizeFn = (req: { system: string; text: string }) => Promise<string>

/**
 * One summarization call's estimated token cost — reported via {@link OnCostFn} so a caller can total
 * up the real overhead this battery pays (the cost profile a `thrift`-only pipeline never incurs).
 *
 * @remarks
 * `inTok`/`outTok` are ESTIMATES, not metered usage: when the injected {@link SummarizeFn}'s transport
 * doesn't report real token usage back (many don't — a bare `Promise<string>` return carries no usage
 * envelope), the battery has no other way to know what the call cost. It measures what it CAN measure
 * — the exact text it sent (`system + text`) and the exact text it got back (the summary) — via the
 * same injected {@link EstimateTokensFn} the caller already supplies for its own token accounting, so
 * these numbers are at least self-consistent with whatever budget arithmetic the caller runs
 * elsewhere. A caller whose `SummarizeFn` DOES have access to real usage counts can ignore this
 * estimate and total its own numbers from inside the function instead.
 */
export interface CompactionCostEvent {
  /** How many summarization calls this event represents — always `1` per {@link OnCostFn} firing (one
   *  call, one event); a caller totals `calls` across events to get the run's summarizer call count. */
  calls: number
  /** Estimated input token cost: `estimateTokens(system + text, encoding)` for the exact request sent
   *  to {@link SummarizeFn} this call (system prompt plus the history/prior-summary text). */
  inTok: number
  /** Estimated output token cost: `estimateTokens(summary, encoding)` for the text {@link SummarizeFn}
   *  returned. */
  outTok: number
}

/**
 * Optional per-summarization cost callback — fired once per {@link SummarizeFn} call that actually
 * runs, replacing the production flagship agent's `globalThis.__agentCompactionCost` ring buffer with
 * an injectable, testable seam that leaves no global state behind.
 *
 * @remarks
 * Never invoked when the threshold hasn't been crossed (no summarization call made — see
 * {@link @nhtio/adk/batteries/context/compact/summarizer!assembleCompactedTurns}'s below-threshold
 * pass-through path). A caller who wants a running total across a whole session's worth of dispatches
 * accumulates across `onCost` firings themselves; this battery holds no cross-call state of its own
 * beyond what a single `assembleCompactedTurns` invocation's caller threads through (the rolling prior
 * summary is passed in and returned explicitly, never stashed on `globalThis`).
 *
 * @param event - See {@link CompactionCostEvent}.
 */
export type OnCostFn = (event: CompactionCostEvent) => void
