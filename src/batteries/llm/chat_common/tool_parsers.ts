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
  | 'phi'
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

/**
 * From `text`, with `from` pointing AT an opening `open` char, return the index of its matching
 * `close` char — string-aware, so a delimiter inside a JSON string literal (e.g. a `}` or `]` or a
 * `</tool_call>`-shaped substring inside `{"text":"…"}`) is NOT miscounted. Returns -1 if the run is
 * unbalanced (e.g. a truncated stream). This is the brace/bracket scan that makes the marker-anchored
 * parsers robust to embedded markup in argument values — the dominant failure class the red-team panel
 * found in the old lazy/greedy regexes.
 */
const scanBalanced = (text: string, from: number, open: string, close: string): number => {
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ─── Hermes: <tool_call>{json}</tool_call> (Hermes 2/3, Qwen2.5, Qwen3-Instruct) ──────────────────────

const HERMES_OPEN = '<tool_call>'

/**
 * Parse Hermes-style `<tool_call>{"name":…,"arguments":{…}}</tool_call>` tags. The de-facto standard,
 * reused by Qwen2.5/Qwen3-Instruct. Anchored on the literal tags — zero collision with bare JSON.
 *
 * @remarks
 * The JSON object after each `<tool_call>` is located by a string-aware balanced-brace scan (not a lazy
 * `</tool_call>` regex), so an embedded `</tool_call>` or `{`/`}` inside a string argument value (e.g.
 * `{"text":"</tool_call>"}`) survives instead of truncating the call. The literal `</tool_call>` close
 * is still consumed for span removal when present immediately after the object.
 */
export const hermesToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  let searchFrom = 0
  for (;;) {
    const openIdx = rawText.indexOf(HERMES_OPEN, searchFrom)
    if (openIdx === -1) break
    const braceStart = rawText.indexOf('{', openIdx + HERMES_OPEN.length)
    if (braceStart === -1) break
    const braceEnd = scanBalanced(rawText, braceStart, '{', '}')
    if (braceEnd === -1) {
      // Unbalanced (truncated stream) — stop; nothing more is parseable.
      break
    }
    const obj = tryJsonParse(rawText.slice(braceStart, braceEnd + 1))
    // The close tag is REQUIRED and must sit immediately after the object (allowing whitespace). The
    // brace-scan already found the true object end, so an embedded `</tool_call>` inside a string value
    // is BEFORE braceEnd and never consulted — but a genuinely truncated call (no real close) declines.
    const afterObj = rawText.slice(braceEnd + 1)
    const closeRel = /^\s*<\/tool_call>/.exec(afterObj)
    if (closeRel && isObject(obj) && typeof obj.name === 'string') {
      const o = obj as { name: string; arguments?: unknown }
      calls.push({ name: o.name, arguments: asArgsObject(o.arguments) })
      spans.push([openIdx, braceEnd + 1 + closeRel[0].length])
      searchFrom = braceEnd + 1 + closeRel[0].length
    } else {
      // Malformed/truncated candidate: skip it but keep scanning for a later valid call.
      searchFrom = braceEnd + 1
    }
  }
  return calls.length > 0 ? { calls, cleanedText: removeSpans(rawText, spans) } : NO_MATCH(rawText)
}

/** Default {@link hermesToolCallParser}. */
export const defaultHermesToolCallParser = hermesToolCallParser

// ─── Gemma E2B/E4B: call:NAME{key:value} (wrapper + <|"|> tokens are decoder-stripped at runtime) ─────
// The tokenizer_config TEMPLATE wraps calls as `<|tool_call>call:NAME{k:<|"|>v<|"|>}<tool_call|>`, but a
// REAL onnx-community/gemma-4-E2B-it-ONNX run emits the bare inner form `call:get_weather{city:Paris}` —
// the `<|tool_call>`/`<tool_call|>`/`<|"|>` markers are SPECIAL TOKENS the decoder strips. Verified
// empirically via the real-model matrix (do NOT trust the template's literal tokens for the runtime
// form). So we accept BOTH: the wrapped template form AND the stripped bare form, with unquoted scalars.

const GEMMA_WRAP_RE = /<\|tool_call>\s*call:\s*([A-Za-z_]\w*)\s*(\{[^{}]*\})\s*<tool_call\|>/g
const GEMMA_BARE_RE = /call:\s*([A-Za-z_]\w*)\s*(\{[^{}]*\})/g

