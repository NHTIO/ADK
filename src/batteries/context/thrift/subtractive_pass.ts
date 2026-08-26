/**
 * The subtractive pass — the whole Token Thrift thesis, in code.
 *
 * @module @nhtio/adk/batteries/context/thrift/subtractive_pass
 *
 * @remarks
 * A context window is NOT a chat history. It is just what you send for ONE dispatch. So: hold a
 * large WORKING set (messages, memories, retrievables, thoughts, an image, tools), then SUBTRACT it
 * down to the high-signal slice that fits the active model's window — focus, don't accumulate.
 *
 * This module is the model-facing plane only. Where the human-facing chat history lives (a SQLite
 * store, an in-memory array, anything else) is entirely the caller's concern — this battery never
 * touches it. Everything here is window-agnostic: the same function runs at `contextWindow: 4096`
 * and `contextWindow: 1_000_000` — the span is a parameter, not a rewrite.
 *
 * This is a direct extraction of the flagship reference agent's production subtractive pass
 * (evaluated head-to-head across five models — see the battery barrel's TSDoc for the results),
 * retargeted at the local structural contracts in
 * {@link @nhtio/adk/batteries/context/thrift/contracts} so it couples to nothing in `@nhtio/adk`
 * core — every value it reads is duck-typed, and its one true dependency (token estimation) is an
 * injected function, never a bundled tokenizer.
 */

import { E_CONTEXT_RESOLVER_MISSING } from '../exceptions'
import type {
  EstimateTokensFn,
  ContentLike,
  WorkingMessage,
  WorkingMemory,
  WorkingRetrievable,
  WorkingThought,
  WorkingTool,
  WorkingToolRegistry,
  WorkingToolCall,
  WorkingImage,
  RenderToolsFn,
  ShedRankFn,
  IsEphemeralMessageFn,
  IsSummaryMessageFn,
} from './contracts'

// Re-exported so a consumer of this module doesn't need a second import from `./contracts` for the
// types that appear directly in this module's own public signatures.
export type {
  WorkingToolCall,
  WorkingImage,
  WorkingMessage,
  WorkingMemory,
  WorkingRetrievable,
  WorkingThought,
  WorkingTool,
  WorkingToolRegistry,
  RenderToolsFn,
  ShedRankFn,
  IsEphemeralMessageFn,
  IsSummaryMessageFn,
  EstimateTokensFn,
}

/**
 * The token encoding this battery measures under, by default.
 *
 * @remarks
 * `'cl100k_base'` — a widely-available, model-agnostic tiktoken encoding — is the default because
 * this battery is core-agnostic: unlike the flagship reference agent it was extracted from (which
 * hard-codes the `gemma` encoding because its engine IS Gemma via LiteRT-LM), this battery has no
 * opinion on which model you run. `cl100k_base` is a reasonable, broadly-supported baseline for a
 * caller who hasn't thought about encodings yet; a caller running Gemma, Claude, or any other model
 * with a distinct tokenizer should pass their own `encoding` (and a matching {@link EstimateTokensFn})
 * so the budget math agrees with what their model/battery actually counts. The encoding identifier is
 * an opaque string as far as this module is concerned — it is never validated or interpreted here,
 * only threaded through to the injected {@link EstimateTokensFn}.
 */
export const DEFAULT_ENCODING = 'cl100k_base'

/**
 * Fallback output reserve, as a fraction of the window, used ONLY when the exact max-output budget is
 * unknown.
 *
 * @remarks
 * Prefer passing the caller's actual generation `maxTokens` as `outputReserve` — reserving a flat
 * fraction of the window when the model can emit at most, say, 2048 tokens throws away real input
 * budget (RAG chunks, history) for output that can never be produced. This fraction is the calibrated
 * value from the flagship reference agent (0.35 of the window), kept as the default for a caller who
 * genuinely doesn't know their generation cap yet.
 */
export const DEFAULT_RESERVE_FRACTION = 0.35

/**
 * How many of the NEWEST this-turn tool-result bodies to protect from budget-shedding as a
 * last-resort backstop, by default.
 *
 * @remarks
 * A normal read→answer turn produces 1–2 this-turn results, so `N = 3` leaves the common case
 * untouched; a deep read-loop (several searches/reads in one turn) that piles up more can shed its
 * OLDEST bodies past this cap (the model has moved past them by the time it has made this many
 * calls). The single newest this-turn result is always kept regardless of this cap — see
 * {@link subtractToFit}'s step 3b.
 */
export const DEFAULT_THIS_TURN_RESULT_KEEP = 3

/** A line in the "what got cut" trace — one bucket's before/after token weight. */
export interface BucketTrace {
  /** The bucket's name (e.g. `'thoughts'`, `'tools'`, `'image'`, `'toolCalls'`, `'retrievables'`,
   *  `'memories'`, `'messages'`, `'thoughts-shed'`, `'tools-shed'`) — one entry per step of the pass. */
  bucket: string
  /** This bucket's measured token weight before this step ran. */
  beforeTokens: number
  /** This bucket's measured token weight after this step ran. */
  afterTokens: number
  /** How many items this bucket held before this step ran. */
  beforeCount: number
  /** How many items this bucket held after this step ran. */
  afterCount: number
  /** A short human-readable rationale for what this step did (or didn't do), for diagnostics/tracing. */
  note?: string
  /** Item identifiers affected by this bucket, when the working items expose ids. */
  ids?: string[]
}

/** The full record of one subtractive pass — before/after weights per bucket, and whether the
 *  dispatch ultimately fits the budget. */
