import { DateTime } from 'luxon'
import { Middleware } from '@nhtio/middleware'
import { TurnGate } from './classes/turn_gate'
import { DispatchRunner } from './dispatch_runner'
import { ToolRegistry } from './classes/tool_registry'
import { isInstanceOf, isError } from './utils/guards'
import { TypedEventEmitter } from '@nhtio/tiny-typed-emitter'
import { passesSchema, validateOrThrow } from './utils/validation'
import { turnRunnerConfigSchema } from './contracts/turn_runner_config'
import { TurnContext, RawTurnContext } from './contracts/turn_runner_context'
import {
  E_INVALID_TURN_RUNNER_CONFIG,
  E_INPUT_PIPELINE_ERROR,
  E_OUTPUT_PIPELINE_ERROR,
  E_PIPELINE_SHORT_CIRCUITED,
} from './exceptions/runtime'
import type { Runner } from '@nhtio/middleware'
import type { RawTurnGate } from './classes/turn_gate'
import type { ResolvedTurnRunnerConfig, TurnRunnerConfig } from './contracts/turn_runner_config'
import type {
  OpenGateFn,
  TurnEvents,
  TurnEvent,
  TurnEventListener,
  TurnPipelineMiddlewareFn,
  TurnObservabilityEvents,
  TurnObservabilityEvent,
  TurnObservabilityEventListener,
} from './types/turn_runner'

export type {
  TurnPipelineMiddlewareFn,
  TurnStreamableContent,
  TurnToolCallContent,
  TurnStartEvent,
  TurnEndEvent,
  TurnGateClosedEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
  EmitMessageFn,
  EmitThoughtFn,
  EmitToolCallFn,
  EmitToolExecutionStartFn,
  EmitToolExecutionEndFn,
  OpenGateFn,
  TurnEvents,
  TurnEvent,
  TurnEventListener,
  TurnObservabilityEvents,
  TurnObservabilityEvent,
  TurnObservabilityEventListener,
} from './types/turn_runner'

/**
 * Executes a single agent turn through paired input and output middleware pipelines.
 *
 * @remarks
 * Construction validates `config` eagerly and throws {@link @nhtio/adk!E_INVALID_TURN_RUNNER_CONFIG} if it
 * does not satisfy the schema — fail-fast so misconfiguration surfaces before any turn runs.
 *
 * Each call to {@link TurnRunner.run} threads a {@link @nhtio/adk!TurnContext} through the input pipeline,
 * invokes the model, then threads the result through the output pipeline. Middleware on each side
 * can read and mutate the context for pre- and post-processing (e.g. message normalisation, tool
 * call dispatch, response filtering).
 *
 * **Two event buses:**
 * - Functional bus (`on` / `off` / `once`): `message`, `thought`, `toolCall` — pipeline-affecting
 *   events that middleware raises throughout turn execution.
 * - Observability bus (`observe` / `unobserve` / `observeOnce`): `turnStart`, `turnEnd`,
 *   `turnGateOpen`, `turnGateClosed`, `error` — instrumentation-only events that monitor execution
 *   without participating in it.
 *
 * Streaming content is surfaced via `message` and `thought` events; tool call lifecycle via
 * `toolCall`; non-fatal pipeline errors via the observability `error` event; gate lifecycle via
 * `turnGateOpen` and `turnGateClosed` — all throughout execution.
 *
 * @example
 * ```ts
 * const runner = new TurnRunner({
 *   fetchMemoriesCallback: async (ctx) => memoryStore.query(ctx),
 *   fetchMessagesCallback: async (ctx) => messageStore.history(ctx),
 *   fetchThoughtsCallback: async (ctx) => thoughtStore.history(ctx),
 *   fetchToolCallsCallback: async (ctx) => toolCallStore.history(ctx),
 * })
 * // Functional bus — pipeline events
 * runner.on('message', (chunk) => process.stdout.write(chunk.aDelta))
 * // Observability bus — instrumentation
 * runner.observe('error', (err) => console.error(err.toString()))
 * runner.observe('turnStart', ({ turnId }) => console.log('turn started', turnId))
 * runner.observe('turnGateOpen', (gate) => {
 *   if (gate.reason === 'tool_approval') {
 *     gate.resolve(true) // approve immediately for this example
 *   }
 * })
 * await runner.run({
 *   turnAbortController: new AbortController(),
 *   systemPrompt: 'You are a helpful assistant.',
 *   standingInstructions: [],
 * })
 * ```
 */
