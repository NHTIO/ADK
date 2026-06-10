/**
 * The step runtime: executes a validated {@link MediaPlan} as an `@nhtio/middleware` onion,
 * one stage per step, with consumer interceptors wrapping every step.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. A fresh `Runner` is minted per
 * execution (middleware runners are single-use), so the same compiled chain can be awaited
 * repeatedly. Each step stage:
 *
 * 1. runs the consumer's `use` interceptors (the documented seam for DLP/AV scanning, caching
 *    via `shortCircuit(bytes)`, byte limits, and telemetry — the battery ships no built-in
 *    scanner/cache/limiter: those are policies, this is the seam), then
 * 2. dispatches to the verb's registered {@link StepImpl}, validating the output at the step
 *    boundary so a misbehaving engine produces a clear error instead of corrupt bytes.
 *
 * Steps stream bytes in memory; nothing touches disk except inside a binary engine's
 * `ScratchWorkspace`. Adjacent `image.*` steps are fused by the compiler before execution so
 * a resize→format→rotate chain costs a single decode/encode.
 */

import { VERB_INDEX } from './verbs'
import { Middleware } from '@nhtio/middleware'
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED, E_MEDIA_STEP_UNAVAILABLE } from './exceptions'
import type { NextFn } from '@nhtio/middleware'
import type { EngineRegistry } from './registry'
import type { MediaPlan, MediaStep, MediaArgValue } from './plan'

/** A single in-flight value travelling between steps. */
export interface StepPayload {
  /** The raw content bytes. */
  bytes: Uint8Array
  /** The content MIME type. */
  mimeType: string
  /** The filename (extension informs format dispatch). */
  filename: string
}

/**
 * What a step produces. `media` continues the chain (or terminates as bytes); `media-list`
 * and `data` are terminal-only shapes enforced by the plan compiler.
 */
export type StepResult =
  | { kind: 'media'; payload: StepPayload }
  | { kind: 'media-list'; payloads: StepPayload[] }
  | { kind: 'data'; data: unknown; asText?: string }

/** The mutable execution context threaded through interceptors and step impls. */
export interface StepContext {
  /** The whole plan being executed. */
  readonly plan: MediaPlan
  /** Zero-based index of the current step. */
  readonly stepIndex: number
  /** The current step. */
  readonly step: MediaStep
  /** The input payload for this step. */
  payload: StepPayload
  /** Abort signal threaded from the caller. */
  readonly signal?: AbortSignal
  /** Scratchpad shared across the execution (interceptors may stash timings, hashes…). */
  readonly stash: Map<string, unknown>
  /**
   * Short-circuit this step: skip the implementation and continue the chain with `bytes`
   * (the cache idiom). Throws internally — call it, don't return it.
   */
  shortCircuit(payload: StepPayload): never
  /** The deployment's engine registry — ordered, capability-filtered dispatch. */
  readonly engines: EngineRegistry
  /**
   * Resolve another media participating in this step (merge/diff targets), by ref id.
   * Supplied by the pipeline from its configured media resolver.
   */
  resolveRef(id: string): Promise<StepPayload>
}

/** One verb's implementation. Registered into the runtime's step registry. */
export type StepImpl = (ctx: StepContext) => Promise<StepResult>

/** Consumer step interceptor — the `use` seam. Same onion shape as the tool batteries. */
export type MediaStepMiddlewareFn = (ctx: StepContext, next: NextFn) => void | Promise<void>

/** Internal sentinel for {@link StepContext.shortCircuit}. */
const SHORT_CIRCUIT = Symbol('adk.media.shortCircuit')

interface ShortCircuitSignal {
  [SHORT_CIRCUIT]: true
  payload: StepPayload
}

const isShortCircuit = (value: unknown): value is ShortCircuitSignal =>
  isObject(value) && (value as Record<symbol, unknown>)[SHORT_CIRCUIT] === true

/** Options for {@link executePlan}. */
export interface ExecutePlanOptions {
  /** The input payload the first step consumes. */
  input: StepPayload
  /** Verb id → implementation registry. */
  steps: ReadonlyMap<string, StepImpl>
  /** Consumer interceptors wrapping every step. */
  use: readonly MediaStepMiddlewareFn[]
  /** The deployment's engine registry. */
  engines: EngineRegistry
  /** Media-ref resolution for multi-input verbs. */
  resolveRef: StepContext['resolveRef']
  /** Abort signal. */
  signal?: AbortSignal
}

/** The settled result of executing a whole plan. */
export type PlanResult = StepResult