export interface ThriftTrace {
  /** The active model's context window this pass was run against. */
  contextWindow: number
  /** Tokens held back for the model's own output (see {@link resolveBudget}). */
  reserve: number
  /** The INPUT token budget — `contextWindow - reserve`. */
  budget: number
  /** Total measured token weight BEFORE any shedding (the "everything reasonable" starting point). */
  totalBefore: number
  /** Total measured token weight AFTER every shedding step ran. */
  totalAfter: number
  /** Whether `totalAfter` fits within `budget`. */
  fits: boolean
  /** The dispatch should be refused: `!fits` — even after every possible shed, the irreducible floor
   *  (system prompt + standing instructions + newest turn + output reserve) still exceeds the window. */
  refused: boolean
  /** One entry per step of the pass, in the order the steps ran, for diagnostics/tracing. */
  buckets: BucketTrace[]
}

/** The mutable working set a dispatch starts from — the "everything reasonable" set this pass
 *  subtracts down to what fits. Every field is a local structural type from
 *  {@link @nhtio/adk/batteries/context/thrift/contracts} — nothing here requires a core ADK value. */
export interface WorkingSet {
  /** The dispatch's system prompt. Measured ctx-resolved (see {@link subtractToFit}'s `renderCtx`
   *  option) to match what a caller's own overflow guard counts. */
  systemPrompt: ContentLike | string
  /**
   * Durable directives the caller renders into every dispatch (the caller's battery counts these
   * too). They are a FIXED cost like the system prompt — never shed — so the pass only ADDS them to
   * the running total, never trims them. Omit (or pass an empty array) when the caller uses none. A
   * consumer that DOES render standing instructions must pass them here or thrift would undercount
   * relative to the caller's own guard.
   */
  standingInstructions?: Array<ContentLike | string>
  /** The conversation history this dispatch would replay — sheds stale ephemeral control messages
   *  first (step 6), then the oldest turns (step 7); the newest turn is always kept. */
  messages: WorkingMessage[]
  /** Durable memories available to this dispatch — sheds lowest-`importance` first (step 5). */
  memories: WorkingMemory[]
  /** Retrieved (RAG) passages available to this dispatch — sheds the tail of the ranking (lowest
   *  `score`) first (step 4), keeping the best-ranked chunks. */
  retrievables: WorkingRetrievable[]
  /** Model-internal guidance content (plans, per-iteration nudges, and — unless
   *  `stripPriorTurnThoughts` is disabled — prior-turn chain-of-thought, dropped in step 1). Surviving
   *  thoughts are sheddable oldest-first as a last resort (step 8), except any ids named in
   *  `protectThoughtIds`. */
  thoughts: WorkingThought[]
  /** The tool registry this dispatch draws visible tools from — mutated via `setHidden` as tools are
   *  shed (steps 2 and 9). */
  tools: WorkingToolRegistry
  /**
   * Prior-turn (and this-turn) tool calls whose RENDERED RESULTS the caller puts in the prompt. Omit
   * (or pass an empty array) when the caller doesn't measure them — the pass then treats tool-result
   * weight as `0`.
   */
  toolCalls?: WorkingToolCall[]
  /** Optional image (or other flat-cost media) attachment. The single biggest token hog. */
  image?: WorkingImage
}

/**
 * Options shared by every entry point in this module that needs to measure a value's token cost —
 * the injected estimator plus the encoding it measures under.
 */
export interface EstimatorOptions {
  /**
   * REQUIRED. Measures a rendered string's token cost under `encoding`, optionally resolved against
   * a live dispatch context. There is no default — this battery ships with no bundled tokenizer, so
   * a caller who omits this gets a clear thrown error naming the option, not a silent guess.
   */
  estimateTokens: EstimateTokensFn
  /** The encoding to measure under. Default: {@link DEFAULT_ENCODING}. */
  encoding?: string
}

/**
 * Options accepted by {@link subtractToFit}. `estimateTokens` (via {@link EstimatorOptions}) is the
 * only option with no default; every other field is a calibrated default, documented on its own
 * declaration below, that a caller can override.
 *
 * @remarks
 * Earlier positional-argument forms of this function (as it existed in the flagship reference agent
 * this battery was extracted from) took `outputReserve`, `keepThoughtIds`, `renderTools`,
 * `protectThoughtIds`, `renderCtx`, and `protectedToolNames` as seven trailing positional parameters.
 * They are collected here into one options object to keep the call site legible and to give each a
 * documented default — the mapping from the old positional order to these keys is: position 4 →
 * `outputReserve`, 5 → `keepThoughtIds`, 6 → `renderTools`, 7 → `protectThoughtIds`, 8 → `renderCtx`,
 * 9 → `protectedToolNames`.
 */
