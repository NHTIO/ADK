/**
 * Validation fuzz — hand-rolled property-style stress of
 * `openAIChatCompletionsOptionsSchema` / `validateOptions`. We generate
 * randomised option objects across the entire documented surface and assert:
 *   - Every shape we believe is valid resolves cleanly.
 *   - Every shape we believe is invalid rejects with
 *     E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS.
 *
 * The "fuzz" here is deterministic: a seeded LCG drives all randomness so
 * failures are reproducible. Each round is logged with the chosen options on
 * failure so a regression is debuggable.
 *
 * No live gateway needed — `validateOptions` is pure. We still skip-by-key to
 * keep the live-LLM stress gating consistent across the suite.
 */
import { describe, expect, it } from 'vitest'
import {
  validateOptions,
  E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'

const TEST_API_KEY = typeof process !== 'undefined' ? process.env?.TEST_OPENAI_API_KEY : undefined
const SKIP = typeof process === 'undefined' || !TEST_API_KEY

// ── Seeded RNG ──────────────────────────────────────────────────────────────
class LCG {
  #state: number
  constructor(seed: number) {
    this.#state = seed >>> 0 || 1
  }
  next() {
    this.#state = (Math.imul(this.#state, 1664525) + 1013904223) >>> 0
    return this.#state / 0x100000000
  }
  int(min: number, max: number) {
    return Math.floor(this.next() * (max - min + 1)) + min
  }
  pick<T>(arr: ReadonlyArray<T>): T {
    return arr[this.int(0, arr.length - 1)]
  }
  bool() {
    return this.next() < 0.5
  }
}

// ── Valid-shape generator ───────────────────────────────────────────────────
const TOKEN_ENCODINGS = [
  null,
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

const SERVICE_TIERS = ['auto', 'default', 'flex', 'priority', 'scale'] as const
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
const VERBOSITIES = ['low', 'medium', 'high'] as const
const BUCKET_LABELS = ['standingInstructions', 'memories', 'retrievables', 'timeline'] as const
const THOUGHT_SURFACINGS = ['all-self', 'latest-self', 'all'] as const

function shuffle<T>(arr: ReadonlyArray<T>, rng: LCG): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function genValidOptions(rng: LCG): Record<string, unknown> {
  const enc = rng.pick(TOKEN_ENCODINGS)
  const out: Record<string, unknown> = {
    model: `m-${rng.int(0, 9999)}`,
  }
  if (rng.bool()) out.apiKey = `sk-${rng.int(0, 999_999)}`
  if (rng.bool()) out.baseURL = `https://example.test/v${rng.int(1, 3)}`
  if (rng.bool()) out.stream = rng.bool()
  if (rng.bool()) out.temperature = rng.next() * 2
  if (rng.bool()) out.top_p = rng.next()
  if (rng.bool()) out.frequency_penalty = rng.next() * 4 - 2
  if (rng.bool()) out.presence_penalty = rng.next() * 4 - 2
  if (rng.bool()) out.n = rng.int(1, 5)
  if (rng.bool()) out.top_logprobs = rng.int(0, 20)
  if (rng.bool()) out.seed = rng.int(0, 1_000_000)
  if (rng.bool()) out.service_tier = rng.pick(SERVICE_TIERS)
  if (rng.bool()) out.reasoning_effort = rng.pick(REASONING_EFFORTS)
  if (rng.bool()) out.verbosity = rng.pick(VERBOSITIES)
  if (rng.bool()) out.logprobs = rng.bool()
  if (rng.bool()) out.parallel_tool_calls = rng.bool()
  if (rng.bool()) out.store = rng.bool()
  if (rng.bool()) out.max_completion_tokens = rng.int(1, 10_000)
  if (rng.bool())
    out.stop = rng.bool() ? `STOP-${rng.int(0, 99)}` : [`a${rng.int(0, 9)}`, `b${rng.int(0, 9)}`]
  if (rng.bool()) out.metadata = { tag: `t${rng.int(0, 99)}` }
  if (rng.bool()) out.logit_bias = { '50256': rng.int(-100, 100) }
  if (rng.bool()) out.thoughtSurfacing = rng.pick(THOUGHT_SURFACINGS)
  if (rng.bool()) out.selfIdentity = `agent_${rng.int(0, 99)}`
  if (rng.bool()) {
    const subset = shuffle(BUCKET_LABELS, rng).slice(0, rng.int(0, BUCKET_LABELS.length))
    out.bucketOrder = subset
  }
  if (enc !== null) {
    out.tokenEncoding = enc
    out.contextWindow = rng.int(1, 200_000)
  } else if (rng.bool()) {
    out.tokenEncoding = null
  }
  if (rng.bool()) out.streamIdleTimeoutMs = rng.int(0, 300_000)
  if (rng.bool()) out.requestTimeoutMs = rng.int(0, 60_000)
  if (rng.bool()) {
    out.retry = {
      maxAttempts: rng.int(1, 5),
      baseDelayMs: rng.int(1, 1000),
      maxDelayMs: rng.int(1000, 60_000),
    }
  }
  if (rng.bool()) {
    out.headers = {
      'X-Custom': `v${rng.int(0, 99)}`,
      'Authorization': `Bearer ${rng.int(0, 999_999)}`,
    }
  }
  if (rng.bool()) out.replayCompatibility = [`tag-${rng.int(0, 9)}`]
  return out
}

// ── Invalid-shape mutators ──────────────────────────────────────────────────
type Mutator = (rng: LCG) => { input: unknown; reason: string }

const invalidMutators: ReadonlyArray<Mutator> = [
  () => ({ input: { model: 'm', temperature: 5 }, reason: 'temperature > 2' }),
  () => ({ input: { model: 'm', temperature: -1 }, reason: 'temperature < 0' }),
  () => ({ input: { model: 'm', top_p: 2 }, reason: 'top_p > 1' }),
  () => ({ input: { model: 'm', frequency_penalty: 3 }, reason: 'frequency_penalty > 2' }),
  () => ({ input: { model: 'm', presence_penalty: -5 }, reason: 'presence_penalty < -2' }),
  () => ({ input: { model: 'm', n: 0 }, reason: 'n < 1' }),
  () => ({ input: { model: 'm', top_logprobs: 21 }, reason: 'top_logprobs > 20' }),
  () => ({ input: { model: 'm', service_tier: 'gold' }, reason: 'unknown service_tier' }),
  () => ({
    input: { model: 'm', reasoning_effort: 'extreme' },
    reason: 'unknown reasoning_effort',
  }),
  () => ({ input: { model: 'm', verbosity: 'max' }, reason: 'unknown verbosity' }),
  () => ({ input: { model: 'm', tokenEncoding: 'bpe' }, reason: 'unknown tokenEncoding' }),
  () => ({ input: { model: 'm', tokenEncoding: 42 }, reason: 'non-string tokenEncoding' }),
  () => ({
    input: { model: 'm', bucketOrder: 'standingInstructions' },
    reason: 'bucketOrder not array',
  }),
  () => ({
    input: { model: 'm', bucketOrder: ['memories', 'memories', 'timeline'] },
    reason: 'bucketOrder duplicates',
  }),
  () => ({
    input: { model: 'm', bucketOrder: ['standingInstructions', 'thoughts'] },
    reason: 'bucketOrder unknown label',
  }),
  () => ({ input: { model: 'm', contextWindow: 0 }, reason: 'contextWindow < 1' }),
  () => ({ input: { model: 'm', contextWindow: -1 }, reason: 'contextWindow negative' }),
  () => ({ input: { model: 'm', contextWindow: 'lots' }, reason: 'contextWindow non-number' }),
  () => ({
    input: { model: 'm', streamIdleTimeoutMs: -1 },
    reason: 'streamIdleTimeoutMs negative',
  }),
  () => ({
    input: { model: 'm', streamIdleTimeoutMs: '200ms' },
    reason: 'streamIdleTimeoutMs non-number',
  }),
  () => ({ input: { model: 'm', requestTimeoutMs: -10 }, reason: 'requestTimeoutMs negative' }),
  () => ({
    input: { model: 'm', retry: { maxAttempts: 0 } },
    reason: 'retry.maxAttempts < 1',
  }),
  () => ({
    input: { model: 'm', retry: { retriableStatuses: [200] } },
    reason:
      'retry.retriableStatuses ignored (200 outside retryable range — schema may accept; soft check)',
  }),
  () => ({ input: { model: 'm', selfIdentity: '' }, reason: 'empty selfIdentity' }),
  () => ({ input: { model: 'm', selfIdentity: 123 }, reason: 'non-string selfIdentity' }),
  () => ({
    input: { model: 'm', thoughtSurfacing: 'everything' },
    reason: 'unknown thoughtSurfacing',
  }),
  () => ({ input: { model: 'm', foo: 'bar' }, reason: 'unknown top-level key' }),
  () => ({ input: { model: 'm', bucketBudgets: { x: 1 } }, reason: 'removed bucketBudgets field' }),
  () => ({
    input: { model: 'm', maxInlineToolResultFraction: 0.05 },
    reason: 'removed maxInlineToolResultFraction field',
  }),
  () => ({ input: { model: 'm', apiKey: 123 }, reason: 'apiKey non-string' }),
  () => ({
    input: { model: 'm', headers: { Authorization: 123 } },
    reason: 'header value non-string',
  }),
  () => ({
    input: { model: 'm', tokenEncoding: 'cl100k_base' },
    reason: 'tokenEncoding set without contextWindow at construction (deferred runtime check)',
  }),
  () => ({ input: {}, reason: 'missing required model' }),
  () => ({ input: { model: 123 }, reason: 'model non-string' }),
  () => ({
    input: { model: 'm', replayCompatibility: 'tag' },
    reason: 'replayCompatibility not array',
  }),
  () => ({
    input: { model: 'm', replayCompatibility: [''] },
    reason: 'replayCompatibility empty element',
  }),
  () => ({
    input: { model: 'm', replayCompatibility: [123] },
    reason: 'replayCompatibility non-string element',
  }),
  () => ({ input: { model: 'm', stream: 'yes' }, reason: 'stream non-boolean' }),
  () => ({ input: { model: 'm', logprobs: 'yes' }, reason: 'logprobs non-boolean' }),
  () => ({
    input: { model: 'm', parallel_tool_calls: 1 },
    reason: 'parallel_tool_calls non-boolean',
  }),
  () => ({
    input: { model: 'm', helpers: { renderUntrustedContent: 'not a function' } },
    reason: 'non-function helper',
  }),
]

describe.skipIf(SKIP)('validation fuzz — valid shapes always accept', () => {
  it('1000 randomly-generated valid shapes all pass validateOptions', { timeout: 60_000 }, () => {
    const rng = new LCG(0xc0ffee)
    let okCount = 0
    const failures: Array<{ round: number; input: unknown; err: unknown }> = []

    for (let i = 0; i < 1000; i++) {
      const input = genValidOptions(rng)
      try {
        validateOptions(input)
        okCount += 1
      } catch (err) {
        failures.push({ round: i, input, err: (err as Error).message })
        if (failures.length > 5) break
      }
    }

    if (failures.length > 0) {
      // Surface the first few failures verbatim so a regression is debuggable.

      console.error('Valid-shape rejections:', JSON.stringify(failures, null, 2))
    }

    expect(failures).toEqual([])
    expect(okCount).toBe(1000)
  })
})

describe.skipIf(SKIP)('validation fuzz — invalid shapes always reject', () => {
  it(
    'each invalid mutator throws E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS — repeated 50 times',
    { timeout: 60_000 },
    () => {
      const rng = new LCG(0xdeadbeef)
      // A handful of mutators (the "soft check" comments) are intentional
      // probes that may or may not reject at the *schema* level (e.g.
      // tokenEncoding-without-contextWindow is enforced at iteration time,
      // not at validateOptions time, and retry.retriableStatuses: [200] is
      // shape-valid). We treat those as "must not crash" rather than "must
      // reject."
      const softMutatorReasons = new Set([
        'retry.retriableStatuses ignored (200 outside retryable range — schema may accept; soft check)',
        'tokenEncoding set without contextWindow at construction (deferred runtime check)',
      ])

      let total = 0
      let strictFailures = 0
      const failures: Array<{ reason: string; input: unknown }> = []

      for (let round = 0; round < 50; round++) {
        for (const mut of invalidMutators) {
          total += 1
          const { input, reason } = mut(rng)
          const isSoft = softMutatorReasons.has(reason)
          let threw = false
          let kind: string | undefined
          try {
            validateOptions(input as Record<string, unknown>)
          } catch (err) {
            threw = true
            kind = (err as { code?: string }).code
          }
          if (isSoft) {
            // Soft check — must not crash with a non-validation error.
            if (threw && kind && kind !== E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS.code) {
              failures.push({ reason, input })
              strictFailures += 1
            }
            continue
          }
          if (!threw) {
            failures.push({ reason, input })
            strictFailures += 1
            continue
          }
          if (kind !== E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS.code) {
            failures.push({ reason: `${reason} (wrong code: ${kind})`, input })
            strictFailures += 1
          }
        }
      }

      if (failures.length > 0) {
        console.error('Invalid-shape failures:', JSON.stringify(failures.slice(0, 10), null, 2))
      }

      expect(strictFailures).toBe(0)
      expect(total).toBeGreaterThan(0)
    }
  )
})

describe.skipIf(SKIP)('validation fuzz — bucketOrder permutations', () => {
  it('every subset+order of the four bucket labels (including empty) accepts', () => {
    // Enumerate all ordered subsets of the four bucket labels.
    const labels = ['standingInstructions', 'memories', 'retrievables', 'timeline'] as const
    const subsets: string[][] = [[]]
    for (const a of labels) {
      subsets.push([a])
      for (const b of labels) {
        if (b === a) continue
        subsets.push([a, b])
        for (const c of labels) {
          if (c === a || c === b) continue
          subsets.push([a, b, c])
          for (const d of labels) {
            if (d === a || d === b || d === c) continue
            subsets.push([a, b, c, d])
          }
        }
      }
    }

    let okCount = 0
    for (const subset of subsets) {
      validateOptions({ model: 'm', bucketOrder: subset })
      okCount += 1
    }
    // 1 empty + 4 singles + 12 pairs + 24 triples + 24 quads = 65
    expect(okCount).toBe(subsets.length)
    expect(subsets.length).toBeGreaterThanOrEqual(65)
  })
})
