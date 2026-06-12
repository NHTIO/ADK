/**
 * A knex-inspired local media pipeline: one declarative plan, three front-ends (chainable
 * builder, pipe string, JSON ops), engines as composable seams.
 *
 * @module @nhtio/adk/batteries/media
 *
 * @remarks
 * Most implementations give you two ways to process media — ship it to an external API, or
 * flood the model's context window with the bytes. This battery is the third option: **full
 * control of media — local processing, no external APIs by default, cross-environment where
 * possible.** Your data stays in your application and infrastructure unless you deliberately
 * wire an engine that sends it elsewhere.
 *
 * The entry point is {@link createMediaPipeline}:
 *
 * ```ts
 * import { createMediaPipeline } from '@nhtio/adk/batteries/media'
 *
 * const mp = await createMediaPipeline({
 *   engines: [
 *     // an ordered array of self-declaring engines; resolvers run eagerly at construction,
 *     // but each engine's heavy peer dependency loads lazily on first actual use
 *     () => import('@nhtio/adk/batteries/media/engines/jimp').then((m) => m.jimpEngine()),
 *   ],
 * })
 *
 * // chainable builder (implementor DX)
 * const redacted = await mp(payload)
 *   .select({ pages: [2, 3] })
 *   .redact({ match: [/\d{3}-\d{2}-\d{4}/] })
 *
 * // pipe string (the LLM-facing DSL — same plan underneath)
 * const result = await mp.query(payload, 'select pages=2-3 | redact match=/\\d{3}-\\d{2}-\\d{4}/')
 * ```
 *
 * Media pipelines have no standard — every tool invented its own grammar. LLMs don't share one
 * mental model of that chaos, so the pipe DSL projects every operation onto the one
 * transformation idiom every model already groks: shell pipes with `key=value` args. The verbs
 * a deployment advertises narrow to the engines it configured; everything else fails loud with
 * a model-actionable message.
 */

import { parsePipeRaw } from './pipe'
import { MediaChain } from './builder'
import { executePlan } from './runtime'
import { DOC_STEPS } from './steps/doc'
import { DATA_STEPS } from './steps/data'
import { SHEET_STEPS } from './steps/sheet'
import { validator } from '@nhtio/validation'
import { SLIDES_STEPS } from './steps/slides'
import { INGEST_STEPS } from './steps/ingest'
import { buildEngineRegistry } from './registry'
import { implementsMediaEngine } from './contracts'
import { isError, isObject } from '@nhtio/adk/guards'
import { IMAGE_AUDIO_STEPS } from './steps/image_audio'
import { validateSegments, validateOps } from './validate'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from './exceptions'
import { selectStep, splitStep, mergeStep, reorderStep } from './steps/pages'
import {
  chunkStep,
  extractTextStep,
  extractMetadataStep,
  redactStep,
  updateTextStep,
  diffStep,
  applyPatchStep,
} from './steps/text'
import type { MediaOp, MediaPlan } from './plan'
import type { MediaEngine, EngineResolver } from './contracts'
import type { EngineRegistry, EngineSelectionMiddlewareFn } from './registry'
import type { StepImpl, StepPayload, PlanResult, MediaStepMiddlewareFn } from './runtime'

export { MediaChain } from './builder'
export type {
  ChainExecutor,
  ChainInput,
  MediaChainRef,
  CellUpdate,
  ResizeOptions,
  SheetNamespace,
  SlidesNamespace,
  ImageNamespace,
  AudioNamespace,
} from './builder'
export { toPipe, toOps, fromOps, isMediaRef, isRegExpRef } from './plan'
export type {
  MediaPlan,
  MediaStep,
  MediaOp,
  MediaArgValue,
  MediaArgScalar,
  MediaArgJson,
  MediaRef,
  RegExpRef,
  SourceSpan,
} from './plan'
export { parsePipeRaw, lowerSegments } from './pipe'
export type { RawSegment, RawArgValue } from './pipe'
export { validateSegments, validateOps, availableVerbs } from './validate'
export type { ValidateOptions, CapabilityProbe } from './validate'
export { VERBS, VERB_INDEX, FOLDED_VERBS, foldVerb, suggestVerbs } from './verbs'
export type {
  VerbSpec,
  VerbArgSpec,
  VerbArgType,
  VerbOutput,
  VerbRequirement,
  FormatFamily,
} from './verbs'
export { PCM_MIME, EMPTY_MIME, pcmToBytes, bytesToPcm, implementsMediaEngine } from './contracts'
export type {
  MediaEngine,
  EngineResolver,
  ConvertCapability,
  ConvertRequest,
  ConvertResult,
  ConvertOutput,
  ConvertOptions,
  OcrConvertOptions,
  AsrConvertOptions,
  ImagesConvertOptions,
  MutateCapability,
  MutateRequest,
  EditCapability,
  EditRequest,
  EditResult,
  EditSummary,
  MimePattern,
} from './contracts'
export { buildEngineRegistry } from './registry'
export type {
  EngineRegistry,
  EngineSelectionContext,
  EngineSelectionMiddlewareFn,
} from './registry'
export type {
  StepPayload,
  StepResult,
  PlanResult,
  StepContext,
  StepImpl,
  MediaStepMiddlewareFn,
} from './runtime'
export {
  MIME,
  familyOf,
  unsupportedForMutationReason,
  replaceExtension,
  EXT_TO_MIME,
} from './formats'
export {
  E_INVALID_MEDIA_PIPELINE_CONFIG,
  E_MEDIA_PIPE_SYNTAX,
  E_MEDIA_UNKNOWN_VERB,
  E_MEDIA_UNKNOWN_ARG,
  E_MEDIA_BAD_ARG,
  E_MEDIA_MISSING_ARG,
  E_MEDIA_UNSUPPORTED_OP,
  E_MEDIA_ENGINE_REQUIRED,
  E_MEDIA_NOT_PIPE_EXPRESSIBLE,
  E_MEDIA_STEP_FAILED,
  E_MEDIA_STEP_UNAVAILABLE,
} from './exceptions'

