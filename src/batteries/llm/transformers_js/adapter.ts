/**
 * Dual-environment (Node + browser) executor adapter for transformers.js (`@huggingface/transformers`).
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/adapter
 *
 * @remarks
 * On-device text generation via ONNX Runtime — `onnxruntime-node` (native) in Node, `onnxruntime-web`
 * (WASM + WebGPU) in the browser, auto-selected by the package. So this battery is
 * **environment-neutral**: it does NOT gate on WebGPU.
 *
 * **transformers.js is text-in / text-out.** It injects tool definitions into the chat template but
 * does NOT return structured tool calls or reasoning — the model emits both as **family-specific raw
 * text**. This adapter parses them out via the shared, configurable parser layer (`toolCallParser` /
 * `reasoningParser`, both defaulting to `'auto'`): after generation, the reasoning parser pulls
 * thinking into ADK Thoughts and the tool-call parser pulls calls into ADK ToolCalls, leaving clean
 * prose as the assistant Message.
 *
 * Three pluggable layers mirror the other LLM batteries: swappable translation helpers, three-layer
 * options merging (constructor → `executor()` overrides → `ctx.stash.transformersJs`), and an
 * injectable/lazy pipeline (`pipeline` or `createPipeline`, defaulting to a dynamic import).
 */

import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { validateOptions } from './validation'
import { withModelSource } from './model_source'
import { emitLifecycle } from '../chat_common/lifecycle'
import { stripEnvelopeSpecialTokens } from '../chat_common/helpers'
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
import { resolveGenerationOptions } from '../chat_common/generation'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { resolveReasoningParser } from '../chat_common/reasoning_parsers'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  Tokenizable,
  ToolRegistry,
  ToolCall,
  Message,
  Thought,
  SpooledArtifact,
  Media,
  ArtifactTool,
} from '@nhtio/adk/common'
import {
  E_TRANSFORMERS_JS_CONTEXT_OVERFLOW,
  E_TRANSFORMERS_JS_STREAM_ERROR,
  E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS,
} from './exceptions'
import {
  defaultDescriptionToChatCompletionsJsonSchema,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
  defaultRenderStandingInstructions,
  defaultRenderMemories,
  defaultRenderRetrievables,
  defaultRenderRetrievableSafetyDirective,
  defaultRenderFirstPartyRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  defaultRenderThought,
  defaultFilterThoughts,
  defaultRenderChatCompletionsSystemPrompt,
  defaultToolsToTransformersJsTools,
  defaultRenderTransformersJsToolResult,
  defaultBuildTransformersJsMessages,
  defaultMediaToTransformersInput,
  defaultCreateTransformersJsStreamAccumulator,
} from './helpers'
import type { Tool } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { ParsedToolCall } from '../chat_common/tool_parsers'
import type { ChatSampler, ResolvedGenerationOptions } from '../chat_common/generation'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type {
  TransformersJsAdapterOptions,
  TransformersJsPipeline,
  TransformersJsModel,
  TransformersJsProcessor,
} from './types'

// ─── Option merging (constructor → executor overrides → stash) ────────────────────────────────────

const mergeHelpers = (
  layers: ReadonlyArray<Partial<NonNullable<TransformersJsAdapterOptions['helpers']>> | undefined>
): Partial<NonNullable<TransformersJsAdapterOptions['helpers']>> | undefined => {
  let merged: Partial<NonNullable<TransformersJsAdapterOptions['helpers']>> | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? {}), ...layer }
  }
  return merged
}

const mergeOptions = (
  baseline: TransformersJsAdapterOptions,
  exec: Partial<TransformersJsAdapterOptions> | undefined,
  stash: Partial<TransformersJsAdapterOptions> | undefined
): Partial<TransformersJsAdapterOptions> => {
  const layers = [baseline as Partial<TransformersJsAdapterOptions>, exec ?? {}, stash ?? {}]
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (k === 'helpers') continue
      out[k] = v
    }
  }
  const helpers = mergeHelpers(layers.map((l) => l.helpers))
  if (helpers !== undefined) out.helpers = helpers
  return out as Partial<TransformersJsAdapterOptions>
}

// ─── Helper resolution (fall back to bundled defaults per field) ──────────────────────────────────

interface ResolvedHelpers {
  descriptionToChatCompletionsJsonSchema: typeof defaultDescriptionToChatCompletionsJsonSchema
  renderUntrustedContent: typeof defaultRenderUntrustedContent
  renderTrustedContent: typeof defaultRenderTrustedContent
  renderStandingInstructions: typeof defaultRenderStandingInstructions
  renderMemories: typeof defaultRenderMemories
  renderRetrievables: typeof defaultRenderRetrievables
  renderRetrievableSafetyDirective: typeof defaultRenderRetrievableSafetyDirective
  renderFirstPartyRetrievables: typeof defaultRenderFirstPartyRetrievables
  renderThirdPartyPublicRetrievables: typeof defaultRenderThirdPartyPublicRetrievables
  renderThirdPartyPrivateRetrievables: typeof defaultRenderThirdPartyPrivateRetrievables
  renderThought: typeof defaultRenderThought
  filterThoughts: typeof defaultFilterThoughts
  renderChatCompletionsSystemPrompt: typeof defaultRenderChatCompletionsSystemPrompt
  toolsToTransformersJsTools: typeof defaultToolsToTransformersJsTools
  renderTransformersJsToolResult: typeof defaultRenderTransformersJsToolResult
  buildTransformersJsMessages: typeof defaultBuildTransformersJsMessages
  createTransformersJsStreamAccumulator: typeof defaultCreateTransformersJsStreamAccumulator
}

