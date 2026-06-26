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
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { BatteryLifecycleReport } from '@nhtio/adk/batteries/llm/transformers_js'

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
    // The bound (id, bytes) form (the adapter calls ctx.storeMediaBytes(id, bytes)). Returns an in-memory
    // reader over the given bytes so a generated Media round-trips back to the same bytes.
    storeMediaBytes: vi.fn(async (_id: string, bytes: Uint8Array) => inMemoryMediaReader(bytes)),
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

  it('passes EXPLICIT generation defaults to generate() (never lets it guess)', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    // No generation options supplied → the validation defaults must be materialised + forwarded.
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const kwargs = (pipe as unknown as { calls: Array<{ kwargs: Record<string, unknown> }> })
      .calls[0].kwargs
    expect(kwargs.max_new_tokens).toBe(1024)
    expect(kwargs.do_sample).toBe(false)
    expect(kwargs.repetition_penalty).toBeCloseTo(1.1)
    // Greedy → sampler knobs are intentionally omitted (transformers.js warns if set under do_sample:false).
    expect(kwargs.temperature).toBeUndefined()
    expect(kwargs.top_k).toBeUndefined()
    expect(kwargs.top_p).toBeUndefined()
    // Thinking is explicitly disabled (forwarded to the pipeline's internal apply_chat_template).
    expect(kwargs.enable_thinking).toBe(false)
  })

  it('sends pinned sampler knobs when sampling is enabled (doSample:true)', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      doSample: true,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const kwargs = (pipe as unknown as { calls: Array<{ kwargs: Record<string, unknown> }> })
      .calls[0].kwargs
    expect(kwargs.do_sample).toBe(true)
    expect(kwargs.temperature).toBeCloseTo(0.7)
    expect(kwargs.top_k).toBe(40)
    expect(kwargs.top_p).toBeCloseTo(0.95)
  })

  it('maps the PORTABLE canonical contract → native generate kwargs', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    // Canonical (battery-agnostic) config — the same shape LiteRT accepts.
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      maxTokens: 256,
      sampler: 'top-p',
      topP: 0.8,
      topK: 16,
      temperature: 0.3,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const kwargs = (pipe as unknown as { calls: Array<{ kwargs: Record<string, unknown> }> })
      .calls[0].kwargs
    // sampler:'top-p' → do_sample:true; canonical knobs + maxTokens→max_new_tokens flow through.
    expect(kwargs.do_sample).toBe(true)
    expect(kwargs.max_new_tokens).toBe(256)
    expect(kwargs.top_p).toBeCloseTo(0.8)
    expect(kwargs.top_k).toBe(16)
    expect(kwargs.temperature).toBeCloseTo(0.3)
  })

  it('canonical `sampler:"greedy"` wins over native `doSample:true` when both are set', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      sampler: 'greedy',
      doSample: true,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const kwargs = (pipe as unknown as { calls: Array<{ kwargs: Record<string, unknown> }> })
      .calls[0].kwargs
    expect(kwargs.do_sample).toBe(false) // canonical greedy wins
  })

  it('canonical `maxTokens` wins over native `maxNewTokens` when both are set', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: pipe as never,
      maxTokens: 128,
      maxNewTokens: 999,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    const kwargs = (pipe as unknown as { calls: Array<{ kwargs: Record<string, unknown> }> })
      .calls[0].kwargs
    expect(kwargs.max_new_tokens).toBe(128)
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

// ─── lifecycle hooks ────────────────────────────────────────────────────────────────────────────────

describe('TransformersJsAdapter — lifecycle hooks', () => {
  it('fires loading → compiling → ready → generating → complete in order (firehose + per-phase)', async () => {
    const seen: string[] = []
    const perPhase: string[] = []
    // Use `createPipeline` (the lazy load path) so loading/compiling/ready fire — a pre-built `pipeline`
    // short-circuits #resolvePipeline (nothing loaded → no loading/compiling/ready, by design).
    const adapter = new TransformersJsAdapter({
      model: 'fam/model',
      stream: false,
      autoAck: true,
      createPipeline: async () => makeFakePipeline({ text: 'hello world' }) as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
      onLoading: () => perPhase.push('loading'),
      onCompiling: () => perPhase.push('compiling'),
      onReady: () => perPhase.push('ready'),
      onGenerating: () => perPhase.push('generating'),
      onComplete: () => perPhase.push('complete'),
    })
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())

    // `compiling` (coarse "now preparing the graph" marker) lands between the download `loading` reports
    // and `ready`.
    expect(seen).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
    expect(perPhase).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete'])
  })

  it('a pre-built pipeline skips loading/ready (nothing loaded) but still fires generating/complete', async () => {
    const seen: string[] = []
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      pipeline: makeFakePipeline({ text: 'ok' }) as never,
      onLifecycle: (r: BatteryLifecycleReport) => seen.push(r.phase),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(seen).toEqual(['generating', 'complete'])
  })

  it('reports the right battery + model on every report', async () => {
    const reports: BatteryLifecycleReport[] = []
    const adapter = new TransformersJsAdapter({
      model: 'fam/model',
      stream: false,
      autoAck: true,
      createPipeline: async () => makeFakePipeline({ text: 'ok' }) as never,
      onLifecycle: (r: BatteryLifecycleReport) => reports.push(r),
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(reports.length).toBeGreaterThanOrEqual(4)
    for (const r of reports) {
      expect(r.battery).toBe('transformers_js')
      expect(r.model).toBe('fam/model')
      expect(typeof r.at).toBe('string')
    }
  })

  it('emits error (not complete) when generation throws', async () => {
    const phases: string[] = []
    const failing = vi.fn(async () => {
      throw new Error('generate boom')
    })
    ;(failing as unknown as { tokenizer: unknown }).tokenizer = { all_special_ids: [] }
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      pipeline: failing as never,
      onLifecycle: (r: BatteryLifecycleReport) => phases.push(r.phase),
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(phases).toContain('error')
    expect(phases).not.toContain('complete')
    expect(ctx.nack).toHaveBeenCalled()
  })

  it('forwards onInitProgress download events into a normalized loading report', async () => {
    const loadingReports: BatteryLifecycleReport[] = []
    const initSeen: unknown[] = []
    // A createPipeline that drives the provided onInitProgress with a fake HF progress event.
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      onInitProgress: (info: unknown) => initSeen.push(info),
      onLoading: (r: BatteryLifecycleReport) => loadingReports.push(r),
      createPipeline: async (input: { onInitProgress?: (info: unknown) => void }) => {
        input.onInitProgress?.({ status: 'progress', file: 'model.onnx', progress: 42 })
        const p = makeFakePipeline({ text: 'done' })
        return p as never
      },
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    // Original onInitProgress still called verbatim (additive).
    expect(initSeen).toHaveLength(1)
    // AND a normalized loading report with progress 0.42.
    const withProgress = loadingReports.find((r) => typeof r.progress === 'number')
    expect(withProgress?.progress).toBeCloseTo(0.42, 5)
    expect((withProgress?.raw as { file?: string })?.file).toBe('model.onnx')
  })

  it('a throwing consumer hook does not break the dispatch', async () => {
    const pipe = makeFakePipeline({ text: 'still works' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      pipeline: pipe as never,
      onLifecycle: () => {
        throw new Error('consumer hook blew up')
      },
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages[0]?.content?.toString()).toContain('still works')
    expect(ctx.ack).toHaveBeenCalledOnce()
  })
})

describe('TransformersJsAdapter — dispose (release ONNX sessions)', () => {
  it('awaits the loaded pipeline.dispose() to free ONNX sessions, then forces a fresh re-load', async () => {
    let loads = 0
    const dispose = vi.fn(async () => [])
    const createPipeline = vi.fn(async () => {
      loads += 1
      const pipe = makeFakePipeline({ text: 'ok' })
      ;(pipe as unknown as { dispose: () => Promise<unknown> }).dispose = dispose
      return pipe as never
    })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      createPipeline,
    })
    // First turn loads the pipeline; dispose() must free it (await the model's dispose).
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(loads).toBe(1)
    await adapter.dispose()
    expect(dispose).toHaveBeenCalledOnce()

    // The cached handle was dropped → the next dispatch re-resolves a FRESH pipeline (a 2nd load), not the
    // disposed one. This is what lets a long browser run reclaim GPU/wasm memory between cells.
    await adapter.executor()(makeCtx(), makeHelpers())
    expect(loads).toBe(2)
  })

  it('is a no-op (no throw) when nothing has been loaded', async () => {
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      createPipeline: vi.fn(),
    })
    await expect(adapter.dispose()).resolves.toBeUndefined()
  })

  it('swallows a throwing dispose() — teardown must never throw', async () => {
    const pipe = makeFakePipeline({ text: 'ok' })
    ;(pipe as unknown as { dispose: () => Promise<unknown> }).dispose = vi.fn(async () => {
      throw new Error('dispose boom')
    })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      pipeline: pipe as never,
    })
    await adapter.executor()(makeCtx(), makeHelpers())
    await expect(adapter.dispose()).resolves.toBeUndefined()
  })
})

