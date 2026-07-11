/**
 * Swappable translation helpers for rendering ADK state into Chat Completions requests.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions/helpers
 *
 * @remarks
 * The swappable translation helpers that turn ADK primitives into OpenAI Chat Completions wire
 * shapes. Each helper is exported under its unprefixed name AND under a `default*` alias so
 * consumers can compose partial overrides. Helpers that compose other helpers receive their
 * dependents via explicit input arguments — never via module-level closure — so a swap at any
 * layer propagates correctly.
 *
 * The wire-shape-AGNOSTIC helpers (`renderUntrustedContent`, `renderMemories`,
 * `renderChatCompletionsSystemPrompt`, `toolsToChatCompletionsTools`, …) now live in the shared,
 * internal `../chat_common/helpers` submodule and are re-exported here under their original names
 * so every existing import keeps resolving. Only the OpenAI-WIRE-SPECIFIC helpers
 * (`renderTimelineMessage`, `renderChatCompletionsToolCallResult`, `buildChatCompletionsHistory`,
 * `createChatCompletionsToolCallDeltaAccumulator`) and the reasoning-field extractor are defined
 * here.
 */

import { Media } from '@nhtio/adk/common'
import { isInstanceOf } from '@nhtio/adk/guards'
import { E_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  escapeXmlAttribute,
  sanitiseNameField,
  memoryToAttrs,
  retrievableToAttrs,
  renderTrustedContent,
  renderUntrustedContent,
  neutraliseDeveloperRulesTag,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  floorTrustTier,
} from '../chat_common/helpers'
import type { ChatHelpersCommon } from '../chat_common/types'
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
import type {
  ChatCompletionsMessage,
  ChatCompletionsContentBlock,
  ChatCompletionsToolCallDelta,
  ChatCompletionsToolCallDeltaAccumulator,
  AssembledToolCall,
  ChatCompletionsBucketOrder,
  MemoryAttrs,
  RetrievableAttrs,
  ChatCompletionsHelpers,
  UnsupportedMediaPolicy,
  ReasoningField,
  ReasoningFieldPrecedence,
  ReasoningExtract,
} from './types'

// ─── Re-exported wire-shape-agnostic helpers (shared submodule) ───────────────
// These are defined once in `../chat_common/helpers` and shared with the native Ollama battery.
// Re-exported here (bare + `default*`) so every existing
// `@nhtio/adk/batteries/llm/openai_chat_completions` import keeps resolving unchanged.
export {
  descriptionToChatCompletionsJsonSchema,
  defaultDescriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  defaultRenderUntrustedContent,
  renderTrustedContent,
  defaultRenderTrustedContent,
  renderStandingInstructions,
  defaultRenderStandingInstructions,
  neutraliseDeveloperRulesTag,
  stripEnvelopeSpecialTokens,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  floorTrustTier,
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
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
} from '../chat_common/helpers'

// ─── extractReasoningFields ───────────────────────────────────────────────────

/**
 * Pulls model reasoning/thinking text out of a Chat Completions response message or stream delta,
 * reading every wire field named in `precedence` that carries a non-empty string.
 *
 * @remarks
 * Reasoning is not part of OpenAI's official Chat Completions spec, so OpenAI-compatible providers
 * disagree on the field name (`reasoning` for Ollama and current vLLM; `reasoning_content` for
 * legacy vLLM and DeepSeek). This reads the union, in `precedence` order, and de-duplicates by
 * content value: a field whose text exactly matches one already kept is dropped.
 *
 * The result length encodes the emission rule the callers follow:
 * - `0` — no reasoning present.
 * - `1` — a single thought (covers "only one field present" AND "several present but identical").
 * - `≥2` — divergent fields; each surfaces as its own thought rather than silently dropping one.
 *
 * @param src - The response `message` or stream `delta` to read from.
 * @param precedence - Ordered, de-duplicated field names to read (see `reasoningFieldPrecedence`).
 * @returns The present, content-deduplicated reasoning traces in precedence order.
 */
