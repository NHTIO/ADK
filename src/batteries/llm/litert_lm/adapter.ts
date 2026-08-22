/**
 * Browser/WebGPU executor adapter for Google's LiteRT-LM (`@litert-lm/core`).
 *
 * @module @nhtio/adk/batteries/llm/litert_lm/adapter
 *
 * @remarks
 * On-device LLM inference via WebGPU + a bundled wasm runtime, `.litertlm` models. Unlike the WebLLM
 * battery (a thin extension of the OpenAI Chat Completions wire shape), LiteRT-LM has its **own** API —
 * `Engine.create() → engine.createConversation({ preface }) → conversation.sendMessageStreaming():
 * ReadableStream<Message>` — with native `Message`/`Tool`/`tool_calls`/`tool_response` shapes (tool-call
 * `arguments` arrive as a parsed object, not a JSON string). So this is a standalone adapter that reuses
 * the ADK's format-agnostic render helpers but maps history/tools/results to LiteRT's shapes.
 *
 * Three pluggable layers mirror the other LLM batteries: swappable translation helpers, three-layer
 * options merging (constructor → `executor()` overrides → `ctx.stash.liteRtLm`), and an
 * injectable/lazy engine (`engine` or `createEngine`, defaulting to a dynamic `@litert-lm/core` import).
 *
 * **The published `@litert-lm/core` docs lag the library** — every wire field here is mapped against the
 * installed package's type declarations, the source of truth. The dependency is young (pinned exact);
 * re-verify on upgrade.
 */

import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { validateOptions } from './validation'
import { emitLifecycle } from '../chat_common/lifecycle'
import { E_LLM_GPU_OUT_OF_MEMORY } from '../chat_common/exceptions'
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
import { resolveGenerationOptions } from '../chat_common/generation'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { resolveReasoningParser } from '../chat_common/reasoning_parsers'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { isGpuOutOfMemoryError, probeGpuBudget } from '../chat_common/gpu_budget'
import {
  looksLikeSpooledArtifact,
  stripEnvelopeSpecialTokens,
  normalizeToolName,
} from '../chat_common/helpers'
import {
  Tokenizable,
  ToolCall,
  Message,
  Thought,
  SpooledArtifact,
  Media,
  ArtifactTool,
} from '@nhtio/adk/common'
import {
  E_INVALID_LITERT_LM_OPTIONS,
  E_LITERT_LM_CONTEXT_OVERFLOW,
  E_LITERT_LM_STREAM_ERROR,
  E_LITERT_LM_INVALID_TOOL_CALL_ARGS,
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
  defaultToolsToLiteRtTools,
  defaultRenderToolsAsPromptText,
  defaultRenderLiteRtToolResult,
  defaultRenderArtifactHandleBody,
  defaultBuildLiteRtConversationInput,
  defaultCreateLiteRtStreamAccumulator,
  renderMediaToLiteRtContent,
} from './helpers'
import type { Tool } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { ParsedToolCall } from '../chat_common/tool_parsers'
import type { ChatSampler, ResolvedGenerationOptions } from '../chat_common/generation'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type {
  LiteRtLmAdapterOptions,
  LiteRtLmEngine,
  LiteRtLmConversation,
  LiteRtMessage,
  LiteRtMessageContentItem,
  LiteRtEngineSettings,
  LiteRtConversationConfig,
  LiteRtSessionConfig,
  LiteRtSamplerParametersOption,
} from './types'

/** Markers that signal the start of tool-call / reasoning markup — used to stop streaming prose. */
const TEXT_MARKUP_MARKERS = [
  '<tool_call>',
  '<|tool_call>',
  '<|channel',
  '<think',
  '[TOOL_CALLS]',
  '<function=',
]

// ─── Option merging (constructor → executor overrides → stash) ────────────────────────────────────

const mergeHelpers = (
  layers: ReadonlyArray<Partial<NonNullable<LiteRtLmAdapterOptions['helpers']>> | undefined>
): Partial<NonNullable<LiteRtLmAdapterOptions['helpers']>> | undefined => {
  let merged: Partial<NonNullable<LiteRtLmAdapterOptions['helpers']>> | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? {}), ...layer }
  }
  return merged
}

const mergeOptions = (
  baseline: LiteRtLmAdapterOptions,
  exec: Partial<LiteRtLmAdapterOptions> | undefined,
  stash: Partial<LiteRtLmAdapterOptions> | undefined
): Partial<LiteRtLmAdapterOptions> => {
  const layers = [baseline as Partial<LiteRtLmAdapterOptions>, exec ?? {}, stash ?? {}]
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
  return out as Partial<LiteRtLmAdapterOptions>
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
  toolsToLiteRtTools: typeof defaultToolsToLiteRtTools
  renderToolsAsPromptText: typeof defaultRenderToolsAsPromptText
  renderLiteRtToolResult: typeof defaultRenderLiteRtToolResult
  renderArtifactHandleBody: typeof defaultRenderArtifactHandleBody
  buildLiteRtConversationInput: typeof defaultBuildLiteRtConversationInput
  createLiteRtStreamAccumulator: typeof defaultCreateLiteRtStreamAccumulator
}

