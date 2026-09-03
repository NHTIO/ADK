/**
 * Cross-environment executor adapter for Google's native Gemini `generateContent` endpoint.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content/adapter
 *
 * @remarks
 * Targets `POST {baseURL}/models/{model}:generateContent` (and `:streamGenerateContent` when
 * `stream` is set) — Gemini's OWN wire format, not an OpenAI-compatible façade in front of it.
 *
 * That distinction is the reason this battery exists. Pointing `openai_chat_completions` at a
 * Gemini-compatible gateway means some translator, not the ADK, decides how your primitives become
 * `contents[]` — including whether a `thoughtSignature` is stamped, whether consecutive same-role
 * turns get merged, and how a tool result is correlated to its call. For ordinary use that is fine.
 * For anything that needs to reason about what the VENDOR actually received — an ordering guard, a
 * wire-shape audit, a bug report against Google — the translation has to be ours and observable.
 * See the validation battery's "Which API surface a rule applies to" guide.
 *
 * Options layer exactly as the other batteries: constructor baseline → `executor()` overrides →
 * per-iteration `ctx.stash.geminiGenerateContent`, re-validated each iteration.
 */

import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { validateOptions } from './validation'
import { normalizeToolName } from '../chat_common/helpers'
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { ArtifactTool, Media, Message, Thought, Tokenizable, ToolCall } from '@nhtio/adk/common'
import {
  E_GEMINI_INVALID_TOOL_CALL_ARGS,
  E_GEMINI_MISSING_THOUGHT_SIGNATURE,
  E_GEMINI_REQUEST_FAILED,
  E_GEMINI_STREAM_ERROR,
} from './exceptions'
import {
  DEFAULT_GEMINI_BUCKET_ORDER,
  buildGeminiRequest,
  extractGeminiGeneration,
  mediaToGeminiInlineData,
  renderGeminiToolResult,
  toolsToGeminiTools,
} from './helpers'
import {
  descriptionToChatCompletionsJsonSchema,
  filterThoughts,
  renderChatCompletionsSystemPrompt,
  renderFirstPartyRetrievables,
  renderMemories,
  renderRetrievableSafetyDirective,
  renderRetrievables,
  renderStandingInstructions,
  renderThirdPartyPrivateRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThought,
  renderTrustedContent,
  renderUntrustedContent,
} from '../chat_common/helpers'
import type { DispatchContext } from '@nhtio/adk/types'
import type { SpooledArtifact, Tool } from '@nhtio/adk/common'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/types'
import type {
  GeminiGenerateContentAdapterOptions,
  GeminiGenerateContentHelpers,
  GeminiGenerateContentResponse,
} from './types'

const nowIso = (): string => DateTime.now().toISO() ?? new Date().toISOString()

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
/**
 * Google's documented portable sentinel for replaying tool history that did not originate from a
 * Gemini reasoning session. See the option's TSDoc for why this is the default.
 */
const DEFAULT_SENTINEL = 'skip_thought_signature_validator'

const computeChecksum = (tool: string, args: Record<string, unknown>): string =>
  sha256(`${tool}:${canonicalStringify(args)}`)

/** Merge the three option layers, later winning. */
const mergeOptions = (
  ...layers: Array<Partial<GeminiGenerateContentAdapterOptions> | undefined>
): Partial<GeminiGenerateContentAdapterOptions> => {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) out[k] = v
  }
  return out as Partial<GeminiGenerateContentAdapterOptions>
}

