// Unit coverage for the LiteRT-LM multimodal MAPPING (0c) — env-neutral, no engine/WASM, runs in node
// + browser. Drives `buildLiteRtConversationInput` directly to prove a user Message with attachments
// maps to a LiteRT content-item array (`[{type:'text'}, {type:'image', path:'data:…'}]`) when the
// matching modality flag is on, and degrades via `unsupportedMediaPolicy` when off. The text-only path
// (no attachments) stays a plain string `content`.
//
// NOTE: this is the BUILD half of the LiteRT multimodal feature. Whether the 0.13.1 WASM runtime
// actually HONORS image/audio content items is GATED ON A REAL-MODEL PROOF (the browser matrix
// `litert-gemma-mm-probe`) — the published types over-promise, the tool_calls lesson. If the WASM
// ignores it, the documented degrade path (this spec's `policy:'throw'`/synthetic cases) is the answer.

import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  Media,
  ToolRegistry,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import {
  buildLiteRtConversationInput,
  renderMediaToLiteRtContent,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
  defaultRenderStandingInstructions,
  defaultRenderMemories,
  defaultRenderRetrievables,
  defaultRenderRetrievableSafetyDirective,
  defaultRenderFirstPartyRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  defaultRenderThought,
  defaultFilterThoughts,
  defaultRenderChatCompletionsSystemPrompt,
  defaultToolsToLiteRtTools,
} from '@nhtio/adk/batteries/llm/litert_lm'
import type { LiteRtMessage, LiteRtMessageContentItem } from '@nhtio/adk/batteries/llm/litert_lm'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

// Tiny 1x1 PNG (red) — enough bytes for a real base64 round-trip; content is irrelevant to mapping.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01,
])

const imageMessage = (): Message => {
  const createdAt = dt('2026-01-01T12:00:00Z')
  return new Message({
    id: 'u-img',
    role: 'user',
    content: 'What is in this picture?',
    attachments: [
      Media.userAttachment({
        id: 'img-1',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'red.png',
        reader: inMemoryMediaReader(PNG_BYTES),
      }),
    ],
    createdAt,
    updatedAt: createdAt,
  })
}

const baseInput = (overrides: Record<string, unknown>) => ({
  systemPrompt: new Tokenizable('You are a vision assistant.'),
  standingInstructions: new Set<Tokenizable>(),
  memories: new Set<Memory>(),
  retrievables: new Set<Retrievable>(),
  messages: new Set<Message>(),
  thoughts: new Set<Thought>(),
  toolCalls: new Set<ToolCall>(),
  tools: new ToolRegistry(),
  renderedToolCallResults: new Map<string, LiteRtMessageContentItem>(),
  bucketOrder: ['standingInstructions', 'memories', 'retrievables', 'timeline'] as never,
  selfIdentity: 'assistant',
  thoughtSurfacing: 'all-self' as const,
  replayCompatibility: [] as string[],
  toolsToLiteRtTools: defaultToolsToLiteRtTools,
  renderThought: defaultRenderThought,
  filterThoughts: defaultFilterThoughts,
  renderUntrustedContent: defaultRenderUntrustedContent,
  renderTrustedContent: defaultRenderTrustedContent,
  renderChatCompletionsSystemPrompt: defaultRenderChatCompletionsSystemPrompt,
  renderStandingInstructions: defaultRenderStandingInstructions,
  renderMemories: defaultRenderMemories,
  renderRetrievables: defaultRenderRetrievables,
  renderRetrievableSafetyDirective: defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables: defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables: defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables: defaultRenderThirdPartyPrivateRetrievables,
  ...overrides,
})

const userMessages = (out: { messages: LiteRtMessage[] }) =>
  out.messages.filter((m) => m.role === 'user')

describe('LiteRT-LM multimodal mapping — buildLiteRtConversationInput', () => {
  it('maps an image attachment to a content-item array with a data: URI when vision is enabled', async () => {
    const out = await buildLiteRtConversationInput(
      baseInput({
        messages: new Set([imageMessage()]),
        visionModalityEnabled: true,
        unsupportedMediaPolicy: 'throw',
        renderMediaToLiteRtContent,
      }) as never
    )
    const user = userMessages(out)[0]
    expect(user).toBeDefined()
    expect(Array.isArray(user?.content)).toBe(true)
    const items = user?.content as LiteRtMessageContentItem[]
    // First a text item, then the image item.
    expect(items[0]).toEqual({ type: 'text', text: 'What is in this picture?' })
    expect(items[1]?.type).toBe('image')
    expect(items[1]?.path).toMatch(/^data:image\/png;base64,/)
  })

  it('degrades to text via synthetic-description when vision is disabled (no leaked binary)', async () => {
    const out = await buildLiteRtConversationInput(
      baseInput({
        messages: new Set([imageMessage()]),
        visionModalityEnabled: false,
        unsupportedMediaPolicy: 'synthetic-description',
        renderMediaToLiteRtContent,
      }) as never
    )
    const user = userMessages(out)[0]
    const items = user?.content as LiteRtMessageContentItem[]
    expect(Array.isArray(items)).toBe(true)
    // No image item; both items are text, and the fallback mentions the file (synthetic description).
    expect(items.every((i) => i.type === 'text')).toBe(true)
    const joined = items.map((i) => i.text ?? '').join('\n')
    expect(joined).toContain('red.png')
    expect(joined).not.toMatch(/data:image/)
  })

  it("throws under policy 'throw' when the modality is disabled (documented failure path)", async () => {
    await expect(
      buildLiteRtConversationInput(
        baseInput({
          messages: new Set([imageMessage()]),
          visionModalityEnabled: false,
          unsupportedMediaPolicy: 'throw',
          renderMediaToLiteRtContent,
        }) as never
      )
    ).rejects.toThrow(/does not support media/i)
  })

  it('leaves a no-attachment message as a plain string content (text path unchanged)', async () => {
    const createdAt = dt('2026-01-01T12:00:00Z')
    const out = await buildLiteRtConversationInput(
      baseInput({
        messages: new Set([
          new Message({
            id: 'u-1',
            role: 'user',
            content: 'hello',
            createdAt,
            updatedAt: createdAt,
          }),
        ]),
        visionModalityEnabled: true,
        unsupportedMediaPolicy: 'throw',
        renderMediaToLiteRtContent,
      }) as never
    )
    const user = userMessages(out)[0]
    expect(typeof user?.content).toBe('string')
    expect(user?.content).toBe('hello')
  })

  it('leaves attachments untouched when the media renderer is NOT wired (back-compat)', async () => {
    // Omitting renderMediaToLiteRtContent → the legacy plain-string path, attachments ignored.
    const out = await buildLiteRtConversationInput(
      baseInput({
        messages: new Set([imageMessage()]),
        visionModalityEnabled: true,
        unsupportedMediaPolicy: 'throw',
        // renderMediaToLiteRtContent intentionally omitted
      }) as never
    )
    const user = userMessages(out)[0]
    expect(typeof user?.content).toBe('string')
    expect(user?.content).toBe('What is in this picture?')
  })
})