const resolveHelpers = (
  overrides: Partial<LiteRtLmAdapterOptions['helpers']> | undefined
): ResolvedHelpers => {
  const src = (overrides ?? {}) as Record<string, unknown>
  return {
    descriptionToChatCompletionsJsonSchema:
      (src.descriptionToChatCompletionsJsonSchema as ResolvedHelpers['descriptionToChatCompletionsJsonSchema']) ??
      defaultDescriptionToChatCompletionsJsonSchema,
    renderUntrustedContent:
      (src.renderUntrustedContent as ResolvedHelpers['renderUntrustedContent']) ??
      defaultRenderUntrustedContent,
    renderTrustedContent:
      (src.renderTrustedContent as ResolvedHelpers['renderTrustedContent']) ??
      defaultRenderTrustedContent,
    renderStandingInstructions:
      (src.renderStandingInstructions as ResolvedHelpers['renderStandingInstructions']) ??
      defaultRenderStandingInstructions,
    renderMemories:
      (src.renderMemories as ResolvedHelpers['renderMemories']) ?? defaultRenderMemories,
    renderRetrievables:
      (src.renderRetrievables as ResolvedHelpers['renderRetrievables']) ??
      defaultRenderRetrievables,
    renderRetrievableSafetyDirective:
      (src.renderRetrievableSafetyDirective as ResolvedHelpers['renderRetrievableSafetyDirective']) ??
      defaultRenderRetrievableSafetyDirective,
    renderFirstPartyRetrievables:
      (src.renderFirstPartyRetrievables as ResolvedHelpers['renderFirstPartyRetrievables']) ??
      defaultRenderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables:
      (src.renderThirdPartyPublicRetrievables as ResolvedHelpers['renderThirdPartyPublicRetrievables']) ??
      defaultRenderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables:
      (src.renderThirdPartyPrivateRetrievables as ResolvedHelpers['renderThirdPartyPrivateRetrievables']) ??
      defaultRenderThirdPartyPrivateRetrievables,
    renderThought: (src.renderThought as ResolvedHelpers['renderThought']) ?? defaultRenderThought,
    filterThoughts:
      (src.filterThoughts as ResolvedHelpers['filterThoughts']) ?? defaultFilterThoughts,
    renderChatCompletionsSystemPrompt:
      (src.renderChatCompletionsSystemPrompt as ResolvedHelpers['renderChatCompletionsSystemPrompt']) ??
      defaultRenderChatCompletionsSystemPrompt,
    toolsToLiteRtTools:
      (src.toolsToLiteRtTools as ResolvedHelpers['toolsToLiteRtTools']) ??
      defaultToolsToLiteRtTools,
    renderToolsAsPromptText:
      (src.renderToolsAsPromptText as ResolvedHelpers['renderToolsAsPromptText']) ??
      defaultRenderToolsAsPromptText,
    renderLiteRtToolResult:
      (src.renderLiteRtToolResult as ResolvedHelpers['renderLiteRtToolResult']) ??
      defaultRenderLiteRtToolResult,
    renderArtifactHandleBody:
      (src.renderArtifactHandleBody as ResolvedHelpers['renderArtifactHandleBody']) ??
      defaultRenderArtifactHandleBody,
    buildLiteRtConversationInput:
      (src.buildLiteRtConversationInput as ResolvedHelpers['buildLiteRtConversationInput']) ??
      defaultBuildLiteRtConversationInput,
    createLiteRtStreamAccumulator:
      (src.createLiteRtStreamAccumulator as ResolvedHelpers['createLiteRtStreamAccumulator']) ??
      defaultCreateLiteRtStreamAccumulator,
  }
}

const nowIso = (): string => DateTime.now().toISO() as string

/** Best-effort lifecycle `model` label: the URL string, else a `<blob>`/`<stream>`/`<model>` marker. */
const litertModelLabel = (model: unknown): string =>
  typeof model === 'string'
    ? model
    : isInstanceOf(model, 'Blob', typeof Blob !== 'undefined' ? Blob : (undefined as never))
      ? '<blob>'
      : model && typeof (model as { getReader?: unknown }).getReader === 'function'
        ? '<stream>'
        : '<model>'

const computeChecksum = (tool: string, args: Record<string, unknown>): string =>
  sha256(canonicalStringify({ tool, args }))

/** An assembled tool call drained from the stream/response (args already a parsed object). */
interface AssembledLiteRtToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  argsWellFormed: boolean
}

/**
 * Does this raw engine message report an INPUT context-cap overflow — the prompt's token ids exceed the
 * engine's fixed `maxNumTokens`? The LiteRT-web runtime throws e.g. `Input token ids are too long.
 * Exceeding the maximum number of tokens allowed: 12596 >= 12288`. Matched so the raw throw can be
 * translated into the typed {@link E_LITERT_LM_CONTEXT_OVERFLOW} instead of the generic stream error —
 * this is the ENGINE BACKSTOP that fires when the optional pre-dispatch guard is unarmed or undercounts.
 * Exported so a host can classify a thrown/caught error the same way.
 */
export const isEngineContextOverflowMessage = (message: string): boolean =>
  /input token ids are too long|exceeding the maximum number of tokens/i.test(message)

