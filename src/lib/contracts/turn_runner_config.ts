import { Tool } from '../classes/tool'
import { validator } from '@nhtio/validation'
import type { TurnPipelineMiddlewareFn } from '../types/turn_runner'
import type { DispatchPipelineMiddlewareFn, DispatchExecutorFn } from '../types/dispatch_runner'
import type {
  MemoryRetrievalFn,
  MessageRetrievalFn,
  ThoughtRetrievalFn,
  ToolCallRetrievalFn,
  ToolsRetrievalFn,
  StandingInstructionsRefreshFn,
  StandingInstructionStoreFn,
  StandingInstructionMutateFn,
  StandingInstructionDeleteFn,
  MemoryStoreFn,
  MemoryMutateFn,
  MemoryDeleteFn,
  RetrievableRetrievalFn,
  RetrievableStoreFn,
  RetrievableMutateFn,
  RetrievableDeleteFn,
  MessageStoreFn,
  MessageMutateFn,
  MessageDeleteFn,
  ThoughtStoreFn,
  ThoughtMutateFn,
  ThoughtDeleteFn,
  ToolCallStoreFn,
  ToolCallMutateFn,
  ToolCallDeleteFn,
} from './turn_runner_context'

/**
 * Configuration supplied to {@link @nhtio/adk!TurnRunner} at construction time.
 *
 * @remarks
 * Validated against `turnRunnerConfigSchema` at construction — a misconfigured runner throws
 * immediately rather than failing on the first turn.
 *
 * All fetch and mutation callbacks are required: they are injected into each {@link @nhtio/adk!TurnContext}
 * so middleware can call fetch, refresh, and persistence methods directly on the context without
 * coupling to the runner.
 *
 * `tools` is optional at the caller level and defaults to `[]` after schema resolution — a runner
 * with no baseline tools is valid.
 */
export interface TurnRunnerConfig {
  /** Performs the LLM API/SDK call for each iteration of the dispatch loop; receives the active {@link @nhtio/adk!DispatchContext} and an {@link @nhtio/adk!DispatchExecutorHelpers} object for managing per-id stream state. */
  executorCallback: DispatchExecutorFn
  /** Called once per turn to supply memories; receives the active {@link @nhtio/adk!TurnContext}. */
  fetchMemoriesCallback: MemoryRetrievalFn
  /** Called once per turn to supply conversation history; receives the active {@link @nhtio/adk!TurnContext}. */
  fetchMessagesCallback: MessageRetrievalFn
  /** Called once per turn to supply thought traces; receives the active {@link @nhtio/adk!TurnContext}. */
  fetchThoughtsCallback: ThoughtRetrievalFn
  /** Called once per turn to supply tool call records; receives the active {@link @nhtio/adk!TurnContext}. */
  fetchToolCallsCallback: ToolCallRetrievalFn
  /** Called to supply available tools; receives the active {@link @nhtio/adk!TurnContext}. */
  fetchToolsCallback: ToolsRetrievalFn
  /** Called to refresh and return standing instructions; receives the active {@link @nhtio/adk!TurnContext}. */
  refreshStandingInstructionsCallback: StandingInstructionsRefreshFn
  /** Persists a new standing instruction. */
  storeStandingInstructionCallback: StandingInstructionStoreFn
  /** Updates an existing standing instruction in the persistence layer. */
  mutateStandingInstructionCallback: StandingInstructionMutateFn
  /** Removes a standing instruction from the persistence layer. */
  deleteStandingInstructionCallback: StandingInstructionDeleteFn
  /** Persists a new memory. */
  storeMemoryCallback: MemoryStoreFn
  /** Updates an existing memory in the persistence layer. */
  mutateMemoryCallback: MemoryMutateFn
  /** Removes a memory from the persistence layer by ID. */
  deleteMemoryCallback: MemoryDeleteFn
  /** Called once per turn to supply retrievable (RAG) records; receives the active {@link @nhtio/adk!TurnContext}. */
  fetchRetrievablesCallback: RetrievableRetrievalFn
  /** Persists a new retrievable record. */
  storeRetrievableCallback: RetrievableStoreFn
  /** Updates an existing retrievable record in the persistence layer. */
  mutateRetrievableCallback: RetrievableMutateFn
  /** Removes a retrievable record from the persistence layer by ID. */
  deleteRetrievableCallback: RetrievableDeleteFn
  /** Persists a new message. */
  storeMessageCallback: MessageStoreFn
  /** Updates an existing message in the persistence layer. */
  mutateMessageCallback: MessageMutateFn
  /** Removes a message from the persistence layer by ID. */
  deleteMessageCallback: MessageDeleteFn
  /** Persists a new thought. */
  storeThoughtCallback: ThoughtStoreFn
  /** Updates an existing thought in the persistence layer. */
  mutateThoughtCallback: ThoughtMutateFn
  /** Removes a thought from the persistence layer by ID. */
  deleteThoughtCallback: ThoughtDeleteFn
  /** Persists a new tool call. */
  storeToolCallCallback: ToolCallStoreFn
  /** Updates an existing tool call in the persistence layer. */
  mutateToolCallCallback: ToolCallMutateFn
  /** Removes a tool call from the persistence layer by ID. */
  deleteToolCallCallback: ToolCallDeleteFn
  /** Baseline tools available on every turn. Middleware may trim or extend this per-turn via `ctx.tools`. Defaults to `[]`. */
  tools?: Tool[]
  /** Turn-level input middleware, executed in order against the {@link @nhtio/adk!TurnContext} before the LLM dispatch. Defaults to `[]`. */
  turnInputPipeline?: TurnPipelineMiddlewareFn[]
  /** Turn-level output middleware, executed in order against the {@link @nhtio/adk!TurnContext} after the LLM dispatch resolves successfully. Defaults to `[]`. */
  turnOutputPipeline?: TurnPipelineMiddlewareFn[]
  /** LLM-iteration input middleware, executed in order against the {@link @nhtio/adk!DispatchContext} before the executor on each iteration. Defaults to `[]`. */
  dispatchInputPipeline?: DispatchPipelineMiddlewareFn[]
  /** LLM-iteration output middleware, executed in order against the {@link @nhtio/adk!DispatchContext} after the executor on each iteration. Defaults to `[]`. */
  dispatchOutputPipeline?: DispatchPipelineMiddlewareFn[]
}

