/**
 * Cross-environment executor adapter for OpenAI Chat Completions compatible endpoints.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions/adapter
 *
 * @remarks
 * Cross-environment LLM adapter for the OpenAI Chat Completions wire shape. Chat Completions was
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
 *    per-iteration `ctx.stash.openaiChatCompletions` overrides combine with key-by-key
 *    precedence for `headers`/`helpers`/`retry` and wholesale replacement for everything else.
 *    The merged shape is re-validated on every iteration so a malformed stash override
 *    fails loud, not silently.
 * 3. **Cross-env transport** — uses `globalThis.fetch`, `TextDecoder`, `AbortController`, and
 *    `AbortSignal.any` only. No Node-specific primitives; works unchanged in browser, edge, and
 *    server runtimes. SSE framing is hand-parsed against `\n\n` separators so the streaming path
 *    has no dependency on a particular SSE library.
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
 *    {@link @nhtio/adk/batteries!E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW} when the total exceeds `contextWindow`.
 * 6. Build the request body via `buildChatCompletionsHistory`; carry vendor-opaque reasoning
 *    blocks through the `_adk_reasoning_payloads` side-channel.
 * 7. POST with a linked `AbortSignal`, retry loop respecting `retry.*`, and a request-timeout
 *    watchdog that arms before fetch and clears once response headers arrive.
 * 8. Streaming path: SSE parse via `response.body.getReader()` + `TextDecoder`; surface deltas
 *    through `helpers.reportMessage` / `reportThought` / `reportToolCall`; assemble tool-call
 *    deltas via the accumulator; persist `Message` / `Thought` / `ToolCall` records on `[DONE]`.
 * 9. Non-streaming path: single `response.json()`; same persistence + tool-execution loop.
 */

import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { validateOptions } from './validation'
import { isError, isInstanceOf, isObject } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { looksLikeSpooledArtifact, normalizeToolName } from '../chat_common/helpers'
import {
  computeBackoff,
  sleepWithJitter,
  parseRetryAfter,
  linkAbortSignals,
} from '../../../lib/utils/retry'
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
  E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS,
  E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW,
  E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR,
  E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR,
  E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED,
  E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT,
  E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS,
} from './exceptions'
import {
  defaultDescriptionToChatCompletionsJsonSchema,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
  defaultRenderStandingInstructions,
  defaultRenderMemories,
  defaultRenderRetrievables,
  defaultRenderRetrievableHandleBody,
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
import type {
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  GenerationStats,
} from '@nhtio/adk/dispatch_runner'
import type {
  OpenAIChatCompletionsAdapterOptions,
  ChatCompletionsHelpers,
  ChatCompletionsRetryConfig,
  OpenAIChatCompletionsRequestBody,
  ChatCompletionsChunk,
  ChatCompletionsResponse,
  AssembledToolCall,
  ChatCompletionsContentBlock,
  ReasoningField,
} from './types'

// ─── ADK-control keys (stripped before sending the request body) ──────────

const ADK_CONTROL_KEYS: ReadonlySet<string> = new Set([
  'apiKey',
  'baseURL',
  'headers',
  'fetch',
  'stream',
  'bucketOrder',
  'contextWindow',
  'selfIdentity',
  'thoughtSurfacing',
  'tokenEncoding',
  'replayCompatibility',
  'reasoningFieldPrecedence',
  'helpers',
  'streamIdleTimeoutMs',
  'requestTimeoutMs',
  'retry',
  'strictToolChoice',
  'autoAck',
  'unsupportedMediaPolicy',
  // Observability hooks — never sent to the provider.
  'onRawGeneration',
  'onPromptAssembled',
  'toolCallIdFilter',
])

// ─── Option merging ───────────────────────────────────────────────────────────

const mergeRetry = (
  layers: ReadonlyArray<ChatCompletionsRetryConfig | undefined>
): ChatCompletionsRetryConfig | undefined => {
  let merged: ChatCompletionsRetryConfig | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? {}), ...layer }
  }
  return merged
}

