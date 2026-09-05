/**
 * Swappable translation helpers for rendering ADK state into the Claude Code CLI's `-p` prompt
 * string and MCP tool-result content.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli/helpers
 *
 * @remarks
 * The wire-shape-agnostic helpers (`renderUntrustedContent`, `renderMemories`,
 * `renderChatCompletionsSystemPrompt`, `toolsToChatCompletionsTools`, …) are shared with every
 * other Chat-family battery via `../chat_common/helpers` and re-exported here under their
 * original names. Only the battery-specific helpers are defined here:
 * `renderClaudeCodeCliTimelineMessage` (plain text — no native image side-channel, unlike
 * Ollama's `images[]`), `renderClaudeCodeCliToolCallResult` (the inbound-history counterpart to
 * the outbound MCP-result rendering `adapter.ts` performs directly), and
 * `buildClaudeCodeCliPrompt` (the top-level history-to-prompt assembler — a direct structural
 * port of `buildOllamaHistory`'s ordering, collapsed to a single joined string).
 */

import { Media } from '@nhtio/adk/common'
import { E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  escapeXmlAttribute,
  memoryToAttrs,
  retrievableToAttrs,
  renderTrustedContent,
  renderUntrustedContent,
  neutraliseDeveloperRulesTag,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  floorTrustTier,
  looksLikeSpooledArtifact,
  renderArtifactHandleBody,
} from '../chat_common/helpers'
import type { ChatHelpersCommon } from '../chat_common/types'
import type {
  ClaudeCodeCliHelpers,
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
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  looksLikeSpooledArtifact,
} from '../chat_common/helpers'

// ─── Media rendering (text-only — no native image channel on either wire direction) ──

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

const renderMediaIdMarker = (media: Media): string =>
  `[media id: ${media.id} | ${sanitizeFilenameForDescription(media.filename)}]`

/**
 * Render a single {@link Media} to plain text for the Claude Code CLI wire — EVERY modality
 * (including image) routes through `unsupportedMediaPolicy`, since a `-p` prompt string and an
 * MCP tool-result's text content block both lack a native image side-channel, unlike Ollama's
 * `images[]` or Anthropic's native `image` content block.
 */
