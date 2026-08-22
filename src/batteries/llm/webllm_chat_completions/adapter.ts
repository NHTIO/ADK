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
import { emitLifecycle } from '../chat_common/lifecycle'
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { looksLikeSpooledArtifact, normalizeToolName } from '../chat_common/helpers'
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
  extractReasoningFields,
} from './helpers'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Tool, Memory, TokenEncoding } from '@nhtio/adk/common'
import type { BatteryLifecyclePhase } from '../chat_common/lifecycle'
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
  ReasoningField,
} from './types'

// MLC init-progress `text` markers that indicate the COMPILE sub-phase (WebGPU pipeline / shader build
// / loading-from-cache), as opposed to network fetch. Best-effort: a miss just routes to `loading`, and
// the coarse `compiling` marker before engine-create fires regardless.
const COMPILE_PROGRESS_RE =
  /shader|compil|from cache|gpu pipeline|finish loading|loading model from/i

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
  'reasoningFieldPrecedence',
  'helpers',
  'strictToolChoice',
  'unsupportedMediaPolicy',
  'onInitProgress',
  'isWebGPUAvailable',
  'autoAck',
  'enableThinking',
  // Observability hooks — never sent to the engine.
  'onRawGeneration',
  'onPromptAssembled',
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

  /**
   * Whether the runtime can host a WebLLM engine — i.e. WebGPU (`navigator.gpu`) is present.
   *
   * @returns `true` when WebGPU is available in the current environment.
   */
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

  /**
   * Eagerly loads (and caches) the engine so the first dispatch does not pay the model-load cost.
   *
   * @param overrides - Optional option overrides layered over the constructor baseline.
   * @returns The resolved {@link WebLLMEngine}.
   */
  async preload(overrides?: Partial<WebLLMChatCompletionsAdapterOptions>): Promise<WebLLMEngine> {
    const merged = validateOptions(mergeOptions(this.#baseline, overrides, undefined))
    return this.#resolveEngine(merged)
  }

  /** Drops the cached engine and any in-flight load so the next dispatch re-resolves it. */
  reset(): void {
    this.#engine = undefined
    this.#enginePromise = undefined
  }

  /**
   * Instance-level availability check, honouring an injected
   * {@link WebLLMChatCompletionsAdapterOptions.isWebGPUAvailable} override.
   *
   * @returns `true` when a WebLLM engine can run in the current environment.
   */
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
      emitLifecycle(merged, 'webllm', merged.model, 'loading', {
        detail: 'loading model + booting WebGPU runtime',
      })
      // Forward each MLC init-progress report ({progress 0..1, text, timeElapsed}) into a normalized
      // `loading` lifecycle report, while still calling the consumer's onInitProgress verbatim.
      const hasLifecycle =
        merged.onLifecycle ??
        merged.onLoading ??
        merged.onReady ??
        merged.onGenerating ??
        merged.onError
      const forwardedInitProgress = hasLifecycle
        ? (report: { progress?: number; text?: string }) => {
            // MLC's init reports cover BOTH fetch and shader/graph compilation; the text distinguishes
            // them ("Loading model from cache" / "shader" / "GPU" → the compile sub-phase). Route a
            // compile-flavored report to `compiling`, everything else to `loading`. Any miss falls back
            // to `loading` (no regression — the coarse `compiling` emit below still fires before create).
            const phase: BatteryLifecyclePhase = COMPILE_PROGRESS_RE.test(report?.text ?? '')
              ? 'compiling'
              : 'loading'
            emitLifecycle(merged, 'webllm', merged.model, phase, {
              ...(typeof report?.progress === 'number' ? { progress: report.progress } : {}),
              ...(report?.text ? { detail: report.text } : {}),
              raw: report,
            })
            merged.onInitProgress?.(report as never)
          }
        : merged.onInitProgress
      try {
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
        // Coarse `compiling` marker: by the time MLC has the weights and is building the WebGPU pipeline,
        // this fires even if no init-report text matched COMPILE_PROGRESS_RE (the boundary the LiteRT chat
        // demo marks). Per-report `compiling` above refines it when MLC's text is granular enough.
        emitLifecycle(merged, 'webllm', merged.model, 'compiling', {
          detail: 'compiling model + WebGPU shaders',
        })
        const engine = await createEngine({
          model: merged.model,
          engineConfig: merged.engineConfig,
          chatOptions: merged.chatOptions,
          onInitProgress: forwardedInitProgress,
        })
        this.#engine = engine
        emitLifecycle(merged, 'webllm', merged.model, 'ready', { detail: 'engine ready' })
        return engine
      } catch (err) {
        this.#enginePromise = undefined
        emitLifecycle(merged, 'webllm', merged.model, 'error', { error: err })
        throw err
      }
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

      // ── Step 3: artifact-reader tools ─────────────────────────────────────
      // Forged by the DispatchRunner CORE into `ctx.tools` before the input pipeline runs (generation is a
      // generic core concern; this battery owns only representation). Read the pre-forged `ctx.tools`
      // directly — no local merge, no bindContext here.

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
          tool: ctx.tools.get(tc.tool) as Tool | ArtifactTool | undefined,
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
        // Tool DECLARATIONS: WebLLM sends the visible tools as `body.tools` and MLC applies the model's
        // conversation template IN-PROCESS (browser), wrapping them per-model — so the exact rendered
        // string isn't reproducible here without the template. Tally the serialized tool JSON (the
        // reproducible, dominant component the adapter actually passes) as an honest FLOOR. Without this
        // the guard undercounts a tool-heavy prompt by the entire declaration block.
        let toolTokens = 0
        const visibleTools = ctx.tools.visible()
        if (visibleTools.length > 0) {
          const toolsJson = JSON.stringify(
            resolvedHelpers.toolsToChatCompletionsTools(visibleTools, {
              descriptionToChatCompletionsJsonSchema:
                resolvedHelpers.descriptionToChatCompletionsJsonSchema,
            })
          )
          toolTokens = await estimateTokensOf(new Tokenizable(toolsJson), encoding)
        }
        const total = spTokens + siTokens + memTokens + retTokens + tlTokens + toolTokens
        const perBucketObj = {
          systemPrompt: spTokens,
          standingInstructions: siTokens,
          memories: memTokens,
          retrievables: retTokens,
          timeline: tlTokens,
          tools: toolTokens,
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
        const t = ctx.tools.get(name) as { ephemeral?: boolean } | undefined
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
          tools: ctx.tools,
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
      // Thread the explicit thinking flag into extra_body.enable_thinking so the underlying chat
      // template never decides for itself (Qwen3/DeepSeek default thinking ON). Default OFF; merged with
      // any caller-supplied extra_body without clobbering it.
      body.extra_body = {
        ...(body.extra_body ?? {}),
        enable_thinking: merged.enableThinking ?? false,
      }
      const toolsArr = ctx.tools.visible()
      if (toolsArr.length > 0) {
        body.tools = resolvedHelpers.toolsToChatCompletionsTools(toolsArr, {
          descriptionToChatCompletionsJsonSchema:
            resolvedHelpers.descriptionToChatCompletionsJsonSchema,
        })
      }
      if (reasoningPayloads.length > 0) {
        body._adk_reasoning_payloads = reasoningPayloads
      }

      // One id for this whole generation — correlates the TO tap (onPromptAssembled) with the FROM tap
      // (onRawGeneration) below.
      const dispatchStreamId = uuidv6()

      // Prompt-assembled observability tap: the EXACT request body going TO the engine, the instant it is
      // built and BEFORE create(). Mirror of onRawGeneration. Handed back AS-IS — no redaction — and
      // swallow observer errors so it can never corrupt the generation path.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'webllm_chat_completions',
            kind: 'request-body',
            messages: body.messages,
            tools: body.tools,
            requestBody: body,
            streamed: stream,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      // ── Step 7: invoke WebLLM engine ─────────────────────────────────────
      let completion: ChatCompletionsResponse | AsyncIterable<ChatCompletionsChunk>
      try {
        const engine = await this.#resolveEngine(merged)
        emitLifecycle(merged, 'webllm', merged.model, 'generating')
        completion = (await engine.chat.completions.create(body as never)) as
          | ChatCompletionsResponse
          | AsyncIterable<ChatCompletionsChunk>
      } catch (err) {
        helpers.log.error({
          kind: 'webllm-engine-error',
          message: `WebLLM engine failure: ${isError(err) ? err.message : String(err)}`,
          payload: { detail: isError(err) ? err.message : String(err) },
        })
        emitLifecycle(merged, 'webllm', merged.model, 'error', { error: err })
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
        const tool = ctx.tools.get(call.name)
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
          const toolName = normalizeToolName(call.name)
          const results = new Tokenizable(parseError.message)
          helpers.reportToolCall(call.id, { tool: toolName, args })
          helpers.reportToolCall(call.id, {
            results,
            isError: true,
            isComplete: true,
          })
          const checksum = computeChecksum(toolName, args)
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: toolName,
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
          const toolName = normalizeToolName(call.name)
          // List the tools that DO exist so the model can self-correct on the next iteration
          // instead of guessing. Without this, a single typo'd / hallucinated tool name yields
          // a dead-end "not found" with no path forward.
          const available = ctx.tools
            .all()
            .map((t) => t.name)
            .sort()
          const errText =
            available.length > 0
              ? `Tool not found: ${toolName}. Available tools: ${available.join(', ')}.`
              : `Tool not found: ${toolName}. No tools are available this turn.`
          const results = new Tokenizable(errText)
          helpers.reportToolCall(call.id, { tool: toolName, args })
          helpers.reportToolCall(call.id, {
            results,
            isError: true,
            isComplete: true,
          })
          const checksum = computeChecksum(toolName, args)
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: toolName,
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
          } else if (looksLikeSpooledArtifact(raw)) {
            results = raw as SpooledArtifact
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

      // FALLBACK tool-call recovery. WebLLM's OpenAI-shaped `message.tool_calls` is authoritative; this is
      // consulted ONLY when the engine returned zero structured calls AND the caller opted in via
      // `localToolCallParser`. On-device small models routinely emit a call in a surface form the chat
      // template does not lift into `tool_calls` (`<call:name{…}`, a ```json block, bare `name\nkey:
      // value`), landing it in `content`. Pure parse — returns assembled calls with `args` as the JSON
      // STRING `executeAndPersistToolCall` expects (empty when disabled or no match), so each call site can
      // reflect them in the onRawGeneration tap and then execute. Fully backward-compatible: absent option
      // → `[]` → today's native-only behaviour.
      const parseFallbackToolCalls = (content: string): AssembledToolCall[] => {
        if (merged.localToolCallParser === undefined) return []
        if (typeof content !== 'string' || content.length === 0) return []
        const parser = resolveToolCallParser(merged.localToolCallParser)
        const toolNames = ctx.tools.visible().map((t) => t.name)
        return parser(content, { toolNames }).calls.map((c) => ({
          id: uuidv6(),
          type: 'function' as const,
          name: c.name,
          args: JSON.stringify(c.arguments),
        }))
      }

      const selfIdentity = merged.selfIdentity ?? 'assistant'
      const reasoningPrecedence = merged.reasoningFieldPrecedence ?? [
        'reasoning',
        'reasoning_content',
      ]

      // ── Step 8: streaming path ────────────────────────────────────────────
      if (stream) {
        const chunks = completion as AsyncIterable<ChatCompletionsChunk>
        if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
          ctx.nack(new E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR(['engine did not return a stream']))
          return
        }
        const accumulator = resolvedHelpers.createChatCompletionsToolCallDeltaAccumulator()
        const streamId = dispatchStreamId

        let partialMessageContent = ''
        let sawMessageDelta = false

        // Reasoning may stream under more than one provider-specific field at once. Accumulate each
        // field's text under its own live stream id; at completion we dedup by content to decide
        // whether to persist one Thought or one per divergent field. The first field to appear keeps
        // the bare `streamId` (the common single-field case); any others get a `:field` suffix.
        const thoughtAccum = new Map<ReasoningField, string>()
        let primaryThoughtField: ReasoningField | undefined
        const thoughtStreamId = (field: ReasoningField): string =>
          field === primaryThoughtField ? streamId : `${streamId}:${field}`

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
          // Finalize every reasoning stream we opened live, then dedup by content to decide how many
          // Thoughts to persist: one (fields agreed, or only one present) vs one per divergent field.
          for (const field of thoughtAccum.keys()) {
            helpers.reportThought(thoughtStreamId(field), '', { isComplete: true })
          }
          const thoughtExtracts = extractReasoningFields(
            Object.fromEntries(thoughtAccum) as Partial<Record<ReasoningField, string>>,
            reasoningPrecedence
          )
          if (thoughtExtracts.length === 1) {
            await ctx.storeThought(
              new Thought({
                id: streamId,
                content: thoughtExtracts[0].content,
                identity: selfIdentity,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              })
            )
          } else {
            for (const { field, content } of thoughtExtracts) {
              await ctx.storeThought(
                new Thought({
                  id: thoughtStreamId(field),
                  content,
                  identity: selfIdentity,
                  createdAt: nowIso(),
                  updatedAt: nowIso(),
                })
              )
            }
          }
          const nativeCalls = accumulator.drain()
          // Fallback recovery (opt-in): if the engine streamed no structured calls, try to parse one out of
          // the accumulated `content`. Consulted only when native calls are absent, so the engine wins.
          const calls =
            nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(partialMessageContent)

          // Raw-generation observability tap (FROM the engine) — streaming path. `rawText`/`cleanedText`
          // are the accumulated assistant content; `toolCalls` are the calls this dispatch will act on
          // (native, or fallback-recovered — args JSON-parsed best-effort). Fired once at stream drain;
          // observer errors swallowed.
          if (merged.onRawGeneration) {
            try {
              merged.onRawGeneration({
                rawText: partialMessageContent,
                cleanedText: partialMessageContent,
                reasoning: thoughtExtracts.map((r) => r.content),
                toolCalls: calls.map((c) => {
                  let parsedArgs: Record<string, unknown> = {}
                  try {
                    const p: unknown = JSON.parse(c.args || '{}')
                    if (isObject(p)) parsedArgs = p as Record<string, unknown>
                  } catch {
                    /* leave args empty on unparseable JSON */
                  }
                  return { name: c.name, arguments: parsedArgs as never }
                }),
                streamed: true,
                streamId: dispatchStreamId,
              })
            } catch {
              /* observer errors are non-fatal */
            }
          }

          helpers.log.debug({
            kind: 'accumulator-finalised',
            message: `Stream finalised: ${calls.length} tool call(s), message=${sawMessageDelta}, thoughtFields=${thoughtExtracts.length}`,
            payload: {
              toolCallCount: calls.length,
              sawMessageDelta,
              thoughtFieldCount: thoughtExtracts.length,
            },
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
            // Stream every reasoning field present on this delta, in precedence order. No
            // mid-stream dedup — deltas are fragments; we compare full contents at completion.
            for (const field of reasoningPrecedence) {
              const reasoning = delta[field]
              if (typeof reasoning !== 'string' || reasoning.length === 0) continue
              if (!thoughtAccum.has(field)) {
                primaryThoughtField ??= field
                thoughtAccum.set(field, '')
              }
              thoughtAccum.set(field, thoughtAccum.get(field)! + reasoning)
              helpers.reportThought(thoughtStreamId(field), reasoning)
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
          emitLifecycle(merged, 'webllm', merged.model, 'error', { error: err })
          ctx.nack(
            new E_WEBLLM_CHAT_COMPLETIONS_STREAM_ERROR([isError(err) ? err.message : String(err)])
          )
          return
        }
        emitLifecycle(merged, 'webllm', merged.model, 'complete')
        return
      }

      // ── Step 9: non-streaming path ────────────────────────────────────────
      const parsed = completion as ChatCompletionsResponse
      const choice = parsed.choices?.[0]
      if (!choice) {
        // Empty response, no tool calls — terminal. Self-ack only when opted in.
        emitLifecycle(merged, 'webllm', merged.model, 'complete')
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
      // Reasoning may arrive under more than one provider-specific field. A single extracted
      // entry (only one field present, or several but identical) keeps the historical
      // `${responseId}:thought` id; divergent fields each surface as their own thought.
      const reasoningExtracts = extractReasoningFields(msg, reasoningPrecedence)
      for (const { field, content } of reasoningExtracts) {
        const thoughtId =
          reasoningExtracts.length > 1 ? `${responseId}:thought:${field}` : `${responseId}:thought`
        helpers.reportThought(thoughtId, content, { isComplete: true })
        await ctx.storeThought(
          new Thought({
            id: thoughtId,
            content,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }

      const rawCalls = msg?.tool_calls ?? []
      const content = typeof msg?.content === 'string' ? msg.content : ''

      // Fallback recovery (opt-in): if the engine returned no structured calls, try to parse one out of the
      // assistant `content`. Consulted only when native calls are absent, so the engine always wins.
      const nativeCalls: AssembledToolCall[] = rawCalls.map((tc) => ({
        id: tc.id,
        type: tc.type ?? 'function',
        name: tc.function?.name ?? '',
        args: tc.function?.arguments ?? '',
      }))
      const calls = nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(content)

      // Raw-generation observability tap (FROM the engine) — non-streaming path. `rawText`/`cleanedText`
      // are the returned assistant content; `toolCalls` are the calls this dispatch will act on (native, or
      // fallback-recovered — args JSON-parsed best-effort). Fired once per terminal generation; observer
      // errors swallowed.
      if (merged.onRawGeneration) {
        try {
          merged.onRawGeneration({
            rawText: content,
            cleanedText: content,
            reasoning: reasoningExtracts.map((r) => r.content),
            toolCalls: calls.map((c) => {
              let parsedArgs: Record<string, unknown> = {}
              try {
                const p: unknown = JSON.parse(c.args || '{}')
                if (isObject(p)) parsedArgs = p as Record<string, unknown>
              } catch {
                /* leave args empty on unparseable JSON */
              }
              return { name: c.name, arguments: parsedArgs as never }
            }),
            streamed: false,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      if (calls.length === 0) {
        // No tool calls — terminal text answer. Self-ack only when opted in;
        // otherwise the implementor's output pipeline owns completion.
        emitLifecycle(merged, 'webllm', merged.model, 'complete')
        if (merged.autoAck) ctx.ack()
        return
      }
      for (const call of calls) {
        if (ctx.abortSignal.aborted) return
        await executeAndPersistToolCall(call)
      }
      // Tool calls produced — do NOT ack; the runner will iterate again.
      emitLifecycle(merged, 'webllm', merged.model, 'complete')
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
