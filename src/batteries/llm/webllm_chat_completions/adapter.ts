/**
 * Cross-environment executor adapter for WebLLM Chat Completions compatible endpoints.
 *
 * @module @nhtio/adk/batteries/llm/webllm_chat_completions/adapter
 *
 * @remarks
 * Cross-environment LLM adapter for the WebLLM Chat Completions wire shape. Chat Completions was
 * chosen as the ADK's reference adapter because it is the de-facto interchange format for the
 * majority of OpenAI-compatible gateways (vLLM, Together, Groq, Fireworks, Ollama, Azure OpenAI,
 * OpenRouter, DeepSeek, Mistral La Plateforme, and most self-hosted deployments). Its tool-call
 * synthetic-history shape (`role: 'assistant', tool_calls: [...]` followed by `role: 'tool'` with
 * `tool_call_id`) is the lowest-common-denominator that every conformant gateway accepts.
 *
 * The adapter is built around three pluggable layers:
 *
 * 1. **Translation helpers** — the thirteen swappable functions exported from `./helpers` turn
 *    ADK primitives ({@link @nhtio/adk!Tokenizable}, {@link @nhtio/adk!Memory}, {@link @nhtio/adk!Message}, {@link @nhtio/adk!Thought},
 *    {@link @nhtio/adk!ToolCall}, {@link @nhtio/adk!Tool}, {@link @nhtio/adk!ArtifactTool}, {@link @nhtio/adk!SpooledArtifact}) into Chat
 *    Completions wire shapes. Consumers override individual helpers via `options.helpers.*` to
 *    customise envelope formats, bucket ordering, thought surfacing, or JSON Schema generation
 *    without forking the adapter.
 * 2. **Three-layer options merging** — constructor baseline, per-`executor()` overrides, and
 *    per-iteration `ctx.stash.webLLMChatCompletions` overrides combine with key-by-key
 *    precedence for `helpers` and wholesale replacement for everything else.
 *    The merged shape is re-validated on every iteration so a malformed stash override
 *    fails loud, not silently.
 * 3. **WebLLM engine invocation** — accepts a preloaded `engine` or lazy `createEngine` factory.
 *    The resolved request body is passed directly to WebLLM's OpenAI-compatible chat API.
 *
 * Per-iteration flow (steps 1–9 of the plan):
 * 1. Merge constructor / executor / stash options and re-validate.
 * 2. Resolve helpers, falling back to bundled `default*` for each unset field.
 * 3. Forge artifact-query tools by walking `ctx.turnToolCalls`, collecting unique
 *    `SpooledArtifact` constructors, calling `<Ctor>.forgeTools(ctx)` on each, and merging the
 *    results with `ctx.tools`.
 * 4. Pre-render every persisted tool-call result into the prompt-ready string the timeline will
 *    use, cached by `tc.id`.
 * 5. When `tokenEncoding !== null`, sum the token weight of every persisted bucket and throw
 *    {@link @nhtio/adk/batteries!E_WEBLLM_CHAT_COMPLETIONS_CONTEXT_OVERFLOW} when the total exceeds `contextWindow`.
 * 6. Build the request body via `buildChatCompletionsHistory`; carry vendor-opaque reasoning
 *    blocks through the `_adk_reasoning_payloads` side-channel.
 * 7. Resolve or lazily create a WebLLM engine and call `engine.chat.completions.create(body)`.
 * 8. Streaming path: consume WebLLM's async chunk iterable; surface deltas through
 *    `helpers.reportMessage` / `reportThought` / `reportToolCall`; assemble tool-call deltas via
 *    the accumulator; persist `Message` / `Thought` / `ToolCall` records on stream end.
 * 9. Non-streaming path: consume the returned Chat Completion object; same persistence +
 *    tool-execution loop.
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
  E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS,
  E_WEBLLM_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
  E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR,
  E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS,
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
  defaultRenderTimelineMessage,
  defaultRenderThought,
  defaultFilterThoughts,
  defaultToolsToChatCompletionsTools,
  defaultRenderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsToolCallResult,
  defaultBuildChatCompletionsHistory,
  defaultCreateChatCompletionsToolCallDeltaAccumulator,
} from './helpers'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Tool, Memory, TokenEncoding } from '@nhtio/adk/common'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type {
  WebLLMChatCompletionsAdapterOptions,
  ChatCompletionsHelpers,
  WebLLMChatCompletionsRequestBody,
  ChatCompletionsChunk,
  ChatCompletionsResponse,
  AssembledToolCall,
  ChatCompletionsContentBlock,
  WebLLMEngine,
} from './types'

// ─── ADK-control keys (stripped before sending the request body) ──────────

const ADK_CONTROL_KEYS: ReadonlySet<string> = new Set([
  'engine',
  'createEngine',
  'engineConfig',
  'chatOptions',
  'stream',
  'bucketOrder',
  'contextWindow',
  'selfIdentity',
  'thoughtSurfacing',
  'tokenEncoding',
  'replayCompatibility',
  'helpers',
  'strictToolChoice',
  'unsupportedMediaPolicy',
  'onInitProgress',
  'isWebGPUAvailable',
  'autoAck',
])

// ─── Option merging ───────────────────────────────────────────────────────────

const mergeHelpers = (
  layers: ReadonlyArray<Partial<ChatCompletionsHelpers> | undefined>
): Partial<ChatCompletionsHelpers> | undefined => {
  let merged: Partial<ChatCompletionsHelpers> | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? {}), ...layer }
  }
  return merged
}

const mergeOptions = (
  baseline: WebLLMChatCompletionsAdapterOptions,
  exec: Partial<WebLLMChatCompletionsAdapterOptions> | undefined,
  stash: Partial<WebLLMChatCompletionsAdapterOptions> | undefined
): Partial<WebLLMChatCompletionsAdapterOptions> => {
  const layers = [baseline as Partial<WebLLMChatCompletionsAdapterOptions>, exec ?? {}, stash ?? {}]
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
  return out as Partial<WebLLMChatCompletionsAdapterOptions>
}

// ─── Helper resolution ────────────────────────────────────────────────────────

const resolveHelpers = (
  overrides: Partial<ChatCompletionsHelpers> | undefined
): ChatCompletionsHelpers => {
  const src = overrides ?? {}
  return {
    descriptionToChatCompletionsJsonSchema:
      src.descriptionToChatCompletionsJsonSchema ?? defaultDescriptionToChatCompletionsJsonSchema,
    renderUntrustedContent: src.renderUntrustedContent ?? defaultRenderUntrustedContent,
    renderTrustedContent: src.renderTrustedContent ?? defaultRenderTrustedContent,
    renderStandingInstructions: src.renderStandingInstructions ?? defaultRenderStandingInstructions,
    renderMemories: src.renderMemories ?? defaultRenderMemories,
    renderRetrievables: src.renderRetrievables ?? defaultRenderRetrievables,
    renderRetrievableSafetyDirective:
      src.renderRetrievableSafetyDirective ?? defaultRenderRetrievableSafetyDirective,
    renderFirstPartyRetrievables:
      src.renderFirstPartyRetrievables ?? defaultRenderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables:
      src.renderThirdPartyPublicRetrievables ?? defaultRenderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables:
      src.renderThirdPartyPrivateRetrievables ?? defaultRenderThirdPartyPrivateRetrievables,
    renderTimelineMessage: src.renderTimelineMessage ?? defaultRenderTimelineMessage,
    renderThought: src.renderThought ?? defaultRenderThought,
    filterThoughts: src.filterThoughts ?? defaultFilterThoughts,
    toolsToChatCompletionsTools:
      src.toolsToChatCompletionsTools ?? defaultToolsToChatCompletionsTools,
    renderChatCompletionsSystemPrompt:
      src.renderChatCompletionsSystemPrompt ?? defaultRenderChatCompletionsSystemPrompt,
    renderChatCompletionsToolCallResult:
      src.renderChatCompletionsToolCallResult ?? defaultRenderChatCompletionsToolCallResult,
    buildChatCompletionsHistory:
      src.buildChatCompletionsHistory ?? defaultBuildChatCompletionsHistory,
    createChatCompletionsToolCallDeltaAccumulator:
      src.createChatCompletionsToolCallDeltaAccumulator ??
      defaultCreateChatCompletionsToolCallDeltaAccumulator,
  }
}

// ─── ID helpers ───────────────────────────────────────────────────────────────

// Canonical (key-order-insensitive) checksum — MUST match the contract documented
// on canonicalStringify and used by Tool.executor + dispatch_runner's streaming
// helper, so ctx.toolCallCount(checksum) detects semantically-identical repeat
// calls regardless of argument key order.
const computeChecksum = (tool: string, args: unknown): string =>
  sha256(canonicalStringify({ tool, args }))

const nowIso = (): string => DateTime.now().toISO() ?? new Date().toISOString()

// ─── Token measurement ────────────────────────────────────────────────────────

const estimateTokensOf = async (
  value: { estimateTokens: (encoding: TokenEncoding) => number | Promise<number> },
  encoding: TokenEncoding
): Promise<number> => {
  return Promise.resolve(value.estimateTokens(encoding))
}

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Opinionated cross-environment LLM adapter for the WebLLM Chat Completions wire shape.
 *
 * @remarks
 * Construction validates options eagerly via {@link @nhtio/adk/batteries!validateOptions} and throws
 * {@link @nhtio/adk/batteries!E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS} on failure — config bugs fail loud, not at
 * dispatch time. The returned instance is reusable: call {@link WebLLMChatCompletionsAdapter.executor}
 * once per `DispatchRunner` configuration to obtain an {@link @nhtio/adk!DispatchExecutorFn} bound to the
 * baseline plus optional executor-scope overrides.
 *
 * Per-iteration overrides live on the active {@link @nhtio/adk!DispatchContext}'s
 * `stash.webLLMChatCompletions` slot and take highest precedence — they merge into the
 * executor-scope shape on every iteration. `helpers` merge key-by-key across all three layers;
 * every other field is replaced wholesale at the highest layer that
 * sets it.
 */
