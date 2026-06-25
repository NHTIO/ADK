import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import {
  TransformersJsAdapter,
  E_INVALID_TRANSFORMERS_JS_OPTIONS,
} from '@nhtio/adk/batteries/llm/transformers_js'
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
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// ─── shared mock context / helpers (mirrors the litert spec) ──────────────────────────────────────────

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const makeMessage = (o: {
  id?: string
  role?: 'user' | 'assistant'
  content?: string
  createdAt?: DateTime
}) => {
  const createdAt = o.createdAt ?? dt('2026-01-01T12:00:00Z')
  return new Message({
    id: o.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    role: o.role ?? 'user',
    content: o.content ?? 'hello',
    createdAt,
    updatedAt: createdAt,
  })
}

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (
  overrides: {
    systemPrompt?: string
    turnMessages?: Message[]
    tools?: ToolRegistry
    stash?: Record<string, unknown>
    abortSignal?: AbortSignal
  } = {}
): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const ctx = {
    systemPrompt: new Tokenizable(overrides.systemPrompt ?? 'You are a helpful assistant.'),
    turnMessages: new Set(overrides.turnMessages ?? []),
    turnThoughts: new Set<Thought>(),
    turnToolCalls: new Set<ToolCall>(),
    turnMemories: new Set<Memory>(),
    turnRetrievables: new Set<Retrievable>(),
    standingInstructions: new Set<Tokenizable>(),
    tools: overrides.tools ?? new ToolRegistry(),
    stash: new Registry(overrides.stash ?? {}),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
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
    mutateToolCall: vi.fn(async () => undefined),
    _stored: stored,
  } as unknown as MockCtx
  return ctx
}

const makeHelpers = (): DispatchExecutorHelpers & {
  _events: Array<{ kind: string; id: string; payload: unknown }>
} => {
  const events: Array<{ kind: string; id: string; payload: unknown }> = []
  return {
    reportMessage: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) =>
      events.push({ kind: 'message', id, payload: { delta, ...(opts ?? {}) } })
    ),
    reportThought: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) =>
      events.push({ kind: 'thought', id, payload: { delta, ...(opts ?? {}) } })
    ),
    reportToolCall: vi.fn((id: string, partial: unknown) =>
      events.push({ kind: 'toolCall', id, payload: partial })
    ),
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportGenerationStats: vi.fn(),
    _events: events,
  } as unknown as DispatchExecutorHelpers & { _events: typeof events }
}

// ─── fake text-generation pipeline ────────────────────────────────────────────────────────────────────
//
// transformers.js pipeline is a CALLABLE with a `.tokenizer`. The adapter passes a streamer in
// `generate_kwargs.streamer`; our fake invokes its `callback_function` with chunks to simulate token
// streaming, then returns the final chat output. We inject a lightweight `createStreamer` (below) so
// the test never imports the heavy `@huggingface/transformers` peer — which is essential in the
// browser project, where optimizing the ONNX/wasm peer would hang.

interface FakePipeOpts {
  /** Final assistant text (non-stream) and/or the concatenation of stream chunks. */
  text: string
  /** Stream chunks; if omitted, `[text]`. */
  chunks?: string[]
}

// A lightweight streamer factory: builds an object with a `callback_function` wired to `onText`, which
// the fake pipeline invokes per chunk. Mirrors the real TextStreamer's callback contract.
const fakeCreateStreamer = ({ onText }: { onText: (t: string) => void }) => ({
  callback_function: (t: string) => onText(t),
})

const makeFakePipeline = (opts: FakePipeOpts) => {
  const calls: Array<{ messages: unknown; kwargs: Record<string, unknown> }> = []
  const fn = vi.fn(async (messages: unknown, kwargs: Record<string, unknown>) => {
    calls.push({ messages, kwargs })
    const streamer = kwargs.streamer as { callback_function?: (t: string) => void } | undefined
    if (streamer && typeof streamer.callback_function === 'function') {
      for (const c of opts.chunks ?? [opts.text]) streamer.callback_function(c)
    }
    return [
      {
        generated_text: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: opts.text },
        ],
      },
    ]
  })
  ;(fn as unknown as { tokenizer: unknown }).tokenizer = { all_special_ids: [] }
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn
}

const echoTool = () =>
  new Tool({
    name: 'echo',
    description: 'echo tool',
    inputSchema: validator.object({ text: validator.string().required() }),
    handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
  })

// ─── static + validation ─────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — static + validation', () => {
  it('exposes its stash key and is env-neutral available', () => {
    expect(TransformersJsAdapter.STASH_KEY).toBe('transformersJs')
    expect(TransformersJsAdapter.isAvailable()).toBe(true)
  })
  it('requires a model', () => {
    expect(() => new TransformersJsAdapter({})).toThrow(E_INVALID_TRANSFORMERS_JS_OPTIONS)
  })
  it('rejects unknown keys', () => {
    expect(() => new TransformersJsAdapter({ model: 'm', bogus: 1 })).toThrow(
      E_INVALID_TRANSFORMERS_JS_OPTIONS
    )
  })
  it('rejects an invalid toolCallParser name', () => {
    expect(() => new TransformersJsAdapter({ model: 'm', toolCallParser: 'nope' })).toThrow(
      E_INVALID_TRANSFORMERS_JS_OPTIONS
    )
  })
})

