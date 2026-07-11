/**
 * The Compact summarizer and history assembler — the whole Compact thesis, in code.
 *
 * @module @nhtio/adk/batteries/context/compact/summarizer
 *
 * @remarks
 * This is a direct extraction of the flagship reference agent's `#summariseTurns` /
 * `#assembleCompactedTurns` head-to-head baseline (the "compact" arm evaluated against Token Thrift —
 * see the battery barrel's TSDoc for the honest, both-ways evaluation results), retargeted at the
 * local structural contracts in {@link @nhtio/adk/batteries/context/compact/contracts} and the shared
 * {@link @nhtio/adk/batteries/context/thrift/relevance!HistoryTurn} shape so it couples to nothing in
 * `@nhtio/adk` core — the one true dependency this battery cannot avoid (an actual model call to
 * summarize) is an injected {@link SummarizeFn}, never a bundled transport.
 */

import { E_CONTEXT_RESOLVER_MISSING } from '../exceptions'
import type { EstimateTokensFn, SummarizeFn, OnCostFn } from './contracts'
import type { HistoryTurn, RelevanceMessage, RelevanceToolCall } from '../thrift/relevance'

export type { HistoryTurn, RelevanceMessage, RelevanceToolCall } from '../thrift/relevance'
export type { EstimateTokensFn, SummarizeFn, CompactionCostEvent, OnCostFn } from './contracts'

/**
 * How many of the MOST RECENT turns stay verbatim, never folded into the running summary —
 * coreference ("it", "that file") needs the immediately preceding turns present no matter what.
 *
 * @remarks
 * The flagship reference agent's own calibrated value (`COMPACT_KEEP_VERBATIM`), lifted unchanged.
 */
export const DEFAULT_KEEP_VERBATIM = 2

/**
 * The token threshold, measured over the OLDER (non-verbatim) region's combined text, past which a
 * (re)summarization call fires.
 *
 * @remarks
 * The flagship reference agent's own calibrated value (`COMPACT_SUMMARISE_AT_TOKENS`), lifted
 * unchanged — modeled on Claude Code auto-compacting as it approaches the context limit (there, a
 * fraction of an 8k window).
 */
export const DEFAULT_SUMMARISE_AT_TOKENS = 2500

/**
 * The default id assigned to the synthetic summary message {@link assembleCompactedTurns} emits.
 *
 * @remarks
 * This exact string is the cross-battery contract with Token Thrift: `thrift`'s
 * {@link @nhtio/adk/batteries/context/thrift/contracts!IsSummaryMessageFn} default predicate is
 * `id === '__compact-summary'` — a caller running `compact` upstream of `thrift` in the same pipeline
 * gets, for free, thrift's protection of this message from being shed like an ordinary old turn. If a
 * caller overrides `summaryMessageId` here, they must also override thrift's `isSummaryMessage` option
 * to match, or thrift will treat the running summary as just another shed-able message.
 */
export const DEFAULT_SUMMARY_MESSAGE_ID = '__compact-summary'

/**
 * The FAITHFUL Claude Code compaction schema — the 9 sections extracted VERBATIM from the flagship
 * reference agent's own real auto-compactions (~4700-token structured summaries observed across 28
 * compactions in that agent's development session). Using the real prompt (not an invented one) is
 * what makes this battery's evaluation honest: the compact strategy loses exactly the detail Claude
 * Code's own compaction loses, no more and no less.
 *
 * @remarks
 * The 9 sections: (1) Primary Request and Intent, (2) Key Technical Concepts, (3) Files and Code
 * Sections, (4) Errors and Fixes, (5) Problem Solving, (6) All User Messages, (7) Pending Tasks,
 * (8) Current Work, (9) Next Step. Callers may supply their own prompt via the `systemPrompt` option
 * on {@link assembleCompactedTurns} (and {@link summariseTurns} directly) — this default is a
 * calibrated starting point, not a hard requirement.
 */
