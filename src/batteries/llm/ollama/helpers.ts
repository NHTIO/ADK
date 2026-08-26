/**
 * Swappable translation helpers for rendering ADK state into native Ollama `/api/chat` requests.
 *
 * @module @nhtio/adk/batteries/llm/ollama/helpers
 *
 * @remarks
 * The wire-shape-agnostic helpers (`renderUntrustedContent`, `renderMemories`,
 * `renderChatCompletionsSystemPrompt`, `toolsToChatCompletionsTools`, …) are shared with the OpenAI
 * battery via the internal `../chat_common/helpers` submodule and re-exported here under their
 * original names. Only the Ollama-WIRE-SPECIFIC helpers are defined here:
 * `renderOllamaTimelineMessage` (flat `content` + base64 `images[]` + `thinking`),
 * `renderOllamaToolCallResult` (string-only result content), `buildOllamaHistory` (synthetic
 * `assistant.tool_calls` with object-form `arguments` + `tool`-role messages labelled by
 * `tool_name`), and `ollamaToolsFromTools` (alias of the shared tool-definition renderer — native
 * `/api/chat` uses the same function-tool wire shape).
 *
 * Native `/api/chat` supports only base64 `images[]`; every non-image modality routes through the
 * `unsupportedMediaPolicy` fallback (stash text / synthetic description) or throws.
 */

import { Media } from '@nhtio/adk/common'
import { isInstanceOf } from '@nhtio/adk/guards'
import { E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  escapeXmlAttribute,
  memoryToAttrs,
  retrievableToAttrs,
  renderTrustedContent,
  renderUntrustedContent,
  toolsToChatCompletionsTools,
  neutraliseDeveloperRulesTag,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  floorTrustTier,
} from '../chat_common/helpers'
import type { ChatHelpersCommon } from '../chat_common/types'
import type {
  OllamaMessage,
  OllamaTool,
  OllamaHelpers,
  MemoryAttrs,
  RetrievableAttrs,
  ChatCompletionsBucketOrder,
  UnsupportedMediaPolicy,
} from './types'
import type {
  Tool,
  ArtifactTool,
  ToolRegistry,
  Tokenizable,
  Memory,
  Message,
  Thought,
  ToolCall,
  Retrievable,
  SpooledArtifact,
  MediaModalityHazard,
  MediaStashEntry,
} from '@nhtio/adk/common'

// ─── Re-exported wire-shape-agnostic helpers (shared submodule) ───────────────
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
  renderRetrievableSafetyDirective,
  defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  renderRetrievables,
  defaultRenderRetrievables,
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
} from '../chat_common/helpers'

// ─── ollamaToolsFromTools (alias — native tool wire == Chat Completions wire) ──

/**
 * Convert ADK tools to the native Ollama `tools[]` wire. Native `/api/chat` uses the identical
 * `{ type: 'function', function: { name, description, parameters } }` shape as Chat Completions, so
 * this is an alias of the shared renderer.
 */
export const ollamaToolsFromTools = (
  tools: ReadonlyArray<Tool | ArtifactTool>,
  deps: Parameters<typeof toolsToChatCompletionsTools>[1]
): OllamaTool[] => toolsToChatCompletionsTools(tools, deps)
/** Default implementation of {@link OllamaHelpers}-style tool translation; alias of {@link ollamaToolsFromTools}. */
export const defaultOllamaToolsFromTools = ollamaToolsFromTools

// ─── Media rendering (Ollama native — images only) ────────────────────────────

const DEFAULT_STASH_FALLBACK_KEYS: ReadonlyArray<string> = [
  'text:transcript',
  'text:caption',
  'text:description',
]

const modalityHazardToAttr = (h: MediaModalityHazard): 'inert' | 'extractable' | 'opaque' => {
  if (h === 'inert') return 'inert'
  if (h === 'extractable-instructions') return 'extractable'
  return 'opaque'
}