export interface SubtractToFitOptions extends EstimatorOptions {
  /**
   * The EXACT number of tokens to hold back for the model's own output — pass the generation
   * `maxTokens` the model is configured with. When omitted, falls back to
   * {@link DEFAULT_RESERVE_FRACTION} of the window (a guess, for callers that don't know the cap).
   * Clamped so the reserve never exceeds the window. Forwarded to {@link resolveBudget}.
   */
  outputReserve?: number
  /**
   * The fallback reserve fraction used when `outputReserve` is omitted. Default:
   * {@link DEFAULT_RESERVE_FRACTION}. Forwarded to {@link resolveBudget}.
   */
  reserveFraction?: number
  /**
   * Whether to apply the prior-turn thought strip (step 1) at all. Default `true`.
   *
   * @remarks
   * The default is driven by Gemma's model card §3, "No Thinking Content in History": thoughts from
   * previous model turns must not be re-added before the next user turn. This is also pure thrift —
   * prior-turn reasoning is the highest-volume, lowest-reuse content there is, Gemma or not — so the
   * default stays `true` even for callers on a different model family; a caller whose model
   * genuinely benefits from replaying its own prior chain-of-thought (uncommon) can set this `false`
   * to skip the strip entirely and let every thought flow into the later per-thought budget shed
   * (step 8) instead.
   */
  stripPriorTurnThoughts?: boolean
  /**
   * Thought ids to PRESERVE through the prior-turn strip (step 1) — e.g. a planner's synthetic
   * THIS-TURN plan thought, which is fresh guidance generated for the current request (not prior-turn
   * chain-of-thought, and not subject to the §3 policy above). Everything else is dropped when
   * stripping is enabled. Omit to drop every thought when stripping is enabled.
   */
  keepThoughtIds?: ReadonlySet<string>
  /**
   * The caller's tool-declaration renderer. When supplied, the tools bucket is measured against the
   * REAL rendered tool-definitions block (e.g. full JSON-Schema per tool) instead of a
   * `name: description` proxy — the proxy can undercount a schema-heavy tool block by an order of
   * magnitude relative to what actually gets dispatched. Omit to fall back to the proxy (keeps this
   * battery usable standalone, without a real tool-rendering pipeline, e.g. in tests).
   */
  renderTools?: RenderToolsFn
  /**
   * Thought ids that must NEVER be shed for budget (step 8) even when the dispatch is over — the
   * this-turn scaffolding the model needs to answer at all (e.g. a plan thought + a citation
   * reinforcement thought). Everything else in the surviving keep-set (per-iteration nudge thoughts,
   * older synthetic guidance) is sheddable oldest-first when the dispatch still doesn't fit. This is
   * a SUBSET of `keepThoughtIds`: `keepThoughtIds` decides what survives the prior-turn strip (step
   * 1); `protectThoughtIds` decides what additionally survives the budget shed (step 8). Omit to make
   * every surviving thought sheddable.
   */
  protectThoughtIds?: ReadonlySet<string>
  /**
   * The live dispatch context, so a DYNAMIC (evaluatable) value's token count reflects the string it
   * will resolve to for THIS dispatch — forwarded as the `ctx` argument to `estimateTokens`. Without
   * it, a dynamic value is measured at its no-`ctx` fallback size, and the budget can disagree with
   * what the caller's own battery ships (an under-count, since evaluated content is typically LARGER
   * than its static form — e.g. an interpolated system prompt). Optional; static content measures
   * identically with or without it.
   */
  renderCtx?: unknown
  /**
   * Tool names the caller's CURRENT PLAN has committed to that have NOT yet been called this turn.
   * These are UNSHEDDABLE by the last-resort tool shed (step 9) until every other tool has already
   * shed — removing a plan-committed tool from the visible set leaves the model instructed to call a
   * tool it can no longer see. The protection is bounded: once the tool HAS been called (its result
   * is already in context) it should be dropped from this set by the caller, so it is never a
   * permanent floor. Omit to make every visible tool sheddable on equal footing.
   */
  protectedToolNames?: ReadonlySet<string>
  /**
   * Ranks a tool by last-resort shed priority for step 9 (lower sheds first). Default: a single
   * generic tier — every tool ranks equally, so the shed proceeds in the order `relevantToolNames`
   * listed them (a stable sort preserves input order when every rank ties). This battery has no
   * domain knowledge of which of a caller's tools are cheap-to-lose "gather" tools versus
   * load-bearing "delivery" tools, so it does not guess a tiering. A caller WHO DOES have that
   * knowledge (as the flagship reference agent does — it ranks ~90 known tool names into seven
   * tiers, sheds its `provide_answer` tool before its core artifact readers, etc.) should inject a
   * `ShedRankFn` that encodes it; see {@link ShedRankFn} for the contract.
   */
  shedRank?: ShedRankFn
  /**
   * Decides whether a message is an ephemeral control message (step 6) — re-derived fresh every
   * dispatch iteration, never persisted, so only the LATEST surviving copy carries live information.
   * Default: `(m) => m.id.startsWith('__eph-')`, the flagship reference agent's own convention. A
   * caller with a different (or no) ephemeral-message convention should override this; the default
   * simply never matches when a caller's ids don't use that prefix, degrading step 6 to a no-op.
   */
  isEphemeralMessage?: IsEphemeralMessageFn
  /**
   * Decides whether a message is a summarizing strategy's load-bearing running summary (step 7) —
   * content that stands in for every older turn that strategy folded away, and so must never be shed
   * like an ordinary old turn even though it renders as the chronologically oldest message. Default:
   * `(m) => m.id === '__compact-summary'`, the flagship reference agent's own convention for its
   * paired summarizing ("compact") strategy. Callers who never run a summarizing strategy alongside
   * this battery can ignore this option entirely — the default predicate simply never matches.
   */
  isSummaryMessage?: IsSummaryMessageFn
  /**
   * How many of the NEWEST this-turn tool-result bodies the newest-N backstop (step 3b) protects
   * from shedding once ordinary prior-turn shedding is exhausted and the dispatch still doesn't fit.
   * Default: {@link DEFAULT_THIS_TURN_RESULT_KEEP}.
   */
  thisTurnResultKeep?: number
}

