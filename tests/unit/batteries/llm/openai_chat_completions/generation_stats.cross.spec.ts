/**
 * Generation-stats coverage for the OpenAI Chat Completions adapter.
 *
 * The adapter previously never called `helpers.reportGenerationStats` at all — on either the
 * streaming or non-streaming path — even though `finish_reason`/`usage` are genuinely present on
 * the wire and already typed. These tests assert:
 *
 *   1. Non-streaming: `reportGenerationStats` fires once, with `finish_reason` and token counts
 *      read from the response body.
 *   2. Streaming: the adapter defaults `stream_options: { include_usage: true }` into the
 *      request body (unless the consumer already set one), and reads `usage`/`finish_reason`
 *      back off the SSE stream — even though OpenAI splits them across two different chunks
 *      (`finish_reason` on the last content chunk, `usage` on a separate final chunk with an
 *      EMPTY `choices` array).
 *   3. A consumer-supplied `stream_options` is left untouched (the default never overrides it).
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { describe, expect, it, vi } from 'vitest'
import { Tokenizable, ToolRegistry, Registry } from '@nhtio/adk/common'
import { OpenAIChatCompletionsAdapter } from '@nhtio/adk/batteries/llm/openai_chat_completions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Message, Thought, ToolCall } from '@nhtio/adk/common'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

interface StoredState {
  toolCalls: ToolCall[]
  messages: Message[]
  thoughts: Thought[]
}

interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (): MockCtx => {
  const stored: StoredState = { toolCalls: [], messages: [], thoughts: [] }
  return {
    systemPrompt: new Tokenizable('You are a helpful assistant.'),
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: new ToolRegistry(),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn((_handler: () => void) => () => undefined),
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
    mutateToolCall: vi.fn(),
    _stored: stored,
  } as unknown as MockCtx
}

const makeHelpers = (): DispatchExecutorHelpers & {
  _stats: Array<Record<string, unknown>>
} => {
  const stats: Array<Record<string, unknown>> = []
  const noopLog = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: {
      trace: noopLog,
      debug: noopLog,
      info: noopLog,
      warn: noopLog,
      error: noopLog,
    },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => {
      stats.push(s)
    }),
    _stats: stats,
  } as unknown as DispatchExecutorHelpers & { _stats: typeof stats }
}

const getRequestBody = (call: unknown): Record<string, unknown> => {
  const init = (call as [string | URL, RequestInit])[1]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const nonStreamingResponse = (opts: {
  content?: string
  finishReason?: string | null
  usage?: Record<string, unknown>
  model?: string
}) =>
  jsonResponse({
    id: 'resp-stats',
    object: 'chat.completion',
    created: 1,
    model: opts.model ?? 'gpt-x',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: opts.content ?? 'hi there' },
        finish_reason: opts.finishReason ?? 'stop',
      },
    ],
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  })

// Builds an SSE Response emitting one content chunk (with `finish_reason`), then — mirroring
// OpenAI's real behavior — a SEPARATE final chunk with an EMPTY `choices` array carrying `usage`,
// then `[DONE]`.
const streamingResponseWithSplitUsage = (opts: {
  content?: string
  finishReason?: string
  usage?: Record<string, unknown>
  model?: string
}): Response => {
  const model = opts.model ?? 'gpt-x'
  const contentChunk = {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    model,
    choices: [
      {
        index: 0,
        delta: { content: opts.content ?? 'hi there' },
        finish_reason: null,
      },
    ],
  }
  const finishChunk = {
    id: 'chunk-2',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason ?? 'stop' }],
  }
  const usageChunk = {
    id: 'chunk-3',
    object: 'chat.completion.chunk',
    model,
    choices: [],
    usage: opts.usage,
  }
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('OpenAIChatCompletionsAdapter — generation stats', () => {
  describe('non-streaming', () => {
    it('reports generationStats once with finishReason and token counts', async () => {
      const fetchFn = vi.fn(async () =>
        nonStreamingResponse({
          finishReason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(1)
      const stats = helpers._stats[0]
      expect(stats.finishReason).toBe('stop')
      expect(stats.promptTokens).toBe(10)
      expect(stats.completionTokens).toBe(5)
      expect(stats.totalTokens).toBe(15)
      expect(stats.provider).toBe('openai_chat_completions')
    })

    it('reports generationStats even when usage is absent (finishReason alone)', async () => {
      const fetchFn = vi.fn(async () => nonStreamingResponse({ finishReason: 'length' }))
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(1)
      expect(helpers._stats[0].finishReason).toBe('length')
      expect(helpers._stats[0].promptTokens).toBeUndefined()
    })

    it('reports generationStats when choices is empty but usage is present', async () => {
      // Regression: a content-filtered / empty completion can still carry billed `usage` with an
      // empty `choices` array. The early `!choice` return must not swallow that usage.
      const fetchFn = vi.fn(async () =>
        jsonResponse({
          id: 'resp-empty-choices',
          model: 'gpt-x',
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
        })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(1)
      expect(helpers._stats[0].promptTokens).toBe(12)
      expect(helpers._stats[0].totalTokens).toBe(12)
      expect(ctx._stored.messages).toHaveLength(0)
    })

    it('does NOT report generationStats when choices is empty and there is no usage', async () => {
      const fetchFn = vi.fn(async () =>
        jsonResponse({ id: 'resp-truly-empty', model: 'gpt-x', choices: [] })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(0)
    })
  })

  describe('streaming', () => {
    it('defaults stream_options.include_usage into the request body', async () => {
      const fetchFn = vi.fn(async () => streamingResponseWithSplitUsage({}))
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
      })
      const ctx = makeCtx()

      await adapter.executor()(ctx, makeHelpers())

      const sentBody = getRequestBody(fetchFn.mock.calls[0])
      expect(sentBody.stream_options).toEqual({ include_usage: true })
    })

    it('does NOT override a consumer-supplied stream_options', async () => {
      const fetchFn = vi.fn(async () => streamingResponseWithSplitUsage({}))
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
        stream_options: { include_usage: false, include_obfuscation: true },
      })
      const ctx = makeCtx()

      await adapter.executor()(ctx, makeHelpers())

      const sentBody = getRequestBody(fetchFn.mock.calls[0])
      expect(sentBody.stream_options).toEqual({ include_usage: false, include_obfuscation: true })
    })

    it('reports generationStats reassembled from two different chunks (finish_reason + usage)', async () => {
      // Regression: OpenAI sends `finish_reason` on the last CONTENT chunk, then usage on a
      // SEPARATE final chunk with an EMPTY `choices` array. A naive "read stats off the last
      // chunk" implementation would lose one or the other.
      const fetchFn = vi.fn(async () =>
        streamingResponseWithSplitUsage({
          finishReason: 'stop',
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(1)
      const stats = helpers._stats[0]
      expect(stats.finishReason).toBe('stop')
      expect(stats.promptTokens).toBe(20)
      expect(stats.completionTokens).toBe(8)
      expect(stats.totalTokens).toBe(28)
    })

    it('does NOT report generationStats when the stream carries no usage or finish_reason', async () => {
      // A backend that ignores `stream_options` (or omits `finish_reason` on every chunk) should
      // not produce a synthetic all-undefined stats event.
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
              })}\n\n`
            )
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      const fetchFn = vi.fn(
        async () =>
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(0)
    })

    it('does NOT treat a present-but-null usage chunk as real usage', async () => {
      // Regression: a bare `chunk.usage !== undefined` check is satisfied by `usage: null`,
      // which some backends send on non-final chunks — that must not mark usage as "available"
      // and must not, on its own, produce a synthetic stats event.
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
                usage: null,
              })}\n\n`
            )
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      const fetchFn = vi.fn(
        async () =>
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(0)
    })

    it('preserves provider metadata split across the finish and usage chunks in raw', async () => {
      // Regression: the finish-reason chunk and the usage chunk can each carry distinct
      // provider-native metadata (e.g. `id` on one, `system_fingerprint` on the other). Reading
      // `raw` off only the single last-seen chunk would silently drop whichever chunk lost.
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
              })}\n\n`
            )
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'chunk-finish-id',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              })}\n\n`
            )
          )
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                system_fingerprint: 'fp_abc123',
                choices: [],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
              })}\n\n`
            )
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      const fetchFn = vi.fn(
        async () =>
          new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      expect(helpers._stats).toHaveLength(1)
      const raw = helpers._stats[0].raw as Record<string, unknown>
      expect(raw.id).toBe('chunk-finish-id')
      expect(raw.system_fingerprint).toBe('fp_abc123')
    })
  })
})
