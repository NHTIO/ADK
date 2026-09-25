import { execa } from 'execa'
import { DateTime } from 'luxon'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeCliAdapter } from '../../../../../src/batteries/llm/claude_code_cli/adapter'
import { E_INVALID_CLAUDE_CODE_CLI_OPTIONS } from '../../../../../src/batteries/llm/claude_code_cli/exceptions'
import { defaultDescriptionToChatCompletionsJsonSchema } from '../../../../../src/batteries/llm/claude_code_cli/helpers'
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
  E_CLAUDE_CODE_CLI_STREAM_ERROR,
  E_CLAUDE_CODE_CLI_STREAM_STALLED,
  E_CLAUDE_CODE_CLI_TURN_FAILED,
  E_CLAUDE_CODE_CLI_CONTEXT_OVERFLOW,
} from '../../../../../src/batteries/llm/claude_code_cli/exceptions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { WrapperEvent } from '../../../../../src/batteries/llm/claude_code_cli/wire'

const dt = (iso: string): DateTime => DateTime.fromISO(iso, { zone: 'utc' })

// ─── real-process fixtures (issue #42 defect #1) ───────────────────────────────
// Mirrors `wrapper.node.spec.ts`'s own convention: the real BUILT wrapper asset, driven by a real
// `execa`, with the `claude` grandchild replaced by the same `fake_claude.mjs` fixture. Needed
// ONLY for the SIGKILL-escalation-reaches-the-grandchild's-process-group test below — every other
// test in this file uses `FakeWrapperChild`, which cannot exercise real OS process-group/signal
// semantics at all (its `kill()` just pushes a string onto an array).
const distDir = join(__dirname, '../../../../../dist')
const wrapperPath = join(distDir, 'claude-code-cli-wrapper.mjs')
const fakeClaudePath = join(__dirname, '../../../../_fixtures/claude_code_cli/fake_claude.mjs')
const distBuilt = existsSync(wrapperPath)

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
  // Mirrors `ExecaLike`'s own `readonly exitCode: number | null` — issue #42 round-2 defect #1's
  // escalation-time "is the wrapper itself still alive" check reads this directly off `child`, so
  // this fake must track it the same way a real execa subprocess/ChildProcess does: `null` until
  // `exit()` below is called, then set to whatever exit code was passed.
  exitCode: number | null = null
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
    this.exitCode = exitCode
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
): {
  execaFn: (...args: unknown[]) => FakeWrapperChild
  calls: unknown[][]
} => {
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

    const wrapperCalls = calls.filter((call) => call[0] === process.execPath)
    expect(wrapperCalls).toHaveLength(1)
    const [cmd, args, options] = wrapperCalls[0] as [string, string[], Record<string, unknown>]
    expect(cmd).toBe(process.execPath)
    expect(args).toEqual(['/fake/wrapper.mjs'])
    expect(options).toMatchObject({ cleanup: true })
    expect(options).not.toHaveProperty('cancelSignal')
  })
})

describe('ClaudeCodeCliAdapter — Electron host spawn decision (issue #42, part C)', () => {
  // `process.versions` itself is non-writable (reassigning the property fails) but its object
  // value is a plain, non-frozen object under Node — mutating `.electron` on it directly (and
  // deleting the key again afterwards) is the seamless way to simulate "running inside Electron"
  // without needing to inject a fake `process` object through the adapter's own constructor
  // surface, which has no such seam today (deliberately: this option-driven design keeps
  // `process.versions.electron` as the single source of truth for a REAL host, and the option
  // fields as the explicit, testable overrides — see `wrapperExecPath`/`wrapperEnv`/
  // `autoDetectElectronHost` in `types.ts`).
  const setElectronVersion = (v: string | undefined): void => {
    if (v === undefined) {
      delete (process.versions as Record<string, string | undefined>).electron
    } else {
      ;(process.versions as Record<string, string | undefined>).electron = v
    }
  }

  it('plain Node host (process.versions.electron undefined): spawn is byte-identical to today — no env key at all', async () => {
    expect(process.versions.electron).toBeUndefined()
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

    const [cmd, , options] = calls[0] as [string, string[], Record<string, unknown>]
    expect(cmd).toBe(process.execPath)
    expect(options).toEqual({ cleanup: true })
    expect(options).not.toHaveProperty('env')
  })

  it('Electron host detected (process.versions.electron set), autoDetectElectronHost left at its default: ELECTRON_RUN_AS_NODE=1 is merged into the spawn env', async () => {
    setElectronVersion('30.0.0')
    try {
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

      const [cmd, , options] = calls[0] as [string, string[], Record<string, unknown>]
      expect(cmd).toBe(process.execPath)
      expect(options).toMatchObject({ cleanup: true, env: { ELECTRON_RUN_AS_NODE: '1' } })
    } finally {
      setElectronVersion(undefined)
    }
  })

  it('Electron host detected but autoDetectElectronHost:false: no ELECTRON_RUN_AS_NODE is added', async () => {
    setElectronVersion('30.0.0')
    try {
      const fake = new FakeWrapperChild()
      const { execaFn, calls } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({ execa: execaFn, autoDetectElectronHost: false })
      )
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

      const [, , options] = calls[0] as [string, string[], Record<string, unknown>]
      expect(options).toEqual({ cleanup: true })
      expect(options).not.toHaveProperty('env')
    } finally {
      setElectronVersion(undefined)
    }
  })

  it('wrapperExecPath overrides the spawned executable (fuse-off Electron mitigation), and wrapperEnv wins over the ELECTRON_RUN_AS_NODE default on a key collision', async () => {
    setElectronVersion('30.0.0')
    try {
      const fake = new FakeWrapperChild()
      const { execaFn, calls } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({
          execa: execaFn,
          wrapperExecPath: '/opt/bundled-node/bin/node',
          wrapperEnv: { ELECTRON_RUN_AS_NODE: undefined, EXTRA_FLAG: 'yes' },
        })
      )
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

      const [cmd, args, options] = calls[0] as [string, string[], Record<string, unknown>]
      expect(cmd).toBe('/opt/bundled-node/bin/node')
      expect(args).toEqual(['/fake/wrapper.mjs'])
      expect(options).toMatchObject({ cleanup: true })
      const env = (options as { env?: Record<string, string | undefined> }).env
      expect(env).toBeDefined()
      expect(env!.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(env!.EXTRA_FLAG).toBe('yes')
      // issue #42 round-2 defect #3: the consumer took ownership of `ELECTRON_RUN_AS_NODE` (opting
      // OUT of it here), so the private strip-marker — which exists ONLY to tell the wrapper "the
      // adapter itself injected this value" — must never appear in the actual spawn env either.
      // Before the fix, the marker was derived from `wantsElectronRunAsNode` alone (true here, since
      // this IS a detected Electron host) and so survived untouched regardless of `wrapperEnv`,
      // meaning the wrapper would still strip the grandchild's own ambient `ELECTRON_RUN_AS_NODE`
      // even though the adapter no longer injected anything — silently defeating this very opt-out.
      expect(env).not.toHaveProperty('ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD')
    } finally {
      setElectronVersion(undefined)
    }
  })

  it('issue #42 round-2 defect #3: consumer overriding ELECTRON_RUN_AS_NODE to the SAME value ("1") still suppresses the strip-marker', async () => {
    setElectronVersion('30.0.0')
    try {
      const fake = new FakeWrapperChild()
      const { execaFn, calls } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({
          execa: execaFn,
          // The consumer explicitly takes ownership of this key, even choosing the identical value
          // the adapter would have injected on its own — the marker must STILL be suppressed,
          // because it certifies "the adapter itself is the one who set this", which is no longer
          // true once the consumer's own `wrapperEnv` is the thing that actually wins the spread.
          wrapperEnv: { ELECTRON_RUN_AS_NODE: '1' },
        })
      )
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

      const [, , options] = calls[0] as [string, string[], Record<string, unknown>]
      const env = (options as { env?: Record<string, string | undefined> }).env
      expect(env).toBeDefined()
      expect(env!.ELECTRON_RUN_AS_NODE).toBe('1')
      expect(env).not.toHaveProperty('ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD')
    } finally {
      setElectronVersion(undefined)
    }
  })

  it('Electron host detected, no wrapperEnv override at all: the strip-marker IS present alongside the adapter-injected ELECTRON_RUN_AS_NODE', async () => {
    setElectronVersion('30.0.0')
    try {
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

      const [, , options] = calls[0] as [string, string[], Record<string, unknown>]
      const env = (options as { env?: Record<string, string | undefined> }).env
      expect(env).toBeDefined()
      expect(env!.ELECTRON_RUN_AS_NODE).toBe('1')
      // Sanity-check the positive case still works: the marker must be present when the adapter
      // truly is the sole source of `ELECTRON_RUN_AS_NODE`, otherwise defect #3's fix would have
      // over-corrected into never setting the marker at all.
      expect(env!.ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD).toBe('1')
    } finally {
      setElectronVersion(undefined)
    }
  })
})

