/**
 * Runtime-agnostic tool-call text parsers for text-only LLM batteries.
 *
 * @remarks
 * **Why this exists.** On-device runtimes like transformers.js and LiteRT-LM (v0.13.1) are
 * text-in / text-out: they inject tool definitions into the chat template, but the model emits its
 * tool calls as **raw text in the assistant message**, in a format specific to the model family it
 * was fine-tuned on. Unlike the OpenAI/Ollama wire batteries — where the provider returns a
 * structured `tool_calls` array — these batteries must parse the call out of the text themselves.
 *
 * This mirrors how vLLM / SGLang / Ollama do it: one **post-hoc** parser per model family, selected
 * by a flag, run *after* generation (sub-millisecond, fails gracefully, never constrains decoding).
 * Each family parser is anchored on a literal marker (or, for the weak-signal JSON/pythonic forms, on
 * the callee name matching a real tool) so cross-family false positives are structurally impossible.
 *
 * **Formats are model-specific and drift across versions** (e.g. Gemma has three incompatible tool
 * formats across its generations; gpt-oss's Harmony channel ordering is an active upstream bug). The
 * bundled defaults target the small ONNX models that actually run in transformers.js; the `'auto'`
 * driver fails gracefully and a custom {@link ToolCallParserFn} is the escape hatch for anything else.
 *
 * NOT `@module`-tagged: private to the bundled LLM batteries, re-exported through their public
 * surfaces (`transformers_js`, `litert_lm`). Consumers import from those battery subpaths.
 */

import { isObject } from '@nhtio/adk/guards'

// ─── Contract ─────────────────────────────────────────────────────────────────────────────────────

/** A JSON-serialisable value — the shape of parsed tool-call arguments. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** A single tool call extracted from model output. `arguments` is a parsed object, never a string. */
export interface ParsedToolCall {
  /** The tool name the model called. */
  name: string
  /** The parsed argument object (never a JSON string). */
  arguments: Record<string, JsonValue>
}

/**
 * The result of running a {@link ToolCallParserFn} over assistant text.
 *
 * @remarks
 * `cleanedText` is the prose with every consumed tool-call span removed and trimmed, so the visible
 * assistant message never carries raw markup. On no-match a parser MUST return
 * `{ calls: [], cleanedText: rawText }` verbatim — that is the signal the `'auto'` driver uses to
 * detect "this parser made no claim" and move to the next one.
 */
export interface ToolCallParseResult {
  /** The tool calls extracted, in document order. Empty when the parser made no claim. */
  calls: ParsedToolCall[]
  /** The assistant prose with every consumed tool-call span removed; equals the input on no-match. */
  cleanedText: string
}

/** Context passed to a parser: the names of the tools actually offered this turn. */
export interface ToolCallParserContext {
  /** The visible tool names this turn — lets a parser reject calls to tools that don't exist. */
  toolNames: ReadonlyArray<string>
}

/** A synchronous tool-call text parser. */
export type ToolCallParserFn = (rawText: string, ctx: ToolCallParserContext) => ToolCallParseResult

/** The bundled family parser names, plus `'auto'` (try-all) and `'none'` (disable). */
export type ToolCallParserName =
  | 'auto'
  | 'hermes'
  | 'gemma'
  | 'gpt_oss'
  | 'pythonic'
  | 'llama3_json'
  | 'mistral'
  | 'qwen3_coder'
  | 'none'

// ─── Shared helpers ─────────────────────────────────────────────────────────────────────────────────

const NO_MATCH = (rawText: string): ToolCallParseResult => ({ calls: [], cleanedText: rawText })

const asArgsObject = (value: unknown): Record<string, JsonValue> =>
  isObject(value) ? (value as Record<string, JsonValue>) : {}

/**
 * Remove a set of `[start, end)` spans from `text` (descending by start so offsets stay valid),
 * collapse the resulting whitespace seams, and trim.
 */
const removeSpans = (text: string, spans: Array<[number, number]>): string => {
  let out = text
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + out.slice(end)
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/** Try to JSON.parse; return undefined on failure (parsers decline rather than throw). */
const tryJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

// ─── Hermes: <tool_call>{json}</tool_call> (Hermes 2/3, Qwen2.5, Qwen3-Instruct) ──────────────────────

const HERMES_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

/**
 * Parse Hermes-style `<tool_call>{"name":…,"arguments":{…}}</tool_call>` tags. The de-facto standard,
 * reused by Qwen2.5/Qwen3-Instruct. Anchored on the literal tags — zero collision with bare JSON.
 */
export const hermesToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(HERMES_RE)) {
    const obj = tryJsonParse(m[1])
    if (isObject(obj) && typeof obj.name === 'string') {
      const o = obj as { name: string; arguments?: unknown }
      calls.push({ name: o.name, arguments: asArgsObject(o.arguments) })
      spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    }
  }
  return calls.length > 0 ? { calls, cleanedText: removeSpans(rawText, spans) } : NO_MATCH(rawText)
}

