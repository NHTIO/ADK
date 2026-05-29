/**
 * Runtime type guards for ADK primitives, contexts, runners, tools, and artifacts.
 *
 * @module @nhtio/adk/guards
 *
 * @remarks
 * Type guards for every value-bearing primitive in the ADK. Each `is*` function is a
 * freestanding TypeScript type predicate (returns `value is X`) that delegates to the
 * cross-realm-safe {@link @nhtio/adk!isInstanceOf} helper.
 *
 * For internal primitives that are not exported as runtime classes (`BaseException`,
 * `TurnContext`, `DispatchContext`), the freestanding guard here is the canonical runtime
 * detection. For user-constructable classes (`Memory`, `Tool`, etc.) these freestanding guards
 * complement the static `ClassName.isClassName(value)` methods already on each class.
 */

import { Tool } from './lib/classes/tool'
import { Memory } from './lib/classes/memory'
import { TurnRunner } from './lib/turn_runner'
import { Message } from './lib/classes/message'
import { Thought } from './lib/classes/thought'
import { Registry } from './lib/classes/registry'
import { Identity } from './lib/classes/identity'
import { TurnGate } from './lib/classes/turn_gate'
import { ToolCall } from './lib/classes/tool_call'
import { DispatchRunner } from './lib/dispatch_runner'
import { Tokenizable } from './lib/classes/tokenizable'
import { ArtifactTool } from './lib/classes/artifact_tool'
import { ToolRegistry } from './lib/classes/tool_registry'
import { BaseException } from './lib/classes/base_exception'
import { SpooledArtifact } from './lib/classes/spooled_artifact'
import { TurnContext } from './lib/contracts/turn_runner_context'
import { DispatchContext } from './lib/contracts/dispatch_context'
import { SpooledJsonArtifact } from './lib/classes/spooled_json_artifact'
import { SpooledMarkdownArtifact } from './lib/classes/spooled_markdown_artifact'
import type { SpooledArtifactConstructor } from './lib/classes/spooled_artifact'

/**
 * @primaryExport
 */
export { isInstanceOf, isError, isObject } from './lib/utils/guards'
export { implementsSpoolReader } from './lib/contracts/spool_reader'

/** Returns `true` if `value` is a {@link @nhtio/adk!BaseException} instance. */
export const isBaseException = (value: unknown): value is BaseException =>
  BaseException.isBaseException(value)

/** Returns `true` if `value` is an {@link @nhtio/adk!Identity} instance. */
export const isIdentity = (value: unknown): value is Identity => Identity.isIdentity(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!Memory} instance. */
export const isMemory = (value: unknown): value is Memory => Memory.isMemory(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!Message} instance. */
export const isMessage = (value: unknown): value is Message => Message.isMessage(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!Registry} instance. */
export const isRegistry = (value: unknown): value is Registry => Registry.isRegistry(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!Thought} instance. */
export const isThought = (value: unknown): value is Thought => Thought.isThought(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!Tokenizable} instance. */
export const isTokenizable = (value: unknown): value is Tokenizable =>
  Tokenizable.isTokenizable(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!Tool} instance. */
export const isTool = (value: unknown): value is Tool => Tool.isTool(value)

/** Returns `true` if `value` is an {@link @nhtio/adk!ArtifactTool} instance. */
export const isArtifactTool = (value: unknown): value is ArtifactTool =>
  ArtifactTool.isArtifactTool(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!ToolCall} instance. */
export const isToolCall = (value: unknown): value is ToolCall => ToolCall.isToolCall(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!ToolRegistry} instance. */
export const isToolRegistry = (value: unknown): value is ToolRegistry =>
  ToolRegistry.isToolRegistry(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!TurnGate} instance. */
export const isTurnGate = (value: unknown): value is TurnGate => TurnGate.isTurnGate(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!SpooledArtifact} instance. */
export const isSpooledArtifact = (value: unknown): value is SpooledArtifact =>
  SpooledArtifact.isSpooledArtifact(value)

/**
 * Returns `true` if `value` is a constructor function for {@link @nhtio/adk!SpooledArtifact} or any of
 * its subclasses (including `SpooledArtifact` itself).
 */
export const isSpooledArtifactConstructor = (
  value: unknown
): value is SpooledArtifactConstructor<SpooledArtifact> =>
  SpooledArtifact.isSpooledArtifactConstructor(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!SpooledJsonArtifact} instance. */
export const isSpooledJsonArtifact = (value: unknown): value is SpooledJsonArtifact =>
  SpooledJsonArtifact.isSpooledJsonArtifact(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!SpooledMarkdownArtifact} instance. */
export const isSpooledMarkdownArtifact = (value: unknown): value is SpooledMarkdownArtifact =>
  SpooledMarkdownArtifact.isSpooledMarkdownArtifact(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!TurnContext} instance. */
export const isTurnContext = (value: unknown): value is TurnContext =>
  TurnContext.isTurnContext(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!TurnRunner} instance. */
export const isTurnRunner = (value: unknown): value is TurnRunner => TurnRunner.isTurnRunner(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!DispatchContext} instance. */
export const isDispatchContext = (value: unknown): value is DispatchContext =>
  DispatchContext.isDispatchContext(value)

/** Returns `true` if `value` is a {@link @nhtio/adk!DispatchRunner} instance. */
export const isDispatchRunner = (value: unknown): value is DispatchRunner =>
  DispatchRunner.isDispatchRunner(value)