const resolveHelpers = (
  overrides: Partial<TransformersJsAdapterOptions['helpers']> | undefined
): ResolvedHelpers => {
  const src = (overrides ?? {}) as Record<string, unknown>
  const pick = <K extends keyof ResolvedHelpers>(
    key: K,
    dflt: ResolvedHelpers[K]
  ): ResolvedHelpers[K] => (src[key as string] as ResolvedHelpers[K]) ?? dflt
  return {
    descriptionToChatCompletionsJsonSchema: pick(
      'descriptionToChatCompletionsJsonSchema',
      defaultDescriptionToChatCompletionsJsonSchema
    ),
    renderUntrustedContent: pick('renderUntrustedContent', defaultRenderUntrustedContent),
    renderTrustedContent: pick('renderTrustedContent', defaultRenderTrustedContent),
    renderStandingInstructions: pick(
      'renderStandingInstructions',
      defaultRenderStandingInstructions
    ),
    renderMemories: pick('renderMemories', defaultRenderMemories),
    renderRetrievables: pick('renderRetrievables', defaultRenderRetrievables),
    renderRetrievableSafetyDirective: pick(
      'renderRetrievableSafetyDirective',
      defaultRenderRetrievableSafetyDirective
    ),
    renderFirstPartyRetrievables: pick(
      'renderFirstPartyRetrievables',
      defaultRenderFirstPartyRetrievables
    ),
    renderThirdPartyPublicRetrievables: pick(
      'renderThirdPartyPublicRetrievables',
      defaultRenderThirdPartyPublicRetrievables
    ),
    renderThirdPartyPrivateRetrievables: pick(
      'renderThirdPartyPrivateRetrievables',
      defaultRenderThirdPartyPrivateRetrievables
    ),
    renderThought: pick('renderThought', defaultRenderThought),
    filterThoughts: pick('filterThoughts', defaultFilterThoughts),
    renderChatCompletionsSystemPrompt: pick(
      'renderChatCompletionsSystemPrompt',
      defaultRenderChatCompletionsSystemPrompt
    ),
    toolsToTransformersJsTools: pick(
      'toolsToTransformersJsTools',
      defaultToolsToTransformersJsTools
    ),
    renderTransformersJsToolResult: pick(
      'renderTransformersJsToolResult',
      defaultRenderTransformersJsToolResult
    ),
    buildTransformersJsMessages: pick(
      'buildTransformersJsMessages',
      defaultBuildTransformersJsMessages
    ),
    createTransformersJsStreamAccumulator: pick(
      'createTransformersJsStreamAccumulator',
      defaultCreateTransformersJsStreamAccumulator
    ),
  }
}

const nowIso = (): string => DateTime.now().toISO() as string

const computeChecksum = (tool: string, args: Record<string, unknown>): string =>
  sha256(canonicalStringify({ tool, args }))

/**
 * Wrap the consumer's `onInitProgress` so each transformers.js download event ALSO emits a normalized
 * `loading` lifecycle report. The HF `progress` field is 0..100 → forwarded as `progress` 0..1, with the
 * raw payload on `raw`. The original `onInitProgress` is still called verbatim (additive). Returns the
 * original callback unchanged when no lifecycle hooks are configured (zero overhead on the text path).
 */
const wrapTransformersInitProgress = (
  merged: TransformersJsAdapterOptions
): TransformersJsAdapterOptions['onInitProgress'] => {
  const hasLifecycle =
    merged.onLifecycle ??
    merged.onLoading ??
    merged.onReady ??
    merged.onGenerating ??
    merged.onError
  if (!hasLifecycle) return merged.onInitProgress
  return (info: unknown) => {
    const p = (info as { progress?: number } | undefined)?.progress
    emitLifecycle(merged, 'transformers_js', merged.model, 'loading', {
      ...(typeof p === 'number' ? { progress: p / 100 } : {}),
      raw: info,
    })
    merged.onInitProgress?.(info as never)
  }
}

/** Markers that signal the start of tool-call / reasoning markup — used to stop streaming prose. */
const TEXT_MARKUP_MARKERS = [
  '<tool_call>',
  '<|tool_call>',
  '<|channel',
  '<think',
  '[TOOL_CALLS]',
  '<function=',
]

/** An assembled tool call ready for execution (args already a parsed object). */
interface AssembledToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  argsWellFormed: boolean
}

/**
 * Dual-environment executor adapter for transformers.js text generation.
 *
 * @remarks
 * Construct with at least `{ model }`; wire `new TransformersJsAdapter(opts).executor()` into a
 * `DispatchRunner` as the `executorCallback`. The pipeline is resolved lazily on first dispatch (or
 * eagerly via {@link TransformersJsAdapter.preload}); pass `pipeline` to inject a pre-built one.
 */
export class TransformersJsAdapter {
  /** The `ctx.stash` key under which per-dispatch option overrides are read. */
  public static readonly STASH_KEY = 'transformersJs' as const

  readonly #baseline: TransformersJsAdapterOptions
  #pipeline: TransformersJsPipeline | undefined
  #pipelinePromise: Promise<TransformersJsPipeline> | undefined
  #mmEngine: { model: TransformersJsModel; processor: TransformersJsProcessor } | undefined
  #mmEnginePromise:
    | Promise<{ model: TransformersJsModel; processor: TransformersJsProcessor }>
    | undefined

