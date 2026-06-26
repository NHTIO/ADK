/**
 * Runtime-agnostic reasoning/thinking text parsers for text-only LLM batteries.
 *
 * @remarks
 * **Why this exists.** Text-only on-device runtimes (transformers.js, LiteRT-LM v0.13.1) emit a
 * reasoning model's chain-of-thought as **raw text inside the assistant message**, delimited in a
 * format specific to the model family — not as a structured `reasoning` field the way OpenAI-style
 * providers do (those are handled by `extractReasoningFields`). To surface that thinking as ADK
 * {@link @nhtio/adk!Thought}s rather than leaking `<think>…</think>` markup into the visible answer,
 * the battery must parse it out of the text.
 *
 * Same shape as the tool-call parser layer: one parser per family, anchored on a literal marker, run
 * post-hoc. The bundled defaults cover the dominant conventions; `'auto'` tries them in order and a
 * custom {@link ReasoningParserFn} is the escape hatch.
 *
 * NOT `@module`-tagged: private to the bundled LLM batteries, re-exported through their public
 * surfaces.
 */

// ─── Contract ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The result of running a {@link ReasoningParserFn} over assistant text.
 *
 * @remarks
 * `reasoning` holds each extracted thinking trace in document order; `cleanedText` is the prose with
 * every consumed reasoning span removed and trimmed. On no-match a parser MUST return
 * `{ reasoning: [], cleanedText: rawText }` verbatim.
 */
export interface ReasoningParseResult {
  /** Each extracted thinking trace, in document order. Empty when no reasoning was found. */
  reasoning: string[]
  /** The prose with every consumed reasoning span removed; equals the input on no-match. */
  cleanedText: string
}

/** A synchronous reasoning text parser. */
export type ReasoningParserFn = (rawText: string) => ReasoningParseResult

/** The bundled reasoning parser names, plus `'auto'` (try-all) and `'none'` (disable). */
export type ReasoningParserName =
  | 'auto'
  | 'think_tag'
  | 'harmony_analysis'
  | 'gemma_channel'
  | 'none'

/**
 * Options shared by the bundled reasoning parsers.
 *
 * @remarks
 * `orphanRecovery` (default `true`) controls whether an **unpaired** reasoning marker is recovered by
 * inferring the missing half from the pseudo-streaming order, rather than being left to leak into the
 * visible answer. A real-world gemma-4-E4B WebGPU quant "randomly emits `</think>`" with no matching
 * open; because generation is start→end, a lone close implies the block opened at the previous close
 * (or start-of-output), and a lone open with no close implies reasoning ran to end-of-stream. Turn this
 * off for strict pair-only behaviour (markers without a matching partner are left verbatim).
 */
export interface ReasoningParserOptions {
  /** Recover unpaired markers by inferring the missing half (default `true`). */
  orphanRecovery?: boolean
}

// ─── Shared ───────────────────────────────────────────────────────────────────────────────────────

const NO_MATCH = (rawText: string): ReasoningParseResult => ({
  reasoning: [],
  cleanedText: rawText,
})