describe('ClaudeCodeCliAdapter — happy path', () => {
  it('completes a full run: ready -> init -> message_delta -> result, storing a Message and settling WITHOUT waiting for the wrapper to actually exit (issue #42, part B)', async () => {
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
    fake.emit({
      type: 'message_delta',
      id: 'msg-1',
      delta: 'Hello there',
      isComplete: true,
    })
    await nextTurn()

    // Terminal `result` observed — as of issue #42's part B, the executor settles PROMPTLY on the
    // terminal NDJSON line alone; it must NOT wait for the wrapper's own OS process exit (`fake`
    // here never calls `.exit(...)` at all in this test, and the promise still settles). Reaping
    // the wrapper is a background concern (`shutdownInBackground()`/`gracefulShutdown()`), entirely
    // decoupled from the executor's own settlement.
    fake.emit({ type: 'result', isError: false, resultText: 'Hello there' })
    await nextTurn()
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

    // Background reaping still happened: a `shutdown` command was written to the (still-alive, in
    // this test) fake wrapper as part of `gracefulShutdown()`.
    expect(fake.writes.some((w) => (JSON.parse(w) as { type: string }).type === 'shutdown')).toBe(
      true
    )
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

  it('treats error_max_turns as normal completion even without result text', async () => {
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
    fake.emit({ type: 'result', isError: true, subtype: 'error_max_turns' })
    fake.exit(0)
    await promise
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._stats).toHaveLength(1)
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
    const results = response!.results as {
      content: Array<{ type: string; text?: string }>
    }
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
    fake.emit({
      type: 'tool_call_request',
      requestId: 'req-x',
      tool: 'ghost_tool',
      args: {},
    })
    await nextTurn()

    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    expect(response).toBeDefined()
    const results = response!.results as {
      content: Array<{ text: string }>
      isError: boolean
    }
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
    fake.emit({
      type: 'tool_call_request',
      requestId: 'req-boom',
      tool: 'boom_tool',
      args: {},
    })
    await nextTurn()

    expect(ctx._stored.toolCalls[0]!.isError).toBe(true)
    const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
    const results = response!.results as {
      content: Array<{ text: string }>
      isError: boolean
    }
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
    const results = response!.results as {
      content: Array<{ type: string; text: string }>
    }
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
    const results = response!.results as {
      content: Array<{ type: string; text: string }>
    }
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
    const results = response!.results as {
      content: Array<{ type: string; text: string }>
    }
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
        baseOptions({
          execa: execaFn,
          streamIdleTimeoutMs: 50,
          disposeGraceMs: 10,
        })
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

  it('a sustained sequence of non-progress "retry"/"log" events does NOT reset the stream-idle timer (issue #39, fix C)', async () => {
    // Reproduces the "also observed" hang from the issue: with a per-chunk unconditional re-arm,
    // a `retry`/`log` event arriving on the SAME stdout stream that carries progress events would
    // reset the idle clock even though no actual model progress occurred, letting a sustained
    // sequence of such events suppress `E_CLAUDE_CODE_CLI_STREAM_STALLED` indefinitely. Each
    // `retry` here arrives well inside `streamIdleTimeoutMs` of the last, mirroring closely-spaced
    // exponential-backoff retries — if the timer were still armed on every chunk (the pre-fix
    // behavior), this stall would never fire within the 10 fake-timer ticks below.
    vi.useFakeTimers()
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({
          execa: execaFn,
          streamIdleTimeoutMs: 50,
          disposeGraceMs: 10,
        })
      )
      const ctx = makeCtx()
      const promise = adapter.executor()(ctx, makeHelpers())
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'init' })
      await vi.advanceTimersByTimeAsync(0)
      // 10 retry/log events, 20ms apart (well under the 50ms streamIdleTimeoutMs), spanning 200ms
      // total — comfortably past the idle threshold IF these events do not reset it.
      for (let i = 0; i < 10; i++) {
        fake.emit({ type: 'retry', attempt: i + 1 })
        await vi.advanceTimersByTimeAsync(10)
        fake.emit({ type: 'log', level: 'warn', kind: 'test-diagnostic', message: 'noise' })
        await vi.advanceTimersByTimeAsync(10)
      }
      await promise
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_STALLED))
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
    // Since issue #42's part B, the executor no longer awaits `Promise.resolve(child)` on this
    // path at all — this test now covers the OTHER order (child exit racing/lagging AFTER the
    // `result` line, rather than before it): the bottom-of-file `Promise.resolve(child).then/.catch`
    // handler firing on this exit must still be a no-op, guarded by `sawTerminalEvent`, and must
    // not double-nack/double-ack a turn that already settled synchronously inside `settleOnce`.
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
    const execaFn = (..._args: unknown[]): typeof rejecting => rejecting
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

  it('issue #42 round-2 defect #1: once grandchild_exited is observed, SIGKILL escalation never signals the (now-stale) grandchild pid', async () => {
    vi.useFakeTimers()
    // A genuine unit-level spy on `process.kill` — NOT a real OS-level kill — proving the adapter
    // itself never even ATTEMPTS the negative-pid call once it has cleared `grandchildPid`. Guard
    // the fake's own implementation so this suite's real teardown (and any other code running
    // concurrently under Node's single-threaded event loop while fake timers are in play) is
    // unaffected: only observe calls, never actually signal anything.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
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
      // Report a grandchild pid, exactly as the wrapper does in a real run...
      fake.emit({ type: 'grandchild_spawned', pid: 54321 })
      await vi.advanceTimersByTimeAsync(0)
      // ...then immediately report it as exited — the adapter must clear its cached pid on this
      // event (see the `grandchild_exited` branch in adapter.ts), BEFORE escalation ever runs.
      fake.emit({ type: 'grandchild_exited' })
      await vi.advanceTimersByTimeAsync(0)

      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.writes.some((w) => (JSON.parse(w) as { type: string }).type === 'shutdown')).toBe(
        true
      )
      // First `disposeGraceMs` wait elapses -> SIGTERM on the wrapper (unrelated to the
      // grandchild-pid question this test is about, but part of the same escalation sequence).
      await vi.advanceTimersByTimeAsync(30)
      expect(fake.kills).toContain('SIGTERM')
      // The wrapper itself never actually exits in this test (mirrors the real "ignores signals"
      // shape without any test-only env hook) — so the second `waitForChildExit` also times out and
      // the adapter proceeds to its SIGKILL escalation branch.
      await vi.advanceTimersByTimeAsync(30)
      expect(fake.kills).toContain('SIGKILL')

      // The actual assertion: no call to the real `process.kill` used a negative pid (the process-
      // group-signalling convention) at all — proving the escalation branch's
      // `typeof grandchildPid === 'number'` guard correctly evaluated false once `grandchildPid`
      // had been cleared by the earlier `grandchild_exited` event, and never even attempted to
      // signal the stale, possibly-reused pgid.
      const negativePidCalls = killSpy.mock.calls.filter(
        (call) => typeof call[0] === 'number' && call[0] < 0
      )
      expect(negativePidCalls).toEqual([])

      fake.exit(0)
      await promise
    } finally {
      killSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('ClaudeCodeCliAdapter — options-merge precedence and validation', () => {
  it('merges constructor -> executor override -> ctx.stash, later layers winning', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: execaFn,
        model: 'ctor-model',
        appendSystemPrompt: 'ctor',
      })
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
    const ctxXor = makeCtx({
      stash: { claudeCodeCli: { authToken: 'also-set' } },
    })
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

describe('ClaudeCodeCliAdapter — context-window pre-flight guard', () => {
  const completeDispatch = async (
    adapter: ClaudeCodeCliAdapter,
    ctx: MockCtx,
    fake: FakeWrapperChild
  ): Promise<void> => {
    const promise = adapter.executor()(ctx, makeHelpers())
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()
    fake.emit({ type: 'result', isError: false })
    fake.exit(0)
    await promise
  }

  it('throws overflow before spawning the wrapper', async () => {
    const fake = new FakeWrapperChild()
    const { execaFn, calls } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: execaFn,
        tokenEncoding: 'cl100k_base',
        contextWindow: 1,
      })
    )
    await expect(
      adapter.executor()(
        makeCtx({
          turnMessages: [
            new Message({
              id: 'overflow',
              role: 'user',
              content: 'x'.repeat(1000),
              createdAt: dt('2026-01-01T00:00:00Z'),
              updatedAt: dt('2026-01-01T00:00:00Z'),
            }),
          ],
        }),
        makeHelpers()
      )
    ).rejects.toThrow(E_CLAUDE_CODE_CLI_CONTEXT_OVERFLOW)
    expect(calls.some(([command]) => command === process.execPath)).toBe(false)
  })

  it.each([undefined, null])(
    'dispatches massive content when tokenEncoding is %s',
    async (tokenEncoding) => {
      const fake = new FakeWrapperChild()
      const { execaFn, calls } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, tokenEncoding }))
      await completeDispatch(
        adapter,
        makeCtx({
          turnMessages: [
            new Message({
              id: 'massive',
              role: 'user',
              content: 'x'.repeat(50_000),
              createdAt: dt('2026-01-01T00:00:00Z'),
              updatedAt: dt('2026-01-01T00:00:00Z'),
            }),
          ],
        }),
        fake
      )
      expect(calls.some(([command]) => command === process.execPath)).toBe(true)
    }
  )

  it('counts appendSystemPrompt in the threshold', async () => {
    const enc = 'cl100k_base' as const
    const prompt = 'rendered prompt'
    const buildPrompt = vi.fn(async () => ({ prompt, reasoningPayloads: [] }))
    const toolBlock = Tokenizable.estimateTokens('{}|', enc)
    const promptBlock = Tokenizable.estimateTokens(prompt, enc)
    const appendValue = 'x'.repeat(1000)
    const contextWindow = promptBlock + toolBlock + 1
    const helperOptions = { buildClaudeCodeCliPrompt: buildPrompt }

    const fittingFake = new FakeWrapperChild()
    const fitting = makeExecaFn(fittingFake)
    const withoutAppend = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: fitting.execaFn,
        tokenEncoding: enc,
        contextWindow,
        helpers: helperOptions,
      })
    )
    await completeDispatch(withoutAppend, makeCtx(), fittingFake)
    expect(fitting.calls.some(([command]) => command === process.execPath)).toBe(true)

    const overflowingFake = new FakeWrapperChild()
    const overflowing = makeExecaFn(overflowingFake)
    const withAppend = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: overflowing.execaFn,
        tokenEncoding: enc,
        contextWindow,
        appendSystemPrompt: appendValue,
        helpers: helperOptions,
      })
    )
    await expect(withAppend.executor()(makeCtx(), makeHelpers())).rejects.toThrow(
      E_CLAUDE_CODE_CLI_CONTEXT_OVERFLOW
    )
    expect(overflowing.calls.some(([command]) => command === process.execPath)).toBe(false)
  })

  it('counts tool declarations in the threshold and does not over-count them', async () => {
    const tool = new Tool({
      name: 'search_docs',
      description: 'A deliberately verbose search tool declaration.',
      inputSchema: validator.object({ query: validator.string().required() }),
      handler: async () => 'ok',
    })
    const tools = new ToolRegistry([tool])
    const described = tool.describe()
    const bridgedTools = [
      {
        name: described.name,
        description: described.description,
        inputSchema: defaultDescriptionToChatCompletionsJsonSchema(described.inputSchema as never),
      },
    ]
    const enc = 'cl100k_base' as const
    const sysAndMsg =
      Tokenizable.estimateTokens('You are a helpful assistant.', enc) +
      Tokenizable.estimateTokens('hi', enc)
    const toolSerialization = `${JSON.stringify(bridgedTools)}|mcp__adk_bridge__search_docs`
    const toolBlock = Tokenizable.estimateTokens(toolSerialization, enc)
    expect(toolBlock).toBeGreaterThan(sysAndMsg)
    const fake = new FakeWrapperChild()
    const { execaFn, calls } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: execaFn,
        tokenEncoding: enc,
        contextWindow: sysAndMsg + Math.floor(toolBlock / 2),
      })
    )
    await expect(
      adapter.executor()(
        makeCtx({
          turnMessages: [
            new Message({
              id: 'tool-overflow',
              role: 'user',
              content: 'hi',
              createdAt: dt('2026-01-01T00:00:00Z'),
              updatedAt: dt('2026-01-01T00:00:00Z'),
            }),
          ],
          tools,
        }),
        makeHelpers()
      )
    ).rejects.toThrow(E_CLAUDE_CODE_CLI_CONTEXT_OVERFLOW)
    expect(calls.some(([command]) => command === process.execPath)).toBe(false)

    const fake2 = new FakeWrapperChild()
    const resolved = makeExecaFn(fake2)
    const fitting = new ClaudeCodeCliAdapter(
      baseOptions({
        execa: resolved.execaFn,
        tokenEncoding: enc,
        contextWindow: sysAndMsg + toolBlock + 256,
      })
    )
    await completeDispatch(
      fitting,
      makeCtx({
        turnMessages: [
          new Message({
            id: 'tool-fitting',
            role: 'user',
            content: 'hi',
            createdAt: dt('2026-01-01T00:00:00Z'),
            updatedAt: dt('2026-01-01T00:00:00Z'),
          }),
        ],
        tools,
      }),
      fake2
    )
    expect(resolved.calls.some(([command]) => command === process.execPath)).toBe(true)
  })
})

