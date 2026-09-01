/**
 * Cross-environment executor adapter for the OpenAI Responses API.
 *
 * @module @nhtio/adk/batteries/llm/openai_responses/adapter
 *
 * @remarks
 * Cross-environment LLM adapter for the OpenAI Responses wire shape — a flat `input: Item[]` array
 * (not `messages[]`), where a tool call and its result are two SIBLING top-level items
 * (`function_call` / `function_call_output`), and the system prompt defaults to a top-level
 * `instructions` string rather than a leading message item.
 *
 * The adapter is built around the same three pluggable layers as `openai_chat_completions`:
 *
 * 1. **Translation helpers** — the swappable functions exported from `./helpers` turn ADK
 *    primitives into Responses wire shapes. Consumers override individual helpers via
 *    `options.helpers.*`.
 * 2. **Three-layer options merging** — constructor baseline, per-`executor()` overrides, and
 *    per-iteration `ctx.stash.openaiResponses` overrides combine with key-by-key precedence for
 *    `headers`/`helpers`/`retry` and wholesale replacement for everything else. The merged shape
 *    is re-validated on every iteration.
 * 3. **Cross-env transport** — hand-rolled `fetch` + SSE parsing, mirroring
 *    `openai_chat_completions/adapter.ts`'s transport exactly. No `openai` SDK dependency.
 *
 * This adapter is STATELESS by design: `store: false` is always sent (never a settable option),
 * and the full `input` array is resent every iteration. There is no `[DONE]` sentinel on the
 * Responses SSE stream — termination is `response.completed` / `.incomplete` / `.failed`; EOF
 * without one of these is a best-effort recovery, not a hard failure: it warn-logs and drains
 * whatever was accumulated rather than nacking with {@link E_OPENAI_RESPONSES_STREAM_ERROR} (that
 * exception is reserved for a genuine stream-level error, e.g. the connection itself failing).
 *
 * Recoverable-failure handling: a 400 whose body matches `invalid_encrypted_content` drops every
 * reasoning item from the resolved input and retries the request once — a documented real-world
 * failure mode when a persisted reasoning `Thought` outlives a server-side key rotation. A 400
 * matching the reasoning/output-item pairing violation phrases translates to
 * {@link E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED} instead of a generic HTTP error.
 *
 * `background` is NOT supported: this executor has no polling/resumption loop for a
 * `queued`/`in_progress` background response (the Responses API's async mode; see
 * https://platform.openai.com/docs/guides/background), so `background: true` is rejected up front
 * by the options schema (`E_INVALID_OPENAI_RESPONSES_OPTIONS`, see `validation.ts`) rather than
 * reaching this executor at all — accepting it here would otherwise fall straight into the
 * ordinary streaming/non-streaming response handling below and treat the initial
 * `queued`/`in_progress` response body as a complete, empty answer, silently discarding whatever
 * the background job eventually produces.
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
  E_INVALID_OPENAI_RESPONSES_OPTIONS,
  E_OPENAI_RESPONSES_CONTEXT_OVERFLOW,
  E_OPENAI_RESPONSES_HTTP_ERROR,
  E_OPENAI_RESPONSES_STREAM_ERROR,
  E_OPENAI_RESPONSES_STREAM_STALLED,
  E_OPENAI_RESPONSES_REQUEST_TIMEOUT,
  E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS,
  E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED,
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
  defaultRenderArtifactHandleBody,
  defaultRenderThought,
  defaultFilterThoughts,
  defaultToolsToChatCompletionsTools,
  defaultRenderChatCompletionsSystemPrompt,
  defaultRenderOpenAIResponsesMediaBlocks,
  defaultRenderOpenAIResponsesTimelineMessage,
  defaultRenderOpenAIResponsesToolCallResult,
  defaultToolsToOpenAIResponsesTools,
  fingerprintOpenAIResponsesPrefix,
  defaultRenderOpenAIResponsesReasoningItem,
  defaultBuildOpenAIResponsesInput,
  defaultCreateResponsesOutputSlotMachine,
  normalizeOpenAIResponsesItemId,
} from './helpers'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Tool, Memory, TokenEncoding } from '@nhtio/adk/common'
import type {
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  GenerationStats,
} from '@nhtio/adk/dispatch_runner'
import type {
  OpenAIResponsesAdapterOptions,
  OpenAIResponsesHelpers,
  ChatCompletionsRetryConfig,
  OpenAIResponsesRequestBody,
  OpenAIResponsesInputItem,
  OpenAIResponsesInputContentBlock,
  OpenAIResponsesReasoningItem,
  OpenAIResponsesFunctionCallItem,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesResponseObject,
  OpenAIResponsesReasoningReplayPayload,
  OpenAIResponsesTool,
} from './types'

// ─── ADK-control keys (stripped before sending the request body) ──────────

const ADK_CONTROL_KEYS: ReadonlySet<string> = new Set([
  'apiKey',
  'baseURL',
  'organization',
  'project',
  'headers',
  'fetch',
  'stream',
  'bucketOrder',
  'contextWindow',
  'selfIdentity',
  'thoughtSurfacing',
  'tokenEncoding',
  'replayCompatibility',
  'helpers',
  'streamIdleTimeoutMs',
  'requestTimeoutMs',
  'retry',
  'strictToolChoice',
  // `strict` configures the EMITTED TOOL DECLARATIONS (it becomes each function tool's own
  // `strict` field via `toolsToOpenAIResponsesTools`) — it is not a top-level Responses request
  // property. Without this entry the generic body spread forwarded it verbatim, so an adapter
  // constructed with `strict: true` put `"strict": true` on the wire alongside `model`/`input`,
  // where the API can reject the request before generation. Verified against the real wire body:
  // the keys sent were `input, instructions, model, store, stream, strict`.
  'strict',
  'autoAck',
  'unsupportedMediaPolicy',
  'localToolCallParser',
  'forgeToolsFilter',
  'spoolStore',
  // Responses-specific ADK control
  'systemPromptChannel',
  'reasoningReplay',
  // Observability hooks — never sent to the provider.
  'onRawGeneration',
  'onPromptAssembled',
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
  layers: ReadonlyArray<Partial<OpenAIResponsesHelpers> | undefined>
): Partial<OpenAIResponsesHelpers> | undefined => {
  let merged: Partial<OpenAIResponsesHelpers> | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? {}), ...layer }
  }
  return merged
}

const mergeOptions = (
  baseline: OpenAIResponsesAdapterOptions,
  exec: Partial<OpenAIResponsesAdapterOptions> | undefined,
  stash: Partial<OpenAIResponsesAdapterOptions> | undefined
): Partial<OpenAIResponsesAdapterOptions> => {
  const layers = [baseline as Partial<OpenAIResponsesAdapterOptions>, exec ?? {}, stash ?? {}]
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
  return out as Partial<OpenAIResponsesAdapterOptions>
}

// ─── Helper resolution ────────────────────────────────────────────────────────

const resolveHelpers = (
  overrides: Partial<OpenAIResponsesHelpers> | undefined
): OpenAIResponsesHelpers => {
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
    renderArtifactHandleBody: src.renderArtifactHandleBody ?? defaultRenderArtifactHandleBody,
    renderThought: src.renderThought ?? defaultRenderThought,
    filterThoughts: src.filterThoughts ?? defaultFilterThoughts,
    toolsToChatCompletionsTools:
      src.toolsToChatCompletionsTools ?? defaultToolsToChatCompletionsTools,
    renderChatCompletionsSystemPrompt:
      src.renderChatCompletionsSystemPrompt ?? defaultRenderChatCompletionsSystemPrompt,
    renderOpenAIResponsesMediaBlocks:
      src.renderOpenAIResponsesMediaBlocks ?? defaultRenderOpenAIResponsesMediaBlocks,
    renderOpenAIResponsesTimelineMessage:
      src.renderOpenAIResponsesTimelineMessage ?? defaultRenderOpenAIResponsesTimelineMessage,
    renderOpenAIResponsesToolCallResult:
      src.renderOpenAIResponsesToolCallResult ?? defaultRenderOpenAIResponsesToolCallResult,
    toolsToOpenAIResponsesTools:
      src.toolsToOpenAIResponsesTools ?? defaultToolsToOpenAIResponsesTools,
    fingerprintOpenAIResponsesPrefix:
      src.fingerprintOpenAIResponsesPrefix ?? fingerprintOpenAIResponsesPrefix,
    renderOpenAIResponsesReasoningItem:
      src.renderOpenAIResponsesReasoningItem ?? defaultRenderOpenAIResponsesReasoningItem,
    buildOpenAIResponsesInput: src.buildOpenAIResponsesInput ?? defaultBuildOpenAIResponsesInput,
    createResponsesOutputSlotMachine:
      src.createResponsesOutputSlotMachine ?? defaultCreateResponsesOutputSlotMachine,
  }
}

// ─── ID helpers ───────────────────────────────────────────────────────────────

// Canonical (key-order-insensitive) checksum — MUST match the contract documented on
// canonicalStringify and used by Tool.executor + dispatch_runner's streaming helper, so
// ctx.toolCallCount(checksum) detects semantically-identical repeat calls regardless of argument
// key order.
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
  usage?: OpenAIResponsesResponseObject['usage']
  finishReason?: string | null
  raw: Record<string, unknown>
}): GenerationStats => {
  const stats: GenerationStats = {
    provider: 'openai_responses',
    model: input.model,
    raw: input.raw,
  }
  const usage = input.usage
  if (usage) {
    const cached = usage.input_tokens_details?.cached_tokens ?? 0
    if (typeof usage.input_tokens === 'number') {
      stats.promptTokens = Math.max(0, usage.input_tokens - cached)
    }
    if (typeof usage.output_tokens === 'number') stats.completionTokens = usage.output_tokens
    if (typeof usage.total_tokens === 'number') stats.totalTokens = usage.total_tokens
  }
  if (typeof input.finishReason === 'string') stats.finishReason = input.finishReason
  return stats
}

// ─── Stop-reason mapping ───────────────────────────────────────────────────────

const mapStopReason = (
  status: OpenAIResponsesResponseObject['status'],
  incompleteReason: string | undefined,
  hadToolCalls: boolean
): string => {
  if (status === 'completed') return hadToolCalls ? 'tool_calls' : 'stop'
  if (status === 'incomplete') {
    if (incompleteReason === 'content_filter') return 'content_filter'
    return 'length'
  }
  return 'error'
}

// ─── Reasoning-replay error detection ─────────────────────────────────────────

const INVALID_ENCRYPTED_CONTENT_PHRASE = 'invalid_encrypted_content'
// Both directions of the bidirectional pairing constraint (openai/openai-node#1791). The first
// phrase catches a REASONING item rejected for missing its required FOLLOWING item; the second
// catches the mirror case reported as that issue's headline error — a MESSAGE item rejected for
// missing its required PRECEDING reasoning item (`Item 'msg_…' of type 'message' was provided
// without its required preceding item of type 'reasoning'`), which the narrower
// "of type 'reasoning' was provided without" phrasing does not match.
const REASONING_PAIRING_PHRASES = [
  "of type 'reasoning' was provided without",
  "was provided without its required preceding item of type 'reasoning'",
  'items are not persisted when store is set to false',
]

const bodyMatches = (body: string, phrases: ReadonlyArray<string>): boolean => {
  const lower = body.toLowerCase()
  return phrases.some((p) => lower.includes(p.toLowerCase()))
}

// ─── SSE framing ────────────────────────────────────────────────────────────────

// A blank line delimits SSE frames. Tolerate CRLF alongside LF — some gateways/proxies
// normalise line endings to \r\n, which a bare `\n\n` search never matches.
const SSE_FRAME_SEPARATOR = /\r?\n\r?\n/

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Opinionated cross-environment LLM adapter for the OpenAI Responses wire shape.
 *
 * @remarks
 * Construction validates options eagerly via {@link validateOptions} and throws
 * {@link E_INVALID_OPENAI_RESPONSES_OPTIONS} on failure. The returned instance is reusable: call
 * {@link OpenAIResponsesAdapter.executor} once per `DispatchRunner` configuration.
 *
 * Per-iteration overrides live on the active `DispatchContext`'s `stash.openaiResponses` slot and
 * take highest precedence — they merge into the executor-scope shape on every iteration.
 * `headers`, `helpers`, and `retry` merge key-by-key across all three layers; every other field is
 * replaced wholesale at the highest layer that sets it.
 */
