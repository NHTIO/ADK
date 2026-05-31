import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { Hooks } from '@nhtio/hooks'
import { validator } from '@nhtio/validation'
import { Middleware } from '@nhtio/middleware'
import { validateOrThrow } from './utils/validation'
import { isError, isInstanceOf } from './utils/guards'
import { canonicalStringify } from './utils/canonical_json'
import { TurnContext } from './contracts/turn_runner_context'
import { DispatchContext } from './contracts/dispatch_context'
import {
  E_INVALID_LLM_DISPATCH_INPUT,
  E_DISPATCH_PIPELINE_ERROR,
  E_LLM_EXECUTION_EXECUTOR_ERROR,
  E_PIPELINE_SHORT_CIRCUITED,
} from './exceptions/runtime'
import type { Memory } from './classes/memory'
import type { Message } from './classes/message'
import type { Thought } from './classes/thought'
import type { ToolCall } from './classes/tool_call'
import type { Retrievable } from './classes/retrievable'
import type { Tokenizable } from './classes/tokenizable'
import type { BaseException } from './classes/base_exception'
import type { Runner as MiddlewareRunner } from '@nhtio/middleware'
import type { RawDispatchContext } from './contracts/dispatch_context'
import type { TurnStreamableContent, TurnToolCallContent } from './types/turn_runner'
import type {
  DispatchPipelineMiddlewareFn,
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  DispatchExecutorLogChannel,
  DispatchExecutorLogEntry,
  DispatchExecutorLogLevel,
  LogEvent,
  ContextDelta,
  DispatchRunnerFunctionalHooks,
  DispatchRunnerObservabilityHooks,
  DispatchRunnerFunctionalHookRegistrations,
  DispatchRunnerObservabilityHookRegistrations,
} from './types/dispatch_runner'

/**
 * Plain input object supplied to {@link DispatchRunner.dispatch}.
 *
 * @remarks
 * Exactly one of `source` or `raw` is required:
 *
 * - `source` — switches to the **derived path**. The runner snapshots primitives from the
 *   provided {@link @nhtio/adk!TurnContext}, wires all fetch/refresh/mutation callbacks to delegate to it,
 *   forwards emits back to its buses, and bubbles mutations to its Sets at the end of every
 *   iteration.
 *
 * - `raw` — switches to the **standalone path**. The runner constructs an {@link @nhtio/adk!DispatchContext}
 *   directly from the provided raw input. No parent relationship exists; mutations are not bubbled.
 *
 * The `executor` is the user-provided callback that performs the actual LLM API call between the
 * input and output middleware pipelines on every iteration.
 */
export interface RawDispatchRunnerInput {
  /** Source {@link @nhtio/adk!TurnContext} to derive the execution context from. Mutually exclusive with `raw`. */
  source?: TurnContext
  /** Raw input for a standalone {@link @nhtio/adk!DispatchContext}. Mutually exclusive with `source`. */
  raw?: Omit<RawDispatchContext, 'hooks'>
  /** User-provided callback that makes the LLM API call. Invoked between input and output pipelines on every iteration. */
  executor: DispatchExecutorFn
  /** Input middleware functions, executed in order before the executor on every iteration. */
  turnInputPipeline?: DispatchPipelineMiddlewareFn[]
  /** Output middleware functions, executed in order after the executor on every iteration. */
  turnOutputPipeline?: DispatchPipelineMiddlewareFn[]
  /** Optional functional hook registrations: message, thought, toolCall. */
  hooks?: DispatchRunnerFunctionalHookRegistrations
  /** Optional observability hook registrations: lifecycle events + tool execution + error. */
  observers?: DispatchRunnerObservabilityHookRegistrations
}