describe('ClaudeCodeCliAdapter — tool-call id de-collision across wrapper spawns (issue #39, fix A)', () => {
  it('two dispatch iterations, each a fresh wrapper spawn whose first tool call is requestId "0", get DISTINCT ADK tool-call ids, both complete, and each wrapper still receives its OWN "0" back in tool_call_response', async () => {
    const tool = new Tool({
      name: 'echo_tool',
      description: 'echoes',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (async (args: unknown) => `echoed:${JSON.stringify(args)}`) as never,
    })
    const tools = new ToolRegistry([tool])

    // A single shared `ctx` standing in for the ONE dispatch that spans both iterations — real
    // `DispatchRunner` accumulates completed tool calls into `ctx.turnToolCalls` as a side effect
    // of `storeToolCall` (see `dispatch_runner.ts`'s `#applyMutation`, `op === 'store'` branch on
    // `toolCall`), which is exactly what `deCollideToolCallIds` inspects to decide whether an
    // incoming id already collides — the default `makeCtx()` mock's `storeToolCall` does NOT
    // mutate `turnToolCalls`, so it must be wired here to mirror that real behavior for this test
    // to exercise the actual collision path.
    const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
    const turnToolCalls = new Set<ToolCall>()
    const ctx = makeCtx({ tools })
    ;(ctx as unknown as { storeToolCall: unknown }).storeToolCall = vi.fn(async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
      turnToolCalls.add(tc)
    })
    ;(ctx as unknown as { turnToolCalls: Set<ToolCall> }).turnToolCalls = turnToolCalls
    ctx._stored.toolCalls = stored.toolCalls

    // ── Iteration 1: fresh wrapper spawn #1, first tool call is requestId "0" ──
    const fake1 = new FakeWrapperChild()
    const { execaFn: execaFn1 } = makeExecaFn(fake1)
    const adapter1 = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn1 }))
    const helpers1 = makeHelpers()
    const promise1 = adapter1.executor()(ctx, helpers1)
    await nextTurn()
    fake1.emit({ type: 'ready' })
    await nextTurn()
    fake1.emit({ type: 'init' })
    await nextTurn()
    fake1.emit({
      type: 'tool_call_request',
      requestId: '0',
      tool: 'echo_tool',
      args: { text: 'first' },
    })
    await nextTurn()
    await nextTurn()
    fake1.emit({ type: 'result', isError: false, resultText: 'iter1 done' })
    fake1.exit(0)
    await promise1

    expect(turnToolCalls.size).toBe(1)
    const firstCallId = [...turnToolCalls][0]!.id

    // ── Iteration 2: a BRAND NEW wrapper spawn (mcp_bridge.ts resets its own `nextRequestId` to
    // 0 on every spawn — see `mcp_bridge.ts:88-113`), whose first tool call ALSO arrives as
    // requestId "0", against the SAME `ctx` (so `turnToolCalls` already holds iteration 1's
    // completed call under whatever id it was renamed to).
    const fake2 = new FakeWrapperChild()
    const { execaFn: execaFn2 } = makeExecaFn(fake2)
    const adapter2 = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn2 }))
    const helpers2 = makeHelpers()
    const promise2 = adapter2.executor()(ctx, helpers2)
    await nextTurn()
    fake2.emit({ type: 'ready' })
    await nextTurn()
    fake2.emit({ type: 'init' })
    await nextTurn()
    fake2.emit({
      type: 'tool_call_request',
      requestId: '0',
      tool: 'echo_tool',
      args: { text: 'second' },
    })
    await nextTurn()
    await nextTurn()
    fake2.emit({ type: 'result', isError: false, resultText: 'iter2 done' })
    fake2.exit(0)
    await promise2

    // Both iterations' tool calls were recorded, with DISTINCT ADK ids, and both complete.
    expect(turnToolCalls.size).toBe(2)
    const allCalls = [...turnToolCalls]
    expect(allCalls.every((tc) => tc.isComplete)).toBe(true)
    const ids = allCalls.map((tc) => tc.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain(firstCallId)

    // Both dispatches themselves succeeded (no nack on either helpers/ctx interaction path).
    expect(ctx.nack).not.toHaveBeenCalled()

    // Each wrapper's own `tool_call_response` still carries ITS wrapper-local requestId "0" —
    // the id rename must never leak into the wire round-trip back to the bridge, since the
    // bridge correlates responses by its OWN `pending` map key, not the ADK-facing id.
    const response1 = parsedWrites(fake1).find((w) => w.type === 'tool_call_response')
    const response2 = parsedWrites(fake2).find((w) => w.type === 'tool_call_response')
    expect(response1).toBeDefined()
    expect(response2).toBeDefined()
    expect(response1!.requestId).toBe('0')
    expect(response2!.requestId).toBe('0')
  })
})

