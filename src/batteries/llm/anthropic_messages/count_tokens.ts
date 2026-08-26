/**
 * Token-count helpers for the Anthropic Messages battery.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/count_tokens
 */

import { validateOptions } from './validation'
import { APIError } from '@anthropic-ai/sdk/core/error'
import { default as Anthropic } from '@anthropic-ai/sdk'
import { isInstanceOf, isObject } from '@nhtio/adk/guards'
import { translateAnthropicError } from './error_translation'
import { DispatchContext, isDispatchContext } from '@nhtio/adk'
import {
  computeBackoff,
  sleepWithJitter,
  parseRetryAfter,
  linkAbortSignals,
} from '../../../lib/utils/retry'
import {
  E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW,
  E_ANTHROPIC_MESSAGES_HTTP_ERROR,
  E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT,
  E_INVALID_ANTHROPIC_MESSAGES_OPTIONS,
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
  defaultRenderAnthropicTimelineMessage,
  defaultRenderAnthropicMediaBlocks,
  defaultRenderAnthropicToolCallResult,
  defaultRenderAnthropicSegmentedSystemPrompt,
  defaultRenderAnthropicThinkingBlocks,
  defaultBuildAnthropicMessagesHistory,
  anthropicToolsFromTools,
} from './helpers'
import type { DispatchExecutorLogChannel } from '@nhtio/adk'
import type {
  AnthropicMessageCountTokensParams,
  AnthropicMessagesAdapterOptions,
  AnthropicMessagesCountTokensInput,
  AnthropicMessagesHelpers,
  AnthropicMessageParam,
  AnthropicTextBlockParam,
  AnthropicTool,
  AnthropicMessageTokensCount,
} from './types'

const ANTHROPIC_MESSAGES_STASH_KEY = 'anthropicMessages' as const
const SDK_TIMEOUT_MARGIN_MS = 30_000
const SDK_TIMEOUT_SENTINEL_MS = 24 * 60 * 60 * 1000
const UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS = [
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
] as const

/**
 * Public count-token input shape accepted by the exported helpers.
 */
export type AnthropicMessagesCountTokensRequestInput =
  | DispatchContext
  | {
      /** Pre-built Anthropic messages to count. */
      messages: AnthropicMessageParam[]
      /** Optional pre-built Anthropic system prompt to count. */
      system?: string | AnthropicTextBlockParam[]
      /** Optional pre-built Anthropic tool definitions to count. */
      tools?: AnthropicTool[]
    }

/**
 * Optional dependencies for the count-token helpers.
 */
export interface AnthropicMessagesCountTokensDeps {
  /** Structured log channel used for warn-and-send diagnostics. */
  log?: DispatchExecutorLogChannel
}

const noop = (): void => {}

const noopLog: DispatchExecutorLogChannel = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

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

const collectUnsupportedSchemaKeywords = (value: unknown, acc: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectUnsupportedSchemaKeywords(item, acc)
    return
  }
  if (!isObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if ((UNSUPPORTED_OUTPUT_SCHEMA_KEYWORDS as readonly string[]).includes(key)) acc.add(key)
    collectUnsupportedSchemaKeywords(child, acc)
  }
}

const warnOnUnsupportedOutputSchemaKeywords = (
  outputConfig: AnthropicMessagesAdapterOptions['outputConfig'],
  log: DispatchExecutorLogChannel
): void => {
  if (!isObject(outputConfig)) return
  if (!('format' in outputConfig)) return
  const found = new Set<string>()
  collectUnsupportedSchemaKeywords(outputConfig.format, found)
  if (found.size === 0) return
  log.warn({
    kind: 'anthropic-output-config-schema-keywords',
    message:
      'Anthropic output_config.format contains JSON Schema keywords Anthropic rejects; sending the schema unmodified.',
    payload: { keywords: Array.from(found).sort() },
  })
}

const isPrebuiltCountTokensInput = (
  input: AnthropicMessagesCountTokensRequestInput | AnthropicMessagesCountTokensInput
): input is {
  messages: AnthropicMessageParam[]
  system?: string | AnthropicTextBlockParam[]
  tools?: AnthropicTool[]
} => {
  if (!isObject(input)) return false
  if (isDispatchContext(input)) return false
  if ('context' in input && 'messages' in input) {
    throw new E_INVALID_ANTHROPIC_MESSAGES_OPTIONS([
      'countTokens input must not include both context and messages',
    ])
  }
  return 'messages' in input
}

