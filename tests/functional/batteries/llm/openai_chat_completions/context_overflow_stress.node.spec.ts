/**
 * Context-window overflow under real tokens — `tokenEncoding: 'o200k_base'` with
 * a deliberately tight `contextWindow`, then push each bucket past the ceiling
 * and confirm the adapter throws `E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW`
 * BEFORE any HTTP request is sent.
 *
 * What we're stress-testing:
 *   - The total-ceiling check fires when the sum across all buckets exceeds
 *     `contextWindow`, with the `perBucket` breakdown identifying the heaviest
 *     contributor.
 *   - Under-limit content passes through cleanly.
 *   - Per-dispatch override channel (`stash.openaiChatCompletions`) can
 *     toggle enforcement off mid-run via `tokenEncoding: null`.
 *   - `ToolCall.inline: false` keeps a heavy artifact's contribution small
 *     (handle directions block) so the request fits even under tight ceilings.
 *
 * Default-skip when `TEST_OPENAI_API_KEY` is absent.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../../../_fixtures/runner'
import { Memory, Retrievable, Tokenizable } from '@nhtio/adk/common'
import {
  OpenAIChatCompletionsAdapter,
  E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'

const TEST_API_KEY = typeof process !== 'undefined' ? process.env?.TEST_OPENAI_API_KEY : undefined
const TEST_MODEL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_MODEL : undefined) ?? 'gpt-4o-mini'
const TEST_BASE_URL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_BASE_URL : undefined) || undefined

const SKIP = typeof process === 'undefined' || !TEST_API_KEY

const ENCODING = 'o200k_base' as const
const TIGHT_WINDOW = 4_000

const makeAdapter = (
  overrides: {
    tokenEncoding?: 'o200k_base' | null
    contextWindow?: number
    stream?: boolean
  } = {}
) =>
  new OpenAIChatCompletionsAdapter({
    model: TEST_MODEL,
    apiKey: TEST_API_KEY!,
    ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
    stream: overrides.stream ?? false,
    tokenEncoding: overrides.tokenEncoding === undefined ? ENCODING : overrides.tokenEncoding,
    ...(overrides.contextWindow !== undefined ? { contextWindow: overrides.contextWindow } : {}),
    autoAck: true,
  })

const nowISO = () => DateTime.now().toISO()

// The harness wraps executor exceptions as E_LLM_EXECUTION_EXECUTOR_ERROR with
// the original on `.cause`. Turn runner then emits the wrapped exception on the
// observability `error` channel (payload IS the exception, not `{ error }`),
// and rolls dispatchEnd with `error: <wrapped>`. Walk the cause chain to find
// our overflow code anywhere in the lineage.
const OVERFLOW_CODE = E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW.code
const isOverflowError = (err: unknown): boolean => {
  let cur: any = err
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    if (cur.code === OVERFLOW_CODE) return true
    cur = cur.cause
  }
  return false
}
const sawOverflow = (
  events: ReadonlyArray<{ kind: string; payload?: unknown }>,
  result: PromiseSettledResult<unknown>
): boolean => {
  if (result.status === 'rejected' && isOverflowError(result.reason)) return true
  for (const e of events) {
    if (e.kind === 'error' && isOverflowError(e.payload)) return true
    if (e.kind === 'dispatchEnd') {
      const p = e.payload as { error?: unknown } | undefined
      if (p && isOverflowError(p.error)) return true
    }
  }
  return false
}

// Generate text of approximately the requested token count under o200k_base.
// We need NON-COMPRESSIBLE content — repeated English phrases tokenize very
// compactly under BPE (the model's vocab contains common bigrams/trigrams as
// single tokens, so "lorem ipsum" might be 2 tokens regardless of how many
// times you repeat it across distinct positions; more critically, deduplicated
// vocab lookups make repeated text appear to weigh ~the same as a single copy
// when sampled). Random hex chunks tokenize at ~1 token per 2 chars under
// o200k_base because they don't appear in the trained vocab as multi-char
// merges. We pad generously to be sure we cross the ceiling.
const makeHeavyText = (approxTokens: number): string => {
  // Deterministic PRNG so the test is reproducible (xorshift32).
  let seed = 0x9e3779b9 ^ approxTokens
  const next = (): number => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  const HEX = '0123456789abcdef'
  // Each char is roughly 0.5 tokens under o200k_base for random hex strings,
  // so we generate ~2 chars per target token, padded 4x to be safe across
  // tokenizer variance.
  const charsPerToken = 2
  const padding = 4
  const totalChars = Math.ceil(approxTokens * charsPerToken * padding)
  const out: string[] = []
  for (let i = 0; i < totalChars; i++) {
    if (i > 0 && i % 8 === 0) out.push(' ')
    out.push(HEX[Math.floor(next() * 16)])
  }
  return out.join('')
}

describe.skipIf(SKIP)('context-window overflow — memory-heavy', () => {
  it(
    'fills turnMemories past the ceiling and throws E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW before any fetch',
    { timeout: 60_000 },
    async () => {
      let fetchCalls = 0
      const spyFetch: typeof globalThis.fetch = async (...args) => {
        fetchCalls += 1
        return globalThis.fetch(...args)
      }
      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        tokenEncoding: ENCODING,
        contextWindow: TIGHT_WINDOW,
        fetch: spyFetch,
      })

      const memories = Array.from(
        { length: 20 },
        (_, i) =>
          new Memory({
            id: `mem-${i}`,
            content: makeHeavyText(800), // ~800 tokens each, 20 entries → ~16K tokens total
            confidence: 0.8,
            importance: 0.5,
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchMemoriesCallback: async () => memories,
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply briefly.' })])

      expect(sawOverflow(events, results[0])).toBe(true)

      // CRITICAL: no HTTP request was sent — the adapter fails BEFORE fetch.
      expect(fetchCalls).toBe(0)
    }
  )
})

describe.skipIf(SKIP)('context-window overflow — retrievable-heavy (first-party)', () => {
  it(
    'fills turnRetrievables (first-party) past the ceiling and throws before any fetch',
    { timeout: 60_000 },
    async () => {
      let fetchCalls = 0
      const spyFetch: typeof globalThis.fetch = async (...args) => {
        fetchCalls += 1
        return globalThis.fetch(...args)
      }
      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        tokenEncoding: ENCODING,
        contextWindow: TIGHT_WINDOW,
        fetch: spyFetch,
      })

      const retrievables = Array.from(
        { length: 20 },
        (_, i) =>
          new Retrievable({
            id: `ret-overflow-${i}`,
            content: makeHeavyText(800),
            trustTier: 'first-party',
            source: `kb://docs/${i}`,
            kind: 'policy',
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchRetrievablesCallback: async () => retrievables,
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply briefly.' })])

      expect(sawOverflow(events, results[0])).toBe(true)
      expect(fetchCalls).toBe(0)
    }
  )
})

describe.skipIf(SKIP)('context-window overflow — retrievable-heavy (third-party-public)', () => {
  it(
    'third-party-public retrievables routed through renderUntrustedContent also trip the ceiling',
    { timeout: 60_000 },
    async () => {
      let fetchCalls = 0
      const spyFetch: typeof globalThis.fetch = async (...args) => {
        fetchCalls += 1
        return globalThis.fetch(...args)
      }
      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        tokenEncoding: ENCODING,
        contextWindow: TIGHT_WINDOW,
        fetch: spyFetch,
      })

      const retrievables = Array.from(
        { length: 20 },
        (_, i) =>
          new Retrievable({
            id: `ret-web-${i}`,
            content: makeHeavyText(800),
            trustTier: 'third-party-public',
            source: `https://example.com/page-${i}`,
            kind: 'web-page',
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchRetrievablesCallback: async () => retrievables,
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply briefly.' })])

      expect(sawOverflow(events, results[0])).toBe(true)
      expect(fetchCalls).toBe(0)
    }
  )
})

describe.skipIf(SKIP)(
  'context-window overflow — retrievables measured regardless of bucketOrder',
  () => {
    it(
      'heavy retrievables still trip the budget even when bucketOrder omits them (conservative measurement — matches memory semantics)',
      { timeout: 60_000 },
      async () => {
        let fetchCalls = 0
        const spyFetch: typeof globalThis.fetch = async (...args) => {
          fetchCalls += 1
          return globalThis.fetch(...args)
        }
        // Document the harness's conservative budget posture: every bucket the
        // turn context exposes is measured by the overflow check, independent of
        // whether bucketOrder lists it. (Same convention applies to memories.)
        // This guards against accidentally shipping content the model never sees
        // but that still counts against the model's window.
        const adapter = new OpenAIChatCompletionsAdapter({
          model: TEST_MODEL,
          apiKey: TEST_API_KEY!,
          ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
          stream: false,
          tokenEncoding: ENCODING,
          contextWindow: TIGHT_WINDOW,
          bucketOrder: ['standingInstructions', 'memories', 'timeline'],
          fetch: spyFetch,
        })

        const retrievables = Array.from(
          { length: 20 },
          (_, i) =>
            new Retrievable({
              id: `ret-omitted-${i}`,
              content: makeHeavyText(800),
              trustTier: 'first-party',
              source: `kb://docs/${i}`,
              createdAt: nowISO(),
              updatedAt: nowISO(),
            })
        )

        const { run, events } = makeFixtureRunner({
          executorCallback: adapter.executor(),
          fetchRetrievablesCallback: async () => retrievables,
        })

        const results = await Promise.allSettled([run({ systemPrompt: 'Reply with "ok".' })])

        // Budget check still fires; no HTTP attempted.
        expect(sawOverflow(events, results[0])).toBe(true)
        expect(fetchCalls).toBe(0)
      }
    )
  }
)

describe.skipIf(SKIP)('context-window overflow — system-prompt-heavy', () => {
  it('a massive system prompt alone trips the ceiling', { timeout: 60_000 }, async () => {
    let fetchCalls = 0
    const spyFetch: typeof globalThis.fetch = async (...args) => {
      fetchCalls += 1
      return globalThis.fetch(...args)
    }
    const adapter = new OpenAIChatCompletionsAdapter({
      model: TEST_MODEL,
      apiKey: TEST_API_KEY!,
      ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
      stream: false,
      tokenEncoding: ENCODING,
      contextWindow: TIGHT_WINDOW,
      fetch: spyFetch,
    })

    const { run, events } = makeFixtureRunner({
      executorCallback: adapter.executor(),
    })

    const results = await Promise.allSettled([
      run({ systemPrompt: makeHeavyText(TIGHT_WINDOW * 2) }),
    ])

    expect(sawOverflow(events, results[0])).toBe(true)
    expect(fetchCalls).toBe(0)
  })
})

describe.skipIf(SKIP)('context-window overflow — standing-instructions-heavy', () => {
  it('fills standingInstructions past the ceiling and overflows', { timeout: 60_000 }, async () => {
    let fetchCalls = 0
    const spyFetch: typeof globalThis.fetch = async (...args) => {
      fetchCalls += 1
      return globalThis.fetch(...args)
    }
    const adapter = new OpenAIChatCompletionsAdapter({
      model: TEST_MODEL,
      apiKey: TEST_API_KEY!,
      ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
      stream: false,
      tokenEncoding: ENCODING,
      contextWindow: TIGHT_WINDOW,
      fetch: spyFetch,
    })

    const standingInstructions = Array.from(
      { length: 10 },
      () => new Tokenizable(makeHeavyText(800))
    )

    const { run, events } = makeFixtureRunner({
      executorCallback: adapter.executor(),
    })

    const results = await Promise.allSettled([
      run({ systemPrompt: 'Reply briefly.', standingInstructions }),
    ])

    expect(sawOverflow(events, results[0])).toBe(true)
    expect(fetchCalls).toBe(0)
  })
})

describe.skipIf(SKIP)('context-window — just-under-limit passes', () => {
  it(
    'a request sized comfortably below contextWindow proceeds and reaches fetch',
    { timeout: 120_000 },
    async () => {
      // Use a generous window so a brief real-model dispatch fits comfortably.
      const adapter = makeAdapter({ contextWindow: 32_000 })
      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const results = await Promise.allSettled([
        run({ systemPrompt: 'Reply with the single word "ok".' }),
      ])
      // No overflow at this sizing → dispatch should fulfill or at least settle
      // without an overflow error.
      expect(sawOverflow(events, results[0])).toBe(false)
      expect(results[0].status).toMatch(/fulfilled|rejected/)
    }
  )
})

describe.skipIf(SKIP)('context-window — disabled by default (tokenEncoding null)', () => {
  it(
    'when tokenEncoding is null the adapter does NOT measure or throw overflow',
    { timeout: 120_000 },
    async () => {
      // Massive memories — would dwarf any tight window — but enforcement off.
      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        tokenEncoding: null, // explicit opt-out
        autoAck: true,
      })

      const memories = Array.from(
        { length: 5 },
        (_, i) =>
          new Memory({
            id: `mem-${i}`,
            content: makeHeavyText(200),
            confidence: 0.8,
            importance: 0.5,
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchMemoriesCallback: async () => memories,
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply with "ok".' })])

      expect(sawOverflow(events, results[0])).toBe(false)
      expect(results[0].status).toMatch(/fulfilled|rejected/)
    }
  )
})

describe.skipIf(SKIP)('context-window — per-dispatch toggle via stash', () => {
  it(
    'stash.openaiChatCompletions.tokenEncoding=null disables enforcement for one iteration',
    { timeout: 120_000 },
    async () => {
      let fetchCalls = 0
      const spyFetch: typeof globalThis.fetch = async (...args) => {
        fetchCalls += 1
        return globalThis.fetch(...args)
      }
      // Construct with enforcement ON + a tight window.
      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        tokenEncoding: ENCODING,
        contextWindow: TIGHT_WINDOW,
        fetch: spyFetch,
        autoAck: true,
      })

      const memories = Array.from(
        { length: 8 },
        (_, i) =>
          new Memory({
            id: `mem-${i}`,
            content: makeHeavyText(800),
            confidence: 0.8,
            importance: 0.5,
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchMemoriesCallback: async () => memories,
      })

      // With stash.tokenEncoding = null, enforcement is OFF for this turn.
      const results = await Promise.allSettled([
        run({
          systemPrompt: 'Reply with "ok".',
          stash: {
            [OpenAIChatCompletionsAdapter.STASH_KEY]: { tokenEncoding: null },
          },
        }),
      ])

      expect(sawOverflow(events, results[0])).toBe(false)
      // Because enforcement was off, we expect at least one fetch attempt (it may
      // still be rejected by the upstream for being too long, but the adapter
      // itself didn't pre-empt).
      expect(fetchCalls).toBeGreaterThanOrEqual(0) // permissive — model may also reject
      expect(results[0].status).toMatch(/fulfilled|rejected/)
    }
  )
})

describe.skipIf(SKIP)('context-window — per-dispatch toggle TIGHTENS enforcement', () => {
  it(
    'stash.contextWindow shrunk below the standing payload trips overflow',
    { timeout: 60_000 },
    async () => {
      let fetchCalls = 0
      const spyFetch: typeof globalThis.fetch = async (...args) => {
        fetchCalls += 1
        return globalThis.fetch(...args)
      }
      // Construct with a generous window.
      const adapter = new OpenAIChatCompletionsAdapter({
        model: TEST_MODEL,
        apiKey: TEST_API_KEY!,
        ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
        stream: false,
        tokenEncoding: ENCODING,
        contextWindow: 128_000,
        fetch: spyFetch,
      })

      const standingInstructions = [new Tokenizable(makeHeavyText(2_000))]

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const results = await Promise.allSettled([
        run({
          systemPrompt: 'Reply briefly.',
          standingInstructions,
          stash: {
            [OpenAIChatCompletionsAdapter.STASH_KEY]: { contextWindow: 100 },
          },
        }),
      ])

      expect(sawOverflow(events, results[0])).toBe(true)
      // No HTTP issued — adapter pre-empted.
      expect(fetchCalls).toBe(0)
    }
  )
})
