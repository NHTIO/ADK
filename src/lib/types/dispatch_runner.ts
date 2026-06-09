import type { DateTime } from 'luxon'
import type { NextFn } from '@nhtio/middleware'
import type { HookHandler } from '@nhtio/hooks'
import type { Memory } from '../classes/memory'
import type { Message } from '../classes/message'
import type { Thought } from '../classes/thought'
import type { ToolCall } from '../classes/tool_call'
import type { Retrievable } from '../classes/retrievable'
import type { Tokenizable } from '../classes/tokenizable'
import type { BaseException } from '../classes/base_exception'
import type { DispatchContext } from '../contracts/dispatch_context'
import type {
  TurnStreamableContent,
  TurnToolCallContent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
} from './turn_runner'

/**
 * Middleware function signature for the input and output pipelines in {@link @nhtio/adk!DispatchRunner}.
 *
 * @remarks
 * Receives the active {@link @nhtio/adk!DispatchContext} and a `next` callback to advance the pipeline.
 * Middleware can inspect `ctx.isSignalled` to bail early when an earlier middleware or the
 * executor has called `ctx.ack()` / `ctx.nack()`, and `ctx.aborted` for external cancellation.
 * Use `ctx.iteration` and `ctx.toolCallCount(checksum)` to implement iteration bounds and
 * checksum-repeat bounds in your own middleware — the runner itself does not impose either.
 */
export type DispatchPipelineMiddlewareFn = (
  ctx: DispatchContext,
  next: NextFn
) => void | Promise<void>

/**
 * Per-dispatch helpers passed to {@link DispatchExecutorFn} alongside the active
 * {@link @nhtio/adk!DispatchContext}.
 *
 * @remarks
 * `DispatchRunner` constructs a fresh helpers instance for every dispatch and threads it
 * through every iteration of that dispatch. Per-id stream state is scoped to the dispatch —
 * helpers are garbage-collected with the runner, so cross-dispatch state cannot leak.
 *
 * Helpers are **emit-only**: they call `ctx.emitMessage` / `ctx.emitThought` /
 * `ctx.emitToolCall` to surface streaming content. They do not persist `Message` / `Thought` /
 * `ToolCall` records, because building those records requires implementation-specific fields
 * (`role`, `identity`, `SpooledArtifact` for results) that the wire payload doesn't carry. The
 * executor calls `ctx.storeMessage(...)` / `ctx.storeThought(...)` / `ctx.storeToolCall(...)`
 * itself when it has the full record assembled.
 *
 * The value the helpers add is per-id accumulation state. Without them, every executor
 * reimplements a per-id `Map<id, { full, createdAt, ... }>` to track streaming chunks across
 * SDK callbacks.
 */
export interface DispatchExecutorHelpers {
  /**
   * Append a delta to the message stream for `id` and emit a {@link @nhtio/adk!TurnStreamableContent}.
   *
   * @remarks
   * On the first call for `id`, creates the stream with `createdAt` / `updatedAt` set to now
   * and `full` equal to `deltaText`. On subsequent calls, appends `deltaText` to the
   * accumulated `full` and updates `updatedAt`. When `opts.isComplete` is true, sets
   * `completedAt` and seals the stream — subsequent calls for the same `id` will throw.
   *
   * @param id - Stable identifier for this message stream.
   * @param deltaText - The new chunk to append.
   * @param opts.isComplete - When true, this is the final chunk for `id`.
   */
  reportMessage(id: string, deltaText: string, opts?: { isComplete?: boolean }): void

  /**
   * Append a delta to the thought stream for `id` and emit a {@link @nhtio/adk!TurnStreamableContent}.
   *
   * @remarks
   * Same accumulation semantics as {@link DispatchExecutorHelpers.reportMessage} but emits via
   * `ctx.emitThought`. Used for reasoning trace chunks that the executor wants to surface but
   * not show to the end user.
   *
   * @param id - Stable identifier for this thought stream.
   * @param deltaText - The new chunk to append.
   * @param opts.isComplete - When true, this is the final chunk for `id`.
   */
  reportThought(id: string, deltaText: string, opts?: { isComplete?: boolean }): void

