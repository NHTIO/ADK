/**
 * Structural contracts for the Token Thrift subtractive-pass battery — every shape it reads off a
 * caller's objects, and every capability it invokes via an injected function.
 *
 * @module @nhtio/adk/batteries/context/thrift/contracts
 *
 * @remarks
 * This module has **zero imports** — not even a type-only import from `@nhtio/adk` core. Every type
 * below is a local structural (duck-typed) declaration of the *minimum* shape the subtractive pass
 * actually reads, derived field-by-field from the production algorithm this battery was extracted
 * from (the flagship agent's `agent_subtractive_pass.ts`). A core `Message`, `Memory`, `Retrievable`,
 * `Thought`, `Tool`, or `ToolRegistry` instance satisfies these interfaces structurally — you never
 * need to import the core classes to call this battery, and the battery never needs to import them
 * to accept your objects. This is the "surface, don't impose" contract in its most literal form: the
 * battery imposes a SHAPE, never a CLASS.
 *
 * Two kinds of decoupling happen here:
 *
 * 1. **Structural types** for the read-only working-set items (messages, memories, retrievables,
 *    thoughts, tool calls, tools, a tool registry) — the battery only ever reads the handful of
 *    fields/methods declared here, never the full core class surface.
 * 2. **Injected resolver functions** for capabilities the battery cannot perform itself — most
 *    importantly token estimation ({@link EstimateTokensFn}), since this battery ships with no
 *    tokenizer of its own and must never guess at one.
 */

/**
 * Estimate the token cost of a rendered string under a named encoding, optionally resolved against a
 * live dispatch context.
 *
 * @remarks
 * This is the ONE capability the subtractive pass cannot perform itself — it has no bundled
 * tokenizer, by design (a context-management algorithm should not force a specific encoding on every
 * caller). Every token-accounting entry point in this battery therefore takes an `estimateTokens`
 * option of this shape and REQUIRES it (see {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit}).
 *
 * The signature mirrors core's own `Tokenizable.estimateTokens(encoding, ctx?)` method deliberately —
 * a caller already holding `Tokenizable` can inject `(value, encoding, ctx) => new Tokenizable(value).estimateTokens(encoding, ctx)`
 * (or, more cheaply, delegate to `Tokenizable.estimateTokens` as a static call) and get byte-for-byte
 * parity with what core's own overflow guard counts. The `ctx` parameter exists for exactly that
 * reason: a dynamic/evaluatable value's rendered size can depend on the live dispatch context (an
 * interpolated system prompt is the canonical example), and a battery that measured only the static
 * form would under-count relative to what the caller's guard actually ships — a real production bug
 * this contract exists to prevent (see the `ctx`-resolved measurement note on
 * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit}).
 *
 * A caller measuring under a CUSTOM (non-built-in) encoding registers it once via
 * {@link @nhtio/adk!registerTokenEstimator} and otherwise injects `Tokenizable.estimateTokens` exactly
 * as shown above — the registration makes the custom encoding a drop-in peer of the built-ins, so this
 * battery never needs to know the encoding is non-standard.
 *
 * @param value - The exact string whose token cost should be measured (already rendered — this
 *   function never renders anything itself).
 * @param encoding - The encoding identifier to measure under (e.g. `'cl100k_base'`, `'gemma'`) — an
 *   opaque string as far as this battery is concerned; the injected function interprets it.
 * @param ctx - The live dispatch context, when measuring a value whose rendered size can depend on it
 *   (an evaluatable/dynamic value). Static content ignores this parameter.
 * @returns The estimated token count, as a plain synchronous number.
 */
export type EstimateTokensFn = (value: string, encoding: string, ctx?: unknown) => number

/**
 * Anything that can estimate its own rendered token cost under a named encoding — the structural
 * shape the battery expects from a `Tokenizable`-like value (system prompt, standing instruction,
 * message content, thought content). Mirrors core's `Tokenizable` public surface, minimally.
 */
export interface Estimable {
  /**
   * Estimate this value's rendered token cost under `encoding`, optionally resolved against a live
   * dispatch context (see {@link EstimateTokensFn} for why `ctx` matters for dynamic content).
   */
  estimateTokens(encoding: string, ctx?: unknown): number
}

/**
 * A `Tokenizable`-like value: renders to a string and (usually) knows its own token cost. Every
 * content field the working set carries (system prompt, standing instructions, message/thought
 * content) is either a plain `string` or a value shaped like this.
 *
 * @remarks
 * `estimateTokens` is optional here (unlike {@link Estimable}) because a caller may hand the battery
 * a plain object that only renders text (e.g. a lightweight test double) — the battery falls back to
 * measuring `toString()` via the injected {@link EstimateTokensFn} when `estimateTokens` is absent.
 */