export const COMPACTION_SYSTEM_PROMPT =
  'Your task is to create a detailed summary of the conversation so far, paying close attention to the ' +
  "user's explicit requests and your previous actions. This summary will REPLACE the older conversation " +
  'history, so it must capture every fact a later turn might need. Structure it under these sections:\n' +
  '1. Primary Request and Intent — what the user is trying to accomplish, verbatim where possible.\n' +
  '2. Key Technical Concepts — technologies, APIs, and terms discussed.\n' +
  '3. Files and Code Sections — specific files/functions/values examined or referenced.\n' +
  '4. Errors and Fixes — problems hit and how they were resolved.\n' +
  '5. Problem Solving — decisions made and why.\n' +
  '6. All User Messages — a list of every non-tool user message, to preserve intent.\n' +
  '7. Pending Tasks — what remains to do.\n' +
  '8. Current Work — what was happening most recently.\n' +
  '9. Next Step — the immediate next action.\n' +
  'Be precise and factual. Preserve exact names, paths, and values. Do not summarise away specifics.'

/** The token encoding this battery measures cost under, by default (matches Token Thrift's own
 *  default — see {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!DEFAULT_ENCODING}). */
const DEFAULT_ENCODING = 'cl100k_base'

/** The character-length cap the flagship reference agent applied to the summarizer's input text
 *  (prior summary + older-turn text combined), to keep the summarizer dispatch itself bounded. Lifted
 *  unchanged from `#summariseTurns`'s `.slice(0, 12000)`. */
const HISTORY_TEXT_CHAR_CAP = 12_000

/**
 * Options for {@link summariseTurns}.
 */
export interface SummariseTurnsOptions {
  /** REQUIRED. The model-call seam — see {@link SummarizeFn}. There is no default; this battery
   *  ships with no bundled transport. */
  summarize: SummarizeFn
  /** REQUIRED. Measures the exact request/response text's token cost for {@link OnCostFn} reporting.
   *  There is no default; this battery ships with no bundled tokenizer. */
  estimateTokens: EstimateTokensFn
  /** The encoding to measure cost under. Default: `'cl100k_base'`. */
  encoding?: string
  /** The compaction instructions sent as `system` to {@link SummarizeFn}. Default:
   *  {@link COMPACTION_SYSTEM_PROMPT}. */
  systemPrompt?: string
  /** Fired once, after a successful summarization call, with the estimated request/response token
   *  cost. See {@link OnCostFn}. */
  onCost?: OnCostFn
}

/**
 * Run ONE summarization call: fold `priorSummary` (if any) and `historyText` into the request text
 * exactly as the flagship reference agent's `#summariseTurns` did, dispatch it through the injected
 * {@link SummarizeFn}, and report the estimated token cost via `options.onCost`.
 *
 * @remarks
 * **Faithfulness to the original**: this is a line-for-line port of `#summariseTurns`'s request
 * assembly and prompt shape, with exactly one deliberate behavioral change: the original SWALLOWED a
 * failed summarizer call and degraded to `priorSummary ?? ''` (never letting a summarizer error
 * propagate, since it ran inline in a chat turn that had to keep going); this battery instead lets a
 * rejected {@link SummarizeFn} promise propagate UNCAUGHT (see {@link SummarizeFn}'s own TSDoc) — a
 * battery has no chat-turn context to know whether "degrade silently" is the right failure mode for
 * a given caller, so it surfaces the error and lets the caller decide (their own `SummarizeFn` can
 * implement the original's degrade-on-failure behavior internally if desired, by catching there
 * instead). The original's GPU-OOM special-case rethrow is likewise the caller's concern now — it
 * lived inside the original's own adapter-specific `SummarizeFn` equivalent, not in the algorithm.
 *
 * @param historyText - The older-turn text to summarize (already assembled by the caller, e.g. from
 *   {@link assembleCompactedTurns}'s older-turns join).
 * @param priorSummary - The prior rolling summary, if one exists, folded into the request text ahead
 *   of `historyText` under a `PREVIOUS SUMMARY (extend/merge, do not lose facts)` header — `null` on
 *   the first summarization of a run.
 * @param options - See {@link SummariseTurnsOptions}.
 * @returns The new summary text, trimmed. Falls back to `priorSummary ?? ''` only when
 *   {@link SummarizeFn} resolves to an empty/whitespace-only string (never on rejection — see above).
 * @throws {@link @nhtio/adk/batteries/context/exceptions!E_CONTEXT_RESOLVER_MISSING} When
 *   `options.summarize` or `options.estimateTokens` is not a function.
 */
