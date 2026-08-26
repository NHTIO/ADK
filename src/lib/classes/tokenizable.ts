import { getEncoding } from 'js-tiktoken'
import { validator } from '@nhtio/validation'
import { LlamaTokenizer } from 'llama-tokenizer-js'
import { createException } from '../utils/exceptions'
import { isInstanceOf, isError } from '../utils/guards'
import { ENCODE_METHOD, DECODE_METHOD } from '../utils/encoder_symbols'
import { E_TOKENIZABLE_EVALUATOR_INVALID } from '../exceptions/runtime'
import { currentEstimationWarnEmitter } from '../utils/estimation_context'
import { fromPreTrained as geminiFromPreTrained } from '@lenml/tokenizer-gemini'
import type { Tiktoken } from 'js-tiktoken'
import type { AdkEncodableSnapshot } from './encodable'
import type { DispatchContext } from '../contracts/dispatch_context'

/**
 * A DYNAMIC Tokenizable value: a function evaluated at prompt-ASSEMBLY time with the live dispatch
 * context, so the wrapped content computes itself coherent with the dispatch it ships in (e.g. a
 * citation instruction that adapts to whether the answer tool survived the subtractive-pass shed).
 *
 * @remarks
 * The context is OPTIONAL: the same Tokenizable is also read outside any dispatch (token measurement,
 * serialization, plain string coercion). The evaluator MUST therefore handle `ctx === undefined` and
 * return a string for EVERY input — that no-ctx branch IS its fallback. It must never throw and must
 * never return a non-string; either violation raises {@link @nhtio/adk!E_TOKENIZABLE_EVALUATOR_INVALID}
 * (loud — a mis-authored evaluator must not silently coerce garbage into the prompt). Keep evaluators
 * serializer-friendly (capture only module-level refs or values passed as explicit bindings, NOT live
 * per-turn state) so a dynamic Tokenizable round-trips its evaluator and stays dynamic across encode/decode.
 */
export type TokenizableEvaluator = (ctx?: DispatchContext) => string

/**
 * The set of supported token encoding identifiers.
 *
 * @remarks
 * Each value maps to a specific estimation backend:
 * - `gpt2`, `r50k_base`, `p50k_base`, `p50k_edit`, `cl100k_base`, `o200k_base` — exact counts
 *   via `js-tiktoken` (OpenAI / tiktoken-compatible models).
 * - `gemini` — exact counts via `@lenml/tokenizer-gemini`, which embeds Gemini's actual
 *   SentencePiece vocabulary locally with no API call required.
 * - `gemma` — exact counts for Google's Gemma models (Gemma 2/3/4, incl. the on-device
 *   `.litertlm` / ONNX builds). Backed by the SAME `@lenml/tokenizer-gemini` package, whose bundled
 *   `tokenizer_config.json` declares `"tokenizer_class": "GemmaTokenizer"` over the shared 256k-vocab
 *   SentencePiece tokenizer — Gemini and Gemma share it, and it encodes Gemma's control tokens
 *   (`<start_of_turn>`, `<end_of_turn>`, `<eos>`, …) as single ids. Deliberate reuse, not a proxy: no
 *   extra dependency. Distinct identifier so callers can say what model they mean.
 * - `llama2` — exact counts via `llama-tokenizer-js` (Llama 1 and 2). Llama 3+ uses a
 *   different vocabulary and should use the `llama3` identifier once a suitable sync backend
 *   is available.
 * - `claude` — heuristic approximation using Anthropic's published ~3.5 chars/token ratio.
 *   No local tokenizer is available for Claude 3+ models; the Anthropic SDK's
 *   `messages.countTokens()` API is the only exact path but requires a network call.
 *
 * This array is the CANONICAL, closed set of backends built into core — adding one of these
 * requires editing core (add a case to {@link Tokenizable.estimateTokens}'s internal switch). For
 * every OTHER encoding a battery or consumer wants to measure (a model-specific tokenizer core has
 * no business knowing about), call {@link registerTokenEstimator} instead — no core edit required.
 * See {@link TokenEncodingId} for the widened identifier type that accepts both.
 */
export const TokenEncoding = [
  'gpt2',
  'r50k_base',
  'p50k_base',
  'p50k_edit',
  'cl100k_base',
  'o200k_base',
  'gemini',
  'gemma',
  'llama2',
  'claude',
] as const