/** Default {@link hermesToolCallParser}. */
export const defaultHermesToolCallParser = hermesToolCallParser

// ─── Gemma E2B/E4B: <|tool_call>call:NAME{...<|"|>val<|"|>}<tool_call|> ────────────────────────────────
// Verified byte-exact against onnx-community/gemma-4-E2B-it-ONNX tokenizer_config.json chat template.

const GEMMA_WRAP_RE = /<\|tool_call>([\s\S]*?)<tool_call\|>/g
const GEMMA_NAME_RE = /^\s*call:\s*([^{]+?)\s*\{/

/**
 * Parse Gemma E2B/E4B delimited tool calls: `<|tool_call>call:NAME{key:<|"|>value<|"|>}<tool_call|>`.
 * String values are wrapped in the `<|"|>` escape token; keys are bare. Targets the E2B/E4B form only
 * — Gemma 3 (`tool_code` fences) and FunctionGemma (`<start_function_call>`) are out of scope (use a
 * custom {@link ToolCallParserFn}).
 */
export const gemmaToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(GEMMA_WRAP_RE)) {
    const body = m[1]
    const nameMatch = GEMMA_NAME_RE.exec(body)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const braceStart = body.indexOf('{')
    const braceEnd = body.lastIndexOf('}')
    const argsBlock =
      braceStart >= 0 && braceEnd > braceStart ? body.slice(braceStart, braceEnd + 1) : '{}'
    // Normalise the Gemma arg block into JSON: <|"|> → ", quote bare keys.
    const jsonish = argsBlock
      .replace(/<\|"\|>/g, '"')
      .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    const parsed = tryJsonParse(jsonish)
    calls.push({ name, arguments: asArgsObject(parsed) })
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  return calls.length > 0 ? { calls, cleanedText: removeSpans(rawText, spans) } : NO_MATCH(rawText)
}

/** Default {@link gemmaToolCallParser}. */
export const defaultGemmaToolCallParser = gemmaToolCallParser

// ─── gpt-oss Harmony: <|channel|>commentary to=functions.NAME ...<|message|>{json}<|call|> ─────────────

const GPT_OSS_RE =
  /<\|channel\|>commentary\s+to=functions\.([A-Za-z0-9_]+)[\s\S]*?<\|message\|>\s*([\s\S]*?)\s*<\|call\|>/g

/**
 * Parse gpt-oss Harmony tool calls on the `commentary` channel:
 * `<|channel|>commentary to=functions.NAME <|constrain|>json<|message|>{…}<|call|>`. The arguments
 * payload between `<|message|>` and `<|call|>` is JSON. Anchored on the literal Harmony markers.
 *
 * @remarks The Harmony channel/constrain ordering has a documented upstream template-vs-spec drift;
 * this matches the common ordering. Verify against a real gpt-oss ONNX run when one is available.
 */
export const gptOssToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(GPT_OSS_RE)) {
    const obj = tryJsonParse(m[2])
    calls.push({ name: m[1], arguments: asArgsObject(obj) })
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  return calls.length > 0 ? { calls, cleanedText: removeSpans(rawText, spans) } : NO_MATCH(rawText)
}

/** Default {@link gptOssToolCallParser}. */
export const defaultGptOssToolCallParser = gptOssToolCallParser

// ─── Pythonic: [get_weather(city='SF'), ...] (Llama 3.2/4, Olmo3) ─────────────────────────────────────

const PYTHONIC_SHAPE_RE = /^\[\s*[A-Za-z_]\w*\s*\(.*\)\s*\]$/s
const PYTHONIC_CALL_RE = /([A-Za-z_]\w*)\s*\(([^)]*)\)/g

