/**
 * Swappable translation helpers for rendering ADK state into OpenAI Responses requests.
 *
 * @module @nhtio/adk/batteries/llm/openai_responses/helpers
 *
 * @remarks
 * The swappable translation helpers that turn ADK primitives into OpenAI Responses wire shapes.
 * Each helper is exported under its unprefixed name AND under a `default*` alias so consumers can
 * compose partial overrides. Helpers that compose other helpers receive their dependents via
 * explicit input arguments — never via module-level closure — so a swap at any layer propagates
 * correctly.
 *
 * The wire-shape-AGNOSTIC helpers (`renderUntrustedContent`, `renderMemories`,
 * `renderChatCompletionsSystemPrompt`, `descriptionToChatCompletionsJsonSchema`,
 * `canonicalFingerprint`, …) live in the shared, internal `../chat_common/helpers` submodule and
 * are re-exported here under their original names so every existing import keeps resolving. Only
 * the Responses-WIRE-SPECIFIC helpers (media mapping, timeline-message rendering, tool-call-result
 * rendering, the `buildOpenAIResponsesInput` assembler, the reasoning-replay machinery, the
 * fingerprint wrapper, the tool-declaration translator, and the streaming output-slot state
 * machine) are defined here.
 */

import { Media } from '@nhtio/adk/common'
import { E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  escapeXmlAttribute,
  memoryToAttrs,
  retrievableToAttrs,
  neutraliseDeveloperRulesTag,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  floorTrustTier,
  looksLikeSpooledArtifact,
  canonicalFingerprint,
  defaultRenderArtifactHandleBody,
  defaultRenderRetrievableHandleBody,
  // Bound locally (not just re-exported below) so the trust-boundary fallback can build the
  // envelope with the DEFAULT renderer when a consumer's override swallows its body.
  defaultRenderTrustedContent,
  defaultRenderUntrustedContent,
} from '../chat_common/helpers'
import type { ChatHelpersCommon } from '../chat_common/types'
import type {
  Tool,
  ArtifactTool,
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
  OpenAIResponsesInputContentBlock,
  OpenAIResponsesInputItem,
  OpenAIResponsesMessageItem,
  OpenAIResponsesOutputMessageItem,
  OpenAIResponsesFunctionCallItem,
  OpenAIResponsesFunctionCallOutputItem,
  OpenAIResponsesReasoningItem,
  OpenAIResponsesTool,
  OpenAIResponsesHelpers,
  OpenAIResponsesReasoningReplayPayload,
  ResponsesOutputSlot,
  ResponsesOutputSlotMachine,
  UnsupportedMediaPolicy,
  JsonSchema,
  ReasoningReplayMode,
} from './types'

// ─── Re-exported wire-shape-agnostic helpers (shared submodule) ───────────────
// These are defined once in `../chat_common/helpers` and shared with the other Chat-family
// batteries. Re-exported here (bare + `default*`) so every existing
// `@nhtio/adk/batteries/llm/openai_responses` import keeps resolving unchanged.
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
  canonicalFingerprint,
  defaultCanonicalFingerprint,
  looksLikeSpooledArtifact,
} from '../chat_common/helpers'

// ─── Media rendering (Responses content-block specific) ──────────────────────

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