export async function summariseTurns(
  historyText: string,
  priorSummary: string | null,
  options: SummariseTurnsOptions
): Promise<string> {
  if (typeof options?.summarize !== 'function') {
    throw new E_CONTEXT_RESOLVER_MISSING(['summariseTurns', 'summarize'])
  }
  if (typeof options?.estimateTokens !== 'function') {
    throw new E_CONTEXT_RESOLVER_MISSING(['summariseTurns', 'estimateTokens'])
  }
  const encoding = options.encoding ?? DEFAULT_ENCODING
  const system = options.systemPrompt ?? COMPACTION_SYSTEM_PROMPT
  const text = (
    (priorSummary
      ? `PREVIOUS SUMMARY (extend/merge, do not lose facts):\n${priorSummary}\n\n---\n\n`
      : '') + `CONVERSATION TO SUMMARISE:\n${historyText}`
  ).slice(0, HISTORY_TEXT_CHAR_CAP)

  const rawSummary = await options.summarize({ system, text })
  const summary = rawSummary.trim()

  options.onCost?.({
    calls: 1,
    inTok: options.estimateTokens(`${system}\n\n${text}`, encoding),
    outTok: options.estimateTokens(summary, encoding),
  })

  return summary || (priorSummary ?? '')
}

/**
 * Options for {@link assembleCompactedTurns}.
 */
export interface AssembleCompactedTurnsOptions {
  /** REQUIRED. The model-call seam — see {@link SummarizeFn}. */
  summarize: SummarizeFn
  /** REQUIRED. Measures token costs (the older-region threshold check, and {@link OnCostFn}
   *  reporting). */
  estimateTokens: EstimateTokensFn
  /** The encoding to measure under. Default: `'cl100k_base'`. */
  encoding?: string
  /** How many of the most recent turns stay verbatim. Default: {@link DEFAULT_KEEP_VERBATIM}. */
  keepVerbatim?: number
  /** The older-region token threshold past which a (re)summarization fires. Default:
   *  {@link DEFAULT_SUMMARISE_AT_TOKENS}. */
  summariseAtTokens?: number
  /** The compaction instructions passed through to {@link summariseTurns}. Default:
   *  {@link COMPACTION_SYSTEM_PROMPT}. */
  systemPrompt?: string
  /** The id assigned to the synthetic summary message/turn. Default:
   *  {@link DEFAULT_SUMMARY_MESSAGE_ID} — see that constant's TSDoc for the cross-battery contract
   *  with Token Thrift's `isSummaryMessage` predicate before changing this. */
  summaryMessageId?: string
  /** Fired once per summarization call that actually runs (never on the below-threshold pass-through
   *  path). See {@link OnCostFn}. */
  onCost?: OnCostFn
  /**
   * The caller's own bookkeeping of prior state, threaded through explicitly (replacing the original
   * `#compactSummary`/`#compactCoveredOlder` private fields on the flagship agent's class instance):
   * the rolling summary text produced by a previous call, and how many older-region turns that summary
   * already covers. Omit on the FIRST call for a fresh run (equivalent to the originals' `null`/`0`
   * initial values). This battery holds no state of its own between calls — see
   * {@link AssembleCompactedTurnsResult} for what to persist and pass back in on the next call.
   */
  priorState?: { summary: string | null; coveredOlder: number }
}

/**
 * {@link assembleCompactedTurns}'s return value: the compacted turns PLUS the rolling state a caller
 * must persist and pass back in as `options.priorState` on the next call (this battery is stateless
 * between calls by design — no private fields, no `globalThis`).
 */
export interface AssembleCompactedTurnsResult<
  M extends RelevanceMessage = RelevanceMessage,
  TC extends RelevanceToolCall = RelevanceToolCall,
> {
  /** `[syntheticSummaryTurn, ...verbatimRecentTurns]` when older turns exist and have been summarized
   *  at least once; otherwise just the verbatim turns unchanged (nothing to compact yet). */
  turns: Array<HistoryTurn<M, TC>>
  /** The rolling summary text after this call (unchanged from `priorState.summary` when the threshold
   *  didn't fire this call) — persist and pass back in as `priorState.summary` next call. */
  summary: string | null
  /** How many older-region turns `summary` covers — persist and pass back in as
   *  `priorState.coveredOlder` next call. */
  coveredOlder: number
}

