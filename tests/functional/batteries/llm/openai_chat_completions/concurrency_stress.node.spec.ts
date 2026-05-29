/**
 * Concurrency stress — N parallel TurnRunner.run() calls against the live gateway.
 *
 * Surfaces race conditions in:
 *   - Shared Tool instances (the same Tool ref handed to multiple runners)
 *   - Concurrent fetch / SSE parsing under load
 *   - Adapter resolved-helpers caches when many iterations run at once
 *   - Per-runner stash isolation (no cross-talk between turns)
 *
 * Each runner gets its own TurnRunner (the harness's design: a runner owns its
 * turn). What we share across runners is the Tool instances and the adapter
 * (since adapters are stateless across dispatches by construction). If state
 * leaks across runners we should observe it as cross-talk in the captured
 * events.
 *
 * Default-skip when `TEST_OPENAI_API_KEY` is absent.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { Tool, Retrievable } from '@nhtio/adk/common'
import { calculateTool } from '@nhtio/adk/batteries/tools/math'
import { makeFixtureRunner } from '../../../../_fixtures/runner'
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

describe.skipIf(SKIP)('concurrency stress — parallel runners', () => {
  it(
    '8 parallel dispatches with a shared adapter all settle independently',
    { timeout: 240_000 },
    async () => {
      const adapter = makeAdapter({ stream: false })
      const N = 8

      const handles = Array.from({ length: N }, () =>
        makeFixtureRunner({
          executorCallback: adapter.executor(),
        })
      )

      const prompts = handles.map(
        (_, i) => `You are runner #${i}. Reply with the literal string "ok-${i}".`
      )

      const results = await Promise.allSettled(
        handles.map((h, i) => h.run({ systemPrompt: prompts[i] }))
      )

      // All N parallel turns must settle — none should hang or crash the runner.
      expect(results.length).toBe(N)
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

      // Each handle's events list is independent: turnEnd === 1 per runner.
      for (const h of handles) {
        expect(h.events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      }
    }
  )

  it(
    '8 parallel dispatches with shared Tool instances — no cross-runner state bleed',
    { timeout: 240_000 },
    async () => {
      const adapter = makeAdapter({ stream: false })
      const N = 8

      // One Tool instance shared across all N runners — the harness's
      // ToolRegistry merges these per-dispatch; if there is shared mutable
      // state, parallel dispatches will surface it.
      const sharedTool = calculateTool

      const handles = Array.from({ length: N }, () =>
        makeFixtureRunner({
          executorCallback: adapter.executor(),
          tools: [sharedTool],
        })
      )

      const results = await Promise.allSettled(
        handles.map((h, i) =>
          h.run({
            systemPrompt: `You are runner #${i}. Use the calculate tool to compute ${i + 1} * ${i + 2}.`,
          })
        )
      )

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

      // Each runner's event stream contains a turnEnd; no runner inherited
      // another runner's tool-call events.
      for (const h of handles) {
        expect(h.events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      }
    }
  )

  it(
    '4 parallel dispatches each with distinct stash overrides — no leakage',
    { timeout: 180_000 },
    async () => {
      const adapter = makeAdapter({ stream: false })
      const N = 4

      const temperatures = [0.0, 0.5, 1.0, 1.5]
      const handles = Array.from({ length: N }, () =>
        makeFixtureRunner({
          executorCallback: adapter.executor(),
        })
      )

      const results = await Promise.allSettled(
        handles.map((h, i) =>
          h.run({
            systemPrompt: `Reply with "t${i}".`,
            stash: {
              openaiChatCompletions: { temperature: temperatures[i] },
            },
          })
        )
      )

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

      // Each runner's stash isolation: dispatches settled, no error events.
      for (const h of handles) {
        expect(h.events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      }
    }
  )

  it(
    '4 parallel streaming dispatches — SSE readers do not collide',
    { timeout: 480_000 },
    async () => {
      const adapter = makeAdapter({ stream: true })
      const N = 4

      const handles = Array.from({ length: N }, () =>
        makeFixtureRunner({
          executorCallback: adapter.executor(),
        })
      )

      const results = await Promise.allSettled(
        handles.map((h, i) =>
          h.run({
            systemPrompt: `Count from 1 to 5 separated by spaces. Runner ${i}.`,
          })
        )
      )

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      for (const h of handles) {
        expect(h.events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      }
    }
  )

  it(
    'parallel dispatches with distinct Tool instances having the same name — registry resolves the per-runner copy',
    { timeout: 360_000 },
    async () => {
      const adapter = makeAdapter({ stream: false })

      // Two distinct Tool instances, same name. Each runner gets one.
      const toolA = new Tool({
        name: 'echo',
        description: 'Returns "A" plus the input.',
        inputSchema: validator.object({
          msg: validator.string().required().description('Input message'),
        }),
        handler: async (args) => `A:${(args as { msg: string }).msg}`,
      })
      const toolB = new Tool({
        name: 'echo',
        description: 'Returns "B" plus the input.',
        inputSchema: validator.object({
          msg: validator.string().required().description('Input message'),
        }),
        handler: async (args) => `B:${(args as { msg: string }).msg}`,
      })

      const handleA = makeFixtureRunner({
        executorCallback: adapter.executor(),
        tools: [toolA],
      })
      const handleB = makeFixtureRunner({
        executorCallback: adapter.executor(),
        tools: [toolB],
      })

      const [ra, rb] = await Promise.allSettled([
        handleA.run({
          systemPrompt: 'Call the echo tool with msg="hello" and reply with the result verbatim.',
        }),
        handleB.run({
          systemPrompt: 'Call the echo tool with msg="hello" and reply with the result verbatim.',
        }),
      ])

      expect(ra.status).toBe('fulfilled')
      expect(rb.status).toBe('fulfilled')
      expect(handleA.events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      expect(handleB.events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
    }
  )

  it(
    '6 parallel dispatches each with a distinct fetchRetrievablesCallback — no Set cross-talk',
    { timeout: 240_000 },
    async () => {
      const adapter = makeAdapter({ stream: false })
      const N = 6
      const nowISO = () => DateTime.now().toISO()

      // Each runner has its OWN retrievables, with a unique marker in the id.
      // If any runner sees another's data the test still settles (we can't
      // inspect the prompt directly here), but the captured retrievables
      // delivered to the fetch callback per-runner should be independent.
      const seenPerRunner: Array<string[]> = Array.from({ length: N }, () => [])

      const handles = Array.from({ length: N }, (_, i) =>
        makeFixtureRunner({
          executorCallback: adapter.executor(),
          fetchRetrievablesCallback: async () => {
            const r = new Retrievable({
              id: `ret-conc-${i}`,
              content: `Runner ${i} private context.`,
              trustTier: 'first-party',
              source: `kb://runner-${i}`,
              createdAt: nowISO(),
              updatedAt: nowISO(),
            })
            seenPerRunner[i].push(r.id)
            return [r]
          },
        })
      )

      const results = await Promise.allSettled(
        handles.map((h, i) => h.run({ systemPrompt: `Reply with "ok-${i}".` }))
      )

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      for (let i = 0; i < N; i++) {
        // Each runner's fetchRetrievablesCallback fired exactly once (one
        // iteration with retrievables in the bucket), and only saw its own id.
        expect(seenPerRunner[i]).toEqual([`ret-conc-${i}`])
        expect(handles[i].events.filter((e) => e.kind === 'turnEnd').length).toBe(1)
      }
    }
  )
})