const getDispatchContextFromInput = (
  input: AnthropicMessagesCountTokensRequestInput | AnthropicMessagesCountTokensInput
): DispatchContext | undefined => {
  if (isDispatchContext(input)) return input
  if (isObject(input) && 'context' in input && isDispatchContext(input.context))
    return input.context
  return undefined
}

const assembleCountTokensPayload = async (
  resolved: AnthropicMessagesAdapterOptions,
  input: AnthropicMessagesCountTokensRequestInput | AnthropicMessagesCountTokensInput,
  log: DispatchExecutorLogChannel
): Promise<{
  messages: AnthropicMessageParam[]
  system?: string | AnthropicTextBlockParam[]
  tools?: AnthropicTool[]
  abortSignal?: AbortSignal
}> => {
  if (isPrebuiltCountTokensInput(input)) {
    return {
      messages: input.messages,
      system: input.system,
      tools: input.tools,
    }
  }

  const context = getDispatchContextFromInput(input)

  if (context === undefined) {
    throw new E_INVALID_ANTHROPIC_MESSAGES_OPTIONS([
      'countTokens input must be a DispatchContext or a pre-built Anthropic shape with messages',
    ])
  }

  const resolvedHelpers = resolveHelpers(resolved.helpers)
  const localWarn = (msg: string): void => {
    log.warn({ kind: 'helper-warning', message: msg })
  }

  const renderedToolCallResults = new Map<
    string,
    Awaited<ReturnType<AnthropicMessagesHelpers['renderAnthropicToolCallResult']>>
  >()
  for (const tc of context.turnToolCalls) {
    const rendered = await resolvedHelpers.renderAnthropicToolCallResult({
      toolCall: tc,
      results: tc.results as never,
      tool: context.tools.get(tc.tool),
      renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
      renderTrustedContent: resolvedHelpers.renderTrustedContent,
      renderAnthropicMediaBlocks: resolvedHelpers.renderAnthropicMediaBlocks,
      unsupportedMediaPolicy: resolved.unsupportedMediaPolicy ?? 'throw',
      warn: localWarn,
    })
    renderedToolCallResults.set(tc.id, rendered)
  }

  const built = await resolvedHelpers.buildAnthropicMessagesHistory({
    model: resolved.model,
    systemPrompt: context.systemPrompt,
    standingInstructions: context.standingInstructions,
    memories: context.turnMemories,
    retrievables: context.turnRetrievables,
    messages: context.turnMessages,
    thoughts: context.turnThoughts,
    toolCalls: context.turnToolCalls,
    tools: context.tools,
    renderedToolCallResults,
    bucketOrder: resolved.bucketOrder ?? [
      'standingInstructions',
      'memories',
      'retrievables',
      'timeline',
    ],
    selfIdentity: resolved.selfIdentity ?? 'assistant',
    thoughtSurfacing: resolved.thoughtSurfacing ?? 'all-self',
    replayCompatibility: resolved.replayCompatibility ?? [],
    unsupportedMediaPolicy: resolved.unsupportedMediaPolicy ?? 'throw',
    cacheBreakpoints: resolved.cacheBreakpoints ?? 'auto',
    cacheTtl: resolved.cacheTtl,
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
    renderRetrievableHandleBody: resolvedHelpers.renderRetrievableHandleBody,
    renderAnthropicTimelineMessage: resolvedHelpers.renderAnthropicTimelineMessage,
    renderThought: resolvedHelpers.renderThought,
    filterThoughts: resolvedHelpers.filterThoughts,
    renderAnthropicThinkingBlocks: resolvedHelpers.renderAnthropicThinkingBlocks,
    renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
    renderTrustedContent: resolvedHelpers.renderTrustedContent,
    warn: localWarn,
  })

  return {
    messages: built.messages,
    system: built.system,
    tools: built.tools,
    abortSignal: context.abortSignal,
  }
}

