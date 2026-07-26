import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { inMemoryMediaReader, Media, Tool, ToolCall, Tokenizable } from '@nhtio/adk/common'
import {
  E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY,
  renderAnthropicMediaBlocks,
  renderAnthropicToolCallResult,
  renderUntrustedContent,
  renderTrustedContent,
} from '@nhtio/adk/batteries/llm/anthropic_messages'

const bytes = (list: number[]) => new Uint8Array(list)
const dt = DateTime.fromISO('2026-01-01T00:00:00Z', { zone: 'utc' })

const makeToolCall = () =>
  new ToolCall({
    id: 'tc-1',
    tool: 'emit_media',
    args: {},
    checksum: 'sum',
    isComplete: true,
    isError: false,
    results: new Tokenizable('unused'),
    createdAt: dt,
    updatedAt: dt,
    completedAt: dt,
  })

const trustedTool = new Tool({
  name: 'emit_media',
  description: 'emits media',
  inputSchema: validator.object({}).unknown(true),
  trusted: true,
  handler: async () => 'ok',
})

describe('Anthropic media rendering', () => {
  it('renders image base64 blocks and native base64-pdf document blocks', async () => {
    const image = Media.userAttachment({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'pic.png',
      reader: inMemoryMediaReader(bytes([1, 2, 3])),
    })
    const imageBlocks = await renderAnthropicMediaBlocks({
      media: image,
      unsupportedMediaPolicy: 'throw',
      renderUntrustedContent,
      renderTrustedContent,
    })
    expect(imageBlocks[0]).toMatchObject({ type: 'text' })
    expect(imageBlocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
    })

    const pdf = Media.userAttachment({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'doc.pdf',
      reader: inMemoryMediaReader(bytes([0x25, 0x50, 0x44, 0x46])),
    })
    const pdfBlocks = await renderAnthropicMediaBlocks({
      media: pdf,
      unsupportedMediaPolicy: 'throw',
      renderUntrustedContent,
      renderTrustedContent,
    })
    expect(pdfBlocks[1]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' },
    })
  })

  it('routes audio/video through unsupportedMediaPolicy and throws with throw-policy', async () => {
    const audio = Media.userAttachment({
      kind: 'audio',
      mimeType: 'audio/wav',
      filename: 'clip.wav',
      reader: inMemoryMediaReader(bytes([1, 2, 3])),
      stash: {
        'text:transcript': { value: 'transcript here', trustTier: 'third-party-private' },
      },
    })
    const audioBlocks = await renderAnthropicMediaBlocks({
      media: audio,
      unsupportedMediaPolicy: 'fallback-stash',
      renderUntrustedContent,
      renderTrustedContent,
    })
    expect(audioBlocks).toHaveLength(1)
    expect(audioBlocks[0]).toMatchObject({ type: 'text' })
    expect((audioBlocks[0] as { text: string }).text).toContain('transcript here')

    const video = Media.userAttachment({
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
      reader: inMemoryMediaReader(bytes([9, 8, 7])),
    })
    await expect(
      renderAnthropicMediaBlocks({
        media: video,
        unsupportedMediaPolicy: 'throw',
        renderUntrustedContent,
        renderTrustedContent,
      })
    ).rejects.toBeInstanceOf(E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY)
  })

  it('renders trusted tool-result media through the same blocks', async () => {
    const image = Media.toolGenerated({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'out.png',
      reader: inMemoryMediaReader(bytes([4, 5, 6])),
    })
    const result = await renderAnthropicToolCallResult({
      toolCall: makeToolCall(),
      results: image,
      tool: trustedTool,
      renderUntrustedContent,
      renderTrustedContent,
      renderAnthropicMediaBlocks,
      unsupportedMediaPolicy: 'throw',
    })
    expect(result.type).toBe('tool_result')
    expect(Array.isArray(result.content)).toBe(true)
    expect((result.content as unknown as Array<Record<string, unknown>>)[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'BAUG' },
    })
  })
})