export const extractReasoningFields = (
  src: Partial<Record<ReasoningField, string | null | undefined>> | undefined,
  precedence: ReasoningFieldPrecedence
): ReasoningExtract[] => {
  const out: ReasoningExtract[] = []
  for (const field of precedence) {
    const value = src?.[field]
    // Skip empty OR whitespace-only fields — a blank reasoning field carries no information and is just
    // a provider/model quirk; there's no point surfacing it as a Thought.
    if (typeof value !== 'string' || value.trim().length === 0) continue
    if (out.some((e) => e.content === value)) continue
    out.push({ field, content: value })
  }
  return out
}

// ─── Media rendering helpers (OpenAI content-block specific) ──────────────────

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

const audioFormatFromMime = (mime: string): 'wav' | 'mp3' | undefined => {
  const m = mime.toLowerCase()
  if (m.includes('wav') || m.includes('x-wav') || m.includes('wave')) return 'wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  return undefined
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
 * The inline media id-marker: a harness-authored text block rendered immediately BEFORE each
 * media content block, so the model can reference the media by id in subsequent tool calls
 * (`media_id` args, `@id` pipe refs).
 *
 * Trust posture: the marker is structural reference data authored by the harness from the
 * harness-controlled `Media.id` (a UUID, not derivable from the payload) — it is NOT payload
 * content, carries no authority, and deliberately renders OUTSIDE the untrusted envelope with
 * fixed, non-instruction phrasing. This is a documented cross-battery convention: every LLM
 * battery that renders media emits the same marker shape.
 */
const renderMediaIdMarker = (media: Media): string =>
  `[media id: ${media.id} | ${sanitizeFilenameForDescription(media.filename)}]`

const renderMediaToContentBlocks = async (input: {
  media: Media
  toolName: string | undefined
  nonce: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  warn?: (msg: string) => void
}): Promise<ChatCompletionsContentBlock[]> => {
  const blocks = await renderMediaBodyBlocks(input)
  return [{ type: 'text', text: renderMediaIdMarker(input.media) }, ...blocks]
}

const renderMediaBodyBlocks = async (input: {
  media: Media
  toolName: string | undefined
  nonce: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  warn?: (msg: string) => void
}): Promise<ChatCompletionsContentBlock[]> => {
  const { media, toolName, nonce, unsupportedMediaPolicy, warn } = input
  const modality = modalityHazardToAttr(media.modalityHazard)
  const kind = media.kind

  const fallbackPath = async (
    keys: ReadonlyArray<string>,
    allowSyntheticFallthrough: boolean
  ): Promise<ChatCompletionsContentBlock[]> => {
    const fallback = resolveFallbackStash(media, keys)
    if (fallback) {
      const text = renderTextInEnvelope(fallback.text, {
        // Floor the stash entry's tier to the parent media's tier: a stash entry may render LESS
        // trusted than its asset but never MORE (the committee's #1-ranked escalation).
        trustTier: floorTrustTier(media.trustTier, fallback.entryTier),
        modality,
        nonce,
        toolName,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
      })
      return [{ type: 'text', text }]
    }
    if (!allowSyntheticFallthrough) {
      // 'fallback-stash' falls through to 'synthetic-description' when no entry is found.
      warn?.(
        `unsupportedMediaPolicy='fallback-stash' for ${media.filename}: no matching stash entry — falling through to synthetic description.`
      )
    }
    const byteLen = await media.byteLength()
    const text = renderTextInEnvelope(renderSyntheticMediaDescription(media, byteLen), {
      trustTier: media.trustTier,
      modality,
      nonce,
      toolName,
      renderTrustedContent: input.renderTrustedContent,
      renderUntrustedContent: input.renderUntrustedContent,
    })
    return [{ type: 'text', text }]
  }

  if (kind === 'image') {
    const b64 = await media.asBase64()
    const safeMime = sanitizeMimeType(media.mimeType, 'image')
    return [
      {
        type: 'image_url',
        image_url: { url: `data:${safeMime};base64,${b64}` },
      },
    ]
  }

  if (kind === 'audio') {
    const fmt = audioFormatFromMime(media.mimeType)
    if (fmt === undefined) {
      // Audio mime not natively expressible — same policy path as video.
      if (unsupportedMediaPolicy === 'throw') {
        throw new E_UNSUPPORTED_MEDIA_MODALITY([media.kind, media.mimeType, media.filename])
      }
      if (
        unsupportedMediaPolicy === 'fallback-stash' ||
        (typeof unsupportedMediaPolicy === 'object' &&
          unsupportedMediaPolicy.mode === 'fallback-stash')
      ) {
        const keys =
          typeof unsupportedMediaPolicy === 'object'
            ? unsupportedMediaPolicy.stashKeys
            : DEFAULT_STASH_FALLBACK_KEYS
        return fallbackPath(keys, false)
      }
      return fallbackPath([], true)
    }
    const data = await media.asBase64()
    return [
      {
        type: 'input_audio',
        input_audio: { data, format: fmt },
      },
    ]
  }

  if (kind === 'document') {
    const b64 = await media.asBase64()
    const safeMime = sanitizeMimeType(media.mimeType)
    return [
      {
        type: 'file',
        file: {
          filename: media.filename,
          file_data: `data:${safeMime};base64,${b64}`,
        },
      },
    ]
  }

  // kind === 'video' — not natively supported by Chat Completions wire format.
  if (unsupportedMediaPolicy === 'throw') {
    throw new E_UNSUPPORTED_MEDIA_MODALITY([media.kind, media.mimeType, media.filename])
  }
  if (
    unsupportedMediaPolicy === 'fallback-stash' ||
    (typeof unsupportedMediaPolicy === 'object' && unsupportedMediaPolicy.mode === 'fallback-stash')
  ) {
    const keys =
      typeof unsupportedMediaPolicy === 'object'
        ? unsupportedMediaPolicy.stashKeys
        : DEFAULT_STASH_FALLBACK_KEYS
    return fallbackPath(keys, false)
  }
  return fallbackPath([], true)
}

// ─── renderTimelineMessage ────────────────────────────────────────────────────

/**
 * Renders a single timeline {@link @nhtio/adk!Message} into an OpenAI Chat Completions message —
 * mapping media to content blocks (`image_url` / `input_audio` / `file`), wrapping textual bodies
 * in the appropriate trust envelope, and applying the unsupported-media policy.
 */
export const renderTimelineMessage = async (input: {
  message: Message
  selfIdentity: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<ChatCompletionsMessage> => {
  const { message, selfIdentity, unsupportedMediaPolicy, warn } = input
  const identifier =
    message.identity?.identifier !== undefined && message.identity?.identifier !== null
      ? String(message.identity.identifier)
      : ''
  const representationRaw =
    message.identity?.representation !== undefined && message.identity?.representation !== null
      ? message.identity.representation.toString()
      : ''
  // Prompt-facing identity (the `from=` attribute) reads `representation`;
  // structural `messages[].name` reads `identifier`. Fall back to `identifier`
  // when `representation` is empty so a bare-string identity still renders.
  const representation = representationRaw.length > 0 ? representationRaw : identifier
  // Neutralise a body-embedded no-nonce developer-rules tier (envelope-mimicry defense): the legitimate
  // tier is harness-injected, never carried in a message body, so a mirrored copy here is always inert.
  const text = neutraliseDeveloperRulesTag(
    message.content !== undefined ? message.content.toString() : ''
  )
  const createdAtStr = message.createdAt.toISO?.() ?? ''
  const createdAtAttr = createdAtStr ? ` createdAt="${escapeXmlAttribute(createdAtStr)}"` : ''
  const attachments = message.attachments
  const hasAttachments = attachments.length > 0

  // Build the text envelope first (same logic as before).
  let envelopeText: string
  let nameField: string | undefined
  let role: 'user' | 'assistant'
  if (message.role === 'user') {
    role = 'user'
    if (identifier.length === 0) {
      envelopeText = text
    } else {
      nameField = sanitiseNameField(identifier)
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<message_${message.id} from="${fromAttr}" role="user"${createdAtAttr}>\n${text}\n</message_${message.id}>`
    }
  } else {
    role = 'assistant'
    if (identifier.length === 0 || identifier === selfIdentity) {
      if (identifier.length > 0) {
        nameField = sanitiseNameField(identifier)
      }
      envelopeText = text
    } else {
      nameField = sanitiseNameField(identifier)
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<peer_agent_output_${message.id} from="${fromAttr}"${createdAtAttr}>\n${text}\n</peer_agent_output_${message.id}>`
    }
  }

  if (!hasAttachments) {
    const out: ChatCompletionsMessage = { role, content: envelopeText }
    if (nameField !== undefined) out.name = nameField
    return out
  }

  // Content-array path: text first (when present), then attachment blocks in array order.
  const blocks: ChatCompletionsContentBlock[] = []
  if (text.length > 0) {
    blocks.push({ type: 'text', text: envelopeText })
  }
  for (const media of attachments) {
    const mediaBlocks = await renderMediaToContentBlocks({
      media,
      toolName: undefined,
      nonce: message.id,
      unsupportedMediaPolicy,
      renderTrustedContent,
      renderUntrustedContent,
      warn,
    })
    for (const b of mediaBlocks) blocks.push(b)
  }
  const out: ChatCompletionsMessage = { role, content: blocks }
  if (nameField !== undefined) out.name = nameField
  return out
}
/** Default timeline-message renderer; alias of {@link renderTimelineMessage}. */
export const defaultRenderTimelineMessage = renderTimelineMessage

// ─── renderChatCompletionsToolCallResult ──────────────────────────────────────

const isSpooledArtifactResult = (
  results: SpooledArtifact | Tokenizable
): results is SpooledArtifact =>
  isInstanceOf(results, 'SpooledArtifact') ||
  // Subclasses identify via the base class guard upstream
  ((results as unknown as { constructor?: { isSpooledArtifactConstructor?: boolean } })
    ?.constructor !== null &&
    (results as unknown as { constructor?: { isSpooledArtifactConstructor?: boolean } })
      ?.constructor !== undefined &&
    typeof (
      results as unknown as {
        constructor: { isSpooledArtifactConstructor?: (c: unknown) => boolean }
      }
    ).constructor.isSpooledArtifactConstructor === 'function')

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
  lineCount: number,
  estimatedTokens: number | undefined,
  encoding: string | undefined
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
  if (estimatedTokens !== undefined && encoding) {
    lines.push(`- estimatedTokens: ${estimatedTokens} (encoding: ${encoding})`)
  }
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
 * Renders a tool call's result(s) into the OpenAI Chat Completions tool-message body — either a
 * plain string or an array of content blocks when the result carries media — wrapping textual
 * output in the trust envelope appropriate to the tool's trust level.
 */
export const renderChatCompletionsToolCallResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<string | ChatCompletionsContentBlock[]> => {
  const { toolCall, results, tool, warn, unsupportedMediaPolicy } = input
  const isTrusted =
    tool !== null && tool !== undefined && (tool as { trusted?: boolean }).trusted === true

  if (tool === undefined) {
    warn?.(
      `Tool "${toolCall.tool}" is not present in the bound tool registry at render time; defaulting to untrusted envelope.`
    )
  }

  // Media / Media[] silo — bypasses Tool.trusted (Trust-Is-Content rule). Envelope is sourced
  // from each Media's own trustTier; modality from each Media's modalityHazard.
  const isMediaResult = Media.isMedia(results)
  const isMediaArrayResult =
    Array.isArray(results) && results.length > 0 && results.every((r) => Media.isMedia(r))
  if (isMediaResult || isMediaArrayResult) {
    const mediaList = isMediaResult ? [results as Media] : (results as Media[])
    const blocks: ChatCompletionsContentBlock[] = []
    for (const media of mediaList) {
      const mediaBlocks = await renderMediaToContentBlocks({
        media,
        toolName: toolCall.tool,
        nonce: toolCall.checksum,
        unsupportedMediaPolicy,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
        warn,
      })
      for (const b of mediaBlocks) blocks.push(b)
    }
    return blocks
  }

  // SpooledArtifact[] silo — render each artifact through the existing single-artifact path
  // and concatenate the bodies. Trust envelope is decided per-artifact via the surrounding
  // Tool.trusted flag (same as single SpooledArtifact today).
  if (Array.isArray(results)) {
    const parts: string[] = []
    for (const a of results) {
      const body = await (a as SpooledArtifact).asString()
      parts.push(body)
    }
    const joined = parts.join('\n\n')
    if (isTrusted) {
      return input.renderTrustedContent(joined, {
        nonce: toolCall.checksum,
        kind: 'trusted-tool-result',
        tool: toolCall.tool,
      })
    }
    return input.renderUntrustedContent(joined, {
      nonce: toolCall.checksum,
      kind: 'tool-result',
      tool: toolCall.tool,
    })
  }

  const isSpooled = looksLikeSpooledArtifact(results)

  // Handle-pattern branch: spooled + inline=false → always untrusted (queryable-data, not policy).
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
    const body = renderArtifactHandleBody(
      toolCall,
      artifact,
      byteLength,
      lineCount,
      undefined,
      undefined
    )
    return input.renderUntrustedContent(body, {
      nonce: toolCall.checksum,
      kind: 'artifact-handle',
      tool: toolCall.tool,
    })
  }

  // Inline path: render full body via the appropriate envelope. A Tokenizable result (an ArtifactTool
  // query answer, an error string) has no queryable artifact to hand back, so it always renders inline
  // regardless of the `inline` flag — under handle-by-default (inline:false) this is the ordinary case,
  // not a misconfiguration, so it is silent.
  let body: string
  if (isSpooled) {
    body = await (results as SpooledArtifact).asString()
  } else {
    body = (results as Tokenizable).toString()
  }

  if (isTrusted) {
    return input.renderTrustedContent(body, {
      nonce: toolCall.checksum,
      kind: 'trusted-tool-result',
      tool: toolCall.tool,
    })
  }
  return input.renderUntrustedContent(body, {
    nonce: toolCall.checksum,
    kind: 'tool-result',
    tool: toolCall.tool,
  })
}
/** Default tool-call-result renderer; alias of {@link renderChatCompletionsToolCallResult}. */
export const defaultRenderChatCompletionsToolCallResult = renderChatCompletionsToolCallResult

// suppress unused; kept for forward-compat with stricter spool guards
void isSpooledArtifactResult

// ─── buildChatCompletionsHistory ──────────────────────────────────────────────

type TimelineItem =
  | { kind: 'message'; createdAt: number; value: Message }
  | { kind: 'thought'; createdAt: number; value: Thought }
  | { kind: 'toolCall'; createdAt: number; value: ToolCall }

/**
 * Assembles the complete OpenAI Chat Completions message history for a dispatch — system prompt and
 * content buckets, the interleaved timeline of messages/thoughts/tool calls (with synthetic
 * `assistant.tool_calls` and `tool.tool_call_id` shaping), and the collected opaque reasoning
 * payloads — by delegating to the injected sub-renderers.
 */
export const buildChatCompletionsHistory = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  messages: Iterable<Message>
  thoughts: Iterable<Thought>
  toolCalls: Iterable<ToolCall>
  tools: ToolRegistry
  renderedToolCallResults: Map<string, string | ChatCompletionsContentBlock[]>
  bucketOrder: ChatCompletionsBucketOrder
  selfIdentity: string
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  replayCompatibility: ReadonlyArray<string>
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderChatCompletionsToolCallResult: ChatCompletionsHelpers['renderChatCompletionsToolCallResult']
  renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
  renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
  renderMemories: ChatHelpersCommon['renderMemories']
  renderRetrievables: ChatHelpersCommon['renderRetrievables']
  renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
  renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
  renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
  renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
  renderTimelineMessage: ChatCompletionsHelpers['renderTimelineMessage']
  renderThought: ChatHelpersCommon['renderThought']
  filterThoughts: ChatHelpersCommon['filterThoughts']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  warn?: (msg: string) => void
}): Promise<{
  messages: ChatCompletionsMessage[]
  reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
}> => {
  const out: ChatCompletionsMessage[] = []
  const reasoningPayloads: Array<{
    id: string
    replayCompatibility: string
    payload: unknown
  }> = []

  const buckets = input.bucketOrder
  const timelineIdx = buckets.indexOf('timeline')

  // Build leading system content from base prompt + before-timeline buckets.
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
    renderUntrustedContent: input.renderUntrustedContent,
  })
  if (leadingSystem.length > 0) {
    out.push({ role: 'system', content: leadingSystem })
  }

  // Build the timeline (if present in bucketOrder).
  const includesTimeline = timelineIdx !== -1
  if (includesTimeline) {
    // Filter thoughts per surfacing mode + compatibility.
    const survivingThoughts = input.filterThoughts(
      input.thoughts,
      input.thoughtSurfacing,
      input.selfIdentity,
      input.replayCompatibility
    )

    // Build sorted timeline items.
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
          await input.renderTimelineMessage({
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
          // Opaque reasoning — side-channel + summary envelope.
          reasoningPayloads.push({
            id: t.id,
            replayCompatibility: compatTag,
            payload: t.payload,
          })
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
          const synthetic: ChatCompletionsMessage = {
            role: 'assistant',
            content: envelope,
          }
          if (!isSelf && identifier.length > 0) {
            synthetic.name = sanitiseNameField(identifier)
          }
          out.push(synthetic)
        } else if (!hasPayload) {
          // Plain-text reasoning (no payload, or tagged plain-text, or tagged but matched).
          const envelope = input.renderThought(t.content.toString(), {
            nonce: t.id,
            kind: isSelf ? 'self-reasoning' : 'peer-reasoning',
            from: identifier,
            createdAt: t.createdAt?.toISO?.() ?? undefined,
          })
          const synthetic: ChatCompletionsMessage = {
            role: 'assistant',
            content: envelope,
          }
          if (!isSelf && identifier.length > 0) {
            synthetic.name = sanitiseNameField(identifier)
          }
          out.push(synthetic)
        }
        // else: opaque, non-matching → elided (NOT removed from ctx.turnThoughts upstream).
      } else {
        // tool call: emit a synthetic assistant message carrying tool_calls[],
        // followed by a tool-role message with the result.
        const tc = item.value
        const assistantMsg: ChatCompletionsMessage = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: tc.id,
              type: 'function',
              function: {
                name: tc.tool,
                arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
              },
            },
          ],
        }
        out.push(assistantMsg)

        let rendered = input.renderedToolCallResults.get(tc.id)
        if (rendered === undefined) {
          const tool = input.tools.get?.(tc.tool)
          rendered = await input.renderChatCompletionsToolCallResult({
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
        out.push({
          role: 'tool',
          content: rendered,
          tool_call_id: tc.id,
        })
      }
    }
  }

  // Trailing system message for after-timeline buckets.
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
/** Default history assembler; alias of {@link buildChatCompletionsHistory}. */
export const defaultBuildChatCompletionsHistory = buildChatCompletionsHistory

