import type { Tool } from '@nhtio/adk'
import type { TurnRunnerConfig, TurnPipelineMiddlewareFn } from '@nhtio/adk/turn_runner'
import type { DispatchPipelineMiddlewareFn, DispatchExecutorFn } from '@nhtio/adk/dispatch_runner'

/**
 * Overrides accepted by {@link makeFixtureConfig}.
 *
 * @remarks
 * `executorCallback` is required — a `TurnRunnerConfig` without an executor is meaningless.
 * Every other field has a stub default; supply what your test needs to inspect.
 */
export interface FixtureConfigOverrides {
  executorCallback: DispatchExecutorFn
  tools?: Tool[]
  turnInputPipeline?: TurnPipelineMiddlewareFn[]
  turnOutputPipeline?: TurnPipelineMiddlewareFn[]
  dispatchInputPipeline?: DispatchPipelineMiddlewareFn[]
  dispatchOutputPipeline?: DispatchPipelineMiddlewareFn[]
  fetchMemoriesCallback?: TurnRunnerConfig['fetchMemoriesCallback']
  fetchMessagesCallback?: TurnRunnerConfig['fetchMessagesCallback']
  fetchThoughtsCallback?: TurnRunnerConfig['fetchThoughtsCallback']
  fetchToolCallsCallback?: TurnRunnerConfig['fetchToolCallsCallback']
  fetchRetrievablesCallback?: TurnRunnerConfig['fetchRetrievablesCallback']
  storeRetrievableCallback?: TurnRunnerConfig['storeRetrievableCallback']
  mutateRetrievableCallback?: TurnRunnerConfig['mutateRetrievableCallback']
  deleteRetrievableCallback?: TurnRunnerConfig['deleteRetrievableCallback']
  refreshStandingInstructionsCallback?: TurnRunnerConfig['refreshStandingInstructionsCallback']
}

/**
 * Builds a {@link TurnRunnerConfig} with every required callback stubbed to a no-op (mutations)
 * or empty-array return (fetches).
 *
 * @remarks
 * `executorCallback` is the only mandatory override — every test needs to script what the LLM
 * is supposed to "do". Tools, middleware, and any other field with a sensible default may be
 * supplied via {@link FixtureConfigOverrides} or left to defaults.
 *
 * The schema enforces `.arity(1)` on fetch callbacks and `.arity(2)` on mutation callbacks, so
 * the stubs declare the matching parameter lists explicitly even when the bodies ignore them.
 *
 * @throws when `executorCallback` is not a function.
 * @returns A fully-populated `TurnRunnerConfig` ready to pass to `new TurnRunner(...)`.
 */
export const makeFixtureConfig = (overrides: FixtureConfigOverrides): TurnRunnerConfig => {
  if (typeof overrides.executorCallback !== 'function') {
    throw new TypeError('makeFixtureConfig: executorCallback is required and must be a function')
  }

  return {
    executorCallback: overrides.executorCallback,

    // Fetch callbacks — arity 1, return empty
    fetchMemoriesCallback: overrides.fetchMemoriesCallback
      ? async (_ctx) => overrides.fetchMemoriesCallback!(_ctx)
      : async (_ctx) => [],
    fetchMessagesCallback: overrides.fetchMessagesCallback
      ? async (_ctx) => overrides.fetchMessagesCallback!(_ctx)
      : async (_ctx) => [],
    fetchThoughtsCallback: overrides.fetchThoughtsCallback
      ? async (_ctx) => overrides.fetchThoughtsCallback!(_ctx)
      : async (_ctx) => [],
    fetchToolCallsCallback: overrides.fetchToolCallsCallback
      ? async (_ctx) => overrides.fetchToolCallsCallback!(_ctx)
      : async (_ctx) => [],
    fetchRetrievablesCallback: overrides.fetchRetrievablesCallback
      ? async (_ctx) => overrides.fetchRetrievablesCallback!(_ctx)
      : async (_ctx) => [],
    fetchToolsCallback: async (_ctx) => overrides.tools ?? [],
    refreshStandingInstructionsCallback: overrides.refreshStandingInstructionsCallback
      ? async (_ctx) => overrides.refreshStandingInstructionsCallback!(_ctx)
      : async (_ctx) => [],

    // Mutation callbacks — arity 2, no-op
    storeStandingInstructionCallback: async (_ctx, _v) => {},
    mutateStandingInstructionCallback: async (_ctx, _v) => {},
    deleteStandingInstructionCallback: async (_ctx, _v) => {},
    storeMemoryCallback: async (_ctx, _v) => {},
    mutateMemoryCallback: async (_ctx, _v) => {},
    deleteMemoryCallback: async (_ctx, _id) => {},
    storeRetrievableCallback: overrides.storeRetrievableCallback
      ? async (_ctx, _v) => overrides.storeRetrievableCallback!(_ctx, _v)
      : async (_ctx, _v) => {},
    mutateRetrievableCallback: overrides.mutateRetrievableCallback
      ? async (_ctx, _v) => overrides.mutateRetrievableCallback!(_ctx, _v)
      : async (_ctx, _v) => {},
    deleteRetrievableCallback: overrides.deleteRetrievableCallback
      ? async (_ctx, _id) => overrides.deleteRetrievableCallback!(_ctx, _id)
      : async (_ctx, _id) => {},
    storeMessageCallback: async (_ctx, _v) => {},
    mutateMessageCallback: async (_ctx, _v) => {},
    deleteMessageCallback: async (_ctx, _id) => {},
    storeThoughtCallback: async (_ctx, _v) => {},
    mutateThoughtCallback: async (_ctx, _v) => {},
    deleteThoughtCallback: async (_ctx, _id) => {},
    storeToolCallCallback: async (_ctx, _v) => {},
    mutateToolCallCallback: async (_ctx, _v) => {},
    deleteToolCallCallback: async (_ctx, _id) => {},

    tools: overrides.tools ?? [],
    turnInputPipeline: overrides.turnInputPipeline ?? [],
    turnOutputPipeline: overrides.turnOutputPipeline ?? [],
    dispatchInputPipeline: overrides.dispatchInputPipeline ?? [],
    dispatchOutputPipeline: overrides.dispatchOutputPipeline ?? [],
  }
}