/** Normalise a Gemma arg block (`{k:<|"|>v<|"|>}` or stripped `{k:v}`) into JSON. */
const gemmaArgsToJson = (argsBlock: string): unknown => {
  const jsonish = argsBlock
    // <|"|> string delimiters → " (template form).
    .replace(/<\|"\|>/g, '"')
    // Quote bare keys: `{key:` / `,key:` → `"key":`.
    .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
    // Quote bare scalar VALUES (the stripped form leaves them unquoted, e.g. city:Paris). Skip values
    // that are already a JSON literal: a quoted string, a number/sign, or true/false/null.
    .replace(/:\s*(?!["\d-]|true\b|false\b|null\b)([^,}\]]+?)\s*([,}\]])/g, ':"$1"$2')
  return tryJsonParse(jsonish)
}

/**
 * Parse Gemma E2B/E4B tool calls. Accepts the wrapped template form
 * (`<|tool_call>call:NAME{k:<|"|>v<|"|>}<tool_call|>`) AND the decoder-stripped runtime form
 * (`call:NAME{k:v}`, special tokens removed, scalars unquoted — the shape a real ONNX run emits).
 * Targets the E2B/E4B form only — Gemma 3 (`tool_code` fences) and FunctionGemma
 * (`<start_function_call>`) are out of scope (use a custom {@link ToolCallParserFn}).
 */
export const gemmaToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  // Prefer the wrapped form (anchored, collision-free); fall back to the bare form only if none matched.
  for (const m of rawText.matchAll(GEMMA_WRAP_RE)) {
    calls.push({ name: m[1], arguments: asArgsObject(gemmaArgsToJson(m[2])) })
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  if (calls.length === 0) {
    for (const m of rawText.matchAll(GEMMA_BARE_RE)) {
      calls.push({ name: m[1], arguments: asArgsObject(gemmaArgsToJson(m[2])) })
      spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    }
  }
  return calls.length > 0 ? { calls, cleanedText: removeSpans(rawText, spans) } : NO_MATCH(rawText)
}

/** Default {@link gemmaToolCallParser}. */
export const defaultGemmaToolCallParser = gemmaToolCallParser

// ─── gpt-oss Harmony: <|channel|>commentary to=functions.NAME ...<|message|>{json}<|call|> ─────────────

// Anchor: locates the channel header + callee name + the `<|message|>` marker. The JSON payload that
// follows is then brace-scanned (string-aware) rather than lazily matched up to `<|call|>` — a `<|call|>`
// substring inside a JSON string value would otherwise truncate the call.
const GPT_OSS_HEAD_RE =
  /<\|channel\|>commentary\s+to=functions\.([A-Za-z0-9_]+)[\s\S]*?<\|message\|>/g
const GPT_OSS_CALL = '<|call|>'

/**
 * Parse gpt-oss Harmony tool calls on the `commentary` channel:
 * `<|channel|>commentary to=functions.NAME <|constrain|>json<|message|>{…}<|call|>`. The arguments
 * payload after `<|message|>` is JSON, located by a string-aware balanced-brace scan so an embedded
 * `<|call|>` / brace inside a string value survives. Anchored on the literal Harmony markers.
 *
 * @remarks The Harmony channel/constrain ordering has a documented upstream template-vs-spec drift;
 * this matches the common ordering. Verify against a real gpt-oss ONNX run when one is available.
 */
export const gptOssToolCallParser: ToolCallParserFn = (rawText) => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(GPT_OSS_HEAD_RE)) {
    const headStart = m.index ?? 0
    const afterMsg = headStart + m[0].length
    const braceStart = rawText.indexOf('{', afterMsg)
    if (braceStart === -1) continue
    const braceEnd = scanBalanced(rawText, braceStart, '{', '}')
    if (braceEnd === -1) continue
    const obj = tryJsonParse(rawText.slice(braceStart, braceEnd + 1))
    if (!isObject(obj)) continue
    // The trailing `<|call|>` marker is REQUIRED and must sit right after the object (allowing
    // whitespace). The brace-scan found the true object end, so an embedded `<|call|>` inside a string
    // value is never consulted; a genuinely missing terminator (truncated stream) declines.
    const afterObj = rawText.slice(braceEnd + 1)
    const callRel = new RegExp(`^\\s*${GPT_OSS_CALL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(
      afterObj
    )
    if (!callRel) continue
    calls.push({ name: m[1], arguments: asArgsObject(obj) })
    spans.push([headStart, braceEnd + 1 + callRel[0].length])
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
 * output** to be the bracketed call list, so it cannot false-positive on incidental prose. Parallel
 * calls are inherent to the format.
 *
 * **Disambiguation, NOT authorization.** The `[fn(args), …]` shape (whole-output) is the structural
 * signal that this is a call list. It deliberately does NOT check callees against `ctx.toolNames` —
 * whether a tool is *allowed* is the consumer's call, and the dispatch layer already replies "Tool not
 * found: … Available tools: …" so the model can self-correct. Dropping an unknown-tool call here would
 * hide the request and that feedback loop.
 */
export const pythonicToolCallParser: ToolCallParserFn = (rawText) => {
  const t = rawText.trim()
  if (!PYTHONIC_SHAPE_RE.test(t)) return NO_MATCH(rawText)
  const inner = t.slice(1, -1)
  const calls: ParsedToolCall[] = []
  for (const m of inner.matchAll(PYTHONIC_CALL_RE)) {
    const name = m[1]
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

/** Strip a single surrounding ```` ```json … ``` ```` (or bare ```` ``` ```` ) fence, if present. */
const stripCodeFence = (text: string): string => {
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text.trim())
  return m ? m[1].trim() : text.trim()
}

/**
 * Parse bare top-level JSON tool call(s) — `{"name":"x","parameters":{…}}` (or `"arguments"`),
 * optionally wrapped in a ```` ```json … ``` ```` fence (a common small-model emission — verified via
 * the real-model matrix on Qwen2.5-Coder-0.5B). The weakest signal, so it is gated hard: after
 * un-fencing, the output must be ONLY top-level JSON object(s) AND every callee must be a real tool
 * (`ctx.toolNames`). Runs after every marker-anchored family in `'auto'`.
 *
 * @remarks
 * **Parallel calls.** Small Llama-family / Qwen-Coder models emit MULTIPLE calls as several top-level
 * objects separated by `,` / `;` / whitespace (verified on the real-model matrix:
 * Llama-3.2-1B → `{…}; {…}`, Qwen2.5-Coder-0.5B → a fenced `{…},\n{…}`). So we string-aware brace-scan
 * the (un-fenced) text into successive balanced `{…}` objects, accepting only the separators above
 * between them — if any NON-separator prose sits between or around the objects, the whole thing declines
 * (the hard whole-output gate, so this never false-positives on JSON embedded in a sentence).
 *
 * **Disambiguation, NOT authorization.** This parser is marker-free, so it must distinguish a tool call
 * from arbitrary JSON content. It does that STRUCTURALLY: whole-output-is-object(s) + each object has a
 * string `name`. It deliberately does NOT check the callee against `ctx.toolNames` — whether a requested
 * tool is *allowed* is the consumer's decision, not the parser's. An unknown-tool call is surfaced like
 * any other; the dispatch layer already replies "Tool not found: … Available tools: …" so the model can
 * self-correct. Silently dropping the call here would hide both the request and that feedback loop.
 */
export const llama3JsonToolCallParser: ToolCallParserFn = (rawText) => {
  const t = stripCodeFence(rawText)
  if (!t.startsWith('{') || !t.endsWith('}')) return NO_MATCH(rawText)

  const calls: ParsedToolCall[] = []
  let i = 0
  while (i < t.length) {
    // Only object separators (`,`/`;`) and whitespace are allowed between top-level objects.
    if (/[\s,;]/.test(t[i]!)) {
      i++
      continue
    }
    if (t[i] !== '{') return NO_MATCH(rawText) // non-separator prose → not a pure call list; decline
    const end = scanBalanced(t, i, '{', '}')
    if (end === -1) return NO_MATCH(rawText)
    const obj = tryJsonParse(t.slice(i, end + 1))
    if (!isObject(obj)) return NO_MATCH(rawText)
    const o = obj as { name?: unknown; parameters?: unknown; arguments?: unknown }
    // Structural disambiguation only: a string `name` makes it call-shaped. Authorization is downstream.
    if (typeof o.name !== 'string') return NO_MATCH(rawText)
    calls.push({ name: o.name, arguments: asArgsObject(o.parameters ?? o.arguments) })
    i = end + 1
  }
  return calls.length > 0 ? { calls, cleanedText: '' } : NO_MATCH(rawText)
}

/** Default {@link llama3JsonToolCallParser}. */
export const defaultLlama3JsonToolCallParser = llama3JsonToolCallParser

// ─── Mistral: [TOOL_CALLS] [ {json}, ... ] ────────────────────────────────────────────────────────────

const MISTRAL_BOT_TOKEN = '[TOOL_CALLS]'

/**
 * Parse Mistral tool calls — the `[TOOL_CALLS]` token followed by a JSON array of
 * `{ name, arguments }`. Anchored on the literal `[TOOL_CALLS]` token.
 *
 * @remarks
 * The array is located by a string-aware balanced-bracket scan from the first `[` after the token (same
 * approach as {@link phiToolCallParser}), so a `]` inside a string argument value (e.g.
 * `{"text":"a]b"}`) does not truncate the array the way the old greedy `\[[\s\S]*\]` regex did.
 */
export const mistralToolCallParser: ToolCallParserFn = (rawText) => {
  const tokenIdx = rawText.indexOf(MISTRAL_BOT_TOKEN)
  if (tokenIdx === -1) return NO_MATCH(rawText)
  const arrStart = rawText.indexOf('[', tokenIdx + MISTRAL_BOT_TOKEN.length)
  if (arrStart === -1) return NO_MATCH(rawText)
  const arrEnd = scanBalanced(rawText, arrStart, '[', ']')
  if (arrEnd === -1) return NO_MATCH(rawText)
  const arr = tryJsonParse(rawText.slice(arrStart, arrEnd + 1))
  if (!Array.isArray(arr)) return NO_MATCH(rawText)
  const calls: ParsedToolCall[] = []
  for (const entry of arr) {
    if (isObject(entry) && typeof entry.name === 'string') {
      const e = entry as { name: string; arguments?: unknown }
      calls.push({ name: e.name, arguments: asArgsObject(e.arguments) })
    }
  }
  return calls.length > 0
    ? { calls, cleanedText: removeSpans(rawText, [[tokenIdx, arrEnd + 1]]) }
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

// ─── Phi-4-mini: functools[{"name":…,"arguments":{…}}, …] ─────────────────────────────────────────────
// Verified against vLLM's `phi4_mini_json` parser: the begin-of-tool token is the literal `functools`,
// followed by a JSON ARRAY of {name, arguments} objects (Microsoft's documented Phi-4 emission shape).
// NOT the `<|tool_calls|>` markers some third-party docs claim — grounded against the real parser.

const PHI_BOT_TOKEN = 'functools'

/**
 * Parse Phi-4-mini tool calls: the literal `functools` token followed by a JSON array of
 * `{ name, arguments }` objects (e.g. `functools[{"name":"get_weather","arguments":{"city":"SF"}}]`).
 *
 * @remarks
 * Anchored on the `functools` begin-of-tool token (vLLM's `phi4_mini_json`). The array is located by
 * scanning for the first `[` after the token and matching to its balanced closing `]`, so trailing
 * prose after the call does not break parsing. Declines (no-match) if the payload is not a JSON array
 * of name-bearing objects.
 */
export const phiToolCallParser: ToolCallParserFn = (rawText) => {
  const tokenIdx = rawText.indexOf(PHI_BOT_TOKEN)
  if (tokenIdx === -1) return NO_MATCH(rawText)
  const arrStart = rawText.indexOf('[', tokenIdx + PHI_BOT_TOKEN.length)
  if (arrStart === -1) return NO_MATCH(rawText)
  // Find the balanced closing bracket (string-aware so brackets inside JSON strings don't miscount).
  let depth = 0
  let inStr = false
  let escaped = false
  let arrEnd = -1
  for (let i = arrStart; i < rawText.length; i++) {
    const ch = rawText[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        arrEnd = i
        break
      }
    }
  }
  if (arrEnd === -1) return NO_MATCH(rawText)
  const arr = tryJsonParse(rawText.slice(arrStart, arrEnd + 1))
  if (!Array.isArray(arr)) return NO_MATCH(rawText)
  const calls: ParsedToolCall[] = []
  for (const entry of arr) {
    if (isObject(entry) && typeof entry.name === 'string') {
      const e = entry as { name: string; arguments?: unknown }
      calls.push({ name: e.name, arguments: asArgsObject(e.arguments) })
    }
  }
  return calls.length > 0
    ? { calls, cleanedText: removeSpans(rawText, [[tokenIdx, arrEnd + 1]]) }
    : NO_MATCH(rawText)
}

/** Default {@link phiToolCallParser}. */
export const defaultPhiToolCallParser = phiToolCallParser

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
  phi: phiToolCallParser,
}

/**
 * The default `'auto'` precedence. Marker-anchored families first (collision-free); the weak-signal
 * pythonic/llama3_json forms run last and are gated on callee∈toolNames.
 */
export const DEFAULT_TOOL_CALL_PARSER_ORDER: ReadonlyArray<
  Exclude<ToolCallParserName, 'auto' | 'none'>
> = ['hermes', 'gemma', 'gpt_oss', 'phi', 'pythonic', 'llama3_json', 'mistral', 'qwen3_coder']
// (phi is marker-anchored on the `functools` token → placed with the other marker families, ahead of
// the weak-signal pythonic/llama3_json forms; the rest keep their original precedence.)

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
