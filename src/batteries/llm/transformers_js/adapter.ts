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
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
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
  defaultCreateTransformersJsStreamAccumulator,
} from './helpers'
import type { Tool } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { ParsedToolCall } from '../chat_common/tool_parsers'
import type { TransformersJsAdapterOptions, TransformersJsPipeline } from './types'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

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

  /** Drop the cached pipeline and any in-flight load so the next dispatch re-resolves it. */
  reset(): void {
    this.#pipeline = undefined
    this.#pipelinePromise = undefined
  }

  async #resolvePipeline(merged: TransformersJsAdapterOptions): Promise<TransformersJsPipeline> {
    if (merged.pipeline) {
      this.#pipeline = merged.pipeline
      return merged.pipeline
    }
    if (this.#pipeline) return this.#pipeline
    this.#pipelinePromise ??= (async () => {
      try {
        const createPipeline =
          merged.createPipeline ??
          (async ({ model, device, dtype, onInitProgress }) => {
            const { pipeline } = await import('@huggingface/transformers')
            return (await pipeline('text-generation', model, {
              ...(device ? { device } : {}),
              ...(dtype ? { dtype } : {}),
              ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
            } as never)) as unknown as TransformersJsPipeline
          })
        const pipe = await createPipeline({
          model: merged.model,
          device: merged.device,
          dtype: merged.dtype,
          onInitProgress: merged.onInitProgress,
        })
        this.#pipeline = pipe
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
        throw new E_TRANSFORMERS_JS_STREAM_ERROR([
          `could not load the transformers.js pipeline: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#pipelinePromise
  }

  /** Build the transformers.js `generate` kwargs from the merged options (excluding tools/streamer). */
  #generateKwargs(merged: TransformersJsAdapterOptions): Record<string, unknown> {
    const kw: Record<string, unknown> = {}
    if (merged.maxNewTokens !== undefined) kw.max_new_tokens = merged.maxNewTokens
    if (merged.doSample !== undefined) kw.do_sample = merged.doSample
    if (merged.temperature !== undefined) kw.temperature = merged.temperature
    if (merged.topK !== undefined) kw.top_k = merged.topK
    if (merged.topP !== undefined) kw.top_p = merged.topP
    if (merged.repetitionPenalty !== undefined) kw.repetition_penalty = merged.repetitionPenalty
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
      const reasoningParser = resolveReasoningParser(merged.reasoningParser)

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

      // 5. Build the transformers.js message array + tools.
      const { messages: turnMessages, tools: toolDefs } = await h.buildTransformersJsMessages({
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
        warn: (m) => helpers.log.warn({ kind: 'transformers-history-warning', message: m }),
      })

      // 6. Resolve the pipeline.
      let pipe: TransformersJsPipeline
      try {
        pipe = await self.#resolvePipeline(merged)
      } catch (err) {
        ctx.nack(
          isInstanceOf(err, 'E_TRANSFORMERS_JS_STREAM_ERROR', E_TRANSFORMERS_JS_STREAM_ERROR)
            ? err
            : new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)])
        )
        return
      }

      if (ctx.abortSignal.aborted) return

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      const stream = merged.stream ?? true
      const generateKwargs = self.#generateKwargs(merged)
      const toolNames = mergedRegistry.visible().map((t) => t.name)

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
        fullText: string,
        streamId: string,
        streamedProse: boolean
      ): Promise<void> => {
        const reasoned = reasoningParser(fullText)
        const afterReasoning = reasoned.cleanedText
        const parsed = toolCallParser(afterReasoning, { toolNames })
        const cleanText = parsed.cleanedText

        // Persist reasoning as Thoughts.
        for (const trace of reasoned.reasoning) {
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

        // Persist the clean assistant message (if any).
        if (cleanText.length > 0) {
          if (streamedProse) {
            helpers.reportMessage(streamId, '', { isComplete: true })
          } else {
            helpers.reportMessage(streamId, cleanText, { isComplete: true })
          }
          await ctx.storeMessage(
            new Message({
              id: streamId,
              role: 'assistant',
              content: cleanText,
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
        const createStreamer =
          merged.createStreamer ??
          (async ({ pipeline: p, onText: cb }) => {
            const { TextStreamer } = await import('@huggingface/transformers')
            const tokenizer = (p as unknown as { tokenizer: unknown }).tokenizer
            return new TextStreamer(
              tokenizer as never,
              {
                skip_prompt: true,
                skip_special_tokens: false,
                callback_function: cb,
              } as never
            )
          })

        let streamer: unknown
        try {
          streamer = await createStreamer({ pipeline: pipe, onText })
        } catch (err) {
          ctx.nack(new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }

        try {
          await (pipe as unknown as (m: unknown, k: unknown) => Promise<unknown>)(turnMessages, {
            ...generateKwargs,
            ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
            streamer,
          })
        } catch (err) {
          if (ctx.abortSignal.aborted) return
          ctx.nack(new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }
        if (ctx.abortSignal.aborted) return
        await finishFromText(accumulator.content(), streamId, streamedProse)
        return
      }

      // ── Non-streaming path ──
      let output: unknown
      try {
        output = await (pipe as unknown as (m: unknown, k: unknown) => Promise<unknown>)(
          turnMessages,
          {
            ...generateKwargs,
            ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
          }
        )
      } catch (err) {
        ctx.nack(new E_TRANSFORMERS_JS_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }
      if (ctx.abortSignal.aborted) return
      await finishFromText(extractGeneratedText(output), uuidv6(), false)
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
