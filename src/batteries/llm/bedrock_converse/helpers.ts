/**
 * Translation helpers for the native Bedrock Converse battery.
 *
 * @module @nhtio/adk/batteries/llm/bedrock_converse/helpers
 *
 * @remarks
 * Every function is injectable via {@link BedrockConverseAdapterOptions.helpers} and has a
 * `default*` alias. Wire-agnostic renderers are re-exported unchanged from `../chat_common/helpers`;
 * only genuinely Converse-shaped logic lives here.
 */

import { isObject } from '@nhtio/adk/guards'
import {
  descriptionToChatCompletionsJsonSchema,
  filterThoughts,
  looksLikeSpooledArtifact,
  neutraliseDeveloperRulesTag,
  normalizeToolName,
  renderChatCompletionsSystemPrompt,
  renderFirstPartyRetrievables,
  renderMemories,
  renderRetrievableSafetyDirective,
  renderRetrievables,
  renderStandingInstructions,
  renderThirdPartyPrivateRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThought,
  renderTrustedContent,
  renderUntrustedContent,
} from '../chat_common/helpers'
import type { SpooledArtifact } from '@nhtio/adk/common'
import type { DescriptionLike } from '../chat_common/types'
import type {
  Tool,
  ArtifactTool,
  Media,
  Message,
  Thought,
  ToolCall,
  Tokenizable,
} from '@nhtio/adk/common'
import type {
  ConverseContentBlock,
  ConverseImageBlock,
  ConverseMessage,
  ConverseRequest,
  ConverseRequestBuildInput,
  ConverseToolSpec,
  JsonSchema,
  UnsupportedMediaPolicy,
} from './types'

// ─── Re-exported wire-agnostic renderers ──────────────────────────────────────
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
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
} from '../chat_common/helpers'

/** Default context-bucket order for the system blocks; matches the other chat batteries. */
export const DEFAULT_CONVERSE_BUCKET_ORDER = [
  'standingInstructions',
  'memories',
  'retrievables',
  'timeline',
] as const

/**
 * JSON-Schema keywords Converse's schema dialect rejects.
 *
 * @remarks
 * Sending one produces a validation error that does not name the offending keyword, so they are
 * stripped rather than forwarded. Same class of problem as Gemini's OpenAPI subset.
 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'patternProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'const',
  'examples',
  'default',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'format',
])

/** Recursively strip schema keywords Converse rejects. */
export const sanitizeConverseSchema = (schema: unknown): JsonSchema => {
  if (Array.isArray(schema)) return schema.map((s) => sanitizeConverseSchema(s)) as never
  if (schema === null || typeof schema !== 'object') return schema as never
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    out[key] = isObject(value) ? sanitizeConverseSchema(value) : value
  }
  return out as never
}

/** Default implementation; alias of {@link sanitizeConverseSchema}. */
export const defaultSanitizeConverseSchema = sanitizeConverseSchema

/**
 * Converse rejects a `toolUseId` outside `[A-Za-z0-9_-]{1,64}`.
 *
 * @remarks
 * ADK ids are UUIDv6, which is already in-charset, but a caller-supplied id may not be — and the
 * rejection names neither the field nor the offending character.
 */
export const sanitizeToolUseId = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_')
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned || 'tool_use'
}

/** Default implementation; alias of {@link sanitizeToolUseId}. */
export const defaultSanitizeToolUseId = sanitizeToolUseId

/** ADK tools → native `toolConfig.tools`. */
export const toolsToConverseTools = (tools: Iterable<Tool | ArtifactTool>): ConverseToolSpec[] => {
  const out: ConverseToolSpec[] = []
  for (const tool of tools) {
    const described = tool.describe()
    const parameters = descriptionToChatCompletionsJsonSchema(
      described.inputSchema as unknown as DescriptionLike
    )
    const sanitized = sanitizeConverseSchema(parameters)
    out.push({
      toolSpec: {
        name: normalizeToolName(described.name),
        description: String(described.description ?? ''),
        // Converse requires an OBJECT schema even for a zero-arg tool; an empty schema is
        // rejected, so a bare `{type:'object'}` stands in.
        inputSchema: {
          json:
            sanitized && Object.keys(sanitized).length > 0
              ? sanitized
              : ({ type: 'object', properties: {} } as never),
        },
      },
    })
  }
  return out
}