// ─── text generation ──────────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — text generation', () => {
  it('non-streaming: stores assistant text + acks when autoAck', async () => {
    const pipe = makeFakePipeline({ text: 'Hello from transformers.js.' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      autoAck: true,
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('Hello from transformers.js.')
    expect(ctx.ack).toHaveBeenCalledOnce()
  })

  it('streaming: accumulates chunk deltas and stores final text', async () => {
    const pipe = makeFakePipeline({ text: 'hi there', chunks: ['hi ', 'there'] })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: true,
      pipeline: pipe as never,
      createStreamer: fakeCreateStreamer,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('hi there')
    expect(ctx.ack).toHaveBeenCalledOnce()
  })

  it('autoAck defaults to false → no ack', async () => {
    const pipe = makeFakePipeline({ text: 'hello' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages.length).toBeGreaterThan(0)
  })

  it('passes tools into the generate kwargs when tools are present', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
    })
    await adapter.executor()(makeCtx({ tools: new ToolRegistry([echoTool()]) }), makeHelpers())
    const kwargs = (pipe as unknown as { calls: Array<{ kwargs: Record<string, unknown> }> })
      .calls[0].kwargs
    expect(Array.isArray(kwargs.tools)).toBe(true)
    expect((kwargs.tools as Array<{ function: { name: string } }>)[0].function.name).toBe('echo')
  })
})

// ─── reasoning extraction ─────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — reasoning extraction', () => {
  it('pulls <think> reasoning into a Thought and leaves clean prose', async () => {
    const pipe = makeFakePipeline({ text: '<think>Let me consider.</think>The answer is 42.' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.thoughts[0]?.content?.toString()).toBe('Let me consider.')
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('The answer is 42.')
  })
})

// ─── tool calls via parser ────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — tool calls (parsed from text)', () => {
  it('hermes: executes the tool, stores result, no ack', async () => {
    const pipe = makeFakePipeline({
      text: 'Sure.<tool_call>{"name":"echo","arguments":{"text":"hi"}}</tool_call>',
    })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      autoAck: true,
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    expect(ctx._stored.toolCalls[0].tool).toBe('echo')
    expect(await (ctx._stored.toolCalls[0].results as SpooledArtifact).asString()).toContain(
      'echoed: hi'
    )
    expect(ctx.ack).not.toHaveBeenCalled()
    // The raw <tool_call> markup must not leak into the persisted message.
    expect(ctx._stored.messages[0]?.content?.toString() ?? '').not.toContain('<tool_call>')
  })

  it('pythonic: callee-guarded extraction', async () => {
    const pipe = makeFakePipeline({ text: "[echo(text='streamed')]" })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(await (ctx._stored.toolCalls[0].results as SpooledArtifact).asString()).toContain(
      'echoed: streamed'
    )
  })

  it("toolCallParser: 'none' disables parsing → markup stays as message text", async () => {
    const pipe = makeFakePipeline({
      text: '<tool_call>{"name":"echo","arguments":{"text":"x"}}</tool_call>',
    })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      toolCallParser: 'none',
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.storeToolCall).not.toHaveBeenCalled()
    expect(ctx._stored.messages[0]?.content?.toString()).toContain('<tool_call>')
  })

  it('custom toolCallParser fn is honoured', async () => {
    const pipe = makeFakePipeline({ text: 'CALL echo' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      toolCallParser: () => ({
        calls: [{ name: 'echo', arguments: { text: 'custom' } }],
        cleanedText: '',
      }),
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(await (ctx._stored.toolCalls[0].results as SpooledArtifact).asString()).toContain(
      'echoed: custom'
    )
  })

  it('unknown tool → stored as error', async () => {
    const pipe = makeFakePipeline({ text: '<tool_call>{"name":"nope","arguments":{}}</tool_call>' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
    })
    const ctx = makeCtx({ tools: new ToolRegistry([echoTool()]) })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls[0].isError).toBe(true)
    expect((ctx._stored.toolCalls[0].results as Tokenizable).toString()).toContain(
      'Tool not found: nope'
    )
  })
})

// ─── option layering ──────────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — option layering', () => {
  it('stash overrides win over the constructor baseline', async () => {
    const basePipe = makeFakePipeline({ text: 'base' })
    const stashPipe = makeFakePipeline({ text: 'stashed' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: basePipe as never,
    })
    const ctx = makeCtx({ stash: { transformersJs: { pipeline: stashPipe } } })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toBe('stashed')
  })
})

// ─── abort ──────────────────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — abort', () => {
  it('a pre-aborted signal stores nothing', async () => {
    const pipe = makeFakePipeline({ text: 'should not be seen' })
    const adapter = new TransformersJsAdapter({ model: 'm', stream: true, pipeline: pipe as never })
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx({ abortSignal: ac.signal })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages).toHaveLength(0)
  })
})
