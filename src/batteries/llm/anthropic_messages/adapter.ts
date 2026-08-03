/**
 * Cross-environment executor adapter for the Anthropic Messages API.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/adapter
 *
 * @remarks
 * Native Anthropic Messages adapter targeting `client.messages.create` from `@anthropic-ai/sdk`
 * (a hard static dependency of this battery). Node-first: an Anthropic API key in a browser
 * bundle is unacceptably exposed, so browser is deliberately not a target or gate for this
 * adapter — `dangerouslyAllowBrowser` exists only for the caller who accepts that risk knowingly.
 *
 * Structurally a sibling of the native Ollama and OpenAI Chat Completions adapters, with the
 * Anthropic-wire divergences:
 *
 * - Transport: the Anthropic SDK owns the HTTP call (`client.messages.create`), not raw `fetch`.
 *   ADK owns retry (`maxRetries: 0` on the client) and timeout (`requestTimeoutMs` fences an
 *   internal `AbortController` linked with `ctx.abortSignal`; when `requestTimeoutMs` is `0` a
 *   large explicit sentinel is set on the SDK client so the SDK's own silent 10-minute default is
 *   never silently inherited).
 * - Streaming: `Stream<RawMessageStreamEvent>` — an `AsyncIterable` the SDK already filters `ping`
 *   frames out of; a mid-stream provider error surfaces as a **thrown `APIError`** from `for
 *   await` iteration, not a discriminated event variant, so the consumption loop is wrapped in a
 *   `try`/`catch`.
 * - Content-block state machine keyed by `index`: `content_block_start` carries the ONLY
 *   occurrence of a `tool_use` block's `id`/`name` and a `redacted_thinking` block's `data`;
 *   `content_block_delta` carries five delta variants (`text_delta`, `thinking_delta`,
 *   `signature_delta`, `input_json_delta`, `citations_delta` — the last is out of scope for v1 and
 *   is a no-op); `content_block_stop` finalizes only that index. `message_stop` is not trusted to
 *   arrive; finalization is reachable from stream EOF too.
 * - Stop reasons: all seven (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`,
 *   `refusal`, `model_context_window_exceeded`) are handled explicitly — `refusal` is a real
 *   terminal HTTP-200 outcome (never mistaken for an error), `model_context_window_exceeded` maps
 *   to `E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW`.
 * - Error translation: typed SDK error classes (`BadRequestError`, `AuthenticationError`,
 *   `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`,
 *   `RateLimitError`, `InternalServerError`, `APIConnectionTimeoutError`, `APIConnectionError`,
 *   `APIUserAbortError`, generic `APIError`) are narrowed and mapped to ADK exceptions. Context
 *   overflow arrives as a 400 `BadRequestError` and is detected from body text (`prompt is too
 *   long`), not status. A real upstream 529 `overloaded_error` is retriable
 *   (`E_ANTHROPIC_MESSAGES_HTTP_ERROR`) — never routed into the fatal same-numbered
 *   adapter-side exceptions, which use 529 as their own unrelated status code.
 * - Thinking persistence: signed `thinking` blocks persist as a `Thought` carrying a
 *   `{variant:'thinking', thinking, signature, prefixFingerprint}` payload; `redacted_thinking`
 *   blocks carry `{variant:'redacted_thinking', data, prefixFingerprint}`. The fingerprint is
 *   computed via the exported `fingerprintAnthropicMessagesPrefix` helper — never reimplemented.
 * - No request repair: a `tool_choice` that appears not to have been honored (forces a name the
 *   response never calls) only warns via `helpers.log.warn` — `AnthropicMessagesAdapterOptions`
 *   has no `strictToolChoice` escape hatch, consistent with the "warn loudly, send anyway" ethos.
 *
 * Per-iteration flow (steps 1–9 of the plan):
 * 1. Merge constructor / executor / stash options and re-validate.
 * 2. Resolve helpers, falling back to bundled `default*` for each unset field.
 * 3. Artifact-reader tools: pre-forged onto `ctx.tools` by the DispatchRunner core; read as-is.
 * 4. Pre-render every persisted tool-call result into an Anthropic tool-result content block.
 * 5. When `tokenEncoding !== null`, sum the token weight of every persisted bucket and throw
 *    {@link @nhtio/adk/batteries!E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW} when the total exceeds `contextWindow`.
 * 6. Build the request via `buildAnthropicMessagesHistory`.
 * 7. Call `client.messages.create` with retry/timeout ownership; classify and translate errors.
 * 8. Streaming path: content-block state machine + usage latching + stop-reason handling.
 * 9. Non-streaming path: same persistence + tool-execution loop, from a single `Message`.
 */

import { DateTime } from 'luxon'
import { sha256 } from 'js-sha256'
import { v6 as uuidv6 } from 'uuid'
import { validateOptions } from './validation'
import { APIError } from '@anthropic-ai/sdk/core/error'
import { default as Anthropic } from '@anthropic-ai/sdk'
import { countAnthropicMessagesTokens } from './count_tokens'
import { translateAnthropicError } from './error_translation'
import { resolveToolCallParser } from '../chat_common/tool_parsers'
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
  ToolCall,
  Message,
  Thought,
  SpooledArtifact,
  Media,
  ArtifactTool,
} from '@nhtio/adk/common'
import {
  E_INVALID_ANTHROPIC_MESSAGES_OPTIONS,
  E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW,
  E_ANTHROPIC_MESSAGES_HTTP_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_STALLED,
  E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT,
  E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS,
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
  defaultToolsToChatCompletionsTools,
  defaultRenderChatCompletionsSystemPrompt,
  defaultRenderAnthropicTimelineMessage,
  defaultRenderAnthropicMediaBlocks,
  defaultRenderAnthropicToolCallResult,
  defaultRenderAnthropicSegmentedSystemPrompt,
  defaultRenderAnthropicThinkingBlocks,
  defaultBuildAnthropicMessagesHistory,
  anthropicToolsFromTools,
  fingerprintAnthropicMessagesPrefix,
} from './helpers'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Tool, Memory, TokenEncoding } from '@nhtio/adk/common'
import type { AnthropicMessagesCountTokensRequestInput } from './count_tokens'
import type {
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  GenerationStats,
} from '@nhtio/adk/dispatch_runner'
import type {
  AnthropicMessagesAdapterOptions,
  AnthropicMessagesHelpers,
  AnthropicMessage,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlockParam,
  AnthropicRawMessageStreamEvent,
  AnthropicRawContentBlockStartEvent,
  AnthropicRawMessageDeltaEvent,
  AnthropicUsage,
  AnthropicMessageDeltaUsage,
  AnthropicThinkingReplayPayload,
  AnthropicStopReason,
  AnthropicMessagesCountTokensInput,
} from './types'

