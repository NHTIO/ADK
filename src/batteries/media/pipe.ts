/**
 * The pipe-expression front-end: a moo lexer plus a hand-rolled recursive-descent parser that
 * compiles `select pages=2-5 | redact match=/…/ | convert to=pdf` into a {@link MediaPlan}.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. The grammar is frozen in the
 * design doc (section 0):
 *
 * - `pipeline := segment ('|' segment)*` ; `segment := verb arg*` ; `arg := IDENT '=' value` —
 *   named args only, no positionals (an IDENT followed by `=` is an arg; otherwise it is the
 *   verb's second word — 2-token lookahead, no verb table needed at parse time).
 * - Verb matching is separator-insensitive (`extract_text` ≡ `extract text` ≡ `extract.text`).
 * - Values: bareword idents, ints/floats, `a-b` ranges, comma lists, `true`/`false`, quoted
 *   strings (single or double), class-aware `/regex/flags` literals, `@id` media refs, and
 *   quoted-JSON structured payloads (a quoted string that the verb's arg schema declares as
 *   `json` is JSON-parsed).
 * - `#` line comments are tolerated (models add them; ignoring them is free robustness).
 * - Two error layers: syntactic ({@link E_MEDIA_PIPE_SYNTAX}, with line/col and a corrective
 *   exemplar) and semantic ({@link E_MEDIA_UNKNOWN_VERB} etc., produced by the validator in
 *   `validate.ts` — this module only parses to a raw AST and lowers to the plan).
 *
 * Parsing is deployment-independent: the full verb table drives folding, and engine narrowing
 * happens later in validation (frozen 0.3).
 */

import { foldVerb } from './verbs'
import { default as moo } from 'moo'
import { canonicalFlags } from './plan'
import { E_MEDIA_PIPE_SYNTAX } from './exceptions'
import { isError, isObject } from '@nhtio/adk/guards'
import type { MediaPlan, MediaStep, MediaArgValue, MediaArgScalar, SourceSpan } from './plan'

// ── lexer ────────────────────────────────────────────────────────────────────

/**
 * The moo ruleset. Order matters: first match wins, so `range` must precede `int`, `float`
 * precedes `int`, and `comment` precedes nothing it could shadow. String/regex bodies exclude
 * raw newlines (escape them); `ws` carries `lineBreaks` so spans stay accurate across lines.
 */
const lexer = moo.compile({
  ws: { match: /[ \t\r\n]+/, lineBreaks: true },
  comment: /#[^\n]*/,
  pipe: '|',
  eq: '=',
  comma: ',',
  ref: /@[A-Za-z0-9_-]+/,
  regex: /\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])+\/[a-z]*/,
  dstring: /"(?:\\.|[^"\\\n])*"/,
  sstring: /'(?:\\.|[^'\\\n])*'/,
  range: /\d+-\d+/,
  float: /\d+\.\d+/,
  int: /\d+/,
  ident: /[A-Za-z_][A-Za-z0-9_.]*/,
  dash: '-',
})

interface Tok {
  type: string
  value: string
  text: string
  offset: number
  line: number
  col: number
}

/** Tokenize, skipping ws/comments, surfacing lexer errors as syntax exceptions. */
const tokenize = (input: string): Tok[] => {
  lexer.reset(input)
  const out: Tok[] = []
  let tok: moo.Token | undefined
  try {
    while ((tok = lexer.next())) {
      if (tok.type === 'ws' || tok.type === 'comment') continue
      out.push({
        type: tok.type as string,
        value: tok.value,
        text: tok.text,
        offset: tok.offset,
        line: tok.line,
        col: tok.col,
      })
    }
  } catch (err) {
    const detail = isError(err) ? err.message.split('\n')[0] : String(err)
    throw new E_MEDIA_PIPE_SYNTAX([
      `${detail}. Values containing special characters must be quoted — write it like: name="my-value"`,
    ])
  }
  return out
}

// ── parser ───────────────────────────────────────────────────────────────────

/** A parsed-but-unvalidated arg value, before the verb's arg schema refines it. */
export interface RawArgValue {
  /** The lowered value. Quoted strings stay strings here; schema may JSON-parse `json` args. */
  value: MediaArgValue
  /** Whether the source token was a quoted string (drives json-arg parsing + name/index rules). */
  quoted: boolean
  /** Source position of the value token. */
  span: SourceSpan
}

/** One parsed segment: verb words plus named args, all position-bearing. */
export interface RawSegment {
  /** Canonical verb id when fold-matching succeeded, else the raw folded text. */
  verb: string
  /** Whether `verb` resolved against the verb table. */
  known: boolean
  /** The parsed named args, in source order. */
  args: Map<string, RawArgValue>
  /** Source position of the verb token(s). */
  span: SourceSpan
}