const dispatchInputSchema = validator.object<RawDispatchRunnerInput>({
  source: validator
    .any()
    .custom((value, helpers) => {
      if (value === undefined) return value
      if (isInstanceOf(value, 'TurnContext', TurnContext)) return value
      return helpers.error('any.invalid')
    })
    .optional(),
  raw: validator.object().unknown(true).optional(),
  executor: validator.function().required(),
  turnInputPipeline: validator.array().items(validator.function()).default([]),
  turnOutputPipeline: validator.array().items(validator.function()).default([]),
  hooks: validator.object().optional(),
  observers: validator.object().optional(),
})

/**
 * Orchestrates a single LLM execution dispatch — input pipeline → executor → output pipeline —
 * looped until middleware/executor signals completion via {@link @nhtio/adk!DispatchContext.ack} /
 * {@link @nhtio/adk!DispatchContext.nack} or the abort signal fires.
 *
 * @remarks
 * `DispatchRunner` has a private constructor and is invoked via the static `dispatch()`
 * method. Each dispatch creates a fresh single-use runner that is garbage-collected after the
 * call completes — matching the `@nhtio/hooks` GC rationale already baked into the context.
 *
 * The runner owns the relationship between an {@link @nhtio/adk!DispatchContext} and its parent
 * {@link @nhtio/adk!TurnContext} (when given a source). It subscribes to the context's mutation hooks,
 * queues `ContextDelta` entries, and flushes them to the parent's Sets at the end of every
 * iteration. Emits propagate from the context's hooks → the runner's hooks → (optionally) the
 * parent `TurnContext`'s emit methods → the `TurnRunner`'s buses.
 *
 * Two hook buses, mirroring `TurnRunner`'s pattern:
 *
 * - **Functional** (`hooks`): `message`, `thought`, `toolCall` — pipeline-affecting events
 * - **Observability** (`observers`): `iterationStart`, `iterationEnd`, `dispatchStart`,
 *   `dispatchEnd`, `error`, `toolExecutionStart`, `toolExecutionEnd` — instrumentation only
 *
 * The runner has no `maxIterations`, no `maxToolCallChecksumRepeats`. Implementers use the
 * primitives — `ctx.iteration`, `ctx.toolCallCount(checksum)`, `ctx.ack()`, `ctx.nack()`,
 * `ctx.abortSignal` — to build any termination bounds they need in their own middleware.
 */
/**
 * Module-private token gating direct construction of {@link DispatchRunner}. Callers must use
 * {@link DispatchRunner.dispatch}; the symbol is not exported, so external code cannot satisfy
 * the guard at runtime.
 */
const CONSTRUCT_TOKEN = Symbol('DispatchRunner.construct')

export class DispatchRunner {
  #functionalHooks: Hooks<DispatchRunnerFunctionalHooks>
  #observabilityHooks: Hooks<DispatchRunnerObservabilityHooks>
  // The Middleware holders are built once; a FRESH Runner is derived from each
  // per dispatch iteration. A Runner is single-use — its internal cursor
  // (#currentIndex) is never reset by run() — so reusing one Runner across
  // iterations silently no-ops every pipeline after the first. The dispatch loop
  // runs the input/output pipelines once PER iteration, so it must mint a new
  // Runner each time or the citation/quality gate (and all output middleware)
  // would only ever fire on iteration 0.
  #inputPipeline: Middleware<DispatchPipelineMiddlewareFn>
  #outputPipeline: Middleware<DispatchPipelineMiddlewareFn>
  #sourceCtx: TurnContext | undefined
  #deltaQueue: ContextDelta[]

