import { getEncoding } from 'js-tiktoken'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '../utils/guards'
import { LlamaTokenizer } from 'llama-tokenizer-js'
import { fromPreTrained as geminiFromPreTrained } from '@lenml/tokenizer-gemini'
import type { Tiktoken } from 'js-tiktoken'

/**
 * The set of supported token encoding identifiers.
 *
 * @remarks
 * Each value maps to a specific estimation backend:
 * - `gpt2`, `r50k_base`, `p50k_base`, `p50k_edit`, `cl100k_base`, `o200k_base` — exact counts
 *   via `js-tiktoken` (OpenAI / tiktoken-compatible models).
 * - `gemini` — exact counts via `@lenml/tokenizer-gemini`, which embeds Gemini's actual
 *   SentencePiece vocabulary locally with no API call required.
 * - `llama2` — exact counts via `llama-tokenizer-js` (Llama 1 and 2). Llama 3+ uses a
 *   different vocabulary and should use the `llama3` identifier once a suitable sync backend
 *   is available.
 * - `claude` — heuristic approximation using Anthropic's published ~3.5 chars/token ratio.
 *   No local tokenizer is available for Claude 3+ models; the Anthropic SDK's
 *   `messages.countTokens()` API is the only exact path but requires a network call.
 *
 * When adding a new encoding, add a case to {@link Tokenizable.estimateTokens}.
 */
export const TokenEncoding = [
  'gpt2',
  'r50k_base',
  'p50k_base',
  'p50k_edit',
  'cl100k_base',
  'o200k_base',
  'gemini',
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
 * Estimation is dispatched by encoding identifier — see {@link TokenEncoding} for the full list
 * of supported backends and their accuracy characteristics. Unrecognised encodings fall back to
 * a `ceil(length / 4)` character heuristic.
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

  declare toJSON: () => string
  declare toString: () => string
  declare valueOf: () => string
  declare toLocaleString: () => string
  /** Replace the wrapped string value (and invalidate the cached token estimates). */
  declare set: (value: string) => void
  /** Estimate the token count of the wrapped string under the given {@link TokenEncoding}. */
  declare estimateTokens: (encoding: TokenEncoding) => number

  #value: string
  #cache: Map<TokenEncoding, number> = new Map()

  /**
   * @param value - The initial string value to wrap.
   */
  constructor(value: string) {
    this.#value = value

    const estimateTokensWithTiktoken = (encoding: TokenEncoding): number => {
      try {
        const enc: Tiktoken = getTiktokenEncoder(encoding)
        return enc.encode(this.#value, []).length
      } catch {
        return Number.POSITIVE_INFINITY
      }
    }

    const estimateTokensWithGemini = (): number => {
      try {
        return getGeminiTokenizer().encode(this.#value).length
      } catch {
        return Number.POSITIVE_INFINITY
      }
    }

    const estimateTokensWithLlama2 = (): number => {
      try {
        return getLlamaTokenizer().encode(this.#value, false).length
      } catch {
        return Number.POSITIVE_INFINITY
      }
    }

    const estimateTokensWithClaudeHeuristic = (): number => {
      try {
        return Math.ceil(this.#value.length / 3.5)
      } catch {
        return Number.POSITIVE_INFINITY
      }
    }

    Object.defineProperties(this, {
      toJSON: {
        value: () => this.#value,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      toString: {
        value: () => this.#value,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      valueOf: {
        value: () => this.#value,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      toLocaleString: {
        value: () => this.#value,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      [Symbol.for('nodejs.util.inspect.custom')]: {
        value: () => this.#value,
        enumerable: false,
        configurable: false,
        writable: false,
      },
      set: {
        value: (next: string) => {
          this.#value = next
          this.#cache.clear()
        },
        enumerable: false,
        configurable: false,
        writable: false,
      },
      estimateTokens: {
        value: (encoding: TokenEncoding): number => {
          if (this.#cache.has(encoding)) {
            return this.#cache.get(encoding)!
          }

          let estimate: number
          switch (encoding) {
            case 'gpt2':
            case 'r50k_base':
            case 'p50k_base':
            case 'p50k_edit':
            case 'cl100k_base':
            case 'o200k_base':
              estimate = estimateTokensWithTiktoken(encoding)
              break
            case 'gemini':
              estimate = estimateTokensWithGemini()
              break
            case 'llama2':
              estimate = estimateTokensWithLlama2()
              break
            case 'claude':
              estimate = estimateTokensWithClaudeHeuristic()
              break
          }
          if (estimate === Number.POSITIVE_INFINITY) {
            estimate = Math.ceil(this.#value.length / 4)
          } else {
            this.#cache.set(encoding, estimate)
          }
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
   * @param value - The string to count tokens for.
   * @param encoding - The encoding identifier to use for counting.
   * @returns The estimated number of tokens.
   */
  public static estimateTokens(value: string, encoding: TokenEncoding): number {
    const temp = new Tokenizable(value)
    return temp.estimateTokens(encoding)
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