/**
 * Counts tokens using already-resolved Anthropic adapter options.
 *
 * @param resolved - Fully merged and validated adapter options.
 * @param input - Either a `DispatchContext` or a pre-built Anthropic-shaped input object.
 * @param deps - Optional helper dependencies, including the structured log channel.
 * @returns The named token-count field plus the raw SDK response.
 */
export const countAnthropicMessagesTokensWithResolvedOptions = async (
  resolved: AnthropicMessagesAdapterOptions,
  input: AnthropicMessagesCountTokensRequestInput | AnthropicMessagesCountTokensInput,
  deps?: AnthropicMessagesCountTokensDeps
): Promise<{ inputTokens: number; raw: unknown }> => {
  const log = deps?.log ?? noopLog
  warnOnUnsupportedOutputSchemaKeywords(resolved.outputConfig, log)

  const assembled = await assembleCountTokensPayload(resolved, input, log)
  const params: AnthropicMessageCountTokensParams = {
    model: resolved.model,
    messages: assembled.messages,
  }
  if (assembled.system !== undefined) params.system = assembled.system
  if (assembled.tools !== undefined && assembled.tools.length > 0) params.tools = assembled.tools
  if (resolved.outputConfig !== undefined) params.output_config = resolved.outputConfig
  if (resolved.thinking !== undefined) params.thinking = resolved.thinking
  if (resolved.toolChoice !== undefined) params.tool_choice = resolved.toolChoice
  if (resolved.userProfileId !== undefined) params.user_profile_id = resolved.userProfileId

  const retryCfg = {
    maxAttempts: resolved.retry?.maxAttempts ?? 1,
    baseDelayMs: resolved.retry?.baseDelayMs ?? 500,
    maxDelayMs: resolved.retry?.maxDelayMs ?? 30_000,
    retriableStatuses: resolved.retry?.retriableStatuses ?? [429, 502, 503, 504, 529],
    honorRetryAfter: resolved.retry?.honorRetryAfter ?? true,
  }

  const requestTimeoutMs = resolved.requestTimeoutMs ?? 0
  const client = new Anthropic({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    fetch: resolved.fetch,
    maxRetries: 0,
    timeout:
      requestTimeoutMs > 0 ? requestTimeoutMs + SDK_TIMEOUT_MARGIN_MS : SDK_TIMEOUT_SENTINEL_MS,
    defaultHeaders: resolved.headers,
    dangerouslyAllowBrowser: resolved.dangerouslyAllowBrowser ?? false,
  })

  let attempt = 1
  let disposeLink: () => void = () => {}
  while (attempt <= retryCfg.maxAttempts) {
    if (assembled.abortSignal?.aborted === true) {
      disposeLink()
      return {
        inputTokens: 0,
        raw: { cancelled: true, reason: 'caller-abort-before-dispatch' },
      }
    }

    const internalController = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (requestTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => internalController.abort(), requestTimeoutMs)
    }
    disposeLink()
    const linkedSignals = assembled.abortSignal
      ? [assembled.abortSignal, internalController.signal]
      : [internalController.signal]
    const { signal: linkedSignal, dispose: disposeCurrentLink } = linkAbortSignals(linkedSignals)
    disposeLink = disposeCurrentLink

    try {
      const raw = (await client.messages.countTokens(params, {
        signal: linkedSignal,
      })) as AnthropicMessageTokensCount
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      disposeLink()
      return { inputTokens: raw.input_tokens, raw }
    } catch (err) {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      const classified = translateAnthropicError(err, retryCfg.retriableStatuses, {
        resolveErrorStatus: resolved.resolveErrorStatus,
        warn: (msg) => log.warn({ kind: 'anthropic-resolve-error-status', message: msg }),
      })
      if (classified.kind === 'abort') {
        disposeLink()
        return {
          inputTokens: 0,
          raw: { cancelled: true, reason: 'caller-abort' },
        }
      }
      if (classified.kind === 'timeout') {
        log.warn({
          kind: 'request-timeout',
          message: `Request timed out after ${requestTimeoutMs}ms on attempt ${attempt}/${retryCfg.maxAttempts}`,
          payload: {
            requestTimeoutMs,
            attempt,
            maxAttempts: retryCfg.maxAttempts,
          },
        })
        if (attempt < retryCfg.maxAttempts) {
          const delay = computeBackoff(attempt, retryCfg)
          await sleepWithJitter(delay, assembled.abortSignal)
          attempt += 1
          continue
        }
        throw new E_ANTHROPIC_MESSAGES_REQUEST_TIMEOUT([requestTimeoutMs])
      }
      if (classified.kind === 'context-overflow') {
        throw new E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW([
          -1,
          resolved.contextWindow ?? -1,
          resolved.tokenEncoding ?? 'unknown',
          classified.message,
        ])
      }
      if (classified.kind === 'retriable') {
        if (attempt < retryCfg.maxAttempts) {
          let delay = computeBackoff(attempt, retryCfg)
          if (retryCfg.honorRetryAfter !== false && isInstanceOf(err, 'APIError', APIError)) {
            const ra = err.headers?.get?.('retry-after')
            if (ra) {
              const raMs = parseRetryAfter(ra)
              if (raMs > 0) delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs)
            }
          }
          log.warn({
            kind: 'retry-attempt',
            message: `Anthropic error (status ${classified.status}) on attempt ${attempt}/${retryCfg.maxAttempts}; retrying in ~${delay}ms`,
            payload: {
              reason: 'http-status',
              status: classified.status,
              delayMs: delay,
              attempt: attempt + 1,
              maxAttempts: retryCfg.maxAttempts,
            },
          })
          await sleepWithJitter(delay, assembled.abortSignal)
          attempt += 1
          continue
        }
      }
      log.error({
        kind: 'http-error',
        message: `Anthropic error ${classified.status} (terminal): ${classified.message.slice(0, 256)}`,
        payload: {
          status: classified.status,
          body: classified.message,
          attempt,
          maxAttempts: retryCfg.maxAttempts,
        },
      })
      throw new E_ANTHROPIC_MESSAGES_HTTP_ERROR([classified.status, classified.message])
    }
  }

  throw new E_ANTHROPIC_MESSAGES_HTTP_ERROR([0, 'Anthropic token count exhausted retry attempts'])
}