/**
 * Translate a generation/load throw into the right battery exception:
 * - a typed {@link E_LITERT_LM_CONTEXT_OVERFLOW} when the engine reports an input context-cap overflow
 *   (parsed `actual >= limit` numbers when present), so a host can `catch` it and shed/retry — this is
 *   the backstop for the optional pre-dispatch guard;
 * - a typed, catchable {@link @nhtio/adk/batteries!E_LLM_GPU_OUT_OF_MEMORY} when the message matches a
 *   known WebGPU exhaustion signature (surface, don't impose);
 * - else the generic {@link E_LITERT_LM_STREAM_ERROR}.
 *
 * @param err - The raw thrown value.
 * @param contextNote - A short human-readable note carried on the OOM error's message.
 */
const toLiteRtGenerationError = (
  err: unknown,
  contextNote: string
):
  | InstanceType<typeof E_LITERT_LM_CONTEXT_OVERFLOW>
  | InstanceType<typeof E_LLM_GPU_OUT_OF_MEMORY>
  | InstanceType<typeof E_LITERT_LM_STREAM_ERROR> => {
  const message = isError(err) ? err.message : String(err)
  if (isEngineContextOverflowMessage(message)) {
    // Parse the engine's `actual >= limit` pair when present so the typed error carries real numbers the
    // host can act on; fall back to 0/0 with the raw message as the breakdown otherwise.
    const m = /(\d+)\s*>=\s*(\d+)/.exec(message)
    const actual = m ? Number(m[1]) : 0
    const limit = m ? Number(m[2]) : 0
    return new E_LITERT_LM_CONTEXT_OVERFLOW([actual, limit, 'engine', message])
  }
  if (isGpuOutOfMemoryError(message)) {
    return new E_LLM_GPU_OUT_OF_MEMORY([message, contextNote], {
      cause: isError(err) ? err : undefined,
    })
  }
  return new E_LITERT_LM_STREAM_ERROR([message])
}

/**
 * Cross-environment executor adapter for LiteRT-LM.
 *
 * @remarks
 * Construct with at least `{ model }`; wire `new LiteRtLmAdapter(opts).executor()` into a
 * `DispatchRunner` as the `executorCallback`. The engine is resolved lazily on first dispatch (or
 * eagerly via {@link LiteRtLmAdapter.preload}); pass `engine` to inject a pre-built one (e.g. in tests).
 */
export class LiteRtLmAdapter {
  /** The `ctx.stash` key under which per-dispatch option overrides are read. */
  public static readonly STASH_KEY = 'liteRtLm' as const

  readonly #baseline: LiteRtLmAdapterOptions
  #engine: LiteRtLmEngine | undefined
  #enginePromise: Promise<LiteRtLmEngine> | undefined

  /**
   * Returns `true` when the current runtime exposes WebGPU (`navigator.gpu`).
   */
  public static isAvailable(): boolean {
    return (
      typeof globalThis.navigator !== 'undefined' &&
      'gpu' in globalThis.navigator &&
      typeof (globalThis.navigator as { gpu?: unknown }).gpu !== 'undefined'
    )
  }

