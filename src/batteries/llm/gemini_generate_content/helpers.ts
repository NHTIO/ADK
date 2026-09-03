/**
 * Translation helpers for the native Gemini `generateContent` battery.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content/helpers
 *
 * @remarks
 * Every function is injectable via {@link GeminiGenerateContentAdapterOptions.helpers} and has a
 * `default*` alias. The wire-shape-agnostic renderers (untrusted/trusted envelopes, memories,
 * retrievables, thought envelopes, the system-prompt assembler) are re-exported unchanged from the
 * shared internal `../chat_common/helpers`; only the parts that are genuinely Gemini-shaped live
 * here.
 */

import { isObject } from '@nhtio/adk/guards'
import {
  descriptionToChatCompletionsJsonSchema,
  filterThoughts,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  looksLikeSpooledArtifact,
  neutraliseDeveloperRulesTag,
  normalizeToolName,
  renderChatCompletionsSystemPrompt,
  renderThought,
  renderTrustedContent,
  renderUntrustedContent,
  sanitizeMimeType,
} from '../chat_common/helpers'
import type { SpooledArtifact } from '@nhtio/adk/common'
import type { DescriptionLike } from '../chat_common/types'
import type {
  Tool,
  ArtifactTool,
  Media,
  ToolCall,
  Tokenizable,
  Message,
  Thought,
} from '@nhtio/adk/common'
import type {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiInlineData,
  GeminiPart,
  GeminiGenerateContentRequest,
  GeminiRequestBuildInput,
  GeminiTool,
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

/**
 * Default context-bucket order for the system instruction.
 *
 * @remarks
 * Matches the other chat batteries so a consumer switching batteries gets the same system-prompt
 * layout. Exported so a caller can reorder without reconstructing the whole list.
 */
export const DEFAULT_GEMINI_BUCKET_ORDER = [
  'standingInstructions',
  'memories',
  'retrievables',
  'timeline',
] as const

/**
 * JSON-Schema keywords Gemini's OpenAPI-subset parameter schema rejects.
 *
 * @remarks
 * Sending any of these produces an opaque `INVALID_ARGUMENT` with no field name, which is
 * expensive to diagnose — so they are stripped before dispatch rather than forwarded. This mirrors
 * the same problem the Bedrock translator has to solve for Converse's schema dialect.
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
])

/**
 * Recursively strip schema keywords Gemini rejects.
 *
 * @param schema - Any JSON-Schema-shaped value.
 * @returns The same shape with unsupported keywords removed.
 */
export const sanitizeGeminiSchema = (schema: unknown): JsonSchema => {
  if (Array.isArray(schema)) return schema.map((s) => sanitizeGeminiSchema(s)) as never
  if (schema === null || typeof schema !== 'object') return schema as never
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    out[key] = isObject(value) ? sanitizeGeminiSchema(value) : value
  }
  return out as never
}

/** Default implementation; alias of {@link sanitizeGeminiSchema}. */
export const defaultSanitizeGeminiSchema = sanitizeGeminiSchema

/**
 * ADK tools → native `functionDeclarations`.
 *
 * @remarks
 * Names are normalised through the shared `normalizeToolName` so a tool whose ADK name contains
 * characters Gemini rejects still resolves; `functionResponse.name` must later match whatever this
 * produced, which is why both sides call the same normaliser.
 */
