import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  singleOllamaResponseCassette,
  singleOllamaStreamCassette,
  cassetteFetch,
} from '../../../../_fixtures/cassette'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  SpooledArtifact,
  Tool,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import {
  OllamaAdapter,
  E_INVALID_OLLAMA_OPTIONS,
  E_OLLAMA_CONTEXT_OVERFLOW,
  E_OLLAMA_HTTP_ERROR,
  ollamaToolsFromTools,
  descriptionToChatCompletionsJsonSchema,
} from '@nhtio/adk/batteries/llm/ollama'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// ─── primitive factories ───────────────────────────────────────────────────────

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

const makeToolCall = (overrides: {
  id?: string
  tool?: string
  args?: Record<string, unknown>
  results?: Tokenizable
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:01:00Z')
  return new ToolCall({
    id: overrides.id ?? `tc-${Math.random().toString(36).slice(2, 10)}`,
    tool: overrides.tool ?? 'my_tool',
    args: overrides.args ?? { x: 1 },
    checksum: 'sum-1',
    isComplete: true,
    isError: false,
    results: overrides.results ?? new Tokenizable('tool said hi'),
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  })
}

// ─── mock DispatchContext ───────────────────────────────────────────────────────

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
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
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
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
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as MockCtx
  return ctx
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

const getRequestHeaders = (call: unknown): Record<string, string> => {
  const init = (call as [string | URL, RequestInit])[1]
  return init.headers as Record<string, string>
}

const getRequestUrl = (call: unknown): string => {
  const url = (call as [string | URL, RequestInit])[0]
  return typeof url === 'string' ? url : url.toString()
}

// ─── tests ──────────────────────────────────────────────────────────────────────

describe('OllamaAdapter — static surface', () => {
  it('exposes STASH_KEY === "ollama"', () => {
    expect(OllamaAdapter.STASH_KEY).toBe('ollama')
  })

  it('isOllamaAdapter recognises instances', () => {
    const a = new OllamaAdapter({ model: 'llama3.2' })
    expect(OllamaAdapter.isOllamaAdapter(a)).toBe(true)
    expect(OllamaAdapter.isOllamaAdapter({})).toBe(false)
  })

  it('throws E_INVALID_OLLAMA_OPTIONS at construction on bad options', () => {
    expect(() => new OllamaAdapter({} as never)).toThrow(E_INVALID_OLLAMA_OPTIONS)
    expect(() => new OllamaAdapter({ model: 'm', think: 'sometimes' as never })).toThrow(
      E_INVALID_OLLAMA_OPTIONS
    )
  })
})

describe('OllamaAdapter — request URL + auth (local vs cloud)', () => {
  it('local: defaults baseURL to http://localhost:11434 and synthesises no Authorization', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    expect(getRequestUrl(fetchFn.mock.calls[0])).toBe('http://localhost:11434/api/chat')
    expect(getRequestHeaders(fetchFn.mock.calls[0])).not.toHaveProperty('Authorization')
  })

  it('cloud: baseURL https://ollama.com + apiKey → Authorization: Bearer', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'gpt-oss:120b',
      baseURL: 'https://ollama.com',
      apiKey: 'sk-test',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    expect(getRequestUrl(fetchFn.mock.calls[0])).toBe('https://ollama.com/api/chat')
    expect(getRequestHeaders(fetchFn.mock.calls[0]).Authorization).toBe('Bearer sk-test')
  })

  it('strips a trailing slash on baseURL', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      baseURL: 'http://localhost:11434/',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    expect(getRequestUrl(fetchFn.mock.calls[0])).toBe('http://localhost:11434/api/chat')
  })
})