describe('ClaudeCodeCliAdapter — no handler error escapes as an unhandled rejection (issue #39, fix B)', () => {
  it('an error thrown while handling a wrapper event is caught, never becomes an unhandled promise rejection, and settles the dispatch via nack with E_CLAUDE_CODE_CLI_STREAM_ERROR', async () => {
    // Install the spy BEFORE anything runs, and remove it in `finally` regardless of outcome —
    // this is a real Node-level global listener, not a mock scoped to this test.
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const tool = new Tool({
        name: 'boom_tool',
        description: 'a tool whose call is never reached — reportToolCall itself throws first',
        inputSchema: validator.object({}).unknown(true),
        handler: (async () => 'unreachable') as never,
      })
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
      const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
      const helpers = makeHelpers()
      // Reproduces the class of bug in the issue: a handler invoked synchronously from inside
      // `onEvent`'s `tool_call_request` branch (here, `helpers.reportToolCall`, called at the top
      // of `handleToolCallRequest` before any tool execution) throws instead of returning
      // normally — previously this propagated out of the `child.stdout.on('data', ...)` listener's
      // bare `void onEvent(event)` with no attached `.catch`, becoming an unhandled promise
      // rejection that crashes the host process by Node's default (>= 15).
      ;(helpers as unknown as { reportToolCall: unknown }).reportToolCall = vi.fn(() => {
        throw new Error('reportToolCall exploded')
      })
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emit({
        type: 'tool_call_request',
        requestId: '0',
        tool: 'boom_tool',
        args: {},
      })
      await nextTurn()
      await nextTurn()
      // The executor must still resolve (settle the dispatch), not hang or reject.
      await promise

      // No unhandled rejection occurred anywhere during this run.
      expect(unhandledRejections).toEqual([])

      // The dispatch settled via nack, carrying the chosen typed exception with the original
      // error preserved as `.cause`.
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_ERROR))
      const nackedError = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![0] as InstanceType<typeof E_CLAUDE_CODE_CLI_STREAM_ERROR>
      expect(nackedError.message).toContain('reportToolCall exploded')
      expect((nackedError.cause as Error).message).toBe('reportToolCall exploded')

      // The wrapper was told to shut down (gracefulShutdown ran as part of settlement).
      expect(fake.writes.some((w) => (JSON.parse(w) as { type: string }).type === 'shutdown')).toBe(
        true
      )

      // A LATER event arriving after settlement must not throw again or double-nack.
      fake.emit({ type: 'result', isError: false, resultText: 'too late' })
      await nextTurn()
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  // A thrown value that defeats BOTH `JSON.stringify` and `String` — a `Proxy` whose every trap
  // throws. Normalising it into an `Error` inside the last-line-of-defence handlers must not itself
  // throw, or it recreates the very unhandled-rejection / uncaught-exception it guards against.
  const makeUnserialisableThrowable = (): unknown =>
    new Proxy(
      {},
      {
        get() {
          throw new Error('hostile get trap')
        },
        getPrototypeOf() {
          throw new Error('hostile getPrototypeOf trap')
        },
      }
    )

  it('an unserialisable value thrown from an async event handler is still caught and nacked, never an unhandled rejection', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const tool = new Tool({
        name: 'boom_tool',
        description: 'a tool whose call is never reached — reportToolCall itself throws first',
        inputSchema: validator.object({}).unknown(true),
        handler: (async () => 'unreachable') as never,
      })
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
      const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
      const helpers = makeHelpers()
      // A PLAIN function, deliberately NOT `vi.fn`: vitest's mock wrapper does not rethrow a
      // thrown Proxy by identity (the caught value no longer defeats JSON.stringify), which would
      // make this test pass against the old, unguarded normaliser and prove nothing.
      ;(helpers as unknown as { reportToolCall: unknown }).reportToolCall = (): never => {
        throw makeUnserialisableThrowable()
      }
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emit({ type: 'tool_call_request', requestId: '0', tool: 'boom_tool', args: {} })
      await nextTurn()
      await nextTurn()
      await promise
      await nextTurn()

      expect(unhandledRejections).toEqual([])
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_ERROR))
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('an unserialisable value thrown synchronously from the stdout line reader is caught and nacked, never an uncaught exception', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
      const ctx = makeCtx()
      const helpers = makeHelpers()
      // The malformed-line path logs at trace from inside `eventReader.push` — synchronously,
      // inside the stdout 'data' listener.
      // A PLAIN function, not `vi.fn` — see the note in the async-handler test above.
      ;(helpers.log as unknown as { trace: unknown }).trace = (): never => {
        throw makeUnserialisableThrowable()
      }
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emitRaw('this line is not json')
      await nextTurn()
      await nextTurn()
      await promise
      await nextTurn()

      expect(uncaught).toEqual([])
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_ERROR))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
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