  /**
   * Update tool call state for `id` and emit a {@link @nhtio/adk!TurnToolCallContent}.
   *
   * @remarks
   * Accepts a partial of the tool call fields; the helper merges into the per-id state and
   * emits the merged view. Typical usage is two calls: one with `{ tool, args }` to announce
   * the requested call (helper auto-computes `checksum` via SHA-256 of
   * `JSON.stringify({tool, args})`), and one with `{ results, isComplete: true, isError? }`
   * after the tool runs.
   *
   * Calls after `isComplete: true` will throw — the per-id state is sealed.
   *
   * @param id - Stable identifier for this tool call (correlates request with result).
   * @param partial - Fields to merge into the tool call state.
   */
  reportToolCall(
    id: string,
    partial: {
      tool?: string
      args?: unknown
      /**
       * Shape depends on the tool kind backing this call.
       *
       * @remarks
       * For a normal {@link @nhtio/adk!Tool} call, this is typically a
       * {@link @nhtio/adk!SpooledArtifact} (single or array — a
       * tool may legitimately spool multiple bounded artifacts in a single call) wrapping
       * the bytes returned by the handler, or one or more {@link @nhtio/adk!Media}
       * instances when the handler chose the explicit-modality return path. For an
       * {@link @nhtio/adk!ArtifactTool} call, this should be the raw
       * string the handler emitted (`Tokenizable.toString()`-equivalent — already the
       * model-visible answer). Type stays `unknown` to keep the wire-side payload narrow.
       */
      results?: unknown
      isError?: boolean
      isComplete?: boolean
    }
  ): void

  /**
   * Emit a structured log event for the current dispatch.
   *
   * @remarks
   * `trace` / `debug` / `info` / `warn` / `error` mirror the standard syslog severity levels.
   * Each call routes through the runner's observability bus as a `log` event so middleware,
   * tests, and consumer observability stacks can subscribe without monkey-patching the
   * executor. The runner enriches every emission with the active `dispatchId` and 0-based
   * `iteration` index — call sites only need to supply a `kind` discriminator, a human-readable
   * message, and an optional structured `payload`.
   *
   * The `log` channel is the canonical egress for executor-side diagnostics — retry decisions,
   * idle / request-timeout fires, HTTP error bodies, SSE chunk anomalies, provider-quirk
   * warnings, context-window perBucket breakdowns. Use it instead of `console.*`.
   */
  log: DispatchExecutorLogChannel

  /**
   * Emit a provider-agnostic {@link GenerationStats} record for the generation that just
   * completed this iteration (token usage, wall-clock durations, finish reason).
   *
   * @remarks
   * A dedicated egress for *generation accounting*, distinct from the diagnostic `log` channel:
   * subscribers (cost meters, latency dashboards, token-budget guards) listen on the runner's
   * `generationStats` observability hook without string-matching a log `kind`. The runner
   * enriches every emission with the active `dispatchId` and 0-based `iteration` index, mirroring
   * {@link DispatchExecutorHelpers.log}.
   *
   * Emit-only and side-effect-only — like `log`, it never throws, never mutates the
   * {@link @nhtio/adk!DispatchContext}, and never participates in ack / nack flow. Every field on
   * {@link GenerationStats} is optional, so a provider supplies only what its wire format reports
   * (e.g. OpenAI surfaces token counts but no durations; Ollama surfaces both). Call it at most
   * once per generation, after the response (or stream) has settled.
   */
  reportGenerationStats(stats: GenerationStats): void
}

/**
 * Severity of a structured log event emitted by an executor via {@link DispatchExecutorHelpers.log}.
 *
 * @remarks
 * Mirrors the lowercase syslog-style level vocabulary every JS logger converges on
 * (`pino`, `winston`, `bunyan`, `loglevel`). Consumers filter on the `level` field of the
 * delivered event — there is no per-level configuration on the channel itself.
 */
export type DispatchExecutorLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/**
 * Per-call structured payload for {@link DispatchExecutorLogChannel}.
 *
 * @remarks
 * `kind` is a short, stable discriminator the executor authored — observability middleware
 * matches on it to filter / group / aggregate events without parsing the human-readable
 * `message`. `payload` is the structured detail block; it is delivered to subscribers verbatim
 * (the runner never inspects it).
 */