// ─── An assembled tool call (args kept as a JSON string; id/name arrive on content_block_start) ──

interface AssembledAnthropicToolCall {
  id: string
  name: string
  args: string
}

// ─── Content-block accumulator state, keyed by block index ───────────────────

interface TextBlockState {
  kind: 'text'
  text: string
}
interface ThinkingBlockState {
  kind: 'thinking'
  thinking: string
  signature: string
}
interface RedactedThinkingBlockState {
  kind: 'redacted_thinking'
  data: string
}
interface ToolUseBlockState {
  kind: 'tool_use'
  id: string
  name: string
  args: string
}
interface OtherBlockState {
  kind: 'other'
}
type BlockState =
  | TextBlockState
  | ThinkingBlockState
  | RedactedThinkingBlockState
  | ToolUseBlockState
  | OtherBlockState

// ─── Option merging ────────────────────────────────────────────────────────────

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
  baseline: AnthropicMessagesAdapterOptions,
  exec: Partial<AnthropicMessagesAdapterOptions> | undefined,
  stash: Partial<AnthropicMessagesAdapterOptions> | undefined
): Partial<AnthropicMessagesAdapterOptions> => {
  const layers = [baseline as Partial<AnthropicMessagesAdapterOptions>, exec ?? {}, stash ?? {}]
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (k === 'headers' || k === 'helpers' || k === 'retry') continue
      out[k] = v
    }
  }
  const headers = mergeRecord(layers.map((l) => l.headers as Record<string, string> | undefined))
  if (headers !== undefined) out.headers = headers
  const helpers = mergeRecord(layers.map((l) => l.helpers as Record<string, unknown> | undefined))
  if (helpers !== undefined) out.helpers = helpers
  const retry = mergeRecord(layers.map((l) => l.retry as Record<string, unknown> | undefined))
  if (retry !== undefined) out.retry = retry
  return out as Partial<AnthropicMessagesAdapterOptions>
}

// ─── Helper resolution ─────────────────────────────────────────────────────────

const resolveHelpers = (
  overrides: Partial<AnthropicMessagesHelpers> | undefined
): AnthropicMessagesHelpers => {
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
    renderThought: src.renderThought ?? defaultRenderThought,
    filterThoughts: src.filterThoughts ?? defaultFilterThoughts,
    toolsToChatCompletionsTools:
      src.toolsToChatCompletionsTools ?? defaultToolsToChatCompletionsTools,
    renderChatCompletionsSystemPrompt:
      src.renderChatCompletionsSystemPrompt ?? defaultRenderChatCompletionsSystemPrompt,
    anthropicToolsFromTools: src.anthropicToolsFromTools ?? anthropicToolsFromTools,
    renderAnthropicTimelineMessage:
      src.renderAnthropicTimelineMessage ?? defaultRenderAnthropicTimelineMessage,
    renderAnthropicMediaBlocks: src.renderAnthropicMediaBlocks ?? defaultRenderAnthropicMediaBlocks,
    renderAnthropicToolCallResult:
      src.renderAnthropicToolCallResult ?? defaultRenderAnthropicToolCallResult,
    renderAnthropicSegmentedSystemPrompt:
      src.renderAnthropicSegmentedSystemPrompt ?? defaultRenderAnthropicSegmentedSystemPrompt,
    renderAnthropicThinkingBlocks:
      src.renderAnthropicThinkingBlocks ?? defaultRenderAnthropicThinkingBlocks,
    buildAnthropicMessagesHistory:
      src.buildAnthropicMessagesHistory ?? defaultBuildAnthropicMessagesHistory,
  }
}

// ─── ID / checksum / time helpers ──────────────────────────────────────────────

const computeChecksum = (tool: string, args: unknown): string =>
  sha256(canonicalStringify({ tool, args }))

const nowIso = (): string => DateTime.now().toISO() ?? new Date().toISOString()

const estimateTokensOf = async (
  value: {
    estimateTokens: (encoding: TokenEncoding) => number | Promise<number>
  },
  encoding: TokenEncoding
): Promise<number> => Promise.resolve(value.estimateTokens(encoding))

const emptyBlockState = (
  block: AnthropicRawContentBlockStartEvent['content_block']
): BlockState => {
  if (block.type === 'text') return { kind: 'text', text: block.text ?? '' }
  if (block.type === 'thinking')
    return {
      kind: 'thinking',
      thinking: block.thinking ?? '',
      signature: block.signature ?? '',
    }
  if (block.type === 'redacted_thinking') return { kind: 'redacted_thinking', data: block.data }
  if (block.type === 'tool_use') {
    // STREAMING-ONLY seed: on a real `content_block_start` event, `content_block.input` for a
    // `tool_use` block is always the SDK's `{}` placeholder, never the real arguments — the real
    // arguments arrive exclusively via subsequent `input_json_delta.partial_json` fragments on
    // `content_block_delta`, which this state's `args` accumulator appends to verbatim (see the
    // `content_block_delta` handler below). Serializing `block.input` here would seed the
    // accumulator with the string `"{}"`, and every later `partial_json` fragment would then be
    // appended onto that placeholder, producing corrupted concatenated JSON such as
    // `{}{"query":"x"}` that fails `JSON.parse` in `executeAndPersistToolCall` for every streamed
    // tool call. This function is reachable ONLY from the streaming path (Step 8); the
    // non-streaming path (Step 9) is structurally separate — it reads the complete `Message`'s
    // `content` array directly and serializes each `tool_use` block's `input` exactly once, never
    // through this function.
    return {
      kind: 'tool_use',
      id: block.id,
      name: block.name,
      args: '',
    }
  }
  return { kind: 'other' }
}