export class OpenAIResponsesAdapter {
  /**
   * Customary key for per-iteration overrides on `ctx.stash`. The adapter reads
   * `ctx.stash.get(OpenAIResponsesAdapter.STASH_KEY, {})` at the start of every iteration and
   * merges the value into the resolved options shape.
   */
  public static readonly STASH_KEY = 'openaiResponses' as const

  readonly #baseline: OpenAIResponsesAdapterOptions

  /**
   * @param options - Constructor-baseline options. Re-validated on every iteration after
   *   per-dispatch and per-iteration overrides are layered in.
   * @throws {@link E_INVALID_OPENAI_RESPONSES_OPTIONS} when `options` does not satisfy
   *   `openAIResponsesOptionsSchema`.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
  }

  /**
   * Returns a `DispatchExecutorFn` bound to this adapter's baseline plus optional executor-scope
   * overrides. The returned function is reusable across iterations — every iteration re-merges
   * with `ctx.stash[STASH_KEY]` and re-validates the result.
   *
   * @param overrides - Optional executor-scope overrides. Higher precedence than the baseline,
   *   lower precedence than `ctx.stash[STASH_KEY]`.
   * @returns A `DispatchExecutorFn` suitable for `DispatchRunner`.
   */
  executor(overrides?: Partial<OpenAIResponsesAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = OpenAIResponsesAdapter
    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      const localWarn = (msg: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message: msg })
      }

      // ── Step 1: merge & validate ──────────────────────────────────────────
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object'
          ? (stashRaw as Partial<OpenAIResponsesAdapterOptions>)
          : {}
      const mergedRaw = mergeOptions(baseline, overrides, stashOverrides)
      const merged = validateOptions(mergedRaw)

      if (merged.tokenEncoding !== null && merged.contextWindow === undefined) {
        throw new E_INVALID_OPENAI_RESPONSES_OPTIONS([
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
      const renderedToolCallResults = new Map<string, string | OpenAIResponsesInputContentBlock[]>()
      for (const tc of ctx.turnToolCalls) {
        const rendered = await resolvedHelpers.renderOpenAIResponsesToolCallResult({
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
          renderOpenAIResponsesMediaBlocks: resolvedHelpers.renderOpenAIResponsesMediaBlocks,
          renderArtifactHandleBody: resolvedHelpers.renderArtifactHandleBody,
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
        {
          // The wire ships ONE `<system_instructions kind="developer-rules">` block wrapping every
          // standing instruction (+68 chars over a 15-char body), not the raw strings. Counting the
          // rendered block captures both the bodies and that wrapper.
          const siBlock = resolvedHelpers.renderStandingInstructions(ctx.standingInstructions)
          if (siBlock.length > 0) {
            siTokens = await estimateTokensOf(new Tokenizable(siBlock), encoding)
          }
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
            // Count the RENDERED message, not the raw content. Every timeline message goes on the
            // wire wrapped in an identity envelope — `<message_<id> from=… role=… createdAt=…>` —
            // which the guard previously ignored entirely. Measured: a 30-char message ships as
            // 118 chars (3.9x), and the envelope is a near-fixed ~90 chars regardless of body
            // length, so a 40-turn conversation of short messages leaked ~880 tokens the guard
            // never saw. Rendering it here is the honest measure: it is the same helper the
            // builder uses, so the count tracks the wire by construction rather than by a
            // hand-maintained estimate that drifts when the envelope changes.
            const renderedMsg = await resolvedHelpers.renderOpenAIResponsesTimelineMessage({
              message: msg,
              selfIdentity: merged.selfIdentity ?? 'assistant',
              // Media is tallied separately below, from byte length; asking this renderer to
              // resolve attachments would duplicate the base64 work and can throw under
              // `unsupportedMediaPolicy: 'throw'` purely to measure it.
              unsupportedMediaPolicy: 'synthetic-description',
              renderOpenAIResponsesMediaBlocks: resolvedHelpers.renderOpenAIResponsesMediaBlocks,
              renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
              renderTrustedContent: resolvedHelpers.renderTrustedContent,
            })
            const renderedText =
              renderedMsg === null
                ? ''
                : (
                    ((renderedMsg as { content?: unknown }).content as
                      | Array<{ type: string; text?: string }>
                      | undefined) ?? []
                  )
                    .filter((b) => b.type === 'input_text')
                    .map((b) => b.text ?? '')
                    .join('')
            tlTokens += await estimateTokensOf(
              new Tokenizable(renderedText.length > 0 ? renderedText : msg.content.toString()),
              encoding
            )
          }
          // A message's ATTACHMENTS render into real wire content — `renderOpenAIResponsesTimeline
          // Message` turns each one into `input_image`/`input_file` blocks carrying a base64
          // payload — so they must be tallied too. Counting only `msg.content` left a user turn
          // with an image attachment entirely invisible to the guard, which is the same
          // undercount already fixed for rendered tool-call results below, one code path over.
          //
          // The media is measured by its own byte length rather than by rendering it here:
          // re-rendering would duplicate the base64 work (and can throw under
          // `unsupportedMediaPolicy: 'throw'`) purely to measure it. base64 inflates bytes by 4/3,
          // and a token is ~4 base64 chars, so `byteLength / 3` is the honest FLOOR for the
          // payload — same doctrine as the tool-declaration and native-block floors.
          for (const media of msg.attachments ?? []) {
            try {
              const bytes = await media.byteLength()
              if (bytes !== undefined && Number.isFinite(bytes) && bytes > 0) {
                tlTokens += Math.ceil(bytes / 3)
              }
            } catch {
              /* unreadable attachment — cannot measure it; the floor simply omits it */
            }
          }
        }
        for (const th of ctx.turnThoughts) {
          // Same envelope problem as messages: a surfaced thought ships wrapped in
          // `<thought_<id> nonce=… kind=… from=… createdAt=…>`, measured at +113 chars over a
          // 19-char body. Count the rendered form so the tally tracks the wire.
          const renderedThought = resolvedHelpers.renderThought(th.content.toString(), {
            nonce: th.id,
            kind: 'self-reasoning',
            from: String(th.identity?.identifier ?? merged.selfIdentity ?? 'assistant'),
            createdAt: th.createdAt?.toISO?.() ?? undefined,
          })
          tlTokens += await estimateTokensOf(new Tokenizable(renderedThought), encoding)
        }
        for (const rendered of renderedToolCallResults.values()) {
          if (typeof rendered === 'string') {
            tlTokens += await estimateTokensOf(new Tokenizable(rendered), encoding)
            continue
          }
          // Count EVERY block that is actually transmitted, not just `input_text`. A native
          // `input_image`/`input_file` block carries a base64 payload in `image_url`/`file_data`
          // that is real request content; filtering those out understated the request by the
          // entire attachment, so a prompt the guard accepted could still exceed the provider's
          // window. Tallying the block's own wire JSON keeps this an honest FLOOR (the provider
          // bills images by its own tiling rules, which are not reproducible client-side) rather
          // than a pretend-exact count — same doctrine as the tool-declaration floor below.
          for (const block of rendered) {
            const text =
              block.type === 'input_text' ? block.text : JSON.stringify(block satisfies object)
            tlTokens += await estimateTokensOf(new Tokenizable(text), encoding)
          }
        }
        // Tool-call REQUEST items. A tool call goes on the wire as two sibling items — the
        // `function_call` (carrying `name` + `arguments`) and its `function_call_output` — but only
        // the OUTPUT was tallied above, via `renderedToolCallResults`. A prior call with large
        // arguments was therefore invisible to the guard. Counting the `function_call` item's own
        // wire JSON keeps this the same honest FLOOR as the blocks above.
        for (const tc of ctx.turnToolCalls) {
          const argsText = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {})
          const callItemJson = JSON.stringify({
            type: 'function_call',
            call_id: tc.id,
            name: tc.tool,
            arguments: argsText,
          })
          tlTokens += await estimateTokensOf(new Tokenizable(callItemJson), encoding)
        }
        // Tool DECLARATIONS: tally the tokens of the wire `tools` JSON as an honest FLOOR — same
        // rationale as `openai_chat_completions/adapter.ts`.
        let toolTokens = 0
        const visibleTools = ctx.tools.visible()
        if (visibleTools.length > 0) {
          const toolsJson = JSON.stringify(
            resolvedHelpers.toolsToOpenAIResponsesTools(visibleTools, {
              descriptionToChatCompletionsJsonSchema: (d: unknown) =>
                resolvedHelpers.descriptionToChatCompletionsJsonSchema(d as never),
              strict: merged.strict,
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
          throw new E_OPENAI_RESPONSES_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            encoding,
            perBucket,
          ])
        }
      }

      // ── Step 5b: tool_choice + forged artifact-tools guard ────────────────
      const toolChoice = merged.tool_choice
      const forcedToolNames: string[] = []
      if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
        forcedToolNames.push(toolChoice.name)
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
          throw new E_INVALID_OPENAI_RESPONSES_OPTIONS([
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
          payload: { toolNames: forcedForgedHits.map((h) => h.toolName) },
        })
      }

      // ── Step 6: build request body ────────────────────────────────────────
      const buildInput = async (
        dropReasoning: boolean
      ): Promise<{
        instructions?: string
        input: OpenAIResponsesInputItem[]
        tools?: OpenAIResponsesTool[]
        fingerprintableLength: number
      }> => {
        return resolvedHelpers.buildOpenAIResponsesInput({
          model: merged.model,
          systemPrompt: ctx.systemPrompt,
          // The live dispatch context, so a DYNAMIC system prompt (a `Tokenizable` built from a
          // `(ctx) => string` resolver) sees it. Previously nothing passed this, so such a prompt
          // rendered against `undefined` and quietly dropped everything it read from context.
          renderCtx: ctx,
          standingInstructions: ctx.standingInstructions,
          memories: ctx.turnMemories,
          retrievables: ctx.turnRetrievables,
          messages: ctx.turnMessages,
          thoughts: dropReasoning ? [] : ctx.turnThoughts,
          toolCalls: ctx.turnToolCalls,
          tools: ctx.tools,
          strict: merged.strict,
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
          reasoningReplay: dropReasoning ? 'off' : (merged.reasoningReplay ?? 'off'),
          systemPromptChannel: merged.systemPromptChannel ?? 'instructions',
          unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
          renderOpenAIResponsesToolCallResult: resolvedHelpers.renderOpenAIResponsesToolCallResult,
          renderOpenAIResponsesMediaBlocks: resolvedHelpers.renderOpenAIResponsesMediaBlocks,
          renderChatCompletionsSystemPrompt: resolvedHelpers.renderChatCompletionsSystemPrompt,
          renderStandingInstructions: resolvedHelpers.renderStandingInstructions,
          renderMemories: resolvedHelpers.renderMemories,
          renderRetrievables: resolvedHelpers.renderRetrievables,
          renderRetrievableSafetyDirective: resolvedHelpers.renderRetrievableSafetyDirective,
          renderFirstPartyRetrievables: resolvedHelpers.renderFirstPartyRetrievables,
          renderThirdPartyPublicRetrievables: resolvedHelpers.renderThirdPartyPublicRetrievables,
          renderThirdPartyPrivateRetrievables: resolvedHelpers.renderThirdPartyPrivateRetrievables,
          renderRetrievableHandleBody: resolvedHelpers.renderRetrievableHandleBody,
          renderOpenAIResponsesTimelineMessage:
            resolvedHelpers.renderOpenAIResponsesTimelineMessage,
          renderOpenAIResponsesReasoningItem: resolvedHelpers.renderOpenAIResponsesReasoningItem,
          fingerprintOpenAIResponsesPrefix: resolvedHelpers.fingerprintOpenAIResponsesPrefix,
          toolsToOpenAIResponsesTools: resolvedHelpers.toolsToOpenAIResponsesTools,
          descriptionToChatCompletionsJsonSchema:
            resolvedHelpers.descriptionToChatCompletionsJsonSchema,
          renderThought: resolvedHelpers.renderThought,
          filterThoughts: resolvedHelpers.filterThoughts,
          renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
          renderTrustedContent: resolvedHelpers.renderTrustedContent,
          warn: localWarn,
        })
      }

      let assembled = await buildInput(false)

      const stream = merged.stream ?? true
      const buildBody = (a: {
        instructions?: string
        input: OpenAIResponsesInputItem[]
        tools?: OpenAIResponsesTool[]
      }): OpenAIResponsesRequestBody => {
        const b: OpenAIResponsesRequestBody = {
          model: merged.model,
          input: a.input,
          stream,
          store: false,
        }
        if (a.instructions !== undefined) b.instructions = a.instructions
        for (const [k, v] of Object.entries(merged)) {
          if (ADK_CONTROL_KEYS.has(k)) continue
          if (
            k === 'model' ||
            k === 'input' ||
            k === 'stream' ||
            k === 'store' ||
            k === 'instructions' ||
            k === 'tool_choice' ||
            k === 'tools'
          )
            continue
          if (v === undefined) continue
          ;(b as Record<string, unknown>)[k] = v
        }
        if (merged.tool_choice !== undefined) b.tool_choice = merged.tool_choice
        if (a.tools && a.tools.length > 0) b.tools = a.tools
        // reasoningReplay 'encrypted' auto-adds 'reasoning.encrypted_content' to `include`.
        if (merged.reasoningReplay === 'encrypted') {
          const include = new Set(b.include ?? [])
          include.add('reasoning.encrypted_content')
          b.include = Array.from(include)
        }
        return b
      }

      let body = buildBody(assembled)

      const dispatchStreamId = uuidv6()

      if (merged.onPromptAssembled) {
        try {
          merged.onPromptAssembled({
            battery: 'openai_responses',
            kind: 'request-body',
            messages: body.input,
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
      const url = `${baseURL}/responses`

      const buildHeaders = (): Record<string, string> => {
        const h: Record<string, string> = { 'Content-Type': 'application/json' }
        if (stream) h['Accept'] = 'text/event-stream'
        if (merged.apiKey) h['Authorization'] = `Bearer ${merged.apiKey}`
        if (merged.organization) h['OpenAI-Organization'] = merged.organization
        if (merged.project) h['OpenAI-Project'] = merged.project
        if (merged.headers) Object.assign(h, merged.headers)
        return h
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

      // The one-time reasoning-drop retry (Known Gotcha / recoverable-failure handling) is
      // ORTHOGONAL to the retry/backoff loop below — it re-assembles the request body once (with
      // every reasoning item stripped) and re-enters the whole POST loop fresh, rather than being
      // counted against `maxAttempts`.
      let usedReasoningDropRetry = false

      let response: Response | undefined
      let attempt = 1
      let attemptStartedAtMs = Date.now()
      let disposeLink: () => void = () => {}
      requestLoop: while (attempt <= maxAttempts) {
        if (ctx.abortSignal.aborted) return

        const internalController = new AbortController()
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        // When THIS attempt's HTTP exchange began. `requestTimeoutMs` is a whole-exchange budget,
        // so the body-read deadline further down is measured from here rather than from the moment
        // headers arrived — otherwise a response that spent most of the budget before sending
        // headers was granted a second, full interval to stream its body.
        attemptStartedAtMs = Date.now()
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
            headers: buildHeaders(),
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
            ctx.nack(new E_OPENAI_RESPONSES_REQUEST_TIMEOUT([requestTimeoutMs]))
            return
          }
          helpers.log.error({
            kind: 'transport-error',
            message: `Transport failure on attempt ${attempt}/${maxAttempts}: ${isError(err) ? err.message : String(err)}`,
            payload: { attempt, maxAttempts, detail: isError(err) ? err.message : String(err) },
          })
          if (attempt < maxAttempts) {
            const delay = computeBackoff(attempt, retryCfg)
            await sleepWithJitter(delay, ctx.abortSignal)
            attempt += 1
            continue
          }
          ctx.nack(new E_OPENAI_RESPONSES_HTTP_ERROR([0, isError(err) ? err.message : String(err)]))
          return
        }

        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

        if (!response.ok) {
          const status = response.status
          const errBody = await response.text().catch(() => '')

          // ── Recoverable-failure handling: a rejected REPLAYED reasoning item ──
          //
          // Two upstream 400s mean the same thing — "the reasoning item you replayed is not
          // acceptable" — and both have the same safe recovery: strip every reasoning item and
          // resend. They are handled identically:
          //
          //   1. `invalid_encrypted_content` — a persisted `encrypted_content` payload outlived a
          //      server-side key rotation.
          //   2. A reasoning/output-item PAIRING violation — the adjacency constraint reported in
          //      `openai/openai-node#1791` (see below).
          //
          // Case 2 previously nacked immediately, killing the turn and telling the caller to set
          // `reasoningReplay: 'off'` by hand. That was the wrong default for a failure the adapter
          // can recover from unaided, and it mattered most exactly where the constraint is least
          // certain: the pairing rule is UNDOCUMENTED, and the official docs actively contradict
          // it (the reasoning guide and cookbook both state that irrelevant reasoning items are
          // silently discarded — "including them is harmless"), while #1791 reports a hard 400
          // reproduced across five official SDKs. Because our adjacency sweep enforces a stricter
          // rule than the documented span rule, an upstream behavior shift could make the sweep
          // wrong — and the correct outcome then is a turn that degrades to no-replay, not a turn
          // that dies. The retry is still ONE-SHOT, so a genuinely broken request cannot loop.
          if (
            status === 400 &&
            !usedReasoningDropRetry &&
            bodyMatches(errBody, [INVALID_ENCRYPTED_CONTENT_PHRASE, ...REASONING_PAIRING_PHRASES])
          ) {
            usedReasoningDropRetry = true
            helpers.log.warn({
              kind: 'reasoning-replay-rejected',
              message:
                'Upstream rejected a replayed reasoning item; dropping all reasoning items and retrying once.',
              payload: { status, body: errBody.slice(0, 512) },
            })
            assembled = await buildInput(true)
            body = buildBody(assembled)
            // Give the REBUILT request its own transport-retry budget. Plain `continue` leaves
            // `attempt` where the failed original left it, so a reasoning rejection arriving on the
            // last attempt handed the replacement a fully-spent budget: one transient 503 on the
            // rebuilt request then ended the turn, even though the recovery itself had worked. That
            // contradicts this block's own contract (the reasoning-drop retry is ORTHOGONAL to the
            // retry/backoff loop, not counted against it).
            //
            // Deliberately a FRESH BUDGET, not an unbounded one: `usedReasoningDropRetry` is
            // one-shot, so this reset can happen at most once per dispatch. Worst case is one
            // additional `maxAttempts` worth of POSTs, never a loop.
            attempt = 1
            continue requestLoop
          }

          // ── Reasoning/output-item pairing violation translation ─────────────
          // Reached only when the reasoning-free retry ALSO failed, so the rejection is not
          // attributable to a replayed reasoning item after all — the self-explaining error is
          // then the honest answer rather than a recovery the adapter has already tried.
          if (status === 400 && bodyMatches(errBody, REASONING_PAIRING_PHRASES)) {
            const offendingId =
              assembled.input.find((i): i is OpenAIResponsesReasoningItem => i.type === 'reasoning')
                ?.id ?? 'unknown'
            ctx.nack(new E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED([offendingId, errBody]))
            return
          }

          const retriable = (retryCfg.retriableStatuses ?? [429, 502, 503, 504]).includes(status)
          if (retriable && attempt < maxAttempts) {
            let delay = computeBackoff(attempt, retryCfg)
            if (retryCfg.honorRetryAfter !== false) {
              const ra = response.headers.get('Retry-After')
              if (ra) {
                const raMs = parseRetryAfter(ra)
                if (raMs > 0) delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs ?? 30_000)
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
          helpers.log.error({
            kind: 'http-error',
            message: `HTTP ${status} (terminal): ${errBody.slice(0, 256)}`,
            payload: { status, body: errBody, attempt, maxAttempts, retriable },
          })
          ctx.nack(new E_OPENAI_RESPONSES_HTTP_ERROR([status, errBody]))
          return
        }

        break
      }

      if (!response) return

      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()

      // ── Inner helper: persist + execute one assembled tool call ───────────
      const executeAndPersistToolCall = async (call: {
        id: string
        name: string
        args: string
      }): Promise<void> => {
        const tool = ctx.tools.get(call.name)
        let args: Record<string, unknown> = {}
        let parseError: InstanceType<typeof E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS> | undefined
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
              parseError = new E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS([
                `must be a JSON object; received ${receivedKind}`,
                call.args,
              ])
            }
          } catch {
            parseError = new E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS([
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
          helpers.reportToolCall(call.id, { results, isError: true, isComplete: true })
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
          helpers.reportToolCall(call.id, { results, isError: true, isComplete: true })
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
        helpers.reportToolCall(call.id, { results, isError: toolHadError, isComplete: true })
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
            inline: isArtifactTool,
            createdAt: completedAt2,
            updatedAt: completedAt2,
            completedAt: completedAt2,
          })
        )
      }

      // FALLBACK tool-call recovery — consulted only when the provider returned zero structured
      // calls AND the caller opted in via `localToolCallParser`.
      const parseFallbackToolCalls = (
        content: string
      ): Array<{ id: string; name: string; args: string }> => {
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

      const selfIdentity = merged.selfIdentity ?? 'assistant'

      // The wire shape a persisted reasoning item will actually REPLAY as, which is what the next
      // turn's adjacency sweep hashes. Under `summary-only` the renderer strips `content` and
      // `encrypted_content` (see `renderOpenAIResponsesReasoningItem`), so an accumulator that
      // recorded the FULL item produced a prefix the sweep never reproduces and every later item
      // dropped as stale. Building the replay shape here keeps persist and validate in agreement
      // for every mode.
      const replayShapeOf = (slot: {
        itemId: string
        summaryText: string
        reasoningText: string
        encryptedContent?: string
      }): OpenAIResponsesInputItem => {
        const summaryOnly = merged.reasoningReplay === 'summary-only'
        return {
          type: 'reasoning',
          id: normalizeOpenAIResponsesItemId(slot.itemId, 'rs'),
          summary:
            slot.summaryText.length > 0 ? [{ type: 'summary_text', text: slot.summaryText }] : [],
          ...(!summaryOnly && slot.reasoningText.length > 0
            ? { content: [{ type: 'reasoning_text', text: slot.reasoningText }] }
            : {}),
          ...(!summaryOnly && slot.encryptedContent
            ? { encrypted_content: slot.encryptedContent }
            : {}),
        }
      }

      // ── Persist a reasoning Thought from a finalized thinking slot ─────────
      const persistThought = async (
        slot: {
          itemId: string
          summaryText: string
          reasoningText: string
          encryptedContent?: string
        },
        pairedItemId: string | undefined,
        // Explicit timestamp so a caller draining several slots can order them monotonically —
        // see `stampFor` in the streaming drain. Defaults to "now" for the non-streaming path.
        stamp: string = nowIso(),
        // Items produced EARLIER IN THIS SAME RESPONSE that will sit between the request prefix
        // and this reasoning item once the whole response is replayed on the next turn.
        //
        // Without this, a response carrying two or more reasoning items replayed only the FIRST.
        // Every item's fingerprint was taken over the request prefix alone, but the next turn's
        // adjacency sweep re-derives each candidate's hash through its OWN position — which for
        // the second reasoning item includes the first reasoning item and its paired message. The
        // hashes could not match, so every item after the first was dropped as stale.
        precedingReplayItems: OpenAIResponsesInputItem[] = []
      ): Promise<void> => {
        const content = slot.reasoningText.length > 0 ? slot.reasoningText : slot.summaryText
        let payload: OpenAIResponsesReasoningReplayPayload | undefined
        if (merged.reasoningReplay !== 'off') {
          const item: OpenAIResponsesReasoningItem = {
            type: 'reasoning',
            id: normalizeOpenAIResponsesItemId(slot.itemId, 'rs'),
            summary:
              slot.summaryText.length > 0 ? [{ type: 'summary_text', text: slot.summaryText }] : [],
            ...(slot.reasoningText.length > 0
              ? { content: [{ type: 'reasoning_text', text: slot.reasoningText }] }
              : {}),
            ...(slot.encryptedContent ? { encrypted_content: slot.encryptedContent } : {}),
          }
          const prefixFingerprint = await resolvedHelpers.fingerprintOpenAIResponsesPrefix({
            model: merged.model,
            instructions: assembled.instructions,
            // Pass `assembled.tools` THROUGH, without an `?? []` fallback: the next turn's
            // adjacency sweep re-derives this hash against the same `undefined`-when-empty shape.
            // Coercing to `[]` here hashes different bytes than the sweep does and drops every
            // replayed reasoning item as stale whenever no tools are registered.
            tools: assembled.tools,
            // Hash the sweep-visible request prefix PLUS whatever this same response already
            // contributed ahead of this item (see `precedingReplayItems`). On the next turn the
            // sweep hashes exactly this sequence when it reaches this item's position.
            //
            // `throughItem` is the length of that combined array: the sweep-visible region of the
            // request (a trailing-bucket item is appended AFTER the sweep runs, so it is absent
            // from every prefix the sweep hashes — including it here would guarantee a mismatch
            // whenever `bucketOrder` puts a non-empty bucket after `'timeline'`) plus the
            // preceding items from this response.
            input: [
              ...assembled.input.slice(0, assembled.fingerprintableLength),
              ...precedingReplayItems,
            ],
            throughItem: assembled.fingerprintableLength + precedingReplayItems.length,
          })
          payload = {
            variant: 'responses-reasoning',
            item,
            pairedItemId,
            prefixFingerprint,
          }
        }
        await ctx.storeThought(
          new Thought({
            id: slot.itemId,
            content,
            identity: selfIdentity,
            payload,
            replayCompatibility: payload ? 'openai-responses-reasoning-v1' : undefined,
            createdAt: stamp,
            updatedAt: stamp,
          })
        )
      }

      // ── Step 8: streaming path ────────────────────────────────────────────
      if (stream) {
        if (!response.body) {
          ctx.nack(new E_OPENAI_RESPONSES_STREAM_ERROR(['response has no body']))
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const slotMachine = resolvedHelpers.createResponsesOutputSlotMachine()
        const streamId = dispatchStreamId

        let buffer = ''
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        let stalled = false
        let terminalSeen = false
        let terminalStatus: OpenAIResponsesResponseObject['status'] | undefined
        let incompleteReason: string | undefined
        let finalUsage: OpenAIResponsesResponseObject['usage'] | undefined
        let finalModel: string | undefined
        let finalRaw: Record<string, unknown> = {}
        const collectedToolCalls: Array<{ id: string; name: string; args: string }> = []
        let sawMessageDelta = false

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
          // Persist every open text / thinking slot.
          const orderedIndices = Array.from(slotMachine.slots().keys()).sort((a, b) => a - b)
          // Timestamps are derived MONOTONICALLY from each slot's position in output-index order,
          // never from independent `nowIso()` calls. Two back-to-back `nowIso()` calls return an
          // identical ISO string ~998 times in 1000, and `buildOpenAIResponsesInput` pushes
          // messages into the timeline before thoughts and then stable-sorts by `createdAt` — so
          // on a tie the assistant message sorted AHEAD of its own reasoning item, leaving that
          // item last with nothing after it, and the adjacency sweep dropped it as unpaired. That
          // made reasoning replay fail most of the time even under the default configuration.
          const drainBaseMs = DateTime.now().toMillis()
          // Same multi-reasoning accumulator as the non-streaming path: items from THIS response
          // that will precede a later reasoning item once the whole response replays next turn.
          const replayedSoFar: OpenAIResponsesInputItem[] = []
          const stampFor = (pos: number): string =>
            DateTime.fromMillis(drainBaseMs + pos).toISO() ??
            new Date(drainBaseMs + pos).toISOString()
          for (const [pos, idx] of orderedIndices.entries()) {
            const slot = slotMachine.getSlot(idx)
            if (!slot) continue
            if (slot.kind === 'text') {
              if (slot.text.length > 0 || slot.refusal.length > 0) {
                sawMessageDelta = true
                const text = slot.refusal.length > 0 ? slot.refusal : slot.text
                helpers.reportMessage(slot.itemId || streamId, '', { isComplete: true })
                await ctx.storeMessage(
                  new Message({
                    id: slot.itemId || streamId,
                    role: 'assistant',
                    content: text,
                    identity: selfIdentity,
                    createdAt: stampFor(pos),
                    updatedAt: stampFor(pos),
                  })
                )
                replayedSoFar.push({
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  id: slot.itemId || streamId,
                  content: [{ type: 'output_text', text, annotations: [] }],
                })
              }
            } else if (slot.kind === 'thinking') {
              helpers.reportThought(slot.itemId || streamId, '', { isComplete: true })
              // `pairedItemId` records the id of the item that FOLLOWS this reasoning item on the
              // wire (per its own contract in types.ts) — look ahead to the next slot in output-index
              // order, not back at whatever slot preceded this one.
              const nextIdx = orderedIndices[pos + 1]
              const nextSlot = nextIdx !== undefined ? slotMachine.getSlot(nextIdx) : undefined
              const pairedItemId = nextSlot?.itemId
              await persistThought(slot, pairedItemId, stampFor(pos), [...replayedSoFar])
              replayedSoFar.push(replayShapeOf(slot))
            } else if (slot.kind === 'toolCall') {
              collectedToolCalls.push({
                id: `${slot.callId}|${slot.itemId}`,
                name: slot.name,
                args: slot.args,
              })
            }
          }

          if (finalUsage !== undefined || terminalStatus !== undefined) {
            const calls = collectedToolCalls.length > 0
            helpers.reportGenerationStats(
              extractGenerationStats({
                model: finalModel ?? merged.model,
                usage: finalUsage,
                finishReason: mapStopReason(terminalStatus, incompleteReason, calls),
                raw:
                  Object.keys(finalRaw).length > 0
                    ? finalRaw
                    : { usage: finalUsage, status: terminalStatus },
              })
            )
          }

          const nativeCalls = collectedToolCalls
          const combinedText = Array.from(slotMachine.slots().values())
            .filter((s): s is Extract<typeof s, { kind: 'text' }> => s.kind === 'text')
            .map((s) => (s.refusal.length > 0 ? s.refusal : s.text))
            .join('')
          const calls = nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(combinedText)

          if (merged.onRawGeneration) {
            try {
              merged.onRawGeneration({
                rawText: combinedText,
                cleanedText: combinedText,
                reasoning: Array.from(slotMachine.slots().values())
                  .filter(
                    (s): s is Extract<typeof s, { kind: 'thinking' }> => s.kind === 'thinking'
                  )
                  .map((s) => (s.reasoningText.length > 0 ? s.reasoningText : s.summaryText)),
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
            kind: 'stream-finalised',
            message: `Stream finalised: ${calls.length} tool call(s), message=${sawMessageDelta}`,
            payload: { toolCallCount: calls.length, sawMessageDelta, terminalSeen },
          })

          if (calls.length === 0) {
            if (merged.autoAck) ctx.ack()
            return
          }
          for (const call of calls) {
            if (ctx.abortSignal.aborted) return
            await executeAndPersistToolCall(call)
          }
        }

        // Processes one SSE frame's `data:` lines. Returns `'stop'` once a terminal event (or a
        // fatal stream-level error) has been handled — the caller must stop reading and return
        // immediately — or `'continue'` otherwise. Extracted so the SAME logic can run once more
        // on whatever is left in `buffer` after EOF (Known finding: a final frame lacking its
        // trailing blank-line separator was previously left unprocessed and silently dropped).
        const processFrame = async (frame: string): Promise<'stop' | 'continue'> => {
          // Per the SSE spec an event's `data:` FIELDS are concatenated (newline-separated) and the
          // result parsed ONCE — a single JSON value may legally be split across several `data:`
          // lines. Parsing each line independently produced two invalid JSON fragments and silently
          // skipped both, losing the whole event. OpenAI does not split events today, but an
          // intermediary may, exactly as one already forced the CRLF handling above.
          //
          // Concatenating per frame is a superset of the previous behaviour for the single-line
          // case (one field joins to itself), so nothing that parsed before stops parsing.
          const dataLines = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
          for (const data of dataLines.length > 1 ? [dataLines.join('\n')] : dataLines) {
            if (data.length === 0) continue
            let payload: OpenAIResponsesStreamEvent
            try {
              payload = JSON.parse(data) as OpenAIResponsesStreamEvent
            } catch {
              helpers.log.trace({
                kind: 'sse-parse-failure',
                message: 'Failed to parse SSE chunk as JSON; skipping',
                payload: { dataPreview: data.slice(0, 256) },
              })
              continue
            }
            // The union's structural fallback member (`OpenAIResponsesStreamEventBase &
            // Record<string, unknown>`, covering every event type this battery does not act
            // on) carries a loose `type: string`, which prevents TypeScript from narrowing the
            // discriminant inside a `switch` the way it would for a "closed" union — the same
            // issue documented in `helpers.ts`'s output-slot-machine `openSlot`/`finalizeSlot`.
            // Cast to the specific event type inside each case rather than rely on narrowing.
            switch (payload.type) {
              case 'response.output_item.added': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.output_item.added' }
                >
                const slot = slotMachine.openSlot(ev.output_index, ev.item)
                if (!slot) {
                  helpers.log.debug({
                    kind: 'unhandled-output-item',
                    message: `No slot opened for output item type "${ev.item.type}" at index ${ev.output_index}`,
                    payload: { itemType: ev.item.type, outputIndex: ev.output_index },
                  })
                }
                break
              }
              case 'response.output_text.delta': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.output_text.delta' }
                >
                slotMachine.appendText(ev.output_index, ev.delta)
                sawMessageDelta = true
                helpers.reportMessage(String(ev.item_id || streamId), ev.delta)
                break
              }
              case 'response.refusal.delta': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.refusal.delta' }
                >
                slotMachine.appendRefusal(ev.output_index, ev.delta)
                sawMessageDelta = true
                helpers.reportMessage(String(ev.item_id || streamId), ev.delta)
                break
              }
              case 'response.reasoning_summary_text.delta': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.reasoning_summary_text.delta' }
                >
                slotMachine.appendReasoningSummary(ev.output_index, ev.delta)
                helpers.reportThought(String(ev.item_id || streamId), ev.delta)
                break
              }
              case 'response.reasoning_text.delta': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.reasoning_text.delta' }
                >
                slotMachine.appendReasoningText(ev.output_index, ev.delta)
                helpers.reportThought(String(ev.item_id || streamId), ev.delta)
                break
              }
              case 'response.function_call_arguments.delta': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.function_call_arguments.delta' }
                >
                slotMachine.appendFunctionCallArgumentsDelta(ev.output_index, ev.delta)
                break
              }
              case 'response.function_call_arguments.done': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.function_call_arguments.done' }
                >
                slotMachine.setFunctionCallArgumentsDone(ev.output_index, ev.arguments)
                break
              }
              case 'response.output_item.done': {
                // The ONLY point at which a reasoning item's encrypted_content is captured
                // (Known Gotcha #3) — never at `.added`, before it's populated.
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.output_item.done' }
                >
                slotMachine.finalizeSlot(ev.output_index, ev.item)
                break
              }
              case 'response.completed':
              case 'response.incomplete': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.completed' | 'response.incomplete' }
                >
                terminalSeen = true
                terminalStatus = ev.response.status
                incompleteReason = ev.response.incomplete_details?.reason ?? undefined
                finalUsage = ev.response.usage
                finalModel = ev.response.model
                finalRaw = { ...ev.response } as unknown as Record<string, unknown>
                // Backfill `encrypted_content` from the terminal event's own `response.output`
                // for any reasoning item whose `.done` event omitted it.
                const output = ev.response.output ?? []
                for (const [i, item] of output.entries()) {
                  if (item && item.type === 'reasoning') {
                    const reasoningItem = item as OpenAIResponsesReasoningItem
                    if (reasoningItem.encrypted_content) {
                      slotMachine.backfillEncryptedContent(i, reasoningItem.encrypted_content)
                    }
                  }
                }
                clearIdleTimer()
                await drainAndPersist()
                return 'stop'
              }
              case 'response.failed': {
                const ev = payload as Extract<
                  OpenAIResponsesStreamEvent,
                  { type: 'response.failed' }
                >
                terminalSeen = true
                clearIdleTimer()
                const msg = ev.response.error?.message ?? 'response.failed'
                ctx.nack(new E_OPENAI_RESPONSES_STREAM_ERROR([msg]))
                return 'stop'
              }
              case 'error': {
                const ev = payload as Extract<OpenAIResponsesStreamEvent, { type: 'error' }>
                terminalSeen = true
                clearIdleTimer()
                ctx.nack(new E_OPENAI_RESPONSES_STREAM_ERROR([ev.message]))
                return 'stop'
              }
              default:
                // Every other event type (response.created, .in_progress,
                // content_part.added/.done, hosted-tool progress events, etc.) — not acted on.
                break
            }
          }
          return 'continue'
        }

        // `requestTimeoutMs` bounds the COMPLETE HTTP exchange, not just the headers. The
        // per-attempt timer above is cleared as soon as `fetch` resolves — which happens on
        // headers — so without this a response whose BODY then stalls waits forever whenever
        // `streamIdleTimeoutMs` is unset (verified: with `requestTimeoutMs: 300` and a body that
        // never yields a byte, the dispatch hung indefinitely). The deadline is measured from the
        // START OF THE ATTEMPT (not from when headers arrived) and races every `reader.read()`,
        // so slow headers and a slow body share one budget rather than getting one each.
        const bodyTimeoutMs = merged.requestTimeoutMs ?? 0
        const bodyDeadline = bodyTimeoutMs > 0 ? attemptStartedAtMs + bodyTimeoutMs : undefined
        const readWithDeadline = async (): Promise<
          ReadableStreamReadResult<Uint8Array> | 'timeout'
        > => {
          if (bodyDeadline === undefined) return reader.read()
          const remaining = bodyDeadline - Date.now()
          if (remaining <= 0) return 'timeout'
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              reader.read(),
              new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), remaining)
              }),
            ])
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        }

        try {
          armIdleTimer()
          while (true) {
            const read = await readWithDeadline()
            if (read === 'timeout') {
              clearIdleTimer()
              reader.cancel().catch(() => {
                /* swallow */
              })
              helpers.log.warn({
                kind: 'request-timeout',
                message: `Response body exceeded requestTimeoutMs (${bodyTimeoutMs}ms) while streaming`,
                payload: { requestTimeoutMs: bodyTimeoutMs },
              })
              ctx.nack(new E_OPENAI_RESPONSES_REQUEST_TIMEOUT([bodyTimeoutMs]))
              return
            }
            const { done, value } = read
            if (done) break
            armIdleTimer()
            if (ctx.abortSignal.aborted) {
              clearIdleTimer()
              return
            }
            buffer += decoder.decode(value, { stream: true })
            let sepMatch = SSE_FRAME_SEPARATOR.exec(buffer)
            while (sepMatch !== null) {
              const frame = buffer.slice(0, sepMatch.index)
              buffer = buffer.slice(sepMatch.index + sepMatch[0].length)
              if ((await processFrame(frame)) === 'stop') return
              sepMatch = SSE_FRAME_SEPARATOR.exec(buffer)
            }
          }
          // EOF: flush the decoder's own internal state (a dangling multi-byte UTF-8 sequence split
          // across the last two chunks) and process whatever is left in `buffer` as one final frame
          // even without its own trailing blank-line separator — a terminal event (or any other
          // event) arriving as the very last bytes of the stream, with no `\n\n` after it, was
          // previously left sitting in `buffer` and silently dropped when the loop broke.
          buffer += decoder.decode()
          if (buffer.trim().length > 0) {
            const finalFrame = buffer
            buffer = ''
            if ((await processFrame(finalFrame)) === 'stop') return
          }
          clearIdleTimer()
          if (stalled) {
            // DELIBERATE ASYMMETRY with the EOF path below: a stall DISCARDS accumulated state
            // rather than draining it, even though both arrive here holding the same partial slots.
            //
            // The difference is what the two conditions tell you about the stream. EOF means the
            // provider CLOSED it — the turn is over and whatever arrived is all there will ever be,
            // so draining preserves a complete-if-short answer. A stall means the connection is
            // still OPEN and simply quiet: more content may well be in flight, and the reader is
            // being cancelled underneath it. Persisting a mid-sentence fragment as though it were
            // the model's answer would put text into history that the model never finished, which
            // the next turn would then treat as a completed assistant turn.
            //
            // The nack is therefore the whole outcome: the caller retries the turn rather than
            // inheriting a truncated answer. Same treatment in `openai_chat_completions` and
            // `anthropic_messages` — the convention was previously undocumented in all three,
            // which reads as an oversight rather than a choice, so it is stated here.
            ctx.nack(new E_OPENAI_RESPONSES_STREAM_STALLED([idleMs]))
            return
          }
          if (!terminalSeen) {
            helpers.log.warn({
              kind: 'sse-eof-without-terminal-event',
              message:
                'SSE stream ended without a terminal event (response.completed/.incomplete/.failed); draining accumulated state',
            })
            await drainAndPersist()
          }
        } catch (err) {
          clearIdleTimer()
          if (ctx.abortSignal.aborted) return
          if (stalled) {
            ctx.nack(new E_OPENAI_RESPONSES_STREAM_STALLED([idleMs]))
            return
          }
          helpers.log.error({
            kind: 'stream-error',
            message: `SSE stream failed: ${isError(err) ? err.message : String(err)}`,
            payload: { detail: isError(err) ? err.message : String(err) },
          })
          ctx.nack(new E_OPENAI_RESPONSES_STREAM_ERROR([isError(err) ? err.message : String(err)]))
          return
        }
        return
      }

      // ── Step 9: non-streaming path ────────────────────────────────────────
      let parsed: OpenAIResponsesResponseObject
      try {
        // `response.json()` consumes the BODY, and the per-attempt timer was cleared the moment
        // `fetch` resolved (which happens on headers) — so a response whose body then stalls hung
        // forever here despite a configured `requestTimeoutMs`. Verified before fixing: with
        // `requestTimeoutMs: 200` and a body that never yields a byte, the dispatch never returned.
        //
        // Bounded by the SAME whole-exchange deadline the streaming path uses (measured from
        // `attemptStartedAtMs`, not from when headers arrived), so slow headers and a slow body
        // share one budget rather than getting one each.
        const jsonTimeoutMs = merged.requestTimeoutMs ?? 0
        if (jsonTimeoutMs > 0) {
          const remaining = attemptStartedAtMs + jsonTimeoutMs - Date.now()
          let timer: ReturnType<typeof setTimeout> | undefined
          const timedOut = Symbol('timeout')
          const raced = await Promise.race([
            response.json(),
            new Promise<typeof timedOut>((resolve) => {
              timer = setTimeout(() => resolve(timedOut), Math.max(0, remaining))
            }),
          ]).finally(() => {
            if (timer !== undefined) clearTimeout(timer)
          })
          if (raced === timedOut) {
            helpers.log.warn({
              kind: 'request-timeout',
              message: `Response body exceeded requestTimeoutMs (${jsonTimeoutMs}ms) while parsing`,
              payload: { requestTimeoutMs: jsonTimeoutMs },
            })
            ctx.nack(new E_OPENAI_RESPONSES_REQUEST_TIMEOUT([jsonTimeoutMs]))
            return
          }
          parsed = raced as OpenAIResponsesResponseObject
        } else {
          parsed = (await response.json()) as OpenAIResponsesResponseObject
        }
      } catch (err) {
        ctx.nack(new E_OPENAI_RESPONSES_STREAM_ERROR([isError(err) ? err.message : String(err)]))
        return
      }

      const output = parsed.output ?? []
      const responseId = parsed.id ?? uuidv6()

      const nativeCalls: Array<{ id: string; name: string; args: string }> = []
      let combinedText = ''
      // Same monotonic-timestamp scheme as the streaming drain: derive each persisted record's
      // stamp from its position in `output` rather than calling `nowIso()` per item. Independent
      // calls collide on the same millisecond ~998 times in 1000, and a tie lets the assistant
      // message sort ahead of its own reasoning item (messages are pushed into the timeline before
      // thoughts, then stable-sorted), orphaning it so the adjacency sweep drops it.
      const outputBaseMs = DateTime.now().toMillis()
      const stampAt = (pos: number): string =>
        DateTime.fromMillis(outputBaseMs + pos).toISO() ??
        new Date(outputBaseMs + pos).toISOString()
      // Deliberately does NOT include `function_call`/`function_call_output` items from this
      // response, despite a review finding asking for them. A `ToolCall` is stamped with
      // `createdAt = completedAt` at EXECUTION time — after every item in the response that
      // requested it — and `buildOpenAIResponsesInput` orders the timeline by `createdAt`. So an
      // in-response tool call sorts AFTER the reasoning item, not before it. Verified on the wire:
      // turn 2 assembled as `role:user | message | function_call | function_call_output`, with the
      // tool call last. Adding it to the prefix would corrupt a hash that currently matches.
      // Items from THIS response that will precede the next reasoning item once the whole response
      // is replayed next turn, in the same wire shapes `buildOpenAIResponsesInput` emits: a
      // replayed reasoning item verbatim, and own-assistant text as the OUTPUT-message shape
      // (`renderOwnAssistantOutputItem`). Passed to `persistThought` so each item's fingerprint
      // covers the prefix the adjacency sweep will actually see at its position — without it, only
      // the first reasoning item in a multi-reasoning response ever replayed.
      const replayedSoFar: OpenAIResponsesInputItem[] = []
      for (const [i, item] of output.entries()) {
        if (!item) continue
        if (item.type === 'message') {
          const msgItem = item as Extract<typeof item, { type: 'message' }>
          const parts: string[] = []
          let refusal = ''
          for (const part of msgItem.content) {
            if (part.type === 'output_text') parts.push(part.text)
            else if (part.type === 'refusal') refusal = part.refusal
          }
          const text = refusal.length > 0 ? refusal : parts.join('')
          combinedText += text
          if (text.length > 0) {
            const messageId = msgItem.id ?? `${responseId}:message:${i}`
            helpers.reportMessage(messageId, text, { isComplete: true })
            await ctx.storeMessage(
              new Message({
                id: messageId,
                role: 'assistant',
                content: text,
                identity: selfIdentity,
                createdAt: stampAt(i),
                updatedAt: stampAt(i),
              })
            )
            // Own-assistant text replays as the OUTPUT-message shape, so record it in that exact
            // form for any later reasoning item's fingerprint prefix.
            replayedSoFar.push({
              type: 'message',
              role: 'assistant',
              status: 'completed',
              id: messageId,
              content: [{ type: 'output_text', text, annotations: [] }],
            })
          }
        } else if (item.type === 'reasoning') {
          const reasoningItem = item as OpenAIResponsesReasoningItem
          const summaryText = (reasoningItem.summary ?? []).map((s) => s.text).join('\n\n')
          const reasoningText = (reasoningItem.content ?? []).map((c) => c.text).join('\n\n')
          const thoughtId = reasoningItem.id
          helpers.reportThought(thoughtId, reasoningText.length > 0 ? reasoningText : summaryText, {
            isComplete: true,
          })
          // `pairedItemId` records the id of the item that FOLLOWS this reasoning item on the wire
          // (per its own contract in types.ts) — look ahead to the next output entry, not back at
          // whatever preceded this one.
          // `output[i + 1]` may be NULL, not merely undefined — the array is provider-supplied and
          // its element type is nullable, which is exactly why the loop head guards with
          // `if (!item) continue`. That guard does not cover this LOOKAHEAD: `'id' in null` throws
          // `TypeError: Cannot use 'in' operator to search for 'id' in null`, killing the whole
          // dispatch (no message persisted, no thought persisted, turn lost) whenever a null sits
          // between a reasoning item and its paired output item. A truthiness check covers null and
          // undefined together.
          const nextItem = output[i + 1]
          const pairedItemId = nextItem && 'id' in nextItem ? nextItem.id : undefined
          await persistThought(
            {
              itemId: reasoningItem.id,
              summaryText,
              reasoningText,
              ...(reasoningItem.encrypted_content
                ? { encryptedContent: reasoningItem.encrypted_content }
                : {}),
            },
            pairedItemId,
            stampAt(i),
            [...replayedSoFar]
          )
          // This item will itself precede any LATER reasoning item on replay.
          replayedSoFar.push(
            replayShapeOf({
              itemId: reasoningItem.id,
              summaryText,
              reasoningText,
              ...(reasoningItem.encrypted_content
                ? { encryptedContent: reasoningItem.encrypted_content }
                : {}),
            })
          )
        } else if (item.type === 'function_call') {
          const fcItem = item as OpenAIResponsesFunctionCallItem
          nativeCalls.push({
            id: fcItem.id ? `${fcItem.call_id}|${fcItem.id}` : fcItem.call_id,
            name: fcItem.name,
            args: fcItem.arguments,
          })
        } else {
          // Hosted/unrecognized output item type — never replayed, debug-log only.
          helpers.log.debug({
            kind: 'unhandled-output-item',
            message: `Unhandled output item type "${item.type}" at index ${i}`,
            payload: { itemType: item.type, index: i },
          })
        }
      }

      if (isObject(parsed.usage) || typeof parsed.status === 'string') {
        helpers.reportGenerationStats(
          extractGenerationStats({
            model: parsed.model ?? merged.model,
            usage: parsed.usage,
            finishReason: mapStopReason(
              parsed.status,
              parsed.incomplete_details?.reason ?? undefined,
              nativeCalls.length > 0
            ),
            raw: { ...parsed } as unknown as Record<string, unknown>,
          })
        )
      }

      if (parsed.status === 'failed' || parsed.status === 'cancelled') {
        const msg = parsed.error?.message ?? `response ${parsed.status}`
        ctx.nack(new E_OPENAI_RESPONSES_STREAM_ERROR([msg]))
        return
      }

      const calls = nativeCalls.length > 0 ? nativeCalls : parseFallbackToolCalls(combinedText)

      if (merged.onRawGeneration) {
        try {
          merged.onRawGeneration({
            rawText: combinedText,
            cleanedText: combinedText,
            reasoning: output
              .filter((i): i is OpenAIResponsesReasoningItem => i?.type === 'reasoning')
              .map(
                (i) =>
                  (i.content ?? []).map((c) => c.text).join('\n\n') ||
                  (i.summary ?? []).map((s) => s.text).join('\n\n')
              ),
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
   * Returns `true` when `value` is an {@link OpenAIResponsesAdapter} instance.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is an `OpenAIResponsesAdapter` instance.
   */
  public static isOpenAIResponsesAdapter(value: unknown): value is OpenAIResponsesAdapter {
    return isInstanceOf(value, 'OpenAIResponsesAdapter', OpenAIResponsesAdapter)
  }
}
