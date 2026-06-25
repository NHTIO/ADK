/**
 * Translation helpers for the transformers.js LLM adapter.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/helpers
 *
 * @remarks
 * Two layers, like the other LLM batteries:
 * 1. **Re-exported format-agnostic helpers** from `chat_common` (string/trust-envelope renderers,
 *    the joi→JSON-Schema converter, thought rendering/filtering) — reused verbatim.
 * 2. **transformers.js-native mappers** defined here — building the `{role,content}[]` message array
 *    + the `tools` definitions, and a stream accumulator that collects decoded text (parsing of tool
 *    calls / reasoning happens once after the stream drains, via the shared parser layer).
 */

import { Media } from '@nhtio/adk'
import { ArtifactTool, Tool } from '@nhtio/adk'
import { Tokenizable, SpooledArtifact } from '@nhtio/adk'
import { E_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  descriptionToChatCompletionsJsonSchema,
  renderUntrustedContent as commonRenderUntrustedContent,
  renderTrustedContent as commonRenderTrustedContent,
  renderChatCompletionsSystemPrompt,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  renderThought,
  filterThoughts,
} from '../openai_chat_completions/helpers'
import type { ChatCompletionsTool } from '../openai_chat_completions/types'
import type { Message, Memory, Retrievable, Thought, ToolCall, ToolRegistry } from '@nhtio/adk'
import type {
  TransformersJsMessage,
  TransformersJsBucketOrder,
  UnsupportedMediaPolicy,
  DescriptionLike,
  JsonSchema,
} from './types'

// ── Re-export the entire format-agnostic layer (reused verbatim) ──────────────────────────────────

export {
  descriptionToChatCompletionsJsonSchema,
  defaultDescriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  defaultRenderUntrustedContent,
  renderTrustedContent,
  defaultRenderTrustedContent,
  renderStandingInstructions,
  defaultRenderStandingInstructions,
  renderMemories,
  defaultRenderMemories,
  renderRetrievables,
  defaultRenderRetrievables,
  renderRetrievableSafetyDirective,
  defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  extractReasoningFields,
} from '../openai_chat_completions/helpers'

// Re-export the shared parser layer so consumers import everything from this battery's barrel.
export * from '../chat_common/tool_parsers'
export * from '../chat_common/reasoning_parsers'

// ── transformers.js-native mappers ────────────────────────────────────────────────────────────────

/** A tool definition in the transformers.js `tools` array (OpenAI-function-shaped). */
export interface TransformersJsTool {
  /** Always `'function'` — the only tool type transformers.js chat templates understand. */
  type: 'function'
  /** The function descriptor: name, optional description, and JSON-Schema parameters. */
  function: {
    name: string
    description?: string
    parameters?: JsonSchema
  }
}

/**
 * Convert ADK {@link @nhtio/adk!Tool} / {@link @nhtio/adk!ArtifactTool} instances into the
 * transformers.js `tools` array shape (OpenAI-function-shaped — what `apply_chat_template` expects).
 */
