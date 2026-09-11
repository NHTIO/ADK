import { isError } from '@nhtio/adk/guards'
import type { Retrievable, Tool } from '@nhtio/adk/common'
import type { SkillManager, SkillMiddlewareSet, ProjectedSkill } from './types'
import type {
  DispatchContext,
  DispatchPipelineMiddlewareFn,
  TurnContext,
  TurnPipelineMiddlewareFn,
} from '@nhtio/adk/types'

/** Options for the standalone skills middleware factories. */
export interface SkillMiddlewareOptions {
  /** Re-discover the catalog before hydrating each non-empty turn. */
  readonly autoRefresh?: boolean
}

type SkillContext = TurnContext | DispatchContext

/**
 * Tracks only objects injected by this middleware. Context registries are deliberately not used
 * as a live-state store: their reads clone values.
 */
interface ProjectionState {
  readonly retrievables: Set<Retrievable>
  /**
   * The exact `Tool` objects this battery registered, keyed by name. Cleanup compares identity
   * against the live registry entry so it never unregisters a same-named tool that a later
   * projection replaced ours with.
   */
  readonly tools: Map<string, Tool>
}

type ProjectionStates = WeakMap<object, ProjectionState>

/**
 * The four standalone factories must share projection state when composed by hand for the same
 * manager — otherwise the turn-output factory holds a different `WeakMap` than the turn-input one
 * and sees no projection to strip. Keyed by manager so each manager gets exactly one shared map,
 * matching what `createSkillMiddlewareSet` builds internally.
 */
const sharedProjectionStates = new WeakMap<SkillManager, ProjectionStates>()
const projectionStatesFor = (manager: SkillManager): ProjectionStates => {
  let states = sharedProjectionStates.get(manager)
  if (!states) {
    states = new WeakMap<object, ProjectionState>()
    sharedProjectionStates.set(manager, states)
  }
  return states
}

const stateFor = (ctx: SkillContext, projectionStates: ProjectionStates): ProjectionState => {
  let state = projectionStates.get(ctx)
  if (!state) {
    state = { retrievables: new Set(), tools: new Map() }
    projectionStates.set(ctx, state)
  }
  return state
}

const project = (
  ctx: SkillContext,
  projected: readonly ProjectedSkill[],
  projectionStates: ProjectionStates
): void => {
  const state = stateFor(ctx, projectionStates)
  for (const skill of projected) {
    for (const tool of skill.tools) {
      ctx.tools.register(tool, true)
      state.tools.set(tool.name, tool)
    }
    if (skill.retrievable) {
      ctx.turnRetrievables.add(skill.retrievable)
      state.retrievables.add(skill.retrievable)
    }
  }
}

const reconcile = (
  ctx: SkillContext,
  manager: SkillManager,
  projectionStates: ProjectionStates
): void => {
  const loaded = new Set(manager.loaded())
  const state = stateFor(ctx, projectionStates)
  for (const [name, tool] of state.tools) {
    const owner = tool.meta.get('skill')
    if (typeof owner === 'string' && !loaded.has(owner)) {
      // Only remove the entry if the registry still holds OUR object; a later projection may
      // have replaced this name with a different tool that we must not clobber.
      if (ctx.tools.get(name) === tool) ctx.tools.unregister(name)
      state.tools.delete(name)
    }
  }

  const projected = manager.projected(ctx)
  const currentRetrievables = new Set(
    projected.flatMap((skill) => (skill.retrievable ? [skill.retrievable] : []))
  )
  for (const retrievable of state.retrievables) {
    if (!currentRetrievables.has(retrievable)) {
      ctx.turnRetrievables.delete(retrievable)
      state.retrievables.delete(retrievable)
    }
  }
  project(ctx, projected, projectionStates)
}

const failTurn = (ctx: TurnContext, error: unknown): void => {
  // TurnContext has no nack/ack; abort(reason) preserves the projection failure and prevents
  // an invalid turn from continuing.
  ctx.abort(error)
}

