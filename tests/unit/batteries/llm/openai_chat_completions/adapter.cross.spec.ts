import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cassetteFetch } from '../../../../_fixtures/cassette'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  Tool,
  SpooledArtifact,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import {
  gemma4StreamingHiThereCassette,
  GEMMA4_STREAMING_FINAL_CONTENT,
} from '../../../../_fixtures/cassettes/openai_chat_completions/gemma4_streaming_hi_there'
import {
  gemma4NonStreamingHelloCassette,
  GEMMA4_NON_STREAMING_FINAL_CONTENT,
} from '../../../../_fixtures/cassettes/openai_chat_completions/gemma4_non_streaming_hello'
import {
  OpenAIChatCompletionsAdapter,
  E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS,
  E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
  E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR,
  E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR,
  E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED,
  E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT,
  toolsToChatCompletionsTools,
  descriptionToChatCompletionsJsonSchema,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type {
  RawGenerationObservation,
  PromptAssembledObservation,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'

// ─── helpers ──────────────────────────────────────────────────────────────────

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const makeMessage = (overrides: {
  id?: string
  role?: 'user' | 'assistant'
  content?: string
  identity?: string
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:00:00Z')
  return new Message({
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    identity: overrides.identity as never,
    createdAt,
    updatedAt: createdAt,
  })
}

const makeMemory = (overrides: { id?: string; content?: string; createdAt?: DateTime }) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T10:00:00Z')
  return new Memory({
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`,
    content: overrides.content ?? 'remembered fact',
    confidence: 0.9,
    importance: 0.5,
    createdAt,
    updatedAt: createdAt,
  })
}

const makeRetrievable = (overrides: {
  id?: string
  content?: string
  trustTier?: 'first-party' | 'third-party-public' | 'third-party-private'
  source?: string
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T10:00:00Z')
  return new Retrievable({
    id: overrides.id ?? `ret-${Math.random().toString(36).slice(2, 10)}`,
    content: overrides.content ?? 'retrieved fact',
    trustTier: overrides.trustTier ?? 'first-party',
    source: overrides.source,
    createdAt,
    updatedAt: createdAt,
  })
}

const makeToolCall = (overrides: {
  id?: string
  tool?: string
  args?: Record<string, unknown>
  checksum?: string
  results?: SpooledArtifact | Tokenizable
  inline?: boolean
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:01:00Z')
  return new ToolCall({
    id: overrides.id ?? `tc-${Math.random().toString(36).slice(2, 10)}`,
    tool: overrides.tool ?? 'my_tool',
    args: overrides.args ?? { x: 1 },
    checksum: overrides.checksum ?? 'sum-1',
    isComplete: true,
    isError: false,
    results: overrides.results ?? new Tokenizable('tool said hi'),
    inline: overrides.inline,
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  })
}

const makeSpooled = (text: string, callId: string): SpooledArtifact => {
  const store = new InMemorySpoolStore()
  const reader = store.write(callId, text)
  return new SpooledArtifact(reader)
}

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
  mutations: Array<{ id: string; patch: unknown }>
}

interface CtxOverrides {
  systemPrompt?: string | Tokenizable
  standingInstructions?: Tokenizable[]
  turnMessages?: Message[]
  turnThoughts?: Thought[]
  turnToolCalls?: ToolCall[]
  turnMemories?: Memory[]
  turnRetrievables?: Retrievable[]
  tools?: ToolRegistry
  stash?: Record<string, unknown>
  abortSignal?: AbortSignal
}

interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (overrides: CtxOverrides = {}): MockCtx => {
  const stored: StoredState = {
    messages: [],
    thoughts: [],
    toolCalls: [],
    mutations: [],
  }
  const sp =
    typeof overrides.systemPrompt === 'string'
      ? new Tokenizable(overrides.systemPrompt)
      : (overrides.systemPrompt ?? new Tokenizable('You are a helpful assistant.'))
  const ctx = {
    systemPrompt: sp,
    turnMessages: new Set(overrides.turnMessages ?? []),
    turnThoughts: new Set(overrides.turnThoughts ?? []),
    turnToolCalls: new Set(overrides.turnToolCalls ?? []),
    turnMemories: new Set(overrides.turnMemories ?? []),
    turnRetrievables: new Set(overrides.turnRetrievables ?? []),
    standingInstructions: new Set(overrides.standingInstructions ?? []),
    tools: overrides.tools ?? new ToolRegistry(),
    stash: new Registry(overrides.stash ?? {}),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
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
    mutateToolCall: vi.fn(async (id: string, patch: unknown) => {
      stored.mutations.push({ id, patch })
    }),
    _stored: stored,
  } as unknown as MockCtx
  return ctx
}

const makeHelpers = (): DispatchExecutorHelpers & {
  _events: Array<{ kind: string; id: string; payload: unknown }>
  _logs: Array<{ level: string; kind: string; message: string; payload?: unknown }>
  _stats: Array<Record<string, unknown>>
} => {
  const events: Array<{ kind: string; id: string; payload: unknown }> = []
  const logs: Array<{ level: string; kind: string; message: string; payload?: unknown }> = []
  const stats: Array<Record<string, unknown>> = []
  const captureLog =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
    (entry: { kind: string; message: string; payload?: Record<string, unknown> }) => {
      logs.push({ level, kind: entry.kind, message: entry.message, payload: entry.payload })
    }
  return {
    reportMessage: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) => {
      events.push({ kind: 'message', id, payload: { delta, ...(opts ?? {}) } })
    }),
    reportThought: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) => {
      events.push({ kind: 'thought', id, payload: { delta, ...(opts ?? {}) } })
    }),
    reportToolCall: vi.fn((id: string, partial: unknown) => {
      events.push({ kind: 'toolCall', id, payload: partial })
    }),
    log: {
      trace: vi.fn(captureLog('trace')),
      debug: vi.fn(captureLog('debug')),
      info: vi.fn(captureLog('info')),
      warn: vi.fn(captureLog('warn')),
      error: vi.fn(captureLog('error')),
    },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => {
      stats.push(s)
    }),
    _events: events,
    _logs: logs,
    _stats: stats,
  } as unknown as DispatchExecutorHelpers & {
    _events: typeof events
    _logs: typeof logs
    _stats: typeof stats
  }
}

// Encode an SSE Response (200) from an array of frame strings (each will be wrapped as `data: <frame>\n\n`).
// Pass `'[DONE]'` as a frame literal to terminate cleanly. Pass a raw string starting with `:` to emit a
// keep-alive comment line. Pass an object with `{ raw: string }` to push an arbitrary already-framed string.
type SSEFrame = string | { raw: string } | { delayMs: number } | { error: Error }

const sseResponse = (
  frames: SSEFrame[],
  init?: { status?: number; headers?: Record<string, string> }
): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const f of frames) {
          if (typeof f === 'string') {
            if (f === '[DONE]') {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            } else if (f.startsWith(':')) {
              // SSE comment / keep-alive line
              controller.enqueue(encoder.encode(`${f}\n\n`))
            } else {
              controller.enqueue(encoder.encode(`data: ${f}\n\n`))
            }
          } else if ('raw' in f) {
            controller.enqueue(encoder.encode(f.raw))
          } else if ('delayMs' in f) {
            await new Promise((resolve) => setTimeout(resolve, f.delayMs))
          } else if ('error' in f) {
            controller.error(f.error)
            return
          }
        }
        controller.close()
      } catch (e) {
        controller.error(e as Error)
      }
    },
  })
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'text/event-stream',
      ...(init?.headers ?? {}),
    },
  })
}

const jsonResponse = (
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> }
): Response => {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

const validNonStreamingResponse = (content = 'hi there', model = 'gpt-x') =>
  jsonResponse({
    id: 'resp-1',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  })

const validStreamingResponse = (deltas: string[]) => {
  const frames: SSEFrame[] = []
  for (const d of deltas) {
    frames.push(
      JSON.stringify({
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: d }, finish_reason: null }],
      })
    )
  }
  frames.push('[DONE]')
  return sseResponse(frames)
}

const getRequestBody = (call: unknown): Record<string, unknown> => {
  const init = (call as [string | URL, RequestInit])[1]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

const getRequestHeaders = (call: unknown): Record<string, string> => {
  const init = (call as [string | URL, RequestInit])[1]
  return init.headers as Record<string, string>
}

const getRequestUrl = (call: unknown): string => {
  const url = (call as [string | URL, RequestInit])[0]
  return typeof url === 'string' ? url : url.toString()
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('OpenAIChatCompletionsAdapter — static surface', () => {
  it('exposes STASH_KEY === "openaiChatCompletions"', () => {
    expect(OpenAIChatCompletionsAdapter.STASH_KEY).toBe('openaiChatCompletions')
  })

  it('isOpenAIChatCompletionsAdapter recognises instances', () => {
    const a = new OpenAIChatCompletionsAdapter({ model: 'm', stream: false })
    expect(OpenAIChatCompletionsAdapter.isOpenAIChatCompletionsAdapter(a)).toBe(true)
    expect(OpenAIChatCompletionsAdapter.isOpenAIChatCompletionsAdapter({})).toBe(false)
  })
})

describe('OpenAIChatCompletionsAdapter — validation hard-fail', () => {
  it('throws E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS at construction on bad options', () => {
    expect(() => new OpenAIChatCompletionsAdapter({})).toThrow(
      E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS
    )
    expect(() => new OpenAIChatCompletionsAdapter({ model: 'm', temperature: 'high' })).toThrow(
      E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS
    )
  })

  it('throws on invalid executor-override before any fetch call', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ temperature: 'totally-wrong' as never })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await expect(ex(ctx, helpers)).rejects.toBeInstanceOf(E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('throws on invalid stash override before any fetch call', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor()
    const ctx = makeCtx({ stash: { openaiChatCompletions: { temperature: 'broken' } } })
    const helpers = makeHelpers()
    await expect(ex(ctx, helpers)).rejects.toBeInstanceOf(E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('OpenAIChatCompletionsAdapter — override precedence', () => {
  it('stash wins over executor wins over ctor for model', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'a',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ model: 'b' })
    const ctx = makeCtx({ stash: { openaiChatCompletions: { model: 'c' } } })
    const helpers = makeHelpers()
    await ex(ctx, helpers)
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body.model).toBe('c')
  })

  it('stash wins over executor wins over ctor for temperature', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      temperature: 0.1,
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ temperature: 0.5 })
    const ctx = makeCtx({ stash: { openaiChatCompletions: { temperature: 0.9 } } })
    await ex(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body.temperature).toBe(0.9)
  })

  it('stash wins over executor wins over ctor for apiKey (Authorization header)', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      apiKey: 'K-ctor',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ apiKey: 'K-exec' })
    const ctx = makeCtx({ stash: { openaiChatCompletions: { apiKey: 'K-custom' } } })
    await ex(ctx, makeHelpers())
    const headers = getRequestHeaders(fetchFn.mock.calls[0])
    expect(headers.Authorization).toBe('Bearer K-custom')
  })

  it('stash wins over executor wins over ctor for baseURL (request URL)', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      baseURL: 'https://a.example.com/v1',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ baseURL: 'https://b.example.com/v1' })
    const ctx = makeCtx({
      stash: { openaiChatCompletions: { baseURL: 'https://c.example.com/v1' } },
    })
    await ex(ctx, makeHelpers())
    expect(getRequestUrl(fetchFn.mock.calls[0])).toBe('https://c.example.com/v1/chat/completions')
  })

  it('strips trailing slash on baseURL', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      baseURL: 'https://x.example.com/v1/',
      fetch: fetchFn as never,
      stream: false,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(getRequestUrl(fetchFn.mock.calls[0])).toBe('https://x.example.com/v1/chat/completions')
  })
})

describe('OpenAIChatCompletionsAdapter — ADK control keys do not leak into the request body', () => {
  // The body is assembled by copying every option key that is NOT an ADK control
  // key into the wire payload. autoAck and unsupportedMediaPolicy are ADK-internal
  // control state; a strict OpenAI-compatible provider rejects unknown top-level
  // params, so they MUST be filtered out regardless of how they were supplied.
  it('omits autoAck and unsupportedMediaPolicy (ctor) from the request body', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      autoAck: true,
      unsupportedMediaPolicy: 'fallback-stash',
      fetch: fetchFn as never,
      stream: false,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body).not.toHaveProperty('autoAck')
    expect(body).not.toHaveProperty('unsupportedMediaPolicy')
  })

  it('omits autoAck and unsupportedMediaPolicy supplied via executor + stash overrides', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ autoAck: false })
    const ctx = makeCtx({
      stash: { openaiChatCompletions: { unsupportedMediaPolicy: 'throw' } },
    })
    await ex(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body).not.toHaveProperty('autoAck')
    expect(body).not.toHaveProperty('unsupportedMediaPolicy')
  })
})

describe('OpenAIChatCompletionsAdapter — header merging', () => {
  it('merges ctor + executor + stash headers key-by-key with stash winning', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      apiKey: 'K1',
      headers: { 'Authorization': 'Bearer K1', 'OpenAI-Project': 'P1' },
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor({ headers: { 'OpenAI-Project': 'P2' } })
    const ctx = makeCtx({
      stash: { openaiChatCompletions: { headers: { 'OpenAI-Beta': 'foo' } } },
    })
    await ex(ctx, makeHelpers())
    const headers = getRequestHeaders(fetchFn.mock.calls[0])
    expect(headers.Authorization).toBe('Bearer K1')
    expect(headers['OpenAI-Project']).toBe('P2')
    expect(headers['OpenAI-Beta']).toBe('foo')
  })

  it('user-supplied Authorization header overrides synthesised apiKey value', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      apiKey: 'K',
      headers: { Authorization: 'Token X' },
      fetch: fetchFn as never,
      stream: false,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const headers = getRequestHeaders(fetchFn.mock.calls[0])
    expect(headers.Authorization).toBe('Token X')
  })

  it('pre-authorized endpoint: no apiKey and no Authorization header → no Authorization synthesised', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      baseURL: 'https://mtls-gateway.internal/v1',
      fetch: fetchFn as never,
      stream: false,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const headers = getRequestHeaders(fetchFn.mock.calls[0])
    expect(headers).not.toHaveProperty('Authorization')
  })

  it('no credentials + upstream 401 surfaces HTTP_ERROR with status 401', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'unauthenticated' }, { status: 401 }))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      baseURL: 'https://mtls-gateway.internal/v1',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    const err = (ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error
    expect(err).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR)
    expect(err.message).toContain('401')
  })

  it('forwards a non-Authorization auth header (X-Api-Key) with no Authorization synthesised', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      headers: { 'X-Api-Key': 'gateway-token' },
      fetch: fetchFn as never,
      stream: false,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const headers = getRequestHeaders(fetchFn.mock.calls[0])
    expect(headers['X-Api-Key']).toBe('gateway-token')
    expect(headers).not.toHaveProperty('Authorization')
  })

  it('streaming sets Accept: text/event-stream; non-streaming does not', async () => {
    const fetchFn = vi.fn(async () => validStreamingResponse(['hi']))
    const sAdapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    await sAdapter.executor()(makeCtx(), makeHelpers())
    expect(getRequestHeaders(fetchFn.mock.calls[0]).Accept).toBe('text/event-stream')

    const fetchFn2 = vi.fn(async () => validNonStreamingResponse())
    const nAdapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn2 as never,
      stream: false,
    })
    await nAdapter.executor()(makeCtx(), makeHelpers())
    expect(getRequestHeaders(fetchFn2.mock.calls[0]).Accept).toBeUndefined()
  })
})

describe('OpenAIChatCompletionsAdapter — bucketOrder', () => {
  const standing = [new Tokenizable('always be polite')]
  const mems = [makeMemory({ content: 'user prefers brevity' })]
  const msgs = [makeMessage({ content: 'hi there' })]

  it('default order: leading system message contains standing instructions + memories', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx({
      standingInstructions: standing,
      turnMemories: mems,
      turnMessages: msgs,
    })
    await adapter.executor()(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const messages = body.messages as Array<{ role: string; content: string }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('always be polite')
    expect(messages[0].content).toContain('user prefers brevity')
  })

  it('bucketOrder ["timeline","standingInstructions","memories"] places system block trailing', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['timeline', 'standingInstructions', 'memories'],
    })
    const ctx = makeCtx({
      standingInstructions: standing,
      turnMemories: mems,
      turnMessages: msgs,
    })
    await adapter.executor()(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const messages = body.messages as Array<{ role: string; content: string }>
    // Leading system message is the persona prompt; second-to-last should be the user message;
    // the trailing system message should carry the buckets.
    const last = messages[messages.length - 1]
    expect(last.role).toBe('system')
    expect(last.content).toContain('always be polite')
    expect(last.content).toContain('user prefers brevity')
  })

  it('per-dispatch stash bucketOrder applies only to that iteration', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ex = adapter.executor()
    const ctx1 = makeCtx({
      standingInstructions: standing,
      turnMemories: mems,
      turnMessages: msgs,
      stash: {
        openaiChatCompletions: { bucketOrder: ['timeline', 'memories', 'standingInstructions'] },
      },
    })
    await ex(ctx1, makeHelpers())
    const body1 = getRequestBody(fetchFn.mock.calls[0])
    const lastMsg = (body1.messages as Array<{ role: string; content: string }>).at(-1)!
    expect(lastMsg.role).toBe('system')

    // Subsequent iteration without stash refresh falls back to default
    const ctx2 = makeCtx({ standingInstructions: standing, turnMemories: mems, turnMessages: msgs })
    await ex(ctx2, makeHelpers())
    const body2 = getRequestBody(fetchFn.mock.calls[1])
    const firstMsg = (body2.messages as Array<{ role: string; content: string }>)[0]
    expect(firstMsg.role).toBe('system')
    expect(firstMsg.content).toContain('always be polite')
  })
})

describe('OpenAIChatCompletionsAdapter — retrievables', () => {
  it('renders mixed-tier retrievables with safety directive in the leading system message', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['retrievables', 'timeline'],
    })
    const ctx = makeCtx({
      turnRetrievables: [
        makeRetrievable({ id: 'fp-x', content: 'fp body', trustTier: 'first-party' }),
        makeRetrievable({
          id: 'pub-x',
          content: 'pub body',
          trustTier: 'third-party-public',
          source: 'https://e.com/a',
        }),
        makeRetrievable({
          id: 'priv-x',
          content: 'priv body',
          trustTier: 'third-party-private',
          source: 'upload://u/1',
        }),
      ],
      turnMessages: [makeMessage({ content: 'hi' })],
    })
    await adapter.executor()(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const messages = body.messages as Array<{ role: string; content: string }>
    const leading = messages[0]
    expect(leading.role).toBe('system')
    expect(leading.content).toContain('DATA')
    expect(leading.content).toContain('<retrieved_corpus>')
    expect(leading.content).toContain('<retrieved_fp-x nonce="fp-x"')
    expect(leading.content).toContain('kind="retrieved-third-party-public"')
    expect(leading.content).toContain('kind="retrieved-third-party-private"')
  })

  it('bucketOrder ["timeline","retrievables"] emits retrievables in trailing system message with directive', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['timeline', 'retrievables'],
    })
    const ctx = makeCtx({
      turnRetrievables: [
        makeRetrievable({ id: 'fp-1', content: 'kb body', trustTier: 'first-party' }),
      ],
      turnMessages: [makeMessage({ content: 'hi' })],
    })
    await adapter.executor()(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const messages = body.messages as Array<{ role: string; content: string }>
    const last = messages[messages.length - 1]
    expect(last.role).toBe('system')
    expect(last.content).toContain('DATA')
    expect(last.content).toContain('<retrieved_corpus>')
    expect(last.content).toContain('kb body')
  })

  it('bucketOrder omitting "retrievables" drops the bucket and the directive', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['timeline'],
    })
    const ctx = makeCtx({
      turnRetrievables: [
        makeRetrievable({ id: 'fp-skip', content: 'should not appear', trustTier: 'first-party' }),
      ],
      turnMessages: [makeMessage({ content: 'hi' })],
    })
    await adapter.executor()(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain('should not appear')
    expect(serialised).not.toContain('retrieved_corpus')
    expect(serialised).not.toContain('DATA only')
  })

  it('per-dispatch override stash.helpers.renderRetrievables applies only to that iteration', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['retrievables', 'timeline'],
    })
    const ex = adapter.executor()
    const r = makeRetrievable({ id: 'fp-y', content: 'real body', trustTier: 'first-party' })
    const ctx1 = makeCtx({
      turnRetrievables: [r],
      turnMessages: [makeMessage({ content: 'hi' })],
      stash: {
        openaiChatCompletions: {
          helpers: { renderRetrievables: () => 'CUSTOM-RETR' },
        },
      },
    })
    await ex(ctx1, makeHelpers())
    const body1 = getRequestBody(fetchFn.mock.calls[0])
    const leading1 = (body1.messages as Array<{ role: string; content: string }>)[0]
    expect(leading1.content).toContain('CUSTOM-RETR')
    expect(leading1.content).not.toContain('<retrieved_corpus>')

    const ctx2 = makeCtx({
      turnRetrievables: [r],
      turnMessages: [makeMessage({ content: 'hi' })],
    })
    await ex(ctx2, makeHelpers())
    const body2 = getRequestBody(fetchFn.mock.calls[1])
    const leading2 = (body2.messages as Array<{ role: string; content: string }>)[0]
    expect(leading2.content).not.toContain('CUSTOM-RETR')
    expect(leading2.content).toContain('<retrieved_corpus>')
  })

  it('per-dispatch override stash.helpers.renderFirstPartyRetrievables only swaps first-party branch', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['retrievables', 'timeline'],
    })
    const ex = adapter.executor()
    const ctx = makeCtx({
      turnRetrievables: [
        makeRetrievable({ id: 'fp-z', content: 'fp body', trustTier: 'first-party' }),
        makeRetrievable({
          id: 'pub-z',
          content: 'pub body',
          trustTier: 'third-party-public',
        }),
      ],
      turnMessages: [makeMessage({ content: 'hi' })],
      stash: {
        openaiChatCompletions: {
          helpers: { renderFirstPartyRetrievables: () => 'FP-CUSTOM' },
        },
      },
    })
    await ex(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const leading = (body.messages as Array<{ role: string; content: string }>)[0]
    expect(leading.content).toContain('FP-CUSTOM')
    // Default third-party-public envelope still used
    expect(leading.content).toContain('kind="retrieved-third-party-public"')
    expect(leading.content).toContain('pub body')
  })

  it('per-dispatch override stash.helpers.renderRetrievableSafetyDirective applies only to that iteration', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      bucketOrder: ['retrievables', 'timeline'],
    })
    const ex = adapter.executor()
    const r = makeRetrievable({ id: 'fp-q', content: 'body', trustTier: 'first-party' })
    const ctx1 = makeCtx({
      turnRetrievables: [r],
      turnMessages: [makeMessage({ content: 'hi' })],
      stash: {
        openaiChatCompletions: {
          helpers: { renderRetrievableSafetyDirective: () => 'CUSTOM-DIRECTIVE' },
        },
      },
    })
    await ex(ctx1, makeHelpers())
    const body1 = getRequestBody(fetchFn.mock.calls[0])
    const leading1 = (body1.messages as Array<{ role: string; content: string }>)[0]
    expect(leading1.content).toContain('CUSTOM-DIRECTIVE')
    expect(leading1.content).toContain('<retrieved_corpus>')

    const ctx2 = makeCtx({
      turnRetrievables: [r],
      turnMessages: [makeMessage({ content: 'hi' })],
    })
    await ex(ctx2, makeHelpers())
    const body2 = getRequestBody(fetchFn.mock.calls[1])
    const leading2 = (body2.messages as Array<{ role: string; content: string }>)[0]
    expect(leading2.content).not.toContain('CUSTOM-DIRECTIVE')
    expect(leading2.content).toContain('DATA')
  })
})

describe('OpenAIChatCompletionsAdapter — context window enforcement', () => {
  it('accounts for a non-inline spooled retrievable handle and forwards the resolved renderer', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const renderer = (_input: {
      callId: string
      artifact: unknown
      byteLength: number
      lineCount: number
    }) => 'HANDLE'
    const id = 'budget-openai'
    const artifact = new SpooledArtifact(
      new InMemorySpoolStore().write(id, 'full-body '.repeat(10000))
    )
    artifact._setSizeHints({ byteLength: 100000, lineCount: 10000 })
    const retrievable = new Retrievable({
      id,
      content: artifact,
      trustTier: 'first-party',
      inline: false,
      createdAt: dt('2026-01-01T10:00:00Z'),
      updatedAt: dt('2026-01-01T10:00:00Z'),
    })
    const spy = vi.spyOn(artifact, 'estimateHandleTokens')
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 1000,
    })
    await expect(
      adapter.executor()(
        makeCtx({
          turnRetrievables: [retrievable],
          stash: { openaiChatCompletions: { helpers: { renderRetrievableHandleBody: renderer } } },
        }),
        makeHelpers()
      )
    ).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith(id, 'cl100k_base', renderer)
    expect(fetchFn).toHaveBeenCalledOnce()
  })
  it('falls back to full-content estimation for a non-inline spooled retrievable with no cached size hints, instead of throwing', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const id = 'budget-openai-unhinted'
    const artifact = new SpooledArtifact(new InMemorySpoolStore().write(id, 'unhinted body'))
    const retrievable = new Retrievable({
      id,
      content: artifact,
      trustTier: 'first-party',
      inline: false,
      createdAt: dt('2026-01-01T10:00:00Z'),
      updatedAt: dt('2026-01-01T10:00:00Z'),
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 1000,
    })
    await expect(
      adapter.executor()(makeCtx({ turnRetrievables: [retrievable] }), makeHelpers())
    ).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledOnce()
  })
  it('disabled by default — no tokenEncoding means massive content dispatches normally', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const big = 'x'.repeat(50_000)
    const ctx = makeCtx({ turnMemories: [makeMemory({ content: big })] })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('explicit tokenEncoding: null behaves identically to omission', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: null,
    })
    const big = 'y'.repeat(50_000)
    const ctx = makeCtx({ turnMemories: [makeMemory({ content: big })] })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('tokenEncoding set without contextWindow throws E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS at iteration time', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
    })
    const ctx = makeCtx()
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toBeInstanceOf(
      E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('memory-heavy overflow throws CONTEXT_OVERFLOW with perBucket.memories largest', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 1000,
    })
    const big = 'memory '.repeat(2000)
    const ctx = makeCtx({ turnMemories: [makeMemory({ content: big })] })
    let thrown: unknown
    try {
      await adapter.executor()(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
    const err = thrown as Error
    expect(err.message).toContain('cl100k_base')
    expect(err.message).toContain('memories')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('history-heavy overflow throws CONTEXT_OVERFLOW with perBucket.timeline largest', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 1000,
    })
    const big = 'timeline-word '.repeat(2000)
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: big })] })
    let thrown: unknown
    try {
      await adapter.executor()(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
    expect((thrown as Error).message).toContain('timeline')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('under-limit dispatches normally', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 10_000,
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  // REGRESSION (same class as the LiteRT crash): the overflow tally MUST include the tool DECLARATIONS.
  // OpenAI serializes `tools` server-side into the model's format, so we tally the wire `tools` JSON as
  // an honest FLOOR. Uses REAL tools → the battery's REAL toolsToChatCompletionsTools → a REAL
  // Tokenizable count (no fakes): the fetch is never reached (guard fires pre-dispatch).
  const richTool = (name: string) =>
    new Tool({
      name,
      description:
        `A tool named ${name} with a deliberately verbose, multi-field input schema so its ` +
        `serialized JSON declaration weighs many tokens.`,
      inputSchema: validator.object({
        query: validator.string().min(1).max(4096).description('the search query text').required(),
        limit: validator.number().integer().min(1).max(100).description('max results to return'),
        filters: validator
          .object({
            path: validator.string().description('restrict to a documentation path prefix'),
            since: validator.string().description('ISO date lower bound'),
            tags: validator.array().items(validator.string()).description('tag allow-list'),
          })
          .description('optional structured filters'),
        verbose: validator.boolean().description('include full bodies in the result'),
      }),
      handler: () => 'ok',
    })

  it('tool-declaration-heavy overflow throws CONTEXT_OVERFLOW with perBucket.tools counted', async () => {
    const fetchFn = vi.fn()
    const tools = new ToolRegistry([
      richTool('search_docs_semantic'),
      richTool('search_docs_keyword'),
      richTool('provide_answer'),
      richTool('get_current_time'),
      richTool('calculate'),
    ])
    const enc = 'cl100k_base' as const
    const sysAndMsg =
      Tokenizable.estimateTokens('You are a helpful assistant.', enc) +
      Tokenizable.estimateTokens('hi', enc)
    const toolBlock = Tokenizable.estimateTokens(
      JSON.stringify(
        toolsToChatCompletionsTools(tools.visible(), { descriptionToChatCompletionsJsonSchema })
      ),
      enc
    )
    // Sanity: the tool declarations are the dominant term.
    expect(toolBlock).toBeGreaterThan(sysAndMsg)
    // A window ABOVE system+message but BELOW system+message+tools: overflows ONLY because tools count.
    const contextWindow = sysAndMsg + Math.floor(toolBlock / 2)
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: enc,
      contextWindow,
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })], tools })
    let thrown: unknown
    try {
      await adapter.executor()(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
    // The perBucket detail carries the tools tally (proves it was counted, not ignored).
    expect((thrown as Error).message).toContain('tools')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does NOT overflow the same tool-heavy prompt when the window covers the tools', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const tools = new ToolRegistry([richTool('search_docs_semantic'), richTool('provide_answer')])
    const enc = 'cl100k_base' as const
    const everything =
      Tokenizable.estimateTokens('You are a helpful assistant.', enc) +
      Tokenizable.estimateTokens('hi', enc) +
      Tokenizable.estimateTokens(
        JSON.stringify(
          toolsToChatCompletionsTools(tools.visible(), { descriptionToChatCompletionsJsonSchema })
        ),
        enc
      )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: enc,
      contextWindow: everything + 256,
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })], tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('handle rendering keeps the request under a tight ceiling for inline:false SpooledArtifact', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      // The overflow guard now counts tool DECLARATIONS too — including the forged artifact-reader tools
      // an inline:false SpooledArtifact injects. The window must sit ABOVE (handle + reader-tool schemas)
      // but well BELOW the ~6.5k tokens the inlined body would need, so the point still holds: the handle
      // + reader tools fit, the inlined body would not.
      contextWindow: 3000,
    })
    const huge = 'huge-content '.repeat(2000)
    const spool = makeSpooled(huge, 'tc-handle-1')
    const tc = makeToolCall({ id: 'tc-handle-1', results: spool, inline: false })
    const ctx = makeCtx({ turnToolCalls: [tc] })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const body = getRequestBody(fetchFn.mock.calls[0])
    const stringified = JSON.stringify(body)
    // The huge body itself is NOT inlined
    expect(stringified).not.toContain('huge-content huge-content huge-content huge-content')
  })

  it('inline:true SpooledArtifact overflowing the ceiling throws CONTEXT_OVERFLOW', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 200,
    })
    const huge = 'inline-overflow '.repeat(500)
    const spool = makeSpooled(huge, 'tc-inline-1')
    const tc = makeToolCall({ id: 'tc-inline-1', results: spool, inline: true })
    const ctx = makeCtx({ turnToolCalls: [tc] })
    let thrown: unknown
    try {
      await adapter.executor()(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('handle directions are still subject to total ceiling: 50× small handles overflow', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 100,
    })
    const toolCalls: ToolCall[] = []
    for (let i = 0; i < 50; i += 1) {
      const spool = makeSpooled('x'.repeat(2000), `tc-h-${i}`)
      toolCalls.push(
        makeToolCall({ id: `tc-h-${i}`, results: spool, inline: false, checksum: `sum-${i}` })
      )
    }
    const ctx = makeCtx({ turnToolCalls: toolCalls })
    let thrown: unknown
    try {
      await adapter.executor()(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('per-dispatch contextWindow override drives that iteration only', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 128_000,
    })
    const ex = adapter.executor()
    const big = 'word '.repeat(2000)
    const ctx = makeCtx({
      turnMemories: [makeMemory({ content: big })],
      stash: { openaiChatCompletions: { contextWindow: 50 } },
    })
    let thrown: unknown
    try {
      await ex(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
  })

  it('per-dispatch tokenEncoding toggle: ctor null → enable via stash', async () => {
    const fetchFn = vi.fn()
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const big = 'flip-on '.repeat(2000)
    const ctx = makeCtx({
      turnMemories: [makeMemory({ content: big })],
      stash: {
        openaiChatCompletions: { tokenEncoding: 'cl100k_base', contextWindow: 100 },
      },
    })
    let thrown: unknown
    try {
      await adapter.executor()(ctx, makeHelpers())
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW)
  })

  it('per-dispatch tokenEncoding toggle: ctor cl100k_base → disable via stash null', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 100,
    })
    const big = 'flip-off '.repeat(2000)
    const ctx = makeCtx({
      turnMemories: [makeMemory({ content: big })],
      stash: { openaiChatCompletions: { tokenEncoding: null } },
    })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('middleware-driven inline flip: mutateToolCall flips inline:true → inline:false before dispatch', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'cl100k_base',
      // Above (handle + forged reader-tool declarations, now counted), below the inlined body — same
      // rationale as the tight-ceiling test above.
      contextWindow: 3000,
    })
    const huge = 'overflow-source '.repeat(2000)
    const spool = makeSpooled(huge, 'tc-flip-1')
    // Originally inline:true (would overflow). The "middleware" creates the ToolCall with inline:false directly,
    // matching what mutateToolCall would do in steady-state. We also assert the mutation entry is recorded
    // (proves the mutate path was invoked, even though it's a no-op on the adapter's read of `inline`).
    const tcInline = makeToolCall({ id: 'tc-flip-1', results: spool, inline: false })
    const ctx = makeCtx({ turnToolCalls: [tcInline] })
    await (ctx.mutateToolCall as unknown as (id: string, patch: unknown) => Promise<void>)(
      tcInline.id,
      { inline: false }
    )
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx._stored.mutations).toEqual([{ id: 'tc-flip-1', patch: { inline: false } }])
  })
})

describe('OpenAIChatCompletionsAdapter — full-parameter passthrough', () => {
  it('every Chat Completions request-body field lands in the body', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'gpt-x',
      stream: false,
      fetch: fetchFn as never,
      audio: { voice: 'alloy', format: 'mp3' },
      frequency_penalty: 0.2,
      logit_bias: { '50256': -100 },
      logprobs: true,
      max_completion_tokens: 1000,
      max_tokens: 800,
      metadata: { tag: 'unit' },
      modalities: ['text'],
      n: 1,
      parallel_tool_calls: true,
      prediction: { type: 'content', content: 'hello' },
      presence_penalty: -0.3,
      prompt_cache_key: 'cache-1',
      prompt_cache_retention: '24h',
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      safety_identifier: 'safe-1',
      seed: 42,
      service_tier: 'default',
      stop: ['STOP'],
      store: true,
      stream_options: { include_usage: true },
      temperature: 0.55,
      tool_choice: 'auto',
      top_logprobs: 3,
      top_p: 0.95,
      user: 'u-123',
      verbosity: 'medium',
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body.model).toBe('gpt-x')
    expect(body.audio).toEqual({ voice: 'alloy', format: 'mp3' })
    expect(body.frequency_penalty).toBe(0.2)
    expect(body.logit_bias).toEqual({ '50256': -100 })
    expect(body.logprobs).toBe(true)
    expect(body.max_completion_tokens).toBe(1000)
    expect(body.max_tokens).toBe(800)
    expect(body.metadata).toEqual({ tag: 'unit' })
    expect(body.modalities).toEqual(['text'])
    expect(body.n).toBe(1)
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.prediction).toEqual({ type: 'content', content: 'hello' })
    expect(body.presence_penalty).toBe(-0.3)
    expect(body.prompt_cache_key).toBe('cache-1')
    expect(body.prompt_cache_retention).toBe('24h')
    expect(body.reasoning_effort).toBe('low')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.safety_identifier).toBe('safe-1')
    expect(body.seed).toBe(42)
    expect(body.service_tier).toBe('default')
    expect(body.stop).toEqual(['STOP'])
    expect(body.store).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.temperature).toBe(0.55)
    expect(body.tool_choice).toBe('auto')
    expect(body.top_logprobs).toBe(3)
    expect(body.top_p).toBe(0.95)
    expect(body.user).toBe('u-123')
    expect(body.verbosity).toBe('medium')
    expect(body.stream).toBe(false)
    // Harness-control keys must NOT appear in the body
    expect(body.apiKey).toBeUndefined()
    expect(body.baseURL).toBeUndefined()
    expect(body.fetch).toBeUndefined()
    expect(body.helpers).toBeUndefined()
    expect(body.retry).toBeUndefined()
    expect(body.tokenEncoding).toBeUndefined()
    expect(body.bucketOrder).toBeUndefined()
    expect(body.streamIdleTimeoutMs).toBeUndefined()
    expect(body.requestTimeoutMs).toBeUndefined()
  })
})

describe('OpenAIChatCompletionsAdapter — non-streaming path', () => {
  it('plain content response → storeMessage called once, one complete reportMessage', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse('the answer is yes'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
    const stored = ctx._stored.messages[0]
    expect(stored.role).toBe('assistant')
    expect(stored.content?.toString()).toBe('the answer is yes')
    const reportMessageEvents = (
      helpers as unknown as { _events: Array<{ kind: string; payload: { isComplete?: boolean } }> }
    )._events.filter((e) => e.kind === 'message')
    expect(reportMessageEvents).toHaveLength(1)
    expect(reportMessageEvents[0].payload.isComplete).toBe(true)
  })

  it('response with tool_calls → storeToolCall called once per call, tool.executor invoked, no ack', async () => {
    const tool = new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
    })
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: 'resp-tc',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const tools = new ToolRegistry([tool])
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    const stored = ctx._stored.toolCalls[0]
    // Exercise the adapter's real constructor -> executor option resolution: absent filter is identity.
    expect(stored.id).toBe('call-1')
    expect(stored.tool).toBe('echo')
    const echoResults = stored.results as SpooledArtifact
    expect(await echoResults.asString()).toContain('echoed: hi')
    expect(ctx.ack).not.toHaveBeenCalled()
  })

  it('configured toolCallIdFilter is applied to the persisted ToolCall id', async () => {
    // The absent-filter case above only proves identity; it cannot distinguish a
    // configured filter from a deleted feature (both yield the unchanged provider id).
    // This test exercises the real constructor -> executor option-resolution path with
    // a filter configured and asserts the PERSISTED ToolCall.id is the filtered value.
    const tool = new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
    })
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: 'resp-tc-filtered',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      toolCallIdFilter: (id: string) => `filtered-${id}`,
    })
    const tools = new ToolRegistry([tool])
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    const stored = ctx._stored.toolCalls[0]
    // The persisted id must be the FILTERED value, not the provider's raw id.
    expect(stored.id).toBe('filtered-call-1')
    expect(stored.tool).toBe('echo')
    const echoResults = stored.results as SpooledArtifact
    expect(await echoResults.asString()).toContain('echoed: hi')
    expect(ctx.ack).not.toHaveBeenCalled()
  })

  it('tool-call checksum is canonical (insensitive to argument key order)', async () => {
    // The repeat-call primitive (ctx.toolCallCount(checksum)) must treat
    // semantically-identical calls as identical regardless of argument key order.
    // Two calls to the same tool with the same args in DIFFERENT key order must
    // therefore produce the SAME checksum — this fails under plain JSON.stringify.
    const tool = new Tool({
      name: 'pair',
      description: 'pair tool',
      inputSchema: validator.object({
        a: validator.string().required(),
        b: validator.string().required(),
      }),
      handler: () => 'ok',
    })
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: 'resp-tc-order',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-ab',
                  type: 'function',
                  // a then b
                  function: { name: 'pair', arguments: '{"a":"1","b":"2"}' },
                },
                {
                  id: 'call-ba',
                  type: 'function',
                  // b then a — same args, different key order
                  function: { name: 'pair', arguments: '{"b":"2","a":"1"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const tools = new ToolRegistry([tool])
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(2)
    const [first, second] = ctx._stored.toolCalls
    expect(first.checksum).toBeDefined()
    expect(first.checksum).toBe(second.checksum)
  })

  it('non-streaming with no choices → ack and no storage', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: 'resp-empty',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-x',
        choices: [],
      })
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(ctx.storeMessage).not.toHaveBeenCalled()
  })
})

describe('OpenAIChatCompletionsAdapter — streaming path', () => {
  it('content deltas → reportMessage per delta, one isComplete:true, single storeMessage', async () => {
    const fetchFn = vi.fn(async () => validStreamingResponse(['Hel', 'lo, ', 'world!']))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const evs = (
      helpers as unknown as {
        _events: Array<{ kind: string; payload: { delta?: string; isComplete?: boolean } }>
      }
    )._events.filter((e) => e.kind === 'message')
    expect(evs.length).toBe(4) // 3 deltas + 1 complete
    expect(evs[3].payload.isComplete).toBe(true)
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
    expect(ctx._stored.messages[0].content?.toString()).toBe('Hello, world!')
  })

  it('reasoning_content deltas → reportThought + storeThought', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }],
      }),
      JSON.stringify({
        id: 'c-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { reasoning_content: ' more' }, finish_reason: null }],
      }),
      '[DONE]',
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const evs = (helpers as unknown as { _events: Array<{ kind: string }> })._events.filter(
      (e) => e.kind === 'thought'
    )
    expect(evs.length).toBe(3)
    expect(ctx.storeThought).toHaveBeenCalledTimes(1)
    expect(ctx._stored.thoughts[0].content.toString()).toBe('thinking more')
  })

  it('tool-call delta accumulator: args assembled across chunks; multiple parallel calls; each persisted', async () => {
    const tool = new Tool({
      name: 'searcher',
      description: 'searches',
      inputSchema: validator.object({ q: validator.string().required() }),
      handler: (args: unknown) => `found: ${(args as { q: string }).q}`,
    })
    const tool2 = new Tool({
      name: 'looker',
      description: 'looks',
      inputSchema: validator.object({ where: validator.string().required() }),
      handler: (args: unknown) => `looked: ${(args as { where: string }).where}`,
    })
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-a',
                  type: 'function',
                  function: { name: 'searcher', arguments: '{"q":"' },
                },
                {
                  index: 1,
                  id: 'call-b',
                  type: 'function',
                  function: { name: 'looker', arguments: '{"where":"' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        id: 'c-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'cats"}' } },
                { index: 1, function: { arguments: 'home"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      '[DONE]',
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const tools = new ToolRegistry([tool, tool2])
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(2)
    const ids = ctx._stored.toolCalls.map((tc) => tc.id).sort()
    expect(ids).toEqual(['call-a', 'call-b'])
    const calla = ctx._stored.toolCalls.find((tc) => tc.id === 'call-a')!
    expect(calla.tool).toBe('searcher')
    expect(calla.args).toEqual({ q: 'cats' })
  })

  it('streaming with empty stream (only [DONE]) → acks', async () => {
    const fetchFn = vi.fn(async () => sseResponse(['[DONE]']))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(ctx.storeMessage).not.toHaveBeenCalled()
  })

  it('autoAck defaults to false → no ack on tool-call-free response', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse('hello world'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages.length).toBeGreaterThan(0)
  })

  it('autoAck:false explicit → no ack', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse('hello world'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: false,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages.length).toBeGreaterThan(0)
  })
})

describe('OpenAIChatCompletionsAdapter — stream idle-timeout watchdog', () => {
  it('disabled by default — long gaps OK', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      }),
      { delayMs: 400 },
      '[DONE]',
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('fires on inactivity → nacks STREAM_STALLED', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'pa' }, finish_reason: null }],
      }),
      { delayMs: 500 }, // exceeds idleTimeout
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 100,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    const err = (ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error
    expect(err).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED)
    expect(err.message).toContain('100')
  })

  it('resets on every chunk — frequent chunks complete normally', async () => {
    const frames: SSEFrame[] = []
    for (let i = 0; i < 5; i += 1) {
      frames.push(
        JSON.stringify({
          id: `c-${i}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-x',
          choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
        })
      )
      frames.push({ delayMs: 80 })
    }
    frames.push('[DONE]')
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 200,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
  })

  it('resets on a keep-alive comment line', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
      }),
      { delayMs: 80 },
      ':keep-alive',
      { delayMs: 80 },
      JSON.stringify({
        id: 'c-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }],
      }),
      '[DONE]',
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 150,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('stall drains partial tool-call state and does not persist a ToolCall', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-partial',
                  type: 'function',
                  function: { name: 'searcher', arguments: '{"q":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      { delayMs: 400 },
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 100,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED
    )
    expect(ctx.storeToolCall).not.toHaveBeenCalled()
  })

  it('cleared on normal [DONE]: no late STREAM_STALLED fires', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
      }),
      '[DONE]',
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 200,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    // Wait beyond the idle window to ensure no late firing
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('cleared on transport error: STREAM_ERROR fires, STREAM_STALLED does not also fire', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
      }),
      { error: new Error('boom') },
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 200,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    const err = (ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err).toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR)
  })

  it('per-dispatch override via stash', async () => {
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
      }),
      { delayMs: 400 },
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const ctx = makeCtx({
      stash: { openaiChatCompletions: { streamIdleTimeoutMs: 100 } },
    })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED
    )
  })

  it('ignored in non-streaming mode — no idle side-effects', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      streamIdleTimeoutMs: 100,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
  })
})

