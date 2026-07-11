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
  | 'bare_pythonic'
  | 'loose_keyed'
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

// Anchors locate the call HEAD (`[<|tool_call>] call:NAME`) up to — but not including — the opening
// `{`; the argument block is then BRACE-SCANNED (string-aware, see scanGemmaArgs) rather than matched
// by a flat `\{[^{}]*\}` regex, so a NESTED block survives. A real E4B `provide_answer` emits
// `{answer:<|“|>…<|”|>,sources:[{path:<|“|>…<|”|>,title:…}]}` — nested arrays/objects AND curly smart
// quotes — which the old single-level regex silently dropped (the whole call then leaked as prose).
const GEMMA_WRAP_HEAD = /<\|tool_call>\s*call:\s*([A-Za-z_]\w*)\s*(?=\{)/g
const GEMMA_BARE_HEAD = /call:\s*([A-Za-z_]\w*)\s*(?=\{)/g
// Prefix-LESS bare head: `NAME{` with NO `call:` — a real runtime shape (Gemma E2B/E4B drops the
// `call:` lead entirely, e.g. `say_i_dont_know{reason: "…"}`). Collision-prone (any `word{` in prose
// matches), so this pass is GATED on ctx.toolNames — only an actual offered tool name is accepted.
const GEMMA_NOPREFIX_HEAD = /([A-Za-z_]\w*)\s*(?=\{)/g
const GEMMA_WRAP_TAIL = '<tool_call|>'

// Any double-quote glyph that delimits a Gemma string value: ASCII `"` or the curly pair `“ ”`. The
// runtime emits curly quotes (both as the `<|“|>` delimiter token and bare inside values); a straight
// apostrophe `’` is NOT here — it is a literal inside a value, not a delimiter.
const GEMMA_DQUOTE = /["“”]/

/**
 * Scan a Gemma argument block `{ … }` for the index of its matching `}`, treating string regions as
 * opaque so structural `{ } [ ]` inside a value never unbalance the scan. String state toggles on any
 * {@link GEMMA_DQUOTE} glyph and on a `<|"|>`/`<|“|>`/`<|”|>` delimiter TOKEN (consumed whole). `from`
 * indexes the opening `{`. Returns the matching close index, or -1 if unterminated.
 */
const scanGemmaArgs = (text: string, from: number): number => {
  let depth = 0
  let inStr = false
  for (let i = from; i < text.length; i++) {
    // A quote delimiter — `<|"|>` (5 chars), curly `“`/`”`, or ASCII `"`. Collapse a RUN of consecutive
    // delimiters (e.g. the triple-quote `"""` opener, or a doubled `<|"|><|"|>`) into a SINGLE toggle, so
    // string state stays balanced and the matching `}` is found. Without the run-collapse, `"""` toggles
    // three times → stays "in string" → the scan never balances and the whole call is dropped.
    const delimW = gemmaQuoteDelimiterWidth(text, i)
    if (delimW > 0) {
      let j = i + delimW
      for (
        let w = gemmaQuoteDelimiterWidth(text, j);
        w > 0;
        w = gemmaQuoteDelimiterWidth(text, j)
      ) {
        j += w
      }
      inStr = !inStr
      i = j - 1
      continue
    }
    const ch = text[i]
    if (inStr) continue
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Whether the delimiter token at `block[i]` is a Gemma string-quote delimiter, and how wide it is. A
 * delimiter is either the 5-char `<|"|>` / `<|“|>` / `<|”|>` special-token placeholder the decoder leaks,
 * a bare curly smart quote `“`/`”`, or a plain ASCII `"`. Returns the delimiter width (5, or 1) or 0 if
 * `block[i]` is not a quote delimiter.
 */
const gemmaQuoteDelimiterWidth = (block: string, i: number): number => {
  if (
    block[i] === '<' &&
    block[i + 1] === '|' &&
    GEMMA_DQUOTE.test(block[i + 2] ?? '') &&
    block[i + 3] === '|' &&
    block[i + 4] === '>'
  ) {
    return 5
  }
  const ch = block[i]
  if (ch === '"' || ch === '“' || ch === '”') return 1
  return 0
}

/**
 * Canonicalise the string delimiters in a Gemma arg block to ASCII `"`, tracking string state so a
 * `:` `,` `{` `}` `[` `]` (or a smart quote) appearing INSIDE a value is never treated as structure.
 * Handles the `<|"|>`/`<|“|>`/`<|”|>` delimiter TOKENS and bare curly `“ ”` glyphs (both open and
 * close a string). The straight apostrophe `’` is a literal, not a delimiter. Inside a string, a raw
 * ASCII `"` is escaped to `\"` so the resulting JSON stays valid.
 *
 * A RUN of consecutive quote delimiters (any mix of `"`, curly, `<|"|>`) collapses to a SINGLE toggle —
 * so Gemma's Python-style triple-quote opener `answer:"""…` (and the doubled `<|"|><|"|>` the decoder
 * sometimes emits) becomes one `"` instead of `"""` (which JSON.parse reads as an empty string `""`
 * followed by garbage). Verified against a real E2B `provide_answer{answer:"""# …}` capture that failed
 * to parse and surfaced as `E_LLM_EXECUTION_EXECUTOR_ERROR`.
 */
const canonicaliseGemmaStrings = (block: string): string => {
  let out = ''
  let inStr = false
  for (let i = 0; i < block.length; i++) {
    const delimW = gemmaQuoteDelimiterWidth(block, i)
    if (delimW > 0) {
      // Collapse a run of consecutive quote delimiters (e.g. `"""`, `<|"|><|"|>`) into a single toggle.
      let j = i + delimW
      while (true) {
        const w = gemmaQuoteDelimiterWidth(block, j)
        if (w === 0) break
        j += w
      }
      out += '"'
      inStr = !inStr
      i = j - 1
      continue
    }
    const ch = block[i]
    // Inside a string, escape raw JSON control characters. A real multi-paragraph `answer` value carries
    // literal newlines/tabs, which JSON.parse rejects ("Bad control character in string literal") unless
    // escaped. A lone backslash is also escaped so it cannot accidentally escape the closing quote.
    if (inStr) {
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      if (ch === '\\') {
        out += '\\\\'
        continue
      }
    }
    out += ch
  }
  return out
}

/** A bare scalar token is "already JSON" — a quoted string, a nested `[`/`{` opener, a COMPLETE JSON
 * number, or a literal — and must NOT be re-quoted. Matching a FULL number (not merely a leading digit)
 * is load-bearing: a digit-led non-number like a UUID `1f173d33-…`, a version, or a hash must still be
 * quoted, else the call yields invalid JSON and leaks as prose. */
const isJsonReadyScalar = (v: string): boolean =>
  /^["[{]/.test(v) ||
  /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v) ||
  /^(?:true|false|null)$/.test(v)

/**
 * Quote bare keys (`key:` → `"key":`), bare scalar values (`:Paris` → `:"Paris"`), and bare array
 * ELEMENTS (`[search_docs_semantic]` → `["search_docs_semantic"]`) that the decoder-stripped form leaves
 * unquoted — but ONLY in structural position (outside quoted strings). Operates on a block whose string
 * delimiters are already canonical ASCII `"` (see {@link canonicaliseGemmaStrings}), walking it
 * quote-aware so a `:` `,` or word inside a value is left untouched. Tokens already JSON (quoted,
 * number/sign, true/false/null, or a nested `[`/`{`) pass through.
 */
const quoteBareGemmaTokens = (block: string): string => {
  let out = ''
  let inStr = false
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (ch === '"') {
      inStr = !inStr
      out += ch
      continue
    }
    if (inStr) {
      out += ch
      continue
    }
    // Structural region. Quote a bare key (identifier directly after a `{`/`,`/`[` opener, ws allowed),
    // emitting only the quoted name + ws — the following `:` is left for the next iteration so the value
    // branch below can run on it. `(?=\s*:)` confirms it is a key, not a bare-word value.
    const keyM = /^([A-Za-z_]\w*)(\s*)(?=:)/.exec(block.slice(i))
    if (keyM && /[{,[]\s*$/.test(out)) {
      out += `"${keyM[1]}"${keyM[2]}`
      i += keyM[0].length - 1
      continue
    }
    // Quote a bare scalar value right after a structural ':' — up to the next ',' '}' ']'.
    if (ch === ':') {
      const rest = block.slice(i + 1)
      const valM = /^\s*([^,}\]]+?)\s*(?=[,}\]])/.exec(rest)
      if (valM && !isJsonReadyScalar(valM[1])) {
        out += `:"${valM[1]}"`
        i += 1 + valM[0].length - 1
        continue
      }
    }
    // Quote a bare ARRAY ELEMENT / list member sitting right after a structural `[` or `,` opener
    // (e.g. `tools_to_use:[search_docs_semantic]` or `[a,b]`). The key branch needs a following `:` and
    // the value branch needs a leading `:`, so both miss enum-array elements — the decoder-stripped
    // `make_plan` `tools_to_use:[search_docs_semantic]` stayed unquoted → invalid JSON → the whole
    // planner call failed to parse and leaked as prose. Only fires when `out` ends with a `[`/`,` opener
    // and the element is not already JSON (a nested `{`/`[`, quoted string, number, or literal).
    if (/[[,]\s*$/.test(out)) {
      const elM = /^([^,{}[\]"\s][^,}\]]*?)\s*(?=[,}\]])/.exec(block.slice(i))
      if (elM && !isJsonReadyScalar(elM[1])) {
        out += `"${elM[1]}"`
        i += elM[0].length - 1
        continue
      }
    }
    out += ch
  }
  return out
}

/**
 * Append any `}`/`]` closers the model dropped, so an under-closed JSON object still parses. Walks the
 * already-canonical (ASCII-quoted) text quote-aware, tracks the structural `{`/`[` stack, and emits the
 * matching closers in reverse order. Real Gemma E4B `provide_answer` output omits the OUTER `}` (the
 * `<tool_call|>` wrapper terminator stands in for it: `…}]<tool_call|>` with two `}` opened but one
 * closed) — without this, the unbalanced object is dropped and the whole cited answer leaks as prose.
 *
 * Also closes an UNTERMINATED string: a long `provide_answer` answer that the model truncates mid-value
 * (the output-token cap cuts it, or the stream ends: `{answer:"""# Overview…<cut>`) leaves the string
 * open. Verified live (Gemma-4 E2B): a broad "give me an overview" request whose answer overran the cap
 * produced exactly this shape, which failed JSON.parse → the call was dropped → the turn errored. When the
 * walk ends INSIDE a string, close it (`"`) BEFORE emitting the structural closers, so the (truncated)
 * answer still commits instead of taking the whole turn down.
 */
const closeUnbalancedJson = (jsonish: string): string => {
  const stack: string[] = []
  let inStr = false
  for (let i = 0; i < jsonish.length; i++) {
    const ch = jsonish[i]
    if (ch === '"' && jsonish[i - 1] !== '\\') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let out = jsonish
  // A dangling open string (truncated mid-value) must be closed first, else the appended `}`/`]` land
  // inside the string and JSON.parse still fails.
  if (inStr) out += '"'
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i]
  return out
}

/**
 * Normalise a Gemma KEY-VALUE SEPARATOR `=` to `:` in structural position. Real Gemma E2B/E4B output
 * sometimes assigns a top-level arg with `=` instead of `:` — observed live: `provide_answer{answer="…",
 * sources:[…]}` (the `answer` key used `=`, while `sources`/`path` used `:`). The rest of the block is
 * valid JSON-ish, but the `=` means the key branch in {@link quoteBareGemmaTokens} (which keys on a
 * following `:`) never quotes that key, so the whole object fails to parse and the cited answer leaks as
 * prose. Rewrite only an `identifier=` sitting in KEY position — directly after a `{`/`,`/`[` opener (ws
 * allowed) — to `identifier:`, walking the block quote-aware so an `=` inside a string value (or a
 * Python-ish `k=v` already handled elsewhere) is left untouched. Runs AFTER string canonicalisation (so
 * `inStr` tracking is reliable) and BEFORE bare-token quoting (so the now-`:` key gets quoted normally).
 */
const normaliseGemmaKeySeparators = (block: string): string => {
  let out = ''
  let inStr = false
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (ch === '"') {
      inStr = !inStr
      out += ch
      continue
    }
    if (inStr) {
      out += ch
      continue
    }
    // A bare `identifier` directly after a structural opener, followed by `=`, is a key assigned with the
    // wrong separator. Emit the name + ws + `:` and skip the `=`. `(?=\s*=)`-style intent via an explicit
    // `=` capture; the `out` tail must end with a `{`/`,`/`[` opener (ws allowed) to be a key position.
    const keyEqM = /^([A-Za-z_]\w*)(\s*)=/.exec(block.slice(i))
    if (keyEqM && /[{,[]\s*$/.test(out)) {
      out += `${keyEqM[1]}${keyEqM[2]}:`
      i += keyEqM[0].length - 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * Normalise a Gemma arg block (`{k:<|"|>v<|"|>}`, stripped `{k:v}`, or a nested
 * `{a:<|“|>…<|”|>,b:[{…}]}`) into JSON. Done in quote-aware passes — canonicalise the string delimiters
 * to ASCII `"`, normalise a wrong `=` key separator to `:`, quote the bare keys/scalars that remain,
 * then close any dropped `}`/`]` — so a `:` `,` or word inside a value (e.g. a `“Class: TurnRunner”`
 * title) is never mistaken for structure and a model that omits the outer closer still parses.
 */
const gemmaArgsToJson = (argsBlock: string): unknown => {
  const canonical = canonicaliseGemmaStrings(argsBlock)
  const colonised = normaliseGemmaKeySeparators(canonical)
  const quoted = quoteBareGemmaTokens(colonised)
  const balanced = closeUnbalancedJson(quoted)
  return tryJsonParse(balanced)
}

/** Collect Gemma calls whose heads match `headRe`; brace-scan each arg block. */
const collectGemmaCalls = (
  rawText: string,
  headRe: RegExp,
  wrapped: boolean,
  allowed?: Set<string>
): { calls: ParsedToolCall[]; spans: Array<[number, number]> } => {
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(headRe)) {
    // When gated (the prefix-less pass), only an actual offered tool name may open a call — otherwise
    // any `word{` in prose would false-match.
    if (allowed && !allowed.has(m[1])) continue
    const headStart = m.index ?? 0
    const braceStart = headStart + m[0].length // lookahead leaves m[0] ending right before `{`
    // Find the arg-block boundary. Normally the matching `}`. But the wrapped form's REAL output drops
    // the outer `}` and lets `<tool_call|>` terminate the call (`…}]<tool_call|>`), so the brace scan
    // never balances — when wrapped, fall back to the wrapper tail as the boundary and let
    // gemmaArgsToJson's `closeUnbalancedJson` repair the missing closer.
    let braceEnd = scanGemmaArgs(rawText, braceStart)
    let spanEnd: number
    let blockEnd: number
    if (braceEnd !== -1) {
      blockEnd = braceEnd + 1
      spanEnd = braceEnd + 1
      // Consume a `<tool_call|>` terminator sitting immediately after the close brace — for the WRAPPED
      // form (`<|tool_call>call:…}<tool_call|>`) AND the bare form, since the decoder strips the leading
      // `<|tool_call>` head but the runtime still emits the trailing `<tool_call|>` (`call:NAME{…}<tool_call|>`).
      // Anchored `^\s*` right after the brace, so it can only eat a real adjacent terminator, never prose.
      const tail = new RegExp(
        `^\\s*${GEMMA_WRAP_TAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
      ).exec(rawText.slice(braceEnd + 1))
      if (tail) spanEnd = braceEnd + 1 + tail[0].length
    } else if (wrapped) {
      const tailIdx = rawText.indexOf(GEMMA_WRAP_TAIL, braceStart)
      if (tailIdx !== -1) {
        blockEnd = tailIdx // up to (not including) the `<tool_call|>` terminator
        spanEnd = tailIdx + GEMMA_WRAP_TAIL.length
      } else {
        // TRUNCATION fallback: wrapped head but no matching `}` AND no `<tool_call|>` tail — the call was
        // cut off mid-value (e.g. a long `provide_answer` answer that overran the output-token cap). Take
        // the rest of the string as the block and let gemmaArgsToJson (closeUnbalancedJson) repair the
        // dangling string + missing closers, so the truncated answer still commits instead of the whole
        // call being dropped (which surfaced as a turn-killing error).
        blockEnd = rawText.length
        spanEnd = rawText.length
      }
    } else {
      // Bare/prefix-less head with no matching `}` — same truncation fallback: consume to end and repair.
      blockEnd = rawText.length
      spanEnd = rawText.length
    }
    const parsed = gemmaArgsToJson(rawText.slice(braceStart, blockEnd))
    if (!isObject(parsed)) continue
    calls.push({ name: m[1], arguments: asArgsObject(parsed) })
    spans.push([headStart, spanEnd])
  }
  return { calls, spans }
}

/**
 * Parse Gemma E2B/E4B tool calls. Accepts the wrapped template form
 * (`<|tool_call>call:NAME{k:<|"|>v<|"|>}<tool_call|>`) AND the decoder-stripped runtime form
 * (`call:NAME{k:v}`, special tokens removed, scalars unquoted — the shape a real ONNX run emits),
 * including NESTED argument blocks with curly smart quotes (the form a real E4B `provide_answer`
 * emits: `{answer:<|“|>…<|”|>,sources:[{path:…}]}`), AND the PREFIX-LESS bare form `NAME{…}` with no
 * `call:` lead (e.g. `say_i_dont_know{reason: "…"}` — a real E2B/E4B runtime shape), gated on
 * `ctx.toolNames`. Targets the E2B/E4B form only — Gemma 3 (`tool_code` fences) and FunctionGemma
 * (`<start_function_call>`) are out of scope (use a custom {@link ToolCallParserFn}).
 */
export const gemmaToolCallParser: ToolCallParserFn = (rawText, ctx) => {
  // Prefer the wrapped form (anchored, collision-free); fall back to the bare `call:NAME{` form, then to
  // the prefix-less `NAME{` form — each only if the previous matched nothing (the earlier anchors also
  // appear inside the later shapes, so never run more than one). The prefix-less pass is GATED on
  // ctx.toolNames since `word{` alone is too weak a signal to claim without an allowlist.
  let { calls, spans } = collectGemmaCalls(rawText, GEMMA_WRAP_HEAD, true)
  if (calls.length === 0) {
    ;({ calls, spans } = collectGemmaCalls(rawText, GEMMA_BARE_HEAD, false))
  }
  if (calls.length === 0 && ctx && ctx.toolNames.length > 0) {
    ;({ calls, spans } = collectGemmaCalls(
      rawText,
      GEMMA_NOPREFIX_HEAD,
      false,
      new Set(ctx.toolNames)
    ))
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

// Curly/smart quote pairs small models emit instead of ASCII quotes (e.g. Gemma: “…”, ‘…’).
// Matching them lets us read string literals the model clearly intended as strings.
const SMART_QUOTE_PAIRS: ReadonlyArray<[string, string]> = [
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
]

/**
 * Read a single pythonic literal: quoted string (ASCII or smart quotes), number, True/False/None,
 * or a bracketed list of literals (`[a, b]`). Lists recurse so `sources=[“/a”, “/b”]` parses to a
 * real array. Unrecognised tokens fall through to the raw trimmed string.
 */
const readPythonLiteral = (raw: string): JsonValue => {
  const t = raw.trim()
  // ASCII-quoted string.
  if (/^(['"]).*\1$/s.test(t)) return t.slice(1, -1)
  // Smart/curly-quoted string (small-model output) — strip the matching pair.
  for (const [open, close] of SMART_QUOTE_PAIRS) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) return t.slice(1, -1)
  }
  // List literal: `[x, y, …]` → array of recursively-read literals.
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    if (inner.length === 0) return []
    return splitPythonArgs(inner).map((el) => readPythonLiteral(el))
  }
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

// ─── Bare pythonic: NAME(k=v, …) without the [ ] list wrapper (weak signal — gated on toolNames) ──────

// A bare call: optional leading "/" or "call:" noise, then NAME( … ). Captures name + the paren body.
// Non-global; we scan with a stateful regex below so we can require the callee ∈ toolNames.
const BARE_PYTHONIC_CALL_RE = /(?:^|[\s>/])(?:call:)?\s*([A-Za-z_]\w*)\s*\(([^)]*)\)/g

/**
 * Parse a BARE pythonic call — `provide_answer(answer=“…”, sources=[“/x”])` — i.e. the pythonic
 * `NAME(kwargs)` form WITHOUT the surrounding `[ … ]` list wrapper that {@link pythonicToolCallParser}
 * requires. Small models (observed: Gemma-4 E2B via transformers.js) emit this for a single call,
 * sometimes with a leading `/`, a `call:` prefix, or smart quotes in the args.
 *
 * Because the bare shape is a WEAK signal (it can resemble incidental prose like "see foo(bar)"),
 * this parser is gated HARD: it only claims a call whose callee is a real offered tool
 * (`ctx.toolNames`). That gate is what makes dropping the `[ ]` requirement safe. Runs after the
 * strict bracketed pythonic parser in the `'auto'` order.
 */
export const barePythonicToolCallParser: ToolCallParserFn = (rawText, ctx) => {
  const allowed = new Set(ctx.toolNames)
  if (allowed.size === 0) return NO_MATCH(rawText)
  const calls: ParsedToolCall[] = []
  const spans: Array<[number, number]> = []
  for (const m of rawText.matchAll(BARE_PYTHONIC_CALL_RE)) {
    const name = m[1]
    if (!allowed.has(name)) continue // gate: only real tools — keeps prose from false-positiving
    const args: Record<string, JsonValue> = {}
    for (const pair of splitPythonArgs(m[2])) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      args[pair.slice(0, eq).trim()] = readPythonLiteral(pair.slice(eq + 1))
    }
    calls.push({ name, arguments: args })
    // Span covers just the NAME(...) substring (m[0] may include a leading delimiter char).
    const start = (m.index ?? 0) + m[0].indexOf(name)
    spans.push([start, (m.index ?? 0) + m[0].length])
  }
  if (calls.length === 0) return NO_MATCH(rawText)
  return { calls, cleanedText: removeSpans(rawText, spans) }
}

/** Default {@link barePythonicToolCallParser}. */
export const defaultBarePythonicToolCallParser = barePythonicToolCallParser

// ─── Loose keyed: bare `tool_name` line + `key: value` lines (degenerate small-model form) ────────────

/** Coerce a loose scalar value string into a JSON value (number/bool/null, else the trimmed string). */
const readLooseScalar = (raw: string): JsonValue => {
  const s = raw.trim().replace(/,\s*$/, '')
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  // Strip one layer of surrounding quotes if present.
  const m = /^"([\s\S]*)"$|^'([\s\S]*)'$/.exec(s)
  return m ? (m[1] ?? m[2] ?? '') : s
}

/**
 * Parse the DEGENERATE keyed form a small instruct model emits when it ignores every structured
 * tool-call grammar: the bare tool NAME on its own line, then one or more `argname: value` lines.
 *
 * @remarks
 * Observed verbatim from **Gemma-4 E2B on LiteRT-web** (raw-captured): asked to call an answer tool it
 * emits, with no `call:`/braces/brackets/JSON at all —
 * ```
 * say_i_dont_know
 * reason: The documentation does not contain a definition for that.
 * ```
 * No marker-anchored or pythonic/JSON parser claims this, so the "call" leaks into the visible answer as
 * prose AND the turn looks like a refusal (the tool the model meant to invoke never fires). A 2B can't
 * be reliably *instructed* into a format (changing the prompt's documented format did not change the
 * output), so the robust path is to parse the shape it actually produces.
 *
 * WEAK SIGNAL, gated HARD (like {@link barePythonicToolCallParser}): it only claims when the FIRST
 * non-empty line is EXACTLY a real offered tool name (`ctx.toolNames`) and is followed by at least one
 * `key: value` line. That gate is what keeps it from misreading ordinary prose ("Note: …", a heading
 * with a colon). Single call only (the degenerate form has no list syntax); runs LAST in `'auto'`.
 */
export const looseKeyedToolCallParser: ToolCallParserFn = (rawText, ctx) => {
  const allowed = new Set(ctx.toolNames)
  if (allowed.size === 0) return NO_MATCH(rawText)
  const lines = rawText.split('\n')
  // Find the first non-empty line; it must be EXACTLY a known tool name (after trimming).
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length) return NO_MATCH(rawText)
  const name = lines[i].trim()
  if (!allowed.has(name)) return NO_MATCH(rawText)
  // Collect the trailing `key: value` lines.
  const args: Record<string, JsonValue> = {}
  let j = i + 1
  let lastConsumed = i
  for (; j < lines.length; j++) {
    const line = lines[j]
    if (line.trim() === '') {
      lastConsumed = j
      continue
    }
    const kv = /^\s*([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(line)
    if (!kv) break // a non-keyed line ends the call body
    args[kv[1]] = readLooseScalar(kv[2])
    lastConsumed = j
  }
  if (Object.keys(args).length === 0) return NO_MATCH(rawText) // bare name alone is too weak to claim
  // Consume from the name line through the last keyed line.
  let start = 0
  for (let k = 0; k < i; k++) start += lines[k].length + 1
  let end = start
  for (let k = i; k <= lastConsumed; k++) end += lines[k].length + (k < lines.length - 1 ? 1 : 0)
  return { calls: [{ name, arguments: args }], cleanedText: removeSpans(rawText, [[start, end]]) }
}

/** Default {@link looseKeyedToolCallParser}. */
export const defaultLooseKeyedToolCallParser = looseKeyedToolCallParser

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
  bare_pythonic: barePythonicToolCallParser,
  loose_keyed: looseKeyedToolCallParser,
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
> = [
  'hermes',
  'gemma',
  'gpt_oss',
  'phi',
  'pythonic',
  'bare_pythonic',
  'llama3_json',
  'mistral',
  'qwen3_coder',
  'loose_keyed',
]
// (phi is marker-anchored on the `functools` token → placed with the other marker families, ahead of
// the weak-signal pythonic/llama3_json forms; the rest keep their original precedence. `loose_keyed`
// is the WEAKEST signal — a bare `name`+`key: value` form — so it runs DEAD LAST, only claiming text
// whose first line is exactly an offered tool name.)

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
