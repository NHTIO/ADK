/**
 * Translation helpers for the LiteRT-LM adapter.
 *
 * @module @nhtio/adk/batteries/llm/litert_lm/helpers
 *
 * @remarks
 * Two layers:
 *
 * 1. **Re-exported format-agnostic helpers** from `chat_common` — they operate on ADK primitives and
 *    produce plain strings / trust envelopes / a JSON-Schema from a joi description, with no wire-format
 *    coupling. LiteRT reuses them verbatim (the same way the WebLLM battery does).
 * 2. **LiteRT-native mappers** defined here — the wire-shape functions the chat-completions batteries
 *    implement against the OpenAI wire format, rewritten against LiteRT's `Message` / `Tool` /
 *    `tool_response` / `Preface` shapes.
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
import type { Message, Memory, Retrievable, Thought, ToolCall, ToolRegistry } from '@nhtio/adk'
import type {
  LiteRtMessage,
  LiteRtMessageContentItem,
  LiteRtTool,
  LiteRtPreface,
  LiteRtLmBucketOrder,
  UnsupportedMediaPolicy,
  DescriptionLike,
  JsonSchema,
} from './types'

// ── Re-export the entire format-agnostic layer (reused verbatim, like WebLLM) ─────────────────────

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

// Re-export the shared text-parser layer so consumers import everything from this battery's barrel.
// LiteRT-LM (v0.13.1) is text-only: tool calls + reasoning arrive as text in `content`, parsed here.
export * from '../chat_common/tool_parsers'
export * from '../chat_common/reasoning_parsers'

// ── LiteRT-native mappers ─────────────────────────────────────────────────────────────────────────

/**
 * Convert ADK {@link @nhtio/adk!Tool} / {@link @nhtio/adk!ArtifactTool} instances into LiteRT
 * {@link LiteRtTool} definitions.
 *
 * @remarks
 * Reuses {@link descriptionToChatCompletionsJsonSchema} (format-agnostic: joi `describe()` → JSON
 * Schema) for the `parameters` field — LiteRT's `Tool.parameters` follows JSON Schema, same as the
 * chat-completions `function.parameters`.
 */
export const toolsToLiteRtTools = (
  tools: ReadonlyArray<Tool | ArtifactTool>,
  deps: {
    descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema
  } = { descriptionToChatCompletionsJsonSchema }
): LiteRtTool[] => {
  const out: LiteRtTool[] = []
  for (const tool of tools) {
    const described = tool.describe()
    const parameters = deps.descriptionToChatCompletionsJsonSchema(
      described.inputSchema as unknown as DescriptionLike
    )
    out.push({
      name: described.name,
      description: described.description,
      parameters:
        parameters && Object.keys(parameters).length > 0
          ? (parameters as LiteRtTool['parameters'])
          : { type: 'object', properties: {} },
    })
  }
  return out
}

/** Default {@link toolsToLiteRtTools}. */
export const defaultToolsToLiteRtTools = toolsToLiteRtTools

/**
 * Render a media kind/mime/filename into a LiteRT content item, or fall back per
 * `unsupportedMediaPolicy`.
 *
 * @remarks
 * The preview `.litertlm` models are text-in/text-out, and the exact multimodal content-item wire
 * shape is not yet stable in the published types. This maps image/audio/document/video to a
 * best-effort `{ type, path }`-style item when the matching modality flag is enabled, and otherwise
 * degrades through the shared `unsupportedMediaPolicy` (stash text / synthetic description / throw).
 * Verify the content-item shape against the installed `.d.ts` + a real multimodal model before
 * relying on the native path.
 */
export const renderMediaToLiteRtContent = async (input: {
  media: Media
  nonce: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  modalityEnabled: boolean
  renderUntrustedContent: typeof commonRenderUntrustedContent
  renderTrustedContent: typeof commonRenderTrustedContent
  warn?: (msg: string) => void
}): Promise<LiteRtMessageContentItem[]> => {
  const { media, modalityEnabled } = input
  const kind = media.kind

  const supportedNatively = modalityEnabled && (kind === 'image' || kind === 'audio') ? true : false

  if (supportedNatively) {
    const b64 = await media.asBase64()
    // LiteRT content items carry inline data via a data: URI in the `path` slot for the preview
    // builds; refine against the real multimodal model when one ships.
    return [
      {
        type: kind,
        path: `data:${media.mimeType};base64,${b64}`,
      } as LiteRtMessageContentItem,
    ]
  }

  // Fall back to a text representation through the shared policy ('throw' raises here).
  const fallbackText = await resolveMediaFallbackText(
    media,
    input.unsupportedMediaPolicy,
    input.warn
  )
  const envelope =
    media.trustTier === 'first-party'
      ? input.renderTrustedContent(fallbackText, {
          nonce: input.nonce,
          kind: 'media-fallback',
        } as never)
      : input.renderUntrustedContent(fallbackText, {
          nonce: input.nonce,
          kind: 'media-fallback',
        } as never)
  return [{ type: 'text', text: envelope }]
}