/**
 * The Compact assembly step: keep the newest `keepVerbatim` turns in full; fold everything OLDER into
 * a running structured summary, (re)generated via {@link summariseTurns} when the older region grows
 * past `summariseAtTokens` AND new turns have aged into it since the last summarization. Returns
 * `[syntheticSummaryTurn, ...recentVerbatimTurns]`.
 *
 * @remarks
 * **Faithfulness to the original** (`#assembleCompactedTurns`): the threshold/keep-verbatim/rolling
 * logic is a line-for-line port — same re-summarize condition (`older.length > coveredOlder &&
 * (summary === null || olderTokens > summariseAtTokens)`), same synthetic turn shape (`qa` = the
 * summary text, `createdAt` = the epoch-zero sentinel that sorts before every real turn, one message
 * with `id: summaryMessageId`, content prefixed `[Earlier conversation, compacted summary]`, no tool
 * calls), same "nothing to compact yet" early return when there's no older region at all. The ONE
 * deviation: state that lived on private class fields (`#compactSummary`, `#compactCoveredOlder`) in
 * the original is now explicit input/output (`options.priorState` in, `{ summary, coveredOlder }` out)
 * — a pure battery function cannot own mutable instance state, so the caller threads it through. This
 * is a mechanical decoupling change, not a behavioral one: a caller who persists and re-supplies
 * `priorState` exactly as returned reproduces the original's stateful behavior turn-for-turn.
 *
 * Unlike Token Thrift, this function CANNOT resurface the exact older detail a later turn needs — it
 * only has the summary's blurred prose. See the module barrel for the honest, both-ways evaluation of
 * that fidelity trade-off against thrift's subtractive approach.
 *
 * @param turns - The full grouped history, chronological (e.g. from
 *   {@link @nhtio/adk/batteries/context/thrift/relevance!groupHistoryIntoTurns}).
 * @param options - See {@link AssembleCompactedTurnsOptions}.
 * @returns See {@link AssembleCompactedTurnsResult}.
 * @throws {@link @nhtio/adk/batteries/context/exceptions!E_CONTEXT_RESOLVER_MISSING} When
 *   `options.summarize` or `options.estimateTokens` is not a function.
 */
export async function assembleCompactedTurns<
  M extends RelevanceMessage = RelevanceMessage,
  TC extends RelevanceToolCall = RelevanceToolCall,
>(
  turns: ReadonlyArray<HistoryTurn<M, TC>>,
  options: AssembleCompactedTurnsOptions
): Promise<AssembleCompactedTurnsResult<M, TC>> {
  if (typeof options?.summarize !== 'function') {
    throw new E_CONTEXT_RESOLVER_MISSING(['assembleCompactedTurns', 'summarize'])
  }
  if (typeof options?.estimateTokens !== 'function') {
    throw new E_CONTEXT_RESOLVER_MISSING(['assembleCompactedTurns', 'estimateTokens'])
  }
  const encoding = options.encoding ?? DEFAULT_ENCODING
  const keepVerbatim = options.keepVerbatim ?? DEFAULT_KEEP_VERBATIM
  const summariseAtTokens = options.summariseAtTokens ?? DEFAULT_SUMMARISE_AT_TOKENS
  const summaryMessageId = options.summaryMessageId ?? DEFAULT_SUMMARY_MESSAGE_ID
  let summary = options.priorState?.summary ?? null
  let coveredOlder = options.priorState?.coveredOlder ?? 0

  const recentStart = Math.max(0, turns.length - keepVerbatim)
  const older = turns.slice(0, recentStart)
  const recent = turns.slice(recentStart)

  if (older.length === 0) {
    return { turns: [...recent], summary, coveredOlder }
  }

  const olderText = older.map((t) => t.qa).join('\n\n')
  const olderTokens = options.estimateTokens(olderText, encoding)

  if (older.length > coveredOlder && (summary === null || olderTokens > summariseAtTokens)) {
    summary = await summariseTurns(olderText, summary, {
      summarize: options.summarize,
      estimateTokens: options.estimateTokens,
      encoding,
      systemPrompt: options.systemPrompt,
      onCost: options.onCost,
    })
    coveredOlder = older.length
  }

  const summaryText = summary ?? olderText
  const sentinelCreatedAt = new Date(0).toISOString() // stable, sorts before real turns
  const summaryTurn = {
    qa: summaryText,
    createdAt: sentinelCreatedAt,
    messages: [
      {
        id: summaryMessageId,
        role: 'user',
        content: `[Earlier conversation, compacted summary]\n${summaryText}`,
        createdAt: sentinelCreatedAt,
      } as unknown as M,
    ],
    toolCalls: [] as TC[],
  } as HistoryTurn<M, TC>

  return { turns: [summaryTurn, ...recent], summary, coveredOlder }
}