/** Default implementation; alias of {@link toolsToConverseTools}. */
export const defaultToolsToConverseTools = toolsToConverseTools

/** Render one tool result into `toolResult.content[]`. */
export const renderConverseToolResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  renderUntrustedContent: typeof renderUntrustedContent
  renderTrustedContent: typeof renderTrustedContent
  unsupportedMediaPolicy: UnsupportedMediaPolicy | undefined
  warn?: (message: string) => void
}): Promise<Array<{ text?: string; json?: Record<string, unknown> }>> => {
  const { results, toolCall } = input
  if (looksLikeSpooledArtifact(results)) {
    // Referenced by handle, never inlined — same contract as the other batteries.
    return [{ text: `[artifact ${String((results as { id?: unknown }).id ?? toolCall.id)}]` }]
  }
  const text = String(results ?? '')
  return [
    {
      text: input.renderUntrustedContent(text, {
        nonce: toolCall.id,
        from: toolCall.tool,
      } as never),
    },
  ]
}

/** Default implementation; alias of {@link renderConverseToolResult}. */
export const defaultRenderConverseToolResult = renderConverseToolResult

/** Decode an ADK Media into a Converse image block. */
export const mediaToConverseImage = async (media: Media): Promise<ConverseImageBlock> => {
  const bytes = (await media.asBytes()) as Uint8Array
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const subtype = media.mimeType.split('/')[1]?.toLowerCase() ?? 'png'
  const format = (['png', 'jpeg', 'gif', 'webp'] as const).includes(subtype as never)
    ? (subtype as 'png' | 'jpeg' | 'gif' | 'webp')
    : 'png'
  return {
    format,
    source: {
      bytes: typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64'),
    },
  }
}

/** Default implementation; alias of {@link mediaToConverseImage}. */
export const defaultMediaToConverseImage = mediaToConverseImage

/**
 * Apply Converse's strict `user` ↔ `assistant` alternation to an already-ordered turn list.
 *
 * @remarks
 * Exported and separately testable because it is the single most consequential transformation in
 * this battery, and the one a gateway would otherwise perform invisibly.
 *
 * - `'merge'` concatenates consecutive same-role turns' content blocks. Lossless: the same blocks
 *   in the same order, in one turn — exactly what Converse would have accepted had the caller
 *   written it that way.
 * - `'filler'` inserts a placeholder opposite-role turn. LOSSIER — it fabricates model output that
 *   never existed — and offered only for callers who need positional stability across turns.
 * - `'reject'` returns the list untouched so Converse's own error surfaces. Use this when
 *   AUDITING: a repair applied before dispatch is invisible in the response, which makes a
 *   gateway's fix indistinguishable from a vendor's tolerance.
 */
export const enforceConverseAlternation = (
  messages: ConverseMessage[],
  policy: 'merge' | 'filler' | 'reject' = 'merge'
): ConverseMessage[] => {
  if (policy === 'reject' || messages.length < 2) return messages

  if (policy === 'filler') {
    const out: ConverseMessage[] = [messages[0]!]
    for (let i = 1; i < messages.length; i++) {
      const prev = out[out.length - 1]!
      const curr = messages[i]!
      if (prev.role === curr.role) {
        out.push({
          role: prev.role === 'user' ? 'assistant' : 'user',
          content: [{ text: '...' }],
        })
      }
      out.push(curr)
    }
    return out
  }

  const merged: ConverseMessage[] = [{ ...messages[0]!, content: [...messages[0]!.content] }]
  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1]!
    const curr = messages[i]!
    if (prev.role === curr.role) prev.content.push(...curr.content)
    else merged.push({ ...curr, content: [...curr.content] })
  }
  return merged
}

/** Default implementation; alias of {@link enforceConverseAlternation}. */
export const defaultEnforceConverseAlternation = enforceConverseAlternation

