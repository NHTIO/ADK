import { DateTime } from 'luxon'
import { EventEmitter } from 'node:events'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeCliAdapter } from '../../../../../src/batteries/llm/claude_code_cli/adapter'
import { E_INVALID_CLAUDE_CODE_CLI_OPTIONS } from '../../../../../src/batteries/llm/claude_code_cli/exceptions'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Tool,
  ArtifactTool,
  ToolRegistry,
  Registry,
  Media,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import {
  E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR,
  E_CLAUDE_CODE_CLI_WRAPPER_CRASHED,
  E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO,
  E_CLAUDE_CODE_CLI_STREAM_STALLED,
  E_CLAUDE_CODE_CLI_TURN_FAILED,
} from '../../../../../src/batteries/llm/claude_code_cli/exceptions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { WrapperEvent } from '../../../../../src/batteries/llm/claude_code_cli/wire'

const dt = (iso: string): DateTime => DateTime.fromISO(iso, { zone: 'utc' })

// ─── fake execa-shaped wrapper child ───────────────────────────────────────────

/**
 * Hermetic fake for what `execa()` returns — mirrors `local_diffusion/adapter.node.spec.ts`'s
 * `FakeBackend` pattern, but shaped for this adapter's own duck (`stdin.write`, `stdout` event
 * emitter, `kill`, and a thenable resolving to `{ exitCode }`).
 */
class FakeWrapperChild {
  readonly writes: string[] = []
  readonly kills: Array<string | undefined> = []
  readonly stdout = new EventEmitter()
  #resolve!: (v: { exitCode: number | null }) => void
  #settled = false
  readonly #promise: Promise<{ exitCode: number | null }>

  constructor() {
    this.#promise = new Promise((resolve) => {
      this.#resolve = resolve
    })
  }

  get stdin(): { write: (chunk: string) => void; end: () => void } {
    return {
      write: (chunk: string): void => {
        this.writes.push(chunk)
      },
      end: (): void => {},
    }
  }

  kill(signal?: string): boolean {
    this.kills.push(signal)
    return true
  }

  /** Resolve the execa promise as if the wrapper process exited. */
  exit(exitCode: number | null): void {
    if (this.#settled) return
    this.#settled = true
    this.#resolve({ exitCode })
  }

  emit(event: WrapperEvent): void {
    this.stdout.emit('data', new TextEncoder().encode(`${JSON.stringify(event)}\n`))
  }

  emitRaw(line: string): void {
    this.stdout.emit('data', new TextEncoder().encode(`${line}\n`))
  }

  endStdout(): void {
    this.stdout.emit('end')
  }

  then<T>(
    onFulfilled?: (v: { exitCode: number | null }) => T,
    onRejected?: (e: unknown) => T
  ): Promise<T> {
    return this.#promise.then(onFulfilled, onRejected) as Promise<T>
  }

  catch<T>(onRejected: (e: unknown) => T): Promise<T> {
    return this.#promise.catch(onRejected) as Promise<T>
  }
}

const parsedWrites = (fake: FakeWrapperChild): Array<Record<string, unknown>> =>
  fake.writes.map((w) => JSON.parse(w) as Record<string, unknown>)

// ─── mock DispatchContext (mirrors ollama/anthropic_messages adapter test convention) ──

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

