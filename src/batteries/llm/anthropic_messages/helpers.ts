/**
 * Anthropic Messages translation helpers.
 *
 * @module @nhtio/adk/batteries/llm/anthropic_messages/helpers
 */

import { Media } from '@nhtio/adk/common'
import { isObject } from '@nhtio/adk/guards'

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
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
  looksLikeSpooledArtifact,
} from '../chat_common/helpers'

import { E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  descriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  renderTrustedContent,
  defaultRenderArtifactHandleBody,
  looksLikeSpooledArtifact,
} from '../chat_common/helpers'
import {
  escapeXmlAttribute,
  floorTrustTier,
  memoryToAttrs,
  neutraliseDeveloperRulesTag,
  retrievableToAttrs,
  sanitizeFilenameForDescription,
  sanitizeMimeType,
} from '../chat_common/helpers'
import type { ChatHelpersCommon } from '../chat_common/types'
import type {
  JsonSchema,
  ChatCompletionsBucketOrder,
  UnsupportedMediaPolicy,
} from '../chat_common/types'
import type {
  ArtifactTool,
  Memory,
  Message,
  Retrievable,
  SpooledArtifact,
  Thought,
  Tokenizable,
  Tool,
  ToolCall,
} from '@nhtio/adk/common'
import type {
  AnthropicCacheBreakpoints,
  AnthropicContentBlockParam,
  AnthropicDocumentBlockParam,
  AnthropicImageBlockParam,
  AnthropicMessagesHelpers,
  AnthropicTextBlockParam,
  AnthropicThinkingReplayPayload,
  AnthropicTool,
  AnthropicToolResultBlockParam,
  AnthropicMessageParam,
} from './types'

/** Converts ADK tools to Anthropic's flat custom-tool definition. */
export const anthropicToolsFromTools = (
  tools: ReadonlyArray<Tool | ArtifactTool>,
  deps: { descriptionToChatCompletionsJsonSchema: (d: unknown) => JsonSchema }
): AnthropicTool[] =>
  tools.map((tool) => {
    const described = tool.describe()
    const schema = deps.descriptionToChatCompletionsJsonSchema(
      described.inputSchema
    ) as AnthropicTool['input_schema']
    return {
      name: described.name,
      ...(described.description ? { description: described.description } : {}),
      input_schema: Object.keys(schema).length > 0 ? schema : { type: 'object', properties: {} },
    }
  })
/** Default Anthropic tool translator. */
export const defaultAnthropicToolsFromTools = anthropicToolsFromTools

const stashKeys = ['text:transcript', 'text:caption', 'text:description'] as const
const modalityAttr = (value: string): 'inert' | 'extractable' | 'opaque' =>
  value === 'inert' ? 'inert' : value === 'extractable-instructions' ? 'extractable' : 'opaque'
const stashEntry = (value: unknown): { value: string; trustTier: string } | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as { value?: unknown; trustTier?: unknown }
  return typeof v.value === 'string' && typeof v.trustTier === 'string'
    ? { value: v.value, trustTier: v.trustTier }
    : undefined
}
const marker = (media: Media): string =>
  `[media id: ${media.id} | ${sanitizeFilenameForDescription(media.filename)}]`
const synthetic = async (media: Media): Promise<string> =>
  `[media: ${sanitizeFilenameForDescription(media.filename)}, ${sanitizeMimeType(media.mimeType)}, ${await media.byteLength()} B]`

const fallbackMedia = async (input: {
  media: Media
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  nonce: string
  tool?: string
  warn?: (msg: string) => void
}): Promise<AnthropicContentBlockParam[]> => {
  const { media, unsupportedMediaPolicy: policy } = input
  if (policy === 'throw') {
    throw new E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY([
      media.kind,
      media.mimeType,
      media.filename,
    ])
  }
  const keys =
    typeof policy === 'object' ? policy.stashKeys : policy === 'fallback-stash' ? stashKeys : []
  let text: string | undefined
  for (const key of keys) {
    const entry = stashEntry(media.stash.get(key))
    if (entry) {
      const tier = floorTrustTier(media.trustTier, entry.trustTier)
      text =
        tier === 'first-party'
          ? input.renderTrustedContent(entry.value, {
              nonce: input.nonce,
              kind: 'media-fallback',
              tool: input.tool,
              modality: modalityAttr(media.modalityHazard),
            })
          : input.renderUntrustedContent(entry.value, {
              nonce: input.nonce,
              kind: 'media-fallback',
              tool: input.tool,
              modality: modalityAttr(media.modalityHazard),
            })
      break
    }
  }
  if (text === undefined) {
    if (policy === 'fallback-stash' || typeof policy === 'object')
      input.warn?.(
        `No media fallback stash entry for ${media.filename}; using synthetic description.`
      )
    const body = await synthetic(media)
    text = input.renderUntrustedContent(body, {
      nonce: input.nonce,
      kind: 'media-fallback',
      tool: input.tool,
      modality: modalityAttr(media.modalityHazard),
    })
  }
  return [{ type: 'text', text: `${marker(media)}\n${text}` }]
}