describe('OllamaAdapter — native request body shape', () => {
  it('nests generation params under `options` (not top level) and forwards think/format/keep_alive', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      think: 'high',
      format: 'json',
      keep_alive: '10m',
      options: { temperature: 0.4, num_ctx: 8192 },
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body.options).toEqual({ temperature: 0.4, num_ctx: 8192 })
    // Generation params must NOT leak to the top level.
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('num_ctx')
    expect(body.think).toBe('high')
    expect(body.format).toBe('json')
    expect(body.keep_alive).toBe('10m')
    expect(body.model).toBe('llama3.2')
    expect(body.stream).toBe(false)
  })

  it('does not leak ADK control keys into the body', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      autoAck: true,
      contextWindow: 4096,
      selfIdentity: 'bot',
      unsupportedMediaPolicy: 'synthetic-description',
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    for (const k of [
      'autoAck',
      'contextWindow',
      'selfIdentity',
      'unsupportedMediaPolicy',
      'apiKey',
      'baseURL',
      'fetch',
      'retry',
      'helpers',
      'tokenEncoding',
    ]) {
      expect(body).not.toHaveProperty(k)
    }
  })

  it('streaming sets Accept: application/x-ndjson', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaStreamCassette('c', { contentDeltas: ['hi'] })))
    await new OllamaAdapter({ model: 'llama3.2', fetch: fetchFn as never }).executor()(
      makeCtx(),
      makeHelpers()
    )
    expect(getRequestHeaders(fetchFn.mock.calls[0]).Accept).toBe('application/x-ndjson')
  })

  it('three-layer merge: stash > executor > ctor for model and nested options', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    const adapter = new OllamaAdapter({
      model: 'a',
      stream: false,
      options: { temperature: 0.1, top_p: 0.5 },
      fetch: fetchFn as never,
    })
    const ex = adapter.executor({ model: 'b', options: { temperature: 0.2 } })
    const ctx = makeCtx({ stash: { ollama: { model: 'c', options: { top_k: 40 } } } })
    await ex(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    expect(body.model).toBe('c')
    // options merge key-by-key across layers: top_p from ctor, temperature from exec, top_k from stash.
    expect(body.options).toEqual({ temperature: 0.2, top_p: 0.5, top_k: 40 })
  })
})

describe('OllamaAdapter — non-streaming responses', () => {
  it('persists a Message and emits generation stats from the response object', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaResponseCassette('c', {
          content: 'The sky is blue.',
          stats: { prompt_eval_count: 26, eval_count: 8, total_duration: 5_000_000_000 },
        })
      )
    )
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, helpers)
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content!.toString()).toBe('The sky is blue.')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    // generation stats
    expect(helpers._stats).toHaveLength(1)
    expect(helpers._stats[0]!).toMatchObject({
      provider: 'ollama',
      promptTokens: 26,
      completionTokens: 8,
      totalTokens: 34,
      totalDurationNs: 5_000_000_000,
      finishReason: 'stop',
    })
  })

  it('autoAck defaults to false → no ack on a tool-call-free answer', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    const ctx = makeCtx()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(ctx.ack).not.toHaveBeenCalled()
  })
})

describe('OllamaAdapter — NDJSON streaming', () => {
  it('accumulates content deltas across NDJSON chunks → one persisted Message; terminates on done:true', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaStreamCassette('c', {
          contentDeltas: ['The ', 'sky ', 'is blue.'],
          stats: { eval_count: 5 },
        })
      )
    )
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, helpers)
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content!.toString()).toBe('The sky is blue.')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._stats[0]!).toMatchObject({ provider: 'ollama', completionTokens: 5 })
  })

  it('handles an object split across two read() chunks (raw partial frames)', async () => {
    // Manually craft a cassette whose NDJSON object is split mid-JSON across two raw frames.
    const obj = JSON.stringify({
      model: 'llama3.2',
      message: { role: 'assistant', content: 'split works' },
      done: true,
      done_reason: 'stop',
    })
    const mid = Math.floor(obj.length / 2)
    const fetchFn = vi.fn(
      cassetteFetch({
        name: 'split',
        interactions: [
          {
            request: { method: 'POST' },
            response: {
              ndjson: [{ raw: obj.slice(0, mid) }, { raw: obj.slice(mid) + '\n' }],
            },
          },
        ],
      })
    )
    const ctx = makeCtx()
    await new OllamaAdapter({
      model: 'llama3.2',
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content!.toString()).toBe('split works')
  })
})