  /**
   * Whether this battery is available. transformers.js is environment-neutral (Node + browser), so this
   * is `true` whenever the runtime can import the peer — there is no WebGPU requirement. Static form
   * returns `true`; the instance form honours an injected `isAvailable` override.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Raw adapter options, validated against `transformersJsOptionsSchema`.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_OPTIONS} when `options` are invalid.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
    this.#pipeline = this.#baseline.pipeline
  }

  /** Instance availability probe (honours the `isAvailable` option override). */
  isAvailable(): boolean {
    return (this.#baseline.isAvailable ?? TransformersJsAdapter.isAvailable)()
  }

  /**
   * Eagerly resolve (load) the pipeline before the first dispatch.
   *
   * @param overrides - Optional option overrides applied for this load.
   */
  async preload(
    overrides?: Partial<TransformersJsAdapterOptions>
  ): Promise<TransformersJsPipeline> {
    const merged = validateOptions(mergeOptions(this.#baseline, overrides, undefined))
    return this.#resolvePipeline(merged)
  }

  /** Drop the cached pipeline/engine and any in-flight load so the next dispatch re-resolves it. */
  reset(): void {
    this.#pipeline = undefined
    this.#pipelinePromise = undefined
    this.#mmEngine = undefined
    this.#mmEnginePromise = undefined
  }

  /**
   * Release the loaded model's underlying ONNX sessions + GPU/wasm buffers, then drop all cached
   * references (so the next dispatch re-resolves a fresh pipeline).
   *
   * @remarks
   * `reset()` only nulls the JS references — it does NOT free the native ONNX Runtime sessions or the
   * WebGPU/wasm device memory they hold. Those leak until GC, and in a browser session that loads many
   * models back-to-back (e.g. a full matrix run) the accumulated sessions exhaust the heap, surfacing as
   * `Can't create a session … Failed to load external data file … memory copy`. transformers.js exposes
   * `PreTrainedModel.dispose()` ("disposes of all the ONNX sessions created during inference") and
   * `Pipeline.dispose()` — this awaits them so the memory is actually reclaimed between loads. Settles any
   * in-flight load first, swallows per-handle disposal errors (a half-loaded model must not throw out of
   * teardown), and finishes with `reset()`. Idempotent and safe to call when nothing is loaded.
   */
  async dispose(): Promise<void> {
    // Settle any in-flight load so we dispose the resolved handle rather than orphaning it.
    const pipeline = this.#pipeline ?? (await this.#pipelinePromise?.catch(() => undefined))
    const mmEngine = this.#mmEngine ?? (await this.#mmEnginePromise?.catch(() => undefined))
    const disposables: Array<Promise<unknown>> = []
    const pipeWithDispose = pipeline as { dispose?: () => Promise<unknown> } | undefined
    if (typeof pipeWithDispose?.dispose === 'function') {
      disposables.push(Promise.resolve(pipeWithDispose.dispose()).catch(() => undefined))
    }
    const mmModel = mmEngine?.model as { dispose?: () => Promise<unknown> } | undefined
    if (typeof mmModel?.dispose === 'function') {
      disposables.push(Promise.resolve(mmModel.dispose()).catch(() => undefined))
    }
    await Promise.all(disposables)
    this.reset()
  }

  /**
   * Resolve the PORTABLE generation contract (shared with LiteRT-LM) from the merged options. Canonical
   * fields win; the transformers.js-native fields ({@link TransformersJsAdapterOptions.maxNewTokens},
   * `doSample`, `multimodal`, …) are the fallback layer consulted only when the canonical one is unset.
   */
  #gen(merged: TransformersJsAdapterOptions): ResolvedGenerationOptions {
    // Native `multimodal` is `boolean | {image,audio}` → normalise to the canonical `{image,audio}` shape.
    const mm = merged.multimodal
    const normalizedMultimodal: { image?: boolean; audio?: boolean } | undefined =
      mm === undefined || mm === false
        ? mm === false
          ? { image: false, audio: false }
          : undefined
        : mm === true
          ? { image: true, audio: true }
          : mm
    // Native `doSample` boolean → canonical sampler strategy. `true` becomes `'top-p'` (the common
    // nucleus default); an explicit `sampler` canonical field overrides this entirely.
    const nativeSampler: ChatSampler | undefined =
      merged.doSample === undefined ? undefined : merged.doSample ? 'top-p' : 'greedy'
    return resolveGenerationOptions(
      {
        maxTokens: merged.maxTokens,
        sampler: merged.sampler,
        temperature: merged.temperature,
        topK: merged.topK,
        topP: merged.topP,
        seed: merged.seed,
        enableThinking: merged.enableThinking,
        // The canonical `multimodal` IS the native field here (transformers.js already used `{image,audio}`);
        // pass it as both so canonical-wins is a no-op and the normalized shape flows through.
        multimodal: normalizedMultimodal,
      },
      {
        maxTokens: merged.maxNewTokens,
        sampler: nativeSampler,
        multimodal: normalizedMultimodal,
      }
    )
  }

  /** Normalise multimodal config to `{image,audio}` flags, or undefined when fully off. */
  #multimodalFlags(
    merged: TransformersJsAdapterOptions
  ): { image: boolean; audio: boolean } | undefined {
    const { multimodal } = this.#gen(merged)
    return multimodal.image || multimodal.audio ? multimodal : undefined
  }

  /** Resolve (and cache, single-flight) the multimodal model+processor pair. */
  async #resolveMultimodalEngine(
    merged: TransformersJsAdapterOptions
  ): Promise<{ model: TransformersJsModel; processor: TransformersJsProcessor }> {
    if (merged.multimodalEngine) {
      this.#mmEngine = merged.multimodalEngine
      return merged.multimodalEngine
    }
    if (this.#mmEngine) return this.#mmEngine
    this.#mmEnginePromise ??= (async () => {
      emitLifecycle(merged, 'transformers_js', merged.model, 'loading', {
        detail: 'loading multimodal model + processor',
      })
      // Forward each provider download event into a `loading` lifecycle report (normalized 0..1).
      const forwardedInitProgress = wrapTransformersInitProgress(merged)
      try {
        const createMultimodal =
          merged.createMultimodal ??
          (async ({ model, device, dtype, onInitProgress }) => {
            const transformers = await import('@huggingface/transformers')
            const { AutoModelForImageTextToText, AutoProcessor, env } = transformers
            const load = async () => {
              const [m, processor] = await Promise.all([
                AutoModelForImageTextToText.from_pretrained(model, {
                  ...(device ? { device } : {}),
                  ...(dtype ? { dtype } : {}),
                  ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
                } as never) as unknown as Promise<TransformersJsModel>,
                AutoProcessor.from_pretrained(model) as unknown as Promise<TransformersJsProcessor>,
              ])
              return { model: m, processor }
            }
            // When a custom model source is configured, serve files through it (OPFS / bundled / etc.)
            // behind the global-`env` mutex; otherwise load straight from HF (unchanged path).
            return merged.modelSource
              ? withModelSource(env as never, merged.modelSource, load)
              : load()
          })
        // `from_pretrained` covers both fetch (reported via progress_callback → `loading`) and the
        // ONNX-graph / WebGPU-WASM warmup. Mark the latter as `compiling` — a COARSE upper-bound marker
        // (fetch + compile overlap inside the call, so this is "now preparing the graph", not a strict
        // post-download boundary).
        emitLifecycle(merged, 'transformers_js', merged.model, 'compiling', {
          detail: 'compiling multimodal model graph',
        })
        const engine = await createMultimodal({
          model: merged.model,
          device: merged.device,
          dtype: merged.dtype,
          onInitProgress: forwardedInitProgress,
        })
        this.#mmEngine = engine
        emitLifecycle(merged, 'transformers_js', merged.model, 'ready', {
          detail: 'multimodal model + processor ready',
        })
        return engine
      } catch (err) {
        this.#mmEnginePromise = undefined
        emitLifecycle(merged, 'transformers_js', merged.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_STREAM_ERROR([
          `could not load the transformers.js multimodal model: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#mmEnginePromise
  }

  async #resolvePipeline(merged: TransformersJsAdapterOptions): Promise<TransformersJsPipeline> {
    if (merged.pipeline) {
      this.#pipeline = merged.pipeline
      return merged.pipeline
    }
    if (this.#pipeline) return this.#pipeline
    this.#pipelinePromise ??= (async () => {
      emitLifecycle(merged, 'transformers_js', merged.model, 'loading', {
        detail: 'loading text-generation pipeline',
      })
      const forwardedInitProgress = wrapTransformersInitProgress(merged)
      try {
        const createPipeline =
          merged.createPipeline ??
          (async ({ model, device, dtype, onInitProgress }) => {
            const transformers = await import('@huggingface/transformers')
            const { pipeline, env } = transformers
            const load = async () =>
              (await pipeline('text-generation', model, {
                ...(device ? { device } : {}),
                ...(dtype ? { dtype } : {}),
                ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
              } as never)) as unknown as TransformersJsPipeline
            return merged.modelSource
              ? withModelSource(env as never, merged.modelSource, load)
              : load()
          })
        // `from_pretrained` covers both fetch (reported via progress_callback → `loading`) and the
        // ONNX-graph / WebGPU-WASM warmup. Mark the latter as `compiling` — a COARSE upper-bound marker
        // (fetch + compile overlap inside the call, so this is "now preparing the graph", not a strict
        // post-download boundary).
        emitLifecycle(merged, 'transformers_js', merged.model, 'compiling', {
          detail: 'compiling text-generation graph',
        })
        const pipe = await createPipeline({
          model: merged.model,
          device: merged.device,
          dtype: merged.dtype,
          onInitProgress: forwardedInitProgress,
        })
        this.#pipeline = pipe
        emitLifecycle(merged, 'transformers_js', merged.model, 'ready', {
          detail: 'text-generation pipeline ready',
        })
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
        emitLifecycle(merged, 'transformers_js', merged.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_STREAM_ERROR([
          `could not load the transformers.js pipeline: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#pipelinePromise
  }

  /**
   * Build the transformers.js `generate` kwargs from the merged options (excluding tools/streamer).
   *
   * @remarks
   * Every sampling/length knob is passed EXPLICITLY with a deterministic-friendly default (resolved via
   * the shared {@link resolveGenerationOptions} from the portable contract) so the downstream `generate`
   * never falls back to the model config's own guess — the source of per-model surprises. Greedy maps to
   * `do_sample:false`; `'top-k'`/`'top-p'` map to `do_sample:true` + the matching cutoff.
   */
  #generateKwargs(merged: TransformersJsAdapterOptions): Record<string, unknown> {
    const gen = this.#gen(merged)
    const doSample = gen.sampler !== 'greedy'
    const kw: Record<string, unknown> = {
      max_new_tokens: gen.maxTokens,
      do_sample: doSample,
      repetition_penalty: merged.repetitionPenalty ?? 1.1,
    }
    // Sampler knobs are meaningful ONLY when sampling. Greedy ignores them and transformers.js logs a
    // warning if they're set — so send them only when sampling. We always send BOTH top_k and top_p (the
    // generate() call accepts both regardless of strategy; the strategy just determines which dominates),
    // keeping the sampler fully specified. seed is forwarded when provided.
    if (doSample) {
      kw.temperature = gen.temperature
      kw.top_k = gen.topK
      kw.top_p = gen.topP
      if (gen.seed !== undefined) kw.seed = gen.seed
    }
    if (merged.stopStrings !== undefined) kw.stop_strings = [...merged.stopStrings]
    return kw
  }

  /**
   * Produce the bound {@link DispatchExecutorFn} the `DispatchRunner` invokes.
   *
   * @param overrides - Option overrides layered above the constructor baseline (below `ctx.stash`).
   */
  executor(overrides?: Partial<TransformersJsAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = TransformersJsAdapter
    const self = this
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      // 1. Three-layer merge + re-validate.
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object'
          ? (stashRaw as Partial<TransformersJsAdapterOptions>)
          : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))
      const h = resolveHelpers(merged.helpers)
      const selfIdentity = merged.selfIdentity ?? 'assistant'
      const unsupportedMediaPolicy = merged.unsupportedMediaPolicy ?? 'throw'
      const toolCallParser = resolveToolCallParser(merged.toolCallParser)
      const reasoningParser = resolveReasoningParser(merged.reasoningParser, undefined, {
        orphanRecovery: merged.reasoningOrphanRecovery,
      })

      // 2. Forge artifact-query tools from prior turn's spooled artifacts; merge into ctx.tools.
      let mergedRegistry: ToolRegistry = ctx.tools
      const artifactCtors = new Set<{ forgeTools: (c: DispatchContext) => ToolRegistry }>()
      for (const tc of ctx.turnToolCalls) {
        const r = tc.results
        const arr = Array.isArray(r) ? r : [r]
        for (const item of arr) {
          if (SpooledArtifact.isSpooledArtifact(item)) {
            const ctor = (item as SpooledArtifact).constructor as unknown as {
              forgeTools?: (c: DispatchContext) => ToolRegistry
            }
            if (typeof ctor.forgeTools === 'function')
              artifactCtors.add(ctor as { forgeTools: (c: DispatchContext) => ToolRegistry })
          }
        }
      }
      if (artifactCtors.size > 0) {
        const registries = [ctx.tools, ...[...artifactCtors].map((c) => c.forgeTools(ctx))]
        mergedRegistry = ToolRegistry.merge(registries, { onCollision: 'keep' })
        mergedRegistry.bindContext(ctx)
      }

      // 3. Pre-render persisted tool-call results into plain-text tool message bodies.
      const renderedToolCallResults = new Map<string, string>()
      for (const tc of ctx.turnToolCalls) {
        const tool = mergedRegistry.get(tc.tool)
        const body = await h.renderTransformersJsToolResult({
          toolCall: tc,
          results: tc.results,
          tool: tool as Tool | ArtifactTool | undefined,
          unsupportedMediaPolicy,
          renderUntrustedContent: h.renderUntrustedContent,
          renderTrustedContent: h.renderTrustedContent,
          warn: (m) => helpers.log.warn({ kind: 'transformers-render-warning', message: m }),
        })
        renderedToolCallResults.set(tc.id, body)
      }

      // 4. Optional context-window enforcement.
      if (merged.tokenEncoding && merged.contextWindow !== undefined) {
        const enc = merged.tokenEncoding
        const tally = (s: string): number => new Tokenizable(s).estimateTokens(enc)
        let total = tally(ctx.systemPrompt.toString())
        for (const si of ctx.standingInstructions) total += tally(si.toString())
        for (const m of ctx.turnMemories) total += tally(m.content.toString())
        for (const r of ctx.turnRetrievables) total += tally((await r.contentString?.()) ?? '')
        for (const m of ctx.turnMessages) total += tally(m.content?.toString() ?? '')
        for (const t of ctx.turnThoughts) total += tally(t.content.toString())
        for (const body of renderedToolCallResults.values()) total += tally(body)
        if (total > merged.contextWindow) {
          throw new E_TRANSFORMERS_JS_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            String(enc),
            `system+buckets+timeline=${total}`,
          ])
        }
      }

      // 5. Build the transformers.js message array + tools (+ decoded media when multimodal).
      const mmFlags = self.#multimodalFlags(merged)
      const {
        messages: turnMessages,
        tools: toolDefs,
        images: mmImages,
        audio: mmAudio,
      } = await h.buildTransformersJsMessages({
        systemPrompt: ctx.systemPrompt,
        standingInstructions: ctx.standingInstructions,
        memories: ctx.turnMemories,
        retrievables: ctx.turnRetrievables,
        messages: ctx.turnMessages,
        thoughts: ctx.turnThoughts,
        toolCalls: ctx.turnToolCalls,
        tools: mergedRegistry,
        renderedToolCallResults,
        bucketOrder: merged.bucketOrder ?? [
          'standingInstructions',
          'memories',
          'retrievables',
          'timeline',
        ],
        selfIdentity,
        thoughtSurfacing: merged.thoughtSurfacing ?? 'all-self',
        replayCompatibility: merged.replayCompatibility ?? [],
        toolsToTransformersJsTools: h.toolsToTransformersJsTools,
        renderThought: h.renderThought,
        filterThoughts: h.filterThoughts,
        renderUntrustedContent: h.renderUntrustedContent,
        renderTrustedContent: h.renderTrustedContent,
        renderChatCompletionsSystemPrompt: h.renderChatCompletionsSystemPrompt,
        renderStandingInstructions: h.renderStandingInstructions,
        renderMemories: h.renderMemories,
        renderRetrievables: h.renderRetrievables,
        renderRetrievableSafetyDirective: h.renderRetrievableSafetyDirective,
        renderFirstPartyRetrievables: h.renderFirstPartyRetrievables,
        renderThirdPartyPublicRetrievables: h.renderThirdPartyPublicRetrievables,
        renderThirdPartyPrivateRetrievables: h.renderThirdPartyPrivateRetrievables,
        multimodal: mmFlags,
        decodeMedia: mmFlags ? (media) => defaultMediaToTransformersInput(media) : undefined,
        unsupportedMediaPolicy,
        warn: (m) => helpers.log.warn({ kind: 'transformers-history-warning', message: m }),
      })

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      const stream = merged.stream ?? true
      const gen = self.#gen(merged)
      const generateKwargs = self.#generateKwargs(merged)
      const toolNames = mergedRegistry.visible().map((t) => t.name)

      // 6. Resolve the engine: multimodal model+processor, or the text-generation pipeline.
      let pipe: TransformersJsPipeline | undefined
      let mmEngine: { model: TransformersJsModel; processor: TransformersJsProcessor } | undefined
      try {
        if (mmFlags) mmEngine = await self.#resolveMultimodalEngine(merged)
        else pipe = await self.#resolvePipeline(merged)
      } catch (err) {
        ctx.nack(
          isInstanceOf(err, 'E_TRANSFORMERS_JS_STREAM_ERROR', E_TRANSFORMERS_JS_STREAM_ERROR)
            ? err
            : new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)])
        )
        return
      }

      if (ctx.abortSignal.aborted) return

      // ── Tool execution + persistence (args already an object — no JSON.parse) ──
      const executeAndPersistToolCall = async (call: AssembledToolCall): Promise<void> => {
        const tool = mergedRegistry.get(call.name)
        const completedAt = nowIso()
        if (!call.argsWellFormed) {
          const err = new E_TRANSFORMERS_JS_INVALID_TOOL_CALL_ARGS([
            'must be a JSON object',
            JSON.stringify(call.args),
          ])
          const results = new Tokenizable(err.message)
          helpers.reportToolCall(call.id, { tool: call.name, args: {} })
          helpers.reportToolCall(call.id, { results, isError: true, isComplete: true })
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: call.name,
              args: {},
              checksum: computeChecksum(call.name, {}),
              isComplete: true,
              isError: true,
              results,
              createdAt: completedAt,
              updatedAt: completedAt,
              completedAt,
            })
          )
          return
        }
        if (!tool) {
          const available = mergedRegistry
            .all()
            .map((t) => t.name)
            .sort()
          const errText =
            available.length > 0
              ? `Tool not found: ${call.name}. Available tools: ${available.join(', ')}.`
              : `Tool not found: ${call.name}. No tools are available this turn.`
          const results = new Tokenizable(errText)
          helpers.reportToolCall(call.id, { tool: call.name, args: call.args })
          helpers.reportToolCall(call.id, { results, isError: true, isComplete: true })
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: call.name,
              args: call.args,
              checksum: computeChecksum(call.name, call.args),
              isComplete: true,
              isError: true,
              results,
              createdAt: completedAt,
              updatedAt: completedAt,
              completedAt,
            })
          )
          return
        }
        helpers.reportToolCall(call.id, { tool: tool.name, args: call.args })
        const isArtifactTool = ArtifactTool.isArtifactTool(tool)
        let results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[] =
          new Tokenizable('')
        let toolHadError = false
        try {
          const raw = await tool.executor(ctx)(call.args)
          if (isArtifactTool) {
            results = Tokenizable.isTokenizable(raw)
              ? raw
              : typeof raw === 'string'
                ? new Tokenizable(raw)
                : (() => {
                    throw new Error(
                      `ArtifactTool "${tool.name}" returned a non-string/non-Tokenizable value`
                    )
                  })()
          } else if (Media.isMedia(raw)) {
            results = raw
          } else if (Array.isArray(raw) && raw.length > 0 && raw.every((m) => Media.isMedia(m))) {
            results = raw as Media[]
          } else if (typeof raw === 'string' || isInstanceOf(raw, 'Uint8Array', Uint8Array)) {
            const reader = await spoolStore.write(call.id, raw as string | Uint8Array)
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          } else {
            const reader = await spoolStore.write(call.id, String(raw))
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          }
        } catch (err) {
          toolHadError = true
          let detailMsg = isError(err) ? err.message : String(err)
          if (isError(err) && isError(err.cause) && err.cause.message !== err.message) {
            detailMsg = `${detailMsg} ${err.cause.message}`
          }
          results = new Tokenizable(detailMsg)
        }
        helpers.reportToolCall(call.id, { results, isError: toolHadError, isComplete: true })
        const completedAt2 = nowIso()
        await ctx.storeToolCall(
          new ToolCall({
            id: call.id,
            tool: tool.name,
            args: call.args,
            checksum: computeChecksum(tool.name, call.args),
            isComplete: true,
            isError: toolHadError,
            results,
            fromArtifactTool: isArtifactTool,
            createdAt: completedAt2,
            updatedAt: completedAt2,
            completedAt: completedAt2,
          })
        )
      }

      const assembleCalls = (raw: ReadonlyArray<ParsedToolCall>): AssembledToolCall[] =>
        raw.map((c) => ({
          id: uuidv6(),
          name: c.name,
          args: isObject(c.arguments) ? (c.arguments as Record<string, unknown>) : {},
          argsWellFormed: isObject(c.arguments),
        }))

      // Parse the full generated text → reasoning + clean prose + tool calls, then persist.
      const finishFromText = async (
        rawText: string,
        streamId: string,
        streamedProse: boolean,
        generatedMedia: Media[] = []
      ): Promise<void> => {
        // Normalise away non-semantic envelope/turn-boundary special tokens (Llama `<|python_tag|>`/
        // `<|eom_id|>`, ChatML `<|im_end|>`, …) before parsing. The streaming path decodes with
        // skip_special_tokens:false (its live prose-stop gate needs the markers), so without this the
        // parsers would see `<|python_tag|>{json}<|eom_id|>` on stream and decline — even though the
        // batch path (skip_special_tokens:true) parses the identical call. Idempotent on batch text.
        const fullText = stripEnvelopeSpecialTokens(rawText)
        const reasoned = reasoningParser(fullText)
        const afterReasoning = reasoned.cleanedText
        const parsed = toolCallParser(afterReasoning, { toolNames })
        const cleanText = parsed.cleanedText

        // Persist reasoning as Thoughts. Drop any trace whose trimmed content is empty — an
        // empty/whitespace thought (e.g. a model's `<think>\n\n</think>` no-think artifact) carries no
        // information and is just a model quirk; there is no point surfacing it to the consumer.
        for (const trace of reasoned.reasoning) {
          if (trace.trim().length === 0) continue
          const id = uuidv6()
          helpers.reportThought(id, trace, { isComplete: true })
          await ctx.storeThought(
            new Thought({
              id,
              content: trace,
              identity: selfIdentity,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            })
          )
        }

        // Persist the assistant message when there is clean prose OR generated media to carry. Media-only
        // turns (empty text + an audio/image attachment) are legitimate; the contract requires at least one
        // of `content`/`attachments`, so a turn with neither stores nothing (unchanged from before).
        if (cleanText.length > 0 || generatedMedia.length > 0) {
          if (streamedProse) {
            helpers.reportMessage(streamId, '', { isComplete: true })
          } else if (cleanText.length > 0) {
            helpers.reportMessage(streamId, cleanText, { isComplete: true })
          }
          await ctx.storeMessage(
            new Message({
              id: streamId,
              role: 'assistant',
              ...(cleanText.length > 0 ? { content: cleanText } : {}),
              ...(generatedMedia.length > 0 ? { attachments: generatedMedia } : {}),
              identity: selfIdentity,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            })
          )
        }

        // Execute tool calls.
        const calls = assembleCalls(parsed.calls)
        if (calls.length === 0) {
          if (merged.autoAck) ctx.ack()
          return
        }
        for (const call of calls) {
          if (ctx.abortSignal.aborted) return
          await executeAndPersistToolCall(call)
        }
      }

      // ── Streaming path ──
      // Unified generate: drives either the text-generation pipeline OR the multimodal model+processor.
      // Returns the final decoded text for the non-streaming path; streaming text arrives via `streamer`.
      // The raw generation object (model.generate / pipeline output) is captured here so the optional
      // `extractMediaOutputs` hook can surface GENERATED media (audio/image) as assistant attachments.
      let rawGenerationResult: unknown
      const runGenerate = async (streamer: unknown): Promise<string> => {
        if (mmEngine) {
          const { model, processor } = mmEngine
          const proc = processor as unknown as {
            apply_chat_template: (m: unknown, o: unknown) => unknown
            batch_decode: (t: unknown, o: unknown) => string[]
          }
          const callProc = processor as unknown as (
            ...args: unknown[]
          ) => Promise<Record<string, unknown>>
          const prompt = proc.apply_chat_template(turnMessages, {
            add_generation_prompt: true,
            tokenize: false,
            // Explicit thinking flag — never let the template default decide (Qwen3/DeepSeek default ON).
            enable_thinking: gen.enableThinking,
          })
          // processor(text, images, audio, options) — positional (verified against the real Gemma-4
          // `Gemma4Processor._call(text, images = null, audio = null, options)`). The audio slot is THIRD,
          // so when audio is present the images slot MUST be filled positionally (with `null` when there
          // is no image) — otherwise audio collapses into the images slot and the image processor throws
          // `image.rgb is not a function`. `if (images)`/`if (audio)` in the processor treat `null` as absent.
          const imageArg =
            mmImages.length === 0 ? null : mmImages.length === 1 ? mmImages[0] : mmImages
          const audioArg = mmAudio.length === 0 ? null : mmAudio.length === 1 ? mmAudio[0] : mmAudio
          const procArgs: unknown[] =
            mmAudio.length > 0
              ? [prompt, imageArg, audioArg] // audio needs the 3rd slot → fill images (null if none)
              : mmImages.length > 0
                ? [prompt, imageArg]
                : [prompt]
          const inputs = await callProc(...procArgs)
          const out = await (
            model as unknown as { generate: (o: unknown) => Promise<unknown> }
          ).generate({ ...inputs, ...generateKwargs, ...(streamer ? { streamer } : {}) })
          rawGenerationResult = out
          // Non-stream decode: slice the prompt tokens off, decode the new tail.
          try {
            const inputLen = (inputs.input_ids as { dims?: number[] } | undefined)?.dims?.[1] ?? 0
            const seq = out as { slice?: (...a: unknown[]) => unknown }
            const newTokens =
              typeof seq.slice === 'function' ? seq.slice(null, [inputLen, null]) : out
            const decoded = proc.batch_decode(newTokens, { skip_special_tokens: true })
            return (decoded?.[0] ?? '').toString()
          } catch {
            return ''
          }
        }
        const p = pipe as unknown as (m: unknown, k: unknown) => Promise<unknown>
        const output = await p(turnMessages, {
          ...generateKwargs,
          // Explicit thinking flag forwarded to the pipeline's internal apply_chat_template — never let
          // the template default decide (Qwen3/DeepSeek default thinking ON).
          enable_thinking: gen.enableThinking,
          ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
          ...(streamer ? { streamer } : {}),
        })
        rawGenerationResult = output
        return extractGeneratedText(output)
      }

      // Run the optional media-output extractor over the raw generation result, persisting each generated
      // media via `ctx.storeMediaBytes` and building first-party `Media` attachments. Returns [] when no
      // hook is configured or it yields nothing — the text-only path then attaches nothing (unchanged).
      const collectGeneratedMedia = async (): Promise<Media[]> => {
        if (!merged.extractMediaOutputs || rawGenerationResult === undefined) return []
        const outputs = await merged.extractMediaOutputs(rawGenerationResult)
        const media: Media[] = []
        for (const o of outputs) {
          const id = uuidv6()
          const reader = await ctx.storeMediaBytes(id, o.bytes)
          media.push(
            Media.toolGenerated({
              id,
              kind: o.kind,
              mimeType: o.mimeType,
              filename: o.filename ?? `${id}.${o.kind}`,
              reader,
            })
          )
        }
        return media
      }

      if (stream) {
        const accumulator = h.createTransformersJsStreamAccumulator()
        const streamId = uuidv6()
        let proseStopped = false
        let streamedProse = false

        // The decoded-text sink: feed the accumulator + stream safe prose deltas (stopping prose once
        // tool-call/think markup appears; the clean message is persisted after generation completes).
        const onText = (text: string): void => {
          accumulator.feed(text)
          if (proseStopped) return
          if (TEXT_MARKUP_MARKERS.some((m) => accumulator.content().includes(m))) {
            proseStopped = true
            return
          }
          if (text.length > 0) {
            streamedProse = true
            helpers.reportMessage(streamId, text)
          }
        }

        // Default streamer factory imports the peer's TextStreamer; `createStreamer` overrides it
        // (e.g. tests inject a lightweight sink to avoid importing the heavy peer in the browser env).
        // The tokenizer comes from the multimodal processor when present, else the pipeline.
        const tokenizerHost = (mmEngine?.processor ?? pipe) as unknown as { tokenizer: unknown }
        const createStreamer =
          merged.createStreamer ??
          (async ({ onText: cb }) => {
            const { TextStreamer } = await import('@huggingface/transformers')
            return new TextStreamer(
              tokenizerHost.tokenizer as never,
              {
                skip_prompt: true,
                skip_special_tokens: false,
                callback_function: cb,
              } as never
            )
          })

        let streamer: unknown
        try {
          streamer = await createStreamer({
            pipeline: pipe as TransformersJsPipeline,
            onText,
          })
        } catch (err) {
          emitLifecycle(merged, 'transformers_js', merged.model, 'error', { error: err })
          ctx.nack(new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }

        emitLifecycle(merged, 'transformers_js', merged.model, 'generating')
        try {
          await runGenerate(streamer)
        } catch (err) {
          if (ctx.abortSignal.aborted) return
          emitLifecycle(merged, 'transformers_js', merged.model, 'error', { error: err })
          ctx.nack(new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }
        if (ctx.abortSignal.aborted) return
        const streamMedia = await collectGeneratedMedia()
        await finishFromText(accumulator.content(), streamId, streamedProse, streamMedia)
        emitLifecycle(merged, 'transformers_js', merged.model, 'complete')
        return
      }

      // ── Non-streaming path ──
      let finalText: string
      emitLifecycle(merged, 'transformers_js', merged.model, 'generating')
      try {
        finalText = await runGenerate(undefined)
      } catch (err) {
        emitLifecycle(merged, 'transformers_js', merged.model, 'error', { error: err })
        ctx.nack(new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }
      if (ctx.abortSignal.aborted) return
      const nonStreamMedia = await collectGeneratedMedia()
      await finishFromText(finalText, uuidv6(), false, nonStreamMedia)
      emitLifecycle(merged, 'transformers_js', merged.model, 'complete')
    }
  }
}

/**
 * Pull the newly-generated assistant text out of a transformers.js text-generation result.
 *
 * @remarks
 * Chat input → `[{ generated_text: Message[] }]` (the last message is the new assistant turn);
 * string input → `[{ generated_text: string }]`. We always send chat input, so we take the last
 * message's content, falling back defensively to a string `generated_text`.
 */
const extractGeneratedText = (output: unknown): string => {
  const first = Array.isArray(output) ? output[0] : output
  const gen = (first as { generated_text?: unknown } | undefined)?.generated_text
  if (typeof gen === 'string') return gen
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1] as { content?: unknown } | undefined
    const content = last?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter(
          (i): i is { type: string; text: string } =>
            isObject(i) && (i as { type?: unknown }).type === 'text'
        )
        .map((i) => i.text)
        .join('')
    }
  }
  return ''
}

export { extractGeneratedText as __extractGeneratedText }
