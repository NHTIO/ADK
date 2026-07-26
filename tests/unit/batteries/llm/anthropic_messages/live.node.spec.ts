import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicMessagesAdapter,
  E_ANTHROPIC_MESSAGES_HTTP_ERROR,
} from '@nhtio/adk/batteries/llm/anthropic_messages'
import {
  inMemoryMediaReader,
  Media,
  Message,
  Registry,
  Thought,
  Tool,
  ToolCall,
  ToolRegistry,
  Tokenizable,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const LIVE_RETRY = 2
const LIVE_TIMEOUT = 90_000
const DIRECT_MODEL = 'claude-haiku-4-5-20251001'
const LB_PASSTHROUGH_MODEL = 'claude-haiku-4-5-20251001'

interface LiveRow {
  label: string
  apiKey?: string
  baseURL?: string
  model?: string
}

const row0: LiveRow = {
  label: 'direct api.anthropic.com',
  apiKey: process.env.TEST_ANTHROPIC_API_KEY,
  model: DIRECT_MODEL,
}

const row1: LiveRow = {
  label: 'LB pass-through',
  apiKey: process.env.TEST_ANTHROPIC_LB_API_KEY,
  baseURL: process.env.TEST_ANTHROPIC_LB_BASE_URL,
  model: LB_PASSTHROUGH_MODEL,
}

const row2: LiveRow = {
  label: 'LB translating',
  apiKey: process.env.TEST_ANTHROPIC_XLAT_API_KEY,
  baseURL: process.env.TEST_ANTHROPIC_XLAT_BASE_URL,
  model: process.env.TEST_ANTHROPIC_XLAT_MODEL,
}

const enabled = (row: LiveRow, needsBaseURL = false): row is Required<LiveRow> =>
  Boolean(row.apiKey && row.model && (!needsBaseURL || row.baseURL))

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })
const now = dt('2026-01-01T12:00:00Z')