// ─── createChatCompletionsToolCallDeltaAccumulator ────────────────────────────

/**
 * Creates a fresh accumulator that stitches streamed {@link ChatCompletionsToolCallDelta} fragments
 * (keyed by their stream index) into fully-assembled tool calls, drained once the stream completes.
 */
export const createChatCompletionsToolCallDeltaAccumulator =
  (): ChatCompletionsToolCallDeltaAccumulator => {
    const byIndex = new Map<
      number,
      { id?: string; type?: 'function'; name: string; args: string }
    >()
    return {
      feed(delta: ChatCompletionsToolCallDelta): void {
        const idx = delta.index
        let entry = byIndex.get(idx)
        if (!entry) {
          entry = { name: '', args: '' }
          byIndex.set(idx, entry)
        }
        if (delta.id !== undefined) entry.id = delta.id
        if (delta.type !== undefined) entry.type = delta.type
        if (delta.function?.name !== undefined) {
          entry.name = entry.name + delta.function.name
        }
        if (delta.function?.arguments !== undefined) {
          entry.args = entry.args + delta.function.arguments
        }
      },
      drain(): AssembledToolCall[] {
        const out: AssembledToolCall[] = []
        const indices = Array.from(byIndex.keys()).sort((a, b) => a - b)
        for (const idx of indices) {
          const e = byIndex.get(idx)!
          out.push({
            id: e.id ?? `call_${idx}`,
            type: e.type ?? 'function',
            name: e.name,
            args: e.args,
          })
        }
        return out
      },
    }
  }
/** Default delta-accumulator factory; alias of {@link createChatCompletionsToolCallDeltaAccumulator}. */
export const defaultCreateChatCompletionsToolCallDeltaAccumulator =
  createChatCompletionsToolCallDeltaAccumulator