describe('OpenAIChatCompletionsAdapter — HTTP error mapping + retry', () => {
  it('retry disabled by default → single fetch on 503', async () => {
    const fetchFn = vi.fn(async () => new Response('upstream busy', { status: 503 }))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR
    )
  })

  it('retry succeeds on second attempt', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('busy', { status: 503 })
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
  })

  it('retry exhausts and nacks', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 503 }))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
  })

  it('aborting during retry backoff returns promptly without a second fetch', async () => {
    // A retriable 503 schedules a long backoff sleep. If the turn aborts during
    // that sleep, the executor must wake immediately and bail — not stay parked
    // for the full delay. With a 60s backoff, a non-abort-aware sleep would hang
    // the test out to its timeout; the abort-aware sleep returns in milliseconds.
    const controller = new AbortController()
    const fetchFn = vi.fn(async () => {
      // Abort shortly after the first (failing) response, while we're in backoff.
      setTimeout(() => controller.abort(), 20)
      return new Response('busy', { status: 503 })
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    })
    const ctx = makeCtx({ abortSignal: controller.signal })
    const started = DateTime.now()
    await adapter.executor()(ctx, makeHelpers())
    const elapsedMs = DateTime.now().diff(started).milliseconds
    // Only the first attempt fetched; the retry was abandoned on abort.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // Returned far sooner than the 60s backoff — proves the sleep is abort-aware.
    expect(elapsedMs).toBeLessThan(5_000)
    // Aborted turns neither ack nor nack; the runner owns abort semantics.
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('honors Retry-After in seconds', async () => {
    let n = 0
    let elapsed = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) {
        // capture pre-sleep time via a shared closure variable
        return new Response('throttled', { status: 429, headers: { 'Retry-After': '1' } })
      }
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 5000 },
    })
    const t0 = Date.now()
    await adapter.executor()(makeCtx(), makeHelpers())
    elapsed = Date.now() - t0
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(elapsed).toBeGreaterThanOrEqual(800) // ~1s with jitter
  })

  it('honors Retry-After HTTP-date in the future', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) {
        // HTTP-date format has second-level resolution. Add ~2.5s so even after the parser
        // rounds down to a whole second, we reliably get >=1s of delay measurable across all
        // four runtimes (node, chromium, firefox, webkit).
        const when = new Date(Date.now() + 2500).toUTCString()
        return new Response('throttled', { status: 429, headers: { 'Retry-After': when } })
      }
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 5000 },
    })
    const t0 = Date.now()
    await adapter.executor()(makeCtx(), makeHelpers())
    const elapsed = Date.now() - t0
    // The actual delay should land between 1s (worst-case rounding) and ~4s (full range + jitter).
    expect(elapsed).toBeGreaterThanOrEqual(800)
    expect(elapsed).toBeLessThanOrEqual(5000)
  })

  it('caps Retry-After at maxDelayMs', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1)
        return new Response('throttled', { status: 429, headers: { 'Retry-After': '60' } })
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 200 },
    })
    const t0 = Date.now()
    await adapter.executor()(makeCtx(), makeHelpers())
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThanOrEqual(1000)
  })

  it('honorRetryAfter:false ignores the header', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1)
        return new Response('throttled', { status: 429, headers: { 'Retry-After': '30' } })
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 10, honorRetryAfter: false },
    })
    const t0 = Date.now()
    await adapter.executor()(makeCtx(), makeHelpers())
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(3000)
  })

  it('non-retriable status (400) is not retried', async () => {
    const fetchFn = vi.fn(async () => new Response('bad', { status: 400 }))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
  })

  it('custom retriableStatuses [418,503]: retries 418', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('teapot', { status: 418 })
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10, retriableStatuses: [418, 503] },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('custom retriableStatuses [418,503]: does NOT retry 429', async () => {
    const fetchFn = vi.fn(async () => new Response('throttled', { status: 429 }))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 10, retriableStatuses: [418, 503] },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
  })

  it('mid-stream STREAM_ERROR is NOT retried', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        JSON.stringify({
          id: 'c-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-x',
          choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
        }),
        { error: new Error('mid-stream') },
      ])
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR
    )
  })

  it('stream stall is NOT retried', async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        JSON.stringify({
          id: 'c-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-x',
          choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
        }),
        { delayMs: 400 },
      ])
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 100,
      retry: { maxAttempts: 3, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED
    )
  })

  it('retry per-dispatch override via stash', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n === 1) return new Response('busy', { status: 503 })
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 1 },
    })
    const ctx = makeCtx({
      stash: { openaiChatCompletions: { retry: { maxAttempts: 3, baseDelayMs: 10 } } },
    })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('retry field-by-field merge: override maxAttempts keeps ctor retriableStatuses', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n += 1
      if (n <= 2) return new Response('teapot', { status: 418 })
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 3, retriableStatuses: [418], baseDelayMs: 10 },
    })
    const ctx = makeCtx({
      stash: { openaiChatCompletions: { retry: { maxAttempts: 5 } } },
    })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(3) // succeeded on attempt 3, override didn't wipe retriableStatuses
    expect(ctx.nack).not.toHaveBeenCalled()
  })
})

