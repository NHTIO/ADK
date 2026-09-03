/**
 * Cross-environment executor adapter for AWS Bedrock's native Converse API.
 *
 * @module @nhtio/adk/batteries/llm/bedrock_converse/adapter
 *
 * @remarks
 * Targets `POST {baseURL}/model/{modelId}/converse` (and `/converse-stream` when `stream` is set)
 * over plain HTTPS with a Bedrock API key (`Authorization: Bearer ABSK…`). Deliberately NO AWS SDK
 * and no SigV4 signer: the battery must stay cross-environment and dependency-light, and a bearer
 * key removes the only reason to pull in a signer.
 *
 * Why a native battery rather than pointing `openai_chat_completions` at a Converse-backed gateway:
 * Converse is a content-BLOCK protocol with strict role alternation, a required `toolConfig`
 * whenever tool blocks appear, and tool results carried on `user` turns. A gateway must repair all
 * of that on your behalf — most notably by MERGING consecutive same-role turns — and that repair is
 * invisible in the response. For ordinary use it is fine; for anything that needs to know what the
 * VENDOR received it is fatal, because a gateway's fix is indistinguishable from vendor tolerance.
 * See the validation battery's "Which API surface a rule applies to" guide, and
 * {@link BedrockConverseAdapterOptions.alternationPolicy} for the `'reject'` escape hatch that lets
 * Converse's own error surface.
 *
 * Options layer as in every other battery: constructor baseline → `executor()` overrides →
 * per-iteration `ctx.stash.bedrockConverse`, re-validated each iteration.
 */

import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { validateOptions } from './validation'
import { normalizeToolName } from '../chat_common/helpers'
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { Media, Message, Thought, Tokenizable, ToolCall } from '@nhtio/adk/common'
import {
  DEFAULT_CONVERSE_BUCKET_ORDER,
  buildConverseRequest,
  extractConverseGeneration,
  mediaToConverseImage,
  renderConverseToolResult,
  toolsToConverseTools,
} from './helpers'
import {
  E_CONVERSE_ALTERNATION_VIOLATION,
  E_CONVERSE_INVALID_TOOL_INPUT,
  E_CONVERSE_MISSING_TOOL_CONFIG,
  E_CONVERSE_REQUEST_FAILED,
  E_CONVERSE_STREAM_ERROR,
} from './exceptions'
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
import type { ArtifactTool, SpooledArtifact, Tool } from '@nhtio/adk/common'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/types'
import type {
  BedrockConverseAdapterOptions,
  BedrockConverseHelpers,
  ConverseResponse,
} from './types'

const nowIso = (): string => DateTime.now().toISO() ?? new Date().toISOString()

const DEFAULT_REGION = 'us-east-1'

const computeChecksum = (tool: string, args: Record<string, unknown>): string =>
  sha256(`${tool}:${canonicalStringify(args)}`)

/** Merge the three option layers, later winning. */
const mergeOptions = (
  ...layers: Array<Partial<BedrockConverseAdapterOptions> | undefined>
): Partial<BedrockConverseAdapterOptions> => {
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) out[k] = v
  }
  return out as Partial<BedrockConverseAdapterOptions>
}

/** Fill every injectable helper, preferring the caller's override. */
const resolveHelpers = (
  overrides: Partial<BedrockConverseHelpers> | undefined
): BedrockConverseHelpers => {
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
    toolsToConverseTools: pick('toolsToConverseTools', toolsToConverseTools),
    renderConverseToolResult: pick('renderConverseToolResult', renderConverseToolResult),
    buildConverseRequest: pick('buildConverseRequest', buildConverseRequest),
  } as BedrockConverseHelpers
}

/**
 * Native Bedrock Converse executor adapter.
 *
 * @example
 * ```ts
 * const adapter = new BedrockConverseAdapter({
 *   model: 'us.amazon.nova-2-lite-v1:0',
 *   apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
 *   region: 'us-east-1',
 * })
 * const runner = new TurnRunner({ executorCallback: adapter.executor(), ... })
 * ```
 */
export class BedrockConverseAdapter {
  /** Per-iteration override key on `ctx.stash`. */
  public static readonly STASH_KEY = 'bedrockConverse' as const

  readonly #baseline: BedrockConverseAdapterOptions

  /**
   * @param options - Constructor-baseline options, re-validated each iteration after overrides merge.
   * @throws {@link E_INVALID_BEDROCK_CONVERSE_OPTIONS} when `options` is invalid.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
  }

  /** Narrowing guard for cross-realm instances. */
  public static isBedrockConverseAdapter(value: unknown): value is BedrockConverseAdapter {
    return isInstanceOf(value, 'BedrockConverseAdapter', BedrockConverseAdapter)
  }