/** Fill every injectable helper, preferring the caller's override. */
const resolveHelpers = (
  overrides: Partial<GeminiGenerateContentHelpers> | undefined
): GeminiGenerateContentHelpers => {
  const src = (overrides ?? {}) as Record<string, unknown>
  const pick = <T>(key: string, fallback: T): T => (src[key] as T | undefined) ?? fallback
  return {
    descriptionToChatCompletionsJsonSchema: pick(
      'descriptionToChatCompletionsJsonSchema',
      descriptionToChatCompletionsJsonSchema
    ),
    renderUntrustedContent: pick('renderUntrustedContent', renderUntrustedContent),
    renderTrustedContent: pick('renderTrustedContent', renderTrustedContent),
    renderStandingInstructions: pick('renderStandingInstructions', renderStandingInstructions),
    renderMemories: pick('renderMemories', renderMemories),
    renderRetrievables: pick('renderRetrievables', renderRetrievables),
    renderRetrievableSafetyDirective: pick(
      'renderRetrievableSafetyDirective',
      renderRetrievableSafetyDirective
    ),
    renderFirstPartyRetrievables: pick(
      'renderFirstPartyRetrievables',
      renderFirstPartyRetrievables
    ),
    renderThirdPartyPublicRetrievables: pick(
      'renderThirdPartyPublicRetrievables',
      renderThirdPartyPublicRetrievables
    ),
    renderThirdPartyPrivateRetrievables: pick(
      'renderThirdPartyPrivateRetrievables',
      renderThirdPartyPrivateRetrievables
    ),
    renderThought: pick('renderThought', renderThought),
    filterThoughts: pick('filterThoughts', filterThoughts),
    renderChatCompletionsSystemPrompt: pick(
      'renderChatCompletionsSystemPrompt',
      renderChatCompletionsSystemPrompt
    ),
    toolsToGeminiTools: pick('toolsToGeminiTools', toolsToGeminiTools),
    renderGeminiToolResult: pick('renderGeminiToolResult', renderGeminiToolResult),
    buildGeminiRequest: pick('buildGeminiRequest', buildGeminiRequest),
  } as GeminiGenerateContentHelpers
}

/**
 * Native Gemini `generateContent` executor adapter.
 *
 * @example
 * ```ts
 * const adapter = new GeminiGenerateContentAdapter({
 *   model: 'gemini-2.5-flash-lite',
 *   apiKey: process.env.GEMINI_API_KEY,
 * })
 * const runner = new TurnRunner({ executorCallback: adapter.executor(), ... })
 * ```
 */
export class GeminiGenerateContentAdapter {
  /** Per-iteration override key on `ctx.stash`. */
  public static readonly STASH_KEY = 'geminiGenerateContent' as const

  readonly #baseline: GeminiGenerateContentAdapterOptions

  /**
   * @param options - Constructor-baseline options, re-validated每 iteration after overrides merge.
   * @throws {@link E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS} when `options` is invalid.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
  }

  /** Narrowing guard for cross-realm instances. */
  public static isGeminiGenerateContentAdapter(
    value: unknown
  ): value is GeminiGenerateContentAdapter {
    return isInstanceOf(value, 'GeminiGenerateContentAdapter', GeminiGenerateContentAdapter)
  }