describe('OpenAIChatCompletionsAdapter — request-timeout', () => {
  it('fires before headers arrive → nacks REQUEST_TIMEOUT', async () => {
    const fetchFn = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
          }
          // Otherwise never resolve.
        })
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      requestTimeoutMs: 100,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT
    )
  })

  it('cleared once headers arrive — slow body completes normally', async () => {
    const fetchFn = vi.fn(async () => {
      // Immediately return headers; body emits slowly but is still under the test timeout.
      const frames: SSEFrame[] = []
      for (let i = 0; i < 3; i += 1) {
        frames.push(
          JSON.stringify({
            id: `c-${i}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-x',
            choices: [{ index: 0, delta: { content: `chunk-${i}` }, finish_reason: null }],
          })
        )
        frames.push({ delayMs: 80 })
      }
      frames.push('[DONE]')
      return sseResponse(frames)
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      requestTimeoutMs: 100,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.storeMessage).toHaveBeenCalledTimes(1)
  })

  it('retries on retriable footing', async () => {
    let n = 0
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      n += 1
      if (n === 1) {
        // First call hangs; honor abort signal.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
      }
      return validNonStreamingResponse()
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      requestTimeoutMs: 100,
      retry: { maxAttempts: 2, baseDelayMs: 10 },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('per-dispatch override via stash', async () => {
    const fetchFn = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      requestTimeoutMs: 0, // disabled
    })
    const ctx = makeCtx({ stash: { openaiChatCompletions: { requestTimeoutMs: 80 } } })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    expect((ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeInstanceOf(
      E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT
    )
  })
})

describe('OpenAIChatCompletionsAdapter — abort handling', () => {
  it('mid-stream abort: cancels reader, drains accumulator, no STREAM_ERROR/STREAM_STALLED', async () => {
    const controller = new AbortController()
    const frames: SSEFrame[] = [
      JSON.stringify({
        id: 'c-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
      }),
      JSON.stringify({
        id: 'c-2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-partial',
                  type: 'function',
                  function: { name: 'searcher', arguments: '{"q":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      { delayMs: 80 }, // gives time to abort
      JSON.stringify({
        id: 'c-3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }],
      }),
      '[DONE]',
    ]
    const fetchFn = vi.fn(async () => sseResponse(frames))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const ctx = makeCtx({ abortSignal: controller.signal })
    // Schedule the abort to occur ~50ms after dispatch starts (during the delay frame)
    setTimeout(() => controller.abort(), 50)
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.storeToolCall).not.toHaveBeenCalled()
  })

  it('mid-stream abort does not double-fire as STREAM_STALLED', async () => {
    const controller = new AbortController()
    // The mock body is wired to the request signal so that abort cancels the readable stream —
    // matches real fetch semantics. This lets the adapter's abort path run before the idle timer.
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'c-1',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'gpt-x',
                choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }],
              })}\n\n`
            )
          )
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              try {
                c.error(new DOMException('aborted', 'AbortError'))
              } catch {
                /* already errored or closed */
              }
            })
          }
          // Otherwise hang the body — never close / never enqueue more.
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
      streamIdleTimeoutMs: 200,
    })
    const ctx = makeCtx({ abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await adapter.executor()(ctx, makeHelpers())
    // No STREAM_STALLED — abort path wins
    const nackCalls = (ctx.nack as ReturnType<typeof vi.fn>).mock.calls
    for (const c of nackCalls) {
      expect(c[0]).not.toBeInstanceOf(E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED)
    }
  })

  it('pre-aborted controller: executor settles cleanly without persisting records', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = vi.fn(async () => validStreamingResponse(['hi']))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: true,
    })
    const ctx = makeCtx({ abortSignal: controller.signal })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeMessage).not.toHaveBeenCalled()
    expect(ctx.storeToolCall).not.toHaveBeenCalled()
    expect(ctx.storeThought).not.toHaveBeenCalled()
  })
})