/**
 * Assemble the native Converse request from ADK turn state. THE ordering seam.
 *
 * @remarks
 * The translation that makes this battery different from pointing `openai_chat_completions` at a
 * Converse-backed gateway:
 *
 *  - System text becomes a top-level `system[]`, never a turn.
 *  - A `ToolCall` becomes an `assistant` turn with a `{toolUse}` block, then a **`user`** turn with
 *    a `{toolResult}` block — Converse has no `tool` role.
 *  - Blocks accumulate on the CURRENT turn where possible, so prose and a tool call emitted in the
 *    same assistant turn stay in one turn (the shape Converse is designed around).
 *  - Alternation is applied last, under {@link ConverseRequestBuildInput.alternationPolicy}.
 *  - Timeline order is `createdAt`, matching the ordering guard's view, so what the guard validated
 *    is what gets dispatched.
 */
export const buildConverseRequest = async (
  input: ConverseRequestBuildInput
): Promise<ConverseRequest> => {
  const h = input.helpers
  const systemText = await renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: input.bucketOrder ?? DEFAULT_CONVERSE_BUCKET_ORDER,
    renderStandingInstructions: h.renderStandingInstructions ?? renderStandingInstructions,
    renderMemories: h.renderMemories ?? renderMemories,
    renderRetrievables: h.renderRetrievables ?? renderRetrievables,
    renderRetrievableSafetyDirective:
      h.renderRetrievableSafetyDirective ?? renderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: h.renderFirstPartyRetrievables ?? renderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables:
      h.renderThirdPartyPublicRetrievables ?? renderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables:
      h.renderThirdPartyPrivateRetrievables ?? renderThirdPartyPrivateRetrievables,
    renderUntrustedContent: h.renderUntrustedContent ?? renderUntrustedContent,
  } as never)

  const surfaced = filterThoughts(
    input.thoughts,
    input.thoughtSurfacing,
    input.selfIdentity,
    input.replayCompatibility
  )

  type Item =
    | { at: number; kind: 'message'; value: Message }
    | { at: number; kind: 'thought'; value: Thought }
    | { at: number; kind: 'toolCall'; value: ToolCall }
  const items: Item[] = []
  for (const m of input.messages)
    items.push({ at: m.createdAt.toMillis(), kind: 'message', value: m })
  for (const t of surfaced) items.push({ at: t.createdAt.toMillis(), kind: 'thought', value: t })
  for (const c of input.toolCalls)
    items.push({ at: c.createdAt.toMillis(), kind: 'toolCall', value: c })
  items.sort((a, b) => a.at - b.at)

  const raw: ConverseMessage[] = []
  /**
   * Append blocks as their OWN turn, always.
   *
   * This deliberately does NOT coalesce same-role turns. Coalescing here would apply the merge
   * unconditionally, BEFORE `alternationPolicy` is consulted — which silently defeated
   * `'reject'`: two consecutive user messages arrived as one turn with two text blocks, so there
   * was no violation left for Converse to rule on and an audit measured our own repair. Merging is
   * `enforceConverseAlternation`'s job and only its job, so the policy stays honest.
   *
   * The one case that DOES belong in a single turn is a tool call and the prose introducing it,
   * which the toolCall branch below emits together for exactly that reason.
   */
  const push = (role: 'user' | 'assistant', blocks: ConverseContentBlock[]): void => {
    if (blocks.length === 0) return
    raw.push({ role, content: blocks })
  }

  for (const item of items) {
    if (item.kind === 'message') {
      const text = neutraliseDeveloperRulesTag(String(item.value.content ?? ''))
      const blocks: ConverseContentBlock[] = []
      if (text.length > 0) blocks.push({ text })
      for (const media of item.value.attachments ?? []) {
        if (input.decodeMedia === undefined) continue
        try {
          blocks.push({ image: await input.decodeMedia(media) })
        } catch (err) {
          input.warn?.(`decodeMedia failed for ${media.filename}: ${String(err)}`)
        }
      }
      push(item.value.role === 'assistant' ? 'assistant' : 'user', blocks)
      continue
    }

    if (item.kind === 'thought') {
      const envelope = renderThought(String(item.value.content ?? ''), {
        nonce: item.value.id,
        kind: 'self-reasoning',
        from: input.selfIdentity,
      } as never)
      push('assistant', [{ text: envelope }])
      continue
    }

    const tc = item.value
    const id = sanitizeToolUseId(tc.id)
    push('assistant', [
      {
        toolUse: {
          toolUseId: id,
          name: normalizeToolName(tc.tool),
          input: (typeof tc.args === 'string'
            ? JSON.parse(tc.args || '{}')
            : (tc.args ?? {})) as Record<string, unknown>,
        },
      },
    ])
    push('user', [
      {
        toolResult: {
          toolUseId: id,
          content: input.renderedToolCallResults.get(tc.id) ?? [{ text: '' }],
          status: tc.isError ? 'error' : 'success',
        },
      },
    ])
  }

  const messages = enforceConverseAlternation(raw, input.alternationPolicy ?? 'merge')
  const tools = h.toolsToConverseTools(input.tools.visible())

  // `toolConfig` is REQUIRED whenever any toolUse/toolResult block appears — including pure history
  // replay where no tools are offered for THIS turn. Omitting it is a hard rejection ("The
  // toolConfig field must be defined when using toolUse and toolResult content blocks").
  //
  // But an EMPTY `tools: []` is rejected too, with only "The provided request is not valid" —
  // verified live against Converse. So a transcript that replays calls for tools we can no longer
  // enumerate needs a declaration synthesized from the calls themselves: name plus a permissive
  // object schema. The model is not being offered these tools (it already called them); the
  // declaration exists solely to satisfy the correlation Converse insists on.
  const declaredNames = new Set(tools.map((t) => t.toolSpec.name))
  const historyToolNames = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.toolUse) historyToolNames.add(block.toolUse.name)
    }
  }
  const backfilled: ConverseToolSpec[] = [...historyToolNames]
    .filter((name) => !declaredNames.has(name))
    .map((name) => ({
      toolSpec: {
        name,
        description: `Previously invoked tool ${name} (declaration backfilled for history replay).`,
        inputSchema: { json: { type: 'object', properties: {} } as never },
      },
    }))
  const allTools = [...tools, ...backfilled]
  const historyHasToolBlocks = messages.some((m) =>
    m.content.some((b) => b.toolUse !== undefined || b.toolResult !== undefined)
  )

  return {
    messages,
    ...(systemText.length > 0 ? { system: [{ text: systemText }] } : {}),
    // Only emit toolConfig when it will be NON-EMPTY; an empty tools array is itself invalid.
    ...(allTools.length > 0 && (tools.length > 0 || historyHasToolBlocks)
      ? { toolConfig: { tools: allTools } }
      : {}),
  }
}

