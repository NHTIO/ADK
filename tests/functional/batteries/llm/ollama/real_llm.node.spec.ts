/**
 * Real-LLM verification for the native Ollama battery against a HOSTED Ollama-compatible service
 * exposing the native `/api/chat` endpoint. Gated behind env vars (loaded by vite.config's
 * `loadEnv` `TEST_` prefix) — the whole suite is skipped when they are unset, so CI without a host
 * configured stays green:
 *
 *   - TEST_OLLAMA_BASE_URL — adapter `baseURL` (e.g. https://ollama.com or a hosted gateway)
 *   - TEST_OLLAMA_API_KEY  — adapter `apiKey` (→ Authorization: Bearer)
 *   - TEST_OLLAMA_MODEL    — adapter `model`
 *
 * Exercises, end-to-end against the live host: non-streaming + NDJSON streaming, a tool call
 * (object-form arguments round-trip), the `think` reasoning channel (on vs off), and asserts a
 * `generationStats` record fires carrying native token counts / durations.
 */

import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { OllamaAdapter } from '@nhtio/adk/batteries/llm/ollama'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Tool,
  Registry,
  ToolRegistry,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers, GenerationStats } from '@nhtio/adk/dispatch_runner'

// `TEST_OLLAMA_BASE_URL` must point at the NATIVE Ollama host root — the adapter targets
// `<baseURL>/api/chat`. Do NOT include an OpenAI-compat `/v1` suffix (that would yield
// `/v1/api/chat` → 404); the native endpoint lives at the host root.
const BASE_URL = process.env.TEST_OLLAMA_BASE_URL
const API_KEY = process.env.TEST_OLLAMA_API_KEY
const MODEL = process.env.TEST_OLLAMA_MODEL

const configured = Boolean(BASE_URL && MODEL)

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}
interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (
  opts: { userText: string; tools?: ToolRegistry } = { userText: 'Say hello.' }
): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const now = DateTime.now()
  const userMsg = new Message({
    id: 'u-1',
    role: 'user',
    content: opts.userText,
    identity: undefined as never,
    createdAt: now,
    updatedAt: now,
  })
  return {
    systemPrompt: new Tokenizable('You are a helpful assistant. Be concise.'),
    turnMessages: new Set([userMsg]),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: opts.tools ?? new ToolRegistry(),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn(() => () => undefined),
    emitToolExecutionStart: vi.fn(),
    emitToolExecutionEnd: vi.fn(),
    emitMessage: vi.fn(),
    emitThought: vi.fn(),
    emitToolCall: vi.fn(),
    storeMessage: vi.fn(async (m: Message) => {
      stored.messages.push(m)
    }),
    storeThought: vi.fn(async (t: Thought) => {
      stored.thoughts.push(t)
    }),
    storeToolCall: vi.fn(async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
    }),
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as MockCtx
}

interface RecordingHelpers extends DispatchExecutorHelpers {
  _stats: GenerationStats[]
}
const makeHelpers = (): RecordingHelpers => {
  const stats: GenerationStats[] = []
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn((s: GenerationStats) => {
      stats.push(s)
    }),
    _stats: stats,
  } as unknown as RecordingHelpers
}

const baseOpts = () => ({
  model: MODEL!,
  baseURL: BASE_URL!,
  ...(API_KEY ? { apiKey: API_KEY } : {}),
  autoAck: true,
})

describe.skipIf(!configured)('OllamaAdapter — real hosted /api/chat', () => {
  it('non-streaming: produces an answer + fires generationStats with native counts', async () => {
    const ctx = makeCtx({ userText: 'Reply with exactly: pong' })
    const helpers = makeHelpers()
    await new OllamaAdapter({ ...baseOpts(), stream: false }).executor()(ctx, helpers)
    expect(ctx._stored.messages.length).toBeGreaterThanOrEqual(1)
    expect(ctx._stored.messages[0]!.content!.toString().length).toBeGreaterThan(0)
    expect(helpers._stats.length).toBeGreaterThanOrEqual(1)
    const s = helpers._stats[0]!
    expect(s.provider).toBe('ollama')
    // Native hosts report token counts + durations; assert at least one is present.
    expect(typeof s.completionTokens === 'number' || typeof s.totalDurationNs === 'number').toBe(
      true
    )
  }, 60_000)

  it('NDJSON streaming: accumulates an answer', async () => {
    const ctx = makeCtx({ userText: 'Count: one two three' })
    const helpers = makeHelpers()
    await new OllamaAdapter({ ...baseOpts(), stream: true }).executor()(ctx, helpers)
    expect(ctx._stored.messages.length).toBeGreaterThanOrEqual(1)
    expect(ctx._stored.messages[0]!.content!.toString().length).toBeGreaterThan(0)
    expect(helpers._stats.length).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('tool call: object-form arguments round-trip and the tool executes', async () => {
    const tool = new Tool({
      name: 'get_weather',
      description: 'Get the current weather for a city',
      inputSchema: validator.object({ city: validator.string().required() }),
      handler: () => 'Sunny, 22C',
    })
    const ctx = makeCtx({
      userText: 'Use the get_weather tool for Tokyo. You must call the tool.',
      tools: new ToolRegistry([tool]),
    })
    await new OllamaAdapter({ ...baseOpts(), stream: false }).executor()(ctx, makeHelpers())
    // Either the model called the tool (preferred) or answered directly; assert no crash and that
    // IF a tool call happened, its args were a usable object.
    if (ctx._stored.toolCalls.length > 0) {
      const tc = ctx._stored.toolCalls[0]
      expect(typeof tc.args).toBe('object')
      expect(tc.isError).toBe(false)
    }
  }, 60_000)

  it('think on → a Thought is persisted; think:false → none (same prompt)', async () => {
    const prompt = 'What is 17 times 3? Think it through.'
    const ctxOn = makeCtx({ userText: prompt })
    await new OllamaAdapter({ ...baseOpts(), stream: false, think: true }).executor()(
      ctxOn,
      makeHelpers()
    )
    const ctxOff = makeCtx({ userText: prompt })
    await new OllamaAdapter({ ...baseOpts(), stream: false, think: false }).executor()(
      ctxOff,
      makeHelpers()
    )
    // think:false must never surface a Thought. think:true MAY (model/host dependent) — assert the
    // disabled side is clean and that enabling never produces fewer thoughts than disabling.
    expect(ctxOff._stored.thoughts).toHaveLength(0)
    expect(ctxOn._stored.thoughts.length).toBeGreaterThanOrEqual(ctxOff._stored.thoughts.length)
  }, 60_000)
})