describe('OllamaAdapter — tool calls (native object args + tool_name history)', () => {
  it('non-streaming: object-form arguments are used directly (no JSON.parse), tool executes, no ack', async () => {
    const tool = new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
    })
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaResponseCassette('c', {
          toolCalls: [{ name: 'echo', arguments: { text: 'hi' } }],
        })
      )
    )
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(ctx, helpers)
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    const stored = ctx._stored.toolCalls[0]
    expect(stored.tool).toBe('echo')
    // D1: this is the adapter's real constructor/executor resolution path; absent filter preserves
    // the id assigned at ingress (native Ollama has no wire id, so it is the generated UUID).
    const reportedId = (helpers.reportToolCall as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(stored.id).toBe(reportedId)
    expect(stored.args).toEqual({ text: 'hi' })
    expect(stored.isError).toBe(false)
    expect(ctx.ack).not.toHaveBeenCalled()
  })

  it('resolves toolCallIdFilter through stash overrides and uses it for persistence/reporting', async () => {
    const tool = new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: () => 'ok',
    })
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaResponseCassette('c', {
          toolCalls: [{ name: 'echo', arguments: { text: 'hi' } }],
        })
      )
    )
    const ctx = makeCtx({
      tools: new ToolRegistry([tool]),
      stash: { ollama: { toolCallIdFilter: () => 'filtered-id' } },
    })
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      toolCallIdFilter: () => 'constructor-id',
      fetch: fetchFn as never,
    }).executor({ toolCallIdFilter: () => 'executor-id' })(ctx, helpers)
    expect(ctx._stored.toolCalls[0]!.id).toBe('filtered-id')
    expect((helpers.reportToolCall as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'filtered-id'
    )
  })

  it('streaming: whole tool_calls arrive in one chunk and execute', async () => {
    const tool = new Tool({
      name: 'echo',
      description: 'echo tool',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
    })
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaStreamCassette('c', {
          toolCalls: [{ name: 'echo', arguments: { text: 'streamed' } }],
        })
      )
    )
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    await new OllamaAdapter({ model: 'llama3.2', fetch: fetchFn as never }).executor()(
      ctx,
      makeHelpers()
    )
    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ text: 'streamed' })
  })

  it('pairs duplicate-id history calls with their own rendered results', async () => {
    const tool = new Tool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: validator.object({ q: validator.string().required() }),
      handler: () => 'ok',
    })
    const first = makeToolCall({
      id: 'same-id',
      tool: 'lookup',
      args: { q: 'Paris' },
      results: new Tokenizable('Paris result'),
    })
    const second = makeToolCall({
      id: 'same-id',
      tool: 'lookup',
      args: { q: 'Tokyo' },
      results: new Tokenizable('Tokyo result'),
      createdAt: dt('2026-01-01T12:02:00Z'),
    })
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'done' })))
    let renderCount = 0
    const renderResult = vi.fn(async ({ toolCall }: { toolCall: ToolCall }) => {
      renderCount += 1
      return renderCount <= 2
        ? `pre-${String(toolCall.args.q)}`
        : `fallback-${String(toolCall.args.q)}`
    })
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
      helpers: { renderOllamaToolCallResult: renderResult } as never,
    }).executor()(
      makeCtx({ tools: new ToolRegistry([tool]), turnToolCalls: [first, second] }),
      makeHelpers()
    )
    const messages = getRequestBody(fetchFn.mock.calls[0]).messages as Array<
      Record<string, unknown>
    >
    const toolMessages = messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(toolMessages).toHaveLength(2)
    // The override deliberately emits pre-<city>, so assert the renderer output rather than the
    // Tokenizable result text it replaces. Both directions are checked to reject collapsed pairing.
    expect(toolMessages[0]).toContain('pre-Paris')
    expect(toolMessages[0]).not.toContain('pre-Tokyo')
    expect(toolMessages[1]).toContain('pre-Tokyo')
    expect(toolMessages[1]).not.toContain('pre-Paris')
  })

  it('prior tool-call history renders a tool-role message keyed by tool_name (not tool_call_id)', async () => {
    const tool = new Tool({
      name: 'lookup',
      description: 'lookup',
      inputSchema: validator.object({ q: validator.string().required() }),
      handler: () => 'ok',
    })
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'done' })))
    const priorCall = makeToolCall({
      tool: 'lookup',
      args: { q: 'x' },
      results: new Tokenizable('result body'),
    })
    const ctx = makeCtx({ tools: new ToolRegistry([tool]), turnToolCalls: [priorCall] })
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    const body = getRequestBody(fetchFn.mock.calls[0])
    const messages = body.messages as Array<Record<string, unknown>>
    const toolMsg = messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_name).toBe('lookup')
    expect(toolMsg).not.toHaveProperty('tool_call_id')
    // The synthetic assistant tool_calls carry object-form arguments.
    const asst = messages.find((m) => Array.isArray(m.tool_calls))
    expect(asst).toBeDefined()
    const tc = (asst!.tool_calls as Array<{ function: { name: string; arguments: unknown } }>)[0]
    expect(tc.function.name).toBe('lookup')
    expect(tc.function.arguments).toEqual({ q: 'x' })
  })

  it('non-object arguments → persisted error ToolCall (E_OLLAMA_INVALID_TOOL_CALL_ARGS), model self-corrects', async () => {
    const tool = new Tool({
      name: 'echo',
      description: 'echo',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: () => 'never',
    })
    // Craft a malformed response where arguments is an array (non-object).
    const fetchFn = vi.fn(
      cassetteFetch({
        name: 'bad-args',
        interactions: [
          {
            request: { method: 'POST' },
            response: {
              body: {
                model: 'llama3.2',
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ function: { name: 'echo', arguments: ['not', 'an', 'object'] } }],
                },
                done: true,
                done_reason: 'stop',
              },
            },
          },
        ],
      })
    )
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls).toHaveLength(1)
    const stored = ctx._stored.toolCalls[0]
    expect(stored.isError).toBe(true)
    // The persisted error body is the exception's formatted message (the model-visible
    // self-correction signal): a "must be a JSON object" headline + the echoed raw value.
    expect(stored.results.toString()).toContain('must be a JSON object')
    expect(stored.results.toString()).toContain('received array')
    expect(stored.results.toString()).toContain('["not","an","object"]')
  })
})