  /**
   * Build a {@link DispatchExecutorFn} bound to the baseline plus optional executor-scope overrides.
   *
   * @param overrides - Higher precedence than the baseline, lower than `ctx.stash`.
   */
  executor(overrides?: Partial<BedrockConverseAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = BedrockConverseAdapter
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      const warn = (message: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message })
      }

      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides = isObject(stashRaw)
        ? (stashRaw as Partial<BedrockConverseAdapterOptions>)
        : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))
      const resolved = resolveHelpers(merged.helpers)
      const selfIdentity = 'assistant'
      const dispatchStreamId = uuidv6()

      // Converse wants toolResult.content[] blocks, so results render ahead of assembly.
      const renderedToolCallResults = new Map<
        string,
        Array<{ text?: string; json?: Record<string, unknown> }>
      >()
      for (const tc of ctx.turnToolCalls) {
        renderedToolCallResults.set(
          tc.id,
          await resolved.renderConverseToolResult({
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

      const request = await resolved.buildConverseRequest({
        systemPrompt: ctx.systemPrompt,
        standingInstructions: ctx.standingInstructions,
        memories: ctx.turnMemories,
        retrievables: ctx.turnRetrievables,
        messages: ctx.turnMessages,
        thoughts: ctx.turnThoughts,
        toolCalls: ctx.turnToolCalls,
        tools: ctx.tools,
        renderedToolCallResults,
        bucketOrder: merged.bucketOrder ?? (DEFAULT_CONVERSE_BUCKET_ORDER as never),
        selfIdentity,
        thoughtSurfacing: merged.thoughtSurfacing ?? 'all-self',
        replayCompatibility: [],
        alternationPolicy: merged.alternationPolicy ?? 'merge',
        helpers: resolved,
        decodeMedia: mediaToConverseImage,
        unsupportedMediaPolicy: merged.unsupportedMediaPolicy,
        warn,
      })

      const inferenceConfig = {
        ...(merged.maxTokens !== undefined ? { maxTokens: merged.maxTokens } : {}),
        ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
        ...(merged.topP !== undefined ? { topP: merged.topP } : {}),
        ...(merged.stopSequences ? { stopSequences: merged.stopSequences } : {}),
      }
      const body = {
        ...request,
        ...(merged.toolChoice && request.toolConfig
          ? { toolConfig: { ...request.toolConfig, toolChoice: merged.toolChoice } }
          : {}),
        ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
        ...(merged.additionalModelRequestFields
          ? { additionalModelRequestFields: merged.additionalModelRequestFields }
          : {}),
      }

      // The EXACT body about to be POSTed. An ADK-control key — stripped from the wire request.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'bedrock_converse',
            kind: 'request-body',
            messages: body.messages,
            tools: body.toolConfig?.tools,
            requestBody: body,
            streamed: merged.stream === true,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      const base = (
        merged.baseURL ?? `https://bedrock-runtime.${merged.region ?? DEFAULT_REGION}.amazonaws.com`
      ).replace(/\/$/, '')
      const action = merged.stream === true ? 'converse-stream' : 'converse'
      // The model id contains ':' and '.', both legal in a path segment but worth encoding so a
      // future id with a reserved character does not silently reshape the URL.
      const url = `${base}/model/${encodeURIComponent(merged.model)}/${action}`
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (merged.apiKey) headers.Authorization = `Bearer ${merged.apiKey}`

      const doFetch = merged.fetch ?? globalThis.fetch
      let parsed: ConverseResponse
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: merged.timeoutMs ? AbortSignal.timeout(merged.timeoutMs) : ctx.abortSignal,
        })
        const text = await res.text()
        if (!res.ok) {
          // Classify the two Converse-specific rejections: both are actionable, and both otherwise
          // arrive as an undifferentiated ValidationException.
          if (/toolConfig/i.test(text)) {
            ctx.nack(new E_CONVERSE_MISSING_TOOL_CONFIG([text.slice(0, 400)]))
            return
          }
          if (/alternat|consecutive|must alternate/i.test(text)) {
            ctx.nack(new E_CONVERSE_ALTERNATION_VIOLATION([text.slice(0, 400)]))
            return
          }
          ctx.nack(new E_CONVERSE_REQUEST_FAILED([res.status, text.slice(0, 400)]))
          return
        }
        parsed = JSON.parse(text) as ConverseResponse
      } catch (err) {
        ctx.nack(new E_CONVERSE_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }

      const { text, reasoning, toolUses, stopReason } = extractConverseGeneration(parsed)
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

      // Fallback recovery is consulted ONLY when the provider returned no structured tool use, so
      // a native toolUse always wins over a parsed one.
      const calls = toolUses.map((t) => ({ id: t.toolUseId, name: t.name, args: t.input }))
      if (calls.length === 0 && merged.localToolCallParser !== undefined && text.length > 0) {
        const parser = resolveToolCallParser(merged.localToolCallParser)
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
        helpers.log.trace({
          kind: 'converse-finish',
          message: `generation ended with stopReason=${stopReason ?? 'unknown'} and no tool use`,
          payload: { stopReason: stopReason ?? 'unknown' },
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
            new E_CONVERSE_INVALID_TOOL_INPUT([JSON.stringify(call.args)]).message
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
