import type { HookHandler } from '@nhtio/hooks'
import type { Memory } from '../classes/memory'
import type { Message } from '../classes/message'
import type { Thought } from '../classes/thought'
import type { ToolCall } from '../classes/tool_call'
import type { Retrievable } from '../classes/retrievable'
import type { Tokenizable } from '../classes/tokenizable'
import type {
  TurnStreamableContent,
  TurnToolCallContent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
} from './turn_runner'

/**
 * Hook event map for {@link @nhtio/adk!DispatchContext}.
 *
 * @remarks
 * Each key maps to a tuple of `[HookArgs, CleanupArgs]`. These events mirror the functional and
 * observability events on {@link @nhtio/adk!TurnRunner} but are surfaced through `@nhtio/hooks` rather than
 * `TypedEventEmitter`, which allows the entire execution context to be garbage-collected once
 * execution completes — no lingering listener references.
 *
 * Mutation hooks (`stored*` / `mutated*` / `deleted*`) fire on every mutation in both standalone
 * and derived paths. The `DispatchRunner` subscribes to these hooks to queue deltas for
 * later bubbling to a parent `TurnContext`; users may subscribe for observability or testing.
 */
export type DispatchContextHooks = {
  /** Fired when a streaming message chunk is emitted during execution. */
  message: [[TurnStreamableContent], []]
  /** Fired when a reasoning trace chunk is emitted during execution. */
  thought: [[TurnStreamableContent], []]
  /** Fired when a tool call is emitted (on request and again on settlement). */
  toolCall: [[TurnToolCallContent], []]
  /** Fired immediately before a tool handler is called (after arg validation). */
  toolExecutionStart: [[ToolExecutionStartEvent], []]
  /** Fired after a tool handler returns or throws. */
  toolExecutionEnd: [[ToolExecutionEndEvent], []]
  /** Fired after a standing instruction is stored locally and persisted. */
  storedStandingInstruction: [[Tokenizable], []]
  /** Fired after a standing instruction is mutated locally and persisted. */
  mutatedStandingInstruction: [[Tokenizable], []]
  /** Fired after a standing instruction is removed locally and from persistence. */
  deletedStandingInstruction: [[Tokenizable], []]
  /** Fired after a memory is stored locally and persisted. */
  storedMemory: [[Memory], []]
  /** Fired after a memory is mutated locally and persisted. */
  mutatedMemory: [[Memory], []]
  /** Fired after a memory is removed locally and from persistence. Payload is the deleted id. */
  deletedMemory: [[string], []]
  /** Fired after a retrievable record is stored locally and persisted. */
  storedRetrievable: [[Retrievable], []]
  /** Fired after a retrievable record is mutated locally and persisted. */
  mutatedRetrievable: [[Retrievable], []]
  /** Fired after a retrievable record is removed locally and from persistence. Payload is the deleted id. */
  deletedRetrievable: [[string], []]
  /** Fired after a message is stored locally and persisted. */
  storedMessage: [[Message], []]
  /** Fired after a message is mutated locally and persisted. */
  mutatedMessage: [[Message], []]
  /** Fired after a message is removed locally and from persistence. Payload is the deleted id. */
  deletedMessage: [[string], []]
  /** Fired after a thought is stored locally and persisted. */
  storedThought: [[Thought], []]
  /** Fired after a thought is mutated locally and persisted. */
  mutatedThought: [[Thought], []]
  /** Fired after a thought is removed locally and from persistence. Payload is the deleted id. */
  deletedThought: [[string], []]
  /**
   * Fired after a tool call is stored locally and persisted.
   *
   * @remarks
   * `ToolCall`s with `fromArtifactTool === true` originated from an
   * {@link @nhtio/adk!ArtifactTool} invocation and carry a
   * {@link @nhtio/adk!Tokenizable} in `results` (NOT a
   * {@link @nhtio/adk!SpooledArtifact}). Subsequent
   * `SpooledArtifact.forgeTools(ctx)` calls filter these out of the `callId` enum to prevent
   * the artifact-grep-on-an-artifact-grep recursion.
   */
  storedToolCall: [[ToolCall], []]
  /**
   * Fired after a tool call is mutated locally and persisted.
   *
   * @remarks
   * See {@link DispatchContextHooks.storedToolCall} for the `fromArtifactTool` /
   * `Tokenizable`-shaped `results` invariant.
   */
  mutatedToolCall: [[ToolCall], []]
  /** Fired after a tool call is removed locally and from persistence. Payload is the deleted id. */
  deletedToolCall: [[string], []]
}

/**
 * Optional hook registrations supplied to {@link @nhtio/adk!DispatchContext} at construction time.
 *
 * @remarks
 * Each key may be a single handler or an array of handlers. Handlers are registered in order and
 * fired synchronously (fire-and-forget) on each corresponding emit call.
 */
export type DispatchContextHookRegistrations = {
  [E in keyof DispatchContextHooks]?:
    | HookHandler<DispatchContextHooks[E][0], DispatchContextHooks[E][1]>
    | HookHandler<DispatchContextHooks[E][0], DispatchContextHooks[E][1]>[]
}