/**
 * Union of all recognised token encoding identifier strings.
 *
 * @remarks
 * Derived from {@link TokenEncoding} so the type and the runtime array stay in sync
 * automatically when new encodings are added.
 */
export type TokenEncoding = (typeof TokenEncoding)[number]

/**
 * A recognised token-encoding identifier: one of the closed {@link TokenEncoding} built-ins, OR any
 * other string registered via {@link registerTokenEstimator}.
 *
 * @remarks
 * The `(string & {})` half of the union is a widening trick, not a real intersection — `string & {}`
 * has no members beyond `string`, so it accepts any string value while `TokenEncoding` still
 * contributes its literal members to editor autocomplete (a bare `string` union member would erase
 * that autocomplete entirely, since TypeScript collapses `TokenEncoding | string` to `string`). Use
 * this type wherever an API accepts "a built-in encoding, or a registered custom one" — for example
 * {@link Tokenizable.estimateTokens}'s `encoding` parameter. APIs that only ever accept the CLOSED
 * built-in set (e.g. a battery's `tokenEncoding` validation list) should keep using {@link TokenEncoding}.
 */
export type TokenEncodingId = TokenEncoding | (string & {})

/**
 * A custom token-count function registered for a non-built-in {@link TokenEncodingId} via
 * {@link registerTokenEstimator}.
 *
 * @remarks
 * Synchronous, matching the built-in estimation backends: every backend behind the
 * {@link TokenEncoding} switch (`js-tiktoken`, `@lenml/tokenizer-gemini`, `llama-tokenizer-js`, the
 * Claude heuristic) resolves synchronously, and {@link Tokenizable.estimateTokens} itself returns a
 * plain `number` — not a `Promise<number>`. A custom estimator therefore must not be async either, so
 * a registered encoding stays a drop-in peer of the built-ins (same call shape, no `await` threaded
 * through `estimateTokens` for some encodings and not others). Wrap an inherently-async tokenizer in a
 * synchronous cache (measure ahead of time / memoize a warmed instance) before registering it.
 *
 * @param value - The already-RESOLVED text to count (the same string `countFor` measures for the
 *   built-in backends — i.e. `render(ctx)`'s output, never the raw evaluator or ctx).
 * @returns The estimated token count for `value`.
 */
export type TokenEstimatorFn = (value: string) => number

/**
 * Thrown by {@link registerTokenEstimator} when the given encoding identifier names a built-in
 * {@link TokenEncoding} rather than a genuinely custom one.
 *
 * @remarks
 * The built-in encodings are canonical: `'gemma'`, `'cl100k_base'`, and friends must always resolve
 * to their core backend (`js-tiktoken`, `@lenml/tokenizer-gemini`, `llama-tokenizer-js`, the Claude
 * heuristic), never to a consumer-supplied override. Allowing a shadow registration would let one
 * battery silently change another's token counts for a shared built-in name — a correctness hazard
 * that is cheap to prevent at registration time. Fatal: this is a programming error in the caller
 * (pick a distinct identifier), not a runtime condition to recover from.
 */
export const E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN = createException<[string]>(
  'E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN',
  'Cannot register a token estimator for "%s": it shadows a built-in TokenEncoding. Built-in encodings always resolve to their core backend and cannot be overridden — register a distinct encoding identifier instead.',
  'E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN',
  409,
  true
)

// Custom encodings registered via registerTokenEstimator, consulted AFTER the built-in switch so the
// closed set's fast path (and its degrade-vs-throw contract) is never disturbed by registration.
const customEstimators = new Map<string, TokenEstimatorFn>()

// The built-in identifiers as a Set for O(1) shadow-checks and the isBuiltinEncoding guard below.
const builtinEncodingSet = new Set<string>(TokenEncoding)

/** Narrows a {@link TokenEncodingId} to the closed {@link TokenEncoding} union when it names a built-in. */
const isBuiltinEncoding = (encoding: string): encoding is TokenEncoding =>
  builtinEncodingSet.has(encoding)