export const toolsToTransformersJsTools = (
  tools: ReadonlyArray<Tool | ArtifactTool>,
  deps: { descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema } = {
    descriptionToChatCompletionsJsonSchema,
  }
): TransformersJsTool[] => {
  const out: TransformersJsTool[] = []
  for (const tool of tools) {
    const described = tool.describe()
    const parameters = deps.descriptionToChatCompletionsJsonSchema(
      described.inputSchema as unknown as DescriptionLike
    )
    out.push({
      type: 'function',
      function: {
        name: described.name,
        description: described.description,
        parameters:
          parameters && Object.keys(parameters).length > 0
            ? parameters
            : { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/** Default {@link toolsToTransformersJsTools}. */
export const defaultToolsToTransformersJsTools = toolsToTransformersJsTools

/** Resolve a media instance to fallback text per policy ('throw' raises; others degrade). */
const resolveMediaFallbackText = async (
  media: Media,
  policy: UnsupportedMediaPolicy,
  warn?: (msg: string) => void
): Promise<string> => {
  if (policy === 'throw') {
    throw new E_UNSUPPORTED_MEDIA_MODALITY([media.kind, media.mimeType, media.filename])
  }
  const syntheticDescription = `[media: ${media.filename}, kind=${media.kind}, mime=${media.mimeType}]`
  if (
    policy === 'fallback-stash' ||
    (typeof policy === 'object' && policy.mode === 'fallback-stash')
  ) {
    const stashKeys =
      typeof policy === 'object'
        ? policy.stashKeys
        : ['text:transcript', 'text:caption', 'text:description']
    for (const key of stashKeys) {
      const entry = media.stash.get<{ value?: unknown } | undefined>(key)
      const value = entry && typeof entry === 'object' ? entry.value : undefined
      if (typeof value === 'string' && value.length > 0) return value
    }
    warn?.(
      `unsupportedMediaPolicy='fallback-stash' for ${media.filename} (${media.kind}): no matching stash entry — falling through to synthetic description.`
    )
    return syntheticDescription
  }
  return syntheticDescription
}

/**
 * Render a {@link @nhtio/adk!ToolCall}'s `results` into a plain-text tool message body.
 *
 * @remarks
 * transformers.js chat templates take a `tool`-role message whose `content` is a string. Materialises
 * SpooledArtifact(s) via `asString()`, applies the trust envelope, and degrades Media to text.
 */
export const renderTransformersJsToolResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderUntrustedContent: typeof commonRenderUntrustedContent
  renderTrustedContent: typeof commonRenderTrustedContent
  warn?: (msg: string) => void
}): Promise<string> => {
  const { results, toolCall, tool } = input
  const isTrusted = tool?.trusted === true

  let body: string
  if (
    Media.isMedia(results) ||
    (Array.isArray(results) && results.every((r) => Media.isMedia(r)))
  ) {
    const mediaList = Media.isMedia(results) ? [results] : (results as Media[])
    const parts: string[] = []
    for (const m of mediaList)
      parts.push(await resolveMediaFallbackText(m, input.unsupportedMediaPolicy, input.warn))
    body = parts.join('\n\n')
  } else if (Array.isArray(results)) {
    const parts: string[] = []
    for (const a of results) parts.push(await (a as SpooledArtifact).asString())
    body = parts.join('\n\n')
  } else if (SpooledArtifact.isSpooledArtifact(results)) {
    body = await results.asString()
  } else {
    body = (results as Tokenizable).toString()
  }

  return isTrusted
    ? input.renderTrustedContent(body, {
        nonce: toolCall.checksum,
        kind: 'trusted-tool-result',
        tool: toolCall.tool,
      } as never)
    : input.renderUntrustedContent(body, {
        nonce: toolCall.checksum,
        kind: 'tool-result',
        tool: toolCall.tool,
      } as never)
}

/** Default {@link renderTransformersJsToolResult}. */
export const defaultRenderTransformersJsToolResult = renderTransformersJsToolResult

/**
 * Build the transformers.js `messages` array + `tools` from the ADK dispatch context buckets.
 *
 * @remarks
 * Leading buckets (system prompt + standing instructions / memories / retrievables) render into a
 * single `system` message; the timeline (messages, surviving thoughts, tool calls — chronological)
 * renders into `user`/`assistant`/`tool` messages. Tools are returned separately for the `tools`
 * generate-kwarg. Mirrors `buildLiteRtConversationInput`.
 */
export const buildTransformersJsMessages = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  messages: Iterable<Message>
  thoughts: Iterable<Thought>
  toolCalls: Iterable<ToolCall>
  tools: ToolRegistry
  renderedToolCallResults: Map<string, string>
  bucketOrder: TransformersJsBucketOrder
  selfIdentity: string
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  replayCompatibility: ReadonlyArray<string>
  toolsToTransformersJsTools: typeof toolsToTransformersJsTools
  renderThought: typeof renderThought
  filterThoughts: typeof filterThoughts
  renderUntrustedContent: typeof commonRenderUntrustedContent
  renderTrustedContent: typeof commonRenderTrustedContent
  renderChatCompletionsSystemPrompt: typeof renderChatCompletionsSystemPrompt
  renderStandingInstructions: typeof renderStandingInstructions
  renderMemories: typeof renderMemories
  renderRetrievables: typeof renderRetrievables
  renderRetrievableSafetyDirective: typeof renderRetrievableSafetyDirective
  renderFirstPartyRetrievables: typeof renderFirstPartyRetrievables
  renderThirdPartyPublicRetrievables: typeof renderThirdPartyPublicRetrievables
  renderThirdPartyPrivateRetrievables: typeof renderThirdPartyPrivateRetrievables
  warn?: (msg: string) => void
}): Promise<{ messages: TransformersJsMessage[]; tools: TransformersJsTool[] }> => {
  const systemText = await input.renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: input.bucketOrder,
    renderStandingInstructions: input.renderStandingInstructions,
    renderMemories: input.renderMemories,
    renderRetrievables: input.renderRetrievables,
    renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
    renderUntrustedContent: input.renderUntrustedContent,
  } as never)

  const messages: TransformersJsMessage[] = []
  if (typeof systemText === 'string' && systemText.length > 0) {
    messages.push({ role: 'system', content: systemText } as TransformersJsMessage)
  }

  const survivingThoughts = input.filterThoughts(
    input.thoughts,
    input.thoughtSurfacing,
    input.selfIdentity,
    input.replayCompatibility
  )
  type Item =
    | { kind: 'message'; at: number; value: Message }
    | { kind: 'thought'; at: number; value: Thought }
    | { kind: 'toolCall'; at: number; value: ToolCall }
  const items: Item[] = []
  for (const m of input.messages)
    items.push({ kind: 'message', at: m.createdAt.toMillis(), value: m })
  for (const t of survivingThoughts)
    items.push({ kind: 'thought', at: t.createdAt.toMillis(), value: t })
  for (const tc of input.toolCalls)
    items.push({ kind: 'toolCall', at: tc.createdAt.toMillis(), value: tc })
  items.sort((a, b) => a.at - b.at)

  for (const item of items) {
    if (item.kind === 'message') {
      const m = item.value
      const role = m.role === 'user' ? 'user' : 'assistant'
      messages.push({
        role,
        content: m.content !== undefined ? m.content.toString() : '',
      } as TransformersJsMessage)
    } else if (item.kind === 'thought') {
      const t = item.value
      const envelope = input.renderThought(t.content.toString(), {
        nonce: t.id,
        kind: 'self-reasoning',
        from: t.identity?.identifier ?? input.selfIdentity,
      } as never)
      messages.push({ role: 'assistant', content: envelope } as TransformersJsMessage)
    } else {
      const tc = item.value
      const rendered = input.renderedToolCallResults.get(tc.id)
      messages.push({ role: 'tool', content: rendered ?? '' } as TransformersJsMessage)
    }
  }

  const tools = input.toolsToTransformersJsTools(input.tools.visible())
  return { messages, tools }
}

