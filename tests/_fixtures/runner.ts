import { TurnRunner } from '@nhtio/adk'
import { makeFixtureConfig } from './fixture_config'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import type { FixtureConfigOverrides } from './fixture_config'
import type { ScriptStore, ScriptedExecutor } from './scripted_executor'
import type { DispatchExecutorFn, RawTurnContext, TurnPipelineMiddlewareFn } from '@nhtio/adk'

/**
 * The event names captured by {@link makeFixtureRunner}'s `events` array.
 *
 * @remarks
 * Functional events (`message`, `thought`, `toolCall`) plus every observability event the
 * runner exposes (`turnStart` / `turnEnd` / `turnGateOpen` / `turnGateClosed` / `dispatchStart`
 * / `dispatchEnd` / `iterationStart` / `iterationEnd` / `toolExecutionStart` /
 * `toolExecutionEnd` / `error`).
 */
export interface CapturedEvent {
  kind:
    | 'message'
    | 'thought'
    | 'toolCall'
    | 'turnStart'
    | 'turnEnd'
    | 'turnGateOpen'
    | 'turnGateClosed'
    | 'dispatchStart'
    | 'dispatchEnd'
    | 'iterationStart'
    | 'iterationEnd'
    | 'log'
    | 'toolExecutionStart'
    | 'toolExecutionEnd'
    | 'error'
  payload: unknown
}

/**
 * The shape returned by {@link makeFixtureRunner}.
 *
 * @remarks
 * - `runner` is the constructed {@link TurnRunner}.
 * - `store` is the spool store backing scripted tool calls. If the caller's `executorCallback`
 *   is a {@link ScriptedExecutor}, `store` reuses its store (whatever its concrete type —
 *   in-memory, flydrive, etc.); otherwise a fresh {@link InMemorySpoolStore} is created and
 *   exposed for tests that want to write bytes manually.
 * - `events` is an array of every event the runner emitted, populated live as the dispatch
 *   progresses. Tests can read it after `await runner.run(...)` resolves.
 * - `run` is a convenience that calls `runner.run(...)` with sensible defaults for
 *   {@link RawTurnContext} (an abort controller, a default system prompt, no standing
 *   instructions). Override individual fields by passing an explicit partial.
 */
export interface FixtureRunnerHandle<S extends ScriptStore = InMemorySpoolStore> {
  runner: TurnRunner
  store: S
  events: CapturedEvent[]
  run(partial?: Partial<RawTurnContext>): Promise<void>
}

const DEFAULT_SYSTEM_PROMPT = 'You are a test assistant.'

/**
 * Builds a {@link TurnRunner} pre-wired with the fixture config defaults, subscribes a single
 * listener per event onto both buses, and returns a handle with everything a functional test
 * needs to drive a dispatch end-to-end.
 *
 * @remarks
 * Every emission is captured into `events` in the order it fires. This keeps tests focused on
 * the assertions rather than the event-subscription boilerplate.
 *
 * If `overrides.executorCallback` is a {@link ScriptedExecutor}, its `.store` is reused so
 * persistence assertions can read from a single, known location. Otherwise a fresh
 * {@link InMemorySpoolStore} is created and exposed on the handle.
 *
 * @param overrides - Same shape as {@link FixtureConfigOverrides}; `executorCallback` is required.
 * @returns A {@link FixtureRunnerHandle}.
 */
export const makeFixtureRunner = <S extends ScriptStore = InMemorySpoolStore>(
  overrides: FixtureConfigOverrides
): FixtureRunnerHandle<S> => {
  // When the caller supplies a fetchMemoriesCallback, auto-install an input
  // middleware that calls `ctx.fetchMemories()` and seeds `ctx.turnMemories`
  // by directly mutating the Set exposed via the getter (which returns the
  // backing Set by reference — see turn_runner_context.ts:360-364).
  //
  // We deliberately do NOT call `ctx.storeMemory(m)` here: that routes to the
  // consumer's storeMemoryCallback (long-term persistence) which is a no-op
  // stub in the fixture config. The within-turn working set the LLM sees is
  // `ctx.turnMemories`, and middleware is responsible for populating it.
  const userInputMiddleware = overrides.turnInputPipeline ?? []
  const autoMemoryMiddleware: TurnPipelineMiddlewareFn[] = overrides.fetchMemoriesCallback
    ? [
        async (ctx, next) => {
          const memories = await ctx.fetchMemories()
          for (const m of memories) {
            ctx.turnMemories.add(m)
          }
          return next()
        },
      ]
    : []
  const autoRetrievableMiddleware: TurnPipelineMiddlewareFn[] = overrides.fetchRetrievablesCallback
    ? [
        async (ctx, next) => {
          const retrievables = await ctx.fetchRetrievables()
          for (const r of retrievables) {
            ctx.turnRetrievables.add(r)
          }
          return next()
        },
      ]
    : []
  const mergedOverrides: FixtureConfigOverrides = {
    ...overrides,
    turnInputPipeline: [
      ...autoMemoryMiddleware,
      ...autoRetrievableMiddleware,
      ...userInputMiddleware,
    ],
  }
  const config = makeFixtureConfig(mergedOverrides)
  const runner = new TurnRunner(config)

  // If the caller passed a ScriptedExecutor (the common case), reuse its store so assertions
  // can introspect persisted tool-call bytes. Otherwise allocate a fresh InMemorySpoolStore as
  // a convenience for tests that drive the executor manually.
  const maybeScripted = overrides.executorCallback as ScriptedExecutor | DispatchExecutorFn
  const exposedStore =
    typeof (maybeScripted as ScriptedExecutor).store?.write === 'function'
      ? ((maybeScripted as ScriptedExecutor).store as S)
      : (new InMemorySpoolStore() as unknown as S)

  const events: CapturedEvent[] = []

  runner.on('message', (payload) => events.push({ kind: 'message', payload }))
  runner.on('thought', (payload) => events.push({ kind: 'thought', payload }))
  runner.on('toolCall', (payload) => events.push({ kind: 'toolCall', payload }))
  runner.observe('turnStart', (payload) => events.push({ kind: 'turnStart', payload }))
  runner.observe('turnEnd', (payload) => events.push({ kind: 'turnEnd', payload }))
  runner.observe('turnGateOpen', (payload) => events.push({ kind: 'turnGateOpen', payload }))
  runner.observe('turnGateClosed', (payload) => events.push({ kind: 'turnGateClosed', payload }))
  runner.observe('dispatchStart', (payload) => events.push({ kind: 'dispatchStart', payload }))
  runner.observe('dispatchEnd', (payload) => events.push({ kind: 'dispatchEnd', payload }))
  runner.observe('iterationStart', (payload) => events.push({ kind: 'iterationStart', payload }))
  runner.observe('iterationEnd', (payload) => events.push({ kind: 'iterationEnd', payload }))
  runner.observe('log', (payload) => events.push({ kind: 'log', payload }))
  runner.observe('toolExecutionStart', (payload) =>
    events.push({ kind: 'toolExecutionStart', payload })
  )
  runner.observe('toolExecutionEnd', (payload) =>
    events.push({ kind: 'toolExecutionEnd', payload })
  )
  runner.observe('error', (payload) => events.push({ kind: 'error', payload }))

  return {
    runner,
    store: exposedStore,
    events,
    run: (partial = {}) =>
      runner.run({
        turnAbortController: partial.turnAbortController ?? new AbortController(),
        systemPrompt: partial.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        standingInstructions: partial.standingInstructions ?? [],
        stash: partial.stash ?? {},
      }),
  }
}