export interface DispatchExecutorLogEntry {
  /** Stable discriminator authored by the executor (e.g. `'retry-attempt'`, `'http-error'`). */
  kind: string
  /** Human-readable message — safe to surface in logs or test failure output. */
  message: string
  /** Optional structured detail block. Delivered to subscribers verbatim. */
  payload?: Record<string, unknown>
}

/**
 * Five-level log channel exposed on {@link DispatchExecutorHelpers}.
 *
 * @remarks
 * Each method emits a `log` observability event with the corresponding `level`. Implementations
 * are non-blocking and side-effect-only — they never throw, never modify the
 * {@link @nhtio/adk!DispatchContext}, and never participate in ack / nack flow.
 */
export interface DispatchExecutorLogChannel {
  /** Emit a `trace`-level structured log event. */
  trace(entry: DispatchExecutorLogEntry): void
  /** Emit a `debug`-level structured log event. */
  debug(entry: DispatchExecutorLogEntry): void
  /** Emit an `info`-level structured log event. */
  info(entry: DispatchExecutorLogEntry): void
  /** Emit a `warn`-level structured log event. */
  warn(entry: DispatchExecutorLogEntry): void
  /** Emit an `error`-level structured log event. */
  error(entry: DispatchExecutorLogEntry): void
}

/**
 * Payload fired on the observability `log` hook for every structured event emitted via
 * {@link DispatchExecutorHelpers.log}.
 *
 * @remarks
 * Enriched by the runner with the active `dispatchId` and 0-based `iteration` index so
 * subscribers can correlate events across multiple in-flight dispatches without threading
 * extra context themselves.
 */
export interface LogEvent {
  /** Stable identifier for the dispatch that produced the event. */
  dispatchId: string
  /** 0-based iteration index within the dispatch. */
  iteration: number
  /** When the event was emitted. */
  emittedAt: DateTime
  /** Severity level the executor selected. */
  level: DispatchExecutorLogLevel
  /** Stable discriminator authored by the executor. */
  kind: string
  /** Human-readable message. */
  message: string
  /** Optional structured detail block. */
  payload?: Record<string, unknown>
}

/**
 * Provider-agnostic generation accounting for a single completed generation, emitted via
 * {@link DispatchExecutorHelpers.reportGenerationStats}.
 *
 * @remarks
 * Every field is optional so each battery supplies only what its wire format reports — OpenAI
 * Chat Completions surfaces token counts (its `usage` block) but no wall-clock durations; Ollama's
 * native `/api/chat` surfaces both token counts and nanosecond durations on its terminal chunk.
 *
 * Durations are carried in their **native nanosecond** unit (the `Ns` suffix is load-bearing) and
 * are never normalised here — normalising to milliseconds would be lossy and providers without
 * durations would gain meaningless zeros. `raw` preserves the full provider-native stats object
 * verbatim for forward-compatibility, so a subscriber can read a field this shape has not yet
 * promoted to a typed member.
 */
export interface GenerationStats {
  /** Tokens in the prompt / input (OpenAI `usage.prompt_tokens`, Ollama `prompt_eval_count`). */
  promptTokens?: number
  /** Tokens in the completion / output (OpenAI `usage.completion_tokens`, Ollama `eval_count`). */
  completionTokens?: number
  /** Total tokens, when the provider reports a combined figure. */
  totalTokens?: number
  /** Total wall-clock generation time in nanoseconds (Ollama `total_duration`). */
  totalDurationNs?: number
  /** Time spent loading the model in nanoseconds (Ollama `load_duration`). */
  loadDurationNs?: number
  /** Time spent evaluating the prompt in nanoseconds (Ollama `prompt_eval_duration`). */
  promptEvalDurationNs?: number
  /** Time spent generating the response in nanoseconds (Ollama `eval_duration`). */
  evalDurationNs?: number
  /** Why generation stopped (Ollama `done_reason`, OpenAI `finish_reason`). */
  finishReason?: string
  /** Model identifier the provider echoed back. */
  model?: string
  /** Stable provider discriminator (e.g. `'ollama'`, `'openai_chat_completions'`). */
  provider?: string
  /** Full provider-native stats object, verbatim, for forward-compatibility. */
  raw?: Record<string, unknown>
}