/** Renders image, document, and policy-routed unsupported media blocks. */
export const renderAnthropicMediaBlocks = async (input: {
  media: Media
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  warn?: (msg: string) => void
}): Promise<AnthropicContentBlockParam[]> => {
  const { media } = input
  if (media.kind === 'image') {
    const mime = sanitizeMimeType(media.mimeType, 'image')
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) {
      return fallbackMedia({ ...input, nonce: media.id })
    }
    const imageMime = mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    const block: AnthropicImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageMime,
        data: await media.asBase64(),
      },
    }
    return [{ type: 'text', text: marker(media) }, block]
  }
  if (
    media.kind === 'document' &&
    (media.mimeType === 'application/pdf' || media.mimeType === 'text/plain')
  ) {
    const source =
      media.mimeType === 'application/pdf'
        ? {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data: await media.asBase64(),
          }
        : {
            type: 'text' as const,
            media_type: 'text/plain' as const,
            data: new TextDecoder().decode(await media.asBytes()),
          }
    const block: AnthropicDocumentBlockParam = { type: 'document', source }
    return [{ type: 'text', text: marker(media) }, block]
  }
  return fallbackMedia({ ...input, nonce: media.id })
}
/** Default Anthropic media renderer. */
export const defaultRenderAnthropicMediaBlocks = renderAnthropicMediaBlocks

/** Renders a tool result as Anthropic tool-result content, preserving media blocks. */
export const renderAnthropicToolCallResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
  renderAnthropicMediaBlocks: AnthropicMessagesHelpers['renderAnthropicMediaBlocks']
  renderArtifactHandleBody?: AnthropicMessagesHelpers['renderArtifactHandleBody']
  renderRetrievableHandleBody?: AnthropicMessagesHelpers['renderRetrievableHandleBody']
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<AnthropicToolResultBlockParam> => {
  const trusted = input.tool !== undefined && (input.tool as { trusted?: boolean }).trusted === true
  const mediaList = Media.isMedia(input.results)
    ? [input.results]
    : Array.isArray(input.results) && input.results.every((x) => Media.isMedia(x))
      ? input.results
      : undefined
  let body:
    | string
    | Array<AnthropicTextBlockParam | AnthropicImageBlockParam | AnthropicDocumentBlockParam>
  if (mediaList) {
    body = []
    for (const media of mediaList) {
      const rendered = await input.renderAnthropicMediaBlocks({
        media,
        unsupportedMediaPolicy: input.unsupportedMediaPolicy,
        renderUntrustedContent: input.renderUntrustedContent,
        renderTrustedContent: input.renderTrustedContent,
        warn: input.warn,
      })
      body.push(
        ...rendered.filter(
          (
            block
          ): block is
            | AnthropicImageBlockParam
            | AnthropicDocumentBlockParam
            | AnthropicTextBlockParam =>
            block.type === 'text' || block.type === 'image' || block.type === 'document'
        )
      )
    }
  } else if (Array.isArray(input.results)) {
    const resultParts = await Promise.all(
      input.results.map((x) =>
        'asString' in (x as object) ? (x as SpooledArtifact).asString() : x.toString()
      )
    )
    body = resultParts.join('\n\n')
  } else if (looksLikeSpooledArtifact(input.results) && input.toolCall.inline === false) {
    const artifact = input.results as SpooledArtifact
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
    const handleBody = (input.renderArtifactHandleBody ?? defaultRenderArtifactHandleBody)({
      callId: input.toolCall.id,
      artifact,
      byteLength,
      lineCount,
    })
    return {
      type: 'tool_result',
      tool_use_id: input.toolCall.id,
      content: input.renderUntrustedContent(handleBody, {
        nonce: input.toolCall.checksum,
        kind: 'artifact-handle',
        tool: input.toolCall.tool,
      }),
      ...(input.toolCall.isError ? { is_error: true } : {}),
    }
  } else if ('asString' in (input.results as object)) {
    body = await (input.results as SpooledArtifact).asString()
  } else body = input.results.toString()
  if (typeof body === 'string')
    body = trusted
      ? input.renderTrustedContent(body, {
          nonce: input.toolCall.checksum,
          kind: 'trusted-tool-result',
          tool: input.toolCall.tool,
        })
      : input.renderUntrustedContent(body, {
          nonce: input.toolCall.checksum,
          kind: 'tool-result',
          tool: input.toolCall.tool,
        })
  return {
    type: 'tool_result',
    tool_use_id: input.toolCall.id,
    content: body,
    ...(input.toolCall.isError ? { is_error: true } : {}),
  }
}
/** Default Anthropic tool-result renderer. */
export const defaultRenderAnthropicToolCallResult = renderAnthropicToolCallResult

