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

const collect = (rawText: string, re: RegExp): ReasoningParseResult => {
  const reasoning: string[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(re)) {
    const trace = m[1].trim()
    if (trace.length > 0) reasoning.push(trace)
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  // Strip the reasoning markup whenever the delimiters matched — even if the captured trace was empty
  // (e.g. an empty thought channel when thinking was disabled), so the markers never leak into prose.
  return spans.length > 0
    ? { reasoning, cleanedText: removeSpans(rawText, spans) }
    : NO_MATCH(rawText)
}

// ─── think_tag: <think>…</think> (Qwen3, DeepSeek-R1 — the dominant convention) ───────────────────────

const THINK_TAG_RE = /<think(?:ing)?>\s*([\s\S]*?)\s*<\/think(?:ing)?>/g

/**
 * Parse `<think>…</think>` (and the `<thinking>…</thinking>` variant) reasoning blocks — the dominant
 * convention, used by Qwen3, DeepSeek-R1, and most distilled reasoning models.
 */
export const thinkTagReasoningParser: ReasoningParserFn = (rawText) =>
  collect(rawText, THINK_TAG_RE)

/** Default {@link thinkTagReasoningParser}. */
export const defaultThinkTagReasoningParser = thinkTagReasoningParser

// ─── harmony_analysis: gpt-oss Harmony analysis channel ───────────────────────────────────────────────

const HARMONY_ANALYSIS_RE = /<\|channel\|>analysis\s*<\|message\|>\s*([\s\S]*?)\s*<\|end\|>/g

/**
 * Parse gpt-oss Harmony chain-of-thought on the `analysis` channel:
 * `<|channel|>analysis<|message|>…<|end|>`. (The user-visible answer is the separate `final` channel;
 * tool calls are `commentary` — handled by the tool-call parser.)
 */
export const harmonyAnalysisReasoningParser: ReasoningParserFn = (rawText) =>
  collect(rawText, HARMONY_ANALYSIS_RE)

/** Default {@link harmonyAnalysisReasoningParser}. */
export const defaultHarmonyAnalysisReasoningParser = harmonyAnalysisReasoningParser

// ─── gemma_channel: Gemma E2B/E4B <|channel>thought\n…<channel|> ──────────────────────────────────────
// Verified byte-exact against onnx-community/gemma-4-E2B-it-ONNX tokenizer_config.json. NOTE the
// asymmetric markers: open `<|channel>thought` (no closing pipe before `>`), close `<channel|>`.

const GEMMA_CHANNEL_RE = /<\|channel>thought\b[^\n]*\n?([\s\S]*?)<channel\|>/g

/**
 * Parse Gemma E2B/E4B reasoning emitted on the thought channel:
 * `<|channel>thought\n…<channel|>`. Targets the E2B/E4B delimited form (the transformers.js-runnable
 * one). Reasoning is only emitted when `<|think|>` is injected into the system prompt.
 */
export const gemmaChannelReasoningParser: ReasoningParserFn = (rawText) =>
  collect(rawText, GEMMA_CHANNEL_RE)

/** Default {@link gemmaChannelReasoningParser}. */
export const defaultGemmaChannelReasoningParser = gemmaChannelReasoningParser

// ─── none ─────────────────────────────────────────────────────────────────────────────────────────

/** A parser that never extracts anything — disables reasoning parsing entirely. */
export const noneReasoningParser: ReasoningParserFn = (rawText) => NO_MATCH(rawText)

/** Default {@link noneReasoningParser}. */
export const defaultNoneReasoningParser = noneReasoningParser

// ─── auto ─────────────────────────────────────────────────────────────────────────────────────────

/** The bundled reasoning parsers keyed by name (excluding `'auto'`/`'none'`). */
export const BUNDLED_REASONING_PARSERS: Readonly<
  Record<Exclude<ReasoningParserName, 'auto' | 'none'>, ReasoningParserFn>
> = {
  think_tag: thinkTagReasoningParser,
  harmony_analysis: harmonyAnalysisReasoningParser,
  gemma_channel: gemmaChannelReasoningParser,
}

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
 * @param parsers - Override the bundled parsers.
 */
export const resolveReasoningParser = (
  option: ReasoningParserName | ReasoningParserFn | undefined,
  parsers: Partial<
    Record<Exclude<ReasoningParserName, 'auto' | 'none'>, ReasoningParserFn>
  > = BUNDLED_REASONING_PARSERS
): ReasoningParserFn => {
  if (typeof option === 'function') return option
  if (option === undefined || option === 'auto') return createAutoReasoningParser(parsers)
  if (option === 'none') return noneReasoningParser
  const parser = parsers[option] ?? BUNDLED_REASONING_PARSERS[option]
  return parser ?? noneReasoningParser
}

/** Default {@link resolveReasoningParser}. */
export const defaultResolveReasoningParser = resolveReasoningParser