/** Default stash keys probed for fallback text when a policy yields no explicit list. */
const DEFAULT_STASH_FALLBACK_KEYS = ['text:transcript', 'text:caption', 'text:description']

/** Synthetic one-line description used when no stash text is available and the policy permits it. */
const syntheticMediaDescription = (media: Media): string =>
  `[media: ${media.filename}, kind=${media.kind}, mime=${media.mimeType}]`

/**
 * Resolve a media instance to fallback text per the policy.
 *
 * @remarks
 * Mirrors the OpenAI battery's contract exactly:
 * - `'throw'` → raises {@link E_UNSUPPORTED_MEDIA_MODALITY} (the documented failure path).
 * - `'fallback-stash'` (string or object form) → returns the first non-empty stash entry, or
 *   degrades to a synthetic description on a miss (warning), never silently vanishing.
 * - `'synthetic-description'` → the synthetic one-liner.
 *
 * Always returns a usable string except when the policy is `'throw'` (which never returns).
 *
 * @throws {@link E_UNSUPPORTED_MEDIA_MODALITY} when `policy === 'throw'`.
 */
const resolveMediaFallbackText = async (
  media: Media,
  policy: UnsupportedMediaPolicy,
  warn?: (msg: string) => void
): Promise<string> => {
  if (policy === 'throw') {
    throw new E_UNSUPPORTED_MEDIA_MODALITY([media.kind, media.mimeType, media.filename])
  }

  if (
    policy === 'fallback-stash' ||
    (typeof policy === 'object' && policy.mode === 'fallback-stash')
  ) {
    const stashKeys = typeof policy === 'object' ? policy.stashKeys : DEFAULT_STASH_FALLBACK_KEYS
    for (const key of stashKeys) {
      const entry = media.stash.get<{ value?: unknown } | undefined>(key)
      const value = entry && typeof entry === 'object' ? entry.value : undefined
      if (typeof value === 'string' && value.length > 0) return value
    }
    warn?.(
      `unsupportedMediaPolicy='fallback-stash' for ${media.filename} (${media.kind}): no matching stash entry — falling through to synthetic description.`
    )
    return syntheticMediaDescription(media)
  }

  // policy === 'synthetic-description'
  return syntheticMediaDescription(media)
}

/**
 * Render a {@link @nhtio/adk!ToolCall}'s `results` into a LiteRT `tool_response` content item.
 *
 * @remarks
 * Materialises {@link @nhtio/adk!SpooledArtifact}(s) via `asString()` and applies the trust envelope
 * (reusing the shared `renderTrustedContent`/`renderUntrustedContent`). Media results degrade to text
 * via {@link renderMediaToLiteRtContent}'s fallback path (LiteRT tool responses are text-shaped).
 */
