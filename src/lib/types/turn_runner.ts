import type { DateTime } from 'luxon'
import type { NextFn } from '@nhtio/middleware'
import type { BaseException } from '../classes/base_exception'
import type { TurnGate, RawTurnGate } from '../classes/turn_gate'
import type { TurnContext } from '../contracts/turn_runner_context'
import type { EventMap, Key, Listener } from '@nhtio/tiny-typed-emitter'
import type {
  DispatchStartEvent,
  DispatchEndEvent,
  IterationStartEvent,
  IterationEndEvent,
  LogEvent,
} from './dispatch_runner'

/**
 * Middleware function signature for the input and output pipelines in a {@link @nhtio/adk!TurnRunner}.
 *
 * @param ctx - The mutable {@link @nhtio/adk!TurnContext} for the current turn.
 * @param next - Callback to advance to the next middleware in the chain.
 */
export type TurnPipelineMiddlewareFn = (ctx: TurnContext, next: NextFn) => void | Promise<void>

/**
 * A unit of streamable content emitted during a turn.
 *
 * @remarks
 * Each emission represents either a visible assistant message or an internal reasoning trace.
 * `aDelta` carries the incremental text since the last emission; `full` is the accumulated text
 * so far. `isComplete` is `true` on the final emission for a given `id`.
 */
export interface TurnStreamableContent {
  /** Stable identifier for this content stream; groups deltas from the same generation. */
  id: string
  /** Timestamp when this content stream was first created. */
  createdAt: DateTime
  /** Timestamp of the most recent delta received for this stream. */
  updatedAt: DateTime
  /** Full accumulated text received so far for this stream. */
  full: string
  /** Incremental text added since the previous emission. */
  aDelta: string
  /** `true` on the final chunk for this `id`; subsequent emissions will use a new `id`. */
  isComplete: boolean
  /** Timestamp when the stream completed. Absent until `isComplete` is `true`. */
  completedAt?: DateTime
}

/**
 * A tool call invocation emitted during a turn, including its result once available.
 *
 * @remarks
 * Emitted at least once when the model requests a tool call. The same `id` is re-emitted with
 * `results` populated and `isComplete` set to `true` after the tool has been executed. If
 * execution fails, `isError` is `true` and `results` contains the error detail.
 */
export interface TurnToolCallContent {
  /**
   * Stable stream id for this tool call; ties the initial request to its result on **this** bus
   * (the announce emission and the completion emission share it). This is the model/stream id, not
   * a cross-bus key — to correlate with the observability `toolExecution*` events, use `checksum`.
   */
  id: string
  /** Name of the tool the model has requested. */
  tool: string
  /** Arguments the model supplied for the tool call. */
  args: unknown
  /**
   * `sha256({ tool, args })` over the raw arguments. Doubles as the **cross-bus join key**: equal to
   * {@link ToolExecutionStartEvent.callId} / {@link ToolExecutionEndEvent.callId} and to
   * {@link @nhtio/adk!ToolCall.checksum}. Collides by design for identical `(tool, args)` within a
   * turn — that is what {@link @nhtio/adk!DispatchContext.toolCallCount} counts — so order or
   * disambiguate repeated calls by `createdAt` / `updatedAt`, not by `checksum` alone.
   */
  checksum: string
  /** Timestamp when this tool call was first emitted. */
  createdAt: DateTime
  /** Timestamp of the most recent update to this tool call (e.g. when results arrived). */
  updatedAt: DateTime
  /**
   * Result returned by the tool, or error detail when `isError` is `true`. Absent until execution
   * completes.
   *
   * @remarks
   * Shape depends on the underlying tool kind. For a normal {@link @nhtio/adk!Tool}
   * call, this carries one or more {@link @nhtio/adk!SpooledArtifact}
   * instances (single artifact or `SpooledArtifact[]`) wrapping the bytes returned by the handler,
   * or one or more {@link @nhtio/adk!Media} instances (single `Media` or
   * `Media[]`) when the handler took the explicit-modality return path. For an
   * {@link @nhtio/adk!ArtifactTool} call, this is the raw string the
   * handler emitted (`Tokenizable.toString()`-equivalent) — already the model-visible answer.
   * Type stays `unknown` to keep this event payload narrow; the underlying
   * `ToolCall.results` is `Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]`.
   *
   * @see {@link @nhtio/adk!ToolCall.results}
   */
  results?: unknown
  /** `true` once the tool call has finished (successfully or not). */
  isComplete: boolean
  /** `true` when the tool execution produced an error; inspect `results` for detail. */
  isError: boolean
  /** Timestamp when the tool call completed (successfully or not). */
  completedAt?: DateTime
}

/**
 * Payload emitted when a turn begins.
 */
export interface TurnStartEvent {
  /** The unique ID of the turn that started. */
  turnId: string
  /** When the turn started. */
  startedAt: DateTime
}

/**
 * Payload emitted when a turn ends.
 */