/**
 * Register (or replace) a {@link TokenEstimatorFn} for a custom {@link TokenEncodingId}, so
 * {@link Tokenizable.estimateTokens} can measure it without a core code change.
 *
 * @remarks
 * This is the additive escape hatch for the closed {@link TokenEncoding} set. Say a context-management
 * battery needs to measure tokens for a model that core has no built-in backend for — it simply calls
 * this once, at startup, for that model's identifier. From then on the encoding is measurable, with no
 * core code change (a new case in {@link Tokenizable.estimateTokens}'s switch) ever required. Mirrors the
 * {@link @nhtio/adk!registerMediaReaderResolver} / {@link @nhtio/adk!registerSpoolReaderResolver} registry
 * idiom used for reader handles — register a factory once, core (or the primitive) consults it, nobody
 * imports a battery from core.
 *
 * Resolution order inside {@link Tokenizable.estimateTokens}: the built-in switch is tried FIRST (so
 * the closed set's fast path — including its degrade-to-heuristic-on-encoder-failure contract — is
 * completely unaffected by the registry existing), and only an encoding the switch doesn't recognise
 * falls through to this registry.
 *
 * Idempotent-by-overwrite: registering the same `encoding` twice replaces the previous estimator —
 * useful for hot-swapping a warmed tokenizer instance without restarting. Registering a name that
 * shadows a BUILT-IN {@link TokenEncoding} (e.g. `'gemma'`, `'cl100k_base'`) is rejected: the built-ins
 * are canonical and must always resolve to their core backend, never to a consumer override.
 *
 * @param encoding - The custom encoding identifier this estimator handles. Must not be one of the
 *   built-in {@link TokenEncoding} values.
 * @param estimator - The synchronous token-count function to call for `encoding`.
 * @throws {@link @nhtio/adk!E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN} when `encoding` names a built-in.
 */
export function registerTokenEstimator(encoding: string, estimator: TokenEstimatorFn): void {
  if (isBuiltinEncoding(encoding)) {
    throw new E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN([encoding])
  }
  customEstimators.set(encoding, estimator)
}

/**
 * Backing schema for {@link Tokenizable.schema}.
 *
 * @remarks
 * Accepts a plain `string` or an existing {@link Tokenizable} instance. Strings pass through
 * unchanged; {@link Tokenizable} instances are accepted via {@link Tokenizable.isTokenizable}
 * to remain cross-realm safe.
 */
const stringOrTokenizableSchema = validator.alternatives(
  validator.string(),
  validator.custom((value, helpers) => {
    if (Tokenizable.isTokenizable(value)) {
      return value
    }
    return helpers.error('any.invalid')
  })
)

/**
 * Backing schema for {@link Tokenizable.emptyableSchema}.
 *
 * @remarks
 * Identical to {@link stringOrTokenizableSchema} except that the EMPTY string is accepted. Joi
 * strings disallow `''` by default, so the strict fragment rejects it while a `new Tokenizable('')`
 * instance sails through the custom branch — an inconsistency that only shows up once a caller
 * legitimately has nothing to put in the field.
 *
 * Deliberately a SEPARATE fragment rather than relaxing the strict one: `Tokenizable.schema` also
 * backs `systemPrompt`, `standingInstructions`, `Identity.representation`, and `Memory.content`,
 * where an empty value is meaningless and should stay a validation error. Opt in per-field.
 */
const emptyableStringOrTokenizableSchema = validator.alternatives(
  validator.string().allow(''),
  validator.custom((value, helpers) => {
    if (Tokenizable.isTokenizable(value)) {
      return value
    }
    return helpers.error('any.invalid')
  })
)

// Lazily-initialised singletons — tokenizers are expensive to load so we defer
// until first use and reuse across all Tokenizable instances thereafter.
let geminiTokenizerInstance: ReturnType<typeof geminiFromPreTrained> | undefined
let llamaTokenizerInstance: InstanceType<typeof LlamaTokenizer> | undefined

// js-tiktoken's `getEncoding` has no internal cache — each call does `new Tiktoken(<ranks>)`,
// parsing the full BPE rank table (~800ms for o200k_base). Building the encoder dwarfs the
// subsequent `encode()` (~0.6ms) by ~1000×, so a fresh encoder per `estimateTokens` call turns
// repeated counting (e.g. re-measuring an accumulating dispatch context every iteration) into
// O(iterations) encoder rebuilds that monopolise a single-threaded host. Cache the encoder per
// encoding, mirroring the Gemini/Llama singletons above — Tiktoken instances are stateless and
// safe to reuse across all Tokenizable instances.
const tiktokenEncoderInstances = new Map<TokenEncoding, Tiktoken>()

const getGeminiTokenizer = () => {
  if (!geminiTokenizerInstance) {
    geminiTokenizerInstance = geminiFromPreTrained()
  }
  return geminiTokenizerInstance
}