export interface ContentLike {
  /** Render this value to its dispatched text form. */
  toString(): string
  /** Optional self-measurement, preferred over the `toString()` fallback when present. */
  estimateTokens?(encoding: string, ctx?: unknown): number
}

/** Anything with a `.toMillis()` — the structural shape the battery needs from a timestamp field
 *  (a core `DateTime` satisfies this; so does a plain `{ toMillis: () => number }` test double). */
export interface MillisTimestamp {
  /** The instant this timestamp represents, as Unix epoch milliseconds. */
  toMillis(): number
}

/**
 * The structural shape of a conversation message the working set carries. Only the fields the pass
 * actually reads: `id` (for ephemeral/summary predicate matching and identity-stable tracing),
 * `content` (measured, and — for messages with no `content` — treated as empty/attachments-only),
 * and `createdAt` (for oldest-first shedding order).
 */
export interface WorkingMessage {
  /** Stable identifier, matched against `keepThoughtIds`-style id sets and the injected
   *  `isEphemeralMessage`/`isSummaryMessage` predicates. */
  id: string
  /** The message's rendered content. Absent (attachment-only messages) measures as zero tokens. */
  content?: ContentLike | string
  /** When this message was created; drives oldest-first shedding order. */
  createdAt: MillisTimestamp
}

/**
 * The structural shape of a memory the working set carries. Only `content` (measured) and
 * `importance` (sort key — low-importance memories shed first) are read.
 */
export interface WorkingMemory {
  /** The memory's rendered content, measured toward the memories bucket's token weight. */
  content: ContentLike | string
  /** `[0, 1]`-ish importance score; memories sort by this (descending) before the shed, so the
   *  lowest-importance memories are popped first. Missing/absent sorts as `0` (shed first). */
  importance?: number
}

/**
 * The structural shape of a retrieved passage (RAG chunk) the working set carries. `estimateTokens`
 * mirrors a core `Retrievable`'s own method, which MAY resolve asynchronously (a reader-backed
 * artifact's estimate can be a `Promise`) — the battery treats a non-number return as "measure the
 * rendered string instead" (see {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit}'s `rTok`
 * helper), since this pass is synchronous end-to-end and never awaits.
 */
export interface WorkingRetrievable {
  /** The retrieved passage's rendered content. */
  content: ContentLike | string
  /** Relevance/rerank score, `[0, 1]`-ish; retrievables sort by this (descending) before the shed, so
   *  the tail of the ranking (lowest score) sheds first. Missing/absent sorts as `0` (shed first). */
  score?: number
  /** Optional self-measurement; may resolve synchronously OR as a `Promise` (a reader-backed
   *  artifact). A non-number result falls back to measuring `content.toString()`. */
  estimateTokens?(encoding: string): number | Promise<number>
}

/**
 * The structural shape of a "thought" (model-internal guidance/scratchpad content, e.g. a plan or a
 * per-iteration nudge) the working set carries. Read for identity (`id`, matched against
 * `keepThoughtIds`/`protectThoughtIds`), measurement (`content`), and shed ordering (`createdAt`).
 */
export interface WorkingThought {
  /** Stable identifier, matched against `keepThoughtIds`/`protectThoughtIds` sets. */
  id: string
  /** The thought's rendered content. */
  content: ContentLike | string
  /** When this thought was created; drives oldest-first shedding order. */
  createdAt: MillisTimestamp
}

/**
 * The structural shape of a tool declaration the working set's tool registry carries. Only `name`
 * (identity, shed-rank lookup) and `description` (the fallback `name: description` measurement proxy
 * used when no {@link RenderToolsFn} is injected) are read.
 */
export interface WorkingTool {
  /** The tool's registered name — identity, and the shed-rank lookup key. */
  name: string
  /** Human-readable description, used in the fallback `name: description` measurement proxy. */
  description?: string
}

/**
 * The MINIMAL tool-registry surface the pass needs — not the full core `ToolRegistry` class. Only
 * `all()` (enumerate every registered tool, to compute the tools bucket's "before" weight) and
 * `setHidden(...names)` (replace the entire hidden set — the mechanism by which a shed tool becomes
 * invisible to the model while remaining callable via a catalog) are invoked.
 *
 * @remarks
 * `setHidden` REPLACES the whole hidden set on each call (matching core `ToolRegistry.setHidden`'s
 * contract) — the pass always passes the COMPLETE set of currently-hidden tool names, never a delta.
 * A structural registry that instead accumulates hidden names across calls would over-hide.
 */
export interface WorkingToolRegistry {
  /** Every tool currently registered (visible or hidden). */
  all(): WorkingTool[]
  /** Replace the registry's entire hidden set with exactly these tool names. */
  setHidden(...names: string[]): void
}