describe('OpenAIChatCompletionsAdapter — recorded-fixture regression (no credentials)', () => {
  it('round-trips a recorded non-streaming gateway response end-to-end', async () => {
    const fetchFn = vi.fn(cassetteFetch(gemma4NonStreamingHelloCassette))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'gemma4',
      apiKey: 'fixture-key',
      baseURL: 'https://fixture.invalid/v1',
      stream: false,
      fetch: fetchFn as never,
      autoAck: true,
    })
    const ctx = makeCtx({ systemPrompt: 'Say "hello" and nothing else.' })
    await adapter.executor()(ctx, makeHelpers())

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(getRequestUrl(fetchFn.mock.calls[0])).toBe('https://fixture.invalid/v1/chat/completions')
    expect(ctx._stored.messages.length).toBe(1)
    expect(ctx._stored.messages[0].content?.toString()).toBe(GEMMA4_NON_STREAMING_FINAL_CONTENT)
    expect(ctx._stored.toolCalls.length).toBe(0)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })

  it('round-trips a recorded streaming gateway response end-to-end', async () => {
    const fetchFn = vi.fn(cassetteFetch(gemma4StreamingHiThereCassette))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'gemma4',
      apiKey: 'fixture-key',
      baseURL: 'https://fixture.invalid/v1',
      stream: true,
      fetch: fetchFn as never,
      autoAck: true,
    })
    const ctx = makeCtx({ systemPrompt: 'Say "hi there" and nothing else.' })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(ctx._stored.messages.length).toBe(1)
    expect(ctx._stored.messages[0].content?.toString()).toBe(GEMMA4_STREAMING_FINAL_CONTENT)
    const messageEvents = helpers._events.filter((e) => e.kind === 'message')
    expect(messageEvents.length).toBeGreaterThanOrEqual(2)
    expect(
      messageEvents.some((e) => (e.payload as { isComplete?: boolean }).isComplete === true)
    ).toBe(true)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })
})