/** Read a single pythonic literal: quoted string, number, True/False/None. */
const readPythonLiteral = (raw: string): JsonValue => {
  const t = raw.trim()
  if (/^(['"]).*\1$/s.test(t)) return t.slice(1, -1)
  if (t === 'True' || t === 'true') return true
  if (t === 'False' || t === 'false') return false
  if (t === 'None' || t === 'null') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : t
}

/** Split `k=v, k2=v2` on top-level commas (ignores commas inside quotes/brackets). */
const splitPythonArgs = (s: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let cur = ''
  for (const ch of s) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim().length > 0) parts.push(cur)
  return parts
}

/**
 * Parse pythonic tool calls — `[get_weather(city='SF'), get_time()]`. Requires the **whole trimmed
 * output** to be the bracketed call list AND every callee name to be a real tool (`ctx.toolNames`), so
 * it cannot false-positive on incidental prose. Parallel calls are inherent to the format.
 */
export const pythonicToolCallParser: ToolCallParserFn = (rawText, ctx) => {
  const t = rawText.trim()
  if (!PYTHONIC_SHAPE_RE.test(t)) return NO_MATCH(rawText)
  const inner = t.slice(1, -1)
  const calls: ParsedToolCall[] = []
  for (const m of inner.matchAll(PYTHONIC_CALL_RE)) {
    const name = m[1]
    if (!ctx.toolNames.includes(name)) return NO_MATCH(rawText)
    const args: Record<string, JsonValue> = {}
    for (const pair of splitPythonArgs(m[2])) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      args[pair.slice(0, eq).trim()] = readPythonLiteral(pair.slice(eq + 1))
    }
    calls.push({ name, arguments: args })
  }
  return calls.length > 0 ? { calls, cleanedText: '' } : NO_MATCH(rawText)
}

/** Default {@link pythonicToolCallParser}. */
export const defaultPythonicToolCallParser = pythonicToolCallParser

// ─── Llama3-JSON: bare {"name":…, "parameters":…} (weakest signal — runs late) ────────────────────────

/**
 * Parse a bare top-level JSON tool call — `{"name":"x","parameters":{…}}` (or `"arguments"`). The
 * weakest signal, so it is gated hard: the entire trimmed output must be the JSON object AND the
 * callee must be a real tool (`ctx.toolNames`). Runs after every marker-anchored family in `'auto'`.
 */
export const llama3JsonToolCallParser: ToolCallParserFn = (rawText, ctx) => {
  const t = rawText.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return NO_MATCH(rawText)
  const obj = tryJsonParse(t)
  if (obj === null || typeof obj !== 'object') return NO_MATCH(rawText)
  const o = obj as { name?: unknown; parameters?: unknown; arguments?: unknown }
  if (typeof o.name !== 'string' || !ctx.toolNames.includes(o.name)) return NO_MATCH(rawText)
  return {
    calls: [{ name: o.name, arguments: asArgsObject(o.parameters ?? o.arguments) }],
    cleanedText: '',
  }
}

/** Default {@link llama3JsonToolCallParser}. */
export const defaultLlama3JsonToolCallParser = llama3JsonToolCallParser

// ─── Mistral: [TOOL_CALLS] [ {json}, ... ] ────────────────────────────────────────────────────────────

const MISTRAL_RE = /\[TOOL_CALLS\]\s*(\[[\s\S]*\])/

/**
 * Parse Mistral tool calls — the `[TOOL_CALLS]` token followed by a JSON array of
 * `{ name, arguments }`. Anchored on the literal `[TOOL_CALLS]` token.
 */
export const mistralToolCallParser: ToolCallParserFn = (rawText) => {
  const m = MISTRAL_RE.exec(rawText)
  if (!m) return NO_MATCH(rawText)
  const arr = tryJsonParse(m[1])
  if (!Array.isArray(arr)) return NO_MATCH(rawText)
  const calls: ParsedToolCall[] = []
  for (const entry of arr) {
    if (isObject(entry) && typeof entry.name === 'string') {
      const e = entry as { name: string; arguments?: unknown }
      calls.push({ name: e.name, arguments: asArgsObject(e.arguments) })
    }
  }
  return calls.length > 0
    ? { calls, cleanedText: removeSpans(rawText, [[m.index ?? 0, (m.index ?? 0) + m[0].length]]) }
    : NO_MATCH(rawText)
}

/** Default {@link mistralToolCallParser}. */
export const defaultMistralToolCallParser = mistralToolCallParser

// ─── Qwen3-Coder: <tool_call><function=NAME><parameter=k>v</parameter></function></tool_call> ─────────

const QWEN3_CODER_RE =
  /<tool_call>\s*<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g
const QWEN3_PARAM_RE = /<parameter=([A-Za-z0-9_]+)>([\s\S]*?)<\/parameter>/g

/**
 * Parse Qwen3-Coder's custom per-parameter XML — `<tool_call><function=NAME><parameter=k>v</parameter>
 * …</function></tool_call>`. Values are taken as trimmed strings (the format is untyped). Anchored on
 * the literal `<function=` tag, distinct from Hermes's JSON-in-`<tool_call>`.
 */
export const qwen3CoderToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(QWEN3_CODER_RE)) {
    const args: Record<string, JsonValue> = {}
    for (const p of m[2].matchAll(QWEN3_PARAM_RE)) {
      args[p[1]] = p[2].trim()
    }
    calls.push({ name: m[1], arguments: args })
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  return calls.length > 0 ? { calls, cleanedText: removeSpans(rawText, spans) } : NO_MATCH(rawText)
}