// ─── Stop-reason handling (exhaustive over all 7 AnthropicStopReason members) ──

/**
 * Logs the terminal stop reason of a completed generation. Exhaustive over every
 * {@link AnthropicStopReason} member plus an explicit `default` for any value the SDK's union does
 * not yet cover — never a silent fall-through. `model_context_window_exceeded` is included for
 * switch exhaustiveness only: both call sites throw/nack on that reason before this function is
 * reached, so its case body is unreachable in practice.
 */
const logAnthropicStopReason = (
  helpers: DispatchExecutorHelpers,
  stopReason: string | null,
  stopDetails: unknown
): void => {
  switch (stopReason as AnthropicStopReason | null) {
    case 'end_turn':
      helpers.log.debug({
        kind: 'anthropic-stop-reason',
        message: 'Anthropic ended the turn normally (end_turn).',
        payload: { stopReason },
      })
      break
    case 'max_tokens':
      helpers.log.warn({
        kind: 'anthropic-stop-reason',
        message: 'Anthropic stopped because max_tokens was reached; the response may be truncated.',
        payload: { stopReason },
      })
      break
    case 'stop_sequence':
      helpers.log.debug({
        kind: 'anthropic-stop-reason',
        message: 'Anthropic stopped on a configured stop_sequence.',
        payload: { stopReason },
      })
      break
    case 'tool_use':
      helpers.log.debug({
        kind: 'anthropic-stop-reason',
        message: 'Anthropic stopped to invoke one or more tools (tool_use).',
        payload: { stopReason },
      })
      break
    case 'pause_turn':
      helpers.log.info({
        kind: 'anthropic-pause-turn',
        message: 'Anthropic paused a long-running turn; response may be continued verbatim',
        payload: { stopReason },
      })
      break
    case 'refusal':
      helpers.log.warn({
        kind: 'anthropic-refusal',
        message: 'Anthropic returned a refusal stop reason',
        payload: { stopReason, stopDetails },
      })
      break
    case 'model_context_window_exceeded':
      // Unreachable: both call sites nack E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW and return as
      // soon as this reason is observed, before this function runs.
      break
    case null:
      break
    default:
      helpers.log.warn({
        kind: 'anthropic-unrecognized-stop-reason',
        message: `Anthropic returned an unrecognized stop_reason "${String(stopReason)}"; treating it as a normal terminal response.`,
        payload: { stopReason },
      })
  }
}

// ─── Generation-stats extraction ───────────────────────────────────────────────

const extractGenerationStats = (input: {
  model: string
  usage?: AnthropicUsage | AnthropicMessageDeltaUsage
  finishReason?: string | null
  raw: Record<string, unknown>
}): GenerationStats => {
  const stats: GenerationStats = {
    provider: 'anthropic_messages',
    model: input.model,
    raw: input.raw,
  }
  const usage = input.usage
  if (usage) {
    if (typeof usage.input_tokens === 'number') stats.promptTokens = usage.input_tokens
    if (typeof usage.output_tokens === 'number') stats.completionTokens = usage.output_tokens
    if (typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
      stats.totalTokens = usage.input_tokens + usage.output_tokens
    }
  }
  if (typeof input.finishReason === 'string') stats.finishReason = input.finishReason
  return stats
}

// ─── Adapter class ─────────────────────────────────────────────────────────────

/**
 * Opinionated cross-environment LLM adapter for the Anthropic Messages wire shape.
 *
 * @remarks
 * Construction validates options eagerly via {@link validateOptions} and throws
 * {@link @nhtio/adk/batteries/llm/anthropic_messages!E_INVALID_ANTHROPIC_MESSAGES_OPTIONS} on
 * failure. The returned instance is reusable: call {@link AnthropicMessagesAdapter.executor} once
 * per `DispatchRunner` configuration to obtain a {@link @nhtio/adk!DispatchExecutorFn} bound to
 * the baseline plus optional executor-scope overrides. Per-iteration overrides live on
 * `ctx.stash.anthropicMessages` and take highest precedence; `headers`, `helpers`, and `retry`
 * merge key-by-key across all three layers, every other field is replaced wholesale at the
 * highest layer that sets it. Node-first: browser is explicitly not a target — an Anthropic API
 * key in a browser bundle is unacceptably exposed.
 */
export class AnthropicMessagesAdapter {
  /** Customary key for per-iteration overrides on `ctx.stash`. */
  public static readonly STASH_KEY = 'anthropicMessages' as const

  readonly #baseline: AnthropicMessagesAdapterOptions