interface CtxOverrides {
  systemPrompt?: string | Tokenizable
  turnMessages?: Message[]
  turnThoughts?: Thought[]
  turnToolCalls?: ToolCall[]
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
  return {
    systemPrompt: sp,
    turnMessages: new Set(overrides.turnMessages ?? []),
    turnThoughts: new Set(overrides.turnThoughts ?? []),
    turnToolCalls: new Set(overrides.turnToolCalls ?? []),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
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

// ─── execa fake resolver ────────────────────────────────────────────────────────

/**
 * Returns an `execa`-shaped fake function that always yields `fake`, and records call args.
 *
 * @remarks
 * `resolveExeca`'s own heuristic (mirrored from `execa_executor.ts`) treats any bare function
 * lacking an `.exec` property as a zero-arg RESOLVER to be invoked and awaited, not as the
 * `ExecaLike` spawn function itself — a real `execa` module namespace object always carries other
 * exports alongside `execa`. Stamping a dummy `.exec` property here is what makes this fake
 * classify as the function itself, matching how a real `execa` import would be told apart from a
 * caller-supplied resolver.
 */
const makeExecaFn = (
  fake: FakeWrapperChild
): { execaFn: (...args: unknown[]) => FakeWrapperChild; calls: unknown[][] } => {
  const calls: unknown[][] = []
  const execaFn = (...args: unknown[]): FakeWrapperChild => {
    calls.push(args)
    return fake
  }
  ;(execaFn as unknown as { exec: unknown }).exec = true
  return { execaFn, calls }
}

const baseOptions = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-sonnet-5',
  apiKey: 'sk-test',
  wrapperPath: '/fake/wrapper.mjs',
  ...extra,
})

// A macrotask tick, not just microtask drains: the adapter's tool-call handling and options
// re-validation involve real async work (Tool.validate, spoolStore writes) deep enough that two
// bare `Promise.resolve()` ticks are not always sufficient to observe a subsequent stdin write.
const nextTurn = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('ClaudeCodeCliAdapter — spawn shape', () => {
  it('spawns via execa(process.execPath, [wrapperPath], {cleanup:true}), never execa(wrapperPath, [])', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn, calls } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const helpers = makeHelpers()
    const ctx = makeCtx()
    const result = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({ type: 'result', isError: false, resultText: 'ok' })
    fake.exit(0)
    await result

    expect(calls).toHaveLength(1)
    const [cmd, args, options] = calls[0] as [string, string[], Record<string, unknown>]
    expect(cmd).toBe(process.execPath)
    expect(args).toEqual(['/fake/wrapper.mjs'])
    expect(options).toMatchObject({ cleanup: true })
    expect(options).not.toHaveProperty('cancelSignal')
  })
})

describe('ClaudeCodeCliAdapter — happy path', () => {
  it('completes a full run: ready -> init -> message_delta -> result, storing a Message and awaiting wrapper self-shutdown', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
    const ctx = makeCtx({
      turnMessages: [
        new Message({
          id: 'm1',
          role: 'user',
          content: 'hi',
          identity: 'user' as never,
          createdAt: dt('2026-01-01T00:00:00Z'),
          updatedAt: dt('2026-01-01T00:00:00Z'),
        }),
      ],
    })
    const helpers = makeHelpers()

    let settled = false
    const promise = (adapter.executor()(ctx, helpers) as Promise<void>).then(() => {
      settled = true
    })
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init', model: 'claude-sonnet-5' })
    await nextTurn()
    fake.emit({ type: 'message_delta', id: 'msg-1', delta: 'Hello there', isComplete: true })
    await nextTurn()

    // Terminal `result` observed — the adapter must await the wrapper's OWN self-shutdown (its
    // process exit) before the executor promise settles, per Decision D step 5.
    fake.emit({ type: 'result', isError: false, resultText: 'Hello there' })
    await nextTurn()
    expect(settled).toBe(false)
    fake.exit(0)
    await promise
    expect(settled).toBe(true)

    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('Hello there')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._stats).toHaveLength(1)
    expect(helpers._stats[0]).toMatchObject({ provider: 'claude_code_cli' })

    // The `run` command's own `prompt` field carries the rendered history.
    const runCmd = parsedWrites(fake).find((w) => w.type === 'run')
    expect(runCmd).toBeDefined()
    expect(String(runCmd!.prompt)).toContain('hi')
  })

  it('a terminal result{isError:true} nacks with E_CLAUDE_CODE_CLI_TURN_FAILED', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx()
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({
      type: 'result',
      isError: true,
      stopReason: 'max_budget_usd_exceeded',
      resultText: 'budget exhausted',
    })
    fake.exit(0)
    await promise
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_TURN_FAILED))
  })
})