/** Default implementation; alias of {@link buildConverseRequest}. */
export const defaultBuildConverseRequest = buildConverseRequest

/**
 * Extract text, reasoning, and tool uses from a Converse response.
 *
 * @remarks
 * `reasoningContent` blocks are NOT concatenated into visible text — doing so leaks the model's
 * scratchpad into the answer.
 */
export const extractConverseGeneration = (
  response: ConverseResponseLike | undefined
): {
  text: string
  reasoning: string
  toolUses: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>
  stopReason: string | undefined
} => {
  const blocks = response?.output?.message?.content ?? []
  let text = ''
  let reasoning = ''
  const toolUses: Array<{ toolUseId: string; name: string; input: Record<string, unknown> }> = []
  for (const block of blocks) {
    if (block.toolUse) {
      toolUses.push({
        toolUseId: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: block.toolUse.input ?? {},
      })
      continue
    }
    if (block.reasoningContent?.reasoningText?.text) {
      reasoning += block.reasoningContent.reasoningText.text
      continue
    }
    if (typeof block.text === 'string') text += block.text
  }
  return { text, reasoning, toolUses, stopReason: response?.stopReason }
}

/** Structural minimum `extractConverseGeneration` needs, so tests can pass a literal. */
interface ConverseResponseLike {
  output?: { message?: { content?: ConverseContentBlock[] } }
  stopReason?: string
}

/** Default implementation; alias of {@link extractConverseGeneration}. */
export const defaultExtractConverseGeneration = extractConverseGeneration