const getLlamaTokenizer = () => {
  if (!llamaTokenizerInstance) {
    llamaTokenizerInstance = new LlamaTokenizer()
  }
  return llamaTokenizerInstance
}

const getTiktokenEncoder = (encoding: TokenEncoding): Tiktoken => {
  let enc = tiktokenEncoderInstances.get(encoding)
  if (!enc) {
    enc = getEncoding(encoding as any)
    tiktokenEncoderInstances.set(encoding, enc)
  }
  return enc
}

/**
 * A mutable string with a built-in token counter.
 *
 * @remarks
 * The wrapped string can be read via the standard coercion protocol and updated at any time via
 * {@link Tokenizable.set}. Token counts are computed lazily on first access per encoding and
 * cached until the value changes, avoiding redundant encoder invocations when the same content
 * is measured multiple times across a pipeline.
 *
 * Estimation is dispatched by encoding identifier — see {@link TokenEncoding} for the full list of
 * built-in backends and their accuracy characteristics, and {@link registerTokenEstimator} for adding
 * more without a core change. An encoding that is neither a built-in nor registered resolves to
 * `undefined` (see {@link Tokenizable.estimateTokens}) — this pre-dates the registry and is unchanged
 * by it. Separately, a built-in encoder that THROWS while measuring (as opposed to an unrecognised
 * name) degrades to a `ceil(length / 3.5)` character heuristic inside a runner execution — see
 * `degradeOrThrow` and `utils/estimation_context`.
 *
 * The class implements the standard JS value-coercion protocol (`toString`, `valueOf`,
 * `toJSON`, `toLocaleString`, `Symbol.for('nodejs.util.inspect.custom')`) so instances behave
 * transparently as strings in most contexts.
 */
export class Tokenizable {
  /** The set of supported token-encoding identifiers, re-exposed as a static for convenience. */
  public static TokenEncoding = TokenEncoding

  /**
   * Validator schema that accepts a plain `string` or a {@link Tokenizable} instance.
   *
   * @remarks
   * Reusable fragment for any schema that wants to accept either form — for example,
   * `systemPrompt` and each item in `standingInstructions` in `turnContextSchema`.
   */
  public static schema = stringOrTokenizableSchema

  /**
   * Variant of {@link Tokenizable.schema} that additionally accepts the EMPTY string.
   *
   * @remarks
   * For fields where "present but empty" is a legitimate state rather than a mistake — e.g.
   * {@link @nhtio/adk!Thought.content} in opaque-replay mode, where the meaning lives in the vendor
   * `payload` and the prose is only kept for token-accounting and observer inspection.
   *
   * Do NOT reach for this by default. {@link Tokenizable.schema} stays strict precisely because an
   * empty system prompt or a blank standing instruction is a bug worth failing on.
   */
  public static emptyableSchema = emptyableStringOrTokenizableSchema

  declare toJSON: () => string
  declare toString: () => string
  declare valueOf: () => string
  declare toLocaleString: () => string
  /** Replace the wrapped value (string or evaluator) and invalidate the cached token estimates. */
  declare set: (value: string | TokenizableEvaluator) => void
  /**
   * Resolve the wrapped content against an OPTIONAL dispatch context and return the string. For a static
   * value the context is ignored. For a dynamic (evaluatable) value the evaluator is invoked with `ctx`
   * ({@link TokenizableEvaluator}); assembly passes the live context so the content matches the dispatch
   * it ships in, while a no-context call returns the evaluator's `undefined`-branch fallback.
   */
  /** Whether the current wrapped value is evaluator-backed rather than a static string. */
  declare readonly dynamic: boolean
  /** Resolve the value against an optional dispatch context. */
  declare render: (ctx?: DispatchContext) => string
  /**
   * Estimate the token count under the given {@link TokenEncodingId} of the string this Tokenizable
   * resolves to for the OPTIONAL context — i.e. of `render(ctx)`. Passing the same `ctx` assembly uses
   * keeps the budget count honest for dynamic content (it measures exactly what will ship). Accepts
   * both a built-in {@link TokenEncoding} and any encoding registered via {@link registerTokenEstimator}.
   */
  declare estimateTokens: (encoding: TokenEncodingId, ctx?: DispatchContext) => number