/** Renders system buckets as separate text blocks and places up to three cache breakpoints. */
export const renderAnthropicSegmentedSystemPrompt = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  bucketOrder: ChatCompletionsBucketOrder
  cacheBreakpoints: AnthropicCacheBreakpoints
  cacheTtl?: '5m' | '1h'
  renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
  renderMemories: ChatHelpersCommon['renderMemories']
  renderRetrievables: ChatHelpersCommon['renderRetrievables']
  renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
  renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
  renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
  renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
  renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
  renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  renderCtx?: unknown
  warn?: (msg: string) => void
}): Promise<AnthropicTextBlockParam[]> => {
  const parts: string[] = []
  const base = input.systemPrompt.render(input.renderCtx as never)
  if (base) parts.push(base)
  for (const label of input.bucketOrder) {
    if (label === 'timeline') break
    if (label === 'standingInstructions') {
      const s = input.renderStandingInstructions(input.standingInstructions)
      if (s) parts.push(s)
    } else if (label === 'memories') {
      const s = input.renderMemories(Array.from(input.memories, memoryToAttrs))
      if (s) parts.push(s)
    } else if (label === 'retrievables') {
      const s = await input.renderRetrievables(Array.from(input.retrievables, retrievableToAttrs), {
        renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
        renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
        renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
        renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
        renderRetrievableHandleBody: input.renderRetrievableHandleBody,
        renderUntrustedContent: input.renderUntrustedContent,
      })
      if (s) parts.push(s)
    }
  }
  const blocks: AnthropicTextBlockParam[] = parts.map((text) => ({
    type: 'text' as const,
    text,
  }))
  if (
    input.cacheBreakpoints !== 'off' &&
    blocks.length &&
    (input.cacheBreakpoints === 'system-only' ||
      input.bucketOrder.indexOf('timeline') === input.bucketOrder.length - 1)
  ) {
    const cache = {
      type: 'ephemeral' as const,
      ...(input.cacheTtl ? { ttl: input.cacheTtl } : {}),
    }
    blocks[blocks.length - 1] = {
      ...blocks[blocks.length - 1]!,
      cache_control: cache,
    }
  } else if (
    input.cacheBreakpoints === 'auto' &&
    input.bucketOrder.indexOf('timeline') !== input.bucketOrder.length - 1
  )
    input.warn?.(
      'Anthropic cache tail breakpoints disabled because timeline is not the last bucket.'
    )
  return blocks
}
/** Default segmented system renderer. */
export const defaultRenderAnthropicSegmentedSystemPrompt = renderAnthropicSegmentedSystemPrompt

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value))
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonical(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')
}

/**
 * Computes the SHA-256 fingerprint used for Anthropic thinking replay.
 *
 * The input is the exact assembled request prefix: model, resolved system, tools, and messages
 * through the content block immediately before the thinking block. Object keys are recursively sorted;
 * array order and block boundaries are preserved.
 */
export const fingerprintAnthropicMessagesPrefix = async (input: {
  model: string
  system?: string | AnthropicTextBlockParam[]
  tools?: AnthropicTool[]
  messages: AnthropicMessageParam[]
  throughBlock?: { messageIndex: number; contentIndex: number }
}): Promise<string> => {
  const messages =
    input.throughBlock === undefined
      ? input.messages
      : input.messages.slice(0, input.throughBlock.messageIndex + 1).map((message, index) => ({
          ...message,
          content:
            Array.isArray(message.content) && index === input.throughBlock!.messageIndex
              ? message.content.slice(0, input.throughBlock!.contentIndex)
              : message.content,
        }))
  return fingerprint({
    model: input.model,
    system: input.system,
    tools: input.tools,
    messages,
  })
}