/** Resolves a media-ref id to its payload — supplied by the consumer (or the agent forge). */
export type MediaRefResolver = (id: string) => StepPayload | Promise<StepPayload>

/** Per-run options for `query`/`ops`. */
export interface RunOptions {
  /** Abort signal threaded into steps and engines. */
  signal?: AbortSignal
  /** Per-run media-ref resolution, overriding the construction-time resolver (the agent forge uses this to resolve `@id` refs against the current turn). */
  resolveRef?: MediaRefResolver
}

/** Configuration for {@link createMediaPipeline}. */
export interface MediaPipelineConfig {
  /**
   * The engine array, in priority order. Each entry is a {@link MediaEngine} instance or a
   * resolver returning one (async dynamic import is the canonical form). Engines self-declare
   * their capabilities; verbs whose capability has no provider are not advertised and fail
   * validation with a do-not-retry message if reached. Resolvers run eagerly at construction —
   * bundled engines stay cheap because their heavy peers lazy-load inside capability methods.
   */
  engines?: ReadonlyArray<EngineResolver<MediaEngine>>
  /**
   * Selection-middleware stages arbitrating dispatches where several engines can perform the
   * same transform. Stages may exclude or reorder candidates (quality heuristics, overrides);
   * array order among survivors always breaks the tie. Most deployments need none.
   */
  selection?: EngineSelectionMiddlewareFn[]
  /**
   * Consumer step interceptors wrapping every step — the documented seam for DLP/AV byte
   * scanning, caching (via `ctx.shortCircuit`), byte limits, and telemetry. The battery
   * ships no built-in scanner/cache/limiter.
   */
  use?: MediaStepMiddlewareFn[]
  /**
   * Resolves `@id` media refs (merge/diff/replace targets). Required only when chains use
   * multi-input verbs; the agent forge supplies a turn-state resolver automatically.
   */
  resolveRef?: MediaRefResolver
}

/**
 * The callable pipeline returned by {@link createMediaPipeline}: `mp(payload)` opens a
 * chainable builder; `mp.query(payload, q)` runs a pipe-string statement; `mp.ops(payload,
 * ops)` runs a JSON ops array. All three compile to the same plan and execute on the same
 * runtime.
 */
export interface MediaPipeline {
  /** Open a fresh chainable builder over `input`. */
  (input: StepPayload): MediaChain
  /** Parse, validate, and execute a pipe-string statement. */
  query(input: StepPayload, q: string, options?: RunOptions): Promise<PlanResult>
  /** Validate and execute a JSON ops array. */
  ops(input: StepPayload, ops: MediaOp[], options?: RunOptions): Promise<PlanResult>
  /** Validate a pipe string or ops array to a plan WITHOUT executing (dry-run/compile). */
  compile(statement: string | MediaOp[]): MediaPlan
  /**
   * The deployment's engine registry (drives verb narrowing AND generation/edit dispatch —
   * the runtime value has always been the registry; the declared type now says so).
   */
  readonly capabilities: EngineRegistry
  /** The resolved engines, in supply order — inspect ids and declared capabilities. */
  readonly engines: readonly MediaEngine[]
}

