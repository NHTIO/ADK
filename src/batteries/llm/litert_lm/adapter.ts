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
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
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
  defaultRenderLiteRtToolResult,
  defaultBuildLiteRtConversationInput,
  defaultCreateLiteRtStreamAccumulator,
} from './helpers'
import type { Tool } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
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
} from './types'

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
  renderLiteRtToolResult: typeof defaultRenderLiteRtToolResult
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
    renderLiteRtToolResult:
      (src.renderLiteRtToolResult as ResolvedHelpers['renderLiteRtToolResult']) ??
      defaultRenderLiteRtToolResult,
    buildLiteRtConversationInput:
      (src.buildLiteRtConversationInput as ResolvedHelpers['buildLiteRtConversationInput']) ??
      defaultBuildLiteRtConversationInput,
    createLiteRtStreamAccumulator:
      (src.createLiteRtStreamAccumulator as ResolvedHelpers['createLiteRtStreamAccumulator']) ??
      defaultCreateLiteRtStreamAccumulator,
  }
}

const nowIso = (): string => DateTime.now().toISO() as string

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
    this.#enginePromise ??= (async () => {
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
      const engine = await createEngine({
        engineSettings,
        onInitProgress: merged.onInitProgress,
      })
      this.#engine = engine
      return engine
    })()
    return this.#enginePromise
  }

  /** Build the per-dispatch session config from the merged options. */
  #sessionConfig(merged: LiteRtLmAdapterOptions): LiteRtSessionConfig | undefined {
    const cfg: LiteRtSessionConfig = {}
    if (merged.samplerParams !== undefined) cfg.samplerParams = merged.samplerParams as never
    if (merged.maxOutputTokens !== undefined) cfg.maxOutputTokens = merged.maxOutputTokens
    if (merged.audioModalityEnabled !== undefined)
      cfg.audioModalityEnabled = merged.audioModalityEnabled
    if (merged.visionModalityEnabled !== undefined)
      cfg.visionModalityEnabled = merged.visionModalityEnabled
    return Object.keys(cfg).length > 0 ? cfg : undefined
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

      // 3. Pre-render persisted tool-call results into LiteRT tool_response content items.
      const renderedToolCallResults = new Map<string, LiteRtMessageContentItem>()
      for (const tc of ctx.turnToolCalls) {
        const tool = mergedRegistry.get(tc.tool)
        const item = await h.renderLiteRtToolResult({
          toolCall: tc,
          results: tc.results,
          tool: tool as Tool | ArtifactTool | undefined,
          unsupportedMediaPolicy,
          renderUntrustedContent: h.renderUntrustedContent,
          renderTrustedContent: h.renderTrustedContent,
          warn: (m) => helpers.log.warn({ kind: 'litert-render-warning', message: m }),
        })
        renderedToolCallResults.set(tc.id, item)
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
        for (const item of renderedToolCallResults.values()) {
          const tr = (item as { tool_response?: { response?: { content?: string } } }).tool_response
          total += tally(tr?.response?.content ?? '')
        }
        if (total > merged.contextWindow) {
          throw new E_LITERT_LM_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            String(enc),
            `system+buckets+timeline=${total}`,
          ])
        }
      }

      // 5. Build LiteRT conversation input (preface + per-turn messages).
      const { preface, messages: turnMessages } = await h.buildLiteRtConversationInput({
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
        toolsToLiteRtTools: h.toolsToLiteRtTools,
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
          ? { filterChannelContentFromKvCache: merged.filterChannelContentFromKvCache }
          : {}),
      }

      let conversation: LiteRtLmConversation
      try {
        const engine = await self.#resolveEngine(merged)
        conversation = await engine.createConversation(conversationConfig as never)
      } catch (err) {
        ctx.nack(new E_LITERT_LM_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      const stream = merged.stream ?? true

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
        const tool = mergedRegistry.get(call.name)
        const completedAt = nowIso()

        if (!call.argsWellFormed) {
          const err = new E_LITERT_LM_INVALID_TOOL_CALL_ARGS([
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

      const assembleCalls = (
        raw: ReadonlyArray<{ name: string; arguments: Record<string, unknown> }>
      ): AssembledLiteRtToolCall[] =>
        raw.map((c) => ({
          id: uuidv6(),
          name: c.name,
          args: isObject(c.arguments) ? (c.arguments as Record<string, unknown>) : {},
          argsWellFormed: isObject(c.arguments),
        }))

      // ── Streaming path ──
      if (stream) {
        const accumulator = h.createLiteRtStreamAccumulator()
        const streamId = uuidv6()
        let sawMessage = false
        const channelStreamIds = new Map<string, string>()

        let readable: ReadableStream<LiteRtMessage>
        try {
          readable = conversation.sendMessageStreaming(
            turnMessages as never
          ) as ReadableStream<LiteRtMessage>
        } catch (err) {
          ctx.nack(new E_LITERT_LM_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }

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
            const { contentDelta, channelDeltas } = accumulator.feed(chunk)
            if (contentDelta.length > 0) {
              sawMessage = true
              helpers.reportMessage(streamId, contentDelta)
            }
            for (const { channel, delta } of channelDeltas) {
              if (!channelStreamIds.has(channel)) channelStreamIds.set(channel, uuidv6())
              helpers.reportThought(channelStreamIds.get(channel)!, delta)
            }
          }
        } catch (err) {
          if (ctx.abortSignal.aborted) return
          ctx.nack(new E_LITERT_LM_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }

        // Drain + persist.
        if (sawMessage) {
          helpers.reportMessage(streamId, '', { isComplete: true })
          await ctx.storeMessage(
            new Message({
              id: streamId,
              role: 'assistant',
              content: accumulator.content(),
              identity: selfIdentity,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            })
          )
        }
        for (const [channel, text] of Object.entries(accumulator.channels())) {
          const id = channelStreamIds.get(channel) ?? uuidv6()
          helpers.reportThought(id, '', { isComplete: true })
          await ctx.storeThought(
            new Thought({
              id,
              content: text,
              identity: selfIdentity,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            })
          )
        }
        const calls = assembleCalls(accumulator.toolCalls())
        if (calls.length === 0) {
          if (merged.autoAck) ctx.ack()
          return
        }
        for (const call of calls) {
          if (ctx.abortSignal.aborted) return
          await executeAndPersistToolCall(call)
        }
        return
      }

      // ── Non-streaming path ──
      let final: LiteRtMessage
      try {
        final = (await conversation.sendMessage(turnMessages as never)) as LiteRtMessage
      } catch (err) {
        ctx.nack(new E_LITERT_LM_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }
      const responseId = uuidv6()
      const contentText =
        typeof final.content === 'string'
          ? final.content
          : Array.isArray(final.content)
            ? final.content
                .filter((i) => i.type === 'text' && typeof i.text === 'string')
                .map((i) => i.text)
                .join('')
            : ''
      if (contentText.length > 0) {
        const messageId = `${responseId}:message`
        helpers.reportMessage(messageId, contentText, { isComplete: true })
        await ctx.storeMessage(
          new Message({
            id: messageId,
            role: 'assistant',
            content: contentText,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }
      if (final.channels && typeof final.channels === 'object') {
        for (const [channel, text] of Object.entries(final.channels)) {
          if (typeof text !== 'string' || text.length === 0) continue
          const thoughtId = `${responseId}:thought:${channel}`
          helpers.reportThought(thoughtId, text, { isComplete: true })
          await ctx.storeThought(
            new Thought({
              id: thoughtId,
              content: text,
              identity: selfIdentity,
              createdAt: nowIso(),
              updatedAt: nowIso(),
            })
          )
        }
      }
      const rawCalls = Array.isArray(final.tool_calls)
        ? final.tool_calls.map((tc) => ({
            name: tc.function?.name ?? '',
            arguments: (tc.function?.arguments ?? {}) as Record<string, unknown>,
          }))
        : []
      const calls = assembleCalls(rawCalls)
      if (calls.length === 0) {
        if (merged.autoAck) ctx.ack()
        return
      }
      for (const call of calls) {
        if (ctx.abortSignal.aborted) return
        await executeAndPersistToolCall(call)
      }
    }
  }
}