/** Default {@link buildTransformersJsMessages}. */
export const defaultBuildTransformersJsMessages = buildTransformersJsMessages

/**
 * A streaming accumulator over transformers.js `TextStreamer` decoded-text deltas.
 *
 * @remarks
 * transformers.js streams **decoded text** (via the `TextStreamer` callback), not structured events.
 * This accumulator just concatenates the deltas; tool-call and reasoning extraction run **once after
 * the stream drains**, over `content()`, via the shared parser layer.
 */
export interface TransformersJsStreamAccumulator {
  /** Feed one decoded-text delta; returns it (for live prose reporting). */
  feed(delta: string): string
  /** The full accumulated text. */
  content(): string
}

/** Create a {@link TransformersJsStreamAccumulator}. */
export const createTransformersJsStreamAccumulator = (): TransformersJsStreamAccumulator => {
  let buf = ''
  return {
    feed(delta) {
      if (typeof delta !== 'string' || delta.length === 0) return ''
      buf += delta
      return delta
    },
    content: () => buf,
  }
}

/** Default {@link createTransformersJsStreamAccumulator}. */
export const defaultCreateTransformersJsStreamAccumulator = createTransformersJsStreamAccumulator

// Re-export the tool definition shape under the chat-completions tool alias for convenience.
export type { ChatCompletionsTool }
