import { describe, expect, it } from 'vitest'
import { ENCODE_METHOD, DECODE_METHOD } from '../../../src/lib/utils/encoder_symbols'
import { E_TOKENIZABLE_EVALUATOR_INVALID } from '../../../src/lib/exceptions/runtime'
import {
  TokenEncoding,
  Tokenizable,
  registerTokenEstimator,
  E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN,
} from '../../../src/lib/classes/tokenizable'

// A minimal stand-in for the DispatchContext an evaluator reads. The evaluator only touches
// `tools.visible()` in the real cite-thought use, so a structural stub is enough for the primitive tests.
const fakeCtx = (toolNames: string[]) =>
  ({ tools: { visible: () => toolNames.map((name) => ({ name })) } }) as never

describe('Tokenizable', () => {
  describe('construction and value access', () => {
    it('stores the initial string value', () => {
      const t = new Tokenizable('hello world')
      expect(t.toString()).toBe('hello world')
      expect(t.valueOf()).toBe('hello world')
      expect(t.toJSON()).toBe('hello world')
      expect(t.toLocaleString()).toBe('hello world')
    })

    it('coerces transparently to a string', () => {
      const t = new Tokenizable('hi')
      expect(`${t}`).toBe('hi')
      expect(String(t)).toBe('hi')
      expect(JSON.stringify(t)).toBe('"hi"')
    })

    it('returns the value from the nodejs.util.inspect.custom hook', () => {
      const t = new Tokenizable('inspected')
      const key = Symbol.for('nodejs.util.inspect.custom')
      const fn = (t as unknown as Record<symbol, () => string>)[key]
      expect(fn.call(t)).toBe('inspected')
    })
  })

  describe('set', () => {
    it('replaces the stored value', () => {
      const t = new Tokenizable('one')
      t.set('two')
      expect(t.toString()).toBe('two')
    })

    it('clears the token-count cache on update', () => {
      const t = new Tokenizable('hello world')
      const before = t.estimateTokens('cl100k_base')
      t.set('a much longer string than before with many more tokens to count')
      const after = t.estimateTokens('cl100k_base')
      expect(after).toBeGreaterThan(before)
    })
  })

  describe('estimateTokens (instance)', () => {
    it('returns a positive count for tiktoken-family encodings', () => {
      const t = new Tokenizable('Hello, world!')
      for (const enc of ['gpt2', 'r50k_base', 'p50k_base', 'cl100k_base', 'o200k_base'] as const) {
        expect(t.estimateTokens(enc)).toBeGreaterThan(0)
      }
    })

    it('returns a positive count for gemini', () => {
      const t = new Tokenizable('Hello, world!')
      expect(t.estimateTokens('gemini')).toBeGreaterThan(0)
    })

    it('returns a positive count for gemma', () => {
      const t = new Tokenizable('Hello, world!')
      expect(t.estimateTokens('gemma')).toBeGreaterThan(0)
    })

    it('encodes Gemma control tokens as single ids (not char-split)', () => {
      // The load-bearing property for on-device budgeting: Gemma chat framing like
      // `<start_of_turn>` / `<end_of_turn>` must count as ONE token each, not the ~5 a naive
      // char/tiktoken split would produce. A bare turn frame is well under 10 gemma tokens.
      const frame = new Tokenizable('<start_of_turn>user\nhi<end_of_turn>\n<start_of_turn>model\n')
      const gemma = frame.estimateTokens('gemma')
      expect(gemma).toBeGreaterThan(0)
      expect(gemma).toBeLessThan(15)
    })

    it('returns a positive count for llama2', () => {
      const t = new Tokenizable('Hello, world!')
      expect(t.estimateTokens('llama2')).toBeGreaterThan(0)
    })

    it('uses the ~3.5 chars/token heuristic for claude', () => {
      const t = new Tokenizable('a'.repeat(35))
      // 35 chars / 3.5 = 10 tokens exactly
      expect(t.estimateTokens('claude')).toBe(10)
    })

    it('caches results per encoding (idempotent within a value)', () => {
      const t = new Tokenizable('cached value')
      const first = t.estimateTokens('cl100k_base')
      const second = t.estimateTokens('cl100k_base')
      expect(first).toBe(second)
    })
  })

  describe('Tokenizable.estimateTokens (static)', () => {
    it('returns a count for one-off invocations without creating a long-lived instance', () => {
      const count = Tokenizable.estimateTokens('hello', 'cl100k_base')
      expect(count).toBeGreaterThan(0)
    })

    it('matches the instance-method result for the same input', () => {
      const t = new Tokenizable('the same input')
      const inst = t.estimateTokens('cl100k_base')
      const stat = Tokenizable.estimateTokens('the same input', 'cl100k_base')
      expect(stat).toBe(inst)
    })
  })

  describe('Tokenizable.isTokenizable', () => {
    it('returns true for Tokenizable instances', () => {
      expect(Tokenizable.isTokenizable(new Tokenizable('x'))).toBe(true)
    })

    it('returns false for plain strings', () => {
      expect(Tokenizable.isTokenizable('x')).toBe(false)
    })

    it('returns false for null/undefined/objects', () => {
      expect(Tokenizable.isTokenizable(null)).toBe(false)
      expect(Tokenizable.isTokenizable(undefined)).toBe(false)
      expect(Tokenizable.isTokenizable({})).toBe(false)
    })
  })

  describe('TokenEncoding constant', () => {
    it('lists every supported encoding', () => {
      expect(TokenEncoding).toContain('gpt2')
      expect(TokenEncoding).toContain('cl100k_base')
      expect(TokenEncoding).toContain('o200k_base')
      expect(TokenEncoding).toContain('gemini')
      expect(TokenEncoding).toContain('gemma')
      expect(TokenEncoding).toContain('llama2')
      expect(TokenEncoding).toContain('claude')
    })

    it('is exposed as a static on the class for runtime access', () => {
      expect(Tokenizable.TokenEncoding).toBe(TokenEncoding)
    })
  })

  describe('special-token text (tiktoken disallowedSpecial fix)', () => {
    // js-tiktoken's `encode` defaults `disallowedSpecial` to "all", so a registered special-token
    // substring (e.g. `<|endoftext|>`) THREW ("The text contains a special token that is not allowed").
    // We estimate counts, never round-trip, so a special-token literal must be COUNTED as ordinary text.
    // Regression guard: a finite count, for every tiktoken-family encoding, both with and without a run
    // scope (proving it never reaches the degrade/throw path at all).
    const TIKTOKEN = [
      'gpt2',
      'r50k_base',
      'p50k_base',
      'p50k_edit',
      'cl100k_base',
      'o200k_base',
    ] as const
    const SPECIALS = [
      'docs about <|endoftext|> token',
      'a chat frame <|im_start|>system then <|im_end|>',
      'fim markers <|fim_prefix|> x <|fim_suffix|> y <|fim_middle|>',
    ]

    for (const enc of TIKTOKEN) {
      it(`counts special-token text as ordinary text (finite) for ${enc}`, () => {
        for (const s of SPECIALS) {
          const n = new Tokenizable(s).estimateTokens(enc)
          expect(Number.isFinite(n)).toBe(true)
          expect(n).toBeGreaterThan(0)
        }
      })
    }

    it('does not throw on special-token text outside any runner scope', () => {
      // The special-token case is fixed UPSTREAM (disallowedSpecial: []), so it never reaches the
      // "outside a runner → throw" branch. This asserts the common trigger is defanged.
      expect(() => new Tokenizable('<|endoftext|>').estimateTokens('cl100k_base')).not.toThrow()
    })

    it('gemma/gemini/llama/claude also count special-token text finitely', () => {
      for (const enc of ['gemini', 'gemma', 'llama2', 'claude'] as const) {
        const n = new Tokenizable('docs about <|endoftext|> token').estimateTokens(enc)
        expect(Number.isFinite(n)).toBe(true)
        expect(n).toBeGreaterThan(0)
      }
    })
  })

  describe('static value is unchanged by the dynamic feature', () => {
    it('render(ctx) equals toString() for a static value (ctx ignored)', () => {
      const t = new Tokenizable('static content')
      expect(t.render()).toBe('static content')
      expect(t.render(fakeCtx(['provide_answer']))).toBe('static content')
      expect(t.render()).toBe(t.toString())
    })

    it('estimateTokens is stable regardless of ctx for a static value', () => {
      const t = new Tokenizable('static content here')
      const a = t.estimateTokens('cl100k_base')
      const b = t.estimateTokens('cl100k_base', fakeCtx(['provide_answer']))
      expect(b).toBe(a)
      expect(a).toBeGreaterThan(0)
    })
  })

  describe('dynamic (evaluatable) value', () => {
    const citeEvaluator = (ctx?: { tools: { visible: () => { name?: string }[] } }): string =>
      ctx?.tools.visible().some((tool) => tool.name === 'provide_answer')
        ? 'CITE: call provide_answer'
        : 'PROSE: answer from context'

    it('render(ctx) evaluates against the context; render()/toString() give the no-ctx fallback', () => {
      const t = new Tokenizable(citeEvaluator as never)
      expect(t.render(fakeCtx(['provide_answer']))).toBe('CITE: call provide_answer')
      expect(t.render(fakeCtx(['search_docs_semantic']))).toBe('PROSE: answer from context')
      // No ctx → the evaluator's `undefined` branch = the fallback (PROSE here).
      expect(t.render()).toBe('PROSE: answer from context')
      expect(t.toString()).toBe('PROSE: answer from context')
      expect(String(t)).toBe('PROSE: answer from context')
    })

    it('estimateTokens(enc, ctx) counts the resolved-for-ctx string; (enc) counts the fallback', () => {
      // Make the two branches obviously different lengths so the counts must differ.
      const t = new Tokenizable(((ctx?: { tools: { visible: () => { name?: string }[] } }) =>
        ctx?.tools.visible().some((x) => x.name === 'provide_answer')
          ? 'short'
          : 'a considerably longer fallback string with many more tokens to encode here') as never)
      const withTool = t.estimateTokens('cl100k_base', fakeCtx(['provide_answer']))
      const fallback = t.estimateTokens('cl100k_base')
      const explicitFallbackCtx = t.estimateTokens('cl100k_base', fakeCtx(['search_docs_semantic']))
      expect(withTool).toBe(Tokenizable.estimateTokens('short', 'cl100k_base'))
      expect(fallback).toBeGreaterThan(withTool)
      expect(explicitFallbackCtx).toBe(fallback)
    })

    it('reuses the per-ctx cached count for the same ctx object (WeakMap cache)', () => {
      let calls = 0
      const t = new Tokenizable(((ctx?: unknown) => {
        calls++
        return ctx ? 'with-ctx' : 'no-ctx'
      }) as never)
      const ctx = fakeCtx(['x'])
      t.estimateTokens('cl100k_base', ctx)
      const afterFirst = calls
      t.estimateTokens('cl100k_base', ctx) // same ctx + same encoding → cached, evaluator not re-run
      expect(calls).toBe(afterFirst)
    })

    it('THROWS E_TOKENIZABLE_EVALUATOR_INVALID when the evaluator throws', () => {
      const t = new Tokenizable((() => {
        throw new Error('boom')
      }) as never)
      expect(() => t.render(fakeCtx(['x']))).toThrowError(E_TOKENIZABLE_EVALUATOR_INVALID)
      // The original error is preserved on cause.
      try {
        t.render()
      } catch (e) {
        expect((e as { cause?: Error }).cause?.message).toBe('boom')
      }
    })

    it('THROWS E_TOKENIZABLE_EVALUATOR_INVALID when the evaluator returns a non-string', () => {
      const t = new Tokenizable((() => 42 as unknown as string) as never)
      expect(() => t.render()).toThrowError(E_TOKENIZABLE_EVALUATOR_INVALID)
      const tObj = new Tokenizable((() => ({}) as unknown as string) as never)
      expect(() => tObj.toString()).toThrowError(E_TOKENIZABLE_EVALUATOR_INVALID)
    })

    it('round-trips its EVALUATOR through encode/decode and STAYS dynamic', () => {
      const t = new Tokenizable(citeEvaluator as never)
      const snapshot = (t as unknown as { [ENCODE_METHOD](): unknown })[ENCODE_METHOD]()
      // The snapshot is the evaluator function itself (dynamic), not a frozen string.
      expect(typeof snapshot).toBe('function')
      const decoded = (Tokenizable as unknown as { [DECODE_METHOD](d: unknown): Tokenizable })[
        DECODE_METHOD
      ](snapshot)
      // Re-evaluates live: the decoded Tokenizable still adapts to the ctx.
      expect(decoded.render(fakeCtx(['provide_answer']))).toBe('CITE: call provide_answer')
      expect(decoded.render(fakeCtx(['search_docs_semantic']))).toBe('PROSE: answer from context')
    })

    it('a static value encodes as its string (unchanged)', () => {
      const t = new Tokenizable('plain')
      const snapshot = (t as unknown as { [ENCODE_METHOD](): unknown })[ENCODE_METHOD]()
      expect(snapshot).toBe('plain')
    })

    it('set() can swap a static value to a dynamic one and invalidates caches', () => {
      const t = new Tokenizable('static')
      const before = t.estimateTokens('cl100k_base')
      t.set(citeEvaluator as never)
      expect(t.render(fakeCtx(['provide_answer']))).toBe('CITE: call provide_answer')
      // Cache was cleared: the fallback count reflects the NEW value, not the old 'static'.
      const after = t.estimateTokens('cl100k_base')
      expect(after).toBe(Tokenizable.estimateTokens('PROSE: answer from context', 'cl100k_base'))
      expect(after).not.toBe(before)
    })
  })

  describe('registerTokenEstimator (custom-encoding registry)', () => {
    it('resolves a registered custom encoding through Tokenizable.estimateTokens (static)', () => {
      registerTokenEstimator('test-quarter', (s) => Math.ceil(s.length / 4))
      // 4 chars / 4 = 1 token exactly.
      expect(Tokenizable.estimateTokens('abcd', 'test-quarter')).toBe(1)
      // 9 chars / 4 = 2.25 -> ceil -> 3 tokens.
      expect(Tokenizable.estimateTokens('abcdefghi', 'test-quarter')).toBe(3)
    })

    it('re-registering the same encoding overwrites the previous estimator', () => {
      registerTokenEstimator('test-overwrite', () => 111)
      expect(Tokenizable.estimateTokens('anything', 'test-overwrite')).toBe(111)
      registerTokenEstimator('test-overwrite', () => 222)
      expect(Tokenizable.estimateTokens('anything', 'test-overwrite')).toBe(222)
    })

    it('THROWS E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN when registering a name that shadows a built-in', () => {
      expect(() => registerTokenEstimator('gemma', (s) => s.length)).toThrowError(
        E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN
      )
      expect(() => registerTokenEstimator('cl100k_base', (s) => s.length)).toThrowError(
        E_TOKEN_ESTIMATOR_SHADOWS_BUILTIN
      )
    })

    it('an unrecognised, unregistered encoding still resolves to undefined (pre-existing behaviour, unchanged)', () => {
      const t = new Tokenizable('hello world')
      expect(t.estimateTokens('totally-unrecognised-encoding' as never)).toBeUndefined()
    })

    it('a Tokenizable INSTANCE measures via a registered custom estimator (constructor path, not just static)', () => {
      registerTokenEstimator('test-instance-path', (s) => s.length * 2)
      const t = new Tokenizable('abc')
      expect(t.estimateTokens('test-instance-path' as never)).toBe(6)
    })
  })
})