/**
 * Payload fired on the observability `generationStats` hook for every record emitted via
 * {@link DispatchExecutorHelpers.reportGenerationStats}.
 *
 * @remarks
 * The runner enriches the executor-supplied {@link GenerationStats} with the active `dispatchId`
 * and 0-based `iteration` index (and an `emittedAt` timestamp) so subscribers can correlate stats
 * across multiple in-flight dispatches without threading extra context — exactly as {@link LogEvent}
 * does for the `log` channel.
 */
export interface GenerationStatsEvent extends GenerationStats {
  /** Stable identifier for the dispatch that produced the event. */
  dispatchId: string
  /** 0-based iteration index within the dispatch. */
  iteration: number
  /** When the event was emitted. */
  emittedAt: DateTime
}

/**
 * The user-supplied callback that performs the actual LLM API call within a dispatch.
 *
 * @remarks
 * Invoked between the input and output middleware pipelines on every iteration. Receives the
 * active {@link @nhtio/adk!DispatchContext} and an {@link DispatchExecutorHelpers} object that manages
 * per-id streaming state for the dispatch. The executor's responsibilities:
 *
 * 1. Make the actual LLM API / SDK call (the ADK has no opinion on which provider).
 * 2. Normalise streaming responses into `TurnStreamableContent` / `TurnToolCallContent` shapes
 *    and report them via the helpers.
 * 3. Persist the resulting `Message` / `Thought` / `ToolCall` records via `ctx.storeMessage` /
 *    `ctx.storeThought` / `ctx.storeToolCall` once the implementation-specific fields are
 *    known.
 * 4. Decide when the loop is done — typically `ctx.ack()` after a response with no further
 *    tool calls, or `ctx.nack(err)` on failure. The runner will loop again if neither signal
 *    nor abort fires.
 *
 * Wired into a `TurnRunner` via `TurnRunnerConfig.executorCallback`. Invoked once per
 * iteration inside `DispatchRunner.dispatch()`, between the input and output middleware
 * pipelines.
 */
export type DispatchExecutorFn = (
  ctx: DispatchContext,
  helpers: DispatchExecutorHelpers
) => void | Promise<void>

// ── Delta types (internal — used by the runner's bubble queue) ──────────────

/**
 * The operation kind for a queued delta. Internal — not exported from any barrel.
 *
 * @internal
 */
export type DeltaOp = 'store' | 'mutate' | 'delete'

/**
 * The entity kind for a queued delta. Internal — not exported from any barrel.
 *
 * @internal
 */
export type DeltaType =
  | 'standingInstruction'
  | 'memory'
  | 'retrievable'
  | 'message'
  | 'thought'
  | 'toolCall'

/**
 * A single queued mutation awaiting application to a parent `TurnContext`. The `value` field is
 * the entity for `store` / `mutate` ops, or the id string for `delete` ops. Internal — not
 * exported from any barrel.
 *
 * @internal
 */
export interface ContextDelta {
  op: DeltaOp
  type: DeltaType
  value: string | Tokenizable | Memory | Retrievable | Message | Thought | ToolCall
}

// ── Observability event payloads ─────────────────────────────────────────────

/**
 * Payload fired when a dispatch begins.
 */
export interface DispatchStartEvent {
  /** Stable identifier for this dispatch (UUIDv6). */
  dispatchId: string
  /** When the dispatch began. */
  startedAt: DateTime
}

/**
 * Payload fired when a dispatch ends — successfully, by error, or by abort.
 */
export interface DispatchEndEvent {
  /** Stable identifier for this dispatch. */
  dispatchId: string
  /** How the dispatch settled. */
  status: 'ack' | 'nack' | 'aborted'
  /** The error stored by `ctx.nack(error)`, or `undefined` for `ack` / `aborted`. */
  error?: Error
  /** Total iterations that ran during this dispatch. */
  iterations: number
  /** When the dispatch began. */
  startedAt: DateTime
  /** When the dispatch ended. */
  endedAt: DateTime
  /** Duration in milliseconds. */
  durationMs: number
}

