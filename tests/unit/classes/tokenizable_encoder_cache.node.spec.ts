import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression guard for the encoder-construction freeze (work_items/1).
 *
 * `js-tiktoken`'s `getEncoding` has no internal cache — each call does `new Tiktoken(<ranks>)`,
 * parsing the full BPE rank table (~800ms for o200k_base), which is ~1000× the cost of the
 * subsequent `encode()`. Before the fix, `Tokenizable` built a fresh encoder on every
 * `estimateTokens` call, so re-measuring an accumulating dispatch context every iteration rebuilt
 * the BPE table O(calls) times and wedged the single-threaded host.
 *
 * These tests mock `getEncoding` and assert the encoder is constructed at most once per encoding
 * for the lifetime of the module, regardless of how many instances or calls drive it. They live
 * in their own file (and use `vi.resetModules`) because the encoder cache is module-level state —
 * a fresh module graph per test keeps the construction counter clean.
 */

// A fake Tiktoken whose `encode` returns one token per whitespace-split word — enough for a
// positive, deterministic count without pulling in the real BPE tables. The factory is a spy so
// tests can assert how many times an encoder was constructed.
const getEncoding = vi.fn((_encoding: string) => ({
  encode: (value: string, _special?: unknown): number[] =>
    value.length === 0
      ? []
      : value
          .split(/\s+/)
          .filter(Boolean)
          .map((_, i) => i),
}))

vi.mock('js-tiktoken', () => ({ getEncoding }))

// Re-import Tokenizable against a fresh module graph each test so its module-level encoder cache
// starts empty; the mocked `js-tiktoken` is re-resolved against the same fresh graph.
const loadTokenizable = async () => {
  vi.resetModules()
  getEncoding.mockClear()
  const mod = await import('../../../src/lib/classes/tokenizable')
  return mod.Tokenizable
}

describe('Tokenizable — tiktoken encoder caching (regression: work_items/1)', () => {
  beforeEach(() => {
    getEncoding.mockClear()
  })

  it('constructs the encoder once for repeated counts on a single instance', async () => {
    const Tokenizable = await loadTokenizable()
    const t = new Tokenizable('hello world')
    t.estimateTokens('o200k_base')
    t.estimateTokens('o200k_base')
    t.estimateTokens('o200k_base')
    // Per-instance value memo means encode runs once; encoder construction must also be once.
    expect(getEncoding).toHaveBeenCalledTimes(1)
  })

  it('constructs the encoder once across many distinct instances (same encoding)', async () => {
    const Tokenizable = await loadTokenizable()
    // This is the freeze scenario: N accumulated results, each a separate Tokenizable, all
    // measured under the same encoding. Before the fix this was N encoder builds.
    for (let i = 0; i < 50; i++) {
      new Tokenizable(`tool result number ${i} with some content`).estimateTokens('o200k_base')
    }
    expect(getEncoding).toHaveBeenCalledTimes(1)
  })

  it('constructs the encoder once even when re-measured across simulated iterations', async () => {
    const Tokenizable = await loadTokenizable()
    // Simulate the adapter's per-iteration token loop over an accumulating context: the SAME
    // throwaway-style measurement repeated, growing each "iteration". The encoder build must not
    // scale with iterations × results.
    const results = Array.from({ length: 10 }, (_, i) => `result ${i}`)
    for (let iteration = 1; iteration <= 10; iteration++) {
      for (let r = 0; r < iteration; r++) {
        new Tokenizable(results[r]!).estimateTokens('o200k_base')
      }
    }
    expect(getEncoding).toHaveBeenCalledTimes(1)
  })

  it('constructs one encoder per distinct encoding, then reuses each', async () => {
    const Tokenizable = await loadTokenizable()
    const encodings = ['cl100k_base', 'o200k_base', 'gpt2'] as const
    // Two passes over every encoding across fresh instances — second pass must hit the cache.
    for (let pass = 0; pass < 2; pass++) {
      for (const enc of encodings) {
        new Tokenizable(`pass ${pass} content`).estimateTokens(enc)
      }
    }
    expect(getEncoding).toHaveBeenCalledTimes(encodings.length)
    for (const enc of encodings) {
      expect(getEncoding).toHaveBeenCalledWith(enc)
    }
  })

  it('still returns a stable positive count using the cached encoder', async () => {
    const Tokenizable = await loadTokenizable()
    const a = new Tokenizable('the quick brown fox').estimateTokens('o200k_base')
    const b = new Tokenizable('the quick brown fox').estimateTokens('o200k_base')
    expect(a).toBeGreaterThan(0)
    expect(b).toBe(a)
  })
})