  /**
   * @param options - Raw adapter options, validated against `liteRtLmOptionsSchema`.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_LITERT_LM_OPTIONS} when `options` are invalid.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
    this.#engine = this.#baseline.engine
  }

  /** Instance WebGPU-availability probe (honours the `isWebGPUAvailable` option override). */
  isAvailable(): boolean {
    return (this.#baseline.isWebGPUAvailable ?? LiteRtLmAdapter.isAvailable)()
  }

  /**
   * Eagerly resolve (load) the engine before the first dispatch.
   *
   * @param overrides - Optional option overrides applied for this load.
   * @returns The resolved {@link LiteRtLmEngine}.
   */
  async preload(overrides?: Partial<LiteRtLmAdapterOptions>): Promise<LiteRtLmEngine> {
    const merged = validateOptions(mergeOptions(this.#baseline, overrides, undefined))
    return this.#resolveEngine(merged)
  }

  /** Drop the cached engine and any in-flight load so the next dispatch re-resolves it. */
  reset(): void {
    this.#engine = undefined
    this.#enginePromise = undefined
  }

  /**
   * Release the loaded engine's native resources (`Engine.delete()`), then drop the cached reference.
   *
   * @remarks
   * `reset()` only nulls the JS reference; the LiteRT engine holds a WebGPU device + compiled graph that
   * stay alive until GC. Loading many `.litertlm` engines back-to-back in one browser session accumulates
   * those until the GPU heap is exhausted. `@litert-lm/core`'s `Engine` exposes `delete()` — this settles
   * any in-flight load, awaits `delete()`, swallows a teardown error (teardown must not throw), and
   * finishes with `reset()`. Idempotent and safe when nothing is loaded.
   */
  async dispose(): Promise<void> {
    const engine = this.#engine ?? (await this.#enginePromise?.catch(() => undefined))
    const withDelete = engine as { delete?: () => unknown } | undefined
    if (typeof withDelete?.delete === 'function') {
      try {
        await Promise.resolve(withDelete.delete())
      } catch {
        // teardown must not throw
      }
    }
    this.reset()
  }

  /**
   * Free the WebGPU buffer cache by deleting the engine, then reload the same model.
   *
   * @remarks
   * The consumer-facing lever for the ONNX Runtime Web WebGPU buffer-freelist high-water-mark (see
   * {@link @nhtio/adk/batteries!probeGpuBudget}). The pool is flushed only when the engine's sessions are
   * released; there is no public flag to flush it mid-life, so the supported way to reclaim the retained
   * working-set without permanently unloading is to delete the engine and load again. This is exactly
   * `dispose()` then `preload()`, surfaced as a named, intentional operation (e.g. an application
   * offering a "free GPU memory" action after a {@link @nhtio/adk/batteries!E_LLM_GPU_OUT_OF_MEMORY}).
   * NOT invoked automatically — the ADK surfaces the lever and leaves the decision to the consumer.
   * Re-incurs the cold-load cost. Idempotent.
   *
   * @param overrides - Optional option overrides applied to the reload (same as {@link preload}).
   */
  async recycle(overrides?: Partial<LiteRtLmAdapterOptions>): Promise<void> {
    await this.dispose()
    await this.preload(overrides)
  }

  /** Build the LiteRT `EngineSettings` from the merged adapter options. */
  #engineSettings(merged: LiteRtLmAdapterOptions): LiteRtEngineSettings {
    const settings: LiteRtEngineSettings = {
      model: merged.model as LiteRtEngineSettings['model'],
    }
    if (merged.backend !== undefined) settings.backend = merged.backend as never
    if (merged.maxNumTokens !== undefined) {
      settings.mainExecutorSettings = { maxNumTokens: merged.maxNumTokens }
    }
    return settings
  }

  async #resolveEngine(merged: LiteRtLmAdapterOptions): Promise<LiteRtLmEngine> {
    if (merged.engine) {
      this.#engine = merged.engine
      return merged.engine
    }
    if (this.#engine) return this.#engine
    const available = (merged.isWebGPUAvailable ?? LiteRtLmAdapter.isAvailable)()
    if (!available) {
      throw new E_INVALID_LITERT_LM_OPTIONS([
        'LiteRT-LM requires a browser/runtime with WebGPU support',
      ])
    }
    const modelLabel = litertModelLabel(merged.model)
    this.#enginePromise ??= (async () => {
      // LiteRT 0.13.1 reports no granular download progress (Engine.create takes no callback), so
      // `loading` is a coarse start marker — the WebGPU/wasm boot happens inside Engine.create.
      emitLifecycle(merged, 'litert_lm', modelLabel, 'loading', {
        detail: 'loading model + booting WebGPU runtime',
      })
      try {
        const engineSettings = this.#engineSettings(merged)
        const createEngine =
          merged.createEngine ??
          (async ({ engineSettings: settings }) => {
            const { Engine } = await import('@litert-lm/core')
            return (await Engine.create(
              settings as never,
              merged.inputPromptAsHint
            )) as LiteRtLmEngine
          })
        // `Engine.create` is one opaque call covering both the (stream-fed) download and the WebGPU
        // shader/graph compilation. The compile span is the slow, otherwise-invisible part — mark it as
        // `compiling` here (the boundary the official LiteRT chat demo's "Compiling Model…" status marks).
        emitLifecycle(merged, 'litert_lm', modelLabel, 'compiling', {
          detail: 'compiling model + WebGPU shaders',
        })
        const engine = await createEngine({
          engineSettings,
          onInitProgress: merged.onInitProgress,
        })
        this.#engine = engine
        emitLifecycle(merged, 'litert_lm', modelLabel, 'ready', {
          detail: 'engine ready',
          // Surface the WebGPU budget (LiteRT-LM is WebGPU-only) so the consumer can relate its context
          // window to the device's per-allocation ceiling — observability, never an imposed cap.
          gpuBudget: await probeGpuBudget(),
        })
        return engine
      } catch (err) {
        this.#enginePromise = undefined
        emitLifecycle(merged, 'litert_lm', modelLabel, 'error', { error: err })
        throw err
      }
    })()
    return this.#enginePromise
  }