/**
 * Payload fired at the start of each iteration within a dispatch.
 */
export interface IterationStartEvent {
  /** Stable identifier for the parent dispatch. */
  dispatchId: string
  /** 0-based iteration index within the dispatch. */
  iteration: number
  /** When this iteration began. */
  startedAt: DateTime
}

/**
 * Payload fired at the end of each iteration within a dispatch.
 */
export interface IterationEndEvent {
  /** Stable identifier for the parent dispatch. */
  dispatchId: string
  /** 0-based iteration index within the dispatch. */
  iteration: number
  /** When this iteration began. */
  startedAt: DateTime
  /** When this iteration ended. */
  endedAt: DateTime
  /** Duration in milliseconds. */
  durationMs: number
}

// ── Hook event maps ──────────────────────────────────────────────────────────

/**
 * Functional hook events on {@link @nhtio/adk!DispatchRunner}.
 *
 * @remarks
 * Pipeline-affecting events forwarded from the {@link @nhtio/adk!DispatchContext}. Register handlers
 * via the `hooks` field of the dispatch input.
 */
export type DispatchRunnerFunctionalHooks = {
  /** Fired for every streaming message chunk. Forwarded from the context. */
  message: [[TurnStreamableContent], []]
  /** Fired for every reasoning trace chunk. Forwarded from the context. */
  thought: [[TurnStreamableContent], []]
  /** Fired for every tool call (on request and on settlement). Forwarded from the context. */
  toolCall: [[TurnToolCallContent], []]
}

/**
 * Observability hook events on {@link @nhtio/adk!DispatchRunner}.
 *
 * @remarks
 * Instrumentation-only events. Register handlers via the `observers` field of the dispatch
 * input. Removing an observer does not affect dispatch correctness.
 */
export type DispatchRunnerObservabilityHooks = {
  /** Forwarded from the context immediately before a tool handler is called. */
  toolExecutionStart: [[ToolExecutionStartEvent], []]
  /** Forwarded from the context after a tool handler returns or throws. */
  toolExecutionEnd: [[ToolExecutionEndEvent], []]
  /** Fired at the start of each iteration. */
  iterationStart: [[IterationStartEvent], []]
  /** Fired at the end of each iteration. */
  iterationEnd: [[IterationEndEvent], []]
  /** Fired once when the dispatch begins. */
  dispatchStart: [[DispatchStartEvent], []]
  /** Fired once when the dispatch ends (ack / nack / aborted). */
  dispatchEnd: [[DispatchEndEvent], []]
  /** Fired when a non-fatal pipeline or executor error occurs. The exception is also re-thrown. */
  error: [[BaseException], []]
  /** Fired for every structured log event emitted by the executor via {@link DispatchExecutorHelpers.log}. */
  log: [[LogEvent], []]
  /** Fired for every generation-stats record emitted via {@link DispatchExecutorHelpers.reportGenerationStats}. */
  generationStats: [[GenerationStatsEvent], []]
}

/**
 * Optional functional hook registrations supplied to {@link @nhtio/adk!DispatchRunner.dispatch}.
 */
export type DispatchRunnerFunctionalHookRegistrations = {
  [E in keyof DispatchRunnerFunctionalHooks]?:
    | HookHandler<DispatchRunnerFunctionalHooks[E][0], DispatchRunnerFunctionalHooks[E][1]>
    | HookHandler<DispatchRunnerFunctionalHooks[E][0], DispatchRunnerFunctionalHooks[E][1]>[]
}

/**
 * Optional observability hook registrations supplied to {@link @nhtio/adk!DispatchRunner.dispatch}.
 */
export type DispatchRunnerObservabilityHookRegistrations = {
  [E in keyof DispatchRunnerObservabilityHooks]?:
    | HookHandler<DispatchRunnerObservabilityHooks[E][0], DispatchRunnerObservabilityHooks[E][1]>
    | HookHandler<DispatchRunnerObservabilityHooks[E][0], DispatchRunnerObservabilityHooks[E][1]>[]
}