/**
 * A prior-turn (or this-turn) tool call in the working set, carrying the PRE-COMPUTED token cost of
 * its rendered result — the pass never renders a tool result itself (it would need to await an
 * artifact reader, breaking synchrony), so the caller measures the result via its own renderer and
 * hands the cost here.
 */
export interface WorkingToolCall {
  /** Opaque handle back to the caller's own call record, returned unchanged so the caller can
   *  reconcile which calls survived the shed (e.g. against a `Set` of live tool-call ids). */
  ref: unknown
  /** Token cost of this call's model-facing rendered result, measured by the caller. */
  tokenCost: number
  /** Chronological order key — oldest tool results shed first among the sheddable pool. */
  createdAtMs: number
  /**
   * `true` when this call was made during the CURRENT turn (the model just made it this dispatch).
   * Such results are the turn's active working set and are protected from ordinary budget-shedding —
   * evicting a result the model just fetched makes it immediately re-request the same call. Only
   * prior-turn results (falsy/absent) are eligible for ordinary shedding; this-turn results are only
   * shed by the newest-N backstop (`thisTurnResultKeep`) as a last resort. See
   * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit}.
   */
  thisTurn?: boolean
}

/** An image (or other flat-cost media) attachment in the working set — the single biggest token hog,
 *  shed first when the dispatch is over budget. */
export interface WorkingImage {
  /** Human label for tracing/diagnostics. */
  label: string
  /** Token cost of including this attachment in the dispatch. */
  tokenCost: number
  /** Whether it survived the pass; set by `subtractToFit`, ignored on input. */
  kept?: boolean
}

/**
 * Renders a set of tools into the EXACT prompt text a caller's LLM battery will send to the model
 * (e.g. a `<tool_definitions>` block with full JSON-Schema per tool), so the tools bucket is measured
 * against the REAL dispatched size rather than a cheap `name: description` proxy. Injecting this is
 * the difference between an accurate budget and one that silently undercounts by an order of
 * magnitude for schema-heavy tools — see the calibration note on
 * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit}. Optional: when omitted,
 * the pass falls back to the `name: description` proxy (keeps the battery usable standalone/in tests
 * without a real tool-rendering pipeline).
 *
 * @param tools - The subset of tools currently visible (post-hiding), to render/measure.
 * @returns The exact rendered text the caller's battery would send for these tools.
 */
export type RenderToolsFn = (tools: ReadonlyArray<WorkingTool>) => string

/**
 * Ranks a tool by last-resort shed priority: LOWER rank sheds FIRST. Ties are broken by encounter
 * order (a stable sort), so two tools ranked equally shed in whatever order the caller's
 * `relevantToolNames` listed them.
 *
 * @remarks
 * This replaces a hard-coded, domain-specific tier list (the flagship agent's `TOOL_SHED_ORDER`,
 * which knew tool names like `provide_answer` and `search_docs_semantic`) with an INJECTABLE policy.
 * The battery ships a generic default (see the `shedRank` option on
 * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit}) that treats every tool
 * equally — it has no domain knowledge of which of a caller's tools are "delivery" tools vs. "gather"
 * tools vs. "exotic reader" tools. A caller who DOES have that knowledge (as the flagship agent does)
 * should supply a `ShedRankFn` that encodes it, exactly as the flagship's own `TOOL_SHED_ORDER`-derived
 * function did in production.
 *
 * @param name - The tool's registered name.
 * @returns A rank; lower sheds first. Any finite number is valid — there is no required range.
 */
export type ShedRankFn = (name: string) => number

/**
 * Decide whether a message is an EPHEMERAL control message — one that is re-derived fresh every
 * dispatch iteration and never persisted, so only the LATEST surviving copy carries live information
 * and every older one is pure waste. Injectable so a caller's own id-tagging scheme (or a caller with
 * no such concept at all) can plug in; see the `isEphemeralMessage` option on
 * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit} for the calibrated
 * default (`id.startsWith('__eph-')`, the flagship agent's own convention).
 */
export type IsEphemeralMessageFn = (message: WorkingMessage) => boolean

/**
 * Decide whether a message is the load-bearing "running summary" a compacting/summarizing strategy
 * maintains — content that stands in for every older turn that strategy folded away, and so must
 * never be shed like an ordinary old turn even though it is chronologically the oldest message in the
 * working set. Injectable; see the `isSummaryMessage` option on
 * {@link @nhtio/adk/batteries/context/thrift/subtractive_pass!subtractToFit} for the calibrated
 * default (`id === '__compact-summary'`). Callers who never run a summarizing strategy alongside
 * thrift can ignore this entirely — the default predicate simply never matches their messages.
 */
export type IsSummaryMessageFn = (message: WorkingMessage) => boolean