const removeSpans = (text: string, spans: Array<[number, number]>): string => {
  let out = text
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + out.slice(end)
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * A literal open/close marker pair for a reasoning family. `openRe` is a `g`-flagged regex (so the open
 * marker can carry trailing attributes, e.g. gemma's `<|channel>thought\n`); `close` is a literal
 * string. After each match the captured trace is the text strictly between the open match's end and the
 * close.
 */
interface ReasoningMarkers {
  /** Global-flagged regex matching the OPEN marker (its full match is consumed). */
  openRe: RegExp
  /** Literal CLOSE marker string. */
  close: string
}

/**
 * Collect reasoning spans, recovering UNPAIRED markers by inferring the missing half from the
 * pseudo-streaming order (see {@link ReasoningParserOptions}). Algorithm, in precedence:
 *
 * 1. **Paired** spans first — each OPEN whose following text contains a CLOSE forms a complete span
 *    `[openStart, closeEnd]`; the trace is the text between. (Unchanged from the strict path.)
 * 2. **Lone closes** — in the text NOT covered by a pair, scan left-to-right for CLOSE markers that
 *    have no preceding OPEN. Each spans `[cursor, closeEnd]` where `cursor` starts at start-of-text and
 *    advances to each consumed close, so `A </c> B </c> C` → traces `A`, `B` and answer `C` (the second
 *    orphan-close opens at the first close, not back at 0).
 * 3. **Lone open** — a final OPEN with no following CLOSE spans `[openStart, end-of-text]` (truncated
 *    stream).
 *
 * When `orphanRecovery` is false this collapses to strict paired-only behaviour (identical to the old
 * `collect`). Returns NO_MATCH only when nothing — no pair, no orphan — was found.
 */
const collectWithOrphans = (
  rawText: string,
  markers: ReasoningMarkers,
  orphanRecovery: boolean
): ReasoningParseResult => {
  const { openRe, close } = markers
  const reasoning: string[] = []
  const spans: Array<[number, number]> = []

  // Reset lastIndex defensively (these regexes are module-level and `g`-flagged).
  openRe.lastIndex = 0

  // Walk the text once. At each step, find the next OPEN and the next CLOSE from the cursor.
  // `cursor` is the start of the not-yet-consumed remainder.
  let cursor = 0
  // Track whether we are currently "inside" an implied/explicit open. For strict pairing we only
  // consume an open when a close follows it.
  while (cursor <= rawText.length) {
    openRe.lastIndex = cursor
    const openMatch = openRe.exec(rawText)
    const openStart = openMatch ? openMatch.index : -1
    const openEnd = openMatch ? openMatch.index + openMatch[0].length : -1
    const closeStart = rawText.indexOf(close, cursor)

    if (closeStart !== -1 && (openStart === -1 || closeStart < openStart)) {
      // A CLOSE appears before the next OPEN (or there is no further OPEN). This is an ORPHAN close:
      // the implied open is the cursor (start-of-remainder == previous close position).
      if (!orphanRecovery) {
        // Strict mode: an unpaired close is not consumed — advance past it untouched.
        cursor = closeStart + close.length
        continue
      }
      const trace = rawText.slice(cursor, closeStart).trim()
      if (trace.length > 0) reasoning.push(trace)
      spans.push([cursor, closeStart + close.length])
      cursor = closeStart + close.length
      continue
    }

    if (openStart !== -1) {
      // We have an OPEN. Look for its matching CLOSE after the open.
      const pairedClose = rawText.indexOf(close, openEnd)
      if (pairedClose !== -1) {
        // Complete pair.
        const trace = rawText.slice(openEnd, pairedClose).trim()
        if (trace.length > 0) reasoning.push(trace)
        spans.push([openStart, pairedClose + close.length])
        cursor = pairedClose + close.length
        continue
      }
      // Lone OPEN with no following CLOSE → truncated stream: reasoning runs to end-of-text.
      if (!orphanRecovery) break
      const trace = rawText.slice(openEnd).trim()
      if (trace.length > 0) reasoning.push(trace)
      spans.push([openStart, rawText.length])
      break
    }

    // No further OPEN and no further CLOSE — done.
    break
  }

  return spans.length > 0
    ? { reasoning, cleanedText: removeSpans(rawText, spans) }
    : NO_MATCH(rawText)
}

// ─── think_tag: <think>…</think> (Qwen3, DeepSeek-R1 — the dominant convention) ───────────────────────
// Two delimiter shapes share this family: `<think>`/`</think>` and the `<thinking>`/`</thinking>`
// variant. They are processed independently (a `<think>` never pairs with a `</thinking>`).

const THINK_OPEN_RE = /<think>/g
const THINKING_OPEN_RE = /<thinking>/g

/**
 * Parse `<think>…</think>` (and the `<thinking>…</thinking>` variant) reasoning blocks — the dominant
 * convention, used by Qwen3, DeepSeek-R1, and most distilled reasoning models. Unpaired markers (a lone
 * `</think>` or a truncated `<think>`) are recovered by default — see {@link ReasoningParserOptions}.
 */
export const makeThinkTagReasoningParser =
  (opts: ReasoningParserOptions = {}): ReasoningParserFn =>
  (rawText) => {
    const orphan = opts.orphanRecovery ?? true
    // Run the two delimiter shapes in sequence over the running cleaned text so spans from one don't
    // collide with the other. `<think>` first (the common form), then `<thinking>`.
    const first = collectWithOrphans(rawText, { openRe: THINK_OPEN_RE, close: '</think>' }, orphan)
    const second = collectWithOrphans(
      first.cleanedText,
      { openRe: THINKING_OPEN_RE, close: '</thinking>' },
      orphan
    )
    const reasoning = [...first.reasoning, ...second.reasoning]
    return reasoning.length > 0 || second.cleanedText !== rawText
      ? { reasoning, cleanedText: second.cleanedText }
      : NO_MATCH(rawText)
  }

/** Default {@link makeThinkTagReasoningParser} (orphan recovery on). */
export const thinkTagReasoningParser: ReasoningParserFn = makeThinkTagReasoningParser()

/** Default {@link thinkTagReasoningParser}. */
export const defaultThinkTagReasoningParser = thinkTagReasoningParser

// ─── harmony_analysis: gpt-oss Harmony analysis channel ───────────────────────────────────────────────

const HARMONY_OPEN_RE = /<\|channel\|>analysis\s*<\|message\|>/g

/**
 * Parse gpt-oss Harmony chain-of-thought on the `analysis` channel:
 * `<|channel|>analysis<|message|>…<|end|>`. (The user-visible answer is the separate `final` channel;
 * tool calls are `commentary` — handled by the tool-call parser.) Unpaired markers are recovered by
 * default — see {@link ReasoningParserOptions}.
 */
export const makeHarmonyAnalysisReasoningParser =
  (opts: ReasoningParserOptions = {}): ReasoningParserFn =>
  (rawText) =>
    collectWithOrphans(
      rawText,
      { openRe: HARMONY_OPEN_RE, close: '<|end|>' },
      opts.orphanRecovery ?? true
    )

/** Default {@link makeHarmonyAnalysisReasoningParser} (orphan recovery on). */
export const harmonyAnalysisReasoningParser: ReasoningParserFn =
  makeHarmonyAnalysisReasoningParser()

/** Default {@link harmonyAnalysisReasoningParser}. */
export const defaultHarmonyAnalysisReasoningParser = harmonyAnalysisReasoningParser

// ─── gemma_channel: Gemma E2B/E4B <|channel>thought\n…<channel|> ──────────────────────────────────────
// Verified byte-exact against onnx-community/gemma-4-E2B-it-ONNX tokenizer_config.json. NOTE the
// asymmetric markers: open `<|channel>thought` (no closing pipe before `>`), close `<channel|>`.

const GEMMA_OPEN_RE = /<\|channel>thought\b[^\n]*\n?/g

/**
 * Parse Gemma E2B/E4B reasoning emitted on the thought channel:
 * `<|channel>thought\n…<channel|>`. Targets the E2B/E4B delimited form (the transformers.js-runnable
 * one). Reasoning is only emitted when `<|think|>` is injected into the system prompt. Unpaired markers
 * are recovered by default — see {@link ReasoningParserOptions}.
 */
export const makeGemmaChannelReasoningParser =
  (opts: ReasoningParserOptions = {}): ReasoningParserFn =>
  (rawText) =>
    collectWithOrphans(
      rawText,
      { openRe: GEMMA_OPEN_RE, close: '<channel|>' },
      opts.orphanRecovery ?? true
    )

/** Default {@link makeGemmaChannelReasoningParser} (orphan recovery on). */
export const gemmaChannelReasoningParser: ReasoningParserFn = makeGemmaChannelReasoningParser()

/** Default {@link gemmaChannelReasoningParser}. */
export const defaultGemmaChannelReasoningParser = gemmaChannelReasoningParser

// ─── none ─────────────────────────────────────────────────────────────────────────────────────────

/** A parser that never extracts anything — disables reasoning parsing entirely. */
export const noneReasoningParser: ReasoningParserFn = (rawText) => NO_MATCH(rawText)

/** Default {@link noneReasoningParser}. */
export const defaultNoneReasoningParser = noneReasoningParser

// ─── auto ─────────────────────────────────────────────────────────────────────────────────────────

/** The bundled reasoning parsers keyed by name (excluding `'auto'`/`'none'`), orphan recovery ON. */
export const BUNDLED_REASONING_PARSERS: Readonly<
  Record<Exclude<ReasoningParserName, 'auto' | 'none'>, ReasoningParserFn>
> = {
  think_tag: thinkTagReasoningParser,
  harmony_analysis: harmonyAnalysisReasoningParser,
  gemma_channel: gemmaChannelReasoningParser,
}

/** Build the bundled family parsers honouring {@link ReasoningParserOptions} (e.g. orphan recovery). */
export const buildBundledReasoningParsers = (
  opts: ReasoningParserOptions = {}
): Record<Exclude<ReasoningParserName, 'auto' | 'none'>, ReasoningParserFn> => ({
  think_tag: makeThinkTagReasoningParser(opts),
  harmony_analysis: makeHarmonyAnalysisReasoningParser(opts),
  gemma_channel: makeGemmaChannelReasoningParser(opts),
})

/** The default `'auto'` precedence. All three are literal-marker-anchored, so order is collision-free. */
export const DEFAULT_REASONING_PARSER_ORDER: ReadonlyArray<
  Exclude<ReasoningParserName, 'auto' | 'none'>
> = ['think_tag', 'harmony_analysis', 'gemma_channel']

/**
 * Compose an `'auto'` reasoning parser: run each parser in `order` until one returns a non-empty
 * `reasoning` array; that result wins. Returns no-match if none claim the text.
 */
export const createAutoReasoningParser = (
  parsers: Partial<
    Record<Exclude<ReasoningParserName, 'auto' | 'none'>, ReasoningParserFn>
  > = BUNDLED_REASONING_PARSERS,
  order: ReadonlyArray<
    Exclude<ReasoningParserName, 'auto' | 'none'>
  > = DEFAULT_REASONING_PARSER_ORDER
): ReasoningParserFn => {
  return (rawText) => {
    for (const name of order) {
      const parser = parsers[name]
      if (!parser) continue
      const result = parser(rawText)
      // A parser "claims" the text if it extracted reasoning OR consumed/stripped any markup
      // (e.g. an empty thought channel — strip the markers even when there's no trace).
      if (result.reasoning.length > 0 || result.cleanedText !== rawText) return result
    }
    return NO_MATCH(rawText)
  }
}

/** Default {@link createAutoReasoningParser}. */
export const defaultCreateAutoReasoningParser = createAutoReasoningParser

/**
 * Resolve a `reasoningParser` option (a name, `'auto'`, `'none'`, or a custom fn) to a concrete
 * {@link ReasoningParserFn}.
 *
 * @param option - The option value. Defaults to `'auto'` when undefined.
 * @param parsers - Override the bundled parsers. Ignored when `opts.orphanRecovery` is set (the bundled
 *   family parsers are rebuilt with that setting); pass a custom `option` fn for full control.
 * @param opts - {@link ReasoningParserOptions}; `orphanRecovery` defaults to `true`. When `false`, the
 *   named/auto bundled parsers are rebuilt in strict pair-only mode.
 */
export const resolveReasoningParser = (
  option: ReasoningParserName | ReasoningParserFn | undefined,
  parsers: Partial<
    Record<Exclude<ReasoningParserName, 'auto' | 'none'>, ReasoningParserFn>
  > = BUNDLED_REASONING_PARSERS,
  opts: ReasoningParserOptions = {}
): ReasoningParserFn => {
  if (typeof option === 'function') return option
  if (option === 'none') return noneReasoningParser
  // When orphan recovery is explicitly disabled, rebuild the bundled parsers in strict mode (and ignore
  // a `parsers` override, which would otherwise carry the default orphan-on instances).
  const resolved =
    opts.orphanRecovery === false
      ? buildBundledReasoningParsers(opts)
      : { ...BUNDLED_REASONING_PARSERS, ...parsers }
  if (option === undefined || option === 'auto') return createAutoReasoningParser(resolved)
  return resolved[option] ?? noneReasoningParser
}

/** Default {@link resolveReasoningParser}. */
export const defaultResolveReasoningParser = resolveReasoningParser
