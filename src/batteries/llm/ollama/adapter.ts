/**
 * Cross-environment executor adapter for the native Ollama `/api/chat` endpoint.
 *
 * @module @nhtio/adk/batteries/llm/ollama/adapter
 *
 * @remarks
 * Native Ollama LLM adapter targeting `/api/chat` (NOT the OpenAI-compat `/v1` layer — the
 * `openai_chat_completions` battery already covers `/v1`). Works against both LOCAL Ollama
 * (`http://localhost:11434`, no auth) and CLOUD Ollama (`https://ollama.com`, `Authorization:
 * Bearer <apiKey>`); the only difference is `baseURL` + the auth header. Native is HTTP-only — a
 * Unix-socket deployment is reached via a custom `fetch` or an external bridge, not an adapter
 * option.
 *
 * Structurally a sibling of the OpenAI Chat Completions adapter, with the native-wire divergences:
 *
 * - Request body: generation params are NESTED under `options`; `think` / `format` / `keep_alive`
 *   are top-level native controls; ADK control fields are stripped before sending.
 * - Streaming: NDJSON (newline-delimited JSON objects), terminated in-band by `done: true` — there
 *   is no SSE `data:` framing and no `[DONE]` sentinel. Whole `tool_calls` arrive per chunk (no
 *   delta accumulation).
 * - Reasoning: the single native `message.thinking` field (no multi-field precedence dance).
 * - Tool calls: `arguments` is already a JSON OBJECT (no `JSON.parse`); native calls carry no `id`,
 *   so the adapter synthesizes one (uuidv6) for correlation / checksum / spool keying. Tool-result
 *   history messages use `tool_name` (the originating tool), not `tool_call_id`.
 * - Generation stats: the terminal `done: true` object's token counts + nanosecond durations +
 *   `done_reason` are surfaced via `helpers.reportGenerationStats`.
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
  E_INVALID_OLLAMA_OPTIONS,
  E_OLLAMA_CONTEXT_OVERFLOW,
  E_OLLAMA_HTTP_ERROR,
  E_OLLAMA_STREAM_ERROR,
  E_OLLAMA_STREAM_STALLED,
  E_OLLAMA_REQUEST_TIMEOUT,
  E_OLLAMA_INVALID_TOOL_CALL_ARGS,
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
  defaultRenderThought,
  defaultFilterThoughts,
  defaultToolsToChatCompletionsTools,
  defaultRenderChatCompletionsSystemPrompt,
  defaultRenderOllamaTimelineMessage,
  defaultRenderOllamaToolCallResult,
  defaultBuildOllamaHistory,
  ollamaToolsFromTools,
} from './helpers'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Tool, Memory, TokenEncoding } from '@nhtio/adk/common'
import type {
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  GenerationStats,
} from '@nhtio/adk/dispatch_runner'
import type {
  OllamaAdapterOptions,
  OllamaHelpers,
  OllamaChatRequestBody,
  OllamaChatStreamChunk,
  OllamaChatResponse,
  OllamaToolCall,
  OllamaRuntimeOptions,
} from './types'

// ─── An assembled native tool call (id synthesized; args already an object) ───
// NOTE: unlike the OpenAI adapter, the request body is assembled EXPLICITLY (model / messages /
// stream / think / format / keep_alive / options / tools) rather than by spreading non-control
// keys, because native generation params live nested under `options`, not at the top level. So
// there is no ADK_CONTROL_KEYS strip-set here.

interface AssembledOllamaToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// ─── Option merging ───────────────────────────────────────────────────────────

const mergeRecord = <T extends Record<string, unknown>>(
  layers: ReadonlyArray<T | undefined>
): T | undefined => {
  let merged: T | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? ({} as T)), ...layer }
  }
  return merged
}

const mergeOptions = (
  baseline: OllamaAdapterOptions,
  exec: Partial<OllamaAdapterOptions> | undefined,
  stash: Partial<OllamaAdapterOptions> | undefined
): Partial<OllamaAdapterOptions> => {
  const layers = [baseline as Partial<OllamaAdapterOptions>, exec ?? {}, stash ?? {}]
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (k === 'headers' || k === 'helpers' || k === 'retry' || k === 'options') continue
      out[k] = v
    }
  }
  const headers = mergeRecord(layers.map((l) => l.headers as Record<string, string> | undefined))
  if (headers !== undefined) out.headers = headers
  const helpers = mergeRecord(layers.map((l) => l.helpers as Record<string, unknown> | undefined))
  if (helpers !== undefined) out.helpers = helpers
  const retry = mergeRecord(layers.map((l) => l.retry as Record<string, unknown> | undefined))
  if (retry !== undefined) out.retry = retry
  // Nested runtime `options` merge key-by-key, like headers — a stash override that sets one
  // sampling param should not clear the others set in the constructor.
  const runtime = mergeRecord(layers.map((l) => l.options as Record<string, unknown> | undefined))
  if (runtime !== undefined) out.options = runtime
  return out as Partial<OllamaAdapterOptions>
}

// ─── Helper resolution ────────────────────────────────────────────────────────

const resolveHelpers = (overrides: Partial<OllamaHelpers> | undefined): OllamaHelpers => {
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
    renderThought: src.renderThought ?? defaultRenderThought,
    filterThoughts: src.filterThoughts ?? defaultFilterThoughts,
    toolsToChatCompletionsTools:
      src.toolsToChatCompletionsTools ?? defaultToolsToChatCompletionsTools,
    renderChatCompletionsSystemPrompt:
      src.renderChatCompletionsSystemPrompt ?? defaultRenderChatCompletionsSystemPrompt,
    renderOllamaTimelineMessage:
      src.renderOllamaTimelineMessage ?? defaultRenderOllamaTimelineMessage,
    renderOllamaToolCallResult: src.renderOllamaToolCallResult ?? defaultRenderOllamaToolCallResult,
    buildOllamaHistory: src.buildOllamaHistory ?? defaultBuildOllamaHistory,
  }
}

// ─── ID / checksum / time helpers ─────────────────────────────────────────────

const computeChecksum = (tool: string, args: unknown): string =>
  sha256(canonicalStringify({ tool, args }))

const nowIso = (): string => DateTime.now().toISO() ?? new Date().toISOString()

const estimateTokensOf = async (
  value: { estimateTokens: (encoding: TokenEncoding) => number | Promise<number> },
  encoding: TokenEncoding
): Promise<number> => Promise.resolve(value.estimateTokens(encoding))

// ─── Generation-stats extraction ──────────────────────────────────────────────

const extractGenerationStats = (
  src: OllamaChatStreamChunk | OllamaChatResponse,
  model: string
): GenerationStats => {
  const stats: GenerationStats = { provider: 'ollama', model: src.model ?? model, raw: { ...src } }
  if (typeof src.prompt_eval_count === 'number') stats.promptTokens = src.prompt_eval_count
  if (typeof src.eval_count === 'number') stats.completionTokens = src.eval_count
  if (typeof src.prompt_eval_count === 'number' && typeof src.eval_count === 'number') {
    stats.totalTokens = src.prompt_eval_count + src.eval_count
  }
  if (typeof src.total_duration === 'number') stats.totalDurationNs = src.total_duration
  if (typeof src.load_duration === 'number') stats.loadDurationNs = src.load_duration
  if (typeof src.prompt_eval_duration === 'number') {
    stats.promptEvalDurationNs = src.prompt_eval_duration
  }
  if (typeof src.eval_duration === 'number') stats.evalDurationNs = src.eval_duration
  if (typeof src.done_reason === 'string') stats.finishReason = src.done_reason
  return stats
}

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Opinionated cross-environment LLM adapter for the native Ollama `/api/chat` wire shape.
 *
 * @remarks
 * Construction validates options eagerly via {@link validateOptions} and throws
 * {@link @nhtio/adk/batteries/llm/ollama!E_INVALID_OLLAMA_OPTIONS} on failure. The returned instance is reusable: call
 * {@link OllamaAdapter.executor} once per `DispatchRunner` configuration to obtain a
 * {@link @nhtio/adk!DispatchExecutorFn} bound to the baseline plus optional executor-scope
 * overrides. Per-iteration overrides live on `ctx.stash.ollama` and take highest precedence;
 * `headers`, `helpers`, `retry`, and the nested runtime `options` merge key-by-key across all three
 * layers, every other field is replaced wholesale at the highest layer that sets it.
 */
