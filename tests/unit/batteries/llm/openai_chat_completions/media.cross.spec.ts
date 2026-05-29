import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { Media, Message, Tool, ToolCall, Tokenizable, inMemoryMediaReader } from '@nhtio/adk/common'
import { E_UNSUPPORTED_MEDIA_MODALITY } from '../../../../../src/batteries/llm/openai_chat_completions/exceptions'
import {
  renderChatCompletionsToolCallResult,
  renderTimelineMessage,
  renderTrustedContent,
  renderUntrustedContent,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'

const tinyBuf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

const makeToolCall = (overrides: Partial<{ tool: string; id: string }> = {}): ToolCall => {
  const now = DateTime.now()
  return new ToolCall({
    id: overrides.id ?? 'tc-1',
    tool: overrides.tool ?? 'someTool',
    args: {},
    checksum: 'nonce-1',
    isComplete: true,
    isError: false,
    results: new Tokenizable(''),
    fromArtifactTool: false,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  })
}

const makeTool = (trusted = false): Tool =>
  new Tool({
    name: 'someTool',
    description: 'test tool',
    inputSchema: validator.object({}),
    handler: async () => '',
    trusted,
  })

const renderDeps = {
  renderTrustedContent,
  renderUntrustedContent,
}

describe('OpenAI Chat Completions — Media tool-result rendering', () => {
  describe('image happy path', () => {
    it('returns an image_url content block with a base64 data URI', async () => {
      const media = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'p.png',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const toolCall = makeToolCall()
      const result = await renderChatCompletionsToolCallResult({
        toolCall,
        results: media,
        tool: makeTool(),
        unsupportedMediaPolicy: 'throw',
        ...renderDeps,
      })
      expect(Array.isArray(result)).toBe(true)
      const blocks = result as Array<{ type: string; image_url?: { url: string } }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('image_url')
      expect(blocks[0].image_url?.url).toMatch(/^data:image\/png;base64,/)
    })
  })

  describe('audio happy path', () => {
    it('returns an input_audio block when the audio mime is supported', async () => {
      const media = new Media({
        kind: 'audio',
        mimeType: 'audio/mp3',
        filename: 'a.mp3',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: media,
        tool: makeTool(),
        unsupportedMediaPolicy: 'throw',
        ...renderDeps,
      })
      const blocks = result as Array<{
        type: string
        input_audio?: { format: string; data: string }
      }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('input_audio')
      expect(typeof blocks[0].input_audio?.data).toBe('string')
    })
  })

  describe('document happy path', () => {
    it('returns a file block with file_data containing a base64 data URI', async () => {
      const media = new Media({
        kind: 'document',
        mimeType: 'application/pdf',
        filename: 'd.pdf',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'extractable-instructions',
      })
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: media,
        tool: makeTool(),
        unsupportedMediaPolicy: 'throw',
        ...renderDeps,
      })
      const blocks = result as Array<{
        type: string
        file?: { filename: string; file_data: string }
      }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('file')
      expect(blocks[0].file?.filename).toBe('d.pdf')
      expect(blocks[0].file?.file_data).toMatch(/^data:application\/pdf;base64,/)
    })
  })

  describe('multi-asset path', () => {
    it('returns one content block per asset, in order', async () => {
      const img1 = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'a.png',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const img2 = new Media({
        kind: 'image',
        mimeType: 'image/jpeg',
        filename: 'b.jpg',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: [img1, img2],
        tool: makeTool(),
        unsupportedMediaPolicy: 'throw',
        ...renderDeps,
      })
      const blocks = result as Array<{ type: string; image_url?: { url: string } }>
      expect(blocks).toHaveLength(2)
      expect(blocks[0].image_url?.url).toMatch(/^data:image\/png;base64,/)
      expect(blocks[1].image_url?.url).toMatch(/^data:image\/jpeg;base64,/)
    })
  })

  describe('video × unsupportedMediaPolicy modes', () => {
    const makeVideo = () =>
      new Media({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'v.mp4',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })

    it("'throw' raises E_UNSUPPORTED_MEDIA_MODALITY", async () => {
      await expect(
        renderChatCompletionsToolCallResult({
          toolCall: makeToolCall(),
          results: makeVideo(),
          tool: makeTool(),
          unsupportedMediaPolicy: 'throw',
          ...renderDeps,
        })
      ).rejects.toThrow(E_UNSUPPORTED_MEDIA_MODALITY)
    })

    it("'synthetic-description' emits a synthetic text block", async () => {
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: makeVideo(),
        tool: makeTool(),
        unsupportedMediaPolicy: 'synthetic-description',
        ...renderDeps,
      })
      const blocks = result as Array<{ type: string; text?: string }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('text')
      expect(blocks[0].text).toContain('v.mp4')
      expect(blocks[0].text).toContain('video/mp4')
    })

    it("'fallback-stash' with matching entry renders the stash text", async () => {
      const v = makeVideo()
      v.stash.set('text:transcript', {
        value: 'A transcript of the video.',
        trustTier: 'third-party-private',
      })
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: v,
        tool: makeTool(),
        unsupportedMediaPolicy: {
          mode: 'fallback-stash',
          stashKeys: ['text:transcript'],
        },
        ...renderDeps,
      })
      const blocks = result as Array<{ type: string; text?: string }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('text')
      expect(blocks[0].text).toContain('A transcript of the video.')
    })

    it("'fallback-stash' with no matching entry falls through to synthetic", async () => {
      const v = makeVideo()
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: v,
        tool: makeTool(),
        unsupportedMediaPolicy: {
          mode: 'fallback-stash',
          stashKeys: ['text:missing'],
        },
        ...renderDeps,
      })
      const blocks = result as Array<{ type: string; text?: string }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('text')
      expect(blocks[0].text).toContain('v.mp4')
    })
  })

  describe('Trust-Is-Content rule', () => {
    it('untrusted Media on a trusted tool still emits an untrusted envelope context', async () => {
      // For media blocks, the wire shape itself doesn't carry trust attribute, but the
      // adapter must not throw or override based on Tool.trusted. Smoke-test: a trusted
      // tool returning third-party-public media still renders to image_url blocks without
      // consulting Tool.trusted (no throw, single image block).
      const media = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'untrusted.png',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'third-party-public',
        modalityHazard: 'opaque-perceptual',
      })
      const result = await renderChatCompletionsToolCallResult({
        toolCall: makeToolCall(),
        results: media,
        tool: makeTool(/* trusted */ true),
        unsupportedMediaPolicy: 'throw',
        ...renderDeps,
      })
      const blocks = result as Array<{ type: string }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('image_url')
    })
  })

  describe('Message attachments — render', () => {
    it('user message with text + image renders as content-array', async () => {
      const img = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'p.png',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'third-party-private',
        modalityHazard: 'opaque-perceptual',
      })
      const m = new Message({
        id: 'msg-1',
        role: 'user',
        content: 'describe this',
        attachments: [img],
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      })
      const out = await renderTimelineMessage({
        message: m,
        selfIdentity: 'assistant',
        unsupportedMediaPolicy: 'throw',
      })
      expect(Array.isArray(out.content)).toBe(true)
      const blocks = out.content as Array<{ type: string }>
      expect(blocks[0].type).toBe('text')
      expect(blocks[1].type).toBe('image_url')
    })

    it('attachments-only user message renders without a leading text block', async () => {
      const img = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'p.png',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'third-party-private',
        modalityHazard: 'opaque-perceptual',
      })
      const m = new Message({
        id: 'msg-2',
        role: 'user',
        attachments: [img],
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      })
      const out = await renderTimelineMessage({
        message: m,
        selfIdentity: 'assistant',
        unsupportedMediaPolicy: 'throw',
      })
      const blocks = out.content as Array<{ type: string }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0].type).toBe('image_url')
    })

    it('assistant message with attachment renders symmetrically', async () => {
      const audio = new Media({
        kind: 'audio',
        mimeType: 'audio/mp3',
        filename: 'reply.mp3',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const m = new Message({
        id: 'msg-3',
        role: 'assistant',
        attachments: [audio],
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      })
      const out = await renderTimelineMessage({
        message: m,
        selfIdentity: 'assistant',
        unsupportedMediaPolicy: 'throw',
      })
      expect(out.role).toBe('assistant')
      const blocks = out.content as Array<{ type: string }>
      expect(blocks[0].type).toBe('input_audio')
    })
  })

  describe('lazy bytes', () => {
    it('does not materialise bytes when only metadata is accessed', () => {
      let streamCalls = 0
      const media = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: 'lazy.png',
        reader: {
          stream() {
            streamCalls++
            return new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(tinyBuf)
                c.close()
              },
            })
          },
          byteLength() {
            return tinyBuf.byteLength
          },
        },
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const json = media.toJSON()
      expect(json.kind).toBe('image')
      expect(streamCalls).toBe(0)
    })
  })
})