/**
 * Counts tokens using constructor-baseline options plus executor-style overrides and stash.
 *
 * @param baseline - Constructor-baseline adapter options.
 * @param input - Either a `DispatchContext` or a pre-built Anthropic-shaped input object.
 * @param overrides - Optional executor-scope overrides with lower precedence than stash.
 * @param deps - Optional helper dependencies, including the structured log channel.
 * @returns The named token-count field plus the raw SDK response.
 */
export const countAnthropicMessagesTokens = async (
  baseline: AnthropicMessagesAdapterOptions,
  input: AnthropicMessagesCountTokensRequestInput | AnthropicMessagesCountTokensInput,
  overrides?: Partial<AnthropicMessagesAdapterOptions>,
  deps?: AnthropicMessagesCountTokensDeps
): Promise<{ inputTokens: number; raw: unknown }> => {
  if (
    // eslint-disable-next-line adk/prefer-is-object -- catch ambiguous inputs even if caller supplies an Object.create(null) record.
    typeof input === 'object' &&
    input !== null &&
    !isDispatchContext(input) &&
    'context' in input &&
    'messages' in input
  ) {
    throw new E_INVALID_ANTHROPIC_MESSAGES_OPTIONS([
      'countTokens input must not include both context and messages',
    ])
  }

  const context = getDispatchContextFromInput(input)
  const stashOverrides = (context?.stash.get(ANTHROPIC_MESSAGES_STASH_KEY, {}) as unknown) ?? {}
  const resolved = validateOptions(
    mergeOptions(
      baseline,
      overrides,
      isObject(stashOverrides) ? (stashOverrides as Partial<AnthropicMessagesAdapterOptions>) : {}
    )
  )

  if (resolved.tokenEncoding !== null && resolved.contextWindow === undefined) {
    throw new E_INVALID_ANTHROPIC_MESSAGES_OPTIONS([
      'tokenEncoding is non-null but contextWindow is undefined',
    ])
  }

  return countAnthropicMessagesTokensWithResolvedOptions(resolved, input, deps)
}