export class TurnRunner {
  /**
   * Returns `true` if `value` is a {@link TurnRunner} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link TurnRunner} instance.
   */
  public static isTurnRunner(value: unknown): value is TurnRunner {
    return isInstanceOf(value, 'TurnRunner', TurnRunner)
  }

  #config: ResolvedTurnRunnerConfig
  #inputRunner: Runner<TurnPipelineMiddlewareFn>
  #outputRunner: Runner<TurnPipelineMiddlewareFn>
  #functionalEmitter: TypedEventEmitter<TurnEvents>
  #observabilityEmitter: TypedEventEmitter<TurnObservabilityEvents>

  /**
   * @param config - Construction-time configuration validated against {@link turnRunnerConfigSchema}.
   * @throws {@link @nhtio/adk!E_INVALID_TURN_RUNNER_CONFIG} when `config` does not satisfy the schema.
   */
  constructor(config: TurnRunnerConfig) {
    const isValid = passesSchema(turnRunnerConfigSchema, config)
    if (!isValid) {
      throw new E_INVALID_TURN_RUNNER_CONFIG()
    }
    // Store the resolved config so optional fields (e.g. tools) are always present.
    this.#config = validateOrThrow<ResolvedTurnRunnerConfig>(turnRunnerConfigSchema, config, true)
    const turnInputPipeline = new Middleware<TurnPipelineMiddlewareFn>()
    const turnOutputPipeline = new Middleware<TurnPipelineMiddlewareFn>()
    const wrap =
      (fn: TurnPipelineMiddlewareFn): TurnPipelineMiddlewareFn =>
      (ctx, next) => {
        // Skip downstream user middlewares once an abort has been signalled. The
        // wrapper still calls next() so the pipeline reaches its terminal resolver
        // (keeping the short-circuit detector quiet); the original middleware body
        // does not run, so it has nothing to clean up.
        if (ctx.aborted) return next()
        return fn(ctx, next)
      }
    for (const fn of this.#config.turnInputPipeline) turnInputPipeline.add(wrap(fn))
    for (const fn of this.#config.turnOutputPipeline) turnOutputPipeline.add(wrap(fn))
    this.#inputRunner = turnInputPipeline.runner()
    this.#outputRunner = turnOutputPipeline.runner()
    this.#functionalEmitter = new TypedEventEmitter<TurnEvents>()
    this.#observabilityEmitter = new TypedEventEmitter<TurnObservabilityEvents>()
  }

  // ── Functional bus ───────────────────────────────────────────────────────

  /**
   * Removes a previously registered functional listener for `event`.
   *
   * @param event - The event to stop listening to.
   * @param listener - The listener function to remove.
   * @returns `this` for chaining.
   */
  off<K>(event: TurnEvent<K>, listener: TurnEventListener<K>): this {
    this.#functionalEmitter.off(event, listener)
    return this
  }

  /**
   * Registers a persistent functional listener for `event`.
   *
   * @param event - The event to listen to.
   * @param listener - The function to call on each emission.
   * @returns `this` for chaining.
   */
  on<K>(event: TurnEvent<K>, listener: TurnEventListener<K>): this {
    this.#functionalEmitter.on(event, listener)
    return this
  }

  /**
   * Registers a one-time functional listener for `event` that is automatically removed after the
   * first emission.
   *
   * @param event - The event to listen to.
   * @param listener - The function to call on the next emission.
   * @returns `this` for chaining.
   */
  once<K>(event: TurnEvent<K>, listener: TurnEventListener<K>): this {
    this.#functionalEmitter.once(event, listener)
    return this
  }

  // ── Observability bus ────────────────────────────────────────────────────

  /**
   * Removes a previously registered observability listener for `event`.
   *
   * @param event - The event to stop observing.
   * @param listener - The listener function to remove.
   * @returns `this` for chaining.
   */
  unobserve<K>(
    event: TurnObservabilityEvent<K>,
    listener: TurnObservabilityEventListener<K>
  ): this {
    this.#observabilityEmitter.off(event, listener)
    return this
  }

  /**
   * Registers a persistent observability listener for `event`.
   *
   * @remarks
   * Use the observability bus (`observe` / `unobserve` / `observeOnce`) for instrumentation:
   * turn lifecycle, gate lifecycle, and non-fatal errors. Use the functional bus (`on` / `off` /
   * `once`) for pipeline-affecting events: `message`, `thought`, `toolCall`.
   *
   * @param event - The event to observe.
   * @param listener - The function to call on each emission.
   * @returns `this` for chaining.
   */
  observe<K>(event: TurnObservabilityEvent<K>, listener: TurnObservabilityEventListener<K>): this {
    this.#observabilityEmitter.on(event, listener)
    return this
  }

  /**
   * Registers a one-time observability listener for `event` that is automatically removed after
   * the first emission.
   *
   * @param event - The event to observe once.
   * @param listener - The function to call on the next emission.
   * @returns `this` for chaining.
   */
  observeOnce<K>(
    event: TurnObservabilityEvent<K>,
    listener: TurnObservabilityEventListener<K>
  ): this {
    this.#observabilityEmitter.once(event, listener)
    return this
  }

  // ── Turn execution ───────────────────────────────────────────────────────

  /**
   * Executes a single agent turn against the provided raw context.
   *
   * @remarks
   * Returns `Promise<void>` intentionally — all meaningful output surfaces via events, not return
   * values. Register listeners before calling `run`: observability events (`turnStart`, `turnEnd`)
   * bracket execution; functional events (`message`, `thought`, `toolCall`) fire throughout;
   * observability `error` carries non-fatal pipeline failures; `turnGateOpen` and `turnGateClosed`
   * fire when middleware suspends via `ctx.waitFor()`. Awaiting this method only tells you the
   * pipeline has finished, not what it produced.
   *
   * Constructs a validated {@link @nhtio/adk!TurnContext} from `context` (throwing
   * {@link @nhtio/adk!E_INVALID_TURN_CONTEXT} on failure), then runs the input middleware pipeline.
   * Abort signals are silently swallowed.
   *
   * @param context - Raw input validated and wrapped into a {@link @nhtio/adk!TurnContext} before execution.
   * @throws {@link @nhtio/adk!E_INVALID_TURN_CONTEXT} when `context` does not satisfy the schema.
   */
  async run(context: RawTurnContext): Promise<void> {
    const abortController = context.turnAbortController ?? new AbortController()

    // Forward declaration so openGate can reference turnContext.id before it is assigned.
    let turnContextId: string

    const openGate: OpenGateFn = <T>(raw: Omit<RawTurnGate, 'turnId' | 'abortSignal'>) => {
      const gate = new TurnGate<T>({
        ...raw,
        turnId: turnContextId,
        abortSignal: abortController.signal,
      })
      this.#observabilityEmitter.emit('turnGateOpen', gate)
      const promise = gate._promise()
      promise.then(
        () => {
          this.#observabilityEmitter.emit('turnGateClosed', {
            gateId: gate.id,
            turnId: gate.turnId,
            result: 'resolved',
            settledAt: DateTime.now(),
          })
        },
        (err: unknown) => {
          let result: 'rejected' | 'aborted' | 'timeout' = 'rejected'
          if (isInstanceOf(err, 'E_TURN_GATE_ABORTED')) result = 'aborted'
          else if (isInstanceOf(err, 'E_TURN_GATE_TIMEOUT')) result = 'timeout'
          this.#observabilityEmitter.emit('turnGateClosed', {
            gateId: gate.id,
            turnId: gate.turnId,
            result,
            settledAt: DateTime.now(),
          })
        }
      )
      return promise
    }

    const tools = new ToolRegistry(this.#config.tools)

    const turnContext = new TurnContext(
      { ...context, turnAbortController: abortController },
      {
        fetchMemories: this.#config.fetchMemoriesCallback,
        fetchMessages: this.#config.fetchMessagesCallback,
        fetchThoughts: this.#config.fetchThoughtsCallback,
        fetchToolCalls: this.#config.fetchToolCallsCallback,
        fetchTools: this.#config.fetchToolsCallback,
        refreshStandingInstructions: this.#config.refreshStandingInstructionsCallback,
        storeStandingInstruction: this.#config.storeStandingInstructionCallback,
        mutateStandingInstruction: this.#config.mutateStandingInstructionCallback,
        deleteStandingInstruction: this.#config.deleteStandingInstructionCallback,
        storeMemory: this.#config.storeMemoryCallback,
        mutateMemory: this.#config.mutateMemoryCallback,
        deleteMemory: this.#config.deleteMemoryCallback,
        fetchRetrievables: this.#config.fetchRetrievablesCallback,
        storeRetrievable: this.#config.storeRetrievableCallback,
        mutateRetrievable: this.#config.mutateRetrievableCallback,
        deleteRetrievable: this.#config.deleteRetrievableCallback,
        storeMessage: this.#config.storeMessageCallback,
        mutateMessage: this.#config.mutateMessageCallback,
        deleteMessage: this.#config.deleteMessageCallback,
        storeThought: this.#config.storeThoughtCallback,
        mutateThought: this.#config.mutateThoughtCallback,
        deleteThought: this.#config.deleteThoughtCallback,
        storeToolCall: this.#config.storeToolCallCallback,
        mutateToolCall: this.#config.mutateToolCallCallback,
        deleteToolCall: this.#config.deleteToolCallCallback,
        emitMessage: (content) => this.#functionalEmitter.emit('message', content),
        emitThought: (content) => this.#functionalEmitter.emit('thought', content),
        emitToolCall: (content) => this.#functionalEmitter.emit('toolCall', content),
        emitToolExecutionStart: (event) =>
          this.#observabilityEmitter.emit('toolExecutionStart', event),
        emitToolExecutionEnd: (event) => this.#observabilityEmitter.emit('toolExecutionEnd', event),
        openGate,
        tools,
      }
    )

    turnContextId = turnContext.id

    const startedAt = DateTime.now()
    this.#observabilityEmitter.emit('turnStart', { turnId: turnContext.id, startedAt })

    const emitTurnEnd = () => {
      const endedAt = DateTime.now()
      this.#observabilityEmitter.emit('turnEnd', {
        turnId: turnContext.id,
        startedAt,
        endedAt,
        durationMs: endedAt.diff(startedAt).milliseconds,
      })
    }

    // 1. Input pipeline
    let inputFailed = false
    let inputReached = false
    await this.#inputRunner
      .errorHandler(async (error) => {
        if (!isError(error) || !isInstanceOf(error, 'AbortError')) {
          inputFailed = true
          const err = new E_INPUT_PIPELINE_ERROR({
            cause: isError(error) ? error : undefined,
          })
          this.#observabilityEmitter.emit('error', err)
        }
      })
      .finalHandler(async () => {
        inputReached = true
      })
      .run((fn, next) => Promise.resolve(fn(turnContext, next)))

    if (!inputReached && !inputFailed && !turnContext.aborted) {
      inputFailed = true
      const err = new E_PIPELINE_SHORT_CIRCUITED(['turn-input'])
      this.#observabilityEmitter.emit('error', err)
    }

    if (inputFailed || turnContext.aborted) {
      emitTurnEnd()
      return
    }

    // 2. LLM execution dispatch
    let dispatchFailed = false
    try {
      await DispatchRunner.dispatch({
        source: turnContext,
        executor: this.#config.executorCallback,
        turnInputPipeline: this.#config.dispatchInputPipeline,
        turnOutputPipeline: this.#config.dispatchOutputPipeline,
        observers: {
          dispatchStart: [
            (e) => {
              this.#observabilityEmitter.emit('dispatchStart', e)
            },
          ],
          dispatchEnd: [
            (e) => {
              this.#observabilityEmitter.emit('dispatchEnd', e)
            },
          ],
          iterationStart: [
            (e) => {
              this.#observabilityEmitter.emit('iterationStart', e)
            },
          ],
          iterationEnd: [
            (e) => {
              this.#observabilityEmitter.emit('iterationEnd', e)
            },
          ],
          log: [
            (e) => {
              this.#observabilityEmitter.emit('log', e)
            },
          ],
        },
      })
    } catch (err) {
      dispatchFailed = true
      const wrapped = isInstanceOf(err, 'BaseException') ? (err as InstanceType<typeof Error>) : err
      this.#observabilityEmitter.emit('error', wrapped as any)
    }

    if (dispatchFailed || turnContext.aborted) {
      emitTurnEnd()
      return
    }

    // 3. Output pipeline
    let outputFailed = false
    let outputReached = false
    await this.#outputRunner
      .errorHandler(async (error) => {
        if (!isError(error) || !isInstanceOf(error, 'AbortError')) {
          outputFailed = true
          const err = new E_OUTPUT_PIPELINE_ERROR({
            cause: isError(error) ? error : undefined,
          })
          this.#observabilityEmitter.emit('error', err)
        }
      })
      .finalHandler(async () => {
        outputReached = true
      })
      .run((fn, next) => Promise.resolve(fn(turnContext, next)))

    if (!outputReached && !outputFailed && !turnContext.aborted) {
      const err = new E_PIPELINE_SHORT_CIRCUITED(['turn-output'])
      this.#observabilityEmitter.emit('error', err)
    }

    emitTurnEnd()
  }
}