  /**
   * Resolve the PORTABLE generation contract (shared with transformers.js) from the merged options.
   * Canonical fields win; the LiteRT-native fields ({@link LiteRtLmAdapterOptions.samplerParams},
   * `maxOutputTokens`, `visionModalityEnabled`/`audioModalityEnabled`) are the fallback layer consulted
   * only when the canonical one is unset.
   */
  #gen(merged: LiteRtLmAdapterOptions): ResolvedGenerationOptions {
    const sp = merged.samplerParams
    // Native samplerParams.type (1=TOP_K, 2=TOP_P, 3=GREEDY) → canonical sampler strategy.
    const nativeSampler: ChatSampler | undefined =
      sp?.type === 1 ? 'top-k' : sp?.type === 2 ? 'top-p' : sp?.type === 3 ? 'greedy' : undefined
    return resolveGenerationOptions(
      {
        maxTokens: merged.maxTokens,
        sampler: merged.sampler,
        temperature: merged.temperature,
        topK: merged.topK,
        topP: merged.topP,
        seed: merged.seed,
        enableThinking: merged.enableThinking,
        multimodal: merged.multimodal,
      },
      {
        maxTokens: merged.maxOutputTokens,
        sampler: nativeSampler,
        temperature: sp?.temperature,
        topK: sp?.k,
        topP: sp?.p,
        seed: sp?.seed,
        multimodal: {
          image: merged.visionModalityEnabled,
          audio: merged.audioModalityEnabled,
        },
      }
    )
  }

  /** Map the resolved canonical sampler → LiteRT `samplerParams` (`type` enum + k/p/temperature). */
  #samplerParams(gen: ResolvedGenerationOptions): LiteRtSamplerParametersOption {
    // SamplerType: 1=TOP_K, 2=TOP_P, 3=GREEDY. CRITICAL LiteRT-web invariant: on the WebGPU sampling
    // path the runtime IGNORES `type` (it always combines top-k + top-p) and the WebGPU TopK sampler
    // REQUIRES `k <= 1` — passing the canonical default (topK 40) or any k>1 throws
    // `Top-K value N must be <= 1` at generate time (grounded in runtime/proto/sampler_params.proto:
    // "type … Ignored on the GPU path"). This battery is WebGPU-only, so we clamp k to 1 for EVERY
    // sampler type and let `p`/`temperature` drive diversity. (The validator additionally REJECTS an
    // explicit topK>1 so a caller learns the constraint rather than being silently clamped.)
    const k = Math.min(gen.topK, 1)
    if (gen.sampler === 'top-k') {
      return {
        type: 1,
        k,
        p: gen.topP,
        temperature: gen.temperature,
        ...(gen.seed !== undefined ? { seed: gen.seed } : {}),
      }
    }
    if (gen.sampler === 'top-p') {
      return {
        type: 2,
        k,
        p: gen.topP,
        temperature: gen.temperature,
        ...(gen.seed !== undefined ? { seed: gen.seed } : {}),
      }
    }
    return {
      type: 3,
      k: 1,
      p: gen.topP,
      temperature: gen.temperature,
      ...(gen.seed !== undefined ? { seed: gen.seed } : {}),
    }
  }

  /** Build the per-dispatch session config from the resolved portable generation contract. */
  #sessionConfig(merged: LiteRtLmAdapterOptions): LiteRtSessionConfig | undefined {
    const gen = this.#gen(merged)
    const cfg: LiteRtSessionConfig = {
      samplerParams: this.#samplerParams(gen) as never,
      maxOutputTokens: gen.maxTokens,
    }
    if (gen.multimodal.audio) cfg.audioModalityEnabled = true
    if (gen.multimodal.image) cfg.visionModalityEnabled = true
    return cfg
  }

  /**
   * Produce the bound {@link DispatchExecutorFn} the `DispatchRunner` invokes.
   *
   * @param overrides - Option overrides layered above the constructor baseline (below `ctx.stash`).
   */
  executor(overrides?: Partial<LiteRtLmAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = LiteRtLmAdapter
    const self = this
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      // 1. Three-layer merge + re-validate.
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object'
          ? (stashRaw as Partial<LiteRtLmAdapterOptions>)
          : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))
      const h = resolveHelpers(merged.helpers)
      const selfIdentity = merged.selfIdentity ?? 'assistant'
      const unsupportedMediaPolicy = merged.unsupportedMediaPolicy ?? 'throw'
      const toolCallParser = resolveToolCallParser(merged.toolCallParser)
      const reasoningParser = resolveReasoningParser(merged.reasoningParser, undefined, {
        orphanRecovery: merged.reasoningOrphanRecovery,
      })

      // 2. Artifact-reader tools are forged by the DispatchRunner CORE into `ctx.tools` before the input
      //    pipeline runs (generation is a generic core concern; this battery owns only representation).
      //    Read the pre-forged `ctx.tools` directly — no local merge, no bindContext here.

      // 3. Pre-render persisted tool-call results into LiteRT tool_response content items.
      const renderedToolCallResults = new Map<string, LiteRtMessageContentItem>()
      for (const tc of ctx.turnToolCalls) {
        const tool = ctx.tools.get(tc.tool)
        const item = await h.renderLiteRtToolResult({
          toolCall: tc,
          results: tc.results,
          tool: tool as Tool | ArtifactTool | undefined,
          unsupportedMediaPolicy,
          renderUntrustedContent: h.renderUntrustedContent,
          renderTrustedContent: h.renderTrustedContent,
          renderArtifactHandleBody: h.renderArtifactHandleBody,
          warn: (m) => helpers.log.warn({ kind: 'litert-render-warning', message: m }),
        })
        renderedToolCallResults.set(tc.id, item)
      }

      // 4. Optional context-window enforcement.
      if (merged.tokenEncoding && merged.contextWindow !== undefined) {
        const enc = merged.tokenEncoding
        const tally = (s: string): number => new Tokenizable(s).estimateTokens(enc)
        // For Tokenizable-backed fields, measure the Tokenizable ITSELF with the live `ctx` (not a temp
        // built from its coerced string): a DYNAMIC value resolves against ctx, so `estimateTokens(enc,
        // ctx)` counts EXACTLY the string that `render(ctx)` will assemble below — keeping this guard's
        // total honest for evaluatable content. A static value counts identically to before.
        const tallyTok = (t: Tokenizable): number => t.estimateTokens(enc, ctx)
        // Per-bucket accounting so the overflow exception carries a real breakdown (its `perBucket` arg,
        // documented for middleware shed-targeting) instead of a single lumped number. A subtractive pass
        // must measure each bucket the SAME way this guard does; a per-bucket split is what lets a
        // pass↔guard disagreement be pinned to the exact bucket rather than inferred.
        const b = {
          system: 0,
          standingInstructions: 0,
          memories: 0,
          retrievables: 0,
          messages: 0,
          thoughts: 0,
          toolResults: 0,
          tools: 0,
        }
        b.system = tallyTok(ctx.systemPrompt as Tokenizable)
        for (const si of ctx.standingInstructions)
          b.standingInstructions += tallyTok(si as Tokenizable)
        for (const m of ctx.turnMemories) b.memories += tallyTok(m.content as Tokenizable)
        for (const r of ctx.turnRetrievables)
          b.retrievables += tally((await r.contentString?.()) ?? '')
        for (const m of ctx.turnMessages)
          b.messages += m.content ? tallyTok(m.content as Tokenizable) : 0
        for (const t of ctx.turnThoughts) b.thoughts += tallyTok(t.content as Tokenizable)
        for (const item of renderedToolCallResults.values()) {
          const tr = (item as { tool_response?: { response?: { content?: string } } }).tool_response
          b.toolResults += tally(tr?.response?.content ?? '')
        }
        let total =
          b.system +
          b.standingInstructions +
          b.memories +
          b.retrievables +
          b.messages +
          b.thoughts +
          b.toolResults
        // The TOOL DECLARATIONS are part of the dispatched prompt too — and for the default
        // `toolDelivery:'prompt'` path they are the FULL JSON-Schema block rendered by
        // `renderToolsAsPromptText`, often the single largest bucket (hundreds of tokens for a handful of
        // tools). Omitting them made this guard undercount by exactly that block and let a tool-heavy
        // prompt sail past the check and blow the engine's hard cap. Tally the EXACT string that
        // buildLiteRtConversationInput renders into the system message (same visible()/toolDelivery/
        // renderer), so the guard sees what the model sees. (Native delivery sends `preface.tools`; its
        // weight is model/runtime-dependent — the on-device Gemma path is prompt-delivery, so that is the
        // case that matters here.)
        const toolDelivery = merged.toolDelivery ?? 'prompt'
        if (toolDelivery === 'prompt') {
          const visibleTools = ctx.tools.visible()
          if (visibleTools.length > 0) b.tools = tally(h.renderToolsAsPromptText(visibleTools))
        }
        total += b.tools
        if (total > merged.contextWindow) {
          throw new E_LITERT_LM_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            String(enc),
            `system=${b.system} standingInstructions=${b.standingInstructions} memories=${b.memories} retrievables=${b.retrievables} messages=${b.messages} thoughts=${b.thoughts} toolResults=${b.toolResults} tools=${b.tools}`,
          ])
        }
      }

      // 5. Build LiteRT conversation input (preface + per-turn messages).
      // Resolve the portable generation contract once so thinking + modality flags are consistent with
      // what #sessionConfig sends to the runtime (canonical-wins over the native flags).
      const gen = self.#gen(merged)
      // A short, user-facing note carried on a GPU-OOM error so the application can show WHY it failed
      // and what to change. We surface the budget/window relationship, never silently cap it.
      const oomNote =
        merged.contextWindow !== undefined
          ? `The configured context window (${merged.contextWindow} tokens, max ${gen.maxTokens} output) exceeded the available GPU memory. Reduce the context window or max output tokens and retry, recycle the adapter to free the WebGPU buffer cache, or switch to a smaller model.`
          : `The request exceeded the available GPU memory. Reduce the context window or max output tokens and retry, recycle the adapter to free the WebGPU buffer cache, or switch to a smaller model.`
      const { preface, messages: turnMessages } = await h.buildLiteRtConversationInput({
        systemPrompt: ctx.systemPrompt,
        standingInstructions: ctx.standingInstructions,
        memories: ctx.turnMemories,
        retrievables: ctx.turnRetrievables,
        messages: ctx.turnMessages,
        thoughts: ctx.turnThoughts,
        toolCalls: ctx.turnToolCalls,
        tools: ctx.tools,
        // The live dispatch context, threaded so DYNAMIC (evaluatable) Tokenizables resolve against it at
        // assembly (`.render(ctx)`), matching what the overflow guard above counted with the same ctx.
        // Static Tokenizables ignore it — no behavioral change for the common case.
        renderCtx: ctx,
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
        toolDelivery: merged.toolDelivery,
        enableThinking: gen.enableThinking,
        toolsToLiteRtTools: h.toolsToLiteRtTools,
        renderToolsAsPromptText: h.renderToolsAsPromptText,
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
        // Multimodal (opt-in): thread the two modality flags + policy + the media renderer so user
        // messages with attachments map to LiteRT content items. NO EngineSettings change — only the
        // existing SessionConfig flags gate it. GATED ON A REAL-MODEL PROOF (browser matrix).
        visionModalityEnabled: gen.multimodal.image,
        audioModalityEnabled: gen.multimodal.audio,
        unsupportedMediaPolicy,
        renderMediaToLiteRtContent,
        warn: (m) => helpers.log.warn({ kind: 'litert-history-warning', message: m }),
      })

      // 6. Resolve engine + create the conversation.
      const sessionConfig = self.#sessionConfig(merged)
      const conversationConfig: LiteRtConversationConfig = {
        preface,
        ...(sessionConfig ? { sessionConfig } : {}),
        ...(merged.enableConstrainedDecoding !== undefined
          ? { enableConstrainedDecoding: merged.enableConstrainedDecoding }
          : {}),
        ...(merged.filterChannelContentFromKvCache !== undefined
          ? {
              filterChannelContentFromKvCache: merged.filterChannelContentFromKvCache,
            }
          : {}),
      }

      let conversation: LiteRtLmConversation
      try {
        const engine = await self.#resolveEngine(merged)
        conversation = await engine.createConversation(conversationConfig as never)
      } catch (err) {
        ctx.nack(toLiteRtGenerationError(err, oomNote))
        return
      }

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      const stream = merged.stream ?? true

      // One id for this whole generation — correlates the TO tap (onPromptAssembled) with the FROM tap
      // (onRawGeneration) and the reported message. Minted here so both the streaming and non-streaming
      // paths below reuse it instead of generating their own.
      const dispatchStreamId = uuidv6()

      // Prompt-assembled observability tap: surface the EXACT prompt bytes going TO the model, the instant
      // assembly finished (above) and before the engine dispatch (below). Mirror of onRawGeneration.
      // Handed back AS-IS — no redaction — and swallow callback errors so a misbehaving observer can never
      // corrupt the generation path.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'litert_lm',
            kind: 'rendered-prompt',
            // The assembled preface object verbatim — carries the system message text (prompt-delivery
            // folds the tool block in here) and, for native delivery, the tool list on `preface.tools`.
            preface,
            messages: turnMessages,
            tools: (preface as { tools?: unknown })?.tools,
            streamed: stream,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      // Wire abort → conversation.cancel().
      const onAbort = (): void => {
        try {
          conversation.cancel()
        } catch {
          /* cancel is best-effort */
        }
      }
      if (ctx.abortSignal.aborted) {
        onAbort()
        return
      }
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

      // ── Tool execution + persistence (args already an object — no JSON.parse) ──
      const executeAndPersistToolCall = async (call: AssembledLiteRtToolCall): Promise<void> => {
        const tool = ctx.tools.get(call.name)
        const completedAt = nowIso()

        if (!call.argsWellFormed) {
          const toolName = normalizeToolName(call.name)
          const err = new E_LITERT_LM_INVALID_TOOL_CALL_ARGS([
            'must be a JSON object',
            JSON.stringify(call.args),
          ])
          const results = new Tokenizable(err.message)
          helpers.reportToolCall(call.id, { tool: toolName, args: {} })
          helpers.reportToolCall(call.id, {
            results,
            isError: true,
            isComplete: true,
          })
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: toolName,
              args: {},
              checksum: computeChecksum(toolName, {}),
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
          const toolName = normalizeToolName(call.name)
          const available = ctx.tools
            .all()
            .map((t) => t.name)
            .sort()
          const errText =
            available.length > 0
              ? `Tool not found: ${toolName}. Available tools: ${available.join(', ')}.`
              : `Tool not found: ${toolName}. No tools are available this turn.`
          const results = new Tokenizable(errText)
          helpers.reportToolCall(call.id, { tool: toolName, args: call.args })
          helpers.reportToolCall(call.id, {
            results,
            isError: true,
            isComplete: true,
          })
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: toolName,
              args: call.args,
              checksum: computeChecksum(toolName, call.args),
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
          } else if (looksLikeSpooledArtifact(raw)) {
            results = raw as SpooledArtifact
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
        helpers.reportToolCall(call.id, {
          results,
          isError: toolHadError,
          isComplete: true,
        })
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
            // ArtifactTool results are the documented exception: they inline the slice the model queried
            // from a prior artifact (handing back a handle to a query result would be recursion). Every
            // other result keeps the secure default (inline:false → handle).
            inline: isArtifactTool,
            createdAt: completedAt2,
            updatedAt: completedAt2,
            completedAt: completedAt2,
          })
        )
      }

      const assembleCalls = (raw: ReadonlyArray<ParsedToolCall>): AssembledLiteRtToolCall[] =>
        raw.map((c) => ({
          id: uuidv6(),
          name: c.name,
          args: isObject(c.arguments) ? (c.arguments as Record<string, unknown>) : {},
          argsWellFormed: isObject(c.arguments),
        }))

      // Parse the full generated text → reasoning + clean prose + tool calls, then persist.
      // LiteRT-LM (v0.13.1) is text-only: tool calls + reasoning arrive as text in `content`, in the
      // model family's format, parsed here via the shared parser layer.
      const toolNames = ctx.tools.visible().map((t) => t.name)
      // Run the optional media-output extractor over the raw LiteRT generation result, persisting each
      // generated media via `ctx.storeMediaBytes` and building first-party `Media`. Returns [] when no hook
      // is configured (today's text-only output, unchanged).
      const collectGeneratedMedia = async (raw: unknown): Promise<Media[]> => {
        if (!merged.extractMediaOutputs || raw === undefined) return []
        const outputs = await merged.extractMediaOutputs(raw)
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

      const finishFromText = async (
        rawText: string,
        streamId: string,
        streamedProse: boolean,
        generatedMedia: Media[] = []
      ): Promise<void> => {
        // Strip non-semantic envelope/turn-boundary special tokens (Llama/ChatML wrappers) before
        // parsing — the streamed text can retain them, and they'd make the JSON parsers decline a valid
        // call. Excludes every token the parsers key on. Idempotent when none are present.
        const fullText = stripEnvelopeSpecialTokens(rawText)
        const reasoned = reasoningParser(fullText)
        const parsed = toolCallParser(reasoned.cleanedText, { toolNames })
        const cleanText = parsed.cleanedText

        // Raw-generation observability tap: surface what the model emitted vs. what parsed, before any
        // persistence. Purely observational — swallow callback errors so a misbehaving observer can
        // never corrupt the generation path.
        if (merged.onRawGeneration) {
          try {
            merged.onRawGeneration({
              rawText: fullText,
              cleanedText: cleanText,
              reasoning: reasoned.reasoning,
              toolCalls: parsed.calls,
              streamed: streamedProse,
              streamId,
            })
          } catch {
            /* observer errors are non-fatal */
          }
        }

        // Drop empty/whitespace traces — a model's no-think artifact carries no information.
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

        // Persist the assistant message when there is clean prose OR generated media. A media-only turn
        // (empty text + attachment) is legitimate; a turn with neither stores nothing (unchanged).
        if (cleanText.length > 0 || generatedMedia.length > 0) {
          if (streamedProse) helpers.reportMessage(streamId, '', { isComplete: true })
          else if (cleanText.length > 0)
            helpers.reportMessage(streamId, cleanText, { isComplete: true })
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

      const lifecycleModel = litertModelLabel(merged.model)
      emitLifecycle(merged, 'litert_lm', lifecycleModel, 'generating')

      // ── Streaming path ──
      if (stream) {
        const accumulator = h.createLiteRtStreamAccumulator()
        const streamId = dispatchStreamId
        let proseStopped = false
        let streamedProse = false

        let readable: ReadableStream<LiteRtMessage>
        try {
          readable = conversation.sendMessageStreaming(
            turnMessages as never
          ) as ReadableStream<LiteRtMessage>
        } catch (err) {
          emitLifecycle(merged, 'litert_lm', lifecycleModel, 'error', {
            error: err,
          })
          ctx.nack(toLiteRtGenerationError(err, oomNote))
          return
        }

        let lastChunk: LiteRtMessage | undefined
        try {
          const reader = readable.getReader()
          while (true) {
            if (ctx.abortSignal.aborted) {
              await reader.cancel().catch(() => undefined)
              return
            }
            const { value: chunk, done } = await reader.read()
            if (done) break
            if (!chunk) continue
            lastChunk = chunk
            const { contentDelta } = accumulator.feed(chunk)
            if (contentDelta.length > 0 && !proseStopped) {
              // Once the buffered output shows any tool-call/reasoning marker, stop streaming prose;
              // the authoritative clean message is persisted after the stream drains.
              if (TEXT_MARKUP_MARKERS.some((m) => accumulator.content().includes(m))) {
                proseStopped = true
              } else {
                streamedProse = true
                helpers.reportMessage(streamId, contentDelta)
              }
            }
          }
        } catch (err) {
          if (ctx.abortSignal.aborted) return
          emitLifecycle(merged, 'litert_lm', lifecycleModel, 'error', {
            error: err,
          })
          ctx.nack(toLiteRtGenerationError(err, oomNote))
          return
        }

        const streamMedia = await collectGeneratedMedia(lastChunk)
        await finishFromText(accumulator.content(), streamId, streamedProse, streamMedia)
        emitLifecycle(merged, 'litert_lm', lifecycleModel, 'complete')
        return
      }

      // ── Non-streaming path ──
      let final: LiteRtMessage
      try {
        final = (await conversation.sendMessage(turnMessages as never)) as LiteRtMessage
      } catch (err) {
        emitLifecycle(merged, 'litert_lm', lifecycleModel, 'error', {
          error: err,
        })
        ctx.nack(toLiteRtGenerationError(err, oomNote))
        return
      }
      const contentText =
        typeof final.content === 'string'
          ? final.content
          : Array.isArray(final.content)
            ? final.content
                .filter((i) => i.type === 'text' && typeof i.text === 'string')
                .map((i) => i.text)
                .join('')
            : ''
      const nonStreamMedia = await collectGeneratedMedia(final)
      await finishFromText(contentText, dispatchStreamId, false, nonStreamMedia)
      emitLifecycle(merged, 'litert_lm', lifecycleModel, 'complete')
    }
  }
}