export class OllamaAdapter {
  /** Customary key for per-iteration overrides on `ctx.stash`. */
  public static readonly STASH_KEY = 'ollama' as const

  readonly #baseline: OllamaAdapterOptions

  /**
   * @param options - Constructor-baseline options. Re-validated on every iteration after
   *   per-dispatch and per-iteration overrides are layered in.
   * @throws {@link @nhtio/adk/batteries/llm/ollama!E_INVALID_OLLAMA_OPTIONS} when `options` does not satisfy `ollamaOptionsSchema`.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
  }

  /**
   * Returns a {@link @nhtio/adk!DispatchExecutorFn} bound to this adapter's baseline plus optional
   * executor-scope overrides.
   *
   * @param overrides - Optional executor-scope overrides. Higher precedence than the baseline,
   *   lower precedence than `ctx.stash[STASH_KEY]`.
   */
  executor(overrides?: Partial<OllamaAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = OllamaAdapter
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      const localWarn = (msg: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message: msg })
      }

      // ── Step 1: merge & validate ──────────────────────────────────────────
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object' ? (stashRaw as Partial<OllamaAdapterOptions>) : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))

      // Cross-field invariant: tokenEncoding non-null requires contextWindow.
      if (merged.tokenEncoding !== null && merged.contextWindow === undefined) {
        throw new E_INVALID_OLLAMA_OPTIONS([
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
      // Key by primitive identity: duplicate ids must not cross-wire pre-rendered results.
      const renderedToolCallResults = new Map<ToolCall, string>()
      for (const tc of ctx.turnToolCalls) {
        const rendered = await resolvedHelpers.renderOllamaToolCallResult({
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
          tlTokens += await estimateTokensOf(new Tokenizable(rendered), encoding)
        }
        // Tool DECLARATIONS: Ollama renders the `tools` array through the MODEL'S OWN Go chat template
        // (the `.Tools` template variable), which is per-model and lives SERVER-side — there is no single
        // fixed conversion to reproduce client-side (seeing the exact string needs `ollama show` / debug
        // logs; evaluating the model's Go template via /api/show is deliberately out of scope for a guard
        // backstop). Tally the serialized wire `tools` JSON as an honest FLOOR. Without this the guard
        // undercounts a tool-heavy prompt by the entire declaration block.
        let toolTokens = 0
        const visibleTools = ctx.tools.visible()
        if (visibleTools.length > 0) {
          const toolsJson = JSON.stringify(
            ollamaToolsFromTools(visibleTools, {
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
          payload: { total, limit: merged.contextWindow, encoding, perBucket: perBucketObj },
        })
        if (total > merged.contextWindow) {
          throw new E_OLLAMA_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            encoding,
            JSON.stringify(perBucketObj),
          ])
        }
      }

      // ── Step 6: build request body ────────────────────────────────────────
      const { messages: wireMessages, reasoningPayloads } =
        await resolvedHelpers.buildOllamaHistory({
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
          renderOllamaToolCallResult: resolvedHelpers.renderOllamaToolCallResult,
          renderChatCompletionsSystemPrompt: resolvedHelpers.renderChatCompletionsSystemPrompt,
          renderStandingInstructions: resolvedHelpers.renderStandingInstructions,
          renderMemories: resolvedHelpers.renderMemories,
          renderRetrievables: resolvedHelpers.renderRetrievables,
          renderRetrievableHandleBody: resolvedHelpers.renderRetrievableHandleBody,
          renderRetrievableSafetyDirective: resolvedHelpers.renderRetrievableSafetyDirective,
          renderFirstPartyRetrievables: resolvedHelpers.renderFirstPartyRetrievables,
          renderThirdPartyPublicRetrievables: resolvedHelpers.renderThirdPartyPublicRetrievables,
          renderThirdPartyPrivateRetrievables: resolvedHelpers.renderThirdPartyPrivateRetrievables,
          renderOllamaTimelineMessage: resolvedHelpers.renderOllamaTimelineMessage,
          renderThought: resolvedHelpers.renderThought,
          filterThoughts: resolvedHelpers.filterThoughts,
          renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
          renderTrustedContent: resolvedHelpers.renderTrustedContent,
          unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
          warn: localWarn,
        })

      const stream = merged.stream ?? true
      const body: OllamaChatRequestBody = {
        model: merged.model,
        messages: wireMessages,
        stream,
      }
      // Native top-level controls — included only when defined. `think` is conditional-presence:
      // omitted → absent; `false` → think:false; truthy/effort → verbatim.
      if (merged.think !== undefined) body.think = merged.think
      if (merged.format !== undefined) body.format = merged.format
      if (merged.keep_alive !== undefined) body.keep_alive = merged.keep_alive
      if (merged.options !== undefined) body.options = merged.options as OllamaRuntimeOptions
      const toolsArr = ctx.tools.visible()
      if (toolsArr.length > 0) {
        body.tools = ollamaToolsFromTools(toolsArr, {
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

      // Prompt-assembled observability tap: the EXACT request body going TO Ollama, the instant it is built
      // and BEFORE the POST. Mirror of onRawGeneration. Handed back AS-IS — no redaction — and swallow
      // observer errors so it can never corrupt the generation path.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'ollama',
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
      const rawBase = merged.baseURL ?? 'http://localhost:11434'
      const baseURL = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase
      const url = `${baseURL}/api/chat`

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (stream) headers['Accept'] = 'application/x-ndjson'
      if (merged.apiKey) headers['Authorization'] = `Bearer ${merged.apiKey}`
      if (merged.headers) Object.assign(headers, merged.headers)

      const retryCfg = {
        maxAttempts: merged.retry?.maxAttempts ?? 1,
        baseDelayMs: merged.retry?.baseDelayMs ?? 500,
        maxDelayMs: merged.retry?.maxDelayMs ?? 30_000,
        retriableStatuses: merged.retry?.retriableStatuses ?? [429, 502, 503, 504],
        honorRetryAfter: merged.retry?.honorRetryAfter ?? true,
      }

      const fetchFn = merged.fetch ?? globalThis.fetch
      const maxAttempts = retryCfg.maxAttempts

      let response: Response | undefined
      let attempt = 1
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
            helpers.log.warn({
              kind: 'request-timeout',
              message: `Request timed out after ${requestTimeoutMs}ms on attempt ${attempt}/${maxAttempts}`,
              payload: { requestTimeoutMs, attempt, maxAttempts },
            })
            if (attempt < maxAttempts) {
              const delay = computeBackoff(attempt, retryCfg)
              await sleepWithJitter(delay, ctx.abortSignal)
              attempt += 1
              continue
            }
            ctx.nack(new E_OLLAMA_REQUEST_TIMEOUT([requestTimeoutMs]))
            return
          }
          helpers.log.error({
            kind: 'transport-error',
            message: `Transport failure on attempt ${attempt}/${maxAttempts}: ${isError(err) ? err.message : String(err)}`,
            payload: { attempt, maxAttempts, detail: isError(err) ? err.message : String(err) },
          })
          ctx.nack(new E_OLLAMA_HTTP_ERROR([0, isError(err) ? err.message : String(err)]))
          return
        }

        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

        if (!response.ok) {
          const status = response.status
          const retriable = retryCfg.retriableStatuses.includes(status)
          if (retriable && attempt < maxAttempts) {
            let delay = computeBackoff(attempt, retryCfg)
            if (retryCfg.honorRetryAfter !== false) {
              const ra = response.headers.get('Retry-After')
              if (ra) {
                const raMs = parseRetryAfter(ra)
                if (raMs > 0) delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs)
              }
            }
            helpers.log.warn({
              kind: 'retry-attempt',
              message: `HTTP ${status} on attempt ${attempt}/${maxAttempts}; retrying in ~${delay}ms`,
              payload: {
                reason: 'http-status',
                status,
                delayMs: delay,
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
            payload: { status, body: errBody, attempt, maxAttempts, retriable },
          })
          ctx.nack(new E_OLLAMA_HTTP_ERROR([status, errBody]))
          return
        }

        break
      }

      if (!response) return

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      const selfIdentity = merged.selfIdentity ?? 'assistant'

      // ── Inner helper: persist + execute one assembled tool call ───────────
      const executeAndPersistToolCall = async (call: AssembledOllamaToolCall): Promise<void> => {
        // Resolve the provider id once at ingress so reporting, persistence, and spooling agree.
        const callId = merged.toolCallIdFilter?.(call.id, ctx) ?? call.id
        const tool = ctx.tools.get(call.name)
        // Native /api/chat delivers `arguments` already parsed as an object. Validate it IS an
        // object (defensive against a non-conformant server/proxy emitting an array/null/primitive)
        // — there is no JSON.parse step. A non-object short-circuits to a persisted error ToolCall.
        let args: Record<string, unknown> = {}
        let parseError: InstanceType<typeof E_OLLAMA_INVALID_TOOL_CALL_ARGS> | undefined
        if (isObject(call.args)) {
          args = call.args
        } else {
          const receivedKind = Array.isArray(call.args)
            ? 'array'
            : call.args === null
              ? 'null'
              : typeof call.args
          parseError = new E_OLLAMA_INVALID_TOOL_CALL_ARGS([
            `must be a JSON object; received ${receivedKind}`,
            JSON.stringify(call.args),
          ])
        }
        const completedAt = nowIso()
        if (parseError !== undefined) {
          const toolName = normalizeToolName(call.name)
          const results = new Tokenizable(parseError.message)
          helpers.reportToolCall(callId, { tool: toolName, args })
          helpers.reportToolCall(callId, { results, isError: true, isComplete: true })
          await ctx.storeToolCall(
            new ToolCall({
              id: callId,
              tool: toolName,
              args,
              checksum: computeChecksum(toolName, args),
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
          helpers.reportToolCall(callId, { tool: toolName, args })
          helpers.reportToolCall(callId, { results, isError: true, isComplete: true })
          await ctx.storeToolCall(
            new ToolCall({
              id: callId,
              tool: toolName,
              args,
              checksum: computeChecksum(toolName, args),
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
            const reader = await spoolStore.write(callId, String(raw))
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          }
        } catch (err) {
          toolHadError = true
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
        helpers.reportToolCall(callId, { results, isError: toolHadError, isComplete: true })
        const completedAt2 = nowIso()
        await ctx.storeToolCall(
          new ToolCall({
            id: callId,
            tool: tool.name,
            args,
            checksum: computeChecksum(tool.name, args),
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

      // FALLBACK tool-call recovery. Native /api/chat tool-calling is authoritative; this is consulted
      // ONLY when the provider returned zero structured calls AND the caller opted in via
      // `localToolCallParser`. Small models routinely emit a call in a surface form the server template
      // misses (`<call:name{…}`, a ```json block, bare `name\nkey: value`), landing it in `content` with
      // empty `tool_calls`. Pure parse — returns the assembled calls (empty when disabled or no match) so
      // each call site can reflect them in the onRawGeneration tap and then execute. Fully
      // backward-compatible: absent option → `[]` → today's native-only behaviour.
      const parseFallbackToolCalls = (content: string): AssembledOllamaToolCall[] => {
        if (merged.localToolCallParser === undefined) return []
        if (typeof content !== 'string' || content.length === 0) return []
        const parser = resolveToolCallParser(merged.localToolCallParser)
        const toolNames = ctx.tools.visible().map((t) => t.name)
        return parser(content, { toolNames }).calls.map((c) => ({
          id: uuidv6(),
          name: c.name,
          args: c.arguments as Record<string, unknown>,
        }))
      }

      // ── Step 8: streaming path (NDJSON) ───────────────────────────────────
      if (stream) {
        if (!response.body) {
          ctx.nack(new E_OLLAMA_STREAM_ERROR(['response has no body']))
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const streamId = dispatchStreamId

        let buffer = ''
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let stalled = false
        let partialMessageContent = ''
        let sawMessageDelta = false
        let partialThinking = ''
        let sawThinking = false
        let doneSeen = false
        const collectedToolCalls: AssembledOllamaToolCall[] = []
        const thoughtStreamId = `${streamId}:thought`

        const idleMs = merged.streamIdleTimeoutMs ?? 0
        const armIdleTimer = (): void => {
          if (idleMs <= 0) return
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            stalled = true
            helpers.log.warn({
              kind: 'stream-idle-timeout',
              message: `NDJSON stream went idle for ${idleMs}ms; cancelling`,
              payload: { idleMs },
            })
            reader.cancel().catch(() => {})
          }, idleMs)
        }
        const clearIdleTimer = (): void => {
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = undefined
          }
        }

        const drainAndPersist = async (
          statsSrc: OllamaChatStreamChunk | undefined
        ): Promise<void> => {
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
          if (sawThinking) {
            helpers.reportThought(thoughtStreamId, '', { isComplete: true })
            await ctx.storeThought(
              new Thought({
                id: thoughtStreamId,
                content: partialThinking,
                identity: selfIdentity,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              })
            )
          }
          if (statsSrc !== undefined) {
            helpers.reportGenerationStats(extractGenerationStats(statsSrc, merged.model))
          }

          // Fallback recovery (opt-in): if the server returned no structured calls, try to parse one out
          // of the accumulated `content`. Consulted only when native calls are absent, so the provider
          // always wins.
          const fallbackCalls =
            collectedToolCalls.length === 0 ? parseFallbackToolCalls(partialMessageContent) : []
          const effectiveCalls = collectedToolCalls.length > 0 ? collectedToolCalls : fallbackCalls

          // Raw-generation observability tap (FROM Ollama) — streaming path. `rawText`/`cleanedText` are
          // the accumulated assistant content; `toolCalls` are the calls this dispatch will act on
          // (native, or fallback-recovered — args already an object). Fired once at stream drain;
          // observer errors swallowed.
          if (merged.onRawGeneration) {
            try {
              merged.onRawGeneration({
                rawText: partialMessageContent,
                cleanedText: partialMessageContent,
                reasoning: sawThinking ? [partialThinking] : [],
                toolCalls: effectiveCalls.map((c) => ({
                  name: c.name,
                  arguments: c.args as never,
                })),
                streamed: true,
                streamId: dispatchStreamId,
              })
            } catch {
              /* observer errors are non-fatal */
            }
          }

          if (effectiveCalls.length === 0) {
            if (merged.autoAck) ctx.ack()
            return
          }
          for (const call of effectiveCalls) {
            if (ctx.abortSignal.aborted) return
            await executeAndPersistToolCall(call)
          }
        }

        const handleChunk = (chunk: OllamaChatStreamChunk): void => {
          const m = chunk.message
          if (m) {
            if (typeof m.content === 'string' && m.content.length > 0) {
              sawMessageDelta = true
              partialMessageContent += m.content
              helpers.reportMessage(streamId, m.content)
            }
            if (typeof m.thinking === 'string' && m.thinking.length > 0) {
              sawThinking = true
              partialThinking += m.thinking
              helpers.reportThought(thoughtStreamId, m.thinking)
            }
            if (Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) {
                collectedToolCalls.push({
                  id: uuidv6(),
                  name: tc.function?.name ?? '',
                  args: (tc.function?.arguments ?? {}) as Record<string, unknown>,
                })
              }
            }
          }
        }

        const parseLine = (line: string): OllamaChatStreamChunk | undefined => {
          const trimmed = line.trim()
          if (trimmed.length === 0) return undefined
          try {
            return JSON.parse(trimmed) as OllamaChatStreamChunk
          } catch {
            helpers.log.trace({
              kind: 'ndjson-parse-failure',
              message: 'Failed to parse NDJSON line as JSON; skipping',
              payload: { linePreview: trimmed.slice(0, 256) },
            })
            return undefined
          }
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
            let nl = buffer.indexOf('\n')
            while (nl !== -1) {
              const line = buffer.slice(0, nl)
              buffer = buffer.slice(nl + 1)
              const chunk = parseLine(line)
              if (chunk !== undefined) {
                handleChunk(chunk)
                if (chunk.done === true) {
                  doneSeen = true
                  clearIdleTimer()
                  await drainAndPersist(chunk)
                  return
                }
              }
              nl = buffer.indexOf('\n')
            }
          }
          clearIdleTimer()
          if (stalled) {
            ctx.nack(new E_OLLAMA_STREAM_STALLED([idleMs]))
            return
          }
          // Flush any residual non-newline-terminated final line.
          if (!doneSeen && buffer.trim().length > 0) {
            const chunk = parseLine(buffer)
            buffer = ''
            if (chunk !== undefined) {
              handleChunk(chunk)
              if (chunk.done === true) {
                await drainAndPersist(chunk)
                return
              }
            }
          }
          if (!doneSeen) {
            helpers.log.warn({
              kind: 'ndjson-eof-without-done',
              message: 'NDJSON stream ended without a done:true chunk; draining accumulated state',
            })
            await drainAndPersist(undefined)
          }
        } catch (err) {
          clearIdleTimer()
          if (ctx.abortSignal.aborted) return
          if (stalled) {
            ctx.nack(new E_OLLAMA_STREAM_STALLED([idleMs]))
            return
          }
          helpers.log.error({
            kind: 'stream-error',
            message: `NDJSON stream failed: ${isError(err) ? err.message : String(err)}`,
            payload: { detail: isError(err) ? err.message : String(err) },
          })
          ctx.nack(new E_OLLAMA_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }
        return
      }

      // ── Step 9: non-streaming path ────────────────────────────────────────
      let parsed: OllamaChatResponse
      try {
        parsed = (await response.json()) as OllamaChatResponse
      } catch (err) {
        ctx.nack(new E_OLLAMA_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }
      const responseId = uuidv6()
      const msg = parsed.message

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
      if (msg && typeof msg.thinking === 'string' && msg.thinking.length > 0) {
        const thoughtId = `${responseId}:thought`
        helpers.reportThought(thoughtId, msg.thinking, { isComplete: true })
        await ctx.storeThought(
          new Thought({
            id: thoughtId,
            content: msg.thinking,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }

      helpers.reportGenerationStats(extractGenerationStats(parsed, merged.model))

      const rawCalls: OllamaToolCall[] = msg?.tool_calls ?? []
      const content = typeof msg?.content === 'string' ? msg.content : ''

      // Fallback recovery (opt-in): if the server returned no structured calls, try to parse one out of
      // the assistant `content`. Consulted only when native calls are absent, so the provider always wins.
      const nativeCalls: AssembledOllamaToolCall[] = rawCalls.map((tc) => ({
        id: uuidv6(),
        name: tc.function?.name ?? '',
        args: (tc.function?.arguments ?? {}) as Record<string, unknown>,
      }))
      const calls = nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(content)

      // Raw-generation observability tap (FROM Ollama) — non-streaming path. `rawText`/`cleanedText` are
      // the returned assistant content; `toolCalls` are the calls this dispatch will act on (native, or
      // fallback-recovered — args already an object). Fired once per terminal generation; observer errors
      // swallowed.
      if (merged.onRawGeneration) {
        try {
          merged.onRawGeneration({
            rawText: content,
            cleanedText: content,
            reasoning:
              typeof msg?.thinking === 'string' && msg.thinking.length > 0 ? [msg.thinking] : [],
            toolCalls: calls.map((c) => ({
              name: c.name,
              arguments: c.args as never,
            })),
            streamed: false,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

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

  /**
   * Returns `true` when `value` is an {@link OllamaAdapter} instance.
   */
  public static isOllamaAdapter(value: unknown): value is OllamaAdapter {
    return isInstanceOf(value, 'OllamaAdapter', OllamaAdapter)
  }
}