const spanOf = (tok: Tok, length?: number): SourceSpan => ({
  offset: tok.offset,
  line: tok.line,
  col: tok.col,
  length: length ?? tok.text.length,
})

const unquote = (raw: string): string =>
  raw
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\(["'\\/])/g, '$1')

const fail = (tok: Tok | undefined, message: string, exemplar: string): never => {
  const where = tok ? ` at line ${tok.line}, col ${tok.col}` : ' at end of input'
  throw new E_MEDIA_PIPE_SYNTAX([`${message}${where}. Write it like: ${exemplar}`])
}

class Parser {
  #toks: Tok[]
  #pos = 0

  constructor(toks: Tok[]) {
    this.#toks = toks
  }

  #peek(ahead = 0): Tok | undefined {
    return this.#toks[this.#pos + ahead]
  }

  #next(): Tok | undefined {
    return this.#toks[this.#pos++]
  }

  parsePipeline(): RawSegment[] {
    const segments: RawSegment[] = []
    if (this.#toks.length === 0) {
      fail(undefined, 'empty pipe expression', 'extract text | chunk by=sentence')
    }
    segments.push(this.#parseSegment())
    while (this.#peek()?.type === 'pipe') {
      this.#next()
      segments.push(this.#parseSegment())
    }
    const trailing = this.#peek()
    if (trailing) {
      fail(
        trailing,
        `unexpected "${trailing.text}" after a complete segment`,
        'segment | segment (segments are separated by |)'
      )
    }
    return segments
  }

  #parseSegment(): RawSegment {
    const first = this.#peek()
    if (!first || first.type !== 'ident') {
      fail(first, 'expected a verb to start the segment', 'convert to=pdf')
    }
    const head = this.#next() as Tok
    // Verb words: idents NOT followed by `=` (named-args-only makes this unambiguous), up to
    // the longest canonical verb (3 words, e.g. `sheet update cells`). When the greedy
    // collection over-reaches, back off to the longest prefix that fold-matches and rewind so
    // the leftover bareword surfaces as the args-must-be-named error. The fold uses the FULL
    // static verb table — deployment-independent (engine narrowing is a later validation pass).
    const collected = [head.value]
    const posAfterWord: number[] = [this.#pos]
    while (collected.length < 3) {
      const next = this.#peek()
      if (next?.type !== 'ident' || this.#peek(1)?.type === 'eq') break
      collected.push((this.#next() as Tok).value)
      posAfterWord.push(this.#pos)
    }
    let take = collected.length
    if (foldVerb(collected) === undefined) {
      // Back off to the longest prefix that folds; if none folds at any length, keep the full
      // sequence as the unknown verb so did-you-mean sees the model's whole attempt.
      let prefix = collected.length - 1
      while (prefix >= 1 && foldVerb(collected.slice(0, prefix)) === undefined) prefix -= 1
      if (prefix >= 1) take = prefix
    }
    const words = collected.slice(0, take)
    this.#pos = posAfterWord[take - 1]
    const folded = foldVerb(words)
    const verbText = words.join(' ')
    const args = new Map<string, RawArgValue>()
    for (;;) {
      const tok = this.#peek()
      if (!tok || tok.type === 'pipe') break
      if (tok.type === 'dash') {
        fail(
          tok,
          'unexpected "-" — values containing dashes must be quoted',
          `${verbText} name="value-with-dashes"`
        )
      }
      if (tok.type !== 'ident' || this.#peek(1)?.type !== 'eq') {
        fail(tok, `unexpected "${tok.text}" — args must be name=value`, `${verbText} name=value`)
      }
      const name = (this.#next() as Tok).value
      this.#next() // eq
      const value = this.#parseValue(verbText, name)
      if (args.has(name)) {
        fail(tok, `duplicate arg "${name}"`, `${verbText} ${name}=value (give each arg once)`)
      }
      args.set(name, value)
    }
    return {
      verb: folded ?? verbText,
      known: folded !== undefined,
      args,
      span: spanOf(head, verbText.length),
    }
  }

  #parseValue(verbText: string, argName: string): RawArgValue {
    const first = this.#parseScalar(verbText, argName)
    if (this.#peek()?.type !== 'comma') return first
    const items: MediaArgScalar[] = [...asScalarList(first, verbText, argName)]
    let quoted = first.quoted
    while (this.#peek()?.type === 'comma') {
      this.#next()
      const next = this.#parseScalar(verbText, argName)
      quoted = quoted || next.quoted
      items.push(...asScalarList(next, verbText, argName))
    }
    return { value: items, quoted, span: first.span }
  }

  #parseScalar(verbText: string, argName: string): RawArgValue {
    const tok = this.#peek()
    if (!tok) {
      fail(tok, `missing value for "${argName}"`, `${verbText} ${argName}=value`)
    }
    const t = tok as Tok
    switch (t.type) {
      case 'int':
        this.#next()
        return { value: Number(t.value), quoted: false, span: spanOf(t) }
      case 'float':
        this.#next()
        return { value: Number(t.value), quoted: false, span: spanOf(t) }
      case 'range': {
        this.#next()
        const [lo, hi] = t.value.split('-').map(Number)
        if (lo > hi) {
          fail(t, `range ${t.value} is descending (start must be ≤ end)`, `${argName}=${hi}-${lo}`)
        }
        const nums: number[] = []
        for (let n = lo; n <= hi; n++) nums.push(n)
        return { value: nums, quoted: false, span: spanOf(t) }
      }
      case 'ident': {
        this.#next()
        if (t.value === 'true') return { value: true, quoted: false, span: spanOf(t) }
        if (t.value === 'false') return { value: false, quoted: false, span: spanOf(t) }
        return { value: t.value, quoted: false, span: spanOf(t) }
      }
      case 'dstring':
      case 'sstring':
        this.#next()
        return { value: unquote(t.text), quoted: true, span: spanOf(t) }
      case 'regex': {
        this.#next()
        const lastSlash = t.text.lastIndexOf('/')
        const source = t.text.slice(1, lastSlash)
        const flags = canonicalFlags(t.text.slice(lastSlash + 1))
        try {
          // Validate the pattern compiles; the IR stores the serializable ref.
          void new RegExp(source, flags)
        } catch (err) {
          const detail = isError(err) ? err.message : String(err)
          fail(t, `invalid regex ${t.text}: ${detail}`, `${argName}=/pattern/flags`)
        }
        return { value: { source, flags }, quoted: false, span: spanOf(t) }
      }
      case 'ref':
        this.#next()
        return {
          value: { kind: 'id', id: t.value.slice(1) },
          quoted: false,
          span: spanOf(t),
        }
      case 'dash':
        fail(
          t,
          'unexpected "-" in a bare value',
          `${argName}="value-with-dashes" (quote values containing dashes)`
        )
        break
      default:
        fail(t, `unexpected "${t.text}"`, `${verbText} ${argName}=value`)
    }
    /* unreachable */
    throw new E_MEDIA_PIPE_SYNTAX(['internal parser error'])
  }
}

const asScalarList = (raw: RawArgValue, verbText: string, argName: string): MediaArgScalar[] => {
  if (Array.isArray(raw.value)) return raw.value as MediaArgScalar[]
  if (raw.value === null || typeof raw.value === 'object') {
    const v = raw.value as MediaArgValue
    if (isObject(v) && !Array.isArray(v) && !('source' in v) && !('kind' in v)) {
      throw new E_MEDIA_PIPE_SYNTAX([
        `structured values cannot appear in a comma list for "${argName}" on "${verbText}"`,
      ])
    }
  }
  return [raw.value as MediaArgScalar]
}

// ── public surface ───────────────────────────────────────────────────────────

/**
 * Parse a pipe expression into raw, position-bearing segments.
 *
 * @remarks
 * Purely syntactic — verbs are fold-matched against the full verb table for canonicalization
 * but unknown verbs are NOT an error here (the validator reports them with did-you-mean and the
 * deployment's narrowed verb list). Use {@link parsePipe} for the validated path.
 *
 * @param input - The pipe expression.
 * @returns The raw segments.
 */
export const parsePipeRaw = (input: string): RawSegment[] => {
  return new Parser(tokenize(input)).parsePipeline()
}

/**
 * Lower raw segments to an (unvalidated) {@link MediaPlan}. Quoted-JSON arg parsing and
 * type/enum checks happen in the validator, which consumes the raw segments — this lowering
 * exists for tooling that wants the structural plan without validation.
 *
 * @param segments - Output of {@link parsePipeRaw}.
 * @returns The structural plan (args carried as parsed, json args still strings).
 */
export const lowerSegments = (segments: RawSegment[]): MediaPlan => ({
  steps: segments.map(
    (seg): MediaStep => ({
      verb: seg.verb,
      args: Object.fromEntries(Array.from(seg.args.entries(), ([k, v]) => [k, v.value])),
      span: seg.span,
    })
  ),
})