  constructor(
    token: typeof CONSTRUCT_TOKEN,
    sourceCtx: TurnContext | undefined,
    turnInputPipeline: DispatchPipelineMiddlewareFn[],
    turnOutputPipeline: DispatchPipelineMiddlewareFn[],
    hooks: DispatchRunnerFunctionalHookRegistrations | undefined,
    observers: DispatchRunnerObservabilityHookRegistrations | undefined
  ) {
    if (token !== CONSTRUCT_TOKEN) {
      throw new E_INVALID_LLM_DISPATCH_INPUT()
    }
    this.#sourceCtx = sourceCtx
    this.#deltaQueue = []
    this.#functionalHooks = new Hooks<DispatchRunnerFunctionalHooks>()
    this.#observabilityHooks = new Hooks<DispatchRunnerObservabilityHooks>()

    const inputPipeline = new Middleware<DispatchPipelineMiddlewareFn>()
    const outputPipeline = new Middleware<DispatchPipelineMiddlewareFn>()
    const wrap =
      (fn: DispatchPipelineMiddlewareFn): DispatchPipelineMiddlewareFn =>
      (ctx, next) => {
        // Skip downstream user middlewares once an abort has been signalled. The
        // wrapper still calls next() so the pipeline reaches its terminal resolver
        // (keeping the short-circuit detector quiet); the original middleware body
        // does not run, so it has nothing to clean up.
        if (ctx.aborted) return next()
        return fn(ctx, next)
      }
    for (const fn of turnInputPipeline) inputPipeline.add(wrap(fn))
    for (const fn of turnOutputPipeline) outputPipeline.add(wrap(fn))
    // Hold the Middleware; derive a fresh Runner per iteration (see field docs).
    this.#inputPipeline = inputPipeline
    this.#outputPipeline = outputPipeline

    if (hooks) {
      for (const key of Object.keys(hooks) as (keyof DispatchRunnerFunctionalHooks)[]) {
        const entry = hooks[key]
        if (!entry) continue
        const handlers = Array.isArray(entry) ? entry : [entry]
        for (const h of handlers) this.#functionalHooks.add(key, h as any)
      }
    }
    if (observers) {
      for (const key of Object.keys(observers) as (keyof DispatchRunnerObservabilityHooks)[]) {
        const entry = observers[key]
        if (!entry) continue
        const handlers = Array.isArray(entry) ? entry : [entry]
        for (const h of handlers) this.#observabilityHooks.add(key, h as any)
      }
    }
  }

  /**
   * Returns `true` if `value` is a {@link DispatchRunner} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link DispatchRunner} instance.
   */
  public static isDispatchRunner(value: unknown): value is DispatchRunner {
    return isInstanceOf(value, 'DispatchRunner', DispatchRunner)
  }

  /**
   * Dispatches a single LLM execution.
   *
   * @remarks
   * Constructs an {@link @nhtio/adk!DispatchContext} (derived from `source` or from `raw`), runs the
   * iteration loop, and resolves when middleware/executor signals completion via `ctx.ack()` or
   * the abort signal fires. Rejects with the nack error when middleware/executor calls
   * `ctx.nack(err)`. Pipeline and executor errors are wrapped, surfaced on the observability
   * `error` hook, and re-thrown.
   *
   * @param input - The dispatch input. Provide either `source` (derived path) or `raw` (standalone).
   * @throws {@link @nhtio/adk!E_INVALID_LLM_DISPATCH_INPUT} when the input does not satisfy validation, or
   *   when neither `source` nor `raw` is provided, or when both are provided.
   */
  public static async dispatch(input: RawDispatchRunnerInput): Promise<void> {
    let resolved: RawDispatchRunnerInput & {
      turnInputPipeline: DispatchPipelineMiddlewareFn[]
      turnOutputPipeline: DispatchPipelineMiddlewareFn[]
    }
    try {
      resolved = validateOrThrow(dispatchInputSchema, input, true) as typeof resolved
    } catch (err) {
      throw new E_INVALID_LLM_DISPATCH_INPUT({ cause: isError(err) ? err : undefined })
    }

    if (!resolved.source && !resolved.raw) {
      throw new E_INVALID_LLM_DISPATCH_INPUT()
    }
    if (resolved.source && resolved.raw) {
      throw new E_INVALID_LLM_DISPATCH_INPUT()
    }

    const runner = new DispatchRunner(
      CONSTRUCT_TOKEN,
      resolved.source,
      resolved.turnInputPipeline,
      resolved.turnOutputPipeline,
      resolved.hooks,
      resolved.observers
    )

    const llmCtx = runner.#buildContext(resolved.source, resolved.raw)
    runner.#wireContextHooks(llmCtx)

    await runner.#runDispatch(llmCtx, resolved.executor)
  }

