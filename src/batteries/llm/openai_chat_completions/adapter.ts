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
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  computeBackoff,
  sleepWithJitter,
  parseRetryAfter,
  linkAbortSignals,
} from '../../../lib/utils/retry'
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
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
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
        const t = mergedRegistry.get(name) as { ephemeral?: boolean } | undefined
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
      const toolsArr = mergedRegistry.visible()
      if (toolsArr.length > 0) {
        body.tools = resolvedHelpers.toolsToChatCompletionsTools(toolsArr, {
          descriptionToChatCompletionsJsonSchema:
            resolvedHelpers.descriptionToChatCompletionsJsonSchema,
        })
      }
      if (reasoningPayloads.length > 0) {
        body._adk_reasoning_payloads = reasoningPayloads
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
          // Generic transport failure — surface as HTTP_ERROR with status 0.
          helpers.log.error({
            kind: 'transport-error',
            message: `Transport failure on attempt ${attempt}/${maxAttempts}: ${isError(err) ? err.message : String(err)}`,
            payload: {
              attempt,
              maxAttempts,
              detail: isError(err) ? err.message : String(err),
            },
          })
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
        const tool = mergedRegistry.get(call.name)
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
          // List the tools that DO exist so the model can self-correct on the next iteration
          // instead of guessing. Without this, a single typo'd / hallucinated tool name yields
          // a dead-end "not found" with no path forward.
          const available = mergedRegistry
            .all()
            .map((t) => t.name)
            .sort()
          const errText =
            available.length > 0
              ? `Tool not found: ${call.name}. Available tools: ${available.join(', ')}.`
              : `Tool not found: ${call.name}. No tools are available this turn.`
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
        const streamId = uuidv6()

        let buffer = ''
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let stalled = false
        let partialMessageContent = ''
        let sawMessageDelta = false
        let doneSentinelSeen = false

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
          const calls = accumulator.drain()
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
                // finish_reason emitted before [DONE] — no special action required; the [DONE]
                // sentinel is the canonical terminator.
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