const mergeHeaders = (
  layers: ReadonlyArray<Record<string, string> | undefined>
): Record<string, string> | undefined => {
  let merged: Record<string, string> | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? {}), ...layer }
  }
  return merged
}

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
  baseline: OpenAIChatCompletionsAdapterOptions,
  exec: Partial<OpenAIChatCompletionsAdapterOptions> | undefined,
  stash: Partial<OpenAIChatCompletionsAdapterOptions> | undefined
): Partial<OpenAIChatCompletionsAdapterOptions> => {
  const layers = [baseline as Partial<OpenAIChatCompletionsAdapterOptions>, exec ?? {}, stash ?? {}]
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (k === 'headers' || k === 'helpers' || k === 'retry') continue
      out[k] = v
    }
  }
  const headers = mergeHeaders(layers.map((l) => l.headers))
  if (headers !== undefined) out.headers = headers
  const helpers = mergeHelpers(layers.map((l) => l.helpers))
  if (helpers !== undefined) out.helpers = helpers
  const retry = mergeRetry(layers.map((l) => l.retry))
  if (retry !== undefined) out.retry = retry
  return out as Partial<OpenAIChatCompletionsAdapterOptions>
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
    renderRetrievableHandleBody:
      src.renderRetrievableHandleBody ?? defaultRenderRetrievableHandleBody,
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

// ─── Retry / timeout helpers ──────────────────────────────────────────────────
// Shared with the OpenAI Embeddings battery — see `../../../lib/utils/retry`. These are pure,
// environment-neutral primitives; the import keeps retry behavior identical across batteries
// without duplication.

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

// ─── Generation-stats extraction ───────────────────────────────────────────────

const extractGenerationStats = (input: {
  model: string
  usage?: Record<string, unknown>
  finishReason?: string | null
  raw: Record<string, unknown>
}): GenerationStats => {
  const stats: GenerationStats = {
    provider: 'openai_chat_completions',
    model: input.model,
    raw: input.raw,
  }
  const usage = input.usage
  if (usage) {
    if (typeof usage.prompt_tokens === 'number') stats.promptTokens = usage.prompt_tokens
    if (typeof usage.completion_tokens === 'number')
      stats.completionTokens = usage.completion_tokens
    if (typeof usage.total_tokens === 'number') stats.totalTokens = usage.total_tokens
  }
  if (typeof input.finishReason === 'string') stats.finishReason = input.finishReason
  return stats
}

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Opinionated cross-environment LLM adapter for the OpenAI Chat Completions wire shape.
 *
 * @remarks
 * Construction validates options eagerly via {@link @nhtio/adk/batteries!validateOptions} and throws
 * {@link @nhtio/adk/batteries!E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS} on failure — config bugs fail loud, not at
 * dispatch time. The returned instance is reusable: call {@link OpenAIChatCompletionsAdapter.executor}
 * once per `DispatchRunner` configuration to obtain an {@link @nhtio/adk!DispatchExecutorFn} bound to the
 * baseline plus optional executor-scope overrides.
 *
 * Per-iteration overrides live on the active {@link @nhtio/adk!DispatchContext}'s
 * `stash.openaiChatCompletions` slot and take highest precedence — they merge into the
 * executor-scope shape on every iteration. `headers`, `helpers`, and `retry` merge key-by-key
 * across all three layers; every other field is replaced wholesale at the highest layer that
 * sets it.
 */
export class OpenAIChatCompletionsAdapter {
  /**
   * Customary key for per-iteration overrides on `ctx.stash`. The adapter reads
   * `ctx.stash.get(OpenAIChatCompletionsAdapter.STASH_KEY, {})` at the start of every
   * iteration and merges the value into the resolved options shape.
   */
  public static readonly STASH_KEY = 'openaiChatCompletions' as const

  readonly #baseline: OpenAIChatCompletionsAdapterOptions