  /**
   * Build a {@link DispatchExecutorFn} bound to the baseline plus optional executor-scope overrides.
   *
   * @param overrides - Higher precedence than the baseline, lower than `ctx.stash`.
   */
  executor(overrides?: Partial<GeminiGenerateContentAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = GeminiGenerateContentAdapter
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      const warn = (message: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message })
      }

      // ── merge & validate ────────────────────────────────────────────────
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides = isObject(stashRaw)
        ? (stashRaw as Partial<GeminiGenerateContentAdapterOptions>)
        : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))
      const resolved = resolveHelpers(merged.helpers)
      const selfIdentity = 'assistant'
      const dispatchStreamId = uuidv6()

      // ── pre-render tool results ─────────────────────────────────────────
      // Gemini wants an OBJECT in functionResponse.response, so results are rendered ahead of
      // assembly and keyed by call id, mirroring the other batteries' two-phase shape.
      const renderedToolCallResults = new Map<string, Record<string, unknown>>()
      for (const tc of ctx.turnToolCalls) {
        renderedToolCallResults.set(
          tc.id,
          await resolved.renderGeminiToolResult({
            toolCall: tc,
            results: tc.results as never,
            tool: ctx.tools.get(tc.tool) as Tool | ArtifactTool | undefined,
            renderUntrustedContent: resolved.renderUntrustedContent,
            renderTrustedContent: resolved.renderTrustedContent,
            unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
            warn,
          })
        )
      }

      // ── assemble ────────────────────────────────────────────────────────
      const request = await resolved.buildGeminiRequest({
        systemPrompt: ctx.systemPrompt,
        standingInstructions: ctx.standingInstructions,
        memories: ctx.turnMemories,
        retrievables: ctx.turnRetrievables,
        messages: ctx.turnMessages,
        thoughts: ctx.turnThoughts,
        toolCalls: ctx.turnToolCalls,
        tools: ctx.tools,
        renderedToolCallResults,
        bucketOrder: merged.bucketOrder ?? (DEFAULT_GEMINI_BUCKET_ORDER as never),
        selfIdentity,
        thoughtSurfacing: merged.thoughtSurfacing ?? 'all-self',
        replayCompatibility: [],
        thoughtSignatureSentinel:
          merged.thoughtSignatureSentinel === undefined
            ? DEFAULT_SENTINEL
            : merged.thoughtSignatureSentinel,
        helpers: resolved,
        decodeMedia: mediaToGeminiInlineData,
        unsupportedMediaPolicy: merged.unsupportedMediaPolicy,
        warn,
      })

      const generationConfig = {
        ...(merged.maxOutputTokens !== undefined
          ? { maxOutputTokens: merged.maxOutputTokens }
          : {}),
        ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
        ...(merged.topP !== undefined ? { topP: merged.topP } : {}),
        ...(merged.topK !== undefined ? { topK: merged.topK } : {}),
        ...(merged.stopSequences ? { stopSequences: merged.stopSequences } : {}),
        ...(merged.thinkingConfig ? { thinkingConfig: merged.thinkingConfig } : {}),
      }
      const body = {
        ...request,
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
        ...(merged.toolConfig ? { toolConfig: merged.toolConfig } : {}),
        ...(merged.safetySettings ? { safetySettings: merged.safetySettings } : {}),
      }

      // Prompt-assembled tap: the EXACT body about to be POSTed. An ADK-control key — stripped
      // from the wire request, never sent. Observer errors are swallowed so a tap can never
      // corrupt a generation.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'gemini_generate_content',
            kind: 'request-body',
            messages: body.contents,
            tools: body.tools,
            requestBody: body,
            streamed: merged.stream === true,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      // ── dispatch ────────────────────────────────────────────────────────
      const base = (merged.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
      const action = merged.stream === true ? 'streamGenerateContent' : 'generateContent'
      const url = `${base}/models/${merged.model}:${action}`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (merged.apiKey) {
        // Google's own endpoint wants x-goog-api-key; several gateways in front of it accept only
        // Authorization, hence the switch rather than sending both.
        if (merged.useBearerAuth === true) headers.Authorization = `Bearer ${merged.apiKey}`
        else headers['x-goog-api-key'] = merged.apiKey
      }

      const doFetch = merged.fetch ?? globalThis.fetch
      let parsed: GeminiGenerateContentResponse
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: merged.timeoutMs ? AbortSignal.timeout(merged.timeoutMs) : ctx.abortSignal,
        })
        const text = await res.text()
        if (!res.ok) {
          // Classify the vendor's own signature rejection separately — it is actionable, and
          // Gemini's generic INVALID_ARGUMENT body gives a caller nothing to act on.
          if (/thought_signature|thoughtSignature/i.test(text)) {
            ctx.nack(new E_GEMINI_MISSING_THOUGHT_SIGNATURE([text.slice(0, 400)]))
            return
          }
          ctx.nack(new E_GEMINI_REQUEST_FAILED([res.status, text.slice(0, 400)]))
          return
        }
        parsed = JSON.parse(text) as GeminiGenerateContentResponse
      } catch (err) {
        ctx.nack(new E_GEMINI_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }

      // ── interpret ───────────────────────────────────────────────────────
      const { text, reasoning, functionCalls, finishReason } = extractGeminiGeneration(parsed)
      const responseId = uuidv6()

      if (text.length > 0) {
        const messageId = `${responseId}:message`
        helpers.reportMessage(messageId, text, { isComplete: true })
        await ctx.storeMessage(
          new Message({
            id: messageId,
            role: 'assistant',
            content: text,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }
      if (reasoning.length > 0) {
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

      // Fallback recovery: only consulted when the provider returned NO structured calls, so a
      // native functionCall always wins over a parsed one.
      let calls = functionCalls.map((c) => ({ id: uuidv6(), name: c.name, args: c.args }))
      if (calls.length === 0 && merged.localToolCallParser !== undefined && text.length > 0) {
        const parser = resolveToolCallParser(merged.localToolCallParser)
        // The parser returns { calls, cleanedText } — not an iterable of calls — and the
        // second argument carries the tool names actually offered this turn so a parser can
        // reject a hallucinated name rather than manufacture a call for it.
        const recovered = parser(text, { toolNames: ctx.tools.all().map((t) => t.name) })
        for (const call of recovered.calls) {
          calls.push({
            id: uuidv6(),
            name: call.name,
            args: (call.arguments ?? {}) as Record<string, unknown>,
          })
        }
      }

      if (merged.onRawGeneration) {
        try {
          merged.onRawGeneration({
            rawText: text,
            cleanedText: text,
            reasoning: reasoning.length > 0 ? [reasoning] : [],
            toolCalls: calls.map((c) => ({ name: c.name, arguments: c.args as never })),
            streamed: merged.stream === true,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      if (calls.length === 0) {
        // `finishReason` is recorded for the caller; an empty generation is NOT an error here —
        // it is a real vendor outcome and the runner decides what to do with it.
        helpers.log.trace({
          kind: 'gemini-finish',
          message: `generation ended with finishReason=${finishReason ?? 'unknown'} and no function calls`,
          payload: { finishReason: finishReason ?? 'unknown' },
        })
        ctx.ack()
        return
      }

      for (const call of calls) {
        if (ctx.abortSignal.aborted) return
        const toolName = normalizeToolName(call.name)
        const tool = ctx.tools.get(toolName) as Tool | ArtifactTool | undefined
        const completedAt = nowIso()

        if (!isObject(call.args)) {
          const results = new Tokenizable(
            new E_GEMINI_INVALID_TOOL_CALL_ARGS([JSON.stringify(call.args)]).message
          )
          helpers.reportToolCall(call.id, { tool: toolName, args: {} })
          helpers.reportToolCall(call.id, { results, isError: true, isComplete: true })
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
          continue
        }

        if (!tool) {
          const available = ctx.tools
            .all()
            .map((t) => t.name)
            .sort()
          const results = new Tokenizable(
            available.length > 0
              ? `Tool not found: ${toolName}. Available tools: ${available.join(', ')}.`
              : `Tool not found: ${toolName}. No tools are available this turn.`
          )
          helpers.reportToolCall(call.id, { tool: toolName, args: call.args })
          helpers.reportToolCall(call.id, { results, isError: true, isComplete: true })
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
          continue
        }

        helpers.reportToolCall(call.id, { tool: tool.name, args: call.args })
        let results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[] =
          new Tokenizable('')
        let isToolError = false
        try {
          const raw = await tool.executor(ctx)(call.args)
          results = Tokenizable.isTokenizable(raw)
            ? raw
            : new Tokenizable(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''))
        } catch (err) {
          isToolError = true
          results = new Tokenizable(isError(err) ? err.message : String(err))
        }
        const finishedAt = nowIso()
        helpers.reportToolCall(call.id, { results, isError: isToolError, isComplete: true })
        await ctx.storeToolCall(
          new ToolCall({
            id: call.id,
            tool: tool.name,
            args: call.args,
            checksum: computeChecksum(tool.name, call.args),
            isComplete: true,
            isError: isToolError,
            results,
            createdAt: finishedAt,
            updatedAt: finishedAt,
            completedAt: finishedAt,
          })
        )
      }
    }
  }
}
