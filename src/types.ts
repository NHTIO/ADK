/**
 * Type-only export surface for raw shapes, callbacks, events, hooks, and internal contracts.
 *
 * @module @nhtio/adk/types
 *
 * @remarks
 * Type-only barrel — re-exports every shape consumers might annotate against: raw constructor
 * inputs, callback function signatures, event payloads, hook event maps, middleware function
 * signatures, validator-resolved configuration shapes, and the runtime-internal context/exception
 * types (`TurnContext`, `DispatchContext`, `BaseException`, `TurnGate`) for which only a
 * type and a runtime guard (see the `guards` barrel) are exposed.
 *
 * No runtime values are re-exported here; importing this barrel produces no JavaScript output
 * after type-erasure. Use this when you want one place to grab types without dragging in the
 * corresponding runtime classes.
 */

// ── Internal-primitive types (no runtime class export) ────────────────────────

export type { BaseException } from './lib/classes/base_exception'
/**
 * @primaryExport
 */
export type { TurnContext } from './lib/contracts/turn_runner_context'
/**
 * @primaryExport
 */
export type { DispatchContext } from './lib/contracts/dispatch_context'
export type { TurnGate } from './lib/classes/turn_gate'

// ── Raw constructor inputs ────────────────────────────────────────────────────

export type { RawIdentity } from './lib/classes/identity'
export type { RawMemory } from './lib/classes/memory'
export type { RawMessage, MessageRole } from './lib/classes/message'
export type { RawThought } from './lib/classes/thought'
export type { RawToolCall } from './lib/classes/tool_call'
export type { RawTool, ToolHandler } from './lib/classes/tool'
export type { RawArtifactTool, ArtifactToolHandler } from './lib/classes/artifact_tool'
export type { MergeOptions } from './lib/classes/tool_registry'
export type {
  SpooledArtifactConstructor,
  ToolMethodDescriptor,
} from './lib/classes/spooled_artifact'
export type { RawTurnGate } from './lib/classes/turn_gate'

// ── Spool / artifact types ────────────────────────────────────────────────────

export type { SpoolReader } from './lib/contracts/spool_reader'
export type { JsonArtifactFormat } from './lib/classes/spooled_json_artifact'
export type {
  MarkdownHeadingEntry,
  MarkdownCodeEntry,
  MarkdownSection,
} from './lib/classes/spooled_markdown_artifact'

// ── Tokenizable ───────────────────────────────────────────────────────────────

export type { TokenEncoding, TokenEncodingId, TokenEstimatorFn } from './lib/classes/tokenizable'

// ── TurnContext callback fn types ─────────────────────────────────────────────

/**
 * @primaryExport
 */
export type {
  RawTurnContext,
  ResolvedTurnContext,
  MemoryRetrievalFn,
  MessageRetrievalFn,
  ThoughtRetrievalFn,
  ToolCallRetrievalFn,
  ToolsRetrievalFn,
  RetrievableRetrievalFn,
  StandingInstructionsRefreshFn,
  StandingInstructionStoreFn,
  StandingInstructionMutateFn,
  StandingInstructionDeleteFn,
  MemoryStoreFn,
  MemoryMutateFn,
  MemoryDeleteFn,
  MessageStoreFn,
  MessageMutateFn,
  MessageDeleteFn,
  ThoughtStoreFn,
  ThoughtMutateFn,
  ThoughtDeleteFn,
  ToolCallStoreFn,
  ToolCallMutateFn,
  ToolCallDeleteFn,
  RetrievableStoreFn,
  RetrievableMutateFn,
  RetrievableDeleteFn,
  MediaBytesStoreFn,
  RetrievableBytesStoreFn,
} from './lib/contracts/turn_runner_context'

// ── TurnRunner config + event types ───────────────────────────────────────────

export type { TurnRunnerConfig, ResolvedTurnRunnerConfig } from './lib/contracts/turn_runner_config'

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
} from './lib/types/turn_runner'

// ── DispatchContext callback fn types + hook maps ─────────────────────────

/**
 * @primaryExport
 */
export type {
  RawDispatchContext,
  DispatchMemoryRetrievalFn,
  DispatchMessageRetrievalFn,
  DispatchThoughtRetrievalFn,
  DispatchToolCallRetrievalFn,
  DispatchToolsRetrievalFn,
  DispatchStandingInstructionsRefreshFn,
  DispatchStandingInstructionStoreFn,
  DispatchStandingInstructionMutateFn,
  DispatchStandingInstructionDeleteFn,
  DispatchMemoryStoreFn,
  DispatchMemoryMutateFn,
  DispatchMemoryDeleteFn,
  DispatchRetrievableRetrievalFn,
  DispatchRetrievableStoreFn,
  DispatchRetrievableMutateFn,
  DispatchRetrievableDeleteFn,
  DispatchMessageStoreFn,
  DispatchMessageMutateFn,
  DispatchMessageDeleteFn,
  DispatchThoughtStoreFn,
  DispatchThoughtMutateFn,
  DispatchThoughtDeleteFn,
  DispatchToolCallStoreFn,
  DispatchToolCallMutateFn,
  DispatchToolCallDeleteFn,
  DispatchMediaBytesStoreFn,
  DispatchRetrievableBytesStoreFn,
  ConduitBytes,
} from './lib/contracts/dispatch_context'

/**
 * @primaryExport
 */
export type {
  DispatchContextHooks,
  DispatchContextHookRegistrations,
} from './lib/types/dispatch_context'

// ── DispatchRunner dispatch input + event + hook types ────────────────────

export type { RawDispatchRunnerInput } from './lib/dispatch_runner'

export type {
  DispatchPipelineMiddlewareFn,
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  DispatchExecutorLogChannel,
  DispatchExecutorLogEntry,
  DispatchExecutorLogLevel,
  LogEvent,
  WarningEvent,
  DispatchStartEvent,
  DispatchEndEvent,
  IterationStartEvent,
  IterationEndEvent,
  DispatchRunnerFunctionalHooks,
  DispatchRunnerObservabilityHooks,
  DispatchRunnerFunctionalHookRegistrations,
  DispatchRunnerObservabilityHookRegistrations,
} from './lib/types/dispatch_runner'