export class WebLLMChatCompletionsAdapter {
  /**
   * Customary key for per-iteration overrides on `ctx.stash`. The adapter reads
   * `ctx.stash.get(WebLLMChatCompletionsAdapter.STASH_KEY, {})` at the start of every
   * iteration and merges the value into the resolved options shape.
   */
  public static readonly STASH_KEY = 'webLLMChatCompletions' as const

  readonly #baseline: WebLLMChatCompletionsAdapterOptions
  #engine: WebLLMEngine | undefined
  #enginePromise: Promise<WebLLMEngine> | undefined

  public static isAvailable(): boolean {
    return (
      typeof globalThis.navigator !== 'undefined' &&
      'gpu' in globalThis.navigator &&
      typeof (globalThis.navigator as { gpu?: unknown }).gpu !== 'undefined'
    )
  }

  /**
   * @param options - Constructor-baseline options. Re-validated on every iteration after
   *   per-dispatch and per-iteration overrides are layered in.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS} when `options` does not satisfy
   *   {@link @nhtio/adk/batteries!webLLMChatCompletionsOptionsSchema}.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
    this.#engine = this.#baseline.engine
  }

  async preload(overrides?: Partial<WebLLMChatCompletionsAdapterOptions>): Promise<WebLLMEngine> {
    const merged = validateOptions(mergeOptions(this.#baseline, overrides, undefined))
    return this.#resolveEngine(merged)
  }

  reset(): void {
    this.#engine = undefined
    this.#enginePromise = undefined
  }

  isAvailable(): boolean {
    return (this.#baseline.isWebGPUAvailable ?? WebLLMChatCompletionsAdapter.isAvailable)()
  }

  async #resolveEngine(merged: WebLLMChatCompletionsAdapterOptions): Promise<WebLLMEngine> {
    if (merged.engine) {
      this.#engine = merged.engine
      return merged.engine
    }
    if (this.#engine) return this.#engine
    const available = (merged.isWebGPUAvailable ?? WebLLMChatCompletionsAdapter.isAvailable)()
    if (!available) {
      throw new E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS([
        'WebLLM requires a browser/runtime with WebGPU support',
      ])
    }
    this.#enginePromise ??= (async () => {
      const createEngine =
        merged.createEngine ??
        (async ({ model, engineConfig, chatOptions, onInitProgress }) => {
          const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
          return (await CreateMLCEngine(
            model,
            { ...(engineConfig ?? {}), initProgressCallback: onInitProgress },
            chatOptions
          )) as WebLLMEngine
        })
      const engine = await createEngine({
        model: merged.model,
        engineConfig: merged.engineConfig,
        chatOptions: merged.chatOptions,
        onInitProgress: merged.onInitProgress,
      })
      this.#engine = engine
      return engine
    })()
    return this.#enginePromise
  }

  /**
   * Returns an {@link @nhtio/adk!DispatchExecutorFn} bound to this adapter's baseline plus optional
   * executor-scope overrides. The returned function is reusable across iterations — every
   * iteration re-merges with `ctx.stash[STASH_KEY]` and re-validates the result.
   *
   * @param overrides - Optional executor-scope overrides. Higher precedence than the baseline,
   *   lower precedence than `ctx.stash[STASH_KEY]`.
   * @returns An {@link @nhtio/adk!DispatchExecutorFn} suitable for `DispatchRunner`.
   */
  executor(overrides?: Partial<WebLLMChatCompletionsAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = WebLLMChatCompletionsAdapter
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      // Bridge helpers.log → the legacy `warn: (msg) => void` slot exposed by the per-call
      // helper signatures. Helpers downstream don't need to know the structured shape — they
      // emit a single string, which we route to `helpers.log.warn` with a stable `kind` so
      // observability middleware can still filter and aggregate.
      const localWarn = (msg: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message: msg })
      }

      // ── Step 1: merge & validate ──────────────────────────────────────────
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object'
          ? (stashRaw as Partial<WebLLMChatCompletionsAdapterOptions>)
          : {}
      const mergedRaw = mergeOptions(baseline, overrides, stashOverrides)
      const merged = validateOptions(mergedRaw)

      // Cross-field invariant: tokenEncoding non-null requires contextWindow.
      if (merged.tokenEncoding !== null && merged.contextWindow === undefined) {
        throw new E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS([
          'tokenEncoding is non-null but contextWindow is undefined',
        ])
      }

      // ── Step 2: resolve helpers ───────────────────────────────────────────
      const resolvedHelpers = resolveHelpers(merged.helpers)

      // ── Step 3: forge artifact-query tools ────────────────────────────────
      const uniqueCtors = new Set<typeof SpooledArtifact>()
      for (const tc of ctx.turnToolCalls) {
        const results = tc.results as unknown as { constructor?: unknown }
        const ctor = results?.constructor
        if (ctor && SpooledArtifact.isSpooledArtifactConstructor(ctor)) {
          uniqueCtors.add(ctor as unknown as typeof SpooledArtifact)
        }
      }
      const forgedRegistries: ToolRegistry[] = []
      for (const ctor of uniqueCtors) {
        const forgeFn = (
          ctor as unknown as {
            forgeTools?: (c: DispatchContext) => ToolRegistry
          }
        ).forgeTools
        if (typeof forgeFn === 'function') {
          forgedRegistries.push(forgeFn.call(ctor, ctx))
        }
      }
      const mergedRegistry = ToolRegistry.merge([ctx.tools, ...forgedRegistries], {
        onCollision: 'replace',
      })
      mergedRegistry.bindContext(ctx)

      // ── Step 4: pre-render tool-call results ──────────────────────────────
      const renderedToolCallResults = new Map<string, string | ChatCompletionsContentBlock[]>()
      for (const tc of ctx.turnToolCalls) {
        const rendered = await resolvedHelpers.renderChatCompletionsToolCallResult({
          toolCall: tc,
          results: tc.results as
            | Tokenizable
            | SpooledArtifact
            | SpooledArtifact[]
            | Media
            | Media[],
          tool: mergedRegistry.get(tc.tool) as Tool | ArtifactTool | undefined,
          renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
          renderTrustedContent: resolvedHelpers.renderTrustedContent,
          unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
          warn: localWarn,
        })
        renderedToolCallResults.set(tc.id, rendered)
      }

      // ── Step 5: context window enforcement ────────────────────────────────
      if (merged.tokenEncoding !== null && merged.contextWindow !== undefined) {
        const encoding = merged.tokenEncoding as TokenEncoding
        let spTokens = await estimateTokensOf(ctx.systemPrompt, encoding)
        let siTokens = 0
        for (const si of ctx.standingInstructions) {
          siTokens += await estimateTokensOf(si, encoding)
        }
        let memTokens = 0
        for (const mem of ctx.turnMemories as Set<Memory>) {
          memTokens += await estimateTokensOf(mem.content, encoding)
        }
        let retTokens = 0
        for (const r of ctx.turnRetrievables) {
          retTokens += await estimateTokensOf(r.content, encoding)
        }
        let tlTokens = 0
        for (const msg of ctx.turnMessages) {
          if (msg.content !== undefined) {
            tlTokens += await estimateTokensOf(msg.content, encoding)
          }
        }
        for (const th of ctx.turnThoughts) {
          tlTokens += await estimateTokensOf(th.content, encoding)
        }
        for (const rendered of renderedToolCallResults.values()) {
          const textPart =
            typeof rendered === 'string'
              ? rendered
              : rendered
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n')
          const tk = new Tokenizable(textPart)
          tlTokens += await estimateTokensOf(tk, encoding)
        }
        const total = spTokens + siTokens + memTokens + retTokens + tlTokens
        const perBucketObj = {
          systemPrompt: spTokens,
          standingInstructions: siTokens,
          memories: memTokens,
          retrievables: retTokens,
          timeline: tlTokens,
        }
        helpers.log.debug({
          kind: 'context-window-usage',
          message: `Context window usage: ${total}/${merged.contextWindow} tokens`,
          payload: {
            total,
            limit: merged.contextWindow,
            encoding,
            perBucket: perBucketObj,
          },
        })
        if (total > merged.contextWindow) {
          const perBucket = JSON.stringify(perBucketObj)
          throw new E_WEBLLM_CHAT_COMPLETIONS_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            encoding,
            perBucket,
          ])
        }
      }

      // ── Step 5b: tool_choice + forged artifact-tools guard ────────────────
      // When `tool_choice` (or the `allowed_tools` variant) forces the model onto a specific
      // tool name and that name resolves to an ephemeral, forged artifact-query tool, surface
      // it as a structured warning (or throw under `strictToolChoice: true`). Forging an
      // artifact-query tool by name is almost always a misconfiguration — the tool may not
      // exist in the next iteration once the artifact ages out of `ctx.turnToolCalls`.
      const forcedToolNames: string[] = []
      const toolChoice = merged.tool_choice
      let toolChoiceVariant: 'function' | 'allowed_tools' = 'function'
      if (toolChoice && typeof toolChoice === 'object') {
        if ('function' in toolChoice && toolChoice.type === 'function') {
          forcedToolNames.push(toolChoice.function.name)
        } else if ('custom' in toolChoice && toolChoice.type === 'custom') {
          forcedToolNames.push(toolChoice.custom.name)
        } else if (toolChoice.type === 'allowed_tools') {
          toolChoiceVariant = 'allowed_tools'
          for (const entry of toolChoice.allowed_tools.tools) {
            if ('function' in entry) forcedToolNames.push(entry.function.name)
            else if ('custom' in entry) forcedToolNames.push(entry.custom.name)
          }
        }
      }
      const forcedForgedHits: Array<{ toolName: string }> = []
      for (const name of forcedToolNames) {
        const t = mergedRegistry.get(name) as { ephemeral?: boolean } | undefined
        if (t?.ephemeral === true) {
          forcedForgedHits.push({ toolName: name })
        }
      }
      if (forcedForgedHits.length > 0) {
        if (merged.strictToolChoice === true) {
          throw new E_INVALID_WEBLLM_CHAT_COMPLETIONS_OPTIONS([
            `tool_choice forces forged ephemeral artifact-query tool(s): ${forcedForgedHits
              .map((h) => h.toolName)
              .join(
                ', '
              )} — these may not exist on the next iteration. Remove the override or unset strictToolChoice.`,
          ])
        }
        helpers.log.warn({
          kind: 'tool-choice-forged-artifact',
          message: `tool_choice forces ${forcedForgedHits.length} forged ephemeral artifact-query tool(s); this is almost always a misconfiguration`,
          payload: {
            toolNames: forcedForgedHits.map((h) => h.toolName),
            variant: toolChoiceVariant,
          },
        })
      }

      // ── Step 6: build request body ────────────────────────────────────────
      const { messages: wireMessages, reasoningPayloads } =
        await resolvedHelpers.buildChatCompletionsHistory({
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
          selfIdentity: merged.selfIdentity ?? 'assistant',
          thoughtSurfacing: merged.thoughtSurfacing ?? 'all-self',
          replayCompatibility: merged.replayCompatibility ?? [],
          renderChatCompletionsToolCallResult: resolvedHelpers.renderChatCompletionsToolCallResult,
          renderChatCompletionsSystemPrompt: resolvedHelpers.renderChatCompletionsSystemPrompt,
          renderStandingInstructions: resolvedHelpers.renderStandingInstructions,
          renderMemories: resolvedHelpers.renderMemories,
          renderRetrievables: resolvedHelpers.renderRetrievables,
          renderRetrievableSafetyDirective: resolvedHelpers.renderRetrievableSafetyDirective,
          renderFirstPartyRetrievables: resolvedHelpers.renderFirstPartyRetrievables,
          renderThirdPartyPublicRetrievables: resolvedHelpers.renderThirdPartyPublicRetrievables,
          renderThirdPartyPrivateRetrievables: resolvedHelpers.renderThirdPartyPrivateRetrievables,
          renderTimelineMessage: resolvedHelpers.renderTimelineMessage,
          renderThought: resolvedHelpers.renderThought,
          filterThoughts: resolvedHelpers.filterThoughts,
          renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
          renderTrustedContent: resolvedHelpers.renderTrustedContent,
          unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
          warn: localWarn,
        })

      const stream = merged.stream ?? true
      const body: WebLLMChatCompletionsRequestBody = {
        model: merged.model,
        messages: wireMessages,
        stream,
      }
      for (const [k, v] of Object.entries(merged)) {
        if (ADK_CONTROL_KEYS.has(k)) continue
        if (k === 'model' || k === 'messages' || k === 'stream') continue
        if (v === undefined) continue
        ;(body as Record<string, unknown>)[k] = v
      }
      const toolsArr = mergedRegistry.all()
      if (toolsArr.length > 0) {
        body.tools = resolvedHelpers.toolsToChatCompletionsTools(toolsArr, {
          descriptionToChatCompletionsJsonSchema:
            resolvedHelpers.descriptionToChatCompletionsJsonSchema,
        })
      }
      if (reasoningPayloads.length > 0) {
        body._adk_reasoning_payloads = reasoningPayloads
      }

      // ── Step 7: invoke WebLLM engine ─────────────────────────────────────
      let completion: ChatCompletionsResponse | AsyncIterable<ChatCompletionsChunk>
      try {
        const engine = await this.#resolveEngine(merged)
        completion = (await engine.chat.completions.create(body as never)) as
          | ChatCompletionsResponse
          | AsyncIterable<ChatCompletionsChunk>
      } catch (err) {
        helpers.log.error({
          kind: 'webllm-engine-error',
          message: `WebLLM engine failure: ${isError(err) ? err.message : String(err)}`,
          payload: { detail: isError(err) ? err.message : String(err) },
        })
        ctx.nack(
          new E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR([isError(err) ? err.message : String(err)])
        )
        return
      }

      // Spool store used to back string / Uint8Array tool returns. Bytes are written under the
      // call id; the resulting SpooledArtifact (or tool-configured subclass) is the model-visible
      // handle for the rest of the turn. Injectable via the `spoolStore` option so consumers can
      // back artifacts with durable storage (OPFS, Flydrive); defaults to an ephemeral per-dispatch
      // in-memory store. NOTE: an injected durable store persists across turns, so call ids must be
      // globally unique for that store (see the `spoolStore` option docs).
      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()

      // ── Inner helper: persist + execute one assembled tool call ───────────
      const executeAndPersistToolCall = async (call: AssembledToolCall): Promise<void> => {
        const tool = mergedRegistry.get(call.name)
        // Parse args defensively. The model may emit non-JSON or a non-object
        // JSON value (string, number, array, null); both are recoverable error
        // conditions, NOT dispatch-killers. A parse failure short-circuits to
        // a persisted error ToolCall — formatted by `E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS`
        // so consumers can match on the stable error code — letting the model
        // self-correct on the next iteration.
        let args: Record<string, unknown> = {}
        let parseError:
          | InstanceType<typeof E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS>
          | undefined
        if (call.args && call.args.length > 0) {
          try {
            const parsed: unknown = JSON.parse(call.args)
            if (isObject(parsed)) {
              args = parsed
            } else {
              const receivedKind = Array.isArray(parsed)
                ? 'array'
                : parsed === null
                  ? 'null'
                  : typeof parsed
              parseError = new E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS([
                `must be a JSON object; received ${receivedKind}`,
                call.args,
              ])
            }
          } catch {
            parseError = new E_WEBLLM_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS([
              'are not valid JSON',
              call.args,
            ])
          }
        }
        const completedAt = nowIso()
        if (parseError !== undefined) {
          const results = new Tokenizable(parseError.message)
          helpers.reportToolCall(call.id, { tool: call.name, args })
          helpers.reportToolCall(call.id, {
            results,
            isError: true,
            isComplete: true,
          })
          const checksum = computeChecksum(call.name, args)
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: call.name,
              args,
              checksum,
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
          const errText = `Tool not found: ${call.name}`
          const results = new Tokenizable(errText)
          helpers.reportToolCall(call.id, { tool: call.name, args })
          helpers.reportToolCall(call.id, {
            results,
            isError: true,
            isComplete: true,
          })
          const checksum = computeChecksum(call.name, args)
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: call.name,
              args,
              checksum,
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
        helpers.reportToolCall(call.id, { tool: tool.name, args })
        const isArtifactTool = ArtifactTool.isArtifactTool(tool)
        let results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[] =
          new Tokenizable('')
        let toolHadError = false
        try {
          const raw = await tool.executor(ctx)(args)
          if (isArtifactTool) {
            // ArtifactTool: handler returns a string | Tokenizable that *is* the model-visible
            // answer to a query against a prior artifact. No spool write, no SpooledArtifact
            // construction — pass through (or wrap a bare string in Tokenizable).
            if (Tokenizable.isTokenizable(raw)) {
              results = raw
            } else if (typeof raw === 'string') {
              results = new Tokenizable(raw)
            } else {
              throw new Error(
                `ArtifactTool "${tool.name}" returned a non-string/non-Tokenizable value`
              )
            }
          } else if (Media.isMedia(raw)) {
            results = raw
          } else if (Array.isArray(raw) && raw.length > 0 && raw.every((m) => Media.isMedia(m))) {
            results = raw as Media[]
          } else if (typeof raw === 'string' || isInstanceOf(raw, 'Uint8Array', Uint8Array)) {
            const reader = await spoolStore.write(call.id, raw as string | Uint8Array)
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          } else {
            // Defensive fallback — wrap stringified value so the model gets *something*.
            const reader = await spoolStore.write(call.id, String(raw))
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          }
        } catch (err) {
          toolHadError = true
          // Surface field-level validation detail from the cause chain so the
          // model can self-correct on the specific offending field. `E_INVALID_TOOL_ARGS`
          // carries the joi `ValidationException` on `cause`, whose message is the
          // joined field-level error text (e.g. `"text" is required`).
          let detailMsg = isError(err) ? err.message : String(err)
          if (
            isError(err) &&
            isError(err.cause) &&
            err.cause.message &&
            err.cause.message !== err.message
          ) {
            detailMsg = `${detailMsg} ${err.cause.message}`
          }
          results = new Tokenizable(detailMsg)
        }
        helpers.reportToolCall(call.id, {
          results,
          isError: toolHadError,
          isComplete: true,
        })
        const checksum = computeChecksum(tool.name, args)
        const completedAt2 = nowIso()
        await ctx.storeToolCall(
          new ToolCall({
            id: call.id,
            tool: tool.name,
            args,
            checksum,
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

      const selfIdentity = merged.selfIdentity ?? 'assistant'

      // ── Step 8: streaming path ────────────────────────────────────────────
      if (stream) {
        const chunks = completion as AsyncIterable<ChatCompletionsChunk>
        if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
          ctx.nack(new E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR(['engine did not return a stream']))
          return
        }
        const accumulator = resolvedHelpers.createChatCompletionsToolCallDeltaAccumulator()
        const streamId = uuidv6()

        let partialMessageContent = ''
        let partialThoughtContent = ''
        let sawMessageDelta = false
        let sawThoughtDelta = false

        const drainAndPersist = async (): Promise<void> => {
          if (sawMessageDelta) {
            helpers.reportMessage(streamId, '', { isComplete: true })
            await ctx.storeMessage(
              new Message({
                id: streamId,
                role: 'assistant',
                content: partialMessageContent,
                identity: selfIdentity,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              })
            )
          }
          if (sawThoughtDelta) {
            helpers.reportThought(streamId, '', { isComplete: true })
            await ctx.storeThought(
              new Thought({
                id: streamId,
                content: partialThoughtContent,
                identity: selfIdentity,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              })
            )
          }
          const calls = accumulator.drain()
          helpers.log.debug({
            kind: 'accumulator-finalised',
            message: `Stream finalised: ${calls.length} tool call(s), message=${sawMessageDelta}, thought=${sawThoughtDelta}`,
            payload: { toolCallCount: calls.length, sawMessageDelta, sawThoughtDelta },
          })
          if (calls.length === 0) {
            // No tool calls — terminal text answer. Self-ack only when opted in;
            // otherwise leave unsignalled so the implementor's output pipeline
            // owns turn completion (autoAck defaults to false).
            if (merged.autoAck) ctx.ack()
            return
          }
          for (const call of calls) {
            if (ctx.abortSignal.aborted) return
            await executeAndPersistToolCall(call)
          }
          // Tool calls produced — do NOT ack; the runner will iterate again.
        }

        try {
          for await (const chunk of chunks) {
            if (ctx.abortSignal.aborted) return
            const delta = chunk.choices?.[0]?.delta
            if (!delta) continue
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              sawMessageDelta = true
              partialMessageContent += delta.content
              helpers.reportMessage(streamId, delta.content)
            }
            const reasoning = (delta as { reasoning_content?: string | null }).reasoning_content
            if (typeof reasoning === 'string' && reasoning.length > 0) {
              sawThoughtDelta = true
              partialThoughtContent += reasoning
              helpers.reportThought(streamId, reasoning)
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const d of delta.tool_calls) {
                accumulator.feed(d)
              }
            }
          }
          await drainAndPersist()
        } catch (err) {
          if (ctx.abortSignal.aborted) return
          helpers.log.error({
            kind: 'stream-error',
            message: `WebLLM stream failed: ${isError(err) ? err.message : String(err)}`,
            payload: { detail: isError(err) ? err.message : String(err) },
          })
          ctx.nack(
            new E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR([isError(err) ? err.message : String(err)])
          )
          return
        }
        return
      }

      // ── Step 9: non-streaming path ────────────────────────────────────────
      const parsed = completion as ChatCompletionsResponse
      const choice = parsed.choices?.[0]
      if (!choice) {
        // Empty response, no tool calls — terminal. Self-ack only when opted in.
        if (merged.autoAck) ctx.ack()
        return
      }
      const msg = choice.message
      const responseId = parsed.id ?? uuidv6()

      if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
        const messageId = `${responseId}:message`
        helpers.reportMessage(messageId, msg.content, { isComplete: true })
        await ctx.storeMessage(
          new Message({
            id: messageId,
            role: 'assistant',
            content: msg.content,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }
      const reasoning = (msg as { reasoning_content?: string | null } | undefined)
        ?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        const thoughtId = `${responseId}:thought`
        helpers.reportThought(thoughtId, reasoning, { isComplete: true })
        await ctx.storeThought(
          new Thought({
            id: thoughtId,
            content: reasoning,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }

      const rawCalls = msg?.tool_calls ?? []
      if (rawCalls.length === 0) {
        // No tool calls — terminal text answer. Self-ack only when opted in;
        // otherwise the implementor's output pipeline owns completion.
        if (merged.autoAck) ctx.ack()
        return
      }
      const calls: AssembledToolCall[] = rawCalls.map((tc) => ({
        id: tc.id,
        type: tc.type ?? 'function',
        name: tc.function?.name ?? '',
        args: tc.function?.arguments ?? '',
      }))
      for (const call of calls) {
        if (ctx.abortSignal.aborted) return
        await executeAndPersistToolCall(call)
      }
      // Tool calls produced — do NOT ack; the runner will iterate again.
    }
  }

  /**
   * Returns `true` when `value` is an {@link WebLLMChatCompletionsAdapter} instance.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an `WebLLMChatCompletionsAdapter` instance.
   */
  public static isWebLLMChatCompletionsAdapter(
    value: unknown
  ): value is WebLLMChatCompletionsAdapter {
    return isInstanceOf(value, 'WebLLMChatCompletionsAdapter', WebLLMChatCompletionsAdapter)
  }
}