  /**
   * @param options - Constructor-baseline options. Re-validated on every iteration after
   *   per-dispatch and per-iteration overrides are layered in.
   * @throws {@link @nhtio/adk/batteries/llm/anthropic_messages!E_INVALID_ANTHROPIC_MESSAGES_OPTIONS} when `options` does not satisfy `anthropicMessagesOptionsSchema`.
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
  executor(overrides?: Partial<AnthropicMessagesAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = AnthropicMessagesAdapter
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      const localWarn = (msg: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message: msg })
      }

      // ── Step 1: merge & validate ──────────────────────────────────────────
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object'
          ? (stashRaw as Partial<AnthropicMessagesAdapterOptions>)
          : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))

      // Cross-field invariant: tokenEncoding non-null requires contextWindow.
      if (merged.tokenEncoding !== null && merged.contextWindow === undefined) {
        throw new E_INVALID_ANTHROPIC_MESSAGES_OPTIONS([
          'tokenEncoding is non-null but contextWindow is undefined',
        ])
      }

      // ── Step 2: resolve helpers ───────────────────────────────────────────
      const resolvedHelpers = resolveHelpers(merged.helpers)

      // ── Step 3: artifact-reader tools ─────────────────────────────────────
      // Forged by the DispatchRunner CORE into `ctx.tools` before the input pipeline runs
      // (generation is a generic core concern; this battery owns only representation). Read the
      // pre-forged `ctx.tools` directly — no local merge, no bindContext here.

      // ── Step 4: pre-render tool-call results ──────────────────────────────
      const renderedToolCallResults = new Map<string, AnthropicToolResultBlockParam>()
      for (const tc of ctx.turnToolCalls) {
        const rendered = await resolvedHelpers.renderAnthropicToolCallResult({
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
          renderAnthropicMediaBlocks: resolvedHelpers.renderAnthropicMediaBlocks,
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
          tlTokens += await estimateTokensOf(new Tokenizable(JSON.stringify(rendered)), encoding)
        }
        // Tool DECLARATIONS: Anthropic renders `tools` server-side; there is no single fixed
        // client-side conversion to reproduce it. Tally the serialized wire `tools` JSON as an
        // honest FLOOR. Without this the guard undercounts a tool-heavy prompt by the entire
        // declaration block.
        let toolTokens = 0
        const visibleTools = ctx.tools.visible()
        if (visibleTools.length > 0) {
          const toolsJson = JSON.stringify(
            resolvedHelpers.anthropicToolsFromTools(visibleTools, {
              descriptionToChatCompletionsJsonSchema: (d) =>
                resolvedHelpers.descriptionToChatCompletionsJsonSchema(d as never),
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
          throw new E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            encoding,
            JSON.stringify(perBucketObj),
          ])
        }
      }

      // ── Step 5b: tool_choice forced-tool guard (warn-only; no strictToolChoice escape) ─────
      // Anthropic's tool_choice shape (`{type:'auto'|'any'|'tool'|'none', name?}`) has no
      // equivalent to Chat Completions' `function`/`custom`/`allowed_tools` variants — only the
      // `'tool'` variant names a single tool. `AnthropicMessagesAdapterOptions` carries no
      // `strictToolChoice` field (types.ts is out of scope for this work package), so a forced
      // name resolving to an ephemeral, forged artifact-query tool can only be warned about, never
      // thrown on — consistent with the "warn loudly, send anyway, no request repair" governing
      // constraint. Never assume forcing worked: some models 400 on a forced tool_choice, which
      // surfaces later as a translated HTTP error, not here.
      const toolChoice = merged.toolChoice
      if (toolChoice && toolChoice.type === 'tool') {
        const t = ctx.tools.get(toolChoice.name) as { ephemeral?: boolean } | undefined
        if (t?.ephemeral === true) {
          helpers.log.warn({
            kind: 'tool-choice-forged-artifact',
            message: `tool_choice forces forged ephemeral artifact-query tool "${toolChoice.name}"; this is almost always a misconfiguration and it may not exist on the next iteration`,
            payload: { toolName: toolChoice.name },
          })
        }
      }

      // ── Step 5c: Fable-class forced-tool-use / thinking incompatibility guard (warn-only) ──
      // "Fable-class" is matched via a `claude-fable-` model-name prefix — ageing data, not a hard
      // capability table (no authoritative per-model capability source is available to this
      // adapter). A forced `tool_choice` (`{type:'tool'}` or `{type:'any'}`) combined with either
      // variant of `thinking` (`disabled` or `enabled`) is known to 400 upstream on this model
      // class. Same governing principle as Step 5b: surface the footgun, never rewrite/repair the
      // request — the caller may know something this heuristic doesn't.
      if (merged.model.startsWith('claude-fable-')) {
        const forcedToolChoice =
          toolChoice !== undefined && (toolChoice.type === 'tool' || toolChoice.type === 'any')
        const incompatibleThinking =
          merged.thinking !== undefined &&
          (merged.thinking.type === 'disabled' || merged.thinking.type === 'enabled')
        if (forcedToolChoice && incompatibleThinking) {
          helpers.log.warn({
            kind: 'fable-forced-tool-choice-thinking-conflict',
            message: `Model "${merged.model}" matches the Fable-class heuristic (claude-fable- prefix); combining a forced tool_choice ("${toolChoice?.type}") with thinking ("${merged.thinking?.type}") is known to 400 upstream on this model class. Sending the request unmodified.`,
            payload: {
              model: merged.model,
              toolChoiceType: toolChoice?.type,
              thinking: merged.thinking,
            },
          })
        }
      }

      // ── Step 6: build request body ────────────────────────────────────────
      const {
        system,
        messages: wireMessages,
        tools: wireTools,
      } = await resolvedHelpers.buildAnthropicMessagesHistory({
        model: merged.model,
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
        unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
        cacheBreakpoints: merged.cacheBreakpoints ?? 'auto',
        cacheTtl: merged.cacheTtl,
        renderAnthropicToolCallResult: resolvedHelpers.renderAnthropicToolCallResult,
        renderChatCompletionsSystemPrompt: resolvedHelpers.renderChatCompletionsSystemPrompt,
        renderAnthropicSegmentedSystemPrompt: resolvedHelpers.renderAnthropicSegmentedSystemPrompt,
        renderStandingInstructions: resolvedHelpers.renderStandingInstructions,
        renderMemories: resolvedHelpers.renderMemories,
        renderRetrievables: resolvedHelpers.renderRetrievables,
        renderRetrievableSafetyDirective: resolvedHelpers.renderRetrievableSafetyDirective,
        renderFirstPartyRetrievables: resolvedHelpers.renderFirstPartyRetrievables,
        renderThirdPartyPublicRetrievables: resolvedHelpers.renderThirdPartyPublicRetrievables,
        renderThirdPartyPrivateRetrievables: resolvedHelpers.renderThirdPartyPrivateRetrievables,
        renderAnthropicTimelineMessage: resolvedHelpers.renderAnthropicTimelineMessage,
        renderThought: resolvedHelpers.renderThought,
        filterThoughts: resolvedHelpers.filterThoughts,
        renderAnthropicThinkingBlocks: resolvedHelpers.renderAnthropicThinkingBlocks,
        renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
        renderTrustedContent: resolvedHelpers.renderTrustedContent,
        warn: localWarn,
      })

      const stream = merged.stream ?? true

      // Anthropic request surface fields are individually named on `AnthropicMessagesAdapterOptions`
      // (unlike OpenAI's spread-minus-control-keys body assembly) — assembled explicitly, field by
      // field, only when defined. This enumerates the request surface exhaustively rather than
      // spreading `merged`, so no ADK-control field (spoolStore, helpers, retry, onRawGeneration,
      // ...) can ever leak into the wire body by omission from a strip-set.
      const params: Record<string, unknown> = {
        model: merged.model,
        max_tokens: merged.maxTokens,
        messages: wireMessages,
        stream,
      }
      if (system !== undefined) params.system = system
      if (wireTools !== undefined && wireTools.length > 0) params.tools = wireTools
      if (merged.stopSequences !== undefined) params.stop_sequences = merged.stopSequences
      if (merged.thinking !== undefined) params.thinking = merged.thinking
      if (merged.outputConfig !== undefined) params.output_config = merged.outputConfig
      if (merged.toolChoice !== undefined) params.tool_choice = merged.toolChoice
      if (merged.metadata !== undefined) params.metadata = merged.metadata
      if (merged.serviceTier !== undefined) params.service_tier = merged.serviceTier
      if (merged.container !== undefined) params.container = merged.container
      if (merged.inferenceGeo !== undefined) params.inference_geo = merged.inferenceGeo
      if (merged.userProfileId !== undefined) params.user_profile_id = merged.userProfileId
      // Deprecated sampling parameters — never supplied unless the caller explicitly sets them.
      if (merged.temperature !== undefined) params.temperature = merged.temperature
      if (merged.topP !== undefined) params.top_p = merged.topP
      if (merged.topK !== undefined) params.top_k = merged.topK

      // One id for this whole generation — correlates the TO tap (onPromptAssembled) with the FROM
      // tap (onRawGeneration) below.
      const dispatchStreamId = uuidv6()

      // Prompt-assembled observability tap: the EXACT request going TO Anthropic, the instant it is
      // built and BEFORE the call. Mirror of onRawGeneration. Handed back AS-IS — no redaction —
      // and swallow observer errors so it can never corrupt the generation path.
      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'anthropic_messages',
            kind: 'request-body',
            messages: wireMessages,
            tools: wireTools,
            requestBody: params,
            streamed: stream,
            streamId: dispatchStreamId,
          })
        } catch {
          /* observer errors are non-fatal */
        }
      }

      // ── Step 7: call the SDK with retry / timeout ownership ───────────────
      const retryCfg = {
        maxAttempts: merged.retry?.maxAttempts ?? 1,
        baseDelayMs: merged.retry?.baseDelayMs ?? 500,
        maxDelayMs: merged.retry?.maxDelayMs ?? 30_000,
        retriableStatuses: merged.retry?.retriableStatuses ?? [429, 502, 503, 504, 529],
        honorRetryAfter: merged.retry?.honorRetryAfter ?? true,
      }

      const requestTimeoutMs = merged.requestTimeoutMs ?? 0
      // ADK owns retry (maxRetries:0) and timeout ownership. When requestTimeoutMs > 0, the SDK
      // client timeout is set with an explicit safety margin above it so the ADK-side timer (via
      // the linked AbortSignal below) is deterministically the one that fires first and raises
      // E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT. When requestTimeoutMs is 0 (ADK timer disabled), a
      // large explicit sentinel replaces the SDK's silent 10-minute default so the caller's choice
      // to disable the ADK timer is never silently overridden by an SDK-owned ceiling.
      const client = new Anthropic({
        apiKey: merged.apiKey,
        baseURL: merged.baseURL,
        fetch: merged.fetch,
        maxRetries: 0,
        timeout: requestTimeoutMs > 0 ? requestTimeoutMs + 30_000 : 24 * 60 * 60 * 1000,
        defaultHeaders: merged.headers,
        dangerouslyAllowBrowser: merged.dangerouslyAllowBrowser ?? false,
      })

      let anthropicStream: AsyncIterable<AnthropicRawMessageStreamEvent> | undefined
      let anthropicMessage: AnthropicMessage | undefined
      let attempt = 1
      const maxAttempts = retryCfg.maxAttempts
      let disposeLink: () => void = () => {}

      while (attempt <= maxAttempts) {
        if (ctx.abortSignal.aborted) return

        const internalController = new AbortController()
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
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
          if (stream) {
            anthropicStream = (await client.messages.create({ ...params, stream: true } as never, {
              signal: linkedSignal,
            })) as unknown as AsyncIterable<AnthropicRawMessageStreamEvent>
          } else {
            anthropicMessage = (await client.messages.create(
              { ...params, stream: false } as never,
              {
                signal: linkedSignal,
              }
            )) as unknown as AnthropicMessage
          }
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          break
        } catch (err) {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          if (ctx.abortSignal.aborted) return
          const classified = translateAnthropicError(err, retryCfg.retriableStatuses, {
            resolveErrorStatus: merged.resolveErrorStatus,
            warn: (msg) =>
              helpers.log.warn({ kind: 'anthropic-resolve-error-status', message: msg }),
          })
          if (classified.kind === 'abort') return
          if (classified.kind === 'timeout') {
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
            ctx.nack(new E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT([requestTimeoutMs]))
            return
          }
          if (classified.kind === 'context-overflow') {
            // Detected from body text on a 400 BadRequestError — the wire never distinguishes this
            // from any other 400, so the adapter cannot report the exact per-bucket breakdown the
            // pre-flight guard (Step 5) computes; that guard is the source of truth for a
            // predictable overflow. This branch only catches what the guard could not: a case where
            // Anthropic's own accounting disagrees with the local token estimate.
            ctx.nack(
              new E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW([
                -1,
                merged.contextWindow ?? -1,
                merged.tokenEncoding ?? 'unknown',
                classified.message,
              ])
            )
            return
          }
          if (classified.kind === 'retriable') {
            if (attempt < maxAttempts) {
              let delay = computeBackoff(attempt, retryCfg)
              if (retryCfg.honorRetryAfter !== false && isInstanceOf(err, 'APIError', APIError)) {
                const ra = err.headers?.get?.('retry-after')
                if (ra) {
                  const raMs = parseRetryAfter(ra)
                  if (raMs > 0) delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs)
                }
              }
              helpers.log.warn({
                kind: 'retry-attempt',
                message: `Anthropic error (status ${classified.status}) on attempt ${attempt}/${maxAttempts}; retrying in ~${delay}ms`,
                payload: {
                  reason: 'http-status',
                  status: classified.status,
                  delayMs: delay,
                  attempt: attempt + 1,
                  maxAttempts,
                },
              })
              await sleepWithJitter(delay, ctx.abortSignal)
              attempt += 1
              continue
            }
            helpers.log.error({
              kind: 'http-error',
              message: `Anthropic error ${classified.status} (terminal): ${classified.message.slice(0, 256)}`,
              payload: {
                status: classified.status,
                body: classified.message,
                attempt,
                maxAttempts,
              },
            })
            ctx.nack(new E_ANTHROPIC_MESSAGES_HTTP_ERROR([classified.status, classified.message]))
            return
          }
          helpers.log.error({
            kind: 'http-error',
            message: `Anthropic error ${classified.status} (terminal): ${classified.message.slice(0, 256)}`,
            payload: {
              status: classified.status,
              body: classified.message,
              attempt,
              maxAttempts,
            },
          })
          ctx.nack(new E_ANTHROPIC_MESSAGES_HTTP_ERROR([classified.status, classified.message]))
          return
        }
      }

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      const selfIdentity = merged.selfIdentity ?? 'assistant'

      // ── Inner helper: persist + execute one assembled tool call ───────────
      const executeAndPersistToolCall = async (call: AssembledAnthropicToolCall): Promise<void> => {
        const tool = ctx.tools.get(call.name)
        let args: Record<string, unknown> = {}
        let parseError: InstanceType<typeof E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS> | undefined
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
              parseError = new E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS([
                `must be a JSON object; received ${receivedKind}`,
                call.args,
              ])
            }
          } catch {
            parseError = new E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS([
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
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: call.name,
              args,
              checksum: computeChecksum(call.name, args),
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
          const available = ctx.tools
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
          await ctx.storeToolCall(
            new ToolCall({
              id: call.id,
              tool: call.name,
              args,
              checksum: computeChecksum(call.name, args),
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
            const reader = await spoolStore.write(call.id, String(raw))
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
            args,
            checksum: computeChecksum(tool.name, args),
            isComplete: true,
            isError: toolHadError,
            results,
            fromArtifactTool: isArtifactTool,
            // ArtifactTool results are the documented exception: they inline the slice the model
            // queried from a prior artifact (handing back a handle to a query result would be
            // recursion). Every other result keeps the secure default (inline:false → handle).
            inline: isArtifactTool,
            createdAt: completedAt2,
            updatedAt: completedAt2,
            completedAt: completedAt2,
          })
        )
      }

      // FALLBACK tool-call recovery. Native `tool_use` content blocks are authoritative; this is
      // consulted ONLY when the response yielded zero native tool_use blocks AND the caller opted
      // in via `localToolCallParser`. Mirrors the `ollama`/`openai_chat_completions` fallback
      // pattern verbatim — pure parse over the accumulated text, returning assembled calls (empty
      // when disabled or no match) so each call site can reflect them in `onRawGeneration` and then
      // execute them exactly like native calls.
      const parseFallbackToolCalls = (content: string): AssembledAnthropicToolCall[] => {
        if (merged.localToolCallParser === undefined) return []
        if (typeof content !== 'string' || content.length === 0) return []
        const parser = resolveToolCallParser(merged.localToolCallParser)
        const toolNames = ctx.tools.visible().map((t) => t.name)
        return parser(content, { toolNames }).calls.map((c) => ({
          id: uuidv6(),
          name: c.name,
          args: JSON.stringify(c.arguments),
        }))
      }

      // ── Step 8: streaming path ────────────────────────────────────────────
      if (stream) {
        if (!anthropicStream) {
          ctx.nack(new E_ANTHROPIC_MESSAGES_STREAM_ERROR(['no stream returned']))
          return
        }
        const streamId = dispatchStreamId
        const thoughtStreamId = `${streamId}:thought`

        const blocks = new Map<number, BlockState>()
        let sawMessageDelta = false
        let sawThinking = false
        let finalUsage: AnthropicUsage | AnthropicMessageDeltaUsage | undefined
        let finalStopReason: string | null = null
        let finalStopDetails: AnthropicRawMessageDeltaEvent['delta']['stop_details'] = null
        let responseModel = merged.model
        let doneSeen = false
        const collectedToolCalls: AssembledAnthropicToolCall[] = []

        const idleMs = merged.streamIdleTimeoutMs ?? 0
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let stalled = false
        const idleController = new AbortController()
        const armIdleTimer = (): void => {
          if (idleMs <= 0) return
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            stalled = true
            helpers.log.warn({
              kind: 'stream-idle-timeout',
              message: `Anthropic stream went idle for ${idleMs}ms; cancelling`,
              payload: { idleMs },
            })
            idleController.abort()
          }, idleMs)
        }
        const clearIdleTimer = (): void => {
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = undefined
          }
        }

        const finalize = async (): Promise<void> => {
          if (sawMessageDelta) {
            const combinedText = Array.from(blocks.values())
              .filter((b): b is TextBlockState => b.kind === 'text')
              .map((b) => b.text)
              .join('')
            helpers.reportMessage(streamId, '', { isComplete: true })
            await ctx.storeMessage(
              new Message({
                id: streamId,
                role: 'assistant',
                content: combinedText,
                identity: selfIdentity,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              })
            )
          }
          if (sawThinking) {
            const thinkingBlocks = Array.from(blocks.entries()).filter(
              (entry): entry is [number, ThinkingBlockState | RedactedThinkingBlockState] =>
                entry[1].kind === 'thinking' || entry[1].kind === 'redacted_thinking'
            )
            const combinedThinking = thinkingBlocks
              .map(([, b]) => (b.kind === 'thinking' ? b.thinking : ''))
              .join('')
            helpers.reportThought(thoughtStreamId, '', { isComplete: true })
            const prefixFingerprint = await fingerprintAnthropicMessagesPrefix({
              model: merged.model,
              system,
              tools: wireTools,
              messages: wireMessages,
            })
            const firstThinking = thinkingBlocks.find(([, b]) => b.kind === 'thinking') as
              | [number, ThinkingBlockState]
              | undefined
            const firstRedacted = thinkingBlocks.find(([, b]) => b.kind === 'redacted_thinking') as
              | [number, RedactedThinkingBlockState]
              | undefined
            const payload: AnthropicThinkingReplayPayload | undefined = firstThinking
              ? {
                  variant: 'thinking',
                  thinking: firstThinking[1].thinking,
                  signature: firstThinking[1].signature,
                  prefixFingerprint,
                }
              : firstRedacted
                ? {
                    variant: 'redacted_thinking',
                    data: firstRedacted[1].data,
                    prefixFingerprint,
                  }
                : undefined
            await ctx.storeThought(
              new Thought({
                id: thoughtStreamId,
                content: combinedThinking,
                identity: selfIdentity,
                payload,
                replayCompatibility: payload ? 'anthropic-messages-thinking-v1' : undefined,
                createdAt: nowIso(),
                updatedAt: nowIso(),
              })
            )
          }

          helpers.reportGenerationStats(
            extractGenerationStats({
              model: responseModel,
              usage: finalUsage,
              finishReason: finalStopReason,
              raw: {
                usage: finalUsage,
                stop_reason: finalStopReason,
                stop_details: finalStopDetails,
              },
            })
          )

          const combinedText = Array.from(blocks.values())
            .filter((b): b is TextBlockState => b.kind === 'text')
            .map((b) => b.text)
            .join('')

          // Fallback recovery (opt-in): consulted only when no native tool_use blocks were
          // collected, so a native call always wins over a parsed one.
          const fallbackToolCalls =
            collectedToolCalls.length === 0 ? parseFallbackToolCalls(combinedText) : []
          const effectiveToolCalls =
            collectedToolCalls.length > 0 ? collectedToolCalls : fallbackToolCalls

          if (merged.onRawGeneration) {
            try {
              merged.onRawGeneration({
                rawText: combinedText,
                cleanedText: combinedText,
                reasoning: sawThinking
                  ? Array.from(blocks.values())
                      .filter((b): b is ThinkingBlockState => b.kind === 'thinking')
                      .map((b) => b.thinking)
                  : [],
                toolCalls: effectiveToolCalls.map((c) => ({
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

          logAnthropicStopReason(helpers, finalStopReason, finalStopDetails)

          if (effectiveToolCalls.length === 0) {
            if (merged.autoAck) ctx.ack()
            return
          }
          for (const call of effectiveToolCalls) {
            if (ctx.abortSignal.aborted) return
            await executeAndPersistToolCall(call)
          }
        }

        try {
          armIdleTimer()
          for await (const event of anthropicStream) {
            armIdleTimer()
            if (ctx.abortSignal.aborted || idleController.signal.aborted) {
              clearIdleTimer()
              if (stalled) {
                ctx.nack(new E_ANTHROPIC_MESSAGES_STREAM_STALLED([idleMs]))
              }
              return
            }
            if (event.type === 'message_start') {
              responseModel = event.message.model ?? responseModel
              finalUsage = event.message.usage
            } else if (event.type === 'content_block_start') {
              blocks.set(event.index, emptyBlockState(event.content_block))
              const b = blocks.get(event.index)!
              if (b.kind === 'thinking' || b.kind === 'redacted_thinking') sawThinking = true
            } else if (event.type === 'content_block_delta') {
              const b = blocks.get(event.index)
              const delta = event.delta
              if (delta.type === 'text_delta') {
                sawMessageDelta = true
                if (b && b.kind === 'text') b.text += delta.text
                helpers.reportMessage(streamId, delta.text)
              } else if (delta.type === 'thinking_delta') {
                sawThinking = true
                if (b && b.kind === 'thinking') b.thinking += delta.thinking
                helpers.reportThought(thoughtStreamId, delta.thinking)
              } else if (delta.type === 'signature_delta') {
                if (b && b.kind === 'thinking') b.signature = delta.signature
              } else if (delta.type === 'input_json_delta') {
                if (b && b.kind === 'tool_use') b.args += delta.partial_json
              }
              // citations_delta: out of scope for v1 — no ADK citation representation; no-op.
            } else if (event.type === 'content_block_stop') {
              const b = blocks.get(event.index)
              if (b && b.kind === 'tool_use') {
                collectedToolCalls.push({
                  id: b.id,
                  name: b.name,
                  args: b.args || '{}',
                })
              }
            } else if (event.type === 'message_delta') {
              if (event.usage) finalUsage = event.usage
              if (event.delta.stop_reason !== null && event.delta.stop_reason !== undefined) {
                finalStopReason = event.delta.stop_reason
              }
              if (event.delta.stop_details !== null && event.delta.stop_details !== undefined) {
                finalStopDetails = event.delta.stop_details
              }
              if (event.delta.stop_reason === 'model_context_window_exceeded') {
                clearIdleTimer()
                ctx.nack(
                  new E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW([
                    -1,
                    merged.contextWindow ?? -1,
                    merged.tokenEncoding ?? 'unknown',
                    JSON.stringify(event.delta),
                  ])
                )
                return
              }
            } else if (event.type === 'message_stop') {
              doneSeen = true
              clearIdleTimer()
              await finalize()
              return
            }
          }
          clearIdleTimer()
          if (stalled) {
            ctx.nack(new E_ANTHROPIC_MESSAGES_STREAM_STALLED([idleMs]))
            return
          }
          // The SDK's own iterator does not guarantee a trailing message_stop reaches this loop in
          // every transport edge case (e.g. the connection closes cleanly right after the final
          // frame) — finalization must be idempotent and reachable from stream EOF too.
          if (!doneSeen) {
            helpers.log.warn({
              kind: 'stream-eof-without-stop',
              message:
                'Anthropic stream ended without a message_stop event; draining accumulated state',
            })
            await finalize()
          }
        } catch (err) {
          clearIdleTimer()
          if (ctx.abortSignal.aborted) return
          if (stalled) {
            ctx.nack(new E_ANTHROPIC_MESSAGES_STREAM_STALLED([idleMs]))
            return
          }
          const classified = translateAnthropicError(err, retryCfg.retriableStatuses, {
            resolveErrorStatus: merged.resolveErrorStatus,
            warn: (msg) =>
              helpers.log.warn({ kind: 'anthropic-resolve-error-status', message: msg }),
          })
          if (classified.kind === 'abort') return
          if (classified.kind === 'context-overflow') {
            ctx.nack(
              new E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW([
                -1,
                merged.contextWindow ?? -1,
                merged.tokenEncoding ?? 'unknown',
                classified.message,
              ])
            )
            return
          }
          helpers.log.error({
            kind: 'stream-error',
            message: `Anthropic stream failed: ${isError(err) ? err.message : String(err)}`,
            payload: { detail: isError(err) ? err.message : String(err) },
          })
          ctx.nack(
            new E_ANTHROPIC_MESSAGES_STREAM_ERROR([isError(err) ? err.message : String(err)])
          )
          return
        }
        return
      }

      // ── Step 9: non-streaming path ─────────────────────────────────────────
      if (!anthropicMessage) return
      const parsed = anthropicMessage
      const responseId = uuidv6()

      const textParts: string[] = []
      const toolUseBlocks: AnthropicToolUseBlockParam[] = []
      let thinkingPayload: AnthropicThinkingReplayPayload | undefined
      let combinedThinking = ''
      let hasThinking = false

      if (parsed.stop_reason === 'model_context_window_exceeded') {
        ctx.nack(
          new E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW([
            -1,
            merged.contextWindow ?? -1,
            merged.tokenEncoding ?? 'unknown',
            JSON.stringify({ stop_reason: parsed.stop_reason }),
          ])
        )
        return
      }
      logAnthropicStopReason(helpers, parsed.stop_reason, parsed.stop_details)

      for (const block of parsed.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'thinking') {
          hasThinking = true
          combinedThinking += block.thinking
          if (thinkingPayload === undefined) {
            thinkingPayload = {
              variant: 'thinking',
              thinking: block.thinking,
              signature: block.signature,
              prefixFingerprint: await fingerprintAnthropicMessagesPrefix({
                model: merged.model,
                system,
                tools: wireTools,
                messages: wireMessages,
              }),
            }
          }
        } else if (block.type === 'redacted_thinking') {
          hasThinking = true
          if (thinkingPayload === undefined) {
            thinkingPayload = {
              variant: 'redacted_thinking',
              data: block.data,
              prefixFingerprint: await fingerprintAnthropicMessagesPrefix({
                model: merged.model,
                system,
                tools: wireTools,
                messages: wireMessages,
              }),
            }
          }
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          })
        }
        // Server-tool-result block types (web_search_tool_result, code_execution_tool_result, ...)
        // are out of scope for this client-tools-only adapter — no ADK-side representation.
      }

      const content = textParts.join('')
      if (content.length > 0) {
        const messageId = `${responseId}:message`
        helpers.reportMessage(messageId, content, { isComplete: true })
        await ctx.storeMessage(
          new Message({
            id: messageId,
            role: 'assistant',
            content,
            identity: selfIdentity,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }
      if (hasThinking) {
        const thoughtId = `${responseId}:thought`
        helpers.reportThought(thoughtId, combinedThinking, {
          isComplete: true,
        })
        await ctx.storeThought(
          new Thought({
            id: thoughtId,
            content: combinedThinking,
            identity: selfIdentity,
            payload: thinkingPayload,
            replayCompatibility: thinkingPayload ? 'anthropic-messages-thinking-v1' : undefined,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }

      helpers.reportGenerationStats(
        extractGenerationStats({
          model: parsed.model ?? merged.model,
          usage: parsed.usage,
          finishReason: parsed.stop_reason,
          raw: { ...parsed } as unknown as Record<string, unknown>,
        })
      )

      const nativeCalls: AssembledAnthropicToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        args: b.input === undefined ? '{}' : JSON.stringify(b.input),
      }))
      // Fallback recovery (opt-in): consulted only when no native tool_use blocks are present, so
      // a native call always wins over a parsed one.
      const calls = nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(content)

      if (merged.onRawGeneration) {
        try {
          merged.onRawGeneration({
            rawText: content,
            cleanedText: content,
            reasoning: hasThinking ? [combinedThinking] : [],
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
   * Counts the input tokens a request would consume, without generating.
   *
   * Uses Anthropic's dedicated count-tokens surface (a distinct parameter shape from a create
   * request, and one that takes no `maxTokens`), and returns a named field plus the raw upstream
   * body rather than leaking the vendor type through this battery's public API.
   *
   * `input` accepts either a dispatch context — whose prompt is assembled with the same helpers the
   * executor uses — or a pre-built Anthropic-shaped request. Option precedence, revalidation,
   * timeout ownership, and error translation all match {@link AnthropicMessagesAdapter.executor}.
   */
  public async countTokens(
    input: AnthropicMessagesCountTokensRequestInput | AnthropicMessagesCountTokensInput,
    overrides?: Partial<AnthropicMessagesAdapterOptions>
  ): Promise<{ inputTokens: number; raw: unknown }> {
    return countAnthropicMessagesTokens(this.#baseline, input, overrides)
  }

  /**
   * Returns `true` when `value` is an {@link AnthropicMessagesAdapter} instance.
   */
  public static isAnthropicMessagesAdapter(value: unknown): value is AnthropicMessagesAdapter {
    return isInstanceOf(value, 'AnthropicMessagesAdapter', AnthropicMessagesAdapter)
  }
}