// A bounded "did this hang" guard: races the executor's own promise against a short real-time
// timeout. Per project doctrine (no pathological MAX_ITERATIONS/timeout-bail patterns), this is
// used ONLY to make a genuine hang FAIL the assertion below (`timedOut` inspected explicitly), not
// to silently treat a slow-but-real completion as success — it is not a substitute for asserting
// on the executor's actual outcome, which every test below still does after the race.
const raceAgainstHang = async (
  promise: void | Promise<void>,
  hangTimeoutMs = 2000
): Promise<boolean> => {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, hangTimeoutMs)
  })
  try {
    await Promise.race([Promise.resolve(promise), timeout])
    return timedOut
  } finally {
    // A fast, successful `promise` otherwise leaves this timer pending for the full
    // `hangTimeoutMs` (a real, un-refed-by-default Node timer) — harmless individually, but this
    // helper is called from several tests in this file, and vitest does not tear down pending
    // real timers between tests, so it leaks one per call. Clearing it here does not change
    // `timedOut`'s value (already captured) or the resolved race outcome.
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('ClaudeCodeCliAdapter — a settlement handler throwing does not hang the executor (issue #39 AI-review defect #1)', () => {
  it('reportGenerationStats throwing on the terminal result event still resolves the executor (bounded wait), nacks once, and never becomes an unhandled rejection', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
      const ctx = makeCtx()
      const helpers = makeHelpers()
      // Reproduces AI-review defect #1: `settleOnce`'s callback in the `result` branch calls
      // `helpers.reportGenerationStats(...)` before `ctx.ack()`; on the pre-fix code, a throw here
      // propagates out of `settleOnce` itself AFTER `settled` was already flipped true, so the
      // Fix-B `onEvent(...).catch(...)` handler's own `settleOnce(...)` call is a silent no-op
      // (the `if (settled) return` guard) and `resolveIteration`/`finish` is never called — the
      // executor hangs forever, never resolving and never nacking.
      ;(helpers as unknown as { reportGenerationStats: unknown }).reportGenerationStats = vi.fn(
        () => {
          throw new Error('reportGenerationStats exploded')
        }
      )
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emit({ type: 'result', isError: false, resultText: 'done' })
      fake.exit(0)

      const timedOut = await raceAgainstHang(promise)
      expect(timedOut).toBe(false)

      expect(unhandledRejections).toEqual([])
      // Nacked exactly once via the guaranteed-resolution path, never double-signalled.
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_ERROR))
      const nackedError = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![0] as InstanceType<typeof E_CLAUDE_CODE_CLI_STREAM_ERROR>
      expect(nackedError.message).toContain('reportGenerationStats exploded')
      // `ctx.ack()` sits AFTER `reportGenerationStats(...)` in the same callback — it must never
      // have been reached.
      expect(ctx.ack).not.toHaveBeenCalled()

      // A later event must not throw again or double-nack.
      fake.emit({ type: 'result', isError: false, resultText: 'too late' })
      await nextTurn()
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('ctx.ack() itself throwing (already signalled by a lost race) is still caught and resolves the executor', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
      const ctx = makeCtx()
      // On the REAL DispatchContext, `ack()`/`nack()` only throw `E_LLM_EXECUTION_ALREADY_SIGNALLED`
      // when `#signalled` is ALREADY set — i.e. `ctx.isSignalled` is already `true` at the moment of
      // the throw (see `dispatch_context.ts`: both guards check `#signalled !== undefined` and throw
      // BEFORE assigning anything new). A faithful mock of "ctx.ack() throws because a concurrent
      // caller already signalled" must reflect that same invariant, or this test would validate the
      // fix's `!ctx.isSignalled` guard against a race shape the real object could never produce.
      ;(ctx as unknown as { ack: unknown }).ack = vi.fn(() => {
        throw new Error('E_LLM_EXECUTION_ALREADY_SIGNALLED (simulated race)')
      })
      Object.defineProperty(ctx, 'isSignalled', { get: () => true, configurable: true })
      const helpers = makeHelpers()
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emit({ type: 'result', isError: false, resultText: 'done' })
      fake.exit(0)

      const timedOut = await raceAgainstHang(promise)
      expect(timedOut).toBe(false)
      expect(unhandledRejections).toEqual([])
      // reportGenerationStats already ran successfully before ctx.ack() threw.
      expect(helpers._stats).toHaveLength(1)
      // ctx.ack() itself threw as-if-already-signalled — the guard must not call ctx.nack() on top
      // of an already-signalled context (no double-signal attempt).
      expect(ctx.nack).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

describe('ClaudeCodeCliAdapter — the stream-idle timer is suspended during ADK tool execution (issue #39 AI-review defect #2)', () => {
  it('a tool executor that outlives streamIdleTimeoutMs does not get falsely nacked STREAM_STALLED, and completes; genuine silence AFTER it finishes still trips STREAM_STALLED', async () => {
    vi.useFakeTimers()
    try {
      let resolveTool: (() => void) | undefined
      const tool = new Tool({
        name: 'slow_tool',
        description: 'a tool whose executor outlives streamIdleTimeoutMs',
        inputSchema: validator.object({}).unknown(true),
        handler: (async () => {
          await new Promise<void>((resolve) => {
            resolveTool = resolve
          })
          return 'slow result'
        }) as never,
      })
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({ execa: execaFn, streamIdleTimeoutMs: 50, disposeGraceMs: 10 })
      )
      const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
      const helpers = makeHelpers()
      const promise = adapter.executor()(ctx, helpers)
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'init' })
      await vi.advanceTimersByTimeAsync(0)
      fake.emit({ type: 'tool_call_request', requestId: '0', tool: 'slow_tool', args: {} })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      // Advance well past streamIdleTimeoutMs while the tool executor is STILL pending and no
      // wrapper stdout has arrived — this must not falsely stall the dispatch.
      await vi.advanceTimersByTimeAsync(500)
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(resolveTool).toBeDefined()

      // Now let the tool finish; the round trip completes and the idle timer resumes.
      resolveTool?.()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(ctx.nack).not.toHaveBeenCalled()
      const response = parsedWrites(fake).find((w) => w.type === 'tool_call_response')
      expect(response).toBeDefined()

      // Genuine silence AFTER the tool answered must still trip the stall timeout.
      await vi.advanceTimersByTimeAsync(200)
      await promise
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_STALLED))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ClaudeCodeCliAdapter — a synchronous throw while logging a malformed line does not escape or hang the executor (issue #39 AI-review defect #3)', () => {
  it('helpers.log.trace throwing on a malformed NDJSON line is caught and settles the dispatch via nack, not an unhandled/uncaught error', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn }))
      const ctx = makeCtx()
      const helpers = makeHelpers()
      // Reproduces AI-review defect #3: the `JSON.parse`-failure callback runs synchronously
      // inside `createNdjsonLineReader`'s `onLine`, which is itself called synchronously from
      // `eventReader.push(chunk)` — a throw here (previously unguarded) escapes directly from the
      // `child.stdout.on('data', ...)` listener, bypassing the Fix-B `onEvent(...).catch(...)`
      // chain entirely, since it never even reaches `onEvent`.
      ;(helpers.log as unknown as { trace: unknown }).trace = vi.fn(() => {
        throw new Error('log.trace exploded')
      })
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      // Malformed NDJSON — triggers the JSON.parse catch block's helpers.log.trace(...) call.
      fake.emitRaw('{not valid json')

      const timedOut = await raceAgainstHang(promise)
      expect(timedOut).toBe(false)

      expect(unhandledRejections).toEqual([])
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_ERROR))
      const nackedError = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![0] as InstanceType<typeof E_CLAUDE_CODE_CLI_STREAM_ERROR>
      expect(nackedError.message).toContain('log.trace exploded')
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

describe('ClaudeCodeCliAdapter — settleOnce guarantees resolution even when its OWN failure-path steps throw (issue #39 AI-review round 2, defect #1)', () => {
  it('helpers.log.error itself throwing while handling a settlement-callback failure still resolves the executor, nacks exactly once, and produces neither an unhandled rejection nor an uncaught exception', async () => {
    const unhandledRejections: unknown[] = []
    const uncaughtExceptions: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    const onUncaughtException = (err: unknown): void => {
      uncaughtExceptions.push(err)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    process.on('uncaughtException', onUncaughtException)
    try {
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
      const ctx = makeCtx()
      const helpers = makeHelpers()
      // Reproduces round-2 defect #1: on af7d0b4, `settleOnce`'s catch block called
      // `helpers.log.error(...)` (itself capable of throwing) BEFORE `resolveIteration?.()`. If the
      // logger throws, resolution never runs even though `settled` is already `true` — every LATER
      // `settleOnce` call anywhere in the file becomes a silent no-op (its own `if (settled) return`
      // guard fires first), hanging the executor forever, and the throw itself escapes whichever
      // caller invoked `settleOnce` (here, an async `onEvent(...).catch(...)` handler, becoming an
      // unhandled rejection; the stdout `'data'` listener's own catch site — a synchronous caller —
      // would instead surface it as an uncaught exception, which is why both are spied on here).
      ;(helpers as unknown as { reportGenerationStats: unknown }).reportGenerationStats = vi.fn(
        () => {
          throw new Error('reportGenerationStats exploded')
        }
      )
      ;(helpers.log as unknown as { error: unknown }).error = vi.fn(() => {
        throw new Error('log.error exploded too')
      })
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emit({ type: 'result', isError: false, resultText: 'done' })
      fake.exit(0)

      const timedOut = await raceAgainstHang(promise)
      expect(timedOut).toBe(false)

      expect(unhandledRejections).toEqual([])
      expect(uncaughtExceptions).toEqual([])
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_CLAUDE_CODE_CLI_STREAM_ERROR))
      const nackedError = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]![0] as InstanceType<typeof E_CLAUDE_CODE_CLI_STREAM_ERROR>
      expect(nackedError.message).toContain('reportGenerationStats exploded')
      expect(ctx.ack).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      process.off('uncaughtException', onUncaughtException)
    }
  })
})