export const toolsToGeminiTools = (tools: Iterable<Tool | ArtifactTool>): GeminiTool[] => {
  const declarations: GeminiFunctionDeclaration[] = []
  for (const tool of tools) {
    // `describe()` is the canonical accessor — a Tool's schema is not a plain property.
    const described = tool.describe()
    const parameters = descriptionToChatCompletionsJsonSchema(
      described.inputSchema as unknown as DescriptionLike
    )
    const sanitized = sanitizeGeminiSchema(parameters)
    declarations.push({
      name: normalizeToolName(described.name),
      description: String(described.description ?? ''),
      // Gemini rejects an EMPTY parameters object on a zero-arg tool, so omit it entirely.
      ...(sanitized && Object.keys(sanitized).length > 0 ? { parameters: sanitized } : {}),
    })
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : []
}

/** Default implementation; alias of {@link toolsToGeminiTools}. */
export const defaultToolsToGeminiTools = toolsToGeminiTools

/**
 * Render one tool result into a `functionResponse.response` object.
 *
 * @remarks
 * Gemini requires an OBJECT here, not a bare string — a string is rejected. Text is therefore
 * wrapped as `{ result: <text> }`, keeping the untrusted-content envelope the other batteries use
 * so a tool result cannot impersonate a system directive.
 */
export const renderGeminiToolResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  renderUntrustedContent: typeof renderUntrustedContent
  renderTrustedContent: typeof renderTrustedContent
  unsupportedMediaPolicy: UnsupportedMediaPolicy | undefined
  warn?: (message: string) => void
}): Promise<Record<string, unknown>> => {
  const { results, toolCall } = input
  if (looksLikeSpooledArtifact(results)) {
    // A spooled artifact is referenced by handle, never inlined — the same contract the other
    // batteries hold, so a large result cannot blow the window.
    return { result: `[artifact ${String((results as { id?: unknown }).id ?? toolCall.id)}]` }
  }
  const text = String(results ?? '')
  return {
    result: input.renderUntrustedContent(text, {
      nonce: toolCall.id,
      from: toolCall.tool,
    } as never),
  }
}

/** Default implementation; alias of {@link renderGeminiToolResult}. */
export const defaultRenderGeminiToolResult = renderGeminiToolResult

/** Decode an ADK Media into Gemini's `inlineData`. */
export const mediaToGeminiInlineData = async (media: Media): Promise<GeminiInlineData> => {
  const bytes = await media.asBytes()
  let binary = ''
  const chunk = 0x8000
  const arr = bytes as Uint8Array
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunk))
  }
  return {
    mimeType: sanitizeMimeType(media.mimeType, media.kind === 'image' ? 'image' : 'audio'),
    data: typeof btoa === 'function' ? btoa(binary) : Buffer.from(arr).toString('base64'),
  }
}

/** Default implementation; alias of {@link mediaToGeminiInlineData}. */
export const defaultMediaToGeminiInlineData = mediaToGeminiInlineData

/**
 * Assemble the native request from ADK turn state. THE ordering seam.
 *
 * @remarks
 * The translation that makes this battery different from pointing `openai_chat_completions` at a
 * Gemini gateway:
 *
 *  - System text goes to `systemInstruction`, not a `contents[]` turn.
 *  - `Message.role: 'assistant'` becomes `role: 'model'`.
 *  - A `ToolCall` becomes TWO turns: a `model` turn with a `functionCall` part, then a `user` turn
 *    with a `functionResponse` part. `functionResponse.name` carries the DECLARED tool name,
 *    because Gemini has no call-id correlation.
 *  - Timeline order is `createdAt`, matching the ordering guard's own view, so what the guard
 *    validates is what gets dispatched.
 *  - The thought-signature sentinel is stamped on the FIRST `functionCall` only when no part
 *    already carries a real signature and the caller has not opted out. Preserving a genuine
 *    signature matters: it is prefix-bound, and replacing one invalidates it.
 */