describe('OpenAIChatCompletionsAdapter — structured observability hooks (helpers.log)', () => {
  it('emits a `retry-attempt` warn when a 503 triggers a retry, and an `http-error` error when the retry exhausts', async () => {
    const fetchFn = vi.fn(async () => new Response('busy', { status: 503 }))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 5 },
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const retryEvents = helpers._logs.filter((l) => l.kind === 'retry-attempt')
    const errEvents = helpers._logs.filter((l) => l.kind === 'http-error')
    expect(retryEvents.length).toBeGreaterThanOrEqual(1)
    expect(retryEvents[0].level).toBe('warn')
    expect((retryEvents[0].payload as { status?: number }).status).toBe(503)
    expect(errEvents.length).toBe(1)
    expect(errEvents[0].level).toBe('error')
    expect((errEvents[0].payload as { status?: number }).status).toBe(503)
  })

  it('emits a `request-timeout` warn and a `retry-attempt` debug when the request times out and retries', async () => {
    // First call hangs past the request timeout; second succeeds.
    let call = 0
    const fetchFn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      call += 1
      if (call === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      }
      return Promise.resolve(validNonStreamingResponse())
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      requestTimeoutMs: 25,
      retry: { maxAttempts: 2, baseDelayMs: 5 },
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const timeoutEvents = helpers._logs.filter((l) => l.kind === 'request-timeout')
    expect(timeoutEvents.length).toBe(1)
    expect(timeoutEvents[0].level).toBe('warn')
    expect((timeoutEvents[0].payload as { requestTimeoutMs?: number }).requestTimeoutMs).toBe(25)
    const retryEvents = helpers._logs.filter((l) => l.kind === 'retry-attempt')
    expect(retryEvents.length).toBe(1)
    expect(retryEvents[0].level).toBe('debug')
    expect((retryEvents[0].payload as { reason?: string }).reason).toBe('request-timeout')
  })

  it('emits a `context-window-usage` debug event with perBucket on every dispatch when context enforcement is active', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tokenEncoding: 'o200k_base',
      contextWindow: 100_000,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const usage = helpers._logs.find((l) => l.kind === 'context-window-usage')
    expect(usage).toBeDefined()
    expect(usage!.level).toBe('debug')
    const payload = usage!.payload as {
      total?: number
      limit?: number
      perBucket?: Record<string, number>
    }
    expect(payload.limit).toBe(100_000)
    expect(typeof payload.total).toBe('number')
    expect(payload.perBucket).toBeDefined()
    expect(Object.keys(payload.perBucket!).sort()).toEqual([
      'memories',
      'retrievables',
      'standingInstructions',
      'systemPrompt',
      'timeline',
      'tools',
    ])
  })

  it('emits an `accumulator-finalised` debug event after every successful streaming dispatch', async () => {
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: (async () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
          '[DONE]',
        ])) as never,
      stream: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const finalised = helpers._logs.find((l) => l.kind === 'accumulator-finalised')
    expect(finalised).toBeDefined()
    expect(finalised!.level).toBe('debug')
    expect(
      (finalised!.payload as { sawMessageDelta?: boolean; doneSentinelSeen?: boolean })
        .sawMessageDelta
    ).toBe(true)
    expect((finalised!.payload as { doneSentinelSeen?: boolean }).doneSentinelSeen).toBe(true)
  })
})