const defaultIsEphemeralMessage: IsEphemeralMessageFn = (m) => m.id.startsWith('__eph-')
const defaultIsSummaryMessage: IsSummaryMessageFn = (m) => m.id === '__compact-summary'
/** The generic default {@link ShedRankFn}: every tool ranks equally (a single tier), so the
 *  last-resort tool shed (step 9) proceeds in whatever order it is handed — no domain knowledge
 *  assumed. See the `shedRank` option on {@link SubtractToFitOptions}. */
const defaultShedRank: ShedRankFn = () => 0

const renderContent = (v: ContentLike | string): string => {
  if (typeof v === 'string') return v
  // Reject the specific failure mode where an opaque object is coerced through the default
  // Object.prototype renderer. Custom toString implementations remain fully valid, including
  // ones whose intentional text happens to look like an object tag.
  const toString = v.toString
  if (typeof toString !== 'function' || toString === Object.prototype.toString) {
    throw new TypeError('ContentLike must provide an explicit string renderer')
  }
  const rendered = toString.call(v)
  if (typeof rendered !== 'string') {
    throw new TypeError('ContentLike renderer must return a string')
  }
  return rendered
}

/**
 * Resolve the per-dispatch INPUT token budget from the ACTIVE model's window: the window minus the
 * room held back for the model's own output. The same call works for a 4K model and a 1M model.
 *
 * @param contextWindow - The active model's context window (input + output share it).
 * @param outputReserve - The EXACT number of tokens to hold back for output — pass the generation
 *   `maxTokens` the model is configured with. When omitted, falls back to `reserveFraction` of the
 *   window (a guess, for callers that don't know the cap). Clamped so the reserve never exceeds the
 *   window.
 * @param reserveFraction - The fallback fraction used when `outputReserve` is omitted. Default:
 *   {@link DEFAULT_RESERVE_FRACTION}.
 */
export const resolveBudget = (
  contextWindow: number,
  outputReserve?: number,
  reserveFraction: number = DEFAULT_RESERVE_FRACTION
): number => {
  const reserve =
    outputReserve === undefined
      ? Math.ceil(contextWindow * reserveFraction)
      : Math.min(contextWindow, Math.max(0, Math.ceil(outputReserve)))
  return Math.max(0, contextWindow - reserve)
}

/**
 * Gemma model card §3 — "No Thinking Content in History": thoughts from previous model turns MUST
 * NOT be re-added before the next user turn. Enforced here as a standalone, callable step (not a
 * silent battery-wide flag), because it is also pure thrift: prior-turn reasoning is the
 * highest-volume, lowest-reuse content a working set carries.
 *
 * @remarks
 * `keepIds` is an allow-list of thought ids to PRESERVE — used for e.g. a planner's synthetic
 * THIS-TURN plan thought, which is fresh guidance generated for the current request (NOT prior-turn
 * chain-of-thought, and NOT subject to the §3 policy): it must survive into the next dispatch's
 * prompt so the model follows the plan. Everything else is dropped.
 *
 * `subtractToFit` calls this internally as step 1 (gated by its `stripPriorTurnThoughts` option,
 * default `true`); it is also exported standalone for a caller who wants the strip without running
 * the rest of the pass.
 *
 * @param ws - A working set exposing (at least) a mutable `thoughts` array; mutated in place.
 * @param options - The estimator used to measure the tokens reclaimed by dropped thoughts.
 * @param keepIds - Thought ids to preserve.
 * @returns How many thoughts were dropped, and how many tokens that reclaimed.
 */
export const stripPriorTurnThoughts = (
  ws: Pick<WorkingSet, 'thoughts'>,
  options: EstimatorOptions,
  keepIds?: ReadonlySet<string>
): { dropped: number; tokens: number } => {
  const encoding = options.encoding ?? DEFAULT_ENCODING
  const tok = (s: string): number => options.estimateTokens(s, encoding)
  const kept = keepIds && keepIds.size > 0 ? ws.thoughts.filter((t) => keepIds.has(t.id)) : []
  const removed = ws.thoughts.filter((t) => !kept.includes(t))
  const tokens = removed.reduce((n, t) => n + tok(renderContent(t.content)), 0)
  ws.thoughts = kept
  return { dropped: removed.length, tokens }
}

// #region shed
/**
 * The subtractive pass. Start wide; measure every bucket; then shed lowest-signal first until the
 * dispatch fits the active window's budget — the image (the single biggest hog) goes first when it
 * doesn't fit, then tools the turn doesn't need, the tail of the retrieval ranking, low-value
 * memories, the oldest conversation turns. Each cut is by EVIDENCE (a measured bucket), never a
 * guess. If even the floor (system prompt + newest turn) won't fit, the dispatch REFUSES (`fits:
 * false`) — a bounded refusal beats a truncated, incoherent dispatch.
 *
 * @remarks
 * `options.estimateTokens` is REQUIRED — this battery ships with no bundled tokenizer, so a missing
 * estimator throws {@link @nhtio/adk/batteries/context/exceptions!E_CONTEXT_RESOLVER_MISSING}
 * immediately (naming the option) rather than silently guessing at token counts.
 *
 * @param ws - The working set to subtract in place. Mutated: `thoughts`, `retrievables`,
 *   `memories`, `messages`, `toolCalls`, `image.kept`, and the visible/hidden state of `tools` may
 *   all change.
 * @param contextWindow - The active model's context window.
 * @param relevantToolNames - The names (from `ws.tools.all()`) that should start VISIBLE for this
 *   turn — every other registered tool starts hidden (0 schema tokens, still callable via a
 *   catalog). The last-resort shed (step 9) may hide some of these too.
 * @param options - See {@link SubtractToFitOptions}.
 * @throws {@link @nhtio/adk/batteries/context/exceptions!E_CONTEXT_RESOLVER_MISSING} When
 *   `options.estimateTokens` is not a function.
 */