const renderMediaAsText = async (input: {
  media: Media
  toolName: string | undefined
  nonce: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  warn?: (msg: string) => void
}): Promise<string> => {
  const { media, toolName, nonce, unsupportedMediaPolicy, warn } = input
  const modality = modalityHazardToAttr(media.modalityHazard)

  const fallbackText = async (
    keys: ReadonlyArray<string>,
    allowSyntheticFallthrough: boolean
  ): Promise<string> => {
    const fallback = resolveFallbackStash(media, keys)
    if (fallback) {
      return renderTextInEnvelope(fallback.text, {
        trustTier: floorTrustTier(media.trustTier, fallback.entryTier),
        modality,
        nonce,
        toolName,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
      })
    }
    if (!allowSyntheticFallthrough) {
      warn?.(
        `unsupportedMediaPolicy='fallback-stash' for ${media.filename}: no matching stash entry — falling through to synthetic description.`
      )
    }
    const byteLen = await media.byteLength()
    return renderTextInEnvelope(renderSyntheticMediaDescription(media, byteLen), {
      trustTier: media.trustTier,
      modality,
      nonce,
      toolName,
      renderTrustedContent: input.renderTrustedContent,
      renderUntrustedContent: input.renderUntrustedContent,
    })
  }

  if (unsupportedMediaPolicy === 'throw') {
    throw new E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY([
      media.kind,
      media.mimeType,
      media.filename,
    ])
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

// ─── renderClaudeCodeCliTimelineMessage ────────────────────────────────────────

/**
 * Renders a single timeline {@link @nhtio/adk!Message} into plain text for the `-p` prompt
 * string — structurally identical to `renderOllamaTimelineMessage`'s trust-envelope/identity
 * logic, except every attachment routes through `unsupportedMediaPolicy` and is appended as text
 * (the "v1 prompt is text-only" limitation).
 */
export const renderClaudeCodeCliTimelineMessage = async (input: {
  message: Message
  selfIdentity: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<string> => {
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
  const text = neutraliseDeveloperRulesTag(
    message.content !== undefined ? message.content.toString() : ''
  )
  const createdAtStr = message.createdAt.toISO?.() ?? ''
  const createdAtAttr = createdAtStr ? ` createdAt="${escapeXmlAttribute(createdAtStr)}"` : ''
  const attachments = message.attachments

  let envelopeText: string
  if (message.role === 'user') {
    if (identifier.length === 0) {
      envelopeText = text
    } else {
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<message_${message.id} from="${fromAttr}" role="user"${createdAtAttr}>\n${text}\n</message_${message.id}>`
    }
  } else {
    if (identifier.length === 0 || identifier === selfIdentity) {
      envelopeText = text
    } else {
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<peer_agent_output_${message.id} from="${fromAttr}"${createdAtAttr}>\n${text}\n</peer_agent_output_${message.id}>`
    }
  }

  const extraTexts: string[] = []
  for (const media of attachments) {
    const rendered = await renderMediaAsText({
      media,
      toolName: undefined,
      nonce: message.id,
      unsupportedMediaPolicy,
      renderTrustedContent,
      renderUntrustedContent,
      warn,
    })
    extraTexts.push(renderMediaIdMarker(media))
    extraTexts.push(rendered)
  }

  const contentParts: string[] = []
  if (envelopeText.length > 0) contentParts.push(envelopeText)
  for (const t of extraTexts) contentParts.push(t)
  return contentParts.join('\n')
}
/** Default timeline-message renderer; alias of {@link renderClaudeCodeCliTimelineMessage}. */
export const defaultRenderClaudeCodeCliTimelineMessage = renderClaudeCodeCliTimelineMessage

// ─── renderClaudeCodeCliToolCallResult (inbound-history direction) ─────────────

const renderArtifactHandleBodyLegacy = (
  toolCall: ToolCall,
  artifact: SpooledArtifact,
  byteLength: number,
  lineCount: number
): string =>
  renderArtifactHandleBody({
    callId: toolCall.id,
    artifact,
    byteLength,
    lineCount,
  })

/**
 * Render a completed {@link @nhtio/adk!ToolCall}'s result to plain text for the INBOUND history
 * direction (how a past tool call reads back into a subsequent dispatch's rendered prompt) —
 * always a string, since the `-p` prompt has no structured-content channel. Media results are
 * routed through the same text-only media renderer used by the timeline path.
 */
export const renderClaudeCodeCliToolCallResult = async (input: {
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

  const isMediaResult = Media.isMedia(results)
  const isMediaArrayResult =
    Array.isArray(results) && results.length > 0 && results.every((r) => Media.isMedia(r))
  if (isMediaResult || isMediaArrayResult) {
    const mediaList = isMediaResult ? [results as Media] : (results as Media[])
    const parts: string[] = []
    for (const media of mediaList) {
      parts.push(renderMediaIdMarker(media))
      parts.push(
        await renderMediaAsText({
          media,
          toolName: toolCall.tool,
          nonce: toolCall.checksum,
          unsupportedMediaPolicy,
          renderTrustedContent: input.renderTrustedContent,
          renderUntrustedContent: input.renderUntrustedContent,
          warn,
        })
      )
    }
    return parts.join('\n')
  }

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
    const body = renderArtifactHandleBodyLegacy(toolCall, artifact, byteLength, lineCount)
    return input.renderUntrustedContent(body, {
      nonce: toolCall.checksum,
      kind: 'artifact-handle',
      tool: toolCall.tool,
    })
  }

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
/** Default tool-call-result renderer; alias of {@link renderClaudeCodeCliToolCallResult}. */
export const defaultRenderClaudeCodeCliToolCallResult = renderClaudeCodeCliToolCallResult

// ─── buildClaudeCodeCliPrompt ───────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'message'; createdAt: number; value: Message }
  | { kind: 'thought'; createdAt: number; value: Thought }
  | { kind: 'toolCall'; createdAt: number; value: ToolCall }

/**
 * Assembles the complete history for a dispatch into ONE joined prompt string — a direct
 * structural port of `buildOllamaHistory`'s ordering (leading system-prompt block, then the
 * timestamp-sorted timeline of messages/thoughts/tool-calls, then any trailing buckets after
 * `'timeline'` in `bucketOrder`), with the target shape collapsed from a message array to a
 * single string, since this wire has one `-p` positional argument.
 */
export const buildClaudeCodeCliPrompt = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  messages: Iterable<Message>
  thoughts: Iterable<Thought>
  toolCalls: Iterable<ToolCall>
  tools: ToolRegistry
  /** Pre-rendered results keyed by the same live ToolCall instances iterated below. */
  renderedToolCallResults: Map<ToolCall, string>
  bucketOrder: ChatCompletionsBucketOrder
  selfIdentity: string
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  replayCompatibility: ReadonlyArray<string>
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderCtx?: unknown
  renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
  renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
  renderMemories: ChatHelpersCommon['renderMemories']
  renderRetrievables: ChatHelpersCommon['renderRetrievables']
  renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
  renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
  renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
  renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
  renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
  renderClaudeCodeCliTimelineMessage: ClaudeCodeCliHelpers['renderClaudeCodeCliTimelineMessage']
  renderClaudeCodeCliToolCallResult: ClaudeCodeCliHelpers['renderClaudeCodeCliToolCallResult']
  renderThought: ChatHelpersCommon['renderThought']
  filterThoughts: ChatHelpersCommon['filterThoughts']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  warn?: (msg: string) => void
}): Promise<{
  prompt: string
  reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
}> => {
  const sections: string[] = []
  const reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }> = []

  const buckets = input.bucketOrder
  const timelineIdx = buckets.indexOf('timeline')

  const leadingSystem = await input.renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    renderCtx: input.renderCtx,
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
    sections.push(leadingSystem)
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
        const rendered = await input.renderClaudeCodeCliTimelineMessage({
          message: item.value,
          selfIdentity: input.selfIdentity,
          unsupportedMediaPolicy: input.unsupportedMediaPolicy,
          warn: input.warn,
        })
        if (rendered.length > 0) sections.push(rendered)
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
          sections.push(envelope)
        } else if (!hasPayload) {
          const envelope = input.renderThought(t.content.toString(), {
            nonce: t.id,
            kind: isSelf ? 'self-reasoning' : 'peer-reasoning',
            from: identifier,
            createdAt: t.createdAt?.toISO?.() ?? undefined,
          })
          sections.push(envelope)
        }
        // else: opaque, non-matching → elided.
      } else {
        const tc = item.value
        const callHeader = `<tool_call id="${escapeXmlAttribute(tc.id)}" tool="${escapeXmlAttribute(
          tc.tool
        )}">\n${JSON.stringify(tc.args)}\n</tool_call>`
        sections.push(callHeader)

        // Instance identity is intentional: ids may collide across turns, while this is the same
        // live primitive used by the producer. An id-keyed cache pairs an earlier call with the
        // later call's result after a collision.
        let rendered = input.renderedToolCallResults.get(tc)
        if (rendered === undefined) {
          const tool = input.tools.get?.(tc.tool)
          rendered = await input.renderClaudeCodeCliToolCallResult({
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
        sections.push(rendered)
      }
    }
  }

  if (includesTimeline) {
    for (let i = timelineIdx + 1; i < buckets.length; i++) {
      const label = buckets[i]!
      if (label === 'standingInstructions') {
        const block = input.renderStandingInstructions(input.standingInstructions)
        if (block.length > 0) sections.push(block)
      } else if (label === 'memories') {
        const wrapped: Array<{ memory: Memory; attrs: MemoryAttrs }> = []
        for (const m of input.memories) {
          wrapped.push(memoryToAttrs(m))
        }
        const block = input.renderMemories(wrapped)
        if (block.length > 0) sections.push(block)
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
        if (block.length > 0) sections.push(block)
      }
    }
  }

  return { prompt: sections.join('\n\n'), reasoningPayloads }
}
/** Default history assembler; alias of {@link buildClaudeCodeCliPrompt}. */
export const defaultBuildClaudeCodeCliPrompt = buildClaudeCodeCliPrompt