export const renderLiteRtToolResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderUntrustedContent: typeof commonRenderUntrustedContent
  renderTrustedContent: typeof commonRenderTrustedContent
  warn?: (msg: string) => void
}): Promise<LiteRtMessageContentItem> => {
  const { results, toolCall, tool } = input
  const isTrusted = tool?.trusted === true

  let body: string
  if (
    Media.isMedia(results) ||
    (Array.isArray(results) && results.every((r) => Media.isMedia(r)))
  ) {
    const mediaList = Media.isMedia(results) ? [results] : (results as Media[])
    const parts: string[] = []
    for (const m of mediaList) {
      const text = await resolveMediaFallbackText(m, input.unsupportedMediaPolicy, input.warn)
      parts.push(text)
    }
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

  const envelope = isTrusted
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

  return {
    type: 'tool_response',
    tool_response: {
      name: toolCall.tool,
      response: { content: envelope },
    },
  } as LiteRtMessageContentItem
}

/** Default {@link renderLiteRtToolResult}. */
export const defaultRenderLiteRtToolResult = renderLiteRtToolResult

/**
 * Build the LiteRT conversation input from the ADK dispatch context buckets.
 *
 * @remarks
 * Maps the ADK history model onto LiteRT's `createConversation({ preface })` + per-turn
 * `sendMessage(messages)` shape:
 *
 * - **Leading buckets** (system prompt + standingInstructions / memories / retrievables before
 *   `timeline` in `bucketOrder`) → a single `preface.messages` system message.
 * - **Tools** → `preface.tools`.
 * - **Timeline** (messages, surviving thoughts, tool calls — chronological) → the `messages` array
 *   sent for this turn, each a LiteRT `Message`. Thoughts render via the shared `renderThought` into
 *   assistant messages; tool calls render an assistant `tool_calls` message + a `tool` role message
 *   carrying the pre-rendered `tool_response` content item.
 *
 * Returns `{ preface, messages }` for `engine.createConversation({ preface })` then
 * `conversation.sendMessageStreaming(messages)`.
 */
export const buildLiteRtConversationInput = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  messages: Iterable<Message>
  thoughts: Iterable<Thought>
  toolCalls: Iterable<ToolCall>
  tools: ToolRegistry
  renderedToolCallResults: Map<string, LiteRtMessageContentItem>
  bucketOrder: LiteRtLmBucketOrder
  selfIdentity: string
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  replayCompatibility: ReadonlyArray<string>
  toolsToLiteRtTools: typeof toolsToLiteRtTools
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
}): Promise<{ preface: LiteRtPreface; messages: LiteRtMessage[] }> => {
  // Leading system content (system prompt + before-timeline buckets), reusing the shared renderer.
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

  const prefaceMessages: LiteRtMessage[] = []
  if (typeof systemText === 'string' && systemText.length > 0) {
    prefaceMessages.push({ role: 'system', content: systemText })
  }
  const toolDefs = input.toolsToLiteRtTools(input.tools.visible())
  const preface: LiteRtPreface = {
    messages: prefaceMessages,
    ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
  }

  // Timeline: messages + surviving thoughts + tool calls, chronological.
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

  const messages: LiteRtMessage[] = []
  for (const item of items) {
    if (item.kind === 'message') {
      const m = item.value
      const role = m.role === 'user' ? 'user' : 'assistant'
      const text = m.content !== undefined ? m.content.toString() : ''
      messages.push({ role, content: text })
    } else if (item.kind === 'thought') {
      const t = item.value
      const envelope = input.renderThought(t.content.toString(), {
        nonce: t.id,
        kind: 'self-reasoning',
        from: t.identity?.identifier ?? input.selfIdentity,
      } as never)
      messages.push({ role: 'assistant', content: envelope })
    } else {
      const tc = item.value
      // Assistant turn that issued the tool call.
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: {
              name: tc.tool,
              arguments: (tc.args ?? {}) as Record<string, never>,
            },
          },
        ],
      })
      // The tool result, as a tool-role message carrying the pre-rendered tool_response item.
      const rendered = input.renderedToolCallResults.get(tc.id)
      if (rendered !== undefined) {
        messages.push({ role: 'tool', content: [rendered] })
      }
    }
  }

  return { preface, messages }
}

/** Default {@link buildLiteRtConversationInput}. */
export const defaultBuildLiteRtConversationInput = buildLiteRtConversationInput

/**
 * A streaming accumulator over LiteRT `ReadableStream<Message>` chunks.
 *
 * @remarks
 * Each chunk is a partial {@link LiteRtMessage}. The `@litert-lm/core` v0.13.1 JS runtime is
 * **text-in / text-out**: it emits `content` only and does NOT populate `tool_calls` or `channels` on
 * output (those wire fields exist for feeding history back IN). Tool calls and reasoning come out as
 * **raw text inside `content`**, in the model family's own format — the adapter parses them out after
 * the stream drains via the shared tool-call / reasoning parser layer.
 *
 * So the accumulator collects assistant `content` text only, handling BOTH delivery conventions —
 * incremental deltas (append) and full-accumulated snapshots (replace) — by detecting whether the
 * incoming value extends the running buffer (`startsWith`) or is a fresh fragment. It also tolerates
 * `content` arriving as a `MessageContentItem[]` by concatenating the text items.
 */
export interface LiteRtStreamAccumulator {
  /** Feed one chunk; returns the newly-appended content text (for incremental reporting). */
  feed(chunk: LiteRtMessage): { contentDelta: string }
  /** Final assembled content text. */
  content(): string
}

/** Extract the text from a chunk's `content` (string or text-item array). */
const chunkContentText = (content: LiteRtMessage['content']): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((i) => i.type === 'text' && typeof i.text === 'string')
      .map((i) => i.text as string)
      .join('')
  }
  return ''
}

/** Create a {@link LiteRtStreamAccumulator}. */
export const createLiteRtStreamAccumulator = (): LiteRtStreamAccumulator => {
  let contentBuf = ''

  // Append `incoming` onto `prev`, tolerating either delta or full-accumulated delivery.
  const merge = (prev: string, incoming: string): { next: string; delta: string } => {
    if (incoming.length === 0) return { next: prev, delta: '' }
    if (prev.length === 0) return { next: incoming, delta: incoming }
    if (incoming.startsWith(prev)) {
      // Full-accumulated snapshot — the delta is the suffix beyond what we already have.
      return { next: incoming, delta: incoming.slice(prev.length) }
    }
    // Incremental fragment — append.
    return { next: prev + incoming, delta: incoming }
  }

  return {
    feed(chunk) {
      const text = chunkContentText(chunk.content)
      if (text.length === 0) return { contentDelta: '' }
      const { next, delta } = merge(contentBuf, text)
      contentBuf = next
      return { contentDelta: delta }
    },
    content: () => contentBuf,
  }
}

/** Default {@link createLiteRtStreamAccumulator}. */
export const defaultCreateLiteRtStreamAccumulator = createLiteRtStreamAccumulator