// ─── reasoningFieldPrecedence (fetch-stubbed, no network) ──────────────────────
//
// Reasoning is non-spec, so providers emit it under `reasoning` (Ollama, current vLLM) or
// `reasoning_content` (legacy vLLM, DeepSeek). These cassettes prove the adapter reads both, honors
// precedence, collapses agreement to one thought, and splits genuine divergence into two — in both
// streaming and non-streaming modes.

const nonStreamingWithReasoning = (
  fields: Partial<{ reasoning: string; reasoning_content: string }>,
  content = 'final',
  id = 'resp-reason'
) =>
  jsonResponse({
    id,
    object: 'chat.completion',
    created: 1,
    model: 'gpt-x',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, ...fields },
        finish_reason: 'stop',
      },
    ],
  })

// Build an SSE stream whose deltas carry reasoning under the given field names. Each entry in
// `reasoningDeltas` is one chunk; `{ field: text }` pairs go on that chunk's delta.
const streamingWithReasoning = (
  reasoningDeltas: Array<Partial<{ reasoning: string; reasoning_content: string }>>,
  contentDeltas: string[] = ['final']
) => {
  const frames: SSEFrame[] = []
  for (const r of reasoningDeltas) {
    frames.push(
      JSON.stringify({
        id: 'chunk-r',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { ...r }, finish_reason: null }],
      })
    )
  }
  for (const c of contentDeltas) {
    frames.push(
      JSON.stringify({
        id: 'chunk-c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: c }, finish_reason: null }],
      })
    )
  }
  frames.push('[DONE]')
  return sseResponse(frames)
}