const failDispatch = (ctx: DispatchContext, error: unknown): void => {
  ctx.nack(isError(error) ? error : new Error(String(error)))
}

/**
 * Hydrates loaded skills onto the fresh turn registry.
 *
 * @remarks
 * The registry exists before the turn input pipeline runs: `turn_runner.ts:309` constructs it,
 * `:311` constructs the `TurnContext`, and `:392` awaits the input pipeline. Projection here is
 * therefore sound and is the load-bearing turn-boundary operation. With `autoRefresh`, this calls
 * the catalog-only `refresh()`, never `refreshAndProject()`; an available update is not swapped
 * into a live conversation implicitly.
 *
 * Place this early, before middleware that reads `ctx.tools` or budgets context. A projection
 * failure aborts the turn: `TurnContext` has `abort()` but no `ack()`/`nack()`. The original
 * error is passed as `abort(reason)`, so the turn's abort signal retains the projection failure
 * for its runner/consumer rather than allowing an invalid turn to continue. Middleware is
 * skipped once `ctx.aborted` (the wrapper still calls `next()` but the body does not run), so
 * cleanup must never live only here; workspace disposal and other cleanup are reachable from
 * `manager.dispose()` as well.
 */
const createTurnInputMiddleware = (
  manager: SkillManager,
  options: SkillMiddlewareOptions,
  projectionStates: ProjectionStates
): TurnPipelineMiddlewareFn => {
  const autoRefresh = options.autoRefresh === true
  return async (ctx, next) => {
    if (manager.loaded().length === 0) {
      await next()
      return
    }
    try {
      if (autoRefresh) await manager.refresh()
      project(ctx, manager.projected(ctx), projectionStates)
    } catch (error) {
      failTurn(ctx, error)
      return
    }
    await next()
  }
}

/** Create the turn-input middleware that refreshes and projects loaded skills. */
export const skillsTurnInputMiddleware = (
  manager: SkillManager,
  options: SkillMiddlewareOptions = {}
): TurnPipelineMiddlewareFn =>
  createTurnInputMiddleware(manager, options, projectionStatesFor(manager))

/**
 * Strips skill projections at the head of the turn-output pipeline, before any downstream output
 * middleware observes the context.
 *
 * @remarks
 * The turn's answer is persisted at dispatch, before this pipeline runs; the strip removes the
 * projection **at the head of turn-output** — it runs before `next()`, so every downstream
 * turn-output middleware (a consumer's observation or secondary persistence) sees a context the
 * skill body and tools have ALREADY left. That omission is the guarantee, not a gap: "the body
 * never leaves" is the whole point, and running the strip after `next()` would expose the
 * projection to downstream persistence and reintroduce exactly the leak this battery exists to
 * prevent. Do not move the strip below `next()`.
 *
 * This is best-effort: `TurnRunner.run()` returns before the output pipeline on a failed or
 * aborted turn (`turn_runner.ts:470-473`). Nothing is corrupted when this strip is skipped because
 * projected state is ephemeral; the discarded turn context is not durable state. This middleware
 * never touches a skill workspace: workspace lifetime follows the skill, not the turn. The
 * per-set weak state records the exact tools and retrievables injected by this battery; cleanup
 * therefore cannot unregister a consumer-owned tool that merely has `meta.skill`. Strip is
 * deliberately subtractive: it never projects to fill missing state. A `load()` handler receives
 * a `DispatchContext` and settles its projection there; it is not a projection into this turn
 * context. In the normal path, `turnInput` records every turn-context injection before output
 * runs. Treating an unrecorded context as loaded state here would briefly inject a skill body and
 * tools into a context that the turn pipeline never hydrated, violating the strip boundary.
 */
const createTurnOutputMiddleware =
  (
    _manager: SkillManager,
    _options: SkillMiddlewareOptions,
    projectionStates: ProjectionStates
  ): TurnPipelineMiddlewareFn =>
  async (ctx, next) => {
    const state = projectionStates.get(ctx)
    for (const retrievable of state?.retrievables ?? []) ctx.turnRetrievables.delete(retrievable)
    for (const [name, tool] of state?.tools ?? []) {
      if (ctx.tools.get(name) === tool) ctx.tools.unregister(name)
    }
    state?.retrievables.clear()
    state?.tools.clear()
    await next()
  }