export const subtractToFit = (
  ws: WorkingSet,
  contextWindow: number,
  relevantToolNames: string[],
  options: SubtractToFitOptions
): ThriftTrace => {
  if (typeof options?.estimateTokens !== 'function') {
    throw new E_CONTEXT_RESOLVER_MISSING(['subtractToFit', 'estimateTokens'])
  }
  // Exclude unmeasurable handle-mode retrievables before ANY bucket measurement. In particular,
  // this must precede ragBefore and the first total() call below: a finite synthetic estimate
  // cannot be safe for an unbounded artifact, and Infinity would poison total() globally.
  const unknownRetrievables = ws.retrievables.filter((r) => r.sizeUnknown === true)
  if (unknownRetrievables.length > 0) {
    ws.retrievables = ws.retrievables.filter((r) => r.sizeUnknown !== true)
  }

  const encoding = options.encoding ?? DEFAULT_ENCODING
  const estimateTokens = options.estimateTokens
  const renderCtx = options.renderCtx
  const doStripPriorTurnThoughts = options.stripPriorTurnThoughts ?? true
  const shedRank = options.shedRank ?? defaultShedRank
  const isEphemeral = options.isEphemeralMessage ?? defaultIsEphemeralMessage
  const isCompactSummary = options.isSummaryMessage ?? defaultIsSummaryMessage
  const thisTurnResultKeep = options.thisTurnResultKeep ?? DEFAULT_THIS_TURN_RESULT_KEEP

  // Use the plain estimator for one-off measurements of rendered strings (tool declarations,
  // message bodies) that don't carry their own `estimateTokens`. Everything the model sees is
  // either an `Estimable`/`ContentLike` value or a string produced by the caller's own render*
  // functions, so this measures the ACTUAL dispatched string, not a proxy.
  const tok = (s: string): number => estimateTokens(s, encoding)

  // Measure a retrievable the way a caller's own overflow guard does (tally its rendered content
  // string) but SYNCHRONOUSLY: use the retrievable's OWN `estimateTokens(enc)` when present, which
  // for an inline-text passage (the common RAG case) resolves immediately. The pass is synchronous
  // end-to-end, so a reader-backed artifact's async estimate would surface as a Promise here; guard
  // that (rare for RAG passages, which are inline text) by falling back to the coerced string.
  const rTok = (r: WorkingRetrievable): number => {
    if (typeof r.estimateTokens !== 'function')
      return tok(renderContent(r.content as ContentLike | string))
    const est = r.estimateTokens(encoding)
    return typeof est === 'number' ? est : tok(renderContent(r.content as ContentLike | string))
  }

  // Count a thought's tokens against the live ctx (dynamic content resolves per-ctx; static is
  // unchanged).
  const thoughtTok = (t: WorkingThought): number => tokTok(t.content)
  // Count a `ContentLike`-backed bucket the SAME way a caller's own overflow guard does: resolve it
  // against the live ctx (`estimateTokens(enc, ctx)`) when the value exposes that method, not its
  // no-ctx `.toString()` fallback. An EVALUATABLE value (e.g. a system prompt that interpolates
  // against ctx) expands to a LARGER string at render than its static form, so measuring the static
  // form under-counts vs. the guard — the pass would then report "fits" while the caller's battery
  // throws on the ctx-resolved prompt. A plain string / value with no `estimateTokens` counts via the
  // plain `tok()` measurement of its rendered text, unaffected by `ctx`.
  function tokTok(v: ContentLike | string | undefined | null): number {
    if (v === undefined || v === null) return tok('')
    if (typeof v === 'string') return tok(v)
    if (typeof v.estimateTokens === 'function') return v.estimateTokens(encoding, renderCtx)
    return tok(v.toString())
  }

  const budget = resolveBudget(contextWindow, options.outputReserve, options.reserveFraction)
  const reserve = contextWindow - budget
  const buckets: BucketTrace[] = []

  const measure = (
    bucket: string,
    before: { tokens: number; count: number },
    after: { tokens: number; count: number },
    note?: string,
    ids?: string[]
  ): void => {
    buckets.push({
      bucket,
      beforeTokens: before.tokens,
      afterTokens: after.tokens,
      beforeCount: before.count,
      afterCount: after.count,
      note,
      ids,
    })
  }

  // Measured ctx-resolved (tokTok) to match a caller's own overflow guard: the system prompt is
  // often an EVALUATABLE value (it interpolates against ctx), so its static rendered form under-counts
  // vs. what the guard sees.
  const sysTokens = tokTok(ws.systemPrompt)
  // Standing instructions are a FIXED cost (durable directives, never shed) the guard also counts —
  // measured once and folded into the total alongside the system prompt so thrift and the guard agree.
  const siTokens = (ws.standingInstructions ?? []).reduce((n, si) => n + tokTok(si), 0)

  // 1. Thoughts — the prior-turn strip (Gemma §3 + thrift): drop all prior-turn thinking, unless the
  //    caller has opted out via `stripPriorTurnThoughts: false`.
  const thoughtsBefore = {
    tokens: ws.thoughts.reduce((n, t) => n + thoughtTok(t), 0),
    count: ws.thoughts.length,
  }
  const thoughtsDropped = doStripPriorTurnThoughts
    ? stripPriorTurnThoughts(ws, { estimateTokens, encoding }, options.keepThoughtIds).dropped
    : 0
  measure(
    'thoughts',
    thoughtsBefore,
    {
      tokens: ws.thoughts.reduce((n, t) => n + thoughtTok(t), 0),
      count: ws.thoughts.length,
    },
    !doStripPriorTurnThoughts
      ? 'prior-turn thought strip disabled by caller (stripPriorTurnThoughts: false)'
      : thoughtsDropped > 0
        ? 'dropped prior-turn thinking (kept thoughts preserved)'
        : 'no prior-turn thinking in history'
  )

  // 2. Tools — hide everything except the turn's shortlist. Hidden = callable, 0 schema tokens.
  const allTools = ws.tools.all()
  // Measure the ACTUAL dispatched tool block: when the caller's renderer is injected, render the
  // filtered set as ONE block and count that; otherwise fall back to the cheap `name: description`
  // proxy (can undercount a schema-heavy tool by an order of magnitude vs. what is actually sent).
  const toolTokens = (names: Set<string>): number => {
    const subset = allTools.filter((t) => names.has(t.name))
    if (subset.length === 0) return 0
    if (options.renderTools) return tok(options.renderTools(subset))
    return subset.reduce((n, t) => n + tok(`${t.name}: ${t.description ?? ''}`), 0)
  }
  // `visibleTools` is MUTABLE — step 2 hides everything except the shortlist, but the LAST-RESORT
  // tool shed (step 9 below) may hide shortlist tools too when even the leanest context won't fit, so
  // this set shrinks. `visibleToolTokens()` reads it live, so the running total reflects the current
  // visible set.
  const visibleTools = new Set(relevantToolNames)
  const toolsBefore = {
    tokens: toolTokens(new Set(allTools.map((t) => t.name))),
    count: allTools.length,
  }
  ws.tools.setHidden(...allTools.map((t) => t.name).filter((n) => !visibleTools.has(n)))
  measure(
    'tools',
    toolsBefore,
    { tokens: toolTokens(visibleTools), count: visibleTools.size },
    'hidden tools stay callable via the catalog'
  )

  // Running total against the budget.
  const imgTokens = (): number => (ws.image && ws.image.kept !== false ? ws.image.tokenCost : 0)
  const memTokens = (): number => ws.memories.reduce((n, m) => n + tokTok(m.content), 0)
  const ragTokens = (): number => ws.retrievables.reduce((n, r) => n + rTok(r), 0)
  // NOTE: `m.content` already holds the FULL rendered message body — including any artifact-handle /
  // response-envelope text the caller's battery stored as the content string — so this counts the
  // real dispatched string, not a proxy. Do NOT "fix" this to render handles separately; that would
  // double-count. Measured ctx-resolved (tokTok) to match the caller's own guard.
  const msgTokens = (): number => ws.messages.reduce((n, m) => n + tokTok(m.content), 0)
  const visibleToolTokens = (): number => toolTokens(visibleTools)
  // Prior-turn (and this-turn) tool RESULTS the caller's battery renders into the prompt.
  // Pre-measured by the caller so the pass stays synchronous. Historically the single biggest
  // multi-turn undercount when omitted: accumulated search results / artifact handles push the true
  // prompt far past what an unmeasured pass would report.
  const toolCallTokens = (): number => (ws.toolCalls ?? []).reduce((n, c) => n + c.tokenCost, 0)
  // The SURVIVING thoughts (the guidance keep-set after the step-1 strip) ARE rendered into the
  // dispatched prompt and counted by a caller's own overflow guard. They MUST be in the running
  // total, or thrift optimises against a smaller number than the guard checks and reports "fits"
  // while the guard throws.
  const thoughtTokens = (): number => ws.thoughts.reduce((n, t) => n + thoughtTok(t), 0)
  const total = (): number =>
    sysTokens +
    siTokens +
    imgTokens() +
    memTokens() +
    ragTokens() +
    msgTokens() +
    visibleToolTokens() +
    toolCallTokens() +
    thoughtTokens()

  const imgBefore = { tokens: ws.image ? ws.image.tokenCost : 0, count: ws.image ? 1 : 0 }
  const tcBefore = { tokens: toolCallTokens(), count: (ws.toolCalls ?? []).length }
  const memBefore = { tokens: memTokens(), count: ws.memories.length }
  const ragBefore = { tokens: ragTokens(), count: ws.retrievables.length }
  const msgBefore = { tokens: msgTokens(), count: ws.messages.length }
  if (unknownRetrievables.length > 0) {
    measure(
      'retrievables-size-unknown',
      { tokens: 0, count: unknownRetrievables.length },
      { tokens: 0, count: 0 },
      'unmeasurable handle-mode retrievables excluded before ranking or token totals',
      unknownRetrievables.map((r) => r.id).filter((id): id is string => id !== undefined)
    )
  }
  // The surviving guidance thoughts AFTER the step-1 strip — the starting point for the budget shed
  // below.
  const thoughtsShedBefore = { tokens: thoughtTokens(), count: ws.thoughts.length }

  // 3. Image — the biggest single hog. If the set is over budget, drop the image first: media is
  //    expensive, and thrift weighs it before anything else.
  if (ws.image && total() > budget) {
    ws.image.kept = false
  } else if (ws.image) {
    ws.image.kept = true
  }
  measure(
    'image',
    imgBefore,
    { tokens: imgTokens(), count: ws.image && ws.image.kept !== false ? 1 : 0 },
    'media is the biggest token hog — weighed and shed first'
  )

  // 3b. Shed PRIOR-TURN tool results (OLDEST first). Across a multi-turn session these accumulate
  //     the fastest — every search returns a blob, every catalog/read leaves an artifact handle — and
  //     a stale prior-turn result is low-reuse: the model already acted on it. Shed oldest→newest
  //     while over budget.
  if (ws.toolCalls && ws.toolCalls.length > 0) {
    // A THIS-turn result is the model's active working set — evicting one it just fetched makes it
    // re-request the same call (an identical-search loop), so this-turn results are protected FIRST.
    // Shed oldest PRIOR-turn results (the model already acted on those). Rebuild `ws.toolCalls` =
    // surviving-prior-turn + kept-this-turn.
    const thisTurn = ws.toolCalls
      .filter((c) => c.thisTurn)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
    const priorTurn = ws.toolCalls
      .filter((c) => !c.thisTurn)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
    while (total() > budget && priorTurn.length > 0) {
      priorTurn.shift()
      ws.toolCalls = [...priorTurn, ...thisTurn]
    }
    ws.toolCalls = [...priorTurn, ...thisTurn]

    // N-CAP BACKSTOP. If prior-turn results are exhausted and the dispatch STILL won't fit, the
    // unsheddable mass is accumulated THIS-turn result bodies — a deep read-loop turn (several
    // searches/reads) piles up real token weight per inlined body. Protecting ALL of them can exceed
    // the whole window. So cap the protected set to the NEWEST N this-turn results and shed the
    // OLDEST beyond N, oldest-first — the model has almost certainly moved past the oldest reads, and
    // the newest (its current focus) is always kept. Never drop the single newest this-turn result:
    // if even that + the floor won't fit, the dispatch legitimately refuses (window too small).
    if (total() > budget && thisTurn.length > thisTurnResultKeep) {
      // thisTurn is oldest→newest; shed from the front (oldest) while over budget and above the keep
      // floor.
      while (total() > budget && thisTurn.length > thisTurnResultKeep) {
        thisTurn.shift()
        ws.toolCalls = [...priorTurn, ...thisTurn]
      }
      ws.toolCalls = [...priorTurn, ...thisTurn]
    }
    measure(
      'toolCalls',
      tcBefore,
      { tokens: toolCallTokens(), count: ws.toolCalls.length },
      'oldest PRIOR-turn results shed first; this-turn results capped to newest N (oldest beyond N shed)'
    )
  }

  // 4. Shed the RAG tail (lowest-reranked first — keep the head, the best chunks).
  const retrievableIdsBefore = ws.retrievables
    .map((r) => r.id)
    .filter((id): id is string => id !== undefined)
  ws.retrievables.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  while (total() > budget && ws.retrievables.length > 0) ws.retrievables.pop()
  const retrievableIdsAfter = new Set(ws.retrievables.map((r) => r.id))
  const shedRetrievableIds = retrievableIdsBefore.filter((id) => !retrievableIdsAfter.has(id))
  measure(
    'retrievables',
    ragBefore,
    { tokens: ragTokens(), count: ws.retrievables.length },
    'tail of the ranking sheds first; the best chunks stay',
    shedRetrievableIds
  )

  // 5. Shed low-value memories next.
  ws.memories.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
  while (total() > budget && ws.memories.length > 0) ws.memories.pop()
  measure('memories', memBefore, { tokens: memTokens(), count: ws.memories.length })

  // 6. Shed the OLDEST EPHEMERAL messages first — per-iteration control-gate directives that are
  //    re-derived fresh every loop and never persisted. During a multi-iteration turn these pile up
  //    and are a dominant runaway growth; dropping the stale ones (keep only the LATEST, which
  //    carries the active directives) is pure win — it reclaims budget without losing real
  //    conversation. Sort oldest→newest and shed oldest ephemerals while over budget, always keeping
  //    the most recent ephemeral.
  ws.messages.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
  let lastEphIdx = -1
  for (let i = ws.messages.length - 1; i >= 0; i--) {
    if (isEphemeral(ws.messages[i])) {
      lastEphIdx = i
      break
    }
  }
  for (let i = 0; i < ws.messages.length && total() > budget; ) {
    if (isEphemeral(ws.messages[i]) && i !== lastEphIdx) {
      ws.messages.splice(i, 1)
      if (i < lastEphIdx) lastEphIdx-- // index shifted left by the removal
    } else {
      i++
    }
  }
  // 7. Then shed the OLDEST conversation turns (keep the newest — always keep >=1). EXCEPT a
  //    summarizing strategy's running-summary message (see `isSummaryMessage`): such a message is
  //    often stamped at the epoch so it RENDERS at the head of history, which also makes it the
  //    "oldest" turn — so a naive oldest-first shift would evict it FIRST. That is wrong: the summary
  //    is load-bearing compaction context (it stands in for every older turn that strategy folded
  //    away), unsheddable like the system prompt. Dropping it would silently degrade a summarizing
  //    strategy to "recent-verbatim-only", which is not compaction at all. Protect it: shed the
  //    oldest NON-summary turn instead. (A no-op when the caller runs no summarizing strategy — the
  //    default `isSummaryMessage` never matches.)
  //
  //    ws.messages is sorted oldest→newest. Shed the OLDEST turn each pass, but NEVER the protected
  //    summary and NEVER the single newest turn. So: consider only NON-summary turns; keep the last
  //    (newest) of them; shed the oldest of the rest while over budget. When only [summary, newest]
  //    remain, stop shedding — and if that STILL exceeds budget, the summary is not dropped. The
  //    total is allowed to stay over budget: step 9 (tools) still runs, then `subtractToFit` returns
  //    `fits: false` / `refused: true` and the caller's own turn-failure path takes over. That is the
  //    faithful compaction contract: an unfittable summary should surface as a refusal, not silently
  //    degrade to summary-less context.
  while (total() > budget) {
    const nonSummary = ws.messages.map((m, i) => ({ m, i })).filter((x) => !isCompactSummary(x.m))
    if (nonSummary.length <= 1) break // only [summary (+ newest)] left — never shed further; refuse instead
    ws.messages.splice(nonSummary[0].i, 1) // drop the OLDEST non-summary turn
  }
  measure(
    'messages',
    msgBefore,
    { tokens: msgTokens(), count: ws.messages.length },
    'stale ephemeral directives shed first, then oldest turns; protected summary + newest always kept'
  )

  // 8. Shed surviving GUIDANCE THOUGHTS as a last resort. These are the this-turn keep-set
  //    (plan/cite + per-iteration nudge thoughts) that survived the step-1 strip — high-signal, so
  //    shed only after messages. During a multi-iteration livelock the nudge thoughts accumulate here
  //    and are the tail-end runaway; each is re-derived every iteration, so dropping the OLDEST
  //    superseded ones is pure win. `protectThoughtIds` (the thoughts the model needs to answer at
  //    all) is never shed; everything else goes oldest→newest, always keeping the most recent (the
  //    active nudge). This is the bucket a caller's own guard counts that an earlier, less complete
  //    pass could be blind to — the accounting that lets thrift actually honour "the dispatched
  //    prompt fits" for thoughts.
  const isProtectedThought = (t: WorkingThought): boolean =>
    !!options.protectThoughtIds && options.protectThoughtIds.has(t.id)
  ws.thoughts.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
  let lastSheddableThoughtIdx = -1
  for (let i = ws.thoughts.length - 1; i >= 0; i--) {
    if (!isProtectedThought(ws.thoughts[i])) {
      lastSheddableThoughtIdx = i
      break
    }
  }
  for (let i = 0; i < ws.thoughts.length && total() > budget; ) {
    if (!isProtectedThought(ws.thoughts[i]) && i !== lastSheddableThoughtIdx) {
      ws.thoughts.splice(i, 1)
      if (i < lastSheddableThoughtIdx) lastSheddableThoughtIdx-- // index shifted left by the removal
    } else {
      i++
    }
  }
  measure(
    'thoughts-shed',
    thoughtsShedBefore,
    { tokens: thoughtTokens(), count: ws.thoughts.length },
    'stale nudge thoughts shed oldest-first; protected thoughts kept, newest nudge kept'
  )

  // 9. LAST-RESORT: shed VISIBLE TOOLS. Everything cheaper is already gone and the dispatch still
  //    won't fit — so the tool schemas (the model's ability to ACT) become a sheddable bucket too,
  //    rather than an unsheddable floor that deadlocks a tight window. Shed by `shedRank` (lower
  //    ranks first), keeping `protectedToolNames` to the very end of the queue. A tool shed here is
  //    HIDDEN (`setHidden` → 0 schema tokens) but stays callable via a catalog if room reappears. Pure
  //    thrift: shed what does not fit; a caller's own downstream gates (e.g. "did the required tool
  //    stay visible?") yield when their required tool is no longer visible.
  const toolsShedBefore = { tokens: visibleToolTokens(), count: visibleTools.size }
  if (visibleTools.size > 0 && total() > budget) {
    // INVARIANT (the flagship reference agent's own design rule, preserved here as guidance for
    // callers): a dispatch should overflow ONLY when the irreducible floor (system prompt + newest
    // turn + output reserve) alone exceeds the window — never because a sheddable tool was left in
    // place. So the shed drives visible tools toward ZERO. PLANNED-BUT-UNCALLED tools (see
    // `protectedToolNames`) shed LAST, not never: keeping a plan-required tool visible is preferable
    // RIGHT UP UNTIL the only alternative is a hard overflow, at which point a degraded-but-delivered
    // dispatch beats a failed one. Two phases, each rank-ordered: shed non-protected first, then
    // protected.
    const nonProtected = [...visibleTools]
      .filter((n) => !(options.protectedToolNames?.has(n) ?? false))
      .sort((a, b) => shedRank(a) - shedRank(b))
    const protectedLast = [...visibleTools]
      .filter((n) => options.protectedToolNames?.has(n) ?? false)
      .sort((a, b) => shedRank(a) - shedRank(b))
    const shedQueue = [...nonProtected, ...protectedLast]
    const allToolNames = allTools.map((t) => t.name)
    for (const name of shedQueue) {
      if (total() <= budget) break
      visibleTools.delete(name)
      // setHidden REPLACES the hidden set (any name not passed becomes visible), so pass the
      // COMPLETE hidden set every time = every registered tool NOT in the surviving visible set.
      // (visibleToolTokens reads visibleTools, so total() reflects the shed immediately.)
      ws.tools.setHidden(...allToolNames.filter((n) => !visibleTools.has(n)))
    }
  }
  measure(
    'tools-shed',
    toolsShedBefore,
    { tokens: visibleToolTokens(), count: visibleTools.size },
    'LAST-RESORT: visible tools shed by rank toward ZERO; protected tools shed last'
  )

  const totalAfter = total()
  const fits = totalAfter <= budget
  const refused = !fits

  return {
    contextWindow,
    reserve,
    budget,
    totalBefore:
      sysTokens +
      siTokens +
      thoughtsBefore.tokens +
      toolsBefore.tokens +
      imgBefore.tokens +
      tcBefore.tokens +
      memBefore.tokens +
      ragBefore.tokens +
      msgBefore.tokens,
    totalAfter,
    fits,
    refused,
    buckets,
  }
}
// #endregion shed
