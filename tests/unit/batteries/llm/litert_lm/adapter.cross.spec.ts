import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { LiteRtLmAdapter, E_INVALID_LITERT_LM_OPTIONS } from '@nhtio/adk/batteries/llm/litert_lm'
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
import type { DispatchContext } from '@nhtio/adk/types'
import type { LiteRtMessage } from '@nhtio/adk/batteries/llm/litert_lm'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// ─── shared mock context / helpers (mirrors the webllm + openai battery specs) ──────────────────────

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
    reportGenerationStats: vi.fn(),
    _events: events,
    _logs: logs,
  } as unknown as DispatchExecutorHelpers & {
    _events: typeof events
    _logs: typeof logs
  }
}

// ─── fake LiteRT engine + conversation ──────────────────────────────────────────────────────────────

interface FakeConversationOpts {
  /** Non-streaming reply. */
  message?: Partial<LiteRtMessage>
  /** Streaming chunks (each a partial Message). */
  chunks?: Array<Partial<LiteRtMessage>>
  /** If set, sendMessageStreaming throws this on call. */
  throwOnStream?: Error
  /** If set, sendMessage throws this on call. */
  throwOnSend?: Error
}

interface FakeEngineHandle {
  engine: unknown
  /** Inputs captured per sendMessage / sendMessageStreaming call. */
  inputs: unknown[]
  /** ConversationConfig objects captured per createConversation call. */
  configs: unknown[]
  cancelled: number
}

const makeEngine = (opts: FakeConversationOpts): FakeEngineHandle => {
  const inputs: unknown[] = []
  const configs: unknown[] = []
  const handle: FakeEngineHandle = { engine: undefined, inputs, configs, cancelled: 0 }
  const engine = {
    createConversation: vi.fn(async (config: unknown) => {
      configs.push(config)
      return {
        sendMessage: vi.fn(async (input: unknown) => {
          inputs.push(input)
          if (opts.throwOnSend) throw opts.throwOnSend
          return {
            role: 'assistant',
            content: '',
            ...(opts.message ?? {}),
          } as LiteRtMessage
        }),
        sendMessageStreaming: vi.fn((input: unknown) => {
          inputs.push(input)
          if (opts.throwOnStream) throw opts.throwOnStream
          const chunks = opts.chunks ?? []
          return new ReadableStream<LiteRtMessage>({
            start(controller) {
              for (const c of chunks) {
                controller.enqueue({ role: 'assistant', ...c } as LiteRtMessage)
              }
              controller.close()
            },
          })
        }),
        cancel: vi.fn(() => {
          handle.cancelled += 1
        }),
        delete: vi.fn(),
        getHistory: vi.fn(() => []),
      }
    }),
    delete: vi.fn(),
  }
  handle.engine = engine
  return handle
}

// ─── static surface ─────────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — static surface', () => {
  it('exposes its own stash key', () => {
    expect(LiteRtLmAdapter.STASH_KEY).toBe('liteRtLm')
  })
})

// ─── validation ───────────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — validation', () => {
  it('requires a model', () => {
    expect(() => new LiteRtLmAdapter({})).toThrow(E_INVALID_LITERT_LM_OPTIONS)
  })

  it('rejects unknown keys', () => {
    expect(() => new LiteRtLmAdapter({ model: 'm', bogusKey: 1 })).toThrow(
      E_INVALID_LITERT_LM_OPTIONS
    )
  })

  it('rejects an out-of-range sampler type', () => {
    expect(() => new LiteRtLmAdapter({ model: 'm', samplerParams: { type: 99 } })).toThrow(
      E_INVALID_LITERT_LM_OPTIONS
    )
  })
})

// ─── engine invocation ──────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — engine invocation', () => {
  it('non-streaming: stores assistant text + acks when autoAck', async () => {
    const h = makeEngine({ message: { content: 'hello from litert' } })
    const adapter = new LiteRtLmAdapter({
      model: 'model-a',
      stream: false,
      engine: h.engine as never,
      autoAck: true,
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())

    expect(h.configs).toHaveLength(1)
    const stored = ctx._stored.messages[0]
    expect(stored).toBeDefined()
    expect(stored?.content?.toString()).toBe('hello from litert')
    expect(ctx.ack).toHaveBeenCalledOnce()
  })

  it('non-streaming: content as MessageContentItem[] is flattened to text', async () => {
    const h = makeEngine({
      message: {
        content: [
          { type: 'text', text: 'part-one ' },
          { type: 'text', text: 'part-two' },
        ] as never,
      },
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('part-one part-two')
  })

  it('streaming: accumulates chunk content and stores final text', async () => {
    const h = makeEngine({ chunks: [{ content: 'hi ' }, { content: 'there' }] })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: true,
      engine: h.engine as never,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('hi there')
    expect(ctx.ack).toHaveBeenCalledOnce()
  })

  it('streaming: full-accumulated snapshot chunks do not double-count', async () => {
    // Defensive: if the runtime delivers cumulative snapshots rather than deltas,
    // the accumulator must dedupe via startsWith and still land on the final text.
    const h = makeEngine({
      chunks: [{ content: 'hel' }, { content: 'hello' }, { content: 'hello!' }],
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: true, engine: h.engine as never })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('hello!')
  })

  it('streaming: channels surface as thoughts', async () => {
    const h = makeEngine({
      chunks: [
        { channels: { thinking: 'let me ' } as never },
        { channels: { thinking: 'let me think' } as never, content: 'answer' },
      ],
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: true, engine: h.engine as never })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.thoughts[0]?.content?.toString()).toBe('let me think')
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('answer')
  })

  it('lazy createEngine is called once and the engine is cached across dispatches', async () => {
    const h = makeEngine({ message: { content: 'created' } })
    const createEngine = vi.fn(async () => h.engine as never)
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      createEngine,
      isWebGPUAvailable: () => true,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(createEngine).toHaveBeenCalledOnce()
    expect(h.configs).toHaveLength(2)
  })

  it('without WebGPU and no injected engine → nack with stream error', async () => {
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      isWebGPUAvailable: () => false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledOnce()
  })

  it('autoAck defaults to false → no ack on a tool-call-free response', async () => {
    const h = makeEngine({ message: { content: 'hello world' } })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages.length).toBeGreaterThan(0)
  })
})