  /**
   * @param options - Constructor-baseline options. Re-validated on every iteration after
   *   per-dispatch and per-iteration overrides are layered in.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS} when `options` does not satisfy
   *   {@link @nhtio/adk/batteries!openAIChatCompletionsOptionsSchema}.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
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
  executor(overrides?: Partial<OpenAIChatCompletionsAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = OpenAIChatCompletionsAdapter
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
          ? (stashRaw as Partial<OpenAIChatCompletionsAdapterOptions>)
          : {}
      const mergedRaw = mergeOptions(baseline, overrides, stashOverrides)
      const merged = validateOptions(mergedRaw)

      // Cross-field invariant: tokenEncoding non-null requires contextWindow.
      if (merged.tokenEncoding !== null && merged.contextWindow === undefined) {
        throw new E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS([
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
      const renderedToolCallResults = new Map<ToolCall, string | ChatCompletionsContentBlock[]>()
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
        renderedToolCallResults.set(tc, rendered)
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
          retTokens +=
            !r.inline && SpooledArtifact.isSpooledArtifact(r.content) && r.content.hasSizeHints()
              ? r.content.estimateHandleTokens(
                  r.id,
                  encoding,
                  resolvedHelpers.renderRetrievableHandleBody
                )
              : await estimateTokensOf(r.content, encoding)
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
        // Tool DECLARATIONS: the OpenAI wire ships tools as the `tools` array, which the PROVIDER
        // serializes server-side into the model's own format (per-model, not reproducible client-side).
        // Tally the tokens of the wire `tools` JSON (`JSON.stringify`) as an honest FLOOR — a truthful
        // lower bound, commented as approximate. Without this the guard undercounts a tool-heavy prompt
        // by the entire declaration block.
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
          throw new E_OPENAI_CHAT_COMPLETIONS_CONTEXT_OVERFLOW([
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
          throw new E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS([
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
          renderRetrievableHandleBody: resolvedHelpers.renderRetrievableHandleBody,
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
      const body: OpenAIChatCompletionsRequestBody = {
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
      // Usage is only present on the FINAL streaming chunk, and only when the request opts in —
      // default it on so `reportGenerationStats` has something to report on the streaming path too.
      // Left untouched if the consumer set `stream_options` themselves (even partially).
      if (stream && body.stream_options === undefined) {
        body.stream_options = { include_usage: true }
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

      // Prompt-assembled observability tap: the EXACT request body going TO the provider, the instant it
      // is built and BEFORE the POST. Mirror of onRawGeneration. Handed back AS-IS — no redaction (the
      // body already has ADK-control keys like apiKey stripped, but that is incidental) — and swallow
      // observer errors so it can never corrupt the generation path.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'openai_chat_completions',
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

      // ── Step 7: POST with retry / timeout loop ────────────────────────────
      const rawBase = merged.baseURL ?? 'https://api.openai.com/v1'
      const baseURL = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase
      const url = `${baseURL}/chat/completions`

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (stream) headers['Accept'] = 'text/event-stream'
      if (merged.apiKey) {
        headers['Authorization'] = `Bearer ${merged.apiKey}`
      }
      // User-supplied headers override built defaults (including Authorization).
      if (merged.headers) {
        Object.assign(headers, merged.headers)
      }

      const retryCfg: ChatCompletionsRetryConfig = {
        maxAttempts: merged.retry?.maxAttempts ?? 1,
        baseDelayMs: merged.retry?.baseDelayMs ?? 500,
        maxDelayMs: merged.retry?.maxDelayMs ?? 30_000,
        retriableStatuses: merged.retry?.retriableStatuses ?? [429, 502, 503, 504],
        honorRetryAfter: merged.retry?.honorRetryAfter ?? true,
      }

      const fetchFn = merged.fetch ?? globalThis.fetch
      const maxAttempts = retryCfg.maxAttempts ?? 1

      let response: Response | undefined
      let attempt = 1
      // The abort-signal link attaches listeners to the long-lived ctx.abortSignal.
      // Each retry attempt re-links, so dispose the PRIOR attempt's link before
      // making a new one — otherwise N retries leave N stale listeners on
      // ctx.abortSignal for the rest of the turn. The final (successful) attempt's
      // link is bounded by the turn's lifetime, same as the native AbortSignal.any.
      let disposeLink: () => void = () => {}
      while (attempt <= maxAttempts) {
        if (ctx.abortSignal.aborted) return

        const internalController = new AbortController()
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const requestTimeoutMs = merged.requestTimeoutMs ?? 0
        if (requestTimeoutMs > 0) {
          timeoutHandle = setTimeout(() => internalController.abort(), requestTimeoutMs)
        }
        disposeLink()
        const { signal: linkedSignal, dispose: disposeCurrentLink } = linkAbortSignals([
          ctx.abortSignal,
          internalController.signal,
        ])
        disposeLink = disposeCurrentLink

        try {
          response = await fetchFn(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: linkedSignal,
          })
        } catch (err) {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          if (ctx.abortSignal.aborted) return
          if (internalController.signal.aborted) {
            // Request timed out before headers arrived — eligible for retry.
            helpers.log.warn({
              kind: 'request-timeout',
              message: `Request timed out after ${requestTimeoutMs}ms on attempt ${attempt}/${maxAttempts}`,
              payload: { requestTimeoutMs, attempt, maxAttempts },
            })
            if (attempt < maxAttempts) {
              const delay = computeBackoff(attempt, retryCfg)
              helpers.log.debug({
                kind: 'retry-attempt',
                message: `Retrying after request timeout in ~${delay}ms (attempt ${attempt + 1}/${maxAttempts})`,
                payload: {
                  reason: 'request-timeout',
                  delayMs: delay,
                  attempt: attempt + 1,
                  maxAttempts,
                },
              })
              await sleepWithJitter(delay, ctx.abortSignal)
              attempt += 1
              continue
            }
            ctx.nack(new E_OPENAI_CHAT_COMPLETIONS_REQUEST_TIMEOUT([requestTimeoutMs]))
            return
          }
          // Generic transport failure (DNS, connection refused, TLS, socket drop) —
          // fetch rejected before any HTTP response, so status is 0. Eligible for
          // retry up to maxAttempts, mirroring the request-timeout branch above and
          // the embeddings adapter. retriableStatuses gates HTTP responses only; it
          // never applies here because there is no response.
          helpers.log.error({
            kind: 'transport-error',
            message: `Transport failure on attempt ${attempt}/${maxAttempts}: ${isError(err) ? err.message : String(err)}`,
            payload: {
              attempt,
              maxAttempts,
              detail: isError(err) ? err.message : String(err),
            },
          })
          if (attempt < maxAttempts) {
            const delay = computeBackoff(attempt, retryCfg)
            helpers.log.debug({
              kind: 'retry-attempt',
              message: `Retrying after transport failure in ~${delay}ms (attempt ${attempt + 1}/${maxAttempts})`,
              payload: {
                reason: 'transport-error',
                delayMs: delay,
                attempt: attempt + 1,
                maxAttempts,
              },
            })
            await sleepWithJitter(delay, ctx.abortSignal)
            attempt += 1
            continue
          }
          ctx.nack(
            new E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR([0, isError(err) ? err.message : String(err)])
          )
          return
        }

        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

        if (!response.ok) {
          const status = response.status
          const retriable = (retryCfg.retriableStatuses ?? [429, 502, 503, 504]).includes(status)
          if (retriable && attempt < maxAttempts) {
            let delay = computeBackoff(attempt, retryCfg)
            let retryAfterMs: number | undefined
            if (retryCfg.honorRetryAfter !== false) {
              const ra = response.headers.get('Retry-After')
              if (ra) {
                const raMs = parseRetryAfter(ra)
                if (raMs > 0) {
                  retryAfterMs = raMs
                  delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs ?? 30_000)
                }
              }
            }
            helpers.log.warn({
              kind: 'retry-attempt',
              message: `HTTP ${status} on attempt ${attempt}/${maxAttempts}; retrying in ~${delay}ms`,
              payload: {
                reason: 'http-status',
                status,
                delayMs: delay,
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                attempt: attempt + 1,
                maxAttempts,
              },
            })
            await sleepWithJitter(delay, ctx.abortSignal)
            attempt += 1
            continue
          }
          const errBody = await response.text().catch(() => '')
          helpers.log.error({
            kind: 'http-error',
            message: `HTTP ${status} (terminal): ${errBody.slice(0, 256)}`,
            payload: {
              status,
              body: errBody,
              attempt,
              maxAttempts,
              retriable,
            },
          })
          ctx.nack(new E_OPENAI_CHAT_COMPLETIONS_HTTP_ERROR([status, errBody]))
          return
        }

        break
      }

      if (!response) return

      // Spool store used to back string / Uint8Array tool returns. Bytes are written under the
      // call id; the resulting SpooledArtifact (or tool-configured subclass) is the model-visible
      // handle for the rest of the turn. Injectable via the `spoolStore` option so consumers can
      // back artifacts with durable storage (OPFS, Flydrive); defaults to an ephemeral per-dispatch
      // in-memory store. NOTE: an injected durable store persists across turns, so call ids must be
      // globally unique for that store (see the `spoolStore` option docs).
      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()

      // ── Inner helper: persist + execute one assembled tool call ───────────
      const executeAndPersistToolCall = async (call: AssembledToolCall): Promise<void> => {
        // Resolve the vendor id once at ingress so reporting, persistence, and spooling agree.
        const callId = merged.toolCallIdFilter?.(call.id, ctx) ?? call.id
        const tool = ctx.tools.get(call.name)
        // Parse args defensively. The model may emit non-JSON or a non-object
        // JSON value (string, number, array, null); both are recoverable error
        // conditions, NOT dispatch-killers. A parse failure short-circuits to
        // a persisted error ToolCall — formatted by `E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS`
        // so consumers can match on the stable error code — letting the model
        // self-correct on the next iteration.
        let args: Record<string, unknown> = {}
        let parseError:
          | InstanceType<typeof E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS>
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
              parseError = new E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS([
                `must be a JSON object; received ${receivedKind}`,
                call.args,
              ])
            }
          } catch {
            parseError = new E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS([
              'are not valid JSON',
              call.args,
            ])
          }
        }
        const completedAt = nowIso()
        if (parseError !== undefined) {
          const toolName = normalizeToolName(call.name)
          const results = new Tokenizable(parseError.message)
          helpers.reportToolCall(callId, { tool: toolName, args })
          helpers.reportToolCall(callId, {
            results,
            isError: true,
            isComplete: true,
          })
          const checksum = computeChecksum(toolName, args)
          await ctx.storeToolCall(
            new ToolCall({
              id: callId,
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
          helpers.reportToolCall(callId, { tool: toolName, args })
          helpers.reportToolCall(callId, {
            results,
            isError: true,
            isComplete: true,
          })
          const checksum = computeChecksum(toolName, args)
          await ctx.storeToolCall(
            new ToolCall({
              id: callId,
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
        helpers.reportToolCall(callId, { tool: tool.name, args })
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
            const reader = await spoolStore.write(callId, raw as string | Uint8Array)
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          } else {
            // Defensive fallback — wrap stringified value so the model gets *something*.
            const reader = await spoolStore.write(callId, String(raw))
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
        helpers.reportToolCall(callId, {
          results,
          isError: toolHadError,
          isComplete: true,
        })
        const checksum = computeChecksum(tool.name, args)
        const completedAt2 = nowIso()
        await ctx.storeToolCall(
          new ToolCall({
            id: callId,
            tool: tool.name,
            args,
            checksum,
            isComplete: true,
            isError: toolHadError,
            results,
            fromArtifactTool: isArtifactTool,
            // ArtifactTool calls are the documented exception to handle-by-default: their result IS the
            // inlined slice the model just queried out of a prior artifact (a Tokenizable answer), so
            // handing back a handle to a query RESULT would be nonsensical recursion. Everything else
            // keeps the secure default (inline:false → SpooledArtifact rendered as a handle).
            inline: isArtifactTool,
            createdAt: completedAt2,
            updatedAt: completedAt2,
            completedAt: completedAt2,
          })
        )
      }

      // FALLBACK tool-call recovery. The provider's `message.tool_calls` is authoritative; this is
      // consulted ONLY when the provider returned zero structured calls AND the caller opted in via
      // `localToolCallParser`. Small models (esp. local ones behind an OpenAI-compatible endpoint) often
      // emit a call in a surface form the endpoint does not lift into `tool_calls` (`<call:name{…}`, a
      // ```json block, bare `name\nkey: value`), landing it in `content`. Pure parse — returns assembled
      // calls with `args` as the JSON STRING `executeAndPersistToolCall` expects (empty when disabled or
      // no match), so each call site can reflect them in the onRawGeneration tap and then execute. Fully
      // backward-compatible: absent option → `[]` → today's native-only behaviour.
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
        if (!response.body) {
          ctx.nack(new E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR(['response has no body']))
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const accumulator = resolvedHelpers.createChatCompletionsToolCallDeltaAccumulator()
        const streamId = dispatchStreamId

        let buffer = ''
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let stalled = false
        let partialMessageContent = ''
        let sawMessageDelta = false
        let doneSentinelSeen = false
        // `finish_reason` and `usage` (opted into via `stream_options.include_usage`) do not
        // necessarily arrive on the same chunk: OpenAI sends `finish_reason` on the last
        // content-bearing chunk, then a SEPARATE final chunk with an EMPTY `choices` array
        // carrying `usage`. Track each independently so neither is lost to the other's chunk.
        // `lastRawChunk` is kept alongside them (rather than deriving `raw` from just the two
        // extracted fields) so `raw` preserves whatever provider-native metadata the final chunk
        // actually carried (e.g. `id`, `system_fingerprint`) — matching the non-streaming path,
        // which spreads the full parsed response into `raw`.
        let lastFinishReason: string | null | undefined
        let lastUsage: Record<string, unknown> | undefined
        let lastModel: string | undefined
        // Merged (not overwritten) across every chunk that carried usage or a finish_reason, so
        // metadata split across the two chunks (e.g. `id` on the finish chunk, `system_fingerprint`
        // on the usage chunk) both survive into the final stats event's `raw`.
        let mergedRawStatsChunks: Record<string, unknown> = {}

        // Reasoning may stream under more than one provider-specific field at once. Accumulate each
        // field's text under its own live stream id; at completion we dedup by content to decide
        // whether to persist one Thought or one per divergent field. The first field to appear keeps
        // the bare `streamId` (the common single-field case); any others get a `:field` suffix.
        const thoughtAccum = new Map<ReasoningField, string>()
        let primaryThoughtField: ReasoningField | undefined
        const thoughtStreamId = (field: ReasoningField): string =>
          field === primaryThoughtField ? streamId : `${streamId}:${field}`

        const idleMs = merged.streamIdleTimeoutMs ?? 0
        const armIdleTimer = (): void => {
          if (idleMs <= 0) return
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            stalled = true
            helpers.log.warn({
              kind: 'stream-idle-timeout',
              message: `SSE stream went idle for ${idleMs}ms; cancelling`,
              payload: { idleMs },
            })
            reader.cancel().catch(() => {
              /* swallow */
            })
          }, idleMs)
        }
        const clearIdleTimer = (): void => {
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = undefined
          }
        }

        const drainAndPersist = async (): Promise<void> => {
          if (lastUsage !== undefined || lastFinishReason !== undefined) {
            helpers.reportGenerationStats(
              extractGenerationStats({
                model: lastModel ?? merged.model,
                usage: lastUsage,
                finishReason: lastFinishReason,
                raw:
                  Object.keys(mergedRawStatsChunks).length > 0
                    ? mergedRawStatsChunks
                    : { usage: lastUsage, finish_reason: lastFinishReason },
              })
            )
          }
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
          // Fallback recovery (opt-in): if the provider streamed no structured calls, try to parse one out
          // of the accumulated `content`. Consulted only when native calls are absent, so the provider
          // always wins.
          const calls =
            nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(partialMessageContent)

          // Raw-generation observability tap (FROM the provider) — streaming path. `rawText`/`cleanedText`
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
              doneSentinelSeen,
            },
          })
          if (calls.length === 0) {
            // No tool calls — terminal text answer. Only self-ack when opted in;
            // otherwise leave the context unsignalled so the implementor's output
            // pipeline owns turn completion (autoAck defaults to false).
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
          armIdleTimer()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            armIdleTimer()
            if (ctx.abortSignal.aborted) {
              clearIdleTimer()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            let sepIdx = buffer.indexOf('\n\n')
            while (sepIdx !== -1) {
              const frame = buffer.slice(0, sepIdx)
              buffer = buffer.slice(sepIdx + 2)
              for (const line of frame.split('\n')) {
                if (!line.startsWith('data:')) continue
                const data = line.slice(5).trim()
                if (data.length === 0) continue
                if (data === '[DONE]') {
                  doneSentinelSeen = true
                  clearIdleTimer()
                  await drainAndPersist()
                  return
                }
                let chunk: ChatCompletionsChunk
                try {
                  chunk = JSON.parse(data) as ChatCompletionsChunk
                } catch {
                  helpers.log.trace({
                    kind: 'sse-parse-failure',
                    message: 'Failed to parse SSE chunk as JSON; skipping',
                    payload: { dataPreview: data.slice(0, 256) },
                  })
                  continue
                }
                if (typeof chunk.model === 'string') lastModel = chunk.model
                // `usage` can be present-but-null on non-final chunks; only an object-valued usage
                // is real provider data — a bare undefined-check would let `null` mark usage as
                // "available" and produce a synthetic stats event with nothing in it.
                const chunkChoice = chunk.choices?.[0]
                const hasFinishReason = typeof chunkChoice?.finish_reason === 'string'
                const hasUsage = isObject(chunk.usage)
                if (hasUsage) lastUsage = chunk.usage
                if (hasFinishReason) lastFinishReason = chunkChoice.finish_reason
                if (hasUsage || hasFinishReason) {
                  mergedRawStatsChunks = {
                    ...mergedRawStatsChunks,
                    ...(chunk as unknown as Record<string, unknown>),
                  }
                }
                const delta = chunkChoice?.delta
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
                // `finish_reason`/`usage` are read from `lastChunk` at drain time, above.
              }
              sepIdx = buffer.indexOf('\n\n')
            }
          }
          clearIdleTimer()
          if (stalled) {
            ctx.nack(new E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED([idleMs]))
            return
          }
          if (!doneSentinelSeen) {
            // EOF without [DONE] — still drain and persist whatever we have.
            helpers.log.warn({
              kind: 'sse-eof-without-done',
              message: 'SSE stream ended without [DONE] sentinel; draining accumulated state',
            })
            await drainAndPersist()
          }
        } catch (err) {
          clearIdleTimer()
          if (ctx.abortSignal.aborted) return
          if (stalled) {
            ctx.nack(new E_OPENAI_CHAT_COMPLETIONS_STREAM_STALLED([idleMs]))
            return
          }
          helpers.log.error({
            kind: 'stream-error',
            message: `SSE stream failed: ${isError(err) ? err.message : String(err)}`,
            payload: { detail: isError(err) ? err.message : String(err) },
          })
          ctx.nack(
            new E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR([isError(err) ? err.message : String(err)])
          )
          return
        }
        return
      }

      // ── Step 9: non-streaming path ────────────────────────────────────────
      let parsed: ChatCompletionsResponse
      try {
        parsed = (await response.json()) as ChatCompletionsResponse
      } catch (err) {
        ctx.nack(
          new E_OPENAI_CHAT_COMPLETIONS_STREAM_ERROR([isError(err) ? err.message : String(err)])
        )
        return
      }
      const choice = parsed.choices?.[0]
      if (isObject(parsed.usage) || typeof choice?.finish_reason === 'string') {
        // Reported even when `choice` is absent below — a response can carry billed `usage`
        // with an empty `choices` array (e.g. a content-filtered completion), and that usage
        // must not be silently dropped just because there was no assistant choice to persist.
        helpers.reportGenerationStats(
          extractGenerationStats({
            model: parsed.model ?? merged.model,
            usage: isObject(parsed.usage) ? parsed.usage : undefined,
            finishReason: choice?.finish_reason,
            raw: { ...parsed } as unknown as Record<string, unknown>,
          })
        )
      }
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

      // Fallback recovery (opt-in): if the provider returned no structured calls, try to parse one out of
      // the assistant `content`. Consulted only when native calls are absent, so the provider always wins.
      const nativeCalls: AssembledToolCall[] = rawCalls.map((tc) => ({
        id: tc.id,
        type: tc.type ?? 'function',
        name: tc.function?.name ?? '',
        args: tc.function?.arguments ?? '',
      }))
      const calls = nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(content)

      // Raw-generation observability tap (FROM the provider). Unlike the on-device batteries the provider
      // returns structured content + tool_calls, so `rawText`/`cleanedText` are the returned assistant
      // content and `toolCalls` are the calls this dispatch will act on (native, or fallback-recovered —
      // args JSON-parsed best-effort). Fired once per terminal generation; observer errors swallowed.
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
        if (merged.autoAck) ctx.ack()
        return
      }
      for (const call of calls) {
        if (ctx.abortSignal.aborted) return
        await executeAndPersistToolCall(call)
      }
      // Tool calls produced — do NOT ack; the runner will iterate again.
    }
  }

  /**
   * Returns `true` when `value` is an {@link OpenAIChatCompletionsAdapter} instance.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an `OpenAIChatCompletionsAdapter` instance.
   */
  public static isOpenAIChatCompletionsAdapter(
    value: unknown
  ): value is OpenAIChatCompletionsAdapter {
    return isInstanceOf(value, 'OpenAIChatCompletionsAdapter', OpenAIChatCompletionsAdapter)
  }
}
