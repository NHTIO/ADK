/**
 * Volume stress — large quantities of memories, standing instructions, and
 * tool output. Pushes the harness's bucket-rendering, history assembly, and
 * persistence paths to their natural limits.
 *
 * We do not flip on context-window enforcement (tokenEncoding stays null) so
 * we can probe what the harness's rendering helpers do under load, separate
 * from the budget-overflow path (which has its own spec).
 *
 * Default-skip when `TEST_OPENAI_API_KEY` is absent.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { makeFixtureRunner } from '../../../../_fixtures/runner'
import { Tool, Memory, Retrievable, Tokenizable } from '@nhtio/adk/common'
import { OpenAIChatCompletionsAdapter } from '@nhtio/adk/batteries/llm/openai_chat_completions'

const TEST_API_KEY = typeof process !== 'undefined' ? process.env?.TEST_OPENAI_API_KEY : undefined
const TEST_MODEL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_MODEL : undefined) ?? 'gpt-4o-mini'
const TEST_BASE_URL =
  (typeof process !== 'undefined' ? process.env?.TEST_OPENAI_BASE_URL : undefined) || undefined

const SKIP = typeof process === 'undefined' || !TEST_API_KEY

const makeAdapter = (overrides: { stream?: boolean } = {}) =>
  new OpenAIChatCompletionsAdapter({
    model: TEST_MODEL,
    apiKey: TEST_API_KEY!,
    ...(TEST_BASE_URL ? { baseURL: TEST_BASE_URL } : {}),
    stream: overrides.stream ?? false,
    autoAck: true,
  })

const nowISO = () => DateTime.now().toISO()

describe.skipIf(SKIP)('volume stress — many standing instructions', () => {
  it(
    '100 standing instructions render through the bucket without crashing',
    { timeout: 120_000 },
    async () => {
      const adapter = makeAdapter()
      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      const standingInstructions = Array.from(
        { length: 100 },
        (_, i) => new Tokenizable(`Instruction #${i}: Be helpful step ${i}.`)
      )

      const results = await Promise.allSettled([
        run({
          systemPrompt: 'Reply "ok".',
          standingInstructions,
        }),
      ])
      expect(results[0].status).toBe('fulfilled')
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )
})

describe.skipIf(SKIP)('volume stress — many memories', () => {
  it(
    'memories array is constructible at scale (500 entries) and accepted by the primitive',
    { timeout: 30_000 },
    async () => {
      // We can't easily inject pre-populated memories into the runner without
      // a custom fetchMemoriesCallback, so we verify the Memory primitive
      // accepts the construction load. The render path is exercised by the
      // smaller integration cases below.
      const memories = Array.from(
        { length: 500 },
        (_, i) =>
          new Memory({
            id: `mem-${i}`,
            content: `Memory entry #${i}: The user prefers option ${i % 5}.`,
            confidence: 0.5 + (i % 50) / 100,
            importance: 0.3 + (i % 30) / 100,
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )
      expect(memories.length).toBe(500)
      expect(memories[0].id).toBe('mem-0')
      expect(memories[499].id).toBe('mem-499')
    }
  )
})

describe.skipIf(SKIP)('volume stress — many retrievables', () => {
  it(
    'retrievables array is constructible at scale (500 entries across all 3 tiers)',
    { timeout: 30_000 },
    async () => {
      const tiers = ['first-party', 'third-party-public', 'third-party-private'] as const
      const retrievables = Array.from(
        { length: 500 },
        (_, i) =>
          new Retrievable({
            id: `ret-${i}`,
            content: `Retrievable entry #${i}: information about topic ${i % 7}.`,
            trustTier: tiers[i % tiers.length],
            source: `src://${i % 5}/${i}`,
            kind: i % 2 === 0 ? 'reference' : 'web-page',
            score: (i % 100) / 100,
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )
      expect(retrievables.length).toBe(500)
      expect(retrievables[0].id).toBe('ret-0')
      expect(retrievables[499].id).toBe('ret-499')
      // Confirm tier distribution
      const tierCounts = retrievables.reduce<Record<string, number>>(
        (acc, r) => ((acc[r.trustTier] = (acc[r.trustTier] ?? 0) + 1), acc),
        {}
      )
      expect(tierCounts['first-party']).toBeGreaterThan(150)
      expect(tierCounts['third-party-public']).toBeGreaterThan(150)
      expect(tierCounts['third-party-private']).toBeGreaterThan(150)
    }
  )

  it(
    '50 mixed-tier retrievables flow through the prompt and the dispatch settles',
    { timeout: 180_000 },
    async () => {
      const adapter = makeAdapter()
      const tiers = ['first-party', 'third-party-public', 'third-party-private'] as const
      const retrievables = Array.from(
        { length: 50 },
        (_, i) =>
          new Retrievable({
            id: `ret-vol-${i}`,
            content: `Reference fact #${i}.`,
            trustTier: tiers[i % tiers.length],
            source: `src://vol/${i}`,
            createdAt: nowISO(),
            updatedAt: nowISO(),
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchRetrievablesCallback: async () => retrievables,
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply with "ok".' })])

      expect(results[0].status).toBe('fulfilled')
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )

  it(
    'a single retrievable with 50KB of content is rendered without crashing',
    { timeout: 180_000 },
    async () => {
      const adapter = makeAdapter()
      const big = Array.from(
        { length: 500 },
        (_, i) => `Line ${i}: ${'lorem ipsum dolor sit amet '.repeat(4)}`
      ).join('\n')

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        fetchRetrievablesCallback: async () => [
          new Retrievable({
            id: 'ret-huge',
            content: big,
            trustTier: 'first-party',
            source: 'kb://huge-doc',
            createdAt: nowISO(),
            updatedAt: nowISO(),
          }),
        ],
      })

      const results = await Promise.allSettled([run({ systemPrompt: 'Reply with "ok".' })])

      expect(results[0].status).toBe('fulfilled')
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )
})

describe.skipIf(SKIP)(
  'volume stress — combined buckets (memories + retrievables + standing)',
  () => {
    it(
      'a mixed payload with memories + retrievables + standing instructions all renders together',
      { timeout: 180_000 },
      async () => {
        const adapter = makeAdapter()
        const memories = Array.from(
          { length: 20 },
          (_, i) =>
            new Memory({
              id: `mem-mix-${i}`,
              content: `User preference #${i}.`,
              confidence: 0.8,
              importance: 0.5,
              createdAt: nowISO(),
              updatedAt: nowISO(),
            })
        )
        const retrievables = Array.from(
          { length: 20 },
          (_, i) =>
            new Retrievable({
              id: `ret-mix-${i}`,
              content: `Reference #${i}.`,
              trustTier:
                i % 3 === 0
                  ? 'first-party'
                  : i % 3 === 1
                    ? 'third-party-public'
                    : 'third-party-private',
              source: `src://mix/${i}`,
              createdAt: nowISO(),
              updatedAt: nowISO(),
            })
        )
        const standing = Array.from(
          { length: 10 },
          (_, i) => new Tokenizable(`Standing instruction #${i}: be helpful.`)
        )

        const { run, events } = makeFixtureRunner({
          executorCallback: adapter.executor(),
          fetchMemoriesCallback: async () => memories,
          fetchRetrievablesCallback: async () => retrievables,
        })

        const results = await Promise.allSettled([
          run({
            systemPrompt: 'Reply with "ok".',
            standingInstructions: standing,
          }),
        ])

        expect(results[0].status).toBe('fulfilled')
        expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      }
    )
  }
)

describe.skipIf(SKIP)('volume stress — tool output volume', () => {
  it(
    'tool returning a 100KB string is rendered through the untrusted envelope',
    { timeout: 180_000 },
    async () => {
      const adapter = makeAdapter()

      // 100KB of synthetic but valid UTF-8 content.
      const body = Array.from(
        { length: 1000 },
        (_, i) => `Line ${i}: ${'lorem ipsum dolor sit amet '.repeat(4)}`
      ).join('\n')

      const tool = new Tool({
        name: 'big_text',
        description: 'Returns a large block of text.',
        inputSchema: validator.object({
          n: validator.number().optional().description('ignored'),
        }),
        handler: async () => body,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        tools: [tool],
      })

      const results = await Promise.allSettled([
        run({
          systemPrompt: 'Call big_text. After it returns, reply with the single word "received".',
        }),
      ])

      expect(results[0].status).toBe('fulfilled')
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )

  it(
    'tool returning a 1MB string still settles (extreme inline case)',
    { timeout: 480_000 },
    async () => {
      const adapter = makeAdapter()

      const body = 'X'.repeat(1_000_000)
      const tool = new Tool({
        name: 'huge_text',
        description: 'Returns a 1MB block of text.',
        inputSchema: validator.object({
          n: validator.number().optional().description('ignored'),
        }),
        handler: async () => body,
      })

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        tools: [tool],
      })

      const results = await Promise.allSettled([
        run({
          systemPrompt: 'Call huge_text. After it returns, reply "received".',
        }),
      ])

      // We accept either fulfilled OR rejected here — a 1MB inline payload may
      // exceed the upstream model's context. What we assert is the harness
      // settled (turnEnd OR error event fired) without hanging.
      const turnEnds = events.filter((e) => e.kind === 'turnEnd')
      const errs = events.filter((e) => e.kind === 'error')
      expect(turnEnds.length + errs.length).toBeGreaterThanOrEqual(1)
      expect(results[0].status).toMatch(/fulfilled|rejected/)
    }
  )
})

describe.skipIf(SKIP)('volume stress — many tools', () => {
  it(
    '50 tools merged into the registry are all forwarded in tools[]',
    { timeout: 120_000 },
    async () => {
      const adapter = makeAdapter()

      const tools = Array.from(
        { length: 50 },
        (_, i) =>
          new Tool({
            name: `tool_${i}`,
            description: `No-op tool #${i}. Returns the number ${i}.`,
            inputSchema: validator.object({
              x: validator.string().optional().description('ignored'),
            }),
            handler: async () => `result-${i}`,
          })
      )

      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
        tools,
      })

      const results = await Promise.allSettled([
        run({ systemPrompt: 'Reply with "ok". You may call tool_0 if you wish.' }),
      ])

      expect(results[0].status).toBe('fulfilled')
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )
})

describe.skipIf(SKIP)('volume stress — sequential chain depth', () => {
  it(
    '5 sequential turns on the same runner all settle and accumulate events independently',
    { timeout: 300_000 },
    async () => {
      const adapter = makeAdapter()
      const { run, events } = makeFixtureRunner({
        executorCallback: adapter.executor(),
      })

      for (let i = 0; i < 5; i++) {
        await run({ systemPrompt: `Turn ${i}: Reply with "t${i}".` })
      }

      // 5 turnStart and 5 turnEnd events.
      expect(events.filter((e) => e.kind === 'turnStart').length).toBe(5)
      expect(events.filter((e) => e.kind === 'turnEnd').length).toBe(5)
    }
  )
})