const formatBytesHumanReadable = (bytes: number | undefined): string => {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const renderSyntheticMediaDescription = (media: Media, byteLen: number | undefined): string =>
  `[media: ${sanitizeFilenameForDescription(media.filename)}, ${sanitizeMimeType(media.mimeType, media.kind === 'image' ? media.kind : undefined)}, ${formatBytesHumanReadable(byteLen)}]`

/**
 * The inline media id-marker rendered immediately BEFORE each media content block — see the
 * identical convention documented in `openai_chat_completions/helpers.ts`.
 */
const renderMediaIdMarker = (media: Media): string =>
  `[media id: ${media.id} | ${sanitizeFilenameForDescription(media.filename)}]`

/**
 * Implements {@link OpenAIResponsesHelpers.renderOpenAIResponsesMediaBlocks}.
 *
 * @remarks
 * `image` maps to `input_image` (a data URI). `document` maps to `input_file` using the
 * NOW-CONFIRMED `file_data: 'data:<mime>;base64,<b64>'` shape (a live probe against the real
 * Responses API accepted this exact shape with `filename` alongside it — see the battery's design
 * notes). `audio`/`video` — and any other kind/mime this battery cannot natively express — route
 * through `unsupportedMediaPolicy`, unchanged.
 */
export const renderOpenAIResponsesMediaBlocks = async (input: {
  media: Media
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  warn?: (msg: string) => void
}): Promise<OpenAIResponsesInputContentBlock[]> => {
  const { media, unsupportedMediaPolicy, warn } = input
  const modality = modalityHazardToAttr(media.modalityHazard)

  const fallbackPath = async (
    keys: ReadonlyArray<string>,
    allowSyntheticFallthrough: boolean
  ): Promise<OpenAIResponsesInputContentBlock[]> => {
    const fallback = resolveFallbackStash(media, keys)
    if (fallback) {
      const text = renderTextInEnvelope(fallback.text, {
        trustTier: floorTrustTier(media.trustTier, fallback.entryTier),
        modality,
        nonce: media.id,
        toolName: undefined,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
      })
      return [{ type: 'input_text', text: `${renderMediaIdMarker(media)}\n${text}` }]
    }
    if (!allowSyntheticFallthrough) {
      warn?.(
        `unsupportedMediaPolicy='fallback-stash' for ${media.filename}: no matching stash entry — falling through to synthetic description.`
      )
    }
    const byteLen = await media.byteLength()
    const text = renderTextInEnvelope(renderSyntheticMediaDescription(media, byteLen), {
      trustTier: media.trustTier,
      modality,
      nonce: media.id,
      toolName: undefined,
      renderTrustedContent: input.renderTrustedContent,
      renderUntrustedContent: input.renderUntrustedContent,
    })
    return [{ type: 'input_text', text: `${renderMediaIdMarker(media)}\n${text}` }]
  }

  const unsupported = async (): Promise<OpenAIResponsesInputContentBlock[]> => {
    if (unsupportedMediaPolicy === 'throw') {
      throw new E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY([
        media.kind,
        media.mimeType,
        media.filename,
      ])
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

  if (media.kind === 'image') {
    const safeMime = sanitizeMimeType(media.mimeType, 'image')
    const b64 = await media.asBase64()
    return [
      { type: 'input_text', text: renderMediaIdMarker(media) },
      {
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${safeMime};base64,${b64}`,
      },
    ]
  }

  if (media.kind === 'document') {
    const safeMime = sanitizeMimeType(media.mimeType)
    const b64 = await media.asBase64()
    return [
      { type: 'input_text', text: renderMediaIdMarker(media) },
      {
        type: 'input_file',
        filename: media.filename,
        file_data: `data:${safeMime};base64,${b64}`,
      },
    ]
  }

  // audio / video — no native Responses representation (confirmed against the openai SDK's own
  // type definitions: ResponseInputContent has no audio member, and no video member either).
  return unsupported()
}
/** Default OpenAI Responses media renderer; alias of {@link renderOpenAIResponsesMediaBlocks}. */
export const defaultRenderOpenAIResponsesMediaBlocks = renderOpenAIResponsesMediaBlocks

// ─── renderOpenAIResponsesTimelineMessage ─────────────────────────────────────

/**
 * Implements {@link OpenAIResponsesHelpers.renderOpenAIResponsesTimelineMessage}.
 *
 * @remarks
 * A USER message, or a peer-identity ASSISTANT message (a message from an assistant identity that
 * is not this adapter's own `selfIdentity`), renders as a plain `role`-carrying input message item
 * — the ADK's own prior assistant turns are NOT routed through this renderer; the caller renders
 * those via {@link renderOpenAIResponsesOwnAssistantMessage} instead, into the OUTPUT-message shape
 * the reasoning-pairing validator expects (see the module's Known Gotchas).
 */
export const renderOpenAIResponsesTimelineMessage = async (input: {
  message: Message
  selfIdentity: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderOpenAIResponsesMediaBlocks: OpenAIResponsesHelpers['renderOpenAIResponsesMediaBlocks']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  warn?: (msg: string) => void
}): Promise<OpenAIResponsesInputItem | null> => {
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

  let envelopeText: string
  const role: 'user' | 'assistant' = message.role
  if (message.role === 'user') {
    if (identifier.length === 0) {
      envelopeText = text
    } else {
      const fromAttr = escapeXmlAttribute(representation)
      envelopeText = `<message_${message.id} from="${fromAttr}" role="user"${createdAtAttr}>\n${text}\n</message_${message.id}>`
    }
  } else {
    // Peer-identity assistant turn — the ADK's own assistant turns never reach this renderer.
    const fromAttr = escapeXmlAttribute(representation)
    envelopeText = `<peer_agent_output_${message.id} from="${fromAttr}"${createdAtAttr}>\n${text}\n</peer_agent_output_${message.id}>`
  }

  const content: OpenAIResponsesInputContentBlock[] = []
  if (envelopeText.length > 0) {
    content.push({ type: 'input_text', text: envelopeText })
  }
  for (const media of message.attachments) {
    const blocks = await input.renderOpenAIResponsesMediaBlocks({
      media,
      unsupportedMediaPolicy,
      renderUntrustedContent: input.renderUntrustedContent,
      renderTrustedContent: input.renderTrustedContent,
      warn,
    })
    for (const b of blocks) content.push(b)
  }
  if (content.length === 0) return null
  const out: OpenAIResponsesMessageItem = { role, content }
  void selfIdentity
  return out
}
/** Default timeline-message renderer; alias of {@link renderOpenAIResponsesTimelineMessage}. */
export const defaultRenderOpenAIResponsesTimelineMessage = renderOpenAIResponsesTimelineMessage

// ─── renderOpenAIResponsesToolCallResult ──────────────────────────────────────

/**
 * Implements {@link OpenAIResponsesHelpers.renderOpenAIResponsesToolCallResult}.
 *
 * @remarks
 * Renders a tool call's result(s) into the shape a `function_call_output` item's `output` field
 * accepts — either a plain string or an array of content blocks when the result carries media —
 * mirroring `openai_chat_completions/helpers.ts`'s `renderChatCompletionsToolCallResult` structure.
 */
export const renderOpenAIResponsesToolCallResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  renderOpenAIResponsesMediaBlocks: OpenAIResponsesHelpers['renderOpenAIResponsesMediaBlocks']
  renderArtifactHandleBody?: ChatHelpersCommon['renderArtifactHandleBody']
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<string | OpenAIResponsesInputContentBlock[]> => {
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
    const blocks: OpenAIResponsesInputContentBlock[] = []
    for (const media of mediaList) {
      const rendered = await input.renderOpenAIResponsesMediaBlocks({
        media,
        unsupportedMediaPolicy,
        renderTrustedContent: input.renderTrustedContent,
        renderUntrustedContent: input.renderUntrustedContent,
        warn,
      })
      for (const b of rendered) blocks.push(b)
    }
    // Trust framing for tool-returned NATIVE media. A native `input_image`/`input_file` cannot be
    // wrapped in a text envelope without destroying the wire representation the provider needs, so
    // the boundary is emitted as text blocks that BRACKET the native ones. Without this, an
    // untrusted tool's image/document arrived preceded only by an id marker — making instructions
    // embedded in the media indistinguishable from first-party attachments. The envelope is keyed
    // on the TOOL's `trusted` flag (same basis as every textual branch below), not on the media's
    // own tier: the question here is whether the tool that produced it is trusted.
    //
    // The envelope is rendered around a unique SENTINEL body rather than an empty one, then split
    // on that sentinel. Going through the configured renderer (instead of hand-writing the tags)
    // keeps a consumer's overridden `renderTrustedContent`/`renderUntrustedContent` authoritative;
    // splitting on a sentinel — rather than on a newline — makes the split independent of whatever
    // delimiter that renderer happens to use.
    const sentinel = `__adk_media_boundary_${toolCall.checksum}__`
    const envelope = isTrusted
      ? input.renderTrustedContent(sentinel, {
          nonce: toolCall.checksum,
          kind: 'trusted-tool-result-media',
          tool: toolCall.tool,
        })
      : input.renderUntrustedContent(sentinel, {
          nonce: toolCall.checksum,
          kind: 'tool-result-media',
          tool: toolCall.tool,
        })
    const sentinelAt = envelope.indexOf(sentinel)
    if (sentinelAt < 0) {
      // A custom renderer dropped the body entirely, so its output cannot be split into an
      // open/close pair. FAIL SAFE: fall back to the DEFAULT renderer to build the boundary rather
      // than shipping the media unframed. Returning the bare blocks here (the previous behaviour)
      // meant any consumer override that swallowed its body silently disabled the trust boundary
      // on exactly the untrusted tool media it exists to frame — a security control must not
      // degrade to "off" because a pluggable renderer misbehaved.
      warn?.(
        `Trust-envelope renderer did not emit its body for tool "${toolCall.tool}"; falling back to the default renderer so the trust boundary is still applied.`
      )
      const fallbackEnvelope = isTrusted
        ? defaultRenderTrustedContent(sentinel, {
            nonce: toolCall.checksum,
            kind: 'trusted-tool-result-media',
            tool: toolCall.tool,
          })
        : defaultRenderUntrustedContent(sentinel, {
            nonce: toolCall.checksum,
            kind: 'tool-result-media',
            tool: toolCall.tool,
          })
      const at = fallbackEnvelope.indexOf(sentinel)
      // The default renderers always emit their body, so `at` cannot be < 0 here; the guard is
      // belt-and-braces so a future change to them can never reintroduce unframed media.
      if (at >= 0) {
        return [
          { type: 'input_text', text: fallbackEnvelope.slice(0, at).trimEnd() },
          ...blocks,
          { type: 'input_text', text: fallbackEnvelope.slice(at + sentinel.length).trimStart() },
        ]
      }
      return blocks
    }
    const openTag = envelope.slice(0, sentinelAt).trimEnd()
    const closeTag = envelope.slice(sentinelAt + sentinel.length).trimStart()
    return [
      { type: 'input_text', text: openTag },
      ...blocks,
      { type: 'input_text', text: closeTag },
    ]
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
    const body = (input.renderArtifactHandleBody ?? defaultRenderArtifactHandleBody)({
      callId: toolCall.id,
      artifact,
      byteLength,
      lineCount,
    })
    return input.renderUntrustedContent(body, {
      nonce: toolCall.checksum,
      kind: 'artifact-handle',
      tool: toolCall.tool,
    })
  }

  let body: string
  if (isSpooled) {
    body = await (results as SpooledArtifact).asString()
  } else {
    body = (results as Tokenizable).toString()
  }

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
/** Default tool-call-result renderer; alias of {@link renderOpenAIResponsesToolCallResult}. */
export const defaultRenderOpenAIResponsesToolCallResult = renderOpenAIResponsesToolCallResult

// ─── toolsToOpenAIResponsesTools ───────────────────────────────────────────────

/**
 * Implements {@link OpenAIResponsesHelpers.toolsToOpenAIResponsesTools}.
 *
 * @remarks
 * `name` is TOP-LEVEL, unlike Chat Completions' `{type:'function', function:{name, ...}}` nesting.
 * Reuses the shared, unmodified `descriptionToChatCompletionsJsonSchema` for the JSON Schema body —
 * only the envelope differs.
 */
export const toolsToOpenAIResponsesTools = (
  tools: ReadonlyArray<Tool | ArtifactTool>,
  deps: { descriptionToChatCompletionsJsonSchema: (d: unknown) => JsonSchema; strict?: boolean }
): OpenAIResponsesTool[] =>
  tools.map((tool) => {
    const described = tool.describe()
    const parameters = deps.descriptionToChatCompletionsJsonSchema(described.inputSchema)
    return {
      type: 'function' as const,
      name: described.name,
      description: described.description,
      parameters:
        parameters && Object.keys(parameters).length > 0
          ? parameters
          : { type: 'object', properties: {} },
      ...(deps.strict !== undefined ? { strict: deps.strict } : {}),
    }
  })
/** Default tool-translation helper; alias of {@link toolsToOpenAIResponsesTools}. */
export const defaultToolsToOpenAIResponsesTools = toolsToOpenAIResponsesTools

// ─── fingerprintOpenAIResponsesPrefix ─────────────────────────────────────────

/**
 * Implements {@link OpenAIResponsesHelpers.fingerprintOpenAIResponsesPrefix}.
 *
 * @remarks
 * Computes the fingerprint used for OpenAI Responses reasoning-item replay. The input is the exact
 * assembled request prefix: `model`, `instructions`, `tools`, and `input` through (but not
 * including) the item at `throughItem`. Assembles the Responses-shaped prefix object and delegates
 * canonicalisation + hashing to the shared, wire-agnostic {@link canonicalFingerprint} primitive —
 * mirroring `fingerprintAnthropicMessagesPrefix`'s shape-and-slice pattern exactly: object keys are
 * recursively sorted; array order and item boundaries are preserved.
 */
export const fingerprintOpenAIResponsesPrefix = async (input: {
  model: string
  instructions?: string
  tools?: OpenAIResponsesTool[]
  input: OpenAIResponsesInputItem[]
  throughItem?: number
}): Promise<string> => {
  const items =
    input.throughItem === undefined ? input.input : input.input.slice(0, input.throughItem)
  return canonicalFingerprint({
    model: input.model,
    instructions: input.instructions,
    tools: input.tools,
    input: items,
  })
}

// ─── renderOpenAIResponsesReasoningItem ───────────────────────────────────────

/**
 * Implements {@link OpenAIResponsesHelpers.renderOpenAIResponsesReasoningItem}.
 *
 * @remarks
 * Converts an eligible stored {@link OpenAIResponsesReasoningReplayPayload} into a wire `reasoning`
 * item, or `undefined` if ineligible (no payload, wrong variant, or a stale fingerprint). The
 * adjacency-sweep pass in {@link buildOpenAIResponsesInput} is what actually enforces the
 * reasoning/output-item pairing constraint (Known Gotcha #1) — this function only validates the
 * signature/fingerprint half of eligibility.
 *
 * Under `reasoningReplay: 'summary-only'`, the returned item strips `content`
 * (full reasoning text) and `encrypted_content` — only `summary` is replayed. `'encrypted'` (or any
 * other non-`'off'` mode) returns the stored item verbatim.
 */
export const renderOpenAIResponsesReasoningItem = (input: {
  thought: Thought
  prefixFingerprint: string
  replayCompatibility: ReadonlyArray<string>
  reasoningReplay: ReasoningReplayMode
  warn?: (msg: string) => void
}): OpenAIResponsesReasoningItem | undefined => {
  if (!input.replayCompatibility.includes(input.thought.replayCompatibility ?? '')) return undefined
  const payload = input.thought.payload as
    | Partial<OpenAIResponsesReasoningReplayPayload>
    | undefined
  if (!payload || payload.variant !== 'responses-reasoning' || !payload.item) return undefined
  if (payload.prefixFingerprint !== input.prefixFingerprint) {
    input.warn?.(
      `Dropping stale OpenAI Responses reasoning signature for thought ${input.thought.id}.`
    )
    return undefined
  }
  if (input.reasoningReplay === 'summary-only') {
    const summaryOnly: OpenAIResponsesReasoningItem = { ...payload.item }
    delete summaryOnly.content
    delete summaryOnly.encrypted_content
    return summaryOnly
  }
  return payload.item
}
/** Default reasoning-item renderer; alias of {@link renderOpenAIResponsesReasoningItem}. */
export const defaultRenderOpenAIResponsesReasoningItem = renderOpenAIResponsesReasoningItem

// ─── buildOpenAIResponsesInput ─────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'message'; at: number; value: Message }
  | { kind: 'thought'; at: number; value: Thought }
  | { kind: 'toolCall'; at: number; value: ToolCall }

/** Renders the ADK's OWN prior assistant text into the OUTPUT-message shape (see the module docs). */
const renderOwnAssistantOutputItem = (
  message: Message
): OpenAIResponsesOutputMessageItem | null => {
  const text = neutraliseDeveloperRulesTag(message.content?.toString() ?? '')
  if (text.length === 0) return null
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    // Normalized, not passed through. `Message.id` is application-generated and unconstrained,
    // while a Responses item id must satisfy the provider's charset and 64-character limit — an
    // oversized or oddly-charactered id gets the whole continuation request rejected. This is the
    // same normalization already applied to replayed reasoning item ids.
    id: normalizeOpenAIResponsesItemId(message.id),
    content: [{ type: 'output_text', text, annotations: [] }],
  }
}

/**
 * Splits an ADK composite tool-call id (`` `${callId}|${itemId}` ``, per the plan's composite-id
 * convention) into its `call_id`/item-`id` parts. Drops a non-`fc_`-prefixed item id rather than
 * send an invalid one — the item id half is only ever meaningful when it came from a genuine prior
 * Responses `function_call` item.
 */
const splitCompositeToolCallId = (id: string): { callId: string; itemId: string | undefined } => {
  if (!id.includes('|')) return { callId: id, itemId: undefined }
  const [callId, itemId] = id.split('|')
  if (!callId) return { callId: id, itemId: undefined }
  if (!itemId || !itemId.startsWith('fc_')) return { callId, itemId: undefined }
  return { callId, itemId }
}

/**
 * Implements {@link OpenAIResponsesHelpers.buildOpenAIResponsesInput}.
 *
 * @remarks
 * Algorithm (mirrors the plan's Part 2 spec exactly):
 *
 * 1. Leading `instructions` (or leading `developer`/`system`-role item, per `systemPromptChannel`)
 *    — ALWAYS ADK-rendered via `renderChatCompletionsSystemPrompt`; there is no consumer-facing
 *    escape hatch.
 * 2. Timeline: messages/thoughts/tool-calls merged and sorted by `createdAt`. A tool call renders
 *    as two SIBLING top-level items (`function_call` then `function_call_output`), with composite
 *    id splitting. A thought replays as a native `reasoning` item only when `reasoningReplay !==
 *    'off'` and a valid, prefix-matched signature exists; otherwise it renders as plain text.
 * 3. Reasoning-pairing enforcement pass — walks `input` left to right, dropping any `reasoning`
 *    item not immediately followed by its paired output item, and stripping the `id` from an
 *    output item whose paired reasoning item was just dropped.
 * 4. Trailing buckets (`bucketOrder` labels after `'timeline'`) render as a trailing
 *    `{type:'message', role:'system', ...}` item.
 *
 * ## Load-bearing invariants
 *
 * These are consequences of the step ORDER above, not incidental details. Both were unwritten
 * once, and both were violated in ways that silently disabled reasoning replay — so they are
 * stated here explicitly and pinned by executable tests (see
 * `tests/unit/batteries/llm/openai_responses/reasoning_replay.cross.spec.ts`, "assembly
 * invariants").
 *
 * 1. **The step-3 sweep only ever sees a PREFIX of the final `input`.** Step 4 appends the
 *    trailing bucket AFTER the sweep has run, so any item added there is invisible to every
 *    fingerprint the sweep computes. A reasoning-replay fingerprint must therefore cover only the
 *    sweep-visible region — that is what the returned `fingerprintableLength` marks, and why
 *    `persistThought` passes it as `throughItem`. Hashing the whole `input` instead cannot match
 *    on the next turn whenever a trailing bucket exists, and drops every replayed item as stale.
 *
 * 2. **A reasoning item must sort STRICTLY BEFORE the output item it is paired with.** The step-2
 *    timeline pushes messages before thoughts and then applies a STABLE sort by `createdAt`, so on
 *    an identical timestamp the message wins the tie and lands ahead of its own reasoning item —
 *    leaving that item unpaired, and the step-3 sweep drops it. Callers persisting a thought and
 *    its message from one response must therefore assign strictly increasing timestamps rather
 *    than calling a clock twice (two `DateTime.now()` calls collide ~998 times in 1000).
 *
 * 3. **`tools` is `undefined`, never `[]`, when the registry is empty** (see the return shape).
 *    Fingerprints on both the persist and validate side must use that same shape:
 *    `canonicalFingerprint` serialises `undefined` and `[]` to different bytes, so coercing on one
 *    side only makes every hash mismatch for tool-less agents.
 */
export const buildOpenAIResponsesInput = async (
  input: Parameters<OpenAIResponsesHelpers['buildOpenAIResponsesInput']>[0]
): Promise<Awaited<ReturnType<OpenAIResponsesHelpers['buildOpenAIResponsesInput']>>> => {
  const tools = input.toolsToOpenAIResponsesTools(input.tools.visible(), {
    descriptionToChatCompletionsJsonSchema: (d: unknown) =>
      input.descriptionToChatCompletionsJsonSchema(d as never),
    strict: input.strict,
  })

  // ── Step 1: leading system content ──────────────────────────────────────────
  const leadingSystemText = await input.renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    // Forwarded so a dynamic `systemPrompt` resolves against the live dispatch context rather
    // than `undefined`.
    renderCtx: input.renderCtx,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: input.bucketOrder,
    renderStandingInstructions: input.renderStandingInstructions,
    renderMemories: input.renderMemories,
    renderRetrievables: input.renderRetrievables,
    renderRetrievableHandleBody: input.renderRetrievableHandleBody,
    renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
    renderUntrustedContent: input.renderUntrustedContent,
  })

  const items: OpenAIResponsesInputItem[] = []
  let instructions: string | undefined
  if (leadingSystemText.length > 0) {
    if (input.systemPromptChannel === 'instructions') {
      instructions = leadingSystemText
    } else {
      const role = input.systemPromptChannel === 'system-item' ? 'system' : 'developer'
      items.push({ role, content: [{ type: 'input_text', text: leadingSystemText }] })
    }
  }

  // ── Step 2: timeline ─────────────────────────────────────────────────────────
  const buckets = input.bucketOrder
  const timelineIdx = buckets.indexOf('timeline')
  const includesTimeline = timelineIdx !== -1

  // Track which reasoning items are candidates for the adjacency-sweep pass (step 3): the item
  // itself, plus the thought it came from (for warn messages).
  const reasoningCandidates: Array<{ item: OpenAIResponsesReasoningItem; thought: Thought }> = []

  if (includesTimeline) {
    const filteredThoughts = input.filterThoughts(
      input.thoughts,
      input.thoughtSurfacing,
      input.selfIdentity,
      input.replayCompatibility
    )

    const timeline: TimelineItem[] = []
    for (const m of input.messages)
      timeline.push({ kind: 'message', at: m.createdAt.toMillis(), value: m })
    for (const t of filteredThoughts)
      timeline.push({ kind: 'thought', at: t.createdAt.toMillis(), value: t })
    for (const tc of input.toolCalls)
      timeline.push({ kind: 'toolCall', at: tc.createdAt.toMillis(), value: tc })
    timeline.sort((a, b) => a.at - b.at)

    for (const entry of timeline) {
      if (entry.kind === 'message') {
        const m = entry.value
        const identifier = String(m.identity?.identifier ?? '')
        const isOwnOutput = m.role === 'assistant' && identifier === input.selfIdentity
        if (isOwnOutput) {
          const rendered = renderOwnAssistantOutputItem(m)
          if (rendered) items.push(rendered)
          for (const media of m.attachments) {
            // Own-output attachments are rare in practice (assistant turns don't normally carry
            // media), but rendered as trailing input_image/input_file blocks on a plain input
            // message rather than lost, since the output-message shape has no attachment slot.
            const blocks = await input.renderOpenAIResponsesMediaBlocks({
              media,
              unsupportedMediaPolicy: input.unsupportedMediaPolicy,
              renderUntrustedContent: input.renderUntrustedContent,
              renderTrustedContent: input.renderTrustedContent,
              warn: input.warn,
            })
            if (blocks.length > 0) items.push({ role: 'user', content: blocks })
          }
        } else {
          const rendered = await input.renderOpenAIResponsesTimelineMessage({
            message: m,
            selfIdentity: input.selfIdentity,
            unsupportedMediaPolicy: input.unsupportedMediaPolicy,
            renderOpenAIResponsesMediaBlocks: input.renderOpenAIResponsesMediaBlocks,
            renderUntrustedContent: input.renderUntrustedContent,
            renderTrustedContent: input.renderTrustedContent,
            warn: input.warn,
          })
          if (rendered) items.push(rendered)
        }
      } else if (entry.kind === 'toolCall') {
        const tc = entry.value
        const { callId, itemId } = splitCompositeToolCallId(tc.id)
        const functionCallItem: OpenAIResponsesFunctionCallItem = {
          type: 'function_call',
          call_id: callId,
          name: tc.tool,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
          ...(itemId !== undefined ? { id: itemId } : {}),
        }
        items.push(functionCallItem)

        let rendered = input.renderedToolCallResults.get(tc.id)
        if (rendered === undefined) {
          const tool = input.tools.get(tc.tool)
          rendered = await input.renderOpenAIResponsesToolCallResult({
            toolCall: tc,
            results: tc.results as
              | Tokenizable
              | SpooledArtifact
              | SpooledArtifact[]
              | Media
              | Media[],
            tool,
            renderUntrustedContent: input.renderUntrustedContent,
            renderTrustedContent: input.renderTrustedContent,
            renderOpenAIResponsesMediaBlocks: input.renderOpenAIResponsesMediaBlocks,
            unsupportedMediaPolicy: input.unsupportedMediaPolicy,
            warn: input.warn,
          })
        }
        const outputItem: OpenAIResponsesFunctionCallOutputItem = {
          type: 'function_call_output',
          call_id: callId,
          output: rendered,
        }
        items.push(outputItem)
      } else {
        // thought
        const thought = entry.value
        const identifier = String(thought.identity?.identifier ?? '')
        const isSelf = identifier === input.selfIdentity

        let reasoningItem: OpenAIResponsesReasoningItem | undefined
        if (input.reasoningReplay !== 'off') {
          const payload = thought.payload as
            | Partial<OpenAIResponsesReasoningReplayPayload>
            | undefined
          const prefixFingerprint =
            typeof payload?.prefixFingerprint === 'string' ? payload.prefixFingerprint : ''
          reasoningItem = input.renderOpenAIResponsesReasoningItem({
            thought,
            prefixFingerprint,
            replayCompatibility: input.replayCompatibility,
            reasoningReplay: input.reasoningReplay,
            // Suppress the stale-signature warning here — the real validity check (against the
            // ACTUAL prefix through this item's position) happens in the second pass below, which
            // is where a definitive drop-and-warn decision belongs.
            warn: undefined,
          })
        }
        if (reasoningItem) {
          items.push(reasoningItem)
          reasoningCandidates.push({ item: reasoningItem, thought })
        } else if (thought.payload === undefined) {
          const text = input.renderThought(thought.content.toString(), {
            nonce: thought.id,
            kind: isSelf ? 'self-reasoning' : 'peer-reasoning',
            from: identifier,
            createdAt: thought.createdAt?.toISO?.() ?? undefined,
          })
          items.push({ role: 'assistant', content: [{ type: 'input_text', text }] })
        }
        // else: opaque, non-replayable, non-matching → elided (mirrors the Anthropic battery).
      }
    }
  }

  // ── Step 3: reasoning-pairing enforcement pass ──────────────────────────────
  // Walk left to right; a `reasoning` item is only ever valid on the wire when it is IMMEDIATELY
  // followed by its own paired output item (Known Gotcha #1 — openai/openai-node#1791). Re-derive
  // the fingerprint through THIS item's actual position in the fully-assembled `items` array (not
  // the position it was tentatively rendered at above, which may have shifted if an earlier
  // reasoning item was dropped) and re-validate against the payload's own recorded pairing.
  if (reasoningCandidates.length > 0) {
    const dropIndices = new Set<number>()
    // Id-strips are RECORDED here and applied after the loop. Applying them inline replaced
    // `items[idx + 1]` with a new object, which broke `items.indexOf(candidate.item)` identity for
    // any candidate that happened to BE that neighbour: its lookup returned -1, the `continue`
    // skipped it, and it was never validated — so a stale reasoning item could reach the wire
    // unchecked, the exact 400 this sweep exists to prevent.
    const idStripIndices = new Set<number>()
    for (const candidate of reasoningCandidates) {
      const idx = items.indexOf(candidate.item)
      if (idx < 0) continue
      const payload = candidate.thought.payload as
        | Partial<OpenAIResponsesReasoningReplayPayload>
        | undefined
      const prefixFingerprint = await input.fingerprintOpenAIResponsesPrefix({
        model: input.model,
        instructions,
        // Hash the tools EXACTLY as this function returns them on the wire (`undefined` when the
        // registry is empty, per the return shape below) — not the local `tools` array, which is
        // always a real array. `canonicalFingerprint` emits `undefined` and `[]` as different
        // bytes, so hashing the local array here while `persistThought` hashes the returned
        // `assembled.tools` made every reasoning item drop as stale whenever no tools were
        // registered, even with a byte-identical prefix.
        tools: tools.length > 0 ? tools : undefined,
        input: items,
        throughItem: idx,
      })
      const nextItem = items[idx + 1]
      const nextItemId = nextItem !== undefined && 'id' in nextItem ? nextItem.id : undefined
      const pairingOk =
        typeof payload?.prefixFingerprint === 'string' &&
        payload.prefixFingerprint === prefixFingerprint &&
        nextItem !== undefined &&
        (payload.pairedItemId === undefined || nextItemId === payload.pairedItemId)
      if (!pairingOk) {
        input.warn?.(
          `Dropping OpenAI Responses reasoning item for thought ${candidate.thought.id}: ${
            nextItem === undefined
              ? 'no paired output item follows it'
              : payload?.pairedItemId !== undefined && nextItemId !== payload.pairedItemId
                ? 'the following item is not its recorded pairing partner'
                : 'stale or missing prefix fingerprint'
          }.`
        )
        dropIndices.add(idx)
        // Record (do NOT yet apply) the id-strip on the paired output item — an id-less item is
        // not subject to the pairing check, so the request stays valid once its reasoning partner
        // is gone. Deferred so this loop never mutates the array it is indexing into.
        if (nextItem !== undefined && 'id' in nextItem && nextItem.id !== undefined) {
          idStripIndices.add(idx + 1)
        }
      }
    }
    // Apply the recorded id-strips now that every candidate has been validated against a stable
    // `items` array.
    for (const stripIdx of idStripIndices) {
      const target = items[stripIdx]
      if (target === undefined) continue
      const stripped: Record<string, unknown> = { ...target }
      delete stripped.id
      items[stripIdx] = stripped as unknown as OpenAIResponsesInputItem
    }
    if (dropIndices.size > 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (dropIndices.has(i)) items.splice(i, 1)
      }
    }
  }

  // Everything appended from here on is INVISIBLE to the adjacency sweep above, so it must not
  // enter a reasoning-replay fingerprint — see `fingerprintableLength` on the return value.
  const fingerprintableLength = items.length

  // ── Step 4: trailing buckets ─────────────────────────────────────────────────
  if (includesTimeline) {
    const trailingParts: string[] = []
    for (let i = timelineIdx + 1; i < buckets.length; i++) {
      const label = buckets[i]!
      if (label === 'standingInstructions') {
        const block = input.renderStandingInstructions(input.standingInstructions)
        if (block.length > 0) trailingParts.push(block)
      } else if (label === 'memories') {
        const wrapped: Array<{ memory: Memory; attrs: ReturnType<typeof memoryToAttrs>['attrs'] }> =
          []
        for (const m of input.memories) wrapped.push(memoryToAttrs(m))
        const block = input.renderMemories(wrapped)
        if (block.length > 0) trailingParts.push(block)
      } else if (label === 'retrievables') {
        const wrapped: Array<{
          retrievable: Retrievable
          attrs: ReturnType<typeof retrievableToAttrs>['attrs']
        }> = []
        for (const r of input.retrievables) wrapped.push(retrievableToAttrs(r))
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
      items.push({
        role: 'system',
        content: [{ type: 'input_text', text: trailingParts.join('\n\n') }],
      })
    }
  }

  return {
    ...(instructions !== undefined ? { instructions } : {}),
    input: items,
    ...(tools.length > 0 ? { tools } : {}),
    fingerprintableLength,
  }
}
/** Default history assembler; alias of {@link buildOpenAIResponsesInput}. */
export const defaultBuildOpenAIResponsesInput = buildOpenAIResponsesInput

// ─── Output-slot state machine ─────────────────────────────────────────────────

/**
 * Implements {@link OpenAIResponsesHelpers.createResponsesOutputSlotMachine}.
 *
 * @remarks
 * Streaming state keyed by `output_index` (one slot per output item — NOT a tool-call `index`,
 * unlike Chat Completions). `openSlot` deliberately opens NO slot for an unrecognized/hosted
 * server-side tool item type (`web_search_call`, `code_interpreter_call`, `mcp_call`, etc.) — Known
 * Gotcha #6 — so every subsequent event keyed to that `output_index` is silently ignored rather
 * than crashing on an unexpected slot kind.
 */
export const createResponsesOutputSlotMachine = (): ResponsesOutputSlotMachine => {
  const slots = new Map<number, ResponsesOutputSlot>()

  return {
    openSlot(outputIndex, rawItem) {
      let slot: ResponsesOutputSlot | undefined
      if (rawItem.type === 'message') {
        const item = rawItem as OpenAIResponsesOutputMessageItem
        slot = { kind: 'text', itemId: item.id ?? `idx-${outputIndex}`, text: '', refusal: '' }
      } else if (rawItem.type === 'reasoning') {
        const item = rawItem as OpenAIResponsesReasoningItem
        slot = {
          kind: 'thinking',
          itemId: item.id,
          summaryText: '',
          reasoningText: '',
          ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
        }
      } else if (rawItem.type === 'function_call') {
        const item = rawItem as OpenAIResponsesFunctionCallItem
        slot = {
          kind: 'toolCall',
          itemId: item.id ?? `idx-${outputIndex}`,
          callId: item.call_id,
          name: item.name,
          args: item.arguments ?? '',
        }
      } else {
        // Hosted/unrecognized item type — no slot; caller's responsibility to debug-log.
        return undefined
      }
      slots.set(outputIndex, slot)
      return slot
    },
    getSlot(outputIndex) {
      return slots.get(outputIndex)
    },
    appendText(outputIndex, delta) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'text') slot.text += delta
    },
    appendRefusal(outputIndex, delta) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'text') slot.refusal += delta
    },
    appendReasoningSummary(outputIndex, delta) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'thinking') slot.summaryText += delta
    },
    appendReasoningText(outputIndex, delta) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'thinking') slot.reasoningText += delta
    },
    appendFunctionCallArgumentsDelta(outputIndex, delta) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'toolCall') slot.args += delta
    },
    setFunctionCallArgumentsDone(outputIndex, args) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'toolCall') slot.args = args
    },
    finalizeSlot(outputIndex, rawItem) {
      const slot = slots.get(outputIndex)
      if (!slot) return
      if (slot.kind === 'text' && rawItem.type === 'message') {
        const item = rawItem as OpenAIResponsesOutputMessageItem
        const textParts: string[] = []
        for (const part of item.content) {
          if (part.type === 'output_text') textParts.push(part.text)
          else if (part.type === 'refusal') slot.refusal = part.refusal
        }
        if (textParts.length > 0) slot.text = textParts.join('')
        if (item.id !== undefined) slot.itemId = item.id
      } else if (slot.kind === 'thinking' && rawItem.type === 'reasoning') {
        // The ONLY point at which a reasoning item's encrypted_content/signature is captured —
        // NEVER at `.added`, before it's populated (Known Gotcha #3).
        const item = rawItem as OpenAIResponsesReasoningItem
        const summaryText = (item.summary ?? []).map((s) => s.text).join('\n\n')
        const reasoningText = (item.content ?? []).map((c) => c.text).join('\n\n')
        if (summaryText.length > 0) slot.summaryText = summaryText
        if (reasoningText.length > 0) slot.reasoningText = reasoningText
        if (item.encrypted_content) slot.encryptedContent = item.encrypted_content
        slot.itemId = item.id
      } else if (slot.kind === 'toolCall' && rawItem.type === 'function_call') {
        const item = rawItem as OpenAIResponsesFunctionCallItem
        if (item.arguments) slot.args = item.arguments
        if (item.id !== undefined) slot.itemId = item.id
        slot.callId = item.call_id
        slot.name = item.name
      }
    },
    backfillEncryptedContent(outputIndex, encryptedContent) {
      const slot = slots.get(outputIndex)
      if (slot && slot.kind === 'thinking' && !slot.encryptedContent) {
        slot.encryptedContent = encryptedContent
      }
    },
    slots() {
      return slots
    },
  }
}
/** Default output-slot state machine factory; alias of {@link createResponsesOutputSlotMachine}. */
export const defaultCreateResponsesOutputSlotMachine = createResponsesOutputSlotMachine

// ─── Item-id charset/length normalisation (Known Gotcha #5) ───────────────────

/**
 * Normalises an ADK-authored id to the Responses item-id charset, and hashes+truncates ids over
 * the 64-character limit (Known Gotcha #5) rather than sending an oversized id verbatim.
 *
 * @remarks
 * Not part of the public {@link OpenAIResponsesHelpers} contract (no override seam is warranted for
 * a pure charset/length transform) — exported for the adapter and for direct unit testing.
 */
export const normalizeOpenAIResponsesItemId = (id: string, prefix = 'msg'): string => {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_')
  if (cleaned.length <= 64) return cleaned
  // Cheap, deterministic short hash — collisions are astronomically unlikely for this purpose
  // (a debug-visible correlation id, not a security boundary) and no crypto dependency is needed
  // synchronously here (unlike canonicalFingerprint, which is async).
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  const shortHash = (hash >>> 0).toString(16).padStart(8, '0')
  return `${prefix}_${shortHash}`
}

// Referenced for forward-compat with a future retrievable-handle-body override seam on this
// battery; kept imported (and referenced) so the shared default stays available to consumers
// composing partial `helpers` overrides without an unused-import lint failure.
void defaultRenderRetrievableHandleBody