describe('ClaudeCodeCliAdapter — fire-and-forget gracefulShutdown() never becomes an unhandled rejection (issue #39 AI-review round 2, defect #2)', () => {
  it('the wrapper/child promise rejecting while an abort-triggered shutdown awaits it does not produce an unhandled rejection', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const stdout = new EventEmitter()
      const kills: Array<string | undefined> = []
      let rejectChild!: (err: unknown) => void
      // A thenable shaped like execa's own return value, mirroring the existing "a rejected
      // wrapper promise" fixture above, but with the rejection deferred under our control instead
      // of firing immediately — so the test can drive the wrapper through `ready`/`init`, trigger
      // an ABORT (which starts `gracefulShutdown()` racing this same child promise internally via
      // `Promise.resolve(child).finally(...)`), and only THEN reject it, landing squarely inside
      // that in-flight internal await.
      const childPromise = new Promise<never>((_resolve, reject) => {
        rejectChild = reject
      })
      // Every OTHER holder of this same underlying rejection (the adapter's own bottom-of-file
      // `void Promise.resolve(child).then(...).catch(...)`, and `gracefulShutdown`'s internal
      // chain) attaches its own handler independently — each `Promise.resolve(child)` call adopts
      // the thenable's state into a genuinely separate promise object. This fixture-level `.catch`
      // exists only so the raw `childPromise` variable itself is never flagged, and does not
      // substitute for either of the adapter's own handlers being correct.
      childPromise.catch(() => undefined)
      const child = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout,
        kill: (signal?: string): boolean => {
          kills.push(signal)
          return true
        },
        then: (
          onFulfilled: (v: unknown) => unknown,
          onRejected: (e: unknown) => unknown
        ): Promise<unknown> => childPromise.then(onFulfilled, onRejected),
        catch: (onRejected: (e: unknown) => unknown): Promise<unknown> =>
          childPromise.catch(onRejected),
      }
      const execaFn = (..._args: unknown[]): typeof child => child
      ;(execaFn as unknown as { exec: unknown }).exec = true
      const controller = new AbortController()
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({ execa: execaFn as never, disposeGraceMs: 20 })
      )
      const ctx = makeCtx({ abortSignal: controller.signal })
      const helpers = makeHelpers()
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      stdout.emit('data', new TextEncoder().encode(`${JSON.stringify({ type: 'ready' })}\n`))
      await nextTurn()
      stdout.emit('data', new TextEncoder().encode(`${JSON.stringify({ type: 'init' })}\n`))
      await nextTurn()

      controller.abort()
      await nextTurn()
      // Reject the child promise while `gracefulShutdown()`'s internal
      // `Promise.resolve(child).finally(...)` chain (started by the abort listener above) is
      // still in flight racing `disposeGraceMs` — this is the exact unguarded chain AI-review
      // round 2 named.
      rejectChild(new Error('wrapper process rejected during abort-triggered shutdown'))

      const timedOut = await raceAgainstHang(promise, 1000)
      expect(timedOut).toBe(false)
      // Node's `unhandledRejection` detection fires on a LATER turn of the event loop than the
      // microtask that settles `promise` itself (it waits to see whether a `.catch` is attached
      // "eventually", not merely "not yet") — `nextTurn()`'s real 10ms `setTimeout` gives that
      // detection a full turn to fire before the listener below is torn down and the assertion is
      // made, so a genuine leak here is not silently missed by unsubscribing too early.
      await nextTurn()
      expect(unhandledRejections).toEqual([])
      // The adapter's own bottom-of-file wrapper-process handler observes the same rejection and
      // settles the turn as a crash — this test's focus is solely that NEITHER path leaks an
      // unhandled rejection, not the specific exception nacked.
      expect(ctx.nack).toHaveBeenCalledTimes(1)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

describe('ClaudeCodeCliAdapter — a wrapper that never exits after result does not block settlement (issue #42, part B)', () => {
  it('child never exits after the terminal result: dispatch still settles promptly, background reaping is attempted, and no unhandled rejection occurs', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      // `FakeWrapperChild.exit(...)` is DELIBERATELY never called anywhere in this test — the
      // underlying execa-shaped thenable never settles, modelling a wrapper whose own OS process
      // hangs (a stuck MCP bridge teardown, a slow grandchild, or simply a wrapper that never
      // observed its own `shutdown_complete` write finish) well past the terminal `result` line.
      // Pre-fix, the `result` branch's own `await Promise.resolve(child)` would have hung the
      // executor's iteration promise right alongside it, forever. Post-fix, `finish()` runs
      // synchronously inside `settleOnce`'s callback and does not depend on the child ever
      // resolving at all.
      const fake = new FakeWrapperChild()
      const { execaFn } = makeExecaFn(fake)
      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({ execa: execaFn, autoAck: true, disposeGraceMs: 20 })
      )
      const ctx = makeCtx()
      const helpers = makeHelpers()
      const promise = adapter.executor()(ctx, helpers)
      await nextTurn()
      fake.emit({ type: 'ready' })
      await nextTurn()
      fake.emit({ type: 'init' })
      await nextTurn()
      fake.emit({ type: 'result', isError: false, resultText: 'done' })

      // The executor promise must settle within `raceAgainstHang`'s bounded wait EVEN THOUGH the
      // fake child's own thenable is left permanently pending — proving settlement no longer has
      // any dependency on the wrapper's OS exit.
      const timedOut = await raceAgainstHang(promise)
      expect(timedOut).toBe(false)
      expect(unhandledRejections).toEqual([])

      expect(ctx.ack).toHaveBeenCalledTimes(1)
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(helpers._stats).toHaveLength(1)

      // Background reaping was still attempted: `gracefulShutdown()` writes a `shutdown` command
      // to the (still "alive", in this test) fake wrapper regardless of whether it ever actually
      // exits — the executor's own settlement above did not wait on this, but the attempt itself
      // must still happen (a silently-skipped reap would leak the wrapper process in a real host).
      expect(fake.writes.some((w) => (JSON.parse(w) as { type: string }).type === 'shutdown')).toBe(
        true
      )

      // `gracefulShutdown()`'s own internal `waitForChildExit(disposeGraceMs)` bounded waits (used
      // twice: once before SIGTERM, once before SIGKILL) are real timers racing a promise that
      // never resolves — give them their own full `2 * disposeGraceMs` plus slack to run to
      // completion in the background before asserting the SIGTERM/SIGKILL escalation, so this
      // assertion cannot pass merely because the background work hasn't reached that point yet.
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(fake.kills).toContain('SIGTERM')
      expect(fake.kills).toContain('SIGKILL')
      // No unhandled rejection surfaced from the backgrounded `gracefulShutdown()` promise chain
      // even though the child it raced against never actually settled.
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

describe.skipIf(!distBuilt)(
  'ClaudeCodeCliAdapter — SIGKILL escalation reaches the grandchild process group (issue #42 defect #1)',
  () => {
    // Real OS processes throughout, deliberately NOT `FakeWrapperChild`: `FakeWrapperChild.kill()`
    // only pushes a signal name onto an array, so it can prove the adapter CALLS `child.kill(...)`
    // but can never prove the OS-level consequence defect #1 is actually about — that a SIGKILL to
    // the wrapper, which cannot be caught or handled, still results in the `claude` grandchild's
    // entire detached process group actually dying. Only a real subprocess tree can prove that.
    it('after SIGTERM-then-SIGKILL escalation, BOTH the wrapper and its detached grandchild are gone', async () => {
      // issue #42 round-2 defect #2: this test used to force the escalation path with a test-only
      // env hook (`ADK_CLAUDE_CODE_CLI_TEST_IGNORE_SIGNALS`) that shipped inside the PUBLISHED
      // wrapper source purely to serve this one test. Real `SIGSTOP` achieves the identical
      // observable effect — a process that cannot act on its own `shutdown` command NOR SIGTERM —
      // without adding any test-only branch to production code: `SIGSTOP` suspends the wrapper at
      // the OS level (uncatchable, unblockable, delivered instantly regardless of what the process
      // is doing), so it can neither read the `shutdown` command off stdin nor run its own SIGTERM
      // handler. The adapter's own escalation is FORCED all the way to its SIGKILL branch exactly
      // as before — SIGKILL (unlike SIGTERM) is delivered to a stopped process too. `SIGCONT` is
      // sent in the `finally` block below purely as a safety net in case an assertion throws before
      // the SIGKILL is ever sent, so a failed run never leaves a real frozen process behind.
      let wrapperStopped = false

      // Wraps the REAL `execa` import (not a fake) so `resolveExeca`'s own heuristic treats it as
      // the already-resolved spawn function (see `makeExecaFn`'s doc comment above) while still
      // letting this test capture the real execa-returned child handle — specifically its `.pid` —
      // the instant it's spawned, for the post-escalation liveness poll below.
      let wrapperChild: ReturnType<typeof execa> | undefined
      const realExecaFn = (
        cmd: string,
        args: readonly string[],
        options: Record<string, unknown>
      ): ReturnType<typeof execa> => {
        const child = execa(cmd, args, { ...options, reject: false } as unknown as Parameters<
          typeof execa
        >[1])
        wrapperChild = child
        return child
      }
      ;(realExecaFn as unknown as { exec: unknown }).exec = true

      const adapter = new ClaudeCodeCliAdapter(
        baseOptions({
          execa: realExecaFn,
          wrapperPath,
          claudeBin: fakeClaudePath,
          disposeGraceMs: 200,
        })
      )
      const abortController = new AbortController()
      const ctx = makeCtx({ abortSignal: abortController.signal })
      const helpers = makeHelpers()

      // `FAKE_CLAUDE_HANG` makes the grandchild a real long-lived detached process that never
      // exits on its own — exactly the shape defect #1 is about: something has to actually kill
      // it, since nothing else ever will. `FAKE_CLAUDE_LINES` must still emit a `system/init` line
      // (the wrapper's own `init` event depends on it) — the fixture only ever emits lines it is
      // explicitly told to via env, matching every other convention in this file/`wrapper.node.
      // spec.ts`.
      const previousHang = process.env.FAKE_CLAUDE_HANG
      const previousArgvLog = process.env.FAKE_CLAUDE_ARGV_LOG
      const previousLines = process.env.FAKE_CLAUDE_LINES
      process.env.FAKE_CLAUDE_HANG = '1'
      process.env.FAKE_CLAUDE_LINES = JSON.stringify([
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [] },
      ])
      delete process.env.FAKE_CLAUDE_ARGV_LOG
      let grandchildPid: number | undefined
      try {
        const promise = adapter.executor()(ctx, helpers)

        // Drive the real wrapper through ready -> (grandchild_spawned) -> init by polling its own
        // emitted NDJSON events, mirroring `WrapperHarness#waitFor` in `wrapper.node.spec.ts` but
        // reading off the real `child.stdout` this test captured above (the adapter has already
        // attached its OWN listener to the same stream; Node's stream 'data' event supports
        // multiple listeners, so this does not interfere with the adapter's own parsing).
        const events: Array<Record<string, unknown>> = []
        let buffer = ''
        await vi.waitUntil(() => wrapperChild !== undefined, { timeout: 5_000, interval: 10 })
        wrapperChild!.stdout?.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8')
          let idx = buffer.indexOf('\n')
          while (idx !== -1) {
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            idx = buffer.indexOf('\n')
            if (line.trim().length === 0) continue
            try {
              events.push(JSON.parse(line) as Record<string, unknown>)
            } catch {
              /* ignore malformed/partial lines for this test's own polling purposes */
            }
          }
        })

        await vi.waitUntil(() => events.some((e) => e.type === 'grandchild_spawned'), {
          timeout: 8_000,
          interval: 20,
        })
        const spawnedEvent = events.find((e) => e.type === 'grandchild_spawned')!
        grandchildPid = spawnedEvent.pid as number
        expect(typeof grandchildPid).toBe('number')

        await vi.waitUntil(() => events.some((e) => e.type === 'init'), {
          timeout: 8_000,
          interval: 20,
        })

        const wrapperPid = wrapperChild!.pid
        expect(typeof wrapperPid).toBe('number')

        // Confirm both processes are genuinely alive before triggering teardown — `process.kill(
        // pid, 0)` is the standard POSIX "is this pid alive?" probe: it throws ESRCH if not, and
        // does nothing (no actual signal delivered) otherwise.
        expect(() => process.kill(wrapperPid!, 0)).not.toThrow()
        expect(() => process.kill(grandchildPid!, 0)).not.toThrow()

        // issue #42 round-2 defect #2: SIGSTOP suspends the real wrapper process at the OS level —
        // uncatchable and unblockable — so it can neither read the `shutdown` command off its own
        // stdin nor act on the SIGTERM the adapter sends next. This forces the exact same escalation
        // path the removed `ADK_CLAUDE_CODE_CLI_TEST_IGNORE_SIGNALS` hook used to force, without any
        // test-only branch in production code.
        process.kill(wrapperPid!, 'SIGSTOP')
        wrapperStopped = true

        // Trigger the adapter's `gracefulShutdown()` via abort — it writes `shutdown` (never read,
        // the wrapper is stopped), waits `disposeGraceMs`, sends SIGTERM (delivered but not acted on
        // while stopped), waits `disposeGraceMs` again, then escalates to SIGKILL on the wrapper AND
        // (defect #1's fix) `process.kill(-grandchildPid, 'SIGKILL')` on the grandchild's process
        // group directly. SIGKILL, unlike SIGTERM, IS delivered to a stopped process — the OS never
        // gives the target a chance to ignore it.
        abortController.abort()

        // Total worst-case background teardown time is `2 * disposeGraceMs` (see the long comment
        // at `gracefulShutdown`'s own call sites) — wait comfortably past that before polling.
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 + 500))

        let wrapperGone = false
        try {
          process.kill(wrapperPid!, 0)
        } catch (err) {
          wrapperGone = (err as NodeJS.ErrnoException).code === 'ESRCH'
        }
        expect(wrapperGone).toBe(true)

        let grandchildGone = false
        try {
          process.kill(grandchildPid!, 0)
        } catch (err) {
          grandchildGone = (err as NodeJS.ErrnoException).code === 'ESRCH'
        }
        expect(grandchildGone).toBe(true)

        // The executor's own settlement never depends on any of this background teardown (issue
        // #42 part B) — but drain it anyway so this test doesn't leave a dangling promise behind.
        await raceAgainstHang(promise, 2_000)
      } finally {
        if (previousHang === undefined) delete process.env.FAKE_CLAUDE_HANG
        else process.env.FAKE_CLAUDE_HANG = previousHang
        if (previousArgvLog === undefined) delete process.env.FAKE_CLAUDE_ARGV_LOG
        else process.env.FAKE_CLAUDE_ARGV_LOG = previousArgvLog
        if (previousLines === undefined) delete process.env.FAKE_CLAUDE_LINES
        else process.env.FAKE_CLAUDE_LINES = previousLines
        // Belt-and-suspenders: if the assertions above failed (e.g. proving this test RED against
        // a reverted fix), make sure this test never actually leaks a real hung process into the
        // rest of the suite regardless of outcome. SIGCONT first: a SIGSTOPped process can still
        // legitimately receive and act on SIGKILL (the OS never lets a stopped process ignore it),
        // but resuming it here removes any doubt and guards against ever leaving a frozen zombie
        // process behind if some earlier assertion threw before the real SIGKILL escalation ran.
        if (wrapperStopped && wrapperChild !== undefined && typeof wrapperChild.pid === 'number') {
          try {
            process.kill(wrapperChild.pid, 'SIGCONT')
          } catch {
            /* already gone */
          }
        }
        if (typeof grandchildPid === 'number') {
          try {
            process.kill(-grandchildPid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
        if (wrapperChild !== undefined && typeof wrapperChild.pid === 'number') {
          try {
            wrapperChild.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    }, 20_000)
  }
)

// ─── issue #43: message/thought id collision across wrapper spawns + within one spawn ──────────

/**
 * A `reportMessage`/`reportThought`-shaped pair that faithfully mirrors core's own
 * `buildStream`/`messageStreams`/`thoughtStreams` guard (`dispatch_runner.ts`'s `#buildHelpers`):
 * a `Map` keyed by id, throwing `stream "${id}" is already complete; further chunks are not
 * accepted` on any chunk (even a first, immediately-complete one) for an id already marked
 * complete. The default `makeHelpers()` mock's bare `vi.fn()`s accept ANY id any number of times,
 * so a test built on it could never actually observe the collision this suite targets — this is
 * the piece that makes these tests capable of failing on unfixed code.
 */
const makeStreamGuardedHelpers = (): DispatchExecutorHelpers & {
  _stats: Array<Record<string, unknown>>
  _messageCalls: Array<{ id: string; delta: string; isComplete: boolean }>
  _thoughtCalls: Array<{ id: string; delta: string; isComplete: boolean }>
} => {
  const stats: Array<Record<string, unknown>> = []
  const messageCalls: Array<{ id: string; delta: string; isComplete: boolean }> = []
  const thoughtCalls: Array<{ id: string; delta: string; isComplete: boolean }> = []
  const noop = vi.fn()
  const makeGuardedReporter =
    (calls: Array<{ id: string; delta: string; isComplete: boolean }>) =>
    (id: string, delta: string, opts?: { isComplete?: boolean }): void => {
      const isComplete = opts?.isComplete ?? false
      const already = calls.find((c) => c.id === id && c.isComplete)
      if (already !== undefined) {
        throw new Error(`stream "${id}" is already complete; further chunks are not accepted`)
      }
      calls.push({ id, delta, isComplete })
    }
  return {
    reportMessage: vi.fn(makeGuardedReporter(messageCalls)),
    reportThought: vi.fn(makeGuardedReporter(thoughtCalls)),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => {
      stats.push(s)
    }),
    _stats: stats,
    _messageCalls: messageCalls,
    _thoughtCalls: thoughtCalls,
  } as unknown as DispatchExecutorHelpers & {
    _stats: typeof stats
    _messageCalls: typeof messageCalls
    _thoughtCalls: typeof thoughtCalls
  }
}

describe('ClaudeCodeCliAdapter — message id de-collision across wrapper spawns (issue #43, fix A)', () => {
  it('two dispatch iterations, each a fresh wrapper spawn whose assistant text streams under the wrapper id "message-0", get DISTINCT ADK message ids, both complete, and both are stored as distinct Messages', async () => {
    // A single shared `ctx` standing in for the ONE dispatch that spans both iterations — mirrors
    // the #39 fix-A tool-call-id test's own `ctx` sharing rationale: `helpers`/`messageStreams` are
    // constructed once per dispatch in the real runner, so this is what actually exercises the
    // cross-iteration collision path (a fresh `makeCtx()`/`makeHelpers()` per iteration would not).
    const ctx = makeCtx()

    // ── Iteration 1: fresh wrapper spawn #1 ──
    const fake1 = new FakeWrapperChild()
    const { execaFn: execaFn1 } = makeExecaFn(fake1)
    const adapter1 = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn1, autoAck: true }))
    const helpers = makeStreamGuardedHelpers()
    const promise1 = adapter1.executor()(ctx, helpers)
    await nextTurn()
    fake1.emit({ type: 'ready' })
    await nextTurn()
    fake1.emit({ type: 'init' })
    await nextTurn()
    // The wrapper's own collision-prone id (pre-fix, always the literal "message"; post-fix,
    // "message-0" for the first message of this spawn).
    fake1.emit({
      type: 'message_delta',
      id: 'message-0',
      delta: 'iteration one reply',
      isComplete: true,
    })
    await nextTurn()
    fake1.emit({ type: 'result', isError: false, resultText: 'iteration one reply' })
    fake1.exit(0)
    await promise1

    // ── Iteration 2: a BRAND NEW wrapper spawn against the SAME `ctx`/`helpers`, whose first
    // (and only) message ALSO arrives under the wrapper-local id "message-0" — every spawn resets
    // its own per-spawn counter, exactly like issue #39's tool-call `requestId`.
    const fake2 = new FakeWrapperChild()
    const { execaFn: execaFn2 } = makeExecaFn(fake2)
    const adapter2 = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn2, autoAck: true }))
    const promise2 = adapter2.executor()(ctx, helpers)
    await nextTurn()
    fake2.emit({ type: 'ready' })
    await nextTurn()
    fake2.emit({ type: 'init' })
    await nextTurn()
    fake2.emit({
      type: 'message_delta',
      id: 'message-0',
      delta: 'iteration two reply',
      isComplete: true,
    })
    await nextTurn()
    fake2.emit({ type: 'result', isError: false, resultText: 'iteration two reply' })
    fake2.exit(0)
    await promise2

    // Neither iteration nacked — in particular, NOT with E_CLAUDE_CODE_CLI_STREAM_ERROR, which is
    // exactly what a thrown "stream already complete" from `makeStreamGuardedHelpers` above would
    // produce on unfixed code (the id-collision propagates through the adapter's own `onEvent(...)
    // .catch(...)` last-line-of-defence handler).
    expect(ctx.nack).not.toHaveBeenCalled()

    // Both messages were reported as complete, under DISTINCT ids.
    const completeCalls = helpers._messageCalls.filter((c) => c.isComplete)
    expect(completeCalls).toHaveLength(2)
    const reportedIds = completeCalls.map((c) => c.id)
    expect(new Set(reportedIds).size).toBe(2)

    // Both were stored as distinct `Message`s with the right content, matching the ids reported.
    expect(ctx._stored.messages).toHaveLength(2)
    const storedIds = ctx._stored.messages.map((m) => m.id)
    expect(new Set(storedIds).size).toBe(2)
    expect(new Set(storedIds)).toEqual(new Set(reportedIds))
    const contents = ctx._stored.messages.map((m) => m.content?.toString())
    expect(contents).toContain('iteration one reply')
    expect(contents).toContain('iteration two reply')
  })
})