/** Default {@link qwen3CoderToolCallParser}. */
export const defaultQwen3CoderToolCallParser = qwen3CoderToolCallParser

// ─── none: never matches ──────────────────────────────────────────────────────────────────────────

/** A parser that never extracts anything — disables tool-call parsing entirely. */
export const noneToolCallParser: ToolCallParserFn = (rawText) => NO_MATCH(rawText)

/** Default {@link noneToolCallParser}. */
export const defaultNoneToolCallParser = noneToolCallParser

// ─── auto: try-all in priority order, first non-empty wins ────────────────────────────────────────

/** The bundled family parsers keyed by name (excluding `'auto'`/`'none'`). */
export const BUNDLED_TOOL_CALL_PARSERS: Readonly<
  Record<Exclude<ToolCallParserName, 'auto' | 'none'>, ToolCallParserFn>
> = {
  hermes: hermesToolCallParser,
  gemma: gemmaToolCallParser,
  gpt_oss: gptOssToolCallParser,
  pythonic: pythonicToolCallParser,
  llama3_json: llama3JsonToolCallParser,
  mistral: mistralToolCallParser,
  qwen3_coder: qwen3CoderToolCallParser,
}

/**
 * The default `'auto'` precedence. Marker-anchored families first (collision-free); the weak-signal
 * pythonic/llama3_json forms run last and are gated on callee∈toolNames.
 */
export const DEFAULT_TOOL_CALL_PARSER_ORDER: ReadonlyArray<
  Exclude<ToolCallParserName, 'auto' | 'none'>
> = ['hermes', 'gemma', 'gpt_oss', 'pythonic', 'llama3_json', 'mistral', 'qwen3_coder']

/**
 * Compose an `'auto'` parser: run each family parser in `order` until one returns a non-empty
 * `calls` array; that result wins. Returns no-match if none claim the text.
 */
export const createAutoToolCallParser = (
  parsers: Partial<
    Record<Exclude<ToolCallParserName, 'auto' | 'none'>, ToolCallParserFn>
  > = BUNDLED_TOOL_CALL_PARSERS,
  order: ReadonlyArray<
    Exclude<ToolCallParserName, 'auto' | 'none'>
  > = DEFAULT_TOOL_CALL_PARSER_ORDER
): ToolCallParserFn => {
  return (rawText, ctx) => {
    for (const name of order) {
      const parser = parsers[name]
      if (!parser) continue
      const result = parser(rawText, ctx)
      if (result.calls.length > 0) return result
    }
    return NO_MATCH(rawText)
  }
}

/** Default {@link createAutoToolCallParser}. */
export const defaultCreateAutoToolCallParser = createAutoToolCallParser

/**
 * Resolve a `toolCallParser` option (a name, `'auto'`, `'none'`, or a custom fn) to a concrete
 * {@link ToolCallParserFn}.
 *
 * @param option - The option value. Defaults to `'auto'` when undefined.
 * @param parsers - Override the bundled family parsers (e.g. swap the Gemma parser).
 */
export const resolveToolCallParser = (
  option: ToolCallParserName | ToolCallParserFn | undefined,
  parsers: Partial<
    Record<Exclude<ToolCallParserName, 'auto' | 'none'>, ToolCallParserFn>
  > = BUNDLED_TOOL_CALL_PARSERS
): ToolCallParserFn => {
  if (typeof option === 'function') return option
  if (option === undefined || option === 'auto') return createAutoToolCallParser(parsers)
  if (option === 'none') return noneToolCallParser
  const parser = parsers[option] ?? BUNDLED_TOOL_CALL_PARSERS[option]
  return parser ?? noneToolCallParser
}

/** Default {@link resolveToolCallParser}. */
export const defaultResolveToolCallParser = resolveToolCallParser