describe('ClaudeCodeCliAdapter — real ADK tool invocation via tool_call_request/tool_call_response', () => {
  it('invokes a real Tool via tool.executor(ctx)(args), stores the ToolCall, and answers with tool_call_response', async () => {
    const handlerSeen = vi.fn(async (args: unknown) => `echoed:${JSON.stringify(args)}`)
    const tool = new Tool({
      name: 'echo_tool',
      description: 'echoes',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: handlerSeen as never,
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({
      type: 'tool_call_request',
      requestId: 'req-1',
      tool: 'echo_tool',
      args: { text: 'hi' },
    })
    await nextTurn()
    await nextTurn()

    expect(handlerSeen).toHaveBeenCalledWith({ text: 'hi' }, expect.anything(), expect.anything())
    expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
    expect(ctx._stored.toolCalls[0]!.tool).toBe('echo_tool')
    expect(ctx._stored.toolCalls[0]!.isError).toBe(false)

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    expect(response).toBeDefined()
    expect(response!.requestId).toBe('req-1')
    // A plain (non-ArtifactTool) Tool's raw string return is spooled and rendered as a bounded
    // handle, not inlined verbatim — matching Ollama's own `inline: isArtifactTool` behavior
    // (see the outbound-rendering-matrix tests below for the ArtifactTool inline counterpart).
    const results = response!.results as { content: Array<{ type: string; text?: string }> }
    expect(results.content[0]).toMatchObject({ type: 'text' })
    expect(results.content[0]!.text).toContain('was not inlined to preserve context budget')
    expect(results.content[0]!.text).toContain('callId: req-1')

    fake.emit({ type: 'result', isError: false, resultText: 'done' })
    fake.exit(0)
    await promise
  })

  it('gives repeated calls to the same tool with identical args the SAME checksum, distinct requestId, but a DIFFERENT checksum from a call with different args', async () => {
    const tool = new Tool({
      name: 'echo_tool',
      description: 'echoes',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (async (args: unknown) => `echoed:${JSON.stringify(args)}`) as never,
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({
      type: 'tool_call_request',
      requestId: 'req-1',
      tool: 'echo_tool',
      args: { text: 'hi' },
    })
    await nextTurn()
    await nextTurn()
    fake.emit({
      type: 'tool_call_request',
      requestId: 'req-2',
      tool: 'echo_tool',
      args: { text: 'hi' },
    })
    await nextTurn()
    await nextTurn()
    fake.emit({
      type: 'tool_call_request',
      requestId: 'req-3',
      tool: 'echo_tool',
      args: { text: 'different' },
    })
    await nextTurn()
    await nextTurn()

    expect(ctx._stored.toolCalls).toHaveLength(3)
    const [first, second, third] = ctx._stored.toolCalls
    // Distinct requestId-derived `id`s (correlation), per call.
    expect(first!.id).toBe('req-1')
    expect(second!.id).toBe('req-2')
    expect(third!.id).toBe('req-3')
    // Identical tool+args must share a checksum — this is what DispatchContext's own
    // toolCallCount/repeat-bound loop detection and cross-bus correlation key on. Neither must
    // ever equal the (per-call-unique) requestId itself.
    expect(first!.checksum).toBe(second!.checksum)
    expect(first!.checksum).not.toBe('req-1')
    expect(second!.checksum).not.toBe('req-2')
    // A different-args call must get a DIFFERENT checksum.
    expect(third!.checksum).not.toBe(first!.checksum)

    fake.emit({ type: 'result', isError: false, resultText: 'done' })
    fake.exit(0)
    await promise
  })

  it('answers "Tool not found" for a tool_call_request naming an unregistered tool', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx()
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({ type: 'tool_call_request', requestId: 'req-x', tool: 'ghost_tool', args: {} })
    await nextTurn()

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    expect(response).toBeDefined()
    const results = response!.results as { content: Array<{ text: string }>; isError: boolean }
    expect(results.isError).toBe(true)
    expect(results.content[0]!.text).toContain('Tool not found')

    fake.emit({ type: 'result', isError: false, resultText: 'done' })
    fake.exit(0)
    await promise
  })

  it('a throwing handler is caught, isError:true is stored and returned, never rejecting the executor', async () => {
    const tool = new Tool({
      name: 'boom_tool',
      description: 'always throws',
      inputSchema: validator.object({}).unknown(true),
      handler: (() => {
        throw new Error('handler exploded')
      }) as never,
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({ type: 'tool_call_request', requestId: 'req-boom', tool: 'boom_tool', args: {} })
    await nextTurn()

    expect(ctx._stored.toolCalls[0]!.isError).toBe(true)
    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    const results = response!.results as { content: Array<{ text: string }>; isError: boolean }
    expect(results.isError).toBe(true)

    fake.emit({ type: 'result', isError: false, resultText: 'done' })
    fake.exit(0)
    await promise
  })
})

describe('ClaudeCodeCliAdapter — outbound tool-result rendering matrix', () => {
  const withReadyToolCall = async (
    fake: FakeWrapperChild,
    promise: void | Promise<void>,
    requestId: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<void> => {
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({ type: 'tool_call_request', requestId, tool: toolName, args })
    await nextTurn()
    void promise
  }

  it('renders an ArtifactTool (inline) plain-string result as a single text content block', async () => {
    // An ArtifactTool's result is always treated as inline (isArtifactTool → inline: true), so a
    // plain string return renders verbatim rather than as a handle — this is the genuine
    // "single plain text content block" case; a non-ArtifactTool Tool's string return is spooled
    // and handle-rendered instead (covered separately below).
    const tool = new ArtifactTool({
      name: 'text_tool',
      description: 'returns text',
      inputSchema: validator.object({}).unknown(true),
      handler: async () => 'plain text result',
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const promise = adapter.executor()(ctx, makeHelpers())
    await withReadyToolCall(fake, promise, 'r1', 'text_tool')

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    const results = response!.results as { content: Array<{ type: string; text: string }> }
    expect(results.content).toEqual([{ type: 'text', text: 'plain text result' }])

    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  })

  it('renders an image Media result as an image content block', async () => {
    const tool = new Tool({
      name: 'image_tool',
      description: 'returns an image',
      inputSchema: validator.object({}).unknown(true),
      handler: async () =>
        Media.toolGenerated({
          kind: 'image',
          mimeType: 'image/png',
          filename: 'out.png',
          reader: inMemoryMediaReader(new Uint8Array([1, 2, 3])),
        }),
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const promise = adapter.executor()(ctx, makeHelpers())
    await withReadyToolCall(fake, promise, 'r2', 'image_tool')

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    const results = response!.results as {
      content: Array<{ type: string; data?: string; mimeType?: string }>
    }
    expect(results.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]).toString('base64'),
    })

    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  })

  it('renders a non-inline SpooledArtifact as a bounded handle body (text block)', async () => {
    const tool = new ArtifactTool({
      name: 'handle_tool',
      description: 'returns a large artifact',
      inputSchema: validator.object({}).unknown(true),
      handler: async () => 'irrelevant',
    })
    // ArtifactTool results are ALWAYS treated as inline by the adapter's own isArtifactTool
    // branch — to exercise the non-inline handle path we go through a plain Tool that returns a
    // raw string, which the adapter spools and wraps with `inline: false` semantics applying only
    // via the ArtifactTool flag. Since ArtifactTool forces inline:true, use a plain Tool instead
    // and assert the SpooledArtifact-handle path directly through renderOutboundResult's own
    // consumer: a plain Tool whose handler returns a raw string is spooled + wrapped as
    // `inline: isArtifactTool` (false for a plain Tool) by the adapter.
    void tool
    const plainTool = new Tool({
      name: 'plain_spool_tool',
      description: 'returns raw text that gets spooled',
      inputSchema: validator.object({}).unknown(true),
      handler: async () => 'a large body that gets spooled and rendered as a handle',
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([plainTool]) })
    const promise = adapter.executor()(ctx, makeHelpers())
    await withReadyToolCall(fake, promise, 'r3', 'plain_spool_tool')

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    const results = response!.results as { content: Array<{ type: string; text: string }> }
    expect(results.content[0]!.type).toBe('text')
    expect(results.content[0]!.text).toContain('was not inlined to preserve context budget')
    expect(results.content[0]!.text).not.toContain(
      'a large body that gets spooled and rendered as a handle'
    )

    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  })

  it('renders an ArtifactTool (inline) SpooledArtifact result via .asString(), not a handle', async () => {
    const tool = new ArtifactTool({
      name: 'inline_artifact_tool',
      description: 'returns an inline artifact',
      inputSchema: validator.object({}).unknown(true),
      handler: async () => 'the full inline body',
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const promise = adapter.executor()(ctx, makeHelpers())
    await withReadyToolCall(fake, promise, 'r4', 'inline_artifact_tool')

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    const results = response!.results as { content: Array<{ type: string; text: string }> }
    expect(results.content[0]!.text).toBe('the full inline body')

    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  })

  it.each(['throw', 'fallback-stash', 'synthetic-description'] as const)(
    'other-Media-kind result under unsupportedResultMediaPolicy=%s',
    async (policy) => {
      const tool = new Tool({
        name: 'audio_tool',
        description: 'returns audio',
        inputSchema: validator.object({}).unknown(true),
        handler: async () =>
          Media.toolGenerated({
            kind: 'audio',
            mimeType: 'audio/wav',
            filename: 'clip.wav',
            reader: inMemoryMediaReader(new Uint8Array([9, 9, 9])),
          }),
      })
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({ execa: execaFn, unsupportedResultMediaPolicy: policy })
      )
      const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
      const promise = adapter.executor()(ctx, makeHelpers())
      await withReadyToolCall(fake, promise, 'r5', 'audio_tool')

      const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
      const results = response!.results as {
        content: Array<{ type: string; text: string }>
        isError: boolean
      }
      expect(results.content[0]!.type).toBe('text')
      if (policy === 'throw') {
        expect(results.isError).toBe(true)
        expect(results.content[0]!.text).toContain('Unsupported result media modality')
      } else {
        expect(results.isError).toBe(false)
        expect(results.content[0]!.text).toContain('clip.wav')
      }

      fake.emit({ type: 'result', isError: false })
      fake.exit(0)
      await promise
    }
  )
})

describe('ClaudeCodeCliAdapter — timeouts and abnormal termination', () => {
  it('idle-timeout: no wrapper output for streamIdleTimeoutMs -> nacks E_CLAUDE_CODE_CLI_STREAM_STALLED, writes shutdown, escalates to SIGTERM', async () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({ execa: execaFn, streamIdleTimeoutMs: 50, disposeGraceMs: 10 })
      )
      const ctx = makeCtx()
      const promise = adapter.executor()(ctx, makeHelpers())
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'init' })
      await vi.advanceTimersByTimeAsync(0)
      // No further stdout — advance past streamIdleTimeoutMs + disposeGraceMs.
      await vi.advanceTimersByTimeAsync(200)
      await promise
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_STALLED))
      expect(fake.writes.some((w) => (JSON.parse(w) as { type: string }).type === 'shutdown')).toBe(
        true
      )
      expect(fake.kills).toContain('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('exit-without-result: wrapper process exits with no terminal event observed -> E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx()
    const promise = adapter.executor()(ctx, makeHelpers())
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.exit(1)
    await promise
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO))
  })

  it('stdout end with no terminal event -> E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx()
    const promise = adapter.executor()(ctx, makeHelpers())
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.endStdout()
    await promise
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO))
  })

  it('a terminal result immediately followed by stdout end does NOT get nacked as an unexpected exit (regression)', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
    const ctx = makeCtx()
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    // Emit the terminal `result` and close stdout in the SAME tick, with no `await` gap between
    // them — reproducing the wrapper writing its terminal line and closing the pipe essentially
    // simultaneously, which previously raced `sealCurrentMessage()`'s await against `stdout`'s
    // `'end'` handler.
    fake.emit({ type: 'result', isError: false, resultText: 'done' })
    fake.endStdout()
    fake.exit(0)
    await promise

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._stats).toHaveLength(1)
  })

  it('a terminal result immediately followed by the wrapper process itself exiting does NOT get nacked as an unexpected exit (regression)', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
    const ctx = makeCtx()
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({ type: 'result', isError: false, resultText: 'done' })
    // The wrapper process settling before the `result` handler's own `await Promise.resolve(child)`
    // resolves is exactly the race this test reproduces.
    fake.exit(0)
    await promise

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })

  it('a rejected wrapper promise -> E_CLAUDE_CODE_CLI_WRAPPER_CRASHED', async () => {
    const rejecting = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: new EventEmitter(),
      kill: vi.fn(),
      then: (
        _resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown
      ): Promise<unknown> => Promise.reject(new Error('boom')).catch(reject),
      catch: (reject: (e: unknown) => unknown): Promise<unknown> =>
        Promise.reject(new Error('boom')).catch(reject),
    }
    const execaFn = (): typeof rejecting => rejecting
    ;(execaFn as unknown as { exec: unknown }).exec = true
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn as never }))
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_WRAPPER_CRASHED))
  })

  it('malformed NDJSON frame from the wrapper is non-fatal: logged at trace, turn still completes', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx()
    const helpers = makeHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emitRaw('{not valid json')
    await nextTurn()
    expect(helpers.log.trace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'malformed-wrapper-event' })
    )
    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
    expect(ctx.nack).not.toHaveBeenCalled()
  })

  it('an execa resolver rejection surfaces E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR via nack', async () => {
    const adapter = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: (() => {
          throw new Error('resolver blew up')
        }) as never,
      })
    )
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR))
  })

  it('ctx.abortSignal firing writes shutdown, waits disposeGraceMs, then SIGTERMs the wrapper', async () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const controller = new AbortController()
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, disposeGraceMs: 25 }))
      const ctx = makeCtx({ abortSignal: controller.signal })
      const promise = adapter.executor()(ctx, makeHelpers())
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'init' })
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.writes.some((w) => (JSON.parse(w) as { type: string }).type === 'shutdown')).toBe(
        true
      )
      expect(fake.kills).toEqual([])
      await vi.advanceTimersByTimeAsync(30)
      expect(fake.kills).toContain('SIGTERM')
      fake.exit(0)
      await promise
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ClaudeCodeCliAdapter — options-merge precedence and validation', () => {
  it('merges constructor -> executor override -> ctx.stash, later layers winning', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(
      baseOptions({ execa: execaFn, model: 'ctor-model', appendSystemPrompt: 'ctor' })
    )
    const executor = adapter.executor({ model: 'exec-model' })
    const ctx = makeCtx({
      stash: { claudeCodeCli: { model: 'stash-model' } },
    })
    const promise = executor(ctx, makeHelpers())
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    const runCmd = parsedWrites(fake).find((w) => w.type === 'run')
    expect(runCmd!.model).toBe('stash-model')
    expect(runCmd!.appendSystemPrompt).toBe('ctor')
    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  })

  it('exposes STASH_KEY === "claudeCodeCli" and isClaudeCodeCliAdapter recognises instances', () => {
    expect(ClaudeCodeCliAdapter.STASH_KEY).toBe('claudeCodeCli')
    const adapter = new ClaudeCodeCliAdapter(baseOptions())
    expect(ClaudeCodeCliAdapter.isClaudeCodeCliAdapter(adapter)).toBe(true)
    expect(ClaudeCodeCliAdapter.isClaudeCodeCliAdapter({})).toBe(false)
  })

  it('throws E_INVALID_CLAUDE_CODE_CLI_OPTIONS at construction on bad options', () => {
    expect(() => new ClaudeCodeCliAdapter({})).toThrow(E_INVALID_CLAUDE_CODE_CLI_OPTIONS)
  })

  it('apiKey/authToken XOR: both set or neither set throws at construction', () => {
    expect(() => new ClaudeCodeCliAdapter({ model: 'm', apiKey: 'a', authToken: 'b' })).toThrow(
      E_INVALID_CLAUDE_CODE_CLI_OPTIONS
    )
    expect(() => new ClaudeCodeCliAdapter({ model: 'm' })).toThrow(
      E_INVALID_CLAUDE_CODE_CLI_OPTIONS
    )
  })

  it.each([
    { flag: '--betas', value: ['--model', 'x'] },
    { flag: '--effort', value: '-x' },
    { flag: '--not-a-real-flag', value: 'x' },
  ])('extraArgs security-flag rejection: %j', (entry) => {
    expect(() => new ClaudeCodeCliAdapter(baseOptions({ extraArgs: [entry] }))).toThrow(
      E_INVALID_CLAUDE_CODE_CLI_OPTIONS
    )
  })

  it('a merged-in-per-iteration invalid override throws (re-validated every iteration)', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx({ stash: { claudeCodeCli: { apiKey: 'also-set' } } })
    // Both apiKey (ctor) and authToken-equivalent stash apiKey collide only if XOR fields differ;
    // force a genuine XOR violation instead by stashing authToken alongside the ctor's apiKey.
    const ctxXor = makeCtx({ stash: { claudeCodeCli: { authToken: 'also-set' } } })
    void ctx
    await expect(adapter.executor()(ctxXor, makeHelpers())).rejects.toBeInstanceOf(
      E_INVALID_CLAUDE_CODE_CLI_OPTIONS
    )
  })

  it('bridgedTools excludes disallowedTools before reaching the run command', async () => {
    const keep = new Tool({
      name: 'keep_tool',
      description: 'kept',
      inputSchema: validator.object({}).unknown(true),
      handler: async () => 'ok',
    })
    const drop = new Tool({
      name: 'drop_tool',
      description: 'dropped',
      inputSchema: validator.object({}).unknown(true),
      handler: async () => 'ok',
    })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(
      baseOptions({ execa: execaFn, disallowedTools: ['drop_tool'] })
    )
    const ctx = makeCtx({ tools: new ToolRegistry([keep, drop]) })
    const promise = adapter.executor()(ctx, makeHelpers())
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    const runCmd = parsedWrites(fake).find((w) => w.type === 'run') as {
      bridgedTools: Array<{ name: string }>
      allowedTools: string[]
    }
    expect(runCmd.bridgedTools.map((t) => t.name)).toEqual(['keep_tool'])
    expect(runCmd.allowedTools).toEqual(['keep_tool'])
    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  })
})

describe('ClaudeCodeCliAdapter — MCP bridge startup failure', () => {
  it('an init event naming an mcpServerErrors entry for the bridge nacks E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
    const ctx = makeCtx()
    const promise = adapter.executor()(ctx, makeHelpers())
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init', mcpServerErrors: ['adk_bridge'] })
    await nextTurn()
    fake.exit(0)
    await promise
    const { E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED } =
      await import('../../../../../src/batteries/llm/claude_code_cli/exceptions')
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED))
  })
})