/** Create the turn-output middleware that removes this set's skill projections. */
export const skillsTurnOutputMiddleware = (
  manager: SkillManager,
  options: SkillMiddlewareOptions = {}
): TurnPipelineMiddlewareFn =>
  createTurnOutputMiddleware(manager, options, projectionStatesFor(manager))

/**
 * Repairs per-iteration skill integrity before the budget/thrift pass.
 *
 * @remarks
 * `turn_runner.ts:425-426` hands `dispatchInputPipeline` to `DispatchRunner` as its
 * `turnInputPipeline`; the parameter names in this factory intentionally say dispatch to avoid
 * wiring those two seams backwards. Unloaded skill tools are removed and the current projection
 * is reasserted after a mid-turn load. Forged artifact readers are deliberately untouched:
 * `pruneEphemeral()` would remove readers for every artifact in the iteration, not just a skill.
 * A dispatch integrity failure nacks the iteration because `DispatchContext` has `nack()`; unlike
 * `TurnContext`, it also has `ack()`.
 */
const createDispatchInputMiddleware = (
  manager: SkillManager,
  _options: SkillMiddlewareOptions,
  projectionStates: ProjectionStates
): DispatchPipelineMiddlewareFn => {
  return async (dispatchCtx, next) => {
    if (manager.loaded().length === 0) {
      await next()
      return
    }
    try {
      reconcile(dispatchCtx, manager, projectionStates)
    } catch (error) {
      failDispatch(dispatchCtx, error)
      return
    }
    await next()
  }
}

/** Create the dispatch-input middleware that reconciles skill projections. */
export const skillsDispatchInputMiddleware = (
  manager: SkillManager,
  options: SkillMiddlewareOptions = {}
): DispatchPipelineMiddlewareFn =>
  createDispatchInputMiddleware(manager, options, projectionStatesFor(manager))

/**
 * Observes and reconciles skill state after execution, without committing anything.
 *
 * @remarks
 * Settlement is immediate: load/unload handlers mutate manager state and the registry before
 * returning, so this middleware is not a commit point. It runs after the executor and before
 * result persistence. It does not call `pruneEphemeral()` and does not touch forged artifact
 * readers. An empty initialized set is a deliberate no-op.
 */
const createDispatchOutputMiddleware = (
  manager: SkillManager,
  _options: SkillMiddlewareOptions,
  projectionStates: ProjectionStates
): DispatchPipelineMiddlewareFn => {
  return async (dispatchCtx, next) => {
    if (manager.loaded().length === 0) {
      await next()
      return
    }
    try {
      reconcile(dispatchCtx, manager, projectionStates)
    } catch (error) {
      failDispatch(dispatchCtx, error)
      return
    }
    await next()
  }
}

/** Create the dispatch-output middleware that observes and reconciles skill state. */
export const skillsDispatchOutputMiddleware = (
  manager: SkillManager,
  options: SkillMiddlewareOptions = {}
): DispatchPipelineMiddlewareFn =>
  createDispatchOutputMiddleware(manager, options, projectionStatesFor(manager))

/** Build the stable four-middleware skills integration surface. */
export const createSkillMiddlewareSet = (
  manager: SkillManager,
  options: SkillMiddlewareOptions = {}
): SkillMiddlewareSet => {
  const projectionStates = projectionStatesFor(manager)
  return {
    turnInput: createTurnInputMiddleware(manager, options, projectionStates),
    turnOutput: createTurnOutputMiddleware(manager, options, projectionStates),
    dispatchInput: createDispatchInputMiddleware(manager, options, projectionStates),
    dispatchOutput: createDispatchOutputMiddleware(manager, options, projectionStates),
  }
}

export type { SkillMiddlewareSet }