describe('TransformersJsAdapter — media output (extractMediaOutputs seam)', () => {
  const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]) // 'RIFF' + payload

  it('attaches generated media to the assistant message + persists via storeMediaBytes', async () => {
    const pipe = makeFakePipeline({ text: 'here is your audio' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      pipeline: pipe as never,
      extractMediaOutputs: () => [{ kind: 'audio', mimeType: 'audio/wav', bytes: wavBytes }],
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]
    expect(msg?.content?.toString()).toBe('here is your audio')
    expect(msg?.attachments.length).toBe(1)
    expect(msg?.attachments[0]?.kind).toBe('audio')
    expect(msg?.attachments[0]?.mimeType).toBe('audio/wav')
    expect(msg?.attachments[0]?.trustTier).toBe('first-party')
    expect(
      (ctx as never as { storeMediaBytes: ReturnType<typeof vi.fn> }).storeMediaBytes
    ).toHaveBeenCalledOnce()
    // bytes round-trip through the stored reader
    expect(await msg!.attachments[0]!.asBytes()).toEqual(wavBytes)
  })

  it('media-only turn (empty text) still stores an assistant message carrying the attachment', async () => {
    const pipe = makeFakePipeline({ text: '' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      pipeline: pipe as never,
      extractMediaOutputs: () => [
        { kind: 'image', mimeType: 'image/png', bytes: wavBytes, filename: 'x.png' },
      ],
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]
    expect(msg).toBeDefined()
    expect(msg?.attachments[0]?.kind).toBe('image')
    expect(msg?.attachments[0]?.filename).toBe('x.png')
  })

  it('DEFAULT (no hook) stores a text-only message with NO attachments — no regression', async () => {
    const pipe = makeFakePipeline({ text: 'plain text answer' })
    const adapter = new TransformersJsAdapter({
      model: 'm',
      stream: false,
      autoAck: true,
      pipeline: pipe as never,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]
    expect(msg?.content?.toString()).toBe('plain text answer')
    expect(msg?.attachments.length).toBe(0)
    expect(
      (ctx as never as { storeMediaBytes: ReturnType<typeof vi.fn> }).storeMediaBytes
    ).not.toHaveBeenCalled()
  })
})