  // ── Context construction ──────────────────────────────────────────────────

  #buildContext(
    source: TurnContext | undefined,
    raw: Omit<RawDispatchContext, 'hooks'> | undefined
  ): DispatchContext {
    if (source) {
      const ac = new AbortController()
      source.abortSignal.addEventListener('abort', () => ac.abort(), { once: true })

      const builtRaw: RawDispatchContext = {
        turnAbortController: ac,
        stash: source.stash.all(),
        systemPrompt: source.systemPrompt,
        standingInstructions: [...source.standingInstructions],
        memories: [...source.turnMemories],
        retrievables: [...source.turnRetrievables],
        messages: [...source.turnMessages],
        thoughts: [...source.turnThoughts],
        toolCalls: [...source.turnToolCalls],
        tools: source.tools.all(),
        fetchMemories: () => source.fetchMemories(),
        fetchRetrievables: () => source.fetchRetrievables(),
        fetchMessages: () => source.fetchMessages(),
        fetchThoughts: () => source.fetchThoughts(),
        fetchToolCalls: () => source.fetchToolCalls(),
        fetchTools: () => source.fetchTools(),
        refreshStandingInstructions: () => source.refreshStandingInstructions(),
        storeStandingInstruction: (_c, v) => source.storeStandingInstruction(v),
        mutateStandingInstruction: (_c, v) => source.mutateStandingInstruction(v),
        deleteStandingInstruction: (_c, v) => source.deleteStandingInstruction(v),
        storeMemory: (_c, v) => source.storeMemory(v),
        mutateMemory: (_c, v) => source.mutateMemory(v),
        deleteMemory: (_c, id) => source.deleteMemory(id),
        storeRetrievable: (_c, v) => source.storeRetrievable(v),
        mutateRetrievable: (_c, v) => source.mutateRetrievable(v),
        deleteRetrievable: (_c, id) => source.deleteRetrievable(id),
        storeMessage: (_c, v) => source.storeMessage(v),
        mutateMessage: (_c, v) => source.mutateMessage(v),
        deleteMessage: (_c, id) => source.deleteMessage(id),
        storeThought: (_c, v) => source.storeThought(v),
        mutateThought: (_c, v) => source.mutateThought(v),
        deleteThought: (_c, id) => source.deleteThought(id),
        storeToolCall: (_c, v) => source.storeToolCall(v),
        mutateToolCall: (_c, v) => source.mutateToolCall(v),
        deleteToolCall: (_c, id) => source.deleteToolCall(id),
        storeMediaBytes: (_c, id, bytes) => source.storeMediaBytes(id, bytes),
        storeRetrievableBytes: (_c, id, bytes) => source.storeRetrievableBytes(id, bytes),
        waitFor: source.waitFor,
      }
      return new DispatchContext(builtRaw)
    }

    // Standalone path — runner does not pass hooks (it registers its own forwarders below).
    return new DispatchContext(raw as RawDispatchContext)
  }

  // ── Wire forwarding handlers from ctx hooks to runner hooks ───────────────

  #wireContextHooks(llmCtx: DispatchContext): void {
    const ctxHooks = llmCtx._getHooks()

    // Functional forwarders: ctx → runner (functional) → (if source) → TurnContext
    ctxHooks.add('message', (c) => {
      void this.#functionalHooks.runner('message').run(c)
      if (this.#sourceCtx) this.#sourceCtx.emitMessage(c)
    })
    ctxHooks.add('thought', (c) => {
      void this.#functionalHooks.runner('thought').run(c)
      if (this.#sourceCtx) this.#sourceCtx.emitThought(c)
    })
    ctxHooks.add('toolCall', (c) => {
      void this.#functionalHooks.runner('toolCall').run(c)
      if (this.#sourceCtx) this.#sourceCtx.emitToolCall(c)
    })

    // Observability forwarders for tool execution lifecycle
    ctxHooks.add('toolExecutionStart', (e) => {
      void this.#observabilityHooks.runner('toolExecutionStart').run(e)
      if (this.#sourceCtx) this.#sourceCtx.emitToolExecutionStart(e)
    })
    ctxHooks.add('toolExecutionEnd', (e) => {
      void this.#observabilityHooks.runner('toolExecutionEnd').run(e)
      if (this.#sourceCtx) this.#sourceCtx.emitToolExecutionEnd(e)
    })

    // Mutation hooks → push to internal delta queue (only meaningful when source exists,
    // but registering unconditionally keeps the API uniform; queue is drained only in derived)
    ctxHooks.add('storedStandingInstruction', (v) => {
      this.#deltaQueue.push({ op: 'store', type: 'standingInstruction', value: v })
    })
    ctxHooks.add('mutatedStandingInstruction', (v) => {
      this.#deltaQueue.push({ op: 'mutate', type: 'standingInstruction', value: v })
    })
    ctxHooks.add('deletedStandingInstruction', (v) => {
      this.#deltaQueue.push({ op: 'delete', type: 'standingInstruction', value: v })
    })
    ctxHooks.add('storedMemory', (v) => {
      this.#deltaQueue.push({ op: 'store', type: 'memory', value: v })
    })
    ctxHooks.add('mutatedMemory', (v) => {
      this.#deltaQueue.push({ op: 'mutate', type: 'memory', value: v })
    })
    ctxHooks.add('deletedMemory', (id) => {
      this.#deltaQueue.push({ op: 'delete', type: 'memory', value: id })
    })
    ctxHooks.add('storedRetrievable', (v) => {
      this.#deltaQueue.push({ op: 'store', type: 'retrievable', value: v })
    })
    ctxHooks.add('mutatedRetrievable', (v) => {
      this.#deltaQueue.push({ op: 'mutate', type: 'retrievable', value: v })
    })
    ctxHooks.add('deletedRetrievable', (id) => {
      this.#deltaQueue.push({ op: 'delete', type: 'retrievable', value: id })
    })
    ctxHooks.add('storedMessage', (v) => {
      this.#deltaQueue.push({ op: 'store', type: 'message', value: v })
    })
    ctxHooks.add('mutatedMessage', (v) => {
      this.#deltaQueue.push({ op: 'mutate', type: 'message', value: v })
    })
    ctxHooks.add('deletedMessage', (id) => {
      this.#deltaQueue.push({ op: 'delete', type: 'message', value: id })
    })
    ctxHooks.add('storedThought', (v) => {
      this.#deltaQueue.push({ op: 'store', type: 'thought', value: v })
    })
    ctxHooks.add('mutatedThought', (v) => {
      this.#deltaQueue.push({ op: 'mutate', type: 'thought', value: v })
    })
    ctxHooks.add('deletedThought', (id) => {
      this.#deltaQueue.push({ op: 'delete', type: 'thought', value: id })
    })
    ctxHooks.add('storedToolCall', (v) => {
      this.#deltaQueue.push({ op: 'store', type: 'toolCall', value: v })
    })
    ctxHooks.add('mutatedToolCall', (v) => {
      this.#deltaQueue.push({ op: 'mutate', type: 'toolCall', value: v })
    })
    ctxHooks.add('deletedToolCall', (id) => {
      this.#deltaQueue.push({ op: 'delete', type: 'toolCall', value: id })
    })
  }

  // ── Helper builder ────────────────────────────────────────────────────────

  /**
   * Constructs an {@link @nhtio/adk!DispatchExecutorHelpers} instance bound to a single dispatch.
   *
   * @remarks
   * Per-id stream state lives on closure-captured `Map`s, so it persists across iterations of
   * the dispatch but cannot leak between dispatches (the runner itself is single-use and
   * garbage-collected after `dispatch()` returns).
   */
  #buildHelpers(ctx: DispatchContext): DispatchExecutorHelpers {
    const observabilityHooks = this.#observabilityHooks
    const makeLogEmitter =
      (level: DispatchExecutorLogLevel) =>
      (entry: DispatchExecutorLogEntry): void => {
        const event: LogEvent = {
          dispatchId: ctx.dispatchId,
          iteration: ctx.iteration,
          emittedAt: DateTime.now(),
          level,
          kind: entry.kind,
          message: entry.message,
          ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        }
        void observabilityHooks.runner('log').run(event)
      }
    const log: DispatchExecutorLogChannel = {
      trace: makeLogEmitter('trace'),
      debug: makeLogEmitter('debug'),
      info: makeLogEmitter('info'),
      warn: makeLogEmitter('warn'),
      error: makeLogEmitter('error'),
    }

    const messageStreams = new Map<
      string,
      { full: string; createdAt: DateTime; isComplete: boolean }
    >()
    const thoughtStreams = new Map<
      string,
      { full: string; createdAt: DateTime; isComplete: boolean }
    >()
    const toolCallStreams = new Map<
      string,
      {
        tool?: string
        args?: unknown
        checksum?: string
        results?: unknown
        isError: boolean
        isComplete: boolean
        createdAt: DateTime
      }
    >()

    const buildStream = (
      store: Map<string, { full: string; createdAt: DateTime; isComplete: boolean }>,
      id: string,
      deltaText: string,
      isComplete: boolean
    ): TurnStreamableContent => {
      let entry = store.get(id)
      const now = DateTime.now()
      if (!entry) {
        entry = { full: '', createdAt: now, isComplete: false }
        store.set(id, entry)
      }
      if (entry.isComplete) {
        throw new Error(`stream "${id}" is already complete; further chunks are not accepted`)
      }
      entry.full = entry.full + deltaText
      entry.isComplete = isComplete
      return {
        id,
        createdAt: entry.createdAt,
        updatedAt: now,
        full: entry.full,
        aDelta: deltaText,
        isComplete,
        ...(isComplete ? { completedAt: now } : {}),
      }
    }

    return {
      reportMessage: (id, deltaText, opts) => {
        const isComplete = opts?.isComplete ?? false
        ctx.emitMessage(buildStream(messageStreams, id, deltaText, isComplete))
      },
      reportThought: (id, deltaText, opts) => {
        const isComplete = opts?.isComplete ?? false
        ctx.emitThought(buildStream(thoughtStreams, id, deltaText, isComplete))
      },
      reportToolCall: (id, partial) => {
        let entry = toolCallStreams.get(id)
        const now = DateTime.now()
        if (!entry) {
          entry = { isError: false, isComplete: false, createdAt: now }
          toolCallStreams.set(id, entry)
        }
        if (entry.isComplete) {
          throw new Error(`tool call "${id}" is already complete; further updates are not accepted`)
        }
        if (partial.tool !== undefined) entry.tool = partial.tool
        if (partial.args !== undefined) entry.args = partial.args
        if (partial.results !== undefined) entry.results = partial.results
        if (partial.isError !== undefined) entry.isError = partial.isError
        if (partial.isComplete !== undefined) entry.isComplete = partial.isComplete

        // Compute checksum once tool + args are both set (or recompute if either changed)
        if (entry.tool !== undefined && entry.args !== undefined) {
          entry.checksum = sha256(canonicalStringify({ tool: entry.tool, args: entry.args }))
        }

        const content: TurnToolCallContent = {
          id,
          tool: entry.tool ?? '',
          args: entry.args,
          checksum: entry.checksum ?? '',
          createdAt: entry.createdAt,
          updatedAt: now,
          isComplete: entry.isComplete,
          isError: entry.isError,
          ...(entry.results !== undefined ? { results: entry.results } : {}),
          ...(entry.isComplete ? { completedAt: now } : {}),
        }
        ctx.emitToolCall(content)
      },
      log,
    }
  }

  // ── Iteration loop ────────────────────────────────────────────────────────

  async #runDispatch(llmCtx: DispatchContext, executor: DispatchExecutorFn): Promise<void> {
    const dispatchId = uuidv6()
    llmCtx._setDispatchId(dispatchId)

    const dispatchStartedAt = DateTime.now()
    void this.#observabilityHooks
      .runner('dispatchStart')
      .run({ dispatchId, startedAt: dispatchStartedAt })

    // Helpers are constructed once per dispatch so per-id streaming state is preserved across
    // iterations, and garbage-collected with the runner so cross-dispatch state can't leak.
    const helpers = this.#buildHelpers(llmCtx)

    let iteration = 0
    let dispatchError: Error | undefined

    try {
      while (!llmCtx.aborted && !llmCtx.isSignalled) {
        llmCtx._setIteration(iteration)
        const iterationStartedAt = DateTime.now()
        void this.#observabilityHooks
          .runner('iterationStart')
          .run({ dispatchId, iteration, startedAt: iterationStartedAt })

        await this.#runPipeline(this.#inputPipeline.runner(), llmCtx, 'input')
        if (llmCtx.aborted || llmCtx.isSignalled) {
          // ack mid-iteration flushes parent-mirror deltas accumulated so far;
          // nack / abort discards them so a partial iteration cannot leak
          // partial writes into the parent turn.
          if (llmCtx.isAcked && !llmCtx.aborted) {
            await this.#flush()
          } else {
            this.#deltaQueue.length = 0
          }
          break
        }

        try {
          await executor(llmCtx, helpers)
        } catch (err) {
          if (this.#isAbortError(err)) {
            this.#deltaQueue.length = 0
            break
          }
          const wrapped = new E_LLM_EXECUTION_EXECUTOR_ERROR({
            cause: isError(err) ? err : undefined,
          })
          void this.#observabilityHooks.runner('error').run(wrapped as unknown as BaseException)
          this.#deltaQueue.length = 0
          throw wrapped
        }

        if (llmCtx.aborted || llmCtx.isSignalled) {
          if (llmCtx.isAcked && !llmCtx.aborted) {
            await this.#flush()
          } else {
            this.#deltaQueue.length = 0
          }
          break
        }

        await this.#runPipeline(this.#outputPipeline.runner(), llmCtx, 'output')
        await this.#flush()

        const iterationEndedAt = DateTime.now()
        void this.#observabilityHooks.runner('iterationEnd').run({
          dispatchId,
          iteration,
          startedAt: iterationStartedAt,
          endedAt: iterationEndedAt,
          durationMs: iterationEndedAt.diff(iterationStartedAt).milliseconds,
        })

        iteration++
      }
    } catch (err) {
      dispatchError = isError(err) ? err : new Error(String(err))
    }

    const status: DispatchEndStatus = dispatchError
      ? 'nack'
      : llmCtx.nackError
        ? 'nack'
        : llmCtx.isAcked
          ? 'ack'
          : 'aborted'
    const finalError = dispatchError ?? llmCtx.nackError

    // Parity with the thrown-executor-error path: when the dispatch ends with
    // a nack whose cause we have not already emitted (i.e. `ctx.nack(error)`
    // was called explicitly, rather than the executor throwing), surface the
    // error on the observability `error` bus so observers see one unified
    // error stream regardless of how the nack was reached.
    if (!dispatchError && llmCtx.nackError) {
      const nackErr = llmCtx.nackError
      const wrapped = isInstanceOf(nackErr, 'BaseException')
        ? (nackErr as unknown as BaseException)
        : (new E_LLM_EXECUTION_EXECUTOR_ERROR({
            cause: isError(nackErr) ? nackErr : undefined,
          }) as unknown as BaseException)
      void this.#observabilityHooks.runner('error').run(wrapped)
    }

    const dispatchEndedAt = DateTime.now()
    void this.#observabilityHooks.runner('dispatchEnd').run({
      dispatchId,
      status,
      error: finalError,
      iterations: iteration,
      startedAt: dispatchStartedAt,
      endedAt: dispatchEndedAt,
      durationMs: dispatchEndedAt.diff(dispatchStartedAt).milliseconds,
    })

    if (finalError) throw finalError
  }

  async #runPipeline(
    pipeline: MiddlewareRunner<DispatchPipelineMiddlewareFn>,
    llmCtx: DispatchContext,
    label: 'input' | 'output'
  ): Promise<void> {
    let pipelineError: Error | undefined
    let reached = false
    await pipeline
      .errorHandler(async (error) => {
        if (this.#isAbortError(error)) return
        pipelineError = new E_DISPATCH_PIPELINE_ERROR({
          cause: isError(error) ? error : undefined,
        })
      })
      .finalHandler(async () => {
        reached = true
      })
      .run((fn, next) => Promise.resolve(fn(llmCtx, next)))

    if (pipelineError) {
      void this.#observabilityHooks.runner('error').run(pipelineError as unknown as BaseException)
      throw pipelineError
    }

    if (!reached && !llmCtx.aborted && !llmCtx.isSignalled) {
      const shortCircuitError = new E_PIPELINE_SHORT_CIRCUITED([`dispatch-${label}`])
      void this.#observabilityHooks
        .runner('error')
        .run(shortCircuitError as unknown as BaseException)
      throw shortCircuitError
    }
  }

  #isAbortError(err: unknown): boolean {
    return isError(err) && isInstanceOf(err, 'AbortError')
  }

  async #flush(): Promise<void> {
    if (!this.#sourceCtx) {
      this.#deltaQueue.length = 0
      return
    }
    while (this.#deltaQueue.length > 0) {
      const delta = this.#deltaQueue.shift()!
      this.#applyDeltaToParent(delta)
    }
  }

  #applyDeltaToParent(delta: ContextDelta): void {
    const ctx = this.#sourceCtx!
    const { op, type, value } = delta

    if (type === 'standingInstruction') {
      const t = value as Tokenizable
      if (op === 'store' || op === 'mutate') ctx.standingInstructions.add(t)
      else ctx.standingInstructions.delete(t)
      return
    }
    if (type === 'memory') {
      if (op === 'store' || op === 'mutate') {
        ctx.turnMemories.add(value as Memory)
      } else {
        for (const m of ctx.turnMemories) {
          if ((m as any).id === (value as any)) {
            ctx.turnMemories.delete(m)
            break
          }
        }
      }
      return
    }
    if (type === 'retrievable') {
      if (op === 'store' || op === 'mutate') {
        ctx.turnRetrievables.add(value as Retrievable)
      } else {
        for (const r of ctx.turnRetrievables) {
          if ((r as any).id === (value as any)) {
            ctx.turnRetrievables.delete(r)
            break
          }
        }
      }
      return
    }
    if (type === 'message') {
      if (op === 'store' || op === 'mutate') {
        ctx.turnMessages.add(value as Message)
      } else {
        for (const m of ctx.turnMessages) {
          if ((m as any).id === (value as any)) {
            ctx.turnMessages.delete(m)
            break
          }
        }
      }
      return
    }
    if (type === 'thought') {
      if (op === 'store' || op === 'mutate') {
        ctx.turnThoughts.add(value as Thought)
      } else {
        for (const t of ctx.turnThoughts) {
          if ((t as any).id === (value as any)) {
            ctx.turnThoughts.delete(t)
            break
          }
        }
      }
      return
    }
    if (type === 'toolCall') {
      if (op === 'store' || op === 'mutate') {
        ctx.turnToolCalls.add(value as ToolCall)
      } else {
        for (const tc of ctx.turnToolCalls) {
          if ((tc as any).id === (value as any)) {
            ctx.turnToolCalls.delete(tc)
            break
          }
        }
      }
      return
    }
  }
}

type DispatchEndStatus = 'ack' | 'nack' | 'aborted'