/**
 * Execute a validated plan. Returns the final step's result; intermediate steps must produce
 * `media` results (the compiler guarantees non-terminal steps are media-shaped).
 *
 * @param plan - The validated plan.
 * @param options - Input payload, step registry, interceptors, engine access.
 * @returns The terminal step's result.
 */
export const executePlan = async (
  plan: MediaPlan,
  options: ExecutePlanOptions
): Promise<PlanResult> => {
  const stash = new Map<string, unknown>()
  let payload = options.input
  let result: PlanResult = { kind: 'media', payload }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    options.signal?.throwIfAborted()
    const impl = options.steps.get(step.verb)
    if (!impl) {
      throw new E_MEDIA_STEP_UNAVAILABLE([step.verb])
    }

    const ctx: StepContext = {
      plan,
      stepIndex: i,
      step,
      payload,
      signal: options.signal,
      stash,
      shortCircuit: (sc: StepPayload): never => {
        const signal: ShortCircuitSignal = { [SHORT_CIRCUIT]: true, payload: sc }
        throw signal
      },
      engines: options.engines,
      resolveRef: options.resolveRef,
    }

    try {
      result = await runStep(ctx, impl, options.use)
    } catch (err) {
      if (isShortCircuit(err)) {
        result = { kind: 'media', payload: err.payload }
      } else if (isError(err) && err.name.startsWith('E_MEDIA_')) {
        throw err
      } else {
        const detail = isError(err) ? err.message : String(err)
        throw new E_MEDIA_STEP_FAILED([step.verb, detail], { cause: err })
      }
    }

    if (result.kind === 'media') {
      payload = result.payload
    } else if (i < plan.steps.length - 1) {
      if (
        result.kind === 'data' &&
        typeof result.asText === 'string' &&
        VERB_INDEX.get(step.verb)?.output === 'text'
      ) {
        // R-step materialization (frozen 0.10): a non-terminal read step yields a text Media
        // into the chain, so `extract text | chunk` is type-sound.
        payload = {
          bytes: new TextEncoder().encode(result.asText),
          mimeType: 'text/plain',
          filename: materializedName(payload.filename),
        }
        result = { kind: 'media', payload }
      } else {
        throw new E_MEDIA_STEP_FAILED([
          step.verb,
          'a non-terminal step produced a terminal result; only the last step may yield data or multiple media',
        ])
      }
    }
  }
  return result
}

/** Run one step: interceptor onion (fresh runner) terminating in the implementation. */
const runStep = async (
  ctx: StepContext,
  impl: StepImpl,
  use: readonly MediaStepMiddlewareFn[]
): Promise<StepResult> => {
  if (use.length === 0) {
    return validated(ctx, await impl(ctx))
  }
  const mw = new Middleware<MediaStepMiddlewareFn>()
  for (const fn of use) mw.add(fn)

  let result: StepResult | undefined
  let caught: unknown
  await mw
    .runner()
    .errorHandler(async (error: unknown) => {
      caught = error
    })
    .finalHandler(async () => {
      result = validated(ctx, await impl(ctx))
    })
    .run((fn, next) => Promise.resolve(fn(ctx, next)))

  if (caught !== undefined) throw caught
  if (result === undefined) {
    throw new E_MEDIA_STEP_FAILED([
      ctx.step.verb,
      'a step interceptor did not call next() and did not short-circuit',
    ])
  }
  return result
}

/** Validate a step implementation's output shape at the boundary. */
const validated = (ctx: StepContext, result: StepResult): StepResult => {
  const bad = (msg: string): never => {
    throw new E_MEDIA_STEP_FAILED([ctx.step.verb, `implementation returned ${msg}`])
  }
  const isBytes = (value: unknown): value is Uint8Array =>
    isInstanceOf(value, 'Uint8Array', Uint8Array)
  if (result.kind === 'media') {
    if (!isBytes(result.payload?.bytes)) bad('a media result without bytes')
    if (typeof result.payload.mimeType !== 'string') bad('a media result without a mimeType')
    return result
  }
  if (result.kind === 'media-list') {
    if (!Array.isArray(result.payloads) || result.payloads.some((p) => !isBytes(p.bytes))) {
      bad('a media-list result with invalid payloads')
    }
    return result
  }
  if (result.kind === 'data') return result
  return bad('an unknown result kind')
}

/** Filename for an R-step's materialized text payload. */
const materializedName = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  const base = dot > 0 ? filename.slice(0, dot) : filename
  return `${base}.txt`
}

/** Convenience: read a step arg with a typed cast (validation already ran). */
export const argOf = <T extends MediaArgValue>(step: MediaStep, name: string): T | undefined =>
  step.args[name] as T | undefined