const formatBytesHumanReadable = (bytes: number | undefined): string => {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const isMediaTextStashEntry = (e: unknown): e is MediaStashEntry => {
  if (!e || typeof e !== 'object') return false
  const r = e as Record<string, unknown>
  return typeof r.value === 'string' && typeof r.trustTier === 'string'
}

const resolveFallbackStash = (
  media: Media,
  keys: ReadonlyArray<string>
): { text: string; entryTier: MediaStashEntry['trustTier'] } | undefined => {
  for (const key of keys) {
    const entry = media.stash.get(key)
    if (isMediaTextStashEntry(entry)) {
      return { text: entry.value as string, entryTier: entry.trustTier }
    }
  }
  return undefined
}

const renderTextInEnvelope = (
  text: string,
  args: {
    trustTier: MediaStashEntry['trustTier']
    modality: 'inert' | 'extractable' | 'opaque'
    nonce: string
    toolName: string | undefined
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  }
): string => {
  if (args.trustTier === 'first-party') {
    return args.renderTrustedContent(text, {
      nonce: args.nonce,
      kind: 'media-fallback',
      tool: args.toolName,
      modality: args.modality,
    })
  }
  return args.renderUntrustedContent(text, {
    nonce: args.nonce,
    kind: 'media-fallback',
    tool: args.toolName,
    modality: args.modality,
  })
}

const renderSyntheticMediaDescription = (media: Media, byteLen: number | undefined): string =>
  `[media: ${sanitizeFilenameForDescription(media.filename)}, ${sanitizeMimeType(media.mimeType, media.kind === 'image' || media.kind === 'audio' ? media.kind : undefined)}, ${formatBytesHumanReadable(byteLen)}]`

/**
 * Render a single {@link Media} for the native Ollama wire. Images become a base64 entry pushed to
 * the message's `images[]` array (returned via `image`); every other modality is unsupported and
 * routes through `unsupportedMediaPolicy` to a text envelope (returned via `text`) or throws.
 */
/**
 * The inline media id-marker (cross-battery convention; see the OpenAI battery's
 * `renderMediaIdMarker`): structural reference text authored by the harness from the
 * harness-controlled `Media.id`, rendered alongside each media so the model can reference it
 * by id in tool calls. Carries no authority; renders outside the untrusted envelope.
 */
const renderMediaIdMarker = (media: Media): string =>
  `[media id: ${media.id} | ${sanitizeFilenameForDescription(media.filename)}]`

const renderMediaForOllama = async (input: {
  media: Media
  toolName: string | undefined
  nonce: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  warn?: (msg: string) => void
}): Promise<{ image?: string; text?: string }> => {
  const { media, toolName, nonce, unsupportedMediaPolicy, warn } = input
  const modality = modalityHazardToAttr(media.modalityHazard)

  if (media.kind === 'image') {
    const b64 = await media.asBase64()
    return { image: b64 }
  }

  // Non-image modality — native /api/chat has no representation for it.
  const fallbackText = async (
    keys: ReadonlyArray<string>,
    allowSyntheticFallthrough: boolean
  ): Promise<{ text: string }> => {
    const fallback = resolveFallbackStash(media, keys)
    if (fallback) {
      return {
        text: renderTextInEnvelope(fallback.text, {
          // Floor the stash entry's tier to the parent media's (a stash entry may render less trusted
          // than its asset, never more) — the committee's #1-ranked media escalation.
          trustTier: floorTrustTier(media.trustTier, fallback.entryTier),
          modality,
          nonce,
          toolName,
          renderTrustedContent: input.renderTrustedContent,
          renderUntrustedContent: input.renderUntrustedContent,
        }),
      }
    }
    if (!allowSyntheticFallthrough) {
      warn?.(
        `unsupportedMediaPolicy='fallback-stash' for ${media.filename}: no matching stash entry — falling through to synthetic description.`
      )
    }
    const byteLen = await media.byteLength()
    return {
      text: renderTextInEnvelope(renderSyntheticMediaDescription(media, byteLen), {
        trustTier: media.trustTier,
        modality,
        nonce,
        toolName,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
      }),
    }
  }

  if (unsupportedMediaPolicy === 'throw') {
    throw new E_OLLAMA_UNSUPPORTED_MEDIA_MODALITY([media.kind, media.mimeType, media.filename])
  }
  if (
    unsupportedMediaPolicy === 'fallback-stash' ||
    (typeof unsupportedMediaPolicy === 'object' && unsupportedMediaPolicy.mode === 'fallback-stash')
  ) {
    const keys =
      typeof unsupportedMediaPolicy === 'object'
        ? unsupportedMediaPolicy.stashKeys
        : DEFAULT_STASH_FALLBACK_KEYS
    return fallbackText(keys, false)
  }
  return fallbackText([], true)
}

// ─── renderOllamaTimelineMessage ──────────────────────────────────────────────

/**
 * Renders a single timeline {@link @nhtio/adk!Message} into a native Ollama message — flattening any
 * media into the base64 `images[]` array, surfacing reasoning as `thinking`, and wrapping textual
 * bodies in the appropriate trust envelope.
 */
export const renderOllamaTimelineMessage = async (input: {
  message: Message
  selfIdentity: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<OllamaMessage> => {
  const { message, selfIdentity, unsupportedMediaPolicy, warn } = input
  const identifier =
    message.identity?.identifier !== undefined && message.identity?.identifier !== null
      ? String(message.identity.identifier)
      : ''
  const representationRaw =
    message.identity?.representation !== undefined && message.identity?.representation !== null
      ? message.identity.representation.toString()
      : ''
  const representation = representationRaw.length > 0 ? representationRaw : identifier
  // Neutralise a body-embedded no-nonce developer-rules tier (envelope-mimicry defense).
  const text = neutraliseDeveloperRulesTag(
    message.content !== undefined ? message.content.toString() : ''
  )
  const createdAtStr = message.createdAt.toISO?.() ?? ''
  const createdAtAttr = createdAtStr ? ` createdAt="${escapeXmlAttribute(createdAtStr)}"` : ''
  const attachments = message.attachments

  // Build the text envelope (same identity logic as the OpenAI battery — wire-agnostic).
  let envelopeText: string
  let role: 'user' | 'assistant'
  if (message.role === 'user') {
    role = 'user'
    if (identifier.length === 0) {
      envelopeText = text
    } else {
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<message_${message.id} from="${fromAttr}" role="user"${createdAtAttr}>\n${text}\n</message_${message.id}>`
    }
  } else {
    role = 'assistant'
    if (identifier.length === 0 || identifier === selfIdentity) {
      envelopeText = text
    } else {
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<peer_agent_output_${message.id} from="${fromAttr}"${createdAtAttr}>\n${text}\n</peer_agent_output_${message.id}>`
    }
  }

  const images: string[] = []
  const extraTexts: string[] = []
  for (const media of attachments) {
    const rendered = await renderMediaForOllama({
      media,
      toolName: undefined,
      nonce: message.id,
      unsupportedMediaPolicy,
      renderTrustedContent,
      renderUntrustedContent,
      warn,
    })
    extraTexts.push(renderMediaIdMarker(media))
    if (rendered.image !== undefined) images.push(rendered.image)
    if (rendered.text !== undefined) extraTexts.push(rendered.text)
  }

  // Non-image fallbacks (text envelopes) are appended to the message content; images ride in the
  // separate native `images[]` field.
  const contentParts: string[] = []
  if (envelopeText.length > 0) contentParts.push(envelopeText)
  for (const t of extraTexts) contentParts.push(t)
  const out: OllamaMessage = { role, content: contentParts.join('\n') }
  if (images.length > 0) out.images = images
  return out
}
/** Default timeline-message renderer; alias of {@link renderOllamaTimelineMessage}. */
export const defaultRenderOllamaTimelineMessage = renderOllamaTimelineMessage

// ─── renderOllamaToolCallResult ───────────────────────────────────────────────

const looksLikeSpooledArtifact = (value: unknown): value is SpooledArtifact => {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.asString === 'function' &&
    typeof v.byteLength === 'function' &&
    typeof v.lineCount === 'function' &&
    typeof v.estimateTokens === 'function'
  )
}

const renderArtifactHandleBody = (
  toolCall: ToolCall,
  artifact: SpooledArtifact,
  byteLength: number,
  lineCount: number
): string => {
  const ctor = (
    artifact as unknown as {
      constructor: { toolMethods?: ReadonlyArray<{ name: string; description?: string }> }
    }
  ).constructor
  const methods = ctor?.toolMethods ?? []
  const lines: string[] = []
  lines.push(`This tool returned a large artifact that was not inlined to preserve context budget.`)
  lines.push(``)
  lines.push(`Artifact metadata:`)
  lines.push(`- callId: ${toolCall.id}`)
  lines.push(`- kind: ${ctor?.constructor?.name ?? 'SpooledArtifact'}`)
  lines.push(`- byteLength: ${byteLength}`)
  lines.push(`- lineCount: ${lineCount}`)
  lines.push(``)
  lines.push(`To read this artifact in this turn, call one of the following tools with`)
  lines.push(`callId=${toolCall.id}:`)
  for (const m of methods) {
    if (m.description) {
      lines.push(`- ${m.name} — ${m.description}`)
    } else {
      lines.push(`- ${m.name}`)
    }
  }
  lines.push(``)
  lines.push(
    `The artifact persists in this turn's context — multiple queries against the same callId are allowed and efficient. Do not assume the body has been inlined anywhere else.`
  )
  return lines.join('\n')
}

/**
 * Render a tool-call result to native Ollama tool-message content (always a string). Media results
 * are routed through the internal media renderer: images cannot ride on a tool-role message's
 * `content`, so an image result is replaced with a short text marker (the image bytes are not
 * re-sent on a tool message); non-image media use the same fallback-text path as elsewhere.
 */
export const renderOllamaToolCallResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<string> => {
  const { toolCall, results, tool, warn, unsupportedMediaPolicy } = input
  const isTrusted =
    tool !== null && tool !== undefined && (tool as { trusted?: boolean }).trusted === true

  if (tool === undefined) {
    warn?.(
      `Tool "${toolCall.tool}" is not present in the bound tool registry at render time; defaulting to untrusted envelope.`
    )
  }

  // Media silo — bypasses Tool.trusted (Trust-Is-Content rule).
  const isMediaResult = Media.isMedia(results)
  const isMediaArrayResult =
    Array.isArray(results) && results.length > 0 && results.every((r) => Media.isMedia(r))
  if (isMediaResult || isMediaArrayResult) {
    const mediaList = isMediaResult ? [results as Media] : (results as Media[])
    const parts: string[] = []
    for (const media of mediaList) {
      const rendered = await renderMediaForOllama({
        media,
        toolName: toolCall.tool,
        nonce: toolCall.checksum,
        unsupportedMediaPolicy,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
        warn,
      })
      parts.push(renderMediaIdMarker(media))
      if (rendered.text !== undefined) {
        parts.push(rendered.text)
      } else {
        // An image tool-result cannot be carried on a tool-role message's string content; emit a
        // text marker in its place so the model knows an image was produced.
        const byteLen = await media.byteLength()
        parts.push(
          input.renderUntrustedContent(renderSyntheticMediaDescription(media, byteLen), {
            nonce: toolCall.checksum,
            kind: 'tool-result-image',
            tool: toolCall.tool,
            modality: modalityHazardToAttr(media.modalityHazard),
          })
        )
      }
    }
    return parts.join('\n')
  }

  // SpooledArtifact[] silo.
  if (Array.isArray(results)) {
    const parts: string[] = []
    for (const a of results) {
      parts.push(await (a as SpooledArtifact).asString())
    }
    const joined = parts.join('\n\n')
    return isTrusted
      ? input.renderTrustedContent(joined, {
          nonce: toolCall.checksum,
          kind: 'trusted-tool-result',
          tool: toolCall.tool,
        })
      : input.renderUntrustedContent(joined, {
          nonce: toolCall.checksum,
          kind: 'tool-result',
          tool: toolCall.tool,
        })
  }

  const isSpooled = looksLikeSpooledArtifact(results)

  // Handle-pattern branch: spooled + inline=false → always untrusted (queryable-data).
  if (isSpooled && toolCall.inline === false) {
    const artifact = results as SpooledArtifact
    let byteLength = 0
    let lineCount = 0
    try {
      byteLength = await artifact.byteLength()
    } catch {
      byteLength = 0
    }
    try {
      lineCount = await artifact.lineCount()
    } catch {
      lineCount = 0
    }
    const body = renderArtifactHandleBody(toolCall, artifact, byteLength, lineCount)
    return input.renderUntrustedContent(body, {
      nonce: toolCall.checksum,
      kind: 'artifact-handle',
      tool: toolCall.tool,
    })
  }

  // A Tokenizable result (an ArtifactTool query answer, an error string) has no queryable artifact to
  // hand back, so it always renders inline regardless of the `inline` flag — under handle-by-default
  // (inline:false) this is the ordinary case, not a misconfiguration, so it is silent.
  const body = isSpooled
    ? await (results as SpooledArtifact).asString()
    : (results as Tokenizable).toString()

  return isTrusted
    ? input.renderTrustedContent(body, {
        nonce: toolCall.checksum,
        kind: 'trusted-tool-result',
        tool: toolCall.tool,
      })
    : input.renderUntrustedContent(body, {
        nonce: toolCall.checksum,
        kind: 'tool-result',
        tool: toolCall.tool,
      })
}
/** Default tool-call-result renderer; alias of {@link renderOllamaToolCallResult}. */
export const defaultRenderOllamaToolCallResult = renderOllamaToolCallResult

// ─── buildOllamaHistory ───────────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'message'; createdAt: number; value: Message }
  | { kind: 'thought'; createdAt: number; value: Thought }
  | { kind: 'toolCall'; createdAt: number; value: ToolCall }

/**
 * Assembles the complete native Ollama message history for a dispatch — system prompt and content
 * buckets, the interleaved timeline of messages/thoughts/tool calls, and the collected opaque
 * reasoning payloads — by delegating to the injected sub-renderers.
 */
export const buildOllamaHistory = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  messages: Iterable<Message>
  thoughts: Iterable<Thought>
  toolCalls: Iterable<ToolCall>
  tools: ToolRegistry
  renderedToolCallResults: Map<string, string>
  bucketOrder: ChatCompletionsBucketOrder
  selfIdentity: string
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  replayCompatibility: ReadonlyArray<string>
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderOllamaToolCallResult: OllamaHelpers['renderOllamaToolCallResult']
  renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
  renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
  renderMemories: ChatHelpersCommon['renderMemories']
  renderRetrievables: ChatHelpersCommon['renderRetrievables']
  renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
  renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
  renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
  renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
  renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
  renderOllamaTimelineMessage: OllamaHelpers['renderOllamaTimelineMessage']
  renderThought: ChatHelpersCommon['renderThought']
  filterThoughts: ChatHelpersCommon['filterThoughts']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  warn?: (msg: string) => void
}): Promise<{
  messages: OllamaMessage[]
  reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
}> => {
  const out: OllamaMessage[] = []
  const reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }> = []

  const buckets = input.bucketOrder
  const timelineIdx = buckets.indexOf('timeline')

  const leadingSystem = await input.renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: buckets,
    renderStandingInstructions: input.renderStandingInstructions,
    renderMemories: input.renderMemories,
    renderRetrievables: input.renderRetrievables,
    renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
    renderRetrievableHandleBody: input.renderRetrievableHandleBody,
    renderUntrustedContent: input.renderUntrustedContent,
  })
  if (leadingSystem.length > 0) {
    out.push({ role: 'system', content: leadingSystem })
  }

  const includesTimeline = timelineIdx !== -1
  if (includesTimeline) {
    const survivingThoughts = input.filterThoughts(
      input.thoughts,
      input.thoughtSurfacing,
      input.selfIdentity,
      input.replayCompatibility
    )

    const items: TimelineItem[] = []
    for (const m of input.messages) {
      items.push({ kind: 'message', createdAt: m.createdAt.toMillis(), value: m })
    }
    for (const t of survivingThoughts) {
      items.push({ kind: 'thought', createdAt: t.createdAt.toMillis(), value: t })
    }
    for (const tc of input.toolCalls) {
      items.push({ kind: 'toolCall', createdAt: tc.createdAt.toMillis(), value: tc })
    }
    items.sort((a, b) => a.createdAt - b.createdAt)

    const replaySet = new Set<string>([...input.replayCompatibility])

    for (const item of items) {
      if (item.kind === 'message') {
        out.push(
          await input.renderOllamaTimelineMessage({
            message: item.value,
            selfIdentity: input.selfIdentity,
            unsupportedMediaPolicy: input.unsupportedMediaPolicy,
            warn: input.warn,
          })
        )
      } else if (item.kind === 'thought') {
        const t = item.value
        const identifier = String(t.identity?.identifier ?? '')
        const isSelf = identifier === input.selfIdentity
        const hasPayload = t.payload !== undefined
        const compatTag = t.replayCompatibility

        if (hasPayload && compatTag && replaySet.has(compatTag)) {
          reasoningPayloads.push({ id: t.id, replayCompatibility: compatTag, payload: t.payload })
          const envelope = input.renderThought(
            t.content.toString(),
            {
              nonce: t.id,
              kind: 'opaque-reasoning',
              from: identifier,
              createdAt: t.createdAt?.toISO?.() ?? undefined,
              replayCompatibility: compatTag,
            },
            t.payload
          )
          out.push({ role: 'assistant', content: envelope })
        } else if (!hasPayload) {
          const envelope = input.renderThought(t.content.toString(), {
            nonce: t.id,
            kind: isSelf ? 'self-reasoning' : 'peer-reasoning',
            from: identifier,
            createdAt: t.createdAt?.toISO?.() ?? undefined,
          })
          out.push({ role: 'assistant', content: envelope })
        }
        // else: opaque, non-matching → elided.
      } else {
        // tool call: synthetic assistant message carrying tool_calls[] (object-form arguments),
        // followed by a tool-role message labelled by `tool_name` (NOT tool_call_id).
        const tc = item.value
        const args =
          tc.args !== null && typeof tc.args === 'object' && !Array.isArray(tc.args)
            ? (tc.args as Record<string, unknown>)
            : {}
        out.push({
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: tc.tool, arguments: args } }],
        })

        let rendered = input.renderedToolCallResults.get(tc.id)
        if (rendered === undefined) {
          const tool = input.tools.get?.(tc.tool)
          rendered = await input.renderOllamaToolCallResult({
            toolCall: tc,
            results: tc.results as
              | Tokenizable
              | SpooledArtifact
              | SpooledArtifact[]
              | Media
              | Media[],
            tool: tool as Tool | ArtifactTool | undefined,
            renderUntrustedContent: input.renderUntrustedContent,
            renderTrustedContent: input.renderTrustedContent,
            unsupportedMediaPolicy: input.unsupportedMediaPolicy,
            warn: input.warn,
          })
        }
        out.push({ role: 'tool', content: rendered, tool_name: tc.tool })
      }
    }
  }

  if (includesTimeline) {
    const trailingParts: string[] = []
    for (let i = timelineIdx + 1; i < buckets.length; i++) {
      const label = buckets[i]!
      if (label === 'standingInstructions') {
        const block = input.renderStandingInstructions(input.standingInstructions)
        if (block.length > 0) trailingParts.push(block)
      } else if (label === 'memories') {
        const wrapped: Array<{ memory: Memory; attrs: MemoryAttrs }> = []
        for (const m of input.memories) {
          wrapped.push(memoryToAttrs(m))
        }
        const block = input.renderMemories(wrapped)
        if (block.length > 0) trailingParts.push(block)
      } else if (label === 'retrievables') {
        const wrapped: Array<{ retrievable: Retrievable; attrs: RetrievableAttrs }> = []
        for (const r of input.retrievables) {
          wrapped.push(retrievableToAttrs(r))
        }
        const block = await input.renderRetrievables(wrapped, {
          renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
          renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
          renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
          renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
          renderUntrustedContent: input.renderUntrustedContent,
        })
        if (block.length > 0) trailingParts.push(block)
      }
    }
    if (trailingParts.length > 0) {
      out.push({ role: 'system', content: trailingParts.join('\n\n') })
    }
  }

  return { messages: out, reasoningPayloads }
}
/** Default native-history assembler; alias of {@link buildOllamaHistory}. */
export const defaultBuildOllamaHistory = buildOllamaHistory

// suppress unused
void isInstanceOf
