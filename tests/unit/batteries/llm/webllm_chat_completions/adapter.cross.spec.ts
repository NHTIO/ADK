import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import {
  WebLLMChatCompletionsAdapter,
  E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS,
} from '@nhtio/adk/batteries/llm/webllm_chat_completions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

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
} => {
  const events: Array<{ kind: string; id: string; payload: unknown }> = []
  const logs: Array<{ level: string; kind: string; message: string; payload?: unknown }> = []
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
    _events: events,
    _logs: logs,
  } as unknown as DispatchExecutorHelpers & {
    _events: typeof events
    _logs: typeof logs
  }
}

describe('WebLLMChatCompletionsAdapter — static surface', () => {
  it('uses its own stash key and guard', () => {
    expect(WebLLMChatCompletionsAdapter.STASH_KEY).toBe('webLLMChatCompletions')
    const a = new WebLLMChatCompletionsAdapter({
      model: 'm',
      stream: false,
      engine: makeEngine({ content: 'ok' }),
    })
    expect(WebLLMChatCompletionsAdapter.isWebLLMChatCompletionsAdapter(a)).toBe(true)
    expect(WebLLMChatCompletionsAdapter.isWebLLMChatCompletionsAdapter({})).toBe(false)
  })
})

describe('WebLLMChatCompletionsAdapter — validation', () => {
  it('requires a model and rejects HTTP-only OpenAI options', () => {
    expect(() => new WebLLMChatCompletionsAdapter({})).toThrow(
      E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS
    )
    expect(
      () => new WebLLMChatCompletionsAdapter({ model: 'm', baseURL: 'https://example.test' })
    ).toThrow(E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS)
  })
})

describe('WebLLMChatCompletionsAdapter — engine invocation', () => {
  it('sends a Chat Completions body to a supplied engine and stores non-streaming text', async () => {
    const engine = makeEngine({ content: 'hello from webllm' })
    const adapter = new WebLLMChatCompletionsAdapter({
      model: 'model-a',
      stream: false,
      engine,
      autoAck: true,
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })

    await adapter.executor()(ctx, makeHelpers())

    expect(engine.requests).toHaveLength(1)
    const request = engine.requests[0]
    expect(request).toBeDefined()
    expect(request?.model).toBe('model-a')
    expect(request?.stream).toBe(false)
    expect(Array.isArray(request?.messages)).toBe(true)
    const stored = ctx._stored.messages[0]
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(stored).toBeDefined()
    expect(stored?.content?.toString()).toBe('hello from webllm')
  })

  it('supports lazy createEngine and reuses the created engine', async () => {
    const engine = makeEngine({ content: 'created' })
    const createEngine = vi.fn(async () => engine)
    const adapter = new WebLLMChatCompletionsAdapter({
      model: 'model-a',
      stream: false,
      createEngine,
      isWebGPUAvailable: () => true,
    })

    await adapter.executor()(makeCtx(), makeHelpers())
    await adapter.executor()(makeCtx(), makeHelpers())

    expect(createEngine).toHaveBeenCalledOnce()
    expect(engine.requests).toHaveLength(2)
  })

  it('consumes streaming async chunks and stores final text', async () => {
    const engine = makeStreamingEngine(['hi ', 'there'])
    const adapter = new WebLLMChatCompletionsAdapter({
      model: 'model-a',
      stream: true,
      engine,
      autoAck: true,
    })
    const ctx = makeCtx()

    await adapter.executor()(ctx, makeHelpers())

    const stored = ctx._stored.messages[0]
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(stored).toBeDefined()
    expect(stored?.content?.toString()).toBe('hi there')
  })

  it('autoAck defaults to false → no ack on tool-call-free response', async () => {
    const engine = makeEngine({ content: 'hello world' })
    const adapter = new WebLLMChatCompletionsAdapter({ model: 'model-a', stream: false, engine })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages.length).toBeGreaterThan(0)
  })

  it('autoAck:false explicit → no ack', async () => {
    const engine = makeEngine({ content: 'hello world' })
    const adapter = new WebLLMChatCompletionsAdapter({
      model: 'model-a',
      stream: false,
      engine,
      autoAck: false,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages.length).toBeGreaterThan(0)
  })

  it('does not leak the autoAck control key into the engine request body', async () => {
    // autoAck is ADK-internal control state; it must never reach the engine's
    // chat.completions.create payload. (unsupportedMediaPolicy is already a
    // control key on this adapter and is covered by the same filter.)
    const engine = makeEngine({ content: 'ok' })
    const adapter = new WebLLMChatCompletionsAdapter({
      model: 'model-a',
      stream: false,
      engine,
      autoAck: true,
      unsupportedMediaPolicy: 'fallback-stash',
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const request = engine.requests[0]
    expect(request).toBeDefined()
    expect(request).not.toHaveProperty('autoAck')
    expect(request).not.toHaveProperty('unsupportedMediaPolicy')
  })
})

const makeEngine = (opts: { content: string }) => {
  const requests: Array<Record<string, unknown>> = []
  return {
    requests,
    chat: {
      completions: {
        create: vi.fn(async (request: Record<string, unknown>) => {
          requests.push(request)
          return {
            id: 'cmpl-1',
            choices: [{ message: { role: 'assistant', content: opts.content } }],
          }
        }),
      },
    },
  }
}

const makeStreamingEngine = (parts: string[]) => {
  const requests: Array<Record<string, unknown>> = []
  return {
    requests,
    chat: {
      completions: {
        create: vi.fn(async (request: Record<string, unknown>) => {
          requests.push(request)
          async function* gen() {
            for (const part of parts) {
              yield { choices: [{ delta: { content: part } }] }
            }
          }
          return gen()
        }),
      },
    },
  }
}