describe('ClaudeCodeCliAdapter — thought id de-collision across wrapper spawns (issue #43, fix A)', () => {
  it('two dispatch iterations, each a fresh wrapper spawn whose thought stream uses the SAME wrapper-local id, get DISTINCT ADK thought ids and both complete without nacking', async () => {
    const ctx = makeCtx()

    // ── Iteration 1 ──
    const fake1 = new FakeWrapperChild()
    const { execaFn: execaFn1 } = makeExecaFn(fake1)
    const adapter1 = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn1, autoAck: true }))
    const helpers = makeStreamGuardedHelpers()
    const promise1 = adapter1.executor()(ctx, helpers)
    await nextTurn()
    fake1.emit({ type: 'ready' })
    await nextTurn()
    fake1.emit({ type: 'init' })
    await nextTurn()
    // No live wrapper code path emits `thought_delta` today (see wrapper.ts), but the wire
    // protocol and the adapter's reporting branch both support it — this synthesizes the event
    // directly against the SAME wrapper-local id a real emitter would be most likely to reuse.
    fake1.emit({ type: 'thought_delta', id: 'thought-0', delta: 'thinking one', isComplete: true })
    await nextTurn()
    fake1.emit({ type: 'result', isError: false, resultText: 'ok' })
    fake1.exit(0)
    await promise1

    // ── Iteration 2: same `ctx`/`helpers`, same wrapper-local thought id ──
    const fake2 = new FakeWrapperChild()
    const { execaFn: execaFn2 } = makeExecaFn(fake2)
    const adapter2 = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn2, autoAck: true }))
    const promise2 = adapter2.executor()(ctx, helpers)
    await nextTurn()
    fake2.emit({ type: 'ready' })
    await nextTurn()
    fake2.emit({ type: 'init' })
    await nextTurn()
    fake2.emit({ type: 'thought_delta', id: 'thought-0', delta: 'thinking two', isComplete: true })
    await nextTurn()
    fake2.emit({ type: 'result', isError: false, resultText: 'ok' })
    fake2.exit(0)
    await promise2

    expect(ctx.nack).not.toHaveBeenCalled()
    const completeCalls = helpers._thoughtCalls.filter((c) => c.isComplete)
    expect(completeCalls).toHaveLength(2)
    const reportedIds = completeCalls.map((c) => c.id)
    expect(new Set(reportedIds).size).toBe(2)
  })
})