export const buildGeminiRequest = async (
  input: GeminiRequestBuildInput
): Promise<GeminiGenerateContentRequest> => {
  // The shared assembler takes its sub-renderers EXPLICITLY rather than reaching for module
  // globals, so an override on `helpers` reaches the system prompt too.
  const h = input.helpers
  const systemText = await renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: input.bucketOrder ?? DEFAULT_GEMINI_BUCKET_ORDER,
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

  const contents: GeminiContent[] = []
  // Whether history already carries a real signature. If it does, DO NOT stamp a sentinel over it.
  let sawRealSignature = false
  for (const item of items) {
    if (item.kind === 'toolCall') {
      const payload = (item.value as { payload?: unknown }).payload
      const sig = isObject(payload)
        ? (payload as { thoughtSignature?: unknown }).thoughtSignature
        : undefined
      if (typeof sig === 'string' && sig.length > 0) sawRealSignature = true
    }
  }

  let stampedSentinel = false
  for (const item of items) {
    if (item.kind === 'message') {
      const text = neutraliseDeveloperRulesTag(String(item.value.content ?? ''))
      const parts: GeminiPart[] = []
      if (text.length > 0) parts.push({ text })
      for (const media of item.value.attachments ?? []) {
        if (input.decodeMedia === undefined) continue
        try {
          parts.push({ inlineData: await input.decodeMedia(media) })
        } catch (err) {
          input.warn?.(`decodeMedia failed for ${media.filename}: ${String(err)}`)
        }
      }
      if (parts.length === 0) continue
      contents.push({ role: item.value.role === 'assistant' ? 'model' : 'user', parts })
      continue
    }

    if (item.kind === 'thought') {
      const envelope = renderThought(String(item.value.content ?? ''), {
        nonce: item.value.id,
        kind: 'self-reasoning',
        from: input.selfIdentity,
      } as never)
      // Reasoning replays as a model turn flagged `thought`, so Gemini treats it as its own
      // prior reasoning rather than user-visible content.
      contents.push({ role: 'model', parts: [{ text: envelope, thought: true }] })
      continue
    }

    const tc = item.value
    const declaredName = normalizeToolName(tc.tool)
    const payload = (tc as { payload?: unknown }).payload
    const existingSig = isObject(payload)
      ? (payload as { thoughtSignature?: unknown }).thoughtSignature
      : undefined

    const callPart: GeminiPart = {
      functionCall: {
        name: declaredName,
        args: (typeof tc.args === 'string'
          ? JSON.parse(tc.args || '{}')
          : (tc.args ?? {})) as Record<string, unknown>,
      },
    }
    if (typeof existingSig === 'string' && existingSig.length > 0) {
      callPart.thoughtSignature = existingSig
    } else if (input.thoughtSignatureSentinel !== false && !sawRealSignature && !stampedSentinel) {
      // Only the FIRST call in the history needs it; stamping every one is unnecessary and makes
      // the provenance claim broader than it has to be.
      callPart.thoughtSignature = input.thoughtSignatureSentinel
      stampedSentinel = true
    }
    contents.push({ role: 'model', parts: [callPart] })

    const rendered = input.renderedToolCallResults.get(tc.id) ?? { result: '' }
    contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: declaredName, response: rendered } }],
    })
  }

  const tools = input.helpers.toolsToGeminiTools(input.tools.visible())
  return {
    contents,
    ...(systemText.length > 0 ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

/** Default implementation; alias of {@link buildGeminiRequest}. */
export const defaultBuildGeminiRequest = buildGeminiRequest

/**
 * Extract text, reasoning, and function calls from a response.
 *
 * @remarks
 * `thought: true` parts are reasoning and must NOT be concatenated into user-visible text — doing
 * so leaks the model's scratchpad into the answer.
 */
export const extractGeminiGeneration = (
  response: { candidates?: Array<{ content?: GeminiContent; finishReason?: string }> } | undefined
): {
  text: string
  reasoning: string
  functionCalls: Array<{ name: string; args: Record<string, unknown>; thoughtSignature?: string }>
  finishReason: string | undefined
} => {
  const candidate = response?.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  let text = ''
  let reasoning = ''
  const functionCalls: Array<{
    name: string
    args: Record<string, unknown>
    thoughtSignature?: string
  }> = []
  for (const part of parts) {
    if (part.functionCall) {
      functionCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args ?? {},
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      })
      continue
    }
    if (typeof part.text !== 'string') continue
    if (part.thought === true) reasoning += part.text
    else text += part.text
  }
  return { text, reasoning, functionCalls, finishReason: candidate?.finishReason }
}

/** Default implementation; alias of {@link extractGeminiGeneration}. */
export const defaultExtractGeminiGeneration = extractGeminiGeneration