  // Exactly one of these is set. A static value keeps `#value`; a dynamic value keeps `#evaluator`
  // (and `#value` stays the empty string, never read on the dynamic path).
  #value: string
  #evaluator: TokenizableEvaluator | undefined
  // Per-encoding cache for the STATIC string and the no-ctx (fallback) resolution — both stable.
  #cache: Map<TokenEncodingId, number> = new Map()
  // Per-context cache for DYNAMIC + ctx resolutions: WeakMap<ctxObject, Map<encoding, count>>. A dynamic
  // value resolves differently per ctx, so a single number can't be cached; keying by the ctx object
  // reuses the count across the several measures of one dispatch (subtractive pass + overflow guard) and
  // auto-frees when the ctx is garbage-collected. (Same ctx object ⇒ same resolved string within a
  // dispatch, since the evaluator is a pure read of that ctx's state.)
  #ctxCache: WeakMap<object, Map<TokenEncodingId, number>> = new WeakMap()

  /**
   * @param value - The initial value to wrap: a plain `string` (static) or a {@link TokenizableEvaluator}
   *   evaluated at assembly time (dynamic).
   */
  constructor(value: string | TokenizableEvaluator) {
    const isFn = typeof value === 'function'
    this.#evaluator = isFn ? (value as TokenizableEvaluator) : undefined
    this.#value = isFn ? '' : (value as string)

    // Resolve the wrapped content to a string for an OPTIONAL context. Static → the stored string.
    // Dynamic → invoke the evaluator; a throw OR a non-string return is a programmer bug → raise
    // E_TOKENIZABLE_EVALUATOR_INVALID (loud, no silent coercion, no degrade). The evaluator's own
    // `ctx === undefined` branch is the only sanctioned fallback and must itself return a string.
    const resolve = (ctx?: DispatchContext): string => {
      const fn = this.#evaluator
      if (!fn) return this.#value
      let result: string
      try {
        result = fn(ctx)
      } catch (err) {
        throw new E_TOKENIZABLE_EVALUATOR_INVALID(['the evaluator threw'], {
          cause: isError(err) ? err : new Error(String(err)),
        })
      }
      if (typeof result !== 'string') {
        throw new E_TOKENIZABLE_EVALUATOR_INVALID([`returned a non-string (${typeof result})`])
      }
      return result
    }

    // Raw, dependency-free token estimate (~3.5 chars/token) of the RESOLVED text. No encoder, no
    // special-token rules, effectively cannot throw — the guesstimate a real tokenizer degrades TO.
    const estimateTokensRaw = (text: string): number => Math.ceil(text.length / 3.5)

    // Shared failure policy for the real tokenizers, enforcing the degrade-vs-throw CONTRACT:
    //   - inside a TurnRunner run / DispatchRunner dispatch (an estimation warn-sink is on the ambient
    //     stack) → emit a `warning` and DEGRADE to the raw guesstimate, so a token-estimation failure
    //     NEVER kills the turn/dispatch;
    //   - outside any runner (no sink) → RE-THROW, because a genuine encoder failure in non-runner code is
    //     a real bug that must surface (loud), not be silently papered over.
    // This replaces the former `catch → Number.POSITIVE_INFINITY`, which — with the armed overflow guards —
    // made `Infinity > contextWindow` spuriously trip `E_*_CONTEXT_OVERFLOW` on, e.g., text containing a
    // special token. See utils/estimation_context.
    const degradeOrThrow = (encoding: TokenEncoding, text: string, error: unknown): number => {
      const emit = currentEstimationWarnEmitter()
      if (!emit) throw error
      emit({ encoding, error, textPreview: text.slice(0, 80) })
      return estimateTokensRaw(text)
    }

    const estimateTokensWithTiktoken = (encoding: TokenEncoding, text: string): number => {
      try {
        const enc: Tiktoken = getTiktokenEncoder(encoding)
        // `encode(text, allowedSpecial, disallowedSpecial)`. js-tiktoken DEFAULTS `disallowedSpecial` to
        // "all", so any registered special-token substring in the text (e.g. a doc that mentions
        // `<|endoftext|>`, or model output echoing `<|im_start|>`) makes `encode` THROW
        // ("The text contains a special token that is not allowed"). We are ESTIMATING a token count, not
        // round-tripping through the model, so a special-token literal must be counted as ordinary text,
        // never rejected. Pass `disallowedSpecial: []` to disable the guard: specials are BPE-encoded as
        // plain text. Any OTHER encoder failure follows the degrade-vs-throw contract (degradeOrThrow).
        return enc.encode(text, [], []).length
      } catch (err) {
        return degradeOrThrow(encoding, text, err)
      }
    }

    const estimateTokensWithGemini = (text: string): number => {
      try {
        return getGeminiTokenizer().encode(text).length
      } catch (err) {
        return degradeOrThrow('gemini', text, err)
      }
    }

    // Gemma reuses the very same tokenizer: `@lenml/tokenizer-gemini` bundles the shared 256k-vocab
    // SentencePiece tokenizer whose config is `"tokenizer_class": "GemmaTokenizer"`. Kept as its own
    // function (rather than folding 'gemma' into the gemini case) so the intent is explicit and a future
    // swap to a dedicated Gemma package is a one-line change here.
    const estimateTokensWithGemma = (text: string): number => {
      try {
        return getGeminiTokenizer().encode(text).length
      } catch (err) {
        return degradeOrThrow('gemma', text, err)
      }
    }

    const estimateTokensWithLlama2 = (text: string): number => {
      try {
        return getLlamaTokenizer().encode(text, false).length
      } catch (err) {
        return degradeOrThrow('llama2', text, err)
      }
    }

    const estimateTokensWithClaudeHeuristic = (text: string): number => estimateTokensRaw(text)

    // Count tokens of an already-RESOLVED string under one of the CLOSED built-in encodings (the
    // switch shared by all built-in callers). Unchanged fast path — `countFor` below only reaches this
    // once it has already narrowed `encoding` to a real {@link TokenEncoding} member.
    const countForBuiltin = (encoding: TokenEncoding, text: string): number => {
      switch (encoding) {
        case 'gpt2':
        case 'r50k_base':
        case 'p50k_base':
        case 'p50k_edit':
        case 'cl100k_base':
        case 'o200k_base':
          return estimateTokensWithTiktoken(encoding, text)
        case 'gemini':
          return estimateTokensWithGemini(text)
        case 'gemma':
          return estimateTokensWithGemma(text)
        case 'llama2':
          return estimateTokensWithLlama2(text)
        case 'claude':
          return estimateTokensWithClaudeHeuristic(text)
      }
    }

    // Count tokens of an already-RESOLVED string under any recognised {@link TokenEncodingId}.
    // Resolution order: (1) the built-in switch — completely unchanged, so the closed set's fast path
    // and degrade-vs-throw contract are untouched by the registry existing; (2) the custom-estimator
    // registry, for anything {@link registerTokenEstimator} has registered; (3) the pre-existing
    // failure path for a truly unrecognised encoding (falls through with no return, same as before the
    // registry was added — callers relying on that behaviour see no change).
    const countFor = (encoding: TokenEncodingId, text: string): number => {
      if (isBuiltinEncoding(encoding)) {
        return countForBuiltin(encoding, text)
      }
      const custom = customEstimators.get(encoding)
      if (custom) {
        return custom(text)
      }
      // Unrecognised AND unregistered: same silent `undefined` this returned before the registry
      // existed (verified against the pre-registry runtime behaviour — see the class-level remarks).
      // The `number` return type is kept as-is (unchanged public contract); this cast documents the
      // one deliberate escape from it, exactly as narrow as it was previously.
      return undefined as unknown as number
    }

    // The standard coercion protocol takes NO argument, so it resolves with no context → the static
    // string, or (dynamic) the evaluator's `undefined`-branch fallback. `render(ctx)` is the explicit,
    // context-aware read that prompt assembly uses.
    const coerce = (): string => resolve(undefined)

    Object.defineProperties(this, {
      toJSON: {
        value: coerce,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      toString: {
        value: coerce,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      valueOf: {
        value: coerce,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      toLocaleString: {
        value: coerce,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      [Symbol.for('nodejs.util.inspect.custom')]: {
        value: coerce,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      dynamic: {
        get: () => this.#evaluator !== undefined,
        enumerable: true,
        configurable: false,
      },
      render: {
        value: (ctx?: DispatchContext): string => resolve(ctx),
        enumerable: false,
        configurable: false,
        writable: false,
      },
      set: {
        value: (next: string | TokenizableEvaluator) => {
          const nextIsFn = typeof next === 'function'
          this.#evaluator = nextIsFn ? (next as TokenizableEvaluator) : undefined
          this.#value = nextIsFn ? '' : (next as string)
          this.#cache.clear()
          this.#ctxCache = new WeakMap()
        },
        enumerable: false,
        configurable: false,
        writable: false,
      },
      estimateTokens: {
        value: (encoding: TokenEncodingId, ctx?: DispatchContext): number => {
          // Cache selection: a STATIC value (or a no-ctx resolution — the stable fallback) uses the
          // per-encoding Map; a DYNAMIC value WITH a ctx uses the per-ctx WeakMap (the resolved string
          // varies by ctx, so a single number can't be shared). `ctx === undefined` always hits the
          // stable per-encoding cache regardless of static/dynamic.
          const useCtxCache = this.#evaluator !== undefined && ctx !== undefined
          if (useCtxCache) {
            let m = this.#ctxCache.get(ctx as unknown as object)
            if (m?.has(encoding)) return m.get(encoding)!
            const text = resolve(ctx)
            const est = countFor(encoding, text)
            if (!m) {
              m = new Map()
              this.#ctxCache.set(ctx as unknown as object, m)
            }
            m.set(encoding, est)
            return est
          }
          if (this.#cache.has(encoding)) {
            return this.#cache.get(encoding)!
          }
          const text = resolve(undefined)
          const estimate = countFor(encoding, text)
          this.#cache.set(encoding, estimate)
          return estimate
        },
        enumerable: false,
        configurable: false,
        writable: false,
      },
    })
  }

  /**
   * Convenience overload for one-off token counting without managing a {@link Tokenizable} instance.
   *
   * @remarks
   * Creates a temporary instance and immediately discards it — no caching benefit. Use the
   * instance method when you need to count the same value under multiple encodings or when the
   * value may change over time.
   *
   * @param value - The string (or {@link TokenizableEvaluator}) to count tokens for.
   * @param encoding - The encoding identifier to use for counting — a built-in {@link TokenEncoding} or
   *   any encoding registered via {@link registerTokenEstimator}.
   * @param ctx - Optional dispatch context; for a dynamic value it selects which resolved string is
   *   counted (so the count matches what assembly ships). Ignored for a static string.
   * @returns The estimated number of tokens.
   */
  public static estimateTokens(
    value: string | TokenizableEvaluator,
    encoding: TokenEncodingId,
    ctx?: DispatchContext
  ): number {
    const temp = new Tokenizable(value)
    return temp.estimateTokens(encoding, ctx)
  }

  /**
   * Returns `true` if `value` is a {@link Tokenizable} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
   * created in a different module copy or VM context.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Tokenizable} instance.
   */
  public static isTokenizable(value: unknown): value is Tokenizable {
    return isInstanceOf(value, 'Tokenizable', Tokenizable)
  }

  /**
   * Serialise this Tokenizable into an `@nhtio/encoder` snapshot.
   *
   * @remarks
   * The wrapped VALUE is the entire state; the token-count caches are derived and deliberately not encoded
   * (they rebuild lazily after decode). For a STATIC value the snapshot is the string. For a DYNAMIC value
   * the snapshot is the EVALUATOR FUNCTION itself — `@nhtio/encoder` serialises functions (source +
   * explicit bindings), so a dynamic Tokenizable round-trips its evaluator and stays dynamic, re-evaluating
   * live on the next assembly (it does NOT downgrade to a frozen string). Evaluators must therefore stay
   * serializer-friendly: capture only module-level refs / explicit bindings, not live per-turn state.
   * Round-trips via {@link Tokenizable.[DECODE_METHOD]}.
   *
   * @returns The wrapped string, or the evaluator function for a dynamic value.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return this.#evaluator ?? this.#value
  }

  /**
   * Reconstruct a {@link Tokenizable} from an {@link Tokenizable.[ENCODE_METHOD]} snapshot.
   *
   * @param data - The wrapped string (static) or evaluator function (dynamic) produced by
   *   {@link Tokenizable.[ENCODE_METHOD]}.
   * @returns A fresh {@link Tokenizable} over the same value.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): Tokenizable {
    return new Tokenizable(data as string | TokenizableEvaluator)
  }
}

/**
 * Returns `true` if `value` is a {@link Tokenizable} instance.
 *
 * @remarks
 * Module-level convenience alias for {@link Tokenizable.isTokenizable}. Prefer this form when
 * you need a standalone type guard without importing the full class.
 *
 * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety — `instanceof` would fail for instances
 * created in a different module copy or VM context.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a {@link Tokenizable} instance.
 */
export const isTokenizable = (value: unknown): value is Tokenizable => {
  return isInstanceOf(value, 'Tokenizable', Tokenizable)
}