// ─── tool calls (args are already an object — no JSON.parse) ──────────────────────────────────────────

describe('LiteRtLmAdapter — tool calls', () => {
  const echoTool = () =>
    new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
    })

  it('non-streaming tool_calls → executes the tool, stores result, no ack', async () => {
    const h = makeEngine({
      message: {
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'echo', arguments: { text: 'hi' } } },
        ] as never,
      },
    })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      autoAck: true,
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    const stored = ctx._stored.toolCalls[0]
    expect(stored.tool).toBe('echo')
    expect(await (stored.results as SpooledArtifact).asString()).toContain('echoed: hi')
    // tool calls present → autoAck must NOT fire (the model must run again).
    expect(ctx.ack).not.toHaveBeenCalled()
  })

  it('streaming tool_calls → executes the tool', async () => {
    const h = makeEngine({
      chunks: [
        {
          tool_calls: [
            { type: 'function', function: { name: 'echo', arguments: { text: 'streamed' } } },
          ] as never,
        },
      ],
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: true, engine: h.engine as never })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    expect(await (ctx._stored.toolCalls[0].results as SpooledArtifact).asString()).toContain(
      'echoed: streamed'
    )
  })

  it('unknown tool → stored as an error tool call', async () => {
    const h = makeEngine({
      message: {
        content: '',
        tool_calls: [{ type: 'function', function: { name: 'nope', arguments: {} } }] as never,
      },
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    const stored = ctx._stored.toolCalls[0]
    expect(stored.isError).toBe(true)
    expect((stored.results as Tokenizable).toString()).toContain('Tool not found: nope')
  })

  it('malformed tool args (array, not object) → stored as an invalid-args error', async () => {
    const h = makeEngine({
      message: {
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'echo', arguments: [1, 2, 3] } },
        ] as never,
      },
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    const stored = ctx._stored.toolCalls[0]
    expect(stored.isError).toBe(true)
    expect((stored.results as Tokenizable).toString()).toContain('must be a JSON object')
  })
})

// ─── option layering ──────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — option layering', () => {
  it('stash overrides win over the constructor baseline', async () => {
    const baseEngine = makeEngine({ message: { content: 'base' } })
    const stashEngine = makeEngine({ message: { content: 'stashed' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: baseEngine.engine as never,
      autoAck: true,
    })
    const ctx = makeCtx({
      stash: { liteRtLm: { engine: stashEngine.engine } },
    })
    await adapter.executor()(ctx, makeHelpers())
    // The stash engine produced the output, not the baseline.
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('stashed')
    expect(stashEngine.configs).toHaveLength(1)
    expect(baseEngine.configs).toHaveLength(0)
  })

  it('executor(overrides) win over the constructor baseline', async () => {
    const baseEngine = makeEngine({ message: { content: 'base' } })
    const overrideEngine = makeEngine({ message: { content: 'override' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: baseEngine.engine as never,
    })
    const ctx = makeCtx()
    await adapter.executor({ engine: overrideEngine.engine as never })(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('override')
  })
})

// ─── context window ─────────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — context window', () => {
  it('throws E_LITERT_LM_CONTEXT_OVERFLOW when the budget is exceeded', async () => {
    const h = makeEngine({ message: { content: 'unused' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      tokenEncoding: 'o200k_base',
      contextWindow: 1,
    })
    const ctx = makeCtx({
      systemPrompt: 'You are a very wordy assistant with a long system prompt.',
      turnMessages: [
        makeMessage({
          content: 'this is a reasonably long user message that blows the tiny budget',
        }),
      ],
    })
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toThrow(/context window/i)
  })
})

// ─── abort ──────────────────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — abort', () => {
  it('a pre-aborted signal cancels the conversation and stores nothing', async () => {
    const h = makeEngine({ chunks: [{ content: 'should not be seen' }] })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: true, engine: h.engine as never })
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx({ abortSignal: ac.signal })
    await adapter.executor()(ctx, makeHelpers())
    expect(h.cancelled).toBeGreaterThanOrEqual(1)
    expect(ctx._stored.messages).toHaveLength(0)
  })
})