/** Converts an eligible stored Anthropic thinking payload into byte-exact wire blocks. */
export const renderAnthropicThinkingBlocks = (input: {
  thought: Thought
  model: string
  prefixFingerprint: string
  replayCompatibility: ReadonlyArray<string>
  warn?: (msg: string) => void
}): AnthropicContentBlockParam[] => {
  if (!input.replayCompatibility.includes(input.thought.replayCompatibility ?? '')) return []
  const payload = input.thought.payload as Partial<AnthropicThinkingReplayPayload> | undefined
  if (!payload || payload.prefixFingerprint !== input.prefixFingerprint) {
    input.warn?.(`Dropping stale Anthropic thinking signature for thought ${input.thought.id}.`)
    return []
  }
  if (
    payload.variant === 'thinking' &&
    typeof payload.thinking === 'string' &&
    typeof payload.signature === 'string'
  )
    return [
      {
        type: 'thinking',
        thinking: payload.thinking,
        signature: payload.signature,
      },
    ]
  if (payload.variant === 'redacted_thinking' && typeof payload.data === 'string')
    return [{ type: 'redacted_thinking', data: payload.data }]
  return []
}
/** Default thinking replay renderer. */
export const defaultRenderAnthropicThinkingBlocks = renderAnthropicThinkingBlocks

/** Renders one ADK timeline message using an identity-bearing content envelope. */
export const renderAnthropicTimelineMessage = async (input: {
  message: Message
  selfIdentity: string
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderAnthropicMediaBlocks: AnthropicMessagesHelpers['renderAnthropicMediaBlocks']
  warn?: (msg: string) => void
}): Promise<AnthropicMessageParam | null> => {
  const m = input.message
  const identifier =
    m.identity?.identifier === null || m.identity?.identifier === undefined
      ? ''
      : String(m.identity.identifier)
  const representation = m.identity?.representation?.toString() || identifier
  const text = neutraliseDeveloperRulesTag(m.content?.toString() ?? '')
  const own = m.role === 'assistant' && identifier === input.selfIdentity
  let rendered = text
  if (identifier && !(m.role === 'assistant' && own)) {
    const tag = m.role === 'user' ? 'message' : 'peer_agent_output'
    const from = escapeXmlAttribute(representation)
    rendered = `<${tag}_${m.id} from="${from}"${m.role === 'user' ? ' role="user"' : ''}>\\n${text}\\n</${tag}_${m.id}>`
  }
  const blocks: AnthropicContentBlockParam[] = []
  if (rendered.length) blocks.push({ type: 'text', text: rendered })
  for (const media of m.attachments)
    blocks.push(
      ...(await input.renderAnthropicMediaBlocks({
        media,
        unsupportedMediaPolicy: input.unsupportedMediaPolicy,
        renderUntrustedContent,
        renderTrustedContent,
        warn: input.warn,
      }))
    )
  if (!blocks.length) return null
  return { role: m.role, content: blocks }
}
/** Default timeline renderer. */
export const defaultRenderAnthropicTimelineMessage = renderAnthropicTimelineMessage