/**
 * Fully-resolved {@link TurnRunnerConfig} after schema validation.
 *
 * @remarks
 * All optional fields are guaranteed present (e.g. `tools` defaults to `[]`). The runner stores
 * this type internally so field access never needs to guard for undefined.
 */
export type ResolvedTurnRunnerConfig = Required<TurnRunnerConfig>

/**
 * Validator schema used to validate a {@link TurnRunnerConfig} at {@link @nhtio/adk!TurnRunner} construction time.
 *
 * @remarks
 * Validates that all callbacks are functions of the correct arity, and that `tools` — when
 * provided — is an array of valid {@link @nhtio/adk!Tool} instances. Defaults `tools` to `[]`.
 *
 * Throws {@link @nhtio/adk!E_INVALID_TURN_RUNNER_CONFIG} (via the {@link @nhtio/adk!TurnRunner} constructor) when
 * validation fails.
 */
export const turnRunnerConfigSchema = validator.object<TurnRunnerConfig>({
  executorCallback: validator.function().required(),
  fetchMemoriesCallback: validator.function().arity(1).required(),
  fetchMessagesCallback: validator.function().arity(1).required(),
  fetchThoughtsCallback: validator.function().arity(1).required(),
  fetchToolCallsCallback: validator.function().arity(1).required(),
  fetchToolsCallback: validator.function().arity(1).required(),
  refreshStandingInstructionsCallback: validator.function().arity(1).required(),
  storeStandingInstructionCallback: validator.function().arity(2).required(),
  mutateStandingInstructionCallback: validator.function().arity(2).required(),
  deleteStandingInstructionCallback: validator.function().arity(2).required(),
  storeMemoryCallback: validator.function().arity(2).required(),
  mutateMemoryCallback: validator.function().arity(2).required(),
  deleteMemoryCallback: validator.function().arity(2).required(),
  fetchRetrievablesCallback: validator.function().arity(1).required(),
  storeRetrievableCallback: validator.function().arity(2).required(),
  mutateRetrievableCallback: validator.function().arity(2).required(),
  deleteRetrievableCallback: validator.function().arity(2).required(),
  storeMessageCallback: validator.function().arity(2).required(),
  mutateMessageCallback: validator.function().arity(2).required(),
  deleteMessageCallback: validator.function().arity(2).required(),
  storeThoughtCallback: validator.function().arity(2).required(),
  mutateThoughtCallback: validator.function().arity(2).required(),
  deleteThoughtCallback: validator.function().arity(2).required(),
  storeToolCallCallback: validator.function().arity(2).required(),
  mutateToolCallCallback: validator.function().arity(2).required(),
  deleteToolCallCallback: validator.function().arity(2).required(),
  tools: validator
    .array()
    .items(
      validator.any().custom((value: unknown, helpers: { error: (code: string) => unknown }) => {
        if (Tool.isTool(value)) return value
        return helpers.error('any.invalid')
      })
    )
    .default([]),
  turnInputPipeline: validator.array().items(validator.function()).default([]),
  turnOutputPipeline: validator.array().items(validator.function()).default([]),
  dispatchInputPipeline: validator.array().items(validator.function()).default([]),
  dispatchOutputPipeline: validator.array().items(validator.function()).default([]),
})
