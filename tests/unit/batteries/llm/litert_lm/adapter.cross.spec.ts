import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
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
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import {
  LiteRtLmAdapter,
  E_INVALID_LITERT_LM_OPTIONS,
  E_LITERT_LM_CONTEXT_OVERFLOW,
  isEngineContextOverflowMessage,
  renderToolsAsPromptText,
} from '@nhtio/adk/batteries/llm/litert_lm'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type {
  LiteRtMessage,
  BatteryLifecycleReport,
  RawGenerationObservation,
  PromptAssembledObservation,
} from '@nhtio/adk/batteries/llm/litert_lm'

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
    storeMediaBytes: vi.fn(async (_id: string, bytes: Uint8Array) => inMemoryMediaReader(bytes)),
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

  it('rejects samplerParams.k>1 under EVERY sampler type (WebGPU path requires k<=1)', () => {
    // The LiteRT WebGPU sampling path IGNORES the sampler type (it always combines top-k+top-p) and
    // requires k<=1 — so k>1 throws `Top-K value N must be <=1` at generate time for GREEDY, TOP_K, AND
    // TOP_P alike. Caught at validation here, not deep inside the wasm runtime.
    for (const type of [1, 2, 3] as const) {
      expect(() => new LiteRtLmAdapter({ model: 'm', samplerParams: { type, k: 40 } })).toThrow(
        E_INVALID_LITERT_LM_OPTIONS
      )
    }
  })

  it('allows samplerParams.k of 0 or 1 (the only WebGPU-valid values)', () => {
    expect(
      () => new LiteRtLmAdapter({ model: 'm', samplerParams: { type: 1, k: 1 } })
    ).not.toThrow()
    expect(
      () => new LiteRtLmAdapter({ model: 'm', samplerParams: { type: 2, k: 0 } })
    ).not.toThrow()
  })

  it('rejects a canonical topK>1 (WebGPU path requires topK<=1)', () => {
    expect(() => new LiteRtLmAdapter({ model: 'm', sampler: 'top-p', topK: 40 })).toThrow(
      E_INVALID_LITERT_LM_OPTIONS
    )
  })

  it('ACCEPTS a helpers.renderArtifactHandleBody override (the wired override seam)', () => {
    // Regression: the options validator's `helpers` schema is `.unknown(false)`, so the new override
    // key must be explicitly allowed — otherwise a consumer passing it gets
    // E_INVALID_LITERT_LM_OPTIONS at construction (the exact failure observed live before this fix).
    expect(
      () =>
        new LiteRtLmAdapter({
          model: 'm',
          helpers: { renderArtifactHandleBody: () => 'custom handle note' },
        })
    ).not.toThrow()
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

  it('passes EXPLICIT generation defaults to the runtime (never lets it guess)', async () => {
    const h = makeEngine({ message: { content: 'ok' } })
    // No generation options supplied → the validation defaults must be materialised and forwarded.
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())

    const cfg = h.configs[0] as {
      preface?: { extra_context?: { enable_thinking?: boolean } }
      sessionConfig?: {
        samplerParams?: { type?: number; k?: number; p?: number; temperature?: number }
        maxOutputTokens?: number
      }
    }
    // Thinking is explicitly OFF (not left to the template).
    expect(cfg.preface?.extra_context?.enable_thinking).toBe(false)
    // Sampler is explicitly GREEDY (3). GREEDY is argmax/top-1, so k is pinned to 1 (the LiteRT runtime
    // requires k<=1 for GREEDY); p/temperature are still pinned so switching to TOP_K/TOP_P is complete.
    expect(cfg.sessionConfig?.samplerParams?.type).toBe(3)
    expect(cfg.sessionConfig?.samplerParams?.k).toBe(1)
    expect(cfg.sessionConfig?.samplerParams?.p).toBeCloseTo(0.95)
    expect(cfg.sessionConfig?.samplerParams?.temperature).toBeCloseTo(0.7)
    expect(cfg.sessionConfig?.maxOutputTokens).toBe(1024)
  })

  it('maps the PORTABLE canonical contract → native samplerParams/maxOutputTokens', async () => {
    const h = makeEngine({ message: { content: 'ok' } })
    // Canonical (battery-agnostic) config — the same shape transformers.js accepts.
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      maxTokens: 256,
      sampler: 'top-k',
      topK: 1, // WebGPU path requires k<=1 for all types
      topP: 0.8,
      temperature: 0.3,
    })
    await adapter.executor()(
      makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] }),
      makeHelpers()
    )
    const cfg = h.configs[0] as {
      sessionConfig?: {
        samplerParams?: { type?: number; k?: number; p?: number; temperature?: number }
        maxOutputTokens?: number
      }
    }
    // sampler:'top-k' → SamplerType.TOP_K (1); canonical knobs flow into samplerParams; maxTokens→maxOutputTokens.
    expect(cfg.sessionConfig?.samplerParams?.type).toBe(1)
    expect(cfg.sessionConfig?.samplerParams?.k).toBe(1)
    expect(cfg.sessionConfig?.samplerParams?.p).toBeCloseTo(0.8)
    expect(cfg.sessionConfig?.samplerParams?.temperature).toBeCloseTo(0.3)
    expect(cfg.sessionConfig?.maxOutputTokens).toBe(256)
  })

  it('canonical `maxTokens` wins over native `maxOutputTokens` when both are set', async () => {
    const h = makeEngine({ message: { content: 'ok' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      maxTokens: 128,
      maxOutputTokens: 999,
    })
    await adapter.executor()(
      makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] }),
      makeHelpers()
    )
    const cfg = h.configs[0] as { sessionConfig?: { maxOutputTokens?: number } }
    expect(cfg.sessionConfig?.maxOutputTokens).toBe(128)
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

  it('reasoning in content text surfaces as thoughts (LiteRT is text-only)', async () => {
    // The v0.13.1 JS runtime emits text only — reasoning arrives as <think> markup inside content,
    // parsed out by the shared reasoning parser. (channels/tool_calls are never populated on output.)
    const h = makeEngine({ message: { content: '<think>let me think</think>answer' } })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
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

  // LiteRT v0.13.1 is text-only: tool calls arrive as family-specific text in `content`, parsed by
  // the shared tool-call parser layer (default 'auto'). These use the Hermes <tool_call> format.

  it('non-streaming tool call (text in content) → executes the tool, stores result, no ack', async () => {
    const h = makeEngine({
      message: { content: '<tool_call>{"name":"echo","arguments":{"text":"hi"}}</tool_call>' },
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

  it('streaming tool call (text in content) → executes the tool', async () => {
    const h = makeEngine({
      chunks: [
        { content: '<tool_call>{"name":"echo","arguments":{"text":"streamed"}}</tool_call>' },
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
    // Use a custom parser to surface a call to a tool that isn't registered — exercises the adapter's
    // not-found handling directly. (The bundled parsers also surface unknown callees now; authorization
    // is the dispatch layer's job, which is exactly the not-found path asserted here.)
    const h = makeEngine({ message: { content: 'CALL nope' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      toolCallParser: () => ({ calls: [{ name: 'nope', arguments: {} }], cleanedText: '' }),
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    const stored = ctx._stored.toolCalls[0]
    expect(stored.isError).toBe(true)
    expect((stored.results as Tokenizable).toString()).toContain('Tool not found: nope')
  })

  it('tool-call markup does not leak into the persisted assistant message', async () => {
    const h = makeEngine({
      message: { content: 'Sure!<tool_call>{"name":"echo","arguments":{"text":"hi"}}</tool_call>' },
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: false, engine: h.engine as never })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]?.content?.toString() ?? ''
    expect(msg).not.toContain('<tool_call>')
    expect(msg).toBe('Sure!')
  })
})

// ─── raw-generation observability ───────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — onRawGeneration observable', () => {
  const echoTool = () =>
    new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
    })

  it('fires once per generation with rawText + the parsed reasoning/toolCalls split', async () => {
    const seen: RawGenerationObservation[] = []
    const h = makeEngine({
      message: { content: 'Sure!<tool_call>{"name":"echo","arguments":{"text":"hi"}}</tool_call>' },
    })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      onRawGeneration: (o: RawGenerationObservation) => seen.push(o),
    })
    await adapter.executor()(makeCtx({ tools: new ToolRegistry([echoTool()]) }), makeHelpers())

    expect(seen).toHaveLength(1)
    const o = seen[0]
    // rawText is the model's COMPLETE output; cleanedText is just the residual prose.
    expect(o.rawText).toContain('<tool_call>')
    expect(o.rawText).toContain('Sure!')
    expect(o.cleanedText).toBe('Sure!')
    expect(o.toolCalls).toEqual([{ name: 'echo', arguments: { text: 'hi' } }])
    expect(o.streamed).toBe(false)
    expect(typeof o.streamId).toBe('string')
  })

  it('surfaces the LEAK: a tool call in a shape no parser matches stays in BOTH rawText and cleanedText', async () => {
    // This is the whole point of the tap. The model emitted a call, but in a form the parser declines,
    // so it silently leaks into the assistant prose. The observable is the only seam that makes the gap
    // — rawText has the call, toolCalls is empty, cleanedText still carries it — visible to a consumer.
    const seen: RawGenerationObservation[] = []
    const h = makeEngine({ message: { content: 'do_thing\narg: 42' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      // No `do_thing` tool registered → loose_keyed's gate declines → the call cannot parse.
      onRawGeneration: (o: RawGenerationObservation) => seen.push(o),
    })
    await adapter.executor()(makeCtx({ tools: new ToolRegistry([echoTool()]) }), makeHelpers())

    expect(seen).toHaveLength(1)
    expect(seen[0].toolCalls).toEqual([])
    expect(seen[0].rawText).toContain('do_thing')
    expect(seen[0].cleanedText).toContain('do_thing') // the leak, observable
  })

  it('never lets an observer error corrupt the generation (errors are swallowed)', async () => {
    const h = makeEngine({ message: { content: 'hello' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      onRawGeneration: () => {
        throw new Error('observer blew up')
      },
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await expect(adapter.executor()(ctx, makeHelpers())).resolves.toBeUndefined()
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('hello')
  })
})

// ─── prompt-assembled observability (the TO tap) ─────────────────────────────────────────────────────

describe('LiteRtLmAdapter — onPromptAssembled (the exact prompt sent TO the model)', () => {
  it('fires once with the rendered preface + per-turn messages, BEFORE the engine dispatch', async () => {
    const seen: PromptAssembledObservation[] = []
    const h = makeEngine({ message: { content: 'hello' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      onPromptAssembled: (o: PromptAssembledObservation) => seen.push(o),
    })
    await adapter.executor()(
      makeCtx({ turnMessages: [makeMessage({ content: 'ping' })] }),
      makeHelpers()
    )
    expect(seen).toHaveLength(1)
    const o = seen[0]
    expect(o.battery).toBe('litert_lm')
    expect(o.kind).toBe('rendered-prompt')
    expect(o.streamed).toBe(false)
    expect(typeof o.streamId).toBe('string')
    // The messages handed to the engine — the ground truth the wiretap persists.
    expect(Array.isArray(o.messages)).toBe(true)
    // The same id correlates the TO tap with the engine's captured send.
    expect(h.inputs).toHaveLength(1)
  })

  it('shares one streamId between the TO tap and the FROM tap', async () => {
    const to: PromptAssembledObservation[] = []
    const from: RawGenerationObservation[] = []
    const h = makeEngine({ message: { content: 'hi' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      onPromptAssembled: (o: PromptAssembledObservation) => to.push(o),
      onRawGeneration: (o: RawGenerationObservation) => from.push(o),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(to).toHaveLength(1)
    expect(from).toHaveLength(1)
    expect(to[0].streamId).toBe(from[0].streamId)
  })

  it('never lets an observer error corrupt the generation (errors are swallowed)', async () => {
    const h = makeEngine({ message: { content: 'hello' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      onPromptAssembled: () => {
        throw new Error('observer blew up')
      },
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await expect(adapter.executor()(ctx, makeHelpers())).resolves.toBeUndefined()
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('hello')
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
  it('accounts for a spooled retrievable handle using the resolved renderer', async () => {
    const h = makeEngine({ message: { content: 'ok' } })
    const id = 'budget-litert'
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
    const renderer = (() => 'HANDLE') as never
    const spy = vi.spyOn(artifact, 'estimateHandleTokens')
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      tokenEncoding: 'gemma',
      contextWindow: 1000,
    })
    await expect(
      adapter.executor()(
        makeCtx({
          turnRetrievables: [retrievable],
          stash: { liteRtLm: { helpers: { renderRetrievableHandleBody: renderer } } },
        }),
        makeHelpers()
      )
    ).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith(id, 'gemma', renderer)
    expect(h.configs).toHaveLength(1)
  })
  it('falls back to full-content estimation for a non-inline spooled retrievable with no cached size hints, instead of throwing', async () => {
    const h = makeEngine({ message: { content: 'ok' } })
    const id = 'budget-litert-unhinted'
    const artifact = new SpooledArtifact(new InMemorySpoolStore().write(id, 'unhinted body'))
    const retrievable = new Retrievable({
      id,
      content: artifact,
      trustTier: 'first-party',
      inline: false,
      createdAt: dt('2026-01-01T10:00:00Z'),
      updatedAt: dt('2026-01-01T10:00:00Z'),
    })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      tokenEncoding: 'gemma',
      contextWindow: 1000,
    })
    await expect(
      adapter.executor()(makeCtx({ turnRetrievables: [retrievable] }), makeHelpers())
    ).resolves.toBeUndefined()
    expect(h.configs).toHaveLength(1)
  })
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

  // REGRESSION (the live crash): the overflow guard MUST count the rendered tool-declaration block, not
  // just the system+timeline. With `toolDelivery:'prompt'` (the on-device Gemma path) each visible tool
  // is rendered as its FULL JSON-Schema block — hundreds of tokens the old tally ignored, so a
  // tool-heavy prompt sailed under the guard and blew the engine's hard cap. This test pins the fix with
  // REAL tools → the battery's REAL renderToolsAsPromptText → a REAL Tokenizable count (no fakes): the
  // engine is never reached (the guard throws at step 4), so no GPU/model is needed.
  const richTool = (name: string) =>
    new Tool({
      name,
      description:
        `A tool named ${name} with a deliberately verbose, multi-field input schema so its ` +
        `rendered JSON-Schema declaration weighs many tokens.`,
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

  it('counts the rendered tool-declaration block (a tool-heavy prompt that fits WITHOUT tools overflows WITH them)', async () => {
    const h = makeEngine({ message: { content: 'unused' } })
    const tools = new ToolRegistry([
      richTool('search_docs_semantic'),
      richTool('search_docs_keyword'),
      richTool('provide_answer'),
      richTool('get_current_time'),
      richTool('calculate'),
    ])
    // A short system prompt + short user message: the system+timeline tally alone is tiny. The ONLY way
    // this overflows a modest window is if the rendered tool-schema block is counted too.
    const ctx = makeCtx({
      systemPrompt: 'You are a helpful assistant.',
      turnMessages: [makeMessage({ content: 'hi' })],
      tools,
    })

    // Establish the ground truth with the REAL Tokenizable + REAL renderer, so the budget is chosen
    // relative to actual measured weights, not a magic number.
    const enc = 'gemma' as const
    const sysAndMsg =
      Tokenizable.estimateTokens('You are a helpful assistant.', enc) +
      Tokenizable.estimateTokens('hi', enc)
    const toolBlock = Tokenizable.estimateTokens(renderToolsAsPromptText(tools.visible()), enc)
    // Sanity: the tool block is the dominant term (this is the whole point).
    expect(toolBlock).toBeGreaterThan(sysAndMsg)

    // A window ABOVE system+message but BELOW system+message+tools: overflows ONLY because tools count.
    const contextWindow = sysAndMsg + Math.floor(toolBlock / 2)
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      tokenEncoding: enc,
      contextWindow,
    })
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toThrow(
      E_LITERT_LM_CONTEXT_OVERFLOW
    )
    // The engine was never reached — the guard fired pre-dispatch.
    expect(h.configs).toHaveLength(0)
  })

  it('does NOT overflow the same tool-heavy prompt when the window comfortably covers the tools', async () => {
    const h = makeEngine({ message: { content: 'ok' } })
    const tools = new ToolRegistry([richTool('search_docs_semantic'), richTool('provide_answer')])
    const ctx = makeCtx({
      systemPrompt: 'You are a helpful assistant.',
      turnMessages: [makeMessage({ content: 'hi' })],
      tools,
    })
    const enc = 'gemma' as const
    const everything =
      Tokenizable.estimateTokens('You are a helpful assistant.', enc) +
      Tokenizable.estimateTokens('hi', enc) +
      Tokenizable.estimateTokens(renderToolsAsPromptText(tools.visible()), enc)
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      engine: h.engine as never,
      autoAck: true,
      tokenEncoding: enc,
      contextWindow: everything + 128, // headroom above the true weight
    })
    await expect(adapter.executor()(ctx, makeHelpers())).resolves.toBeUndefined()
    expect(h.configs).toHaveLength(1) // engine WAS reached — no false overflow
  })
})

describe('LiteRtLmAdapter — engine context-cap backstop (error translation)', () => {
  // When the pre-dispatch guard is unarmed (or undercounts), the ENGINE itself throws
  // `Input token ids are too long. Exceeding the maximum number of tokens allowed: N >= M`. The adapter
  // must translate that raw throw into the TYPED E_LITERT_LM_CONTEXT_OVERFLOW (via ctx.nack), so a host
  // can catch/shed/retry instead of string-matching — and so it flows through observability as a
  // classified error, not a generic stream error. Uses the fake engine's throwOnStream to inject the
  // EXACT runtime message (no GPU needed to prove the translation).
  it('translates the raw engine over-cap throw into a typed E_LITERT_LM_CONTEXT_OVERFLOW nack', async () => {
    const h = makeEngine({
      throwOnStream: new Error(
        'Input token ids are too long. Exceeding the maximum number of tokens allowed: 12596 >= 12288'
      ),
    })
    const adapter = new LiteRtLmAdapter({ model: 'm', stream: true, engine: h.engine as never })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledOnce()
    const nacked = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    expect(nacked).toBeInstanceOf(E_LITERT_LM_CONTEXT_OVERFLOW)
    // The parsed actual/limit from the engine message are carried on the typed error.
    expect(String((nacked as Error).message)).toMatch(/12596/)
    expect(String((nacked as Error).message)).toMatch(/12288/)
  })

  it('isEngineContextOverflowMessage matches the runtime signature and ignores unrelated errors', () => {
    expect(
      isEngineContextOverflowMessage(
        'Input token ids are too long. Exceeding the maximum number of tokens allowed: 12596 >= 12288'
      )
    ).toBe(true)
    expect(isEngineContextOverflowMessage('RequestDeviceFailed: adapter lost')).toBe(false)
    expect(isEngineContextOverflowMessage('some unrelated stream hiccup')).toBe(false)
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

// ─── lifecycle hooks ────────────────────────────────────────────────────────────────────────────────

describe('LiteRtLmAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete via createEngine (firehose + per-phase)', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    const h = makeEngine({ message: { content: 'pong' } })
    const adapter = new LiteRtLmAdapter({
      model: 'https://example/model.litertlm',
      stream: false,
      autoAck: true,
      isWebGPUAvailable: () => true,
      createEngine: async () => h.engine as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    // `compiling` lands between `loading` (download start) and `ready` (engine resolved) — the
    // otherwise-invisible WebGPU shader/graph build, the boundary the LiteRT chat demo marks.
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('reports battery=litert_lm + the model URL on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const h = makeEngine({ message: { content: 'ok' } })
    const adapter = new LiteRtLmAdapter({
      model: 'https://example/m.litertlm',
      stream: false,
      autoAck: true,
      isWebGPUAvailable: () => true,
      createEngine: async () => h.engine as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    for (const r of reports) {
      expect(r.battery).toBe('litert_lm')
      expect(r.model).toBe('https://example/m.litertlm')
    }
  })

  it('a pre-built engine skips loading/ready but still fires generating/complete', async () => {
    const seen: string[] = []
    const h = makeEngine({ message: { content: 'ok' } })
    const adapter = new LiteRtLmAdapter({
      model: 'https://example/m.litertlm',
      stream: false,
      autoAck: true,
      engine: h.engine as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(seen).toEqual(['generating', 'complete'])
  })

  it('emits error (not complete) when engine creation fails', async () => {
    const phases: string[] = []
    const adapter = new LiteRtLmAdapter({
      model: 'https://example/m.litertlm',
      stream: false,
      isWebGPUAvailable: () => true,
      createEngine: async () => {
        throw new Error('engine boom')
      },
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(phases).toContain('loading')
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
    expect(ctx.nack).toHaveBeenCalled()
  })

  it('a throwing consumer hook does not break the dispatch', async () => {
    const h = makeEngine({ message: { content: 'still works' } })
    const adapter = new LiteRtLmAdapter({
      model: 'https://example/m.litertlm',
      stream: false,
      autoAck: true,
      engine: h.engine as never,
      onLifecycle: () => {
        throw new Error('hook blew up')
      },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toContain('still works')
    expect(ctx.ack).toHaveBeenCalledOnce()
  })
})

describe('LiteRtLmAdapter — media output (extractMediaOutputs seam)', () => {
  const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7, 6])

  it('attaches generated media to the assistant message + persists via storeMediaBytes', async () => {
    const h = makeEngine({ message: { content: 'here is your audio' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      engine: h.engine as never,
      extractMediaOutputs: () => [{ kind: 'audio', mimeType: 'audio/wav', bytes: wavBytes }],
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]
    expect(msg?.content?.toString()).toBe('here is your audio')
    expect(msg?.attachments.length).toBe(1)
    expect(msg?.attachments[0]?.kind).toBe('audio')
    expect(msg?.attachments[0]?.trustTier).toBe('first-party')
    expect(await msg!.attachments[0]!.asBytes()).toEqual(wavBytes)
  })

  it('DEFAULT (no hook) stores text-only with NO attachments — no regression', async () => {
    const h = makeEngine({ message: { content: 'plain answer' } })
    const adapter = new LiteRtLmAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      engine: h.engine as never,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]
    expect(msg?.content?.toString()).toBe('plain answer')
    expect(msg?.attachments.length).toBe(0)
  })
})