/** Assembles Anthropic system content, messages, tools, and safely replayable thinking. */
export const buildAnthropicMessagesHistory = async (
  input: Parameters<AnthropicMessagesHelpers['buildAnthropicMessagesHistory']>[0]
): Promise<Awaited<ReturnType<AnthropicMessagesHelpers['buildAnthropicMessagesHistory']>>> => {
  const deps = input as typeof input & {
    anthropicToolsFromTools?: typeof anthropicToolsFromTools
    descriptionToChatCompletionsJsonSchema?: (d: unknown) => JsonSchema
    renderAnthropicThinkingBlocks?: typeof renderAnthropicThinkingBlocks
    renderAnthropicMediaBlocks?: AnthropicMessagesHelpers['renderAnthropicMediaBlocks']
  }
  const tools = (deps.anthropicToolsFromTools ?? anthropicToolsFromTools)(input.tools.visible(), {
    descriptionToChatCompletionsJsonSchema: (d: unknown) =>
      descriptionToChatCompletionsJsonSchema(d as never),
  })
  const segmented = await input.renderAnthropicSegmentedSystemPrompt({
    systemPrompt: input.systemPrompt,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: input.bucketOrder,
    cacheBreakpoints: input.cacheBreakpoints,
    cacheTtl: input.cacheTtl,
    renderStandingInstructions: input.renderStandingInstructions,
    renderMemories: input.renderMemories,
    renderRetrievables: input.renderRetrievables,
    renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
    renderRetrievableHandleBody: input.renderRetrievableHandleBody,
    renderUntrustedContent: input.renderUntrustedContent,
    warn: input.warn,
  })
  const system =
    input.cacheBreakpoints === 'off'
      ? await input.renderChatCompletionsSystemPrompt({
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
          renderRetrievableHandleBody: input.renderRetrievableHandleBody,
          renderUntrustedContent: input.renderUntrustedContent,
        })
      : segmented
  const items: Array<
    | { kind: 'message'; at: number; value: Message }
    | { kind: 'thought'; at: number; value: Thought }
    | { kind: 'tool'; at: number; value: ToolCall }
  > = [...input.messages].map((value) => ({
    kind: 'message',
    at: value.createdAt.toMillis(),
    value,
  }))
  const filteredThoughts = input.filterThoughts(
    input.thoughts,
    input.thoughtSurfacing,
    input.selfIdentity,
    input.replayCompatibility
  )
  for (const value of filteredThoughts)
    items.push({ kind: 'thought', at: value.createdAt.toMillis(), value })
  for (const value of input.toolCalls)
    items.push({ kind: 'tool', at: value.createdAt.toMillis(), value })
  items.sort((a, b) => a.at - b.at)
  const messages: AnthropicMessageParam[] = []
  const replayCandidates: Array<{
    block: AnthropicContentBlockParam
    thought: Thought
  }> = []
  const append = (message: AnthropicMessageParam): void => {
    if (typeof message.content === 'string' && message.content.length === 0) return
    const previous = messages[messages.length - 1]
    if (previous && previous.role === message.role) {
      const left =
        typeof previous.content === 'string'
          ? [{ type: 'text' as const, text: previous.content }]
          : previous.content
      const right =
        typeof message.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : message.content
      if (left.length || right.length) {
        input.warn?.(`Merged consecutive Anthropic ${message.role} turns during history assembly.`)
        messages[messages.length - 1] = {
          role: message.role,
          content: [...left, ...right],
        }
      }
      return
    }
    if (Array.isArray(message.content) && message.content.length === 0) return
    messages.push(message)
  }
  for (const item of items) {
    if (item.kind === 'message') {
      const rendered = await input.renderAnthropicTimelineMessage({
        message: item.value,
        selfIdentity: input.selfIdentity,
        unsupportedMediaPolicy: input.unsupportedMediaPolicy,
        renderAnthropicMediaBlocks:
          deps.renderAnthropicMediaBlocks ?? defaultRenderAnthropicMediaBlocks,
        warn: input.warn,
      })
      if (rendered) {
        append(rendered)
      }
    } else if (item.kind === 'tool') {
      const tc = item.value
      if (!/^[a-zA-Z0-9_-]+$/.test(tc.id))
        input.warn?.(
          `Anthropic tool id "${tc.id}" violates required charset ^[a-zA-Z0-9_-]+$; sending it unchanged.`
        )
      const use = {
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.tool,
        input: tc.args,
      }
      append({ role: 'assistant', content: [use] })
      let result = input.renderedToolCallResults.get(tc.id)
      if (!result) {
        const tool = input.tools.get(tc.tool)
        result = await input.renderAnthropicToolCallResult({
          toolCall: tc,
          results: tc.results as never,
          tool,
          renderUntrustedContent: input.renderUntrustedContent,
          renderTrustedContent: input.renderTrustedContent,
          renderAnthropicMediaBlocks:
            deps.renderAnthropicMediaBlocks ?? defaultRenderAnthropicMediaBlocks,
          unsupportedMediaPolicy: input.unsupportedMediaPolicy,
          warn: input.warn,
        })
      }
      append({ role: 'user', content: [result] })
    } else {
      const thought = item.value
      const payload = thought.payload as Partial<AnthropicThinkingReplayPayload> | undefined
      // Replay validation is deferred until after role merging.  Give the renderer the
      // stored value so it can select the compatible, well-formed wire block; the
      // canonical prefix is checked in the second pass below.  Suppress its stale
      // warning because that decision belongs to the second pass.
      const blocks = (deps.renderAnthropicThinkingBlocks ?? renderAnthropicThinkingBlocks)({
        thought,
        model: input.model,
        prefixFingerprint:
          typeof payload?.prefixFingerprint === 'string' ? payload.prefixFingerprint : '',
        replayCompatibility: input.replayCompatibility,
        warn: undefined,
      })
      if (blocks.length) {
        append({ role: 'assistant', content: blocks })
        for (const block of blocks) replayCandidates.push({ block, thought })
      } else if (thought.payload === undefined)
        append({
          role: 'assistant',
          content: input.renderThought(thought.content.toString(), {
            nonce: thought.id,
            kind: 'self-reasoning',
            from: String(thought.identity?.identifier ?? ''),
          }),
        })
    }
  }
  if (messages[0]?.role === 'assistant') {
    input.warn?.(
      'Dropped leading Anthropic assistant history because Messages requires a leading user turn.'
    )
    messages.shift()
  }

  // Candidate positions are located in the post-merge array.  Fingerprints use a
  // zero-based message/content position, and throughBlock excludes that block itself
  // (and everything after it).  All decisions use this unchanged pass-1 array, so
  // dropping an earlier block cannot shift a later candidate's position.
  const droppedBlocks = new Set<AnthropicContentBlockParam>()
  for (const candidate of replayCandidates) {
    const messageIndex = messages.findIndex(
      (message) => Array.isArray(message.content) && message.content.includes(candidate.block)
    )
    if (messageIndex < 0) continue
    const contentIndex = (messages[messageIndex]!.content as AnthropicContentBlockParam[]).indexOf(
      candidate.block
    )
    const payload = candidate.thought.payload as Partial<AnthropicThinkingReplayPayload> | undefined
    const prefixFingerprint = await fingerprintAnthropicMessagesPrefix({
      model: input.model,
      system,
      tools,
      messages,
      throughBlock: { messageIndex, contentIndex },
    })
    if (payload?.prefixFingerprint !== prefixFingerprint) {
      input.warn?.(
        `Dropping stale Anthropic thinking signature for thought ${candidate.thought.id}.`
      )
      droppedBlocks.add(candidate.block)
    }
  }
  if (droppedBlocks.size) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (!Array.isArray(message.content)) continue
      const content = message.content.filter((block) => !droppedBlocks.has(block))
      if (content.length === 0) messages.splice(index, 1)
      else if (content.length !== message.content.length) messages[index] = { ...message, content }
    }
  }

  // Cache message-side breakpoints only after role merging has produced the final wire messages.
  // Anthropic accepts cache_control on text, image, document, and tool-result blocks, but not on
  // every member of ContentBlockParam (notably thinking and tool-use blocks).
  const cache = {
    type: 'ephemeral' as const,
    ...(input.cacheTtl ? { ttl: input.cacheTtl } : {}),
  }
  const canCacheBlock = (
    block: AnthropicContentBlockParam
  ): block is
    | AnthropicTextBlockParam
    | AnthropicImageBlockParam
    | AnthropicDocumentBlockParam
    | AnthropicToolResultBlockParam =>
    block.type === 'text' ||
    block.type === 'image' ||
    block.type === 'document' ||
    block.type === 'tool_result'
  let emittedBreakpoints = Array.isArray(system)
    ? system.filter((block) => block.cache_control !== undefined).length
    : 0
  if (
    input.cacheBreakpoints === 'auto' &&
    input.bucketOrder.indexOf('timeline') === input.bucketOrder.length - 1
  ) {
    const toolResultMessageIndex = messages.findLastIndex(
      (message) =>
        message.role === 'user' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result')
    )
    const finalUserMessageIndex = messages.findLastIndex((message) => message.role === 'user')
    const candidates = [toolResultMessageIndex, finalUserMessageIndex]
    let placedBlock: { messageIndex: number; contentIndex: number } | undefined
    for (const messageIndex of candidates) {
      if (messageIndex < 0) continue
      const message = messages[messageIndex]!
      if (!Array.isArray(message.content) || message.content.length === 0) continue
      const contentIndex = message.content.length - 1
      if (placedBlock?.messageIndex === messageIndex && placedBlock.contentIndex === contentIndex)
        continue
      if (emittedBreakpoints >= 4) {
        input.warn?.(
          'Anthropic prompt-cache breakpoint cap of 4 exceeded; message breakpoint was not placed.'
        )
        continue
      }
      const block = message.content[contentIndex]!
      if (!canCacheBlock(block)) continue
      const content = [...message.content]
      content[contentIndex] = { ...block, cache_control: cache }
      messages[messageIndex] = { ...message, content }
      emittedBreakpoints++
      placedBlock = { messageIndex, contentIndex }
    }
  }
  return {
    ...(system.length ? { system } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
  }
}
/** Default history assembler. */
export const defaultBuildAnthropicMessagesHistory = buildAnthropicMessagesHistory