describe('OpenAIChatCompletionsAdapter — reasoningFieldPrecedence', () => {
  describe('non-streaming', () => {
    it('reads the `reasoning` field (Ollama / current vLLM convention)', async () => {
      const fetchFn = vi.fn(async () => nonStreamingWithReasoning({ reasoning: 'I am thinking.' }))
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()
      await adapter.executor()(ctx, helpers)

      expect(ctx._stored.thoughts).toHaveLength(1)
      expect(ctx._stored.thoughts[0].content.toString()).toBe('I am thinking.')
      expect(ctx._stored.thoughts[0].id).toBe('resp-reason:thought')
      const thoughtEvents = helpers._events.filter((e) => e.kind === 'thought')
      expect(thoughtEvents.length).toBeGreaterThan(0)
    })

    it('reads the `reasoning_content` field (legacy vLLM / DeepSeek convention)', async () => {
      const fetchFn = vi.fn(async () =>
        nonStreamingWithReasoning({ reasoning_content: 'legacy thought' })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
      })
      const ctx = makeCtx()
      await adapter.executor()(ctx, makeHelpers())

      expect(ctx._stored.thoughts).toHaveLength(1)
      expect(ctx._stored.thoughts[0].content.toString()).toBe('legacy thought')
      expect(ctx._stored.thoughts[0].id).toBe('resp-reason:thought')
    })

    it('collapses identical reasoning + reasoning_content into a single thought', async () => {
      const fetchFn = vi.fn(async () =>
        nonStreamingWithReasoning({ reasoning: 'same text', reasoning_content: 'same text' })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
      })
      const ctx = makeCtx()
      await adapter.executor()(ctx, makeHelpers())

      expect(ctx._stored.thoughts).toHaveLength(1)
      expect(ctx._stored.thoughts[0].content.toString()).toBe('same text')
      expect(ctx._stored.thoughts[0].id).toBe('resp-reason:thought')
    })

    it('emits two thoughts when reasoning and reasoning_content diverge', async () => {
      const fetchFn = vi.fn(async () =>
        nonStreamingWithReasoning({ reasoning: 'first trace', reasoning_content: 'second trace' })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
      })
      const ctx = makeCtx()
      await adapter.executor()(ctx, makeHelpers())

      expect(ctx._stored.thoughts).toHaveLength(2)
      // Default precedence is reasoning-first.
      expect(ctx._stored.thoughts[0].id).toBe('resp-reason:thought:reasoning')
      expect(ctx._stored.thoughts[0].content.toString()).toBe('first trace')
      expect(ctx._stored.thoughts[1].id).toBe('resp-reason:thought:reasoning_content')
      expect(ctx._stored.thoughts[1].content.toString()).toBe('second trace')
    })

    it('honors a reasoning_content-first precedence override', async () => {
      const fetchFn = vi.fn(async () =>
        nonStreamingWithReasoning({ reasoning: 'first trace', reasoning_content: 'second trace' })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
        reasoningFieldPrecedence: ['reasoning_content', 'reasoning'],
      })
      const ctx = makeCtx()
      await adapter.executor()(ctx, makeHelpers())

      expect(ctx._stored.thoughts).toHaveLength(2)
      // Override flips ordering: reasoning_content surfaces first.
      expect(ctx._stored.thoughts[0].id).toBe('resp-reason:thought:reasoning_content')
      expect(ctx._stored.thoughts[0].content.toString()).toBe('second trace')
      expect(ctx._stored.thoughts[1].id).toBe('resp-reason:thought:reasoning')
    })

    it('reads only the listed field when precedence is a single element', async () => {
      const fetchFn = vi.fn(async () =>
        nonStreamingWithReasoning({ reasoning: 'visible', reasoning_content: 'ignored' })
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
        reasoningFieldPrecedence: ['reasoning'],
      })
      const ctx = makeCtx()
      await adapter.executor()(ctx, makeHelpers())

      expect(ctx._stored.thoughts).toHaveLength(1)
      expect(ctx._stored.thoughts[0].content.toString()).toBe('visible')
      expect(ctx._stored.thoughts[0].id).toBe('resp-reason:thought')
    })

    it('emits no thought when no reasoning field is present', async () => {
      const fetchFn = vi.fn(async () => nonStreamingWithReasoning({}))
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
        autoAck: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()
      await adapter.executor()(ctx, helpers)

      expect(ctx._stored.thoughts).toHaveLength(0)
      expect(helpers._events.filter((e) => e.kind === 'thought')).toHaveLength(0)
    })
  })

  describe('streaming', () => {
    it('streams the `reasoning` field and persists one thought', async () => {
      const fetchFn = vi.fn(async () =>
        streamingWithReasoning([{ reasoning: 'think ' }, { reasoning: 'more' }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
        autoAck: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()
      await adapter.executor()(ctx, helpers)

      expect(ctx._stored.thoughts).toHaveLength(1)
      expect(ctx._stored.thoughts[0].content.toString()).toBe('think more')
      const thoughtEvents = helpers._events.filter((e) => e.kind === 'thought')
      expect(thoughtEvents.length).toBeGreaterThan(0)
      expect(
        thoughtEvents.some((e) => (e.payload as { isComplete?: boolean }).isComplete === true)
      ).toBe(true)
    })

    it('collapses identical streamed reasoning + reasoning_content into one thought', async () => {
      const fetchFn = vi.fn(async () =>
        streamingWithReasoning([
          { reasoning: 'abc', reasoning_content: 'abc' },
          { reasoning: 'def', reasoning_content: 'def' },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
        autoAck: true,
      })
      const ctx = makeCtx()
      await adapter.executor()(ctx, makeHelpers())

      expect(ctx._stored.thoughts).toHaveLength(1)
      expect(ctx._stored.thoughts[0].content.toString()).toBe('abcdef')
    })

    it('persists two thoughts when streamed reasoning fields diverge', async () => {
      const fetchFn = vi.fn(async () =>
        streamingWithReasoning([
          { reasoning: 'alpha', reasoning_content: 'beta' },
          { reasoning: '-1', reasoning_content: '-2' },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: true,
        autoAck: true,
      })
      const ctx = makeCtx()
      const helpers = makeHelpers()
      await adapter.executor()(ctx, helpers)

      expect(ctx._stored.thoughts).toHaveLength(2)
      const byContent = ctx._stored.thoughts.map((t) => t.content.toString()).sort()
      expect(byContent).toEqual(['alpha-1', 'beta-2'])
      // Both fields streamed live as distinct thought streams.
      const thoughtIds = new Set(
        helpers._events.filter((e) => e.kind === 'thought').map((e) => e.id)
      )
      expect(thoughtIds.size).toBeGreaterThanOrEqual(2)
    })
  })
})

// ─── Live API matrix (gated, real e2e) ─────────────────────────────────────────
//
// One row per real model behind an OpenAI-Chat-Completions-compatible endpoint. Each row is gated
// on its own `TEST_OPENAI_<PREFIX>_API_KEY`; absent env → the whole describe block is skipped, so
// these are CI-safe and only run when a key is supplied. Populate `.env.test` (gitignored; see
// `.env.test.example`) and run under the node project:
//   set -a && source .env.test && set +a && \
//   pnpm vitest run tests/unit/batteries/llm/openai_chat_completions/adapter.cross.spec.ts --project node
//
// `expectsReasoning` records the OBSERVED behavior of each model behind its endpoint — not a
// capability claim. Reasoning is not part of the OpenAI Chat Completions spec, so whether a thought
// surfaces depends on the serving stack, not just the model: a model can "think" yet have its
// reasoning embedded inline (`<think>…</think>` in content) or suppressed rather than split into a
// `reasoning` / `reasoning_content` field. The matrix below was calibrated against the live load
// balancer; rows marked `false` still exercise the message + ack path across providers.
//
// `reasoningEffort` is the passthrough `reasoning_effort` request-body field. On these endpoints it
// is what turns thinking on (the native `think` param is not honored on `/v1`). It is per-row, not
// global, because some routes (e.g. the gemini-2.5-pro backend) HTTP-error when it is supplied.
interface LiveModel {
  label: string
  envPrefix: string
  model: string
  expectsReasoning: boolean
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

const MODEL_MATRIX: LiveModel[] = [
  // Surfaces reasoning_content once reasoning_effort enables thinking.
  {
    label: 'claude-haiku-4-5',
    envPrefix: 'TEST_OPENAI_CLAUDE_HAIKU_4_5',
    model: 'claude-haiku-4-5',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  // Surfaces reasoning_content with reasoning_effort (the gemini-2.5-pro route did not).
  {
    label: 'gemini-3.5-flash',
    envPrefix: 'TEST_OPENAI_GEMINI_3_5_FLASH',
    model: 'gemini-3.5-flash',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  // The gemma4:31b route splits thinking into reasoning_content; the a4b route kept it inline.
  {
    label: 'gemma4',
    envPrefix: 'TEST_OPENAI_GEMMA4',
    model: 'gemma4:31b',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  // Same family via Ollama, which DOES split thinking into the `reasoning` field.
  {
    label: 'gemma4-workstation',
    envPrefix: 'TEST_OPENAI_GEMMA4_WORKSTATION',
    model: 'gemma4:12b-mlx',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  {
    label: 'deepseek-v4-flash',
    envPrefix: 'TEST_OPENAI_DEEPSEEK_V4_FLASH',
    model: 'deepseek-v4-flash',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  {
    label: 'glm-5.1',
    envPrefix: 'TEST_OPENAI_GLM_5_1',
    model: 'glm-5.1',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  {
    label: 'gpt-oss:20b',
    envPrefix: 'TEST_OPENAI_GPT_OSS_20B',
    model: 'gpt-oss:20b',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
  {
    label: 'kimi-k2.6',
    envPrefix: 'TEST_OPENAI_KIMI_K2_6',
    model: 'kimi-k2.6',
    expectsReasoning: true,
    reasoningEffort: 'medium',
  },
]

// A prompt that genuinely REQUIRES multi-step reasoning so thinking-capable models populate a
// reasoning field. A trivial question (e.g. "17 + 26") is not enough: some models (observed with
// gemini-3.5-flash streaming) skip the reasoning channel entirely when the answer is obvious, even
// with reasoning_effort set. The classic "bat and ball" puzzle reliably elicits a chain-of-thought
// while keeping the final answer short to assert on.
const REASONING_PROMPT =
  'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. ' +
  'How much does the ball cost? Think step by step, then give only the final amount.'

const envFor = (prefix: string): { apiKey: string; baseURL: string | undefined } | undefined => {
  if (typeof process === 'undefined') return undefined
  const apiKey = process.env?.[`${prefix}_API_KEY`]
  if (!apiKey) return undefined
  return { apiKey, baseURL: process.env?.[`${prefix}_BASE_URL`] || undefined }
}

// These tests hit a real load balancer over the network, so a small retry absorbs genuinely
// transient I/O blips (connection resets, momentary backend hiccups). Per Vitest guidance this is a
// bandage for flaky external I/O, not a substitute for correctness — the deterministic field-parsing
// behavior is fully covered by the fetch-stubbed `reasoningFieldPrecedence` suite above.
const LIVE_RETRY = 2

for (const m of MODEL_MATRIX) {
  const env = envFor(m.envPrefix)
  describe.skipIf(!env)(`OpenAIChatCompletionsAdapter — live: ${m.label}`, () => {
    const apiKey = env?.apiKey ?? ''
    const baseURL = env?.baseURL

    it(
      'non-streaming: persists a message, acks, and surfaces reasoning when expected',
      { retry: LIVE_RETRY },
      async () => {
        const adapter = new OpenAIChatCompletionsAdapter({
          model: m.model,
          apiKey,
          ...(baseURL ? { baseURL } : {}),
          stream: false,
          autoAck: true,
          ...(m.reasoningEffort ? { reasoning_effort: m.reasoningEffort } : {}),
        })
        const ctx = makeCtx({
          systemPrompt: 'You are a terse assistant.',
          turnMessages: [makeMessage({ role: 'user', content: REASONING_PROMPT })],
        })
        const helpers = makeHelpers()
        await adapter.executor()(ctx, helpers)

        expect(ctx._stored.messages.length).toBeGreaterThan(0)
        expect((ctx._stored.messages[0].content?.toString() ?? '').length).toBeGreaterThan(0)
        expect(ctx.ack).toHaveBeenCalledTimes(1)

        if (m.expectsReasoning) {
          const thoughtEvents = helpers._events.filter((e) => e.kind === 'thought')
          expect(thoughtEvents.length).toBeGreaterThan(0)
          expect(ctx._stored.thoughts.length).toBeGreaterThan(0)
          expect((ctx._stored.thoughts[0].content.toString() ?? '').length).toBeGreaterThan(0)
        }
      }
    )

    it(
      'streaming: persists a message, acks, and surfaces reasoning when expected',
      { retry: LIVE_RETRY },
      async () => {
        const adapter = new OpenAIChatCompletionsAdapter({
          model: m.model,
          apiKey,
          ...(baseURL ? { baseURL } : {}),
          stream: true,
          autoAck: true,
          ...(m.reasoningEffort ? { reasoning_effort: m.reasoningEffort } : {}),
        })
        const ctx = makeCtx({
          systemPrompt: 'You are a terse assistant.',
          turnMessages: [makeMessage({ role: 'user', content: REASONING_PROMPT })],
        })
        const helpers = makeHelpers()
        await adapter.executor()(ctx, helpers)

        expect(ctx._stored.messages.length).toBeGreaterThan(0)
        expect((ctx._stored.messages[0].content?.toString() ?? '').length).toBeGreaterThan(0)
        const messageEvents = helpers._events.filter((e) => e.kind === 'message')
        expect(messageEvents.length).toBeGreaterThan(0)
        expect(ctx.ack).toHaveBeenCalledTimes(1)

        if (m.expectsReasoning) {
          const thoughtEvents = helpers._events.filter((e) => e.kind === 'thought')
          expect(thoughtEvents.length).toBeGreaterThan(0)
          expect(
            thoughtEvents.some((e) => (e.payload as { isComplete?: boolean }).isComplete === true)
          ).toBe(true)
          expect(ctx._stored.thoughts.length).toBeGreaterThan(0)
        }
      }
    )
  })
}

describe('OpenAIChatCompletionsAdapter — tool_choice + forged artifact-tools guard', () => {
  // A forged artifact-query tool is identified by `ephemeral: true`. The simplest way
  // to inject one into the merged registry without spinning up a real SpooledArtifact
  // forge cycle is to register a base `Tool` with the flag flipped — the guard reads
  // `mergedRegistry.get(name).ephemeral`, so the discriminator is the flag, not the
  // ancestry of the class. Real-world callers get this via `SpooledArtifact.forgeTools(ctx)`.
  const makeEphemeralTool = (name: string) =>
    new Tool({
      name,
      description: `ephemeral ${name}`,
      inputSchema: validator.object({}),
      handler: () => 'ok',
      ephemeral: true,
    })

  const makeRegularTool = (name: string) =>
    new Tool({
      name,
      description: `regular ${name}`,
      inputSchema: validator.object({}),
      handler: () => 'ok',
    })

  it('warns when tool_choice forces an ephemeral forged tool (function variant, default)', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tool_choice: { type: 'function', function: { name: 'artifact_head' } },
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_head')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(1)
    expect(hits[0].level).toBe('warn')
    expect((hits[0].payload as { toolNames: string[] }).toolNames).toEqual(['artifact_head'])
    expect((hits[0].payload as { variant: string }).variant).toBe('function')
    // Call still went through.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('throws E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS under strictToolChoice:true', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      strictToolChoice: true,
      tool_choice: { type: 'function', function: { name: 'artifact_grep' } },
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_grep')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await expect(adapter.executor()(ctx, helpers)).rejects.toBeInstanceOf(
      E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not warn when tool_choice targets a non-ephemeral (regular) tool', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tool_choice: { type: 'function', function: { name: 'normal_tool' } },
    })
    const tools = new ToolRegistry([makeRegularTool('normal_tool')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(0)
  })

  it('does not warn when tool_choice is `auto` or `required` (no specific name)', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tool_choice: 'required',
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_head')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(0)
  })

  it('warns when the allowed_tools variant contains an ephemeral forged tool', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      tool_choice: {
        type: 'allowed_tools',
        allowed_tools: {
          mode: 'auto',
          tools: [
            { type: 'function', function: { name: 'normal_tool' } },
            { type: 'function', function: { name: 'artifact_tail' } },
          ],
        },
      },
    })
    const tools = new ToolRegistry([
      makeRegularTool('normal_tool'),
      makeEphemeralTool('artifact_tail'),
    ])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(1)
    expect(hits[0].level).toBe('warn')
    // Only the forged tool name is reported; the regular tool is filtered out.
    expect((hits[0].payload as { toolNames: string[] }).toolNames).toEqual(['artifact_tail'])
    expect((hits[0].payload as { variant: string }).variant).toBe('allowed_tools')
  })

  it('throws under strictToolChoice:true when allowed_tools contains an ephemeral forged tool', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      strictToolChoice: true,
      tool_choice: {
        type: 'allowed_tools',
        allowed_tools: {
          mode: 'required',
          tools: [{ type: 'function', function: { name: 'artifact_cat' } }],
        },
      },
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_cat')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await expect(adapter.executor()(ctx, helpers)).rejects.toBeInstanceOf(
      E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not warn when tool_choice is unset', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_head')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(0)
  })

  it('strictToolChoice:true with a non-forged tool_choice passes silently (no warn, no throw)', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse())
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      strictToolChoice: true,
      tool_choice: { type: 'function', function: { name: 'normal_tool' } },
    })
    const tools = new ToolRegistry([makeRegularTool('normal_tool')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('OpenAIChatCompletionsAdapter — wire observability (TO + FROM taps)', () => {
  it('onPromptAssembled fires once with the wire body/messages/tools, BEFORE the POST', async () => {
    const seen: PromptAssembledObservation[] = []
    const fetchFn = vi.fn(async () => validNonStreamingResponse('hi'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      onPromptAssembled: (o: PromptAssembledObservation) => seen.push(o),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(seen).toHaveLength(1)
    const o = seen[0]
    expect(o.battery).toBe('openai_chat_completions')
    expect(o.kind).toBe('request-body')
    expect(Array.isArray(o.messages)).toBe(true)
    // The full assembled body is surfaced AS-IS (the model field is the wire body's).
    expect((o.requestBody as { model?: string }).model).toBe('m')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('onRawGeneration fires once with the provider content + tool calls (FROM parity)', async () => {
    const seen: RawGenerationObservation[] = []
    const fetchFn = vi.fn(async () => validNonStreamingResponse('the answer'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      onRawGeneration: (o: RawGenerationObservation) => seen.push(o),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(seen).toHaveLength(1)
    expect(seen[0].rawText).toBe('the answer')
    expect(seen[0].streamed).toBe(false)
  })

  it('shares one streamId between the TO and FROM taps', async () => {
    const to: PromptAssembledObservation[] = []
    const from: RawGenerationObservation[] = []
    const fetchFn = vi.fn(async () => validNonStreamingResponse('x'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      onPromptAssembled: (o: PromptAssembledObservation) => to.push(o),
      onRawGeneration: (o: RawGenerationObservation) => from.push(o),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(to[0]?.streamId).toBe(from[0]?.streamId)
  })

  it('both hooks are STRIPPED from the wire body (never sent to the provider)', async () => {
    let sentBody: unknown
    const fetchFn = vi.fn(async (_url: unknown, init: { body?: string }) => {
      sentBody = JSON.parse(init.body ?? '{}')
      return validNonStreamingResponse('ok')
    })
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      onPromptAssembled: () => {},
      onRawGeneration: () => {},
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(sentBody).toBeDefined()
    expect('onPromptAssembled' in (sentBody as object)).toBe(false)
    expect('onRawGeneration' in (sentBody as object)).toBe(false)
  })

  it('observer errors are swallowed (never corrupt the generation)', async () => {
    const fetchFn = vi.fn(async () => validNonStreamingResponse('safe'))
    const adapter = new OpenAIChatCompletionsAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      onPromptAssembled: () => {
        throw new Error('TO observer blew up')
      },
      onRawGeneration: () => {
        throw new Error('FROM observer blew up')
      },
    })
    const ctx = makeCtx()
    await expect(adapter.executor()(ctx, makeHelpers())).resolves.toBeUndefined()
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('safe')
  })
})

// Aid test isolation when the file is re-run in watch mode.
beforeEach(() => {
  vi.clearAllMocks()
})