// `attachments` must be OMITTED when empty — the Message schema treats it as an array with a
// required member, so passing `[]` fails validation with "does not contain 1 required value(s)".
const makeMessage = (content: string, attachments: Media[] = []) =>
  new Message({
    id: `m-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: now,
    updatedAt: now,
  })

interface LiveCtx extends DispatchContext {
  _stored: { messages: Message[]; thoughts: Thought[]; toolCalls: ToolCall[] }
}

const makeCtx = (input: {
  message?: Message
  systemPrompt?: string
  thoughts?: Thought[]
  toolCalls?: ToolCall[]
  tools?: ToolRegistry
}): LiveCtx => {
  const stored = {
    messages: [] as Message[],
    thoughts: [] as Thought[],
    toolCalls: [] as ToolCall[],
  }
  return {
    systemPrompt: new Tokenizable(input.systemPrompt ?? 'You are a terse test assistant.'),
    turnMessages: new Set(input.message ? [input.message] : []),
    turnThoughts: new Set(input.thoughts ?? []),
    turnToolCalls: new Set(input.toolCalls ?? []),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: input.tools ?? new ToolRegistry(),
    stash: new Registry(),
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
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as LiveCtx
}

const makeHelpers = (): DispatchExecutorHelpers & {
  _stats: Array<Record<string, unknown>>
} => {
  const stats: Array<Record<string, unknown>> = []
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => stats.push(s)),
    _stats: stats,
  } as unknown as DispatchExecutorHelpers & {
    _stats: Array<Record<string, unknown>>
  }
}

const adapterFor = (row: Required<LiveRow>, stream: boolean, extra = {}) =>
  new AnthropicMessagesAdapter({
    apiKey: row.apiKey,
    baseURL: row.baseURL,
    model: row.model,
    maxTokens: 256,
    stream,
    requestTimeoutMs: LIVE_TIMEOUT,
    autoAck: true,
    ...extra,
  })

const fetchWithRequestBodies = (bodies: Array<Record<string, unknown>>): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string')
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return fetch(input, init)
  }) as typeof fetch

const echoTool = () =>
  new Tool({
    name: 'echo_live_value',
    description: 'Echoes a short value.',
    inputSchema: validator.object({ value: validator.string().required() }).unknown(false),
    handler: async (args: unknown) => `echo:${(args as { value: string }).value}`,
  })

const tinyPng = () =>
  Media.userAttachment({
    kind: 'image',
    mimeType: 'image/png',
    filename: 'one-pixel.png',
    reader: inMemoryMediaReader(
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
    ),
  })

const assertTextGenerated = (ctx: { _stored: { messages: Message[] } }) => {
  expect(ctx._stored.messages.length).toBeGreaterThan(0)
  expect(ctx._stored.messages[0]!.content?.toString().length ?? 0).toBeGreaterThan(0)
}

const assertHttp400Nack = (ctx: DispatchContext) => {
  expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_ANTHROPIC_MESSAGES_HTTP_ERROR))
  const err = vi.mocked(ctx.nack).mock.calls[0]?.[0] as Error | undefined
  expect(err?.message).toContain('400')
}

const runNativeFidelityAssertions = (row: Required<LiveRow>) => {
  it('non-streaming text completes', { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT }, async () => {
    const ctx = makeCtx({
      message: makeMessage('Reply with exactly: live-ok'),
    })
    await adapterFor(row, false).executor()(ctx, makeHelpers())
    assertTextGenerated(ctx)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })

  it(
    'SSE streaming yields text and latches usage from the final usage-bearing event',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const ctx = makeCtx({
        message: makeMessage('Reply with a three-word sentence.'),
      })
      const helpers = makeHelpers()
      await adapterFor(row, true).executor()(ctx, helpers)
      assertTextGenerated(ctx)
      expect(vi.mocked(helpers.reportMessage).mock.calls.length).toBeGreaterThan(0)
      expect(Number(helpers._stats.at(-1)?.promptTokens ?? 0)).toBeGreaterThan(0)
    }
  )

  it('tool-call round-trip completes', { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT }, async () => {
    const ctx = makeCtx({
      message: makeMessage('Call echo_live_value with value "abc". Do not answer in prose.'),
      tools: new ToolRegistry([echoTool()]),
    })
    await adapterFor(row, false, {
      toolChoice: { type: 'tool', name: 'echo_live_value' },
    }).executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.tool).toBe('echo_live_value')
    expect(ctx._stored.toolCalls[0]!.isError).toBe(false)
  })

  it(
    'countTokens returns a positive input token count',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const counted = await adapterFor(row, false).countTokens({
        messages: [{ role: 'user', content: 'Count this tiny prompt.' }],
      })
      expect(counted.inputTokens).toBeGreaterThan(0)
    }
  )

  it(
    'cache_control records a cache creation and then a cache read on an identical call',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT * 2 },
    async () => {
      const cacheText = `Cache this exact prefix. ${'anthropic prompt cache live test '.repeat(220)}`
      const firstHelpers = makeHelpers()
      await adapterFor(row, false, { cacheBreakpoints: 'auto' }).executor()(
        makeCtx({
          systemPrompt: cacheText,
          message: makeMessage('Answer with one word: first'),
        }),
        firstHelpers
      )
      const firstUsage = firstHelpers._stats.at(-1)?.raw as {
        usage?: Record<string, number>
      }
      expect(firstUsage.usage?.cache_creation_input_tokens ?? 0).toBeGreaterThan(0)

      const secondHelpers = makeHelpers()
      await adapterFor(row, false, { cacheBreakpoints: 'auto' }).executor()(
        makeCtx({
          systemPrompt: cacheText,
          message: makeMessage('Answer with one word: first'),
        }),
        secondHelpers
      )
      const secondUsage = secondHelpers._stats.at(-1)?.raw as {
        usage?: Record<string, number>
      }
      expect(secondUsage.usage?.cache_read_input_tokens ?? 0).toBeGreaterThan(0)
    }
  )

  it(
    'vision accepts a base64 image attachment',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const ctx = makeCtx({
        message: makeMessage('What kind of file is attached? Answer briefly.', [tinyPng()]),
      })
      await adapterFor(row, false).executor()(ctx, makeHelpers())
      assertTextGenerated(ctx)
    }
  )
}

describe.skipIf(!enabled(row0))(`AnthropicMessagesAdapter — live: ${row0.label}`, () => {
  const row = row0 as Required<LiveRow>
  runNativeFidelityAssertions(row)

  it(
    'signed-thinking round-trip is accepted verbatim',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT * 2 },
    async () => {
      const original = makeMessage('Think privately, then answer with exactly: done')
      const firstCtx = makeCtx({ message: original })
      await adapterFor(row, false, {
        maxTokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 1024 },
      }).executor()(firstCtx, makeHelpers())
      const thought = firstCtx._stored.thoughts.find((t) => t.payload !== undefined)
      expect(thought?.payload).toMatchObject({
        variant: 'thinking',
        signature: expect.any(String),
      })

      const payload = thought!.payload as {
        thinking: string
        signature: string
      }
      const requestBodies: Array<Record<string, unknown>> = []
      const secondCtx = makeCtx({
        message: original,
        thoughts: [thought!],
      })
      await adapterFor(row, false, {
        maxTokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        fetch: fetchWithRequestBodies(requestBodies),
      }).executor()(secondCtx, makeHelpers())
      expect(secondCtx.nack).not.toHaveBeenCalled()
      const replayedThinking = (
        requestBodies[0]!.messages as Array<{
          content: Array<Record<string, unknown>>
        }>
      )
        .flatMap((m) => m.content)
        .find((block) => block.type === 'thinking')
      expect(replayedThinking).toMatchObject({
        type: 'thinking',
        thinking: payload.thinking,
        signature: payload.signature,
      })
    }
  )

  it(
    'non-conforming ToolCall.id is rejected with 400',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const badCall = new ToolCall({
        id: 'bad.id:shape',
        tool: 'echo_live_value',
        args: { value: 'x' },
        checksum: 'sum',
        isComplete: true,
        isError: false,
        results: new Tokenizable('echo:x'),
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      })
      const ctx = makeCtx({
        message: makeMessage('Continue.'),
        toolCalls: [badCall],
      })
      await adapterFor(row, false).executor()(ctx, makeHelpers())
      assertHttp400Nack(ctx)
    }
  )

  it(
    'max_tokens omitted is rejected with 400',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': row.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: row.model,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      expect(response.status).toBe(400)
    }
  )

  it(
    'temperature and top_p together are rejected with 400',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const ctx = makeCtx({ message: makeMessage('Say hi.') })
      await adapterFor(row, false, {
        temperature: 0.2,
        topP: 0.9,
      }).executor()(ctx, makeHelpers())
      assertHttp400Nack(ctx)
    }
  )
})

describe.skipIf(!enabled(row1, true))(`AnthropicMessagesAdapter — live: ${row1.label}`, () => {
  runNativeFidelityAssertions(row1 as Required<LiveRow>)
})

describe.skipIf(!enabled(row2, true))(`AnthropicMessagesAdapter — live: ${row2.label}`, () => {
  const row = row2 as Required<LiveRow>

  it(
    'non-streaming transport and auth complete',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const ctx = makeCtx({
        message: makeMessage('Reply with a short greeting.'),
      })
      await adapterFor(row, false).executor()(ctx, makeHelpers())
      assertTextGenerated(ctx)
      expect(ctx.nack).not.toHaveBeenCalled()
    }
  )

  it(
    'tool-call round-trip completes through the translating route',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const ctx = makeCtx({
        message: makeMessage('Call echo_live_value with value "xlat". Do not answer in prose.'),
        tools: new ToolRegistry([echoTool()]),
      })
      await adapterFor(row, false, {
        toolChoice: { type: 'tool', name: 'echo_live_value' },
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(1)
      expect(ctx._stored.toolCalls[0]!.isError).toBe(false)
    }
  )

  it(
    'streaming yields text while tolerating zero input_tokens on message_start',
    { retry: LIVE_RETRY, timeout: LIVE_TIMEOUT },
    async () => {
      const ctx = makeCtx({
        message: makeMessage('Stream one short sentence.'),
      })
      const helpers = makeHelpers()
      await adapterFor(row, true).executor()(ctx, helpers)
      assertTextGenerated(ctx)
      expect(vi.mocked(helpers.reportMessage).mock.calls.length).toBeGreaterThan(0)
      const latchedPromptTokens = Number(helpers._stats.at(-1)?.promptTokens ?? 0)
      expect(latchedPromptTokens).toBeGreaterThan(0)
    }
  )
})