describe('ClaudeCodeCliAdapter — multiple distinct messages within ONE wrapper spawn (issue #43, fix B/C)', () => {
  it('a single spawn emitting text -> tool_use -> more text produces TWO distinct, complete, correctly-stored Messages instead of colliding or merging', async () => {
    const tool = new Tool({
      name: 'echo_tool',
      description: 'echoes',
      inputSchema: validator.object({ text: validator.string().required() }),
      handler: (async (args: unknown) => `echoed:${JSON.stringify(args)}`) as never,
    })
    const ctx = makeCtx({ tools: new ToolRegistry([tool]) })
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
    const helpers = makeStreamGuardedHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()

    // First assistant message, sealed complete under the wrapper's per-spawn id "message-0".
    fake.emit({
      type: 'message_delta',
      id: 'message-0',
      delta: 'first message text',
      isComplete: true,
    })
    await nextTurn()

    // A tool call in between — the wrapper's own message-id counter/reset must not be disturbed by
    // unrelated tool-call traffic sharing the same spawn.
    fake.emit({ type: 'tool_call_request', requestId: '0', tool: 'echo_tool', args: { text: 'x' } })
    await nextTurn()
    await nextTurn()

    // A second, DISTINCT assistant message arrives later in the SAME spawn. Post-fix, the wrapper
    // resets its counter after sealing the first message, so this arrives as "message-1" — the
    // exact id the wrapper-side fix is responsible for minting.
    fake.emit({
      type: 'message_delta',
      id: 'message-1',
      delta: 'second message text',
      isComplete: true,
    })
    await nextTurn()
    fake.emit({ type: 'result', isError: false, resultText: 'second message text' })
    fake.exit(0)
    await promise

    expect(ctx.nack).not.toHaveBeenCalled()

    // Both messages reported complete under distinct ids — not one call silently colliding with
    // (or being dropped in favor of) the other.
    const completeCalls = helpers._messageCalls.filter((c) => c.isComplete)
    expect(completeCalls).toHaveLength(2)
    expect(new Set(completeCalls.map((c) => c.id)).size).toBe(2)

    // Both were persisted as distinct `Message`s — pre-fix (Bug C), `sealCurrentMessage`'s flat
    // `sealedMessage` boolean guard meant only the FIRST message per spawn was ever stored, and its
    // flat `currentMessageBuffer` accumulator would have concatenated the two texts together had
    // the id collision (Bug B) not thrown first.
    expect(ctx._stored.messages).toHaveLength(2)
    const contents = ctx._stored.messages.map((m) => m.content?.toString())
    expect(contents).toContain('first message text')
    expect(contents).toContain('second message text')
    // Neither message's stored content bled into the other's.
    expect(contents.every((c) => c === 'first message text' || c === 'second message text')).toBe(
      true
    )
  })
})

describe('ClaudeCodeCliAdapter — `result` seals EVERY still-unsealed message, not just the most recent (issue #43, verification-pass LOW finding)', () => {
  it('two distinct messages are both still unsealed (no isComplete: true seen for either) when `result` arrives — both get sealed and stored, not only the most-recently-seen one', async () => {
    const ctx = makeCtx()
    const fake = new FakeWrapperChild()
    const { execaFn } = makeExecaFn(fake)
    const adapter = new ClaudeCodeCliAdapter(baseOptions({ execa: execaFn, autoAck: true }))
    const helpers = makeStreamGuardedHelpers()
    const promise = adapter.executor()(ctx, helpers)
    await nextTurn()
    fake.emit({ type: 'ready' })
    await nextTurn()
    fake.emit({ type: 'init' })
    await nextTurn()

    // First message: at least one delta arrives, but no `isComplete: true` is ever seen for it —
    // `messageState` has an entry for it, unsealed.
    fake.emit({
      type: 'message_delta',
      id: 'message-0',
      delta: 'first message text',
      isComplete: false,
    })
    await nextTurn()

    // A second, DISTINCT message id also streams a delta, and it ALSO never sees `isComplete: true`
    // before `result` arrives — e.g. the wrapper process exits right after a spawn emits two
    // in-progress messages back to back. Pre-fix, `sealCurrentMessage()` sealed only whichever id
    // was assigned to `currentMessageId` last (here, "message-1"), silently dropping "message-0".
    fake.emit({
      type: 'message_delta',
      id: 'message-1',
      delta: 'second message text',
      isComplete: false,
    })
    await nextTurn()

    fake.emit({ type: 'result', isError: false, resultText: 'second message text' })
    fake.exit(0)
    await promise

    expect(ctx.nack).not.toHaveBeenCalled()

    // BOTH messages were sealed and stored on `result`, in insertion order, not just the last one.
    expect(ctx._stored.messages).toHaveLength(2)
    const contents = ctx._stored.messages.map((m) => m.content?.toString())
    expect(contents).toContain('first message text')
    expect(contents).toContain('second message text')
  })
})