const configSchema = validator
  .object({
    engines: validator
      .array()
      .items(validator.alternatives().try(validator.function(), validator.object().unknown(true)))
      .optional(),
    selection: validator.array().items(validator.function()).optional(),
    use: validator.array().items(validator.function()).optional(),
    resolveRef: validator.function().optional(),
  })
  .unknown(false)

/** The Phase 0 step registry: pure steps available in every deployment. */
const PURE_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['select', selectStep],
  ['split', splitStep],
  ['merge', mergeStep],
  ['reorder', reorderStep],
  ['redact', redactStep],
  ['update_text', updateTextStep],
  ['diff', diffStep],
  ['apply_patch', applyPatchStep],
  ['extract.text', extractTextStep],
  ['extract.metadata', extractMetadataStep],
  ['chunk', chunkStep],
  ...DATA_STEPS,
  ...SHEET_STEPS,
  ...SLIDES_STEPS,
  // DOC_STEPS + INGEST_STEPS override the Phase 0 text-only implementations with format dispatch.
  ...DOC_STEPS,
  ...INGEST_STEPS,
  ...IMAGE_AUDIO_STEPS,
]

/** Resolve one engine entry: invoke a resolver, unwrap `{default}`, guard-check the result. */
const resolveEngine = async (
  entry: EngineResolver<MediaEngine>,
  index: number
): Promise<MediaEngine> => {
  let value: unknown = entry
  if (typeof value === 'function') {
    try {
      value = await (value as () => unknown)()
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([`engines[${index}] resolver failed: ${detail}`])
    }
    if (isObject(value) && 'default' in value && !implementsMediaEngine(value)) {
      value = (value as { default: unknown }).default
    }
  }
  if (!implementsMediaEngine(value)) {
    const candidate = value as { id?: unknown } | undefined
    const id = isObject(value) && typeof candidate?.id === 'string' ? ` ("${candidate.id}")` : ''
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      `engines[${index}]${id} does not implement the MediaEngine contract (a string id plus at least one well-formed converts/mutates capability entry)`,
    ])
  }
  return value
}

/**
 * Create a media pipeline.
 *
 * @remarks
 * Config is validated eagerly, and so are the engines: every resolver in the array runs at
 * construction (capability declarations drive verb narrowing, so they must be known up
 * front), each result is contract-checked, and failures throw
 * `E_INVALID_MEDIA_PIPELINE_CONFIG` naming the offending index. Construction stays cheap —
 * bundled engine modules import their heavy peer dependencies lazily inside capability
 * methods, on first actual use.
 *
 * @param config - Engines, selection stages, step interceptors, and the media-ref resolver.
 * @returns The callable {@link MediaPipeline}.
 */
export const createMediaPipeline = async (
  config: MediaPipelineConfig = {}
): Promise<MediaPipeline> => {
  const { error } = configSchema.validate(config, { abortEarly: true })
  if (error) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([error.message])
  }
  const use = config.use ?? []
  const resolveRef: MediaRefResolver =
    config.resolveRef ??
    (() => {
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        'this chain references another media (@id) but no resolveRef was configured',
      ])
    })

  const resolvedEngines = await Promise.all((config.engines ?? []).map(resolveEngine))
  const registry = buildEngineRegistry(resolvedEngines, config.selection ?? [])

  const steps = new Map<string, StepImpl>(PURE_STEPS)

  const run = async (
    input: StepPayload,
    plan: MediaPlan,
    options?: RunOptions
  ): Promise<PlanResult> => {
    const refResolver = options?.resolveRef ?? resolveRef
    return executePlan(plan, {
      input,
      steps,
      use,
      engines: registry,
      resolveRef: async (id) => refResolver(id),
      signal: options?.signal,
    })
  }

  const compile = (statement: string | MediaOp[]): MediaPlan =>
    typeof statement === 'string'
      ? validateSegments(parsePipeRaw(statement), { capabilities: registry })
      : validateOps(statement, { capabilities: registry })

  const callable = ((input: StepPayload): MediaChain => {
    return new MediaChain(async (ops) => {
      const plan = validateOps(ops, { capabilities: registry })
      return run(input, plan)
    })
  }) as MediaPipeline

  Object.defineProperties(callable, {
    query: {
      value: async (input: StepPayload, q: string, options?: RunOptions): Promise<PlanResult> => {
        const plan = validateSegments(parsePipeRaw(q), { capabilities: registry })
        return run(input, plan, options)
      },
    },
    ops: {
      value: async (
        input: StepPayload,
        ops: MediaOp[],
        options?: RunOptions
      ): Promise<PlanResult> => {
        const plan = validateOps(ops, { capabilities: registry })
        return run(input, plan, options)
      },
    },
    compile: { value: compile },
    capabilities: { value: registry },
    engines: { value: registry.engines },
  })

  return callable
}