export interface TurnEndEvent {
  /** The unique ID of the turn that ended. */
  turnId: string
  /** When the turn started. */
  startedAt: DateTime
  /** When the turn ended. */
  endedAt: DateTime
  /** Duration of the turn in milliseconds. */
  durationMs: number
}

/**
 * Payload emitted on the observability bus when a tool's executor begins executing the handler.
 *
 * @remarks
 * Fired after arg validation passes and immediately before the handler is called.
 * `callId` is the cross-bus join key — equal to {@link TurnToolCallContent.checksum} and
 * {@link @nhtio/adk!ToolCall.checksum}, **not** {@link @nhtio/adk!ToolCall.id}. Fires for both
 * {@link @nhtio/adk!Tool} and {@link @nhtio/adk!ArtifactTool} invocations — the payload is identical.
 */
export interface ToolExecutionStartEvent {
  /** Name of the tool being executed. */
  toolName: string
  /** ID of the turn in which the tool is being executed. */
  turnId: string
  /**
   * Cross-bus join key: `sha256({ tool, args })`, identical to {@link TurnToolCallContent.checksum}
   * and {@link @nhtio/adk!ToolCall.checksum}. This is **not** {@link @nhtio/adk!ToolCall.id}. It
   * collides by design for identical `(tool, args)` within a turn — that is what
   * {@link @nhtio/adk!DispatchContext.toolCallCount} counts. Order or disambiguate repeated calls by
   * `startedAt`. Empty string when not provided.
   */
  callId: string
  /** The validated arguments that will be passed to the handler. */
  args: unknown
  /** When execution started. */
  startedAt: DateTime
}

/**
 * Payload emitted on the observability bus when a tool's executor finishes (successfully or not).
 *
 * @remarks
 * Fired after the handler returns or throws. When `isError` is `true`, the handler threw and the
 * error has been wrapped in {@link @nhtio/adk!E_TOOL_DOWNSTREAM_ERROR}. `callId` carries the same
 * cross-bus join key as {@link ToolExecutionStartEvent.callId}. Fires for both
 * {@link @nhtio/adk!Tool} and {@link @nhtio/adk!ArtifactTool} invocations — the payload is identical.
 */
export interface ToolExecutionEndEvent {
  /** Name of the tool that was executed. */
  toolName: string
  /** ID of the turn in which the tool was executed. */
  turnId: string
  /**
   * Cross-bus join key: `sha256({ tool, args })`, identical to {@link TurnToolCallContent.checksum}
   * and {@link @nhtio/adk!ToolCall.checksum}. This is **not** {@link @nhtio/adk!ToolCall.id}. It
   * collides by design for identical `(tool, args)` within a turn — that is what
   * {@link @nhtio/adk!DispatchContext.toolCallCount} counts. Order or disambiguate repeated calls by
   * `startedAt` / `endedAt`. Empty string when not provided.
   */
  callId: string
  /** When execution started. */
  startedAt: DateTime
  /** When execution ended. */
  endedAt: DateTime
  /** Duration of the execution in milliseconds. */
  durationMs: number
  /** `true` when the handler threw an error; the rejection reason is {@link @nhtio/adk!E_TOOL_DOWNSTREAM_ERROR}. */
  isError: boolean
}

/**
 * Payload emitted when a {@link @nhtio/adk!TurnGate} settles (resolved, rejected, aborted, or timed out).
 */
export interface TurnGateClosedEvent {
  /** ID of the gate that settled. */
  gateId: string
  /** ID of the turn that owned the gate. */
  turnId: string
  /** How the gate settled. */
  result: 'resolved' | 'rejected' | 'aborted' | 'timeout'
  /** When the gate settled. */
  settledAt: DateTime
}

/**
 * A function that emits a `message` event on the {@link @nhtio/adk!TurnRunner}.
 *
 * @remarks
 * Injected into {@link @nhtio/adk!TurnContext} so middleware can surface streaming message chunks without
 * holding a reference to the runner or its emitter.
 */
export type EmitMessageFn = (content: TurnStreamableContent) => void

/**
 * A function that emits a `thought` event on the {@link @nhtio/adk!TurnRunner}.
 *
 * @remarks
 * Injected into {@link @nhtio/adk!TurnContext} so middleware can surface reasoning trace chunks without
 * holding a reference to the runner or its emitter.
 */
export type EmitThoughtFn = (content: TurnStreamableContent) => void

/**
 * A function that emits a `toolCall` event on the {@link @nhtio/adk!TurnRunner}.
 *
 * @remarks
 * Injected into {@link @nhtio/adk!TurnContext} so middleware can surface tool call lifecycle events —
 * both the initial request and the settled result — without holding a reference to the runner.
 */
export type EmitToolCallFn = (content: TurnToolCallContent) => void

/**
 * A function that emits a `toolExecutionStart` event on the {@link @nhtio/adk!TurnRunner} observability bus.
 *
 * @remarks
 * Injected into both {@link @nhtio/adk!TurnContext} and `DispatchContext` so `Tool.executor()` can emit
 * lifecycle events without holding a reference to the runner or its emitter. Tool execution
 * happens inside an LLM dispatch loop; `DispatchContext` is the canonical context the tool
 * handler receives.
 */