describe('OllamaAdapter — context window enforcement', () => {
  it('accounts for a spooled retrievable handle using the resolved renderer', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(singleOllamaResponseCassette('budget-handle', { content: 'ok' }))
    )
    const id = 'budget-ollama'
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
    const adapter = new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 1000,
      fetch: fetchFn as never,
    })
    await expect(
      adapter.executor()(
        makeCtx({
          turnRetrievables: [retrievable],
          stash: { ollama: { helpers: { renderRetrievableHandleBody: renderer } } },
        }),
        makeHelpers()
      )
    ).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledWith(id, 'cl100k_base', renderer)
    expect(fetchFn).toHaveBeenCalledOnce()
  })
  it('falls back to full-content estimation for a non-inline spooled retrievable with no cached size hints, instead of throwing', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(singleOllamaResponseCassette('budget-handle-unhinted', { content: 'ok' }))
    )
    const id = 'budget-ollama-unhinted'
    const artifact = new SpooledArtifact(new InMemorySpoolStore().write(id, 'unhinted body'))
    const retrievable = new Retrievable({
      id,
      content: artifact,
      trustTier: 'first-party',
      inline: false,
      createdAt: dt('2026-01-01T10:00:00Z'),
      updatedAt: dt('2026-01-01T10:00:00Z'),
    })
    const adapter = new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      tokenEncoding: 'cl100k_base',
      contextWindow: 1000,
      fetch: fetchFn as never,
    })
    await expect(
      adapter.executor()(makeCtx({ turnRetrievables: [retrievable] }), makeHelpers())
    ).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledOnce()
  })
  it('throws E_OLLAMA_CONTEXT_OVERFLOW when token weight exceeds contextWindow', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    const bigMsg = makeMessage({ content: 'word '.repeat(5000) })
    const ctx = makeCtx({ turnMessages: [bigMsg] })
    await expect(
      new OllamaAdapter({
        model: 'llama3.2',
        stream: false,
        tokenEncoding: 'cl100k_base',
        contextWindow: 10,
        fetch: fetchFn as never,
      }).executor()(ctx, makeHelpers())
    ).rejects.toThrow(E_OLLAMA_CONTEXT_OVERFLOW)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // REGRESSION (same class as the LiteRT crash): the overflow tally MUST include the tool DECLARATIONS.
  // Ollama renders `tools` through the MODEL'S OWN Go chat template server-side (per-model, not
  // reproducible client-side), so the guard tallies the serialized wire `tools` JSON as an honest FLOOR.
  // REAL tools → the battery's REAL ollamaToolsFromTools → a REAL Tokenizable count (no fakes): fetch is
  // never reached (guard fires pre-dispatch).
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

  it('counts the serialized tool declarations (a tool-heavy prompt that fits WITHOUT tools overflows WITH them)', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'unused' })))
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
        ollamaToolsFromTools(tools.visible(), { descriptionToChatCompletionsJsonSchema })
      ),
      enc
    )
    expect(toolBlock).toBeGreaterThan(sysAndMsg)
    const contextWindow = sysAndMsg + Math.floor(toolBlock / 2)
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })], tools })
    await expect(
      new OllamaAdapter({
        model: 'llama3.2',
        stream: false,
        tokenEncoding: enc,
        contextWindow,
        fetch: fetchFn as never,
      }).executor()(ctx, makeHelpers())
    ).rejects.toThrow(E_OLLAMA_CONTEXT_OVERFLOW)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does NOT overflow the same tool-heavy prompt when the window covers the tools', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'ok' })))
    const tools = new ToolRegistry([richTool('search_docs_semantic'), richTool('provide_answer')])
    const enc = 'cl100k_base' as const
    const everything =
      Tokenizable.estimateTokens('You are a helpful assistant.', enc) +
      Tokenizable.estimateTokens('hi', enc) +
      Tokenizable.estimateTokens(
        JSON.stringify(
          ollamaToolsFromTools(tools.visible(), { descriptionToChatCompletionsJsonSchema })
        ),
        enc
      )
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })], tools })
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      tokenEncoding: enc,
      contextWindow: everything + 256,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(1) // fetch WAS reached — no false overflow
  })
})

describe('OllamaAdapter — HTTP errors', () => {
  it('non-2xx surfaces E_OLLAMA_HTTP_ERROR via nack', async () => {
    const fetchFn = vi.fn(
      async () => new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } })
    )
    const ctx = makeCtx()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    const err = (ctx.nack as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err).toBeInstanceOf(E_OLLAMA_HTTP_ERROR)
  })
})