export type EmitToolExecutionStartFn = (event: ToolExecutionStartEvent) => void

/**
 * A function that emits a `toolExecutionEnd` event on the {@link @nhtio/adk!TurnRunner} observability bus.
 *
 * @remarks
 * Injected into both {@link @nhtio/adk!TurnContext} and `DispatchContext` so `Tool.executor()` can emit
 * lifecycle events without holding a reference to the runner or its emitter. Tool execution
 * happens inside an LLM dispatch loop; `DispatchContext` is the canonical context the tool
 * handler receives.
 */
export type EmitToolExecutionEndFn = (event: ToolExecutionEndEvent) => void

/**
 * A function that opens a {@link @nhtio/adk!TurnGate} for the current turn.
 *
 * @remarks
 * Injected into {@link @nhtio/adk!TurnContext} as `waitFor`. The runner closure supplies `turnId` and
 * `abortSignal` automatically — callers only provide the gate-specific fields.
 *
 * @typeParam T - The expected type of the resolution value.
 */
export type OpenGateFn = <T>(raw: Omit<RawTurnGate, 'turnId' | 'abortSignal'>) => Promise<T>

/**
 * Functional events emitted by {@link @nhtio/adk!TurnRunner} during a turn.
 *
 * @remarks
 * These events are pipeline-affecting and are registered via `on` / `off` / `once`.
 *
 * - `message` — a visible assistant message chunk; may be emitted at any point during the turn.
 * - `thought` — an internal reasoning/thinking trace chunk; may be emitted at any point during
 *   the turn. Not shown to end users by default.
 * - `toolCall` — emitted when the model requests a tool call and again when the result is
 *   available. Check {@link TurnToolCallContent.isComplete} to distinguish the two emissions.
 */
export type TurnEvents = EventMap<{
  message: [TurnStreamableContent]
  thought: [TurnStreamableContent]
  toolCall: [TurnToolCallContent]
}>

/**
 * Observability events emitted by {@link @nhtio/adk!TurnRunner} for instrumentation.
 *
 * @remarks
 * These events are for monitoring and instrumentation only and are registered via
 * `observe` / `unobserve` / `observeOnce`. They do not affect pipeline execution.
 *
 * - `turnStart` — emitted immediately before the input pipeline runs.
 * - `turnEnd` — emitted after the pipeline completes (or is aborted/errored).
 * - `turnGateOpen` — emitted when middleware calls `ctx.waitFor()`, opening a gate.
 * - `turnGateClosed` — emitted when a gate settles (resolved, rejected, aborted, or timed out).
 * - `toolExecutionStart` — emitted before a tool handler is called (after arg validation).
 * - `toolExecutionEnd` — emitted after a tool handler returns or throws.
 * - `error` — emitted when a non-fatal error occurs inside the input or output pipeline.
 * - `log` — emitted when the LLM executor (or anything wired through `helpers.log`) writes a
 *   structured observability record. Carries `dispatchId`, `iteration`, `emittedAt`, `level`,
 *   `kind`, `message`, and an optional `payload`.
 */
export type TurnObservabilityEvents = EventMap<{
  turnStart: [TurnStartEvent]
  turnEnd: [TurnEndEvent]
  turnGateOpen: [TurnGate]
  turnGateClosed: [TurnGateClosedEvent]
  toolExecutionStart: [ToolExecutionStartEvent]
  toolExecutionEnd: [ToolExecutionEndEvent]
  dispatchStart: [DispatchStartEvent]
  dispatchEnd: [DispatchEndEvent]
  iterationStart: [IterationStartEvent]
  iterationEnd: [IterationEndEvent]
  log: [LogEvent]
  error: [BaseException]
}>

/**
 * Valid event name keys for the {@link @nhtio/adk!TurnRunner} functional bus.
 *
 * @typeParam K - Inferred from the key of {@link TurnEvents}.
 */
export type TurnEvent<K> = Key<K, TurnEvents>

/**
 * Listener signature for a given {@link @nhtio/adk!TurnRunner} functional event.
 *
 * @typeParam K - The event key; inferred from the key of {@link TurnEvents}.
 */
export type TurnEventListener<K> = Listener<K, TurnEvents>

/**
 * Valid event name keys for the {@link @nhtio/adk!TurnRunner} observability bus.
 *
 * @typeParam K - Inferred from the key of {@link TurnObservabilityEvents}.
 */
export type TurnObservabilityEvent<K> = Key<K, TurnObservabilityEvents>

/**
 * Listener signature for a given {@link @nhtio/adk!TurnRunner} observability event.
 *
 * @typeParam K - The event key; inferred from the key of {@link TurnObservabilityEvents}.
 */
export type TurnObservabilityEventListener<K> = Listener<K, TurnObservabilityEvents>
