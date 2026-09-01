/**
 * Media-mapping coverage for the OpenAI Responses battery:
 *   - image → `input_image` (data URI)
 *   - document → `input_file` using the CONFIRMED wire shape (`file_data:
 *     'data:<mime>;base64,<b64>'` + `filename`) — document support SHIPS IN V1, not a
 *     fallback/conditional row; the live probe already confirmed this contract (see
 *     `helpers.ts`'s `renderOpenAIResponsesMediaBlocks`).
 *   - audio / video → all `unsupportedMediaPolicy` branches ('throw' / 'synthetic-description' /
 *     'fallback-stash' with and without a matching stash entry), since the Responses input-content
 *     union has no audio or video member.
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { Media, Message, ToolCall, Tokenizable, inMemoryMediaReader, Tool } from '@nhtio/adk/common'
import {
  renderOpenAIResponsesMediaBlocks,
  renderOpenAIResponsesToolCallResult,
  renderOpenAIResponsesTimelineMessage,
  renderTrustedContent,
  renderUntrustedContent,
  E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY,
} from '@nhtio/adk/batteries/llm/openai_responses'
import type {
  OpenAIResponsesInputContentBlock,
  OpenAIResponsesMessageItem,
} from '@nhtio/adk/batteries/llm/openai_responses'

const tinyBuf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const makeToolCall = (): ToolCall => {
  const now = dt('2026-01-01T00:00:00Z')
  return new ToolCall({
    id: 'tc-1',
    tool: 'someTool',
    args: {},
    checksum: 'nonce-1',
    isComplete: true,
    isError: false,
    results: new Tokenizable(''),
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

const renderDeps = { renderUntrustedContent, renderTrustedContent }

/** Every rendered media is preceded by an inline id-marker text block (`[media id: … | filename]`). */
const isIdMarker = (b: { type?: string; text?: string }): boolean =>
  b.type === 'input_text' && typeof b.text === 'string' && /^\[media id: /.test(b.text)

/**
 * Tool-returned media is BRACKETED by a trust-boundary open/close text block pair (keyed on the
 * producing tool's `trusted` flag) so instructions embedded in an untrusted tool's image/document
 * are not indistinguishable from a first-party attachment. These wrapper blocks are asserted
 * directly by the trust-framing tests below; every other test strips them to assert the native
 * body shape.
 */
const isTrustBoundary = (b: { type?: string; text?: string }): boolean =>
  b.type === 'input_text' &&
  typeof b.text === 'string' &&
  /^<\/?(?:un)?trusted_content_/.test(b.text)

const bodyBlocks = <T = OpenAIResponsesInputContentBlock>(result: unknown): T[] =>
  (result as Array<{ type?: string; text?: string }>).filter(
    (b) => !isIdMarker(b) && !isTrustBoundary(b)
  ) as T[]

describe('OpenAI Responses — media block rendering (renderOpenAIResponsesMediaBlocks)', () => {
  it('image → input_image with a base64 data URI, preceded by an id-marker text block', async () => {
    const media = new Media({
      id: 'media-img-1',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'p.png',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })
    const result = await renderOpenAIResponsesMediaBlocks({
      media,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'input_text', text: '[media id: media-img-1 | p.png]' })
    expect(result[1]!.type).toBe('input_image')
    const imgBlock = result[1] as Extract<OpenAIResponsesInputContentBlock, { type: 'input_image' }>
    expect(imgBlock.detail).toBe('auto')
    expect(imgBlock.image_url).toMatch(/^data:image\/png;base64,/)
  })

  it('document → input_file using the CONFIRMED shape: file_data as a full data URI + filename', async () => {
    const media = new Media({
      id: 'media-doc-1',
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'extractable-instructions',
    })
    const result = await renderOpenAIResponsesMediaBlocks({
      media,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ type: 'input_text', text: '[media id: media-doc-1 | report.pdf]' })
    const fileBlock = result[1] as Extract<OpenAIResponsesInputContentBlock, { type: 'input_file' }>
    expect(fileBlock.type).toBe('input_file')
    expect(fileBlock.filename).toBe('report.pdf')
    // NOT bare base64 — a full data URI, per the live-probe-confirmed contract.
    expect(fileBlock.file_data).toMatch(/^data:application\/pdf;base64,/)
    expect(fileBlock.file_data).not.toMatch(/^[A-Za-z0-9+/=]+$/) // rules out "bare base64, no prefix"
    expect(fileBlock.file_id).toBeUndefined()
    expect(fileBlock.file_url).toBeUndefined()
  })

  it('document file_data base64 payload round-trips the original bytes', async () => {
    const media = new Media({
      kind: 'document',
      mimeType: 'text/plain',
      filename: 'note.txt',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'extractable-instructions',
    })
    const result = await renderOpenAIResponsesMediaBlocks({
      media,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })
    const fileBlock = result.find((b) => b.type === 'input_file') as Extract<
      OpenAIResponsesInputContentBlock,
      { type: 'input_file' }
    >
    const b64 = fileBlock.file_data!.split(',')[1]!
    // Cross-env decode (no Buffer in browser projects) — atob + manual byte extraction.
    const binary = atob(b64)
    const decoded = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    expect(Array.from(decoded)).toEqual(Array.from(tinyBuf))
  })

  describe('audio × unsupportedMediaPolicy (no native representation)', () => {
    const makeAudio = () =>
      new Media({
        kind: 'audio',
        mimeType: 'audio/mp3',
        filename: 'a.mp3',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })

    it("'throw' raises E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY", async () => {
      await expect(
        renderOpenAIResponsesMediaBlocks({
          media: makeAudio(),
          unsupportedMediaPolicy: 'throw',
          ...renderDeps,
        })
      ).rejects.toThrow(E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY)
    })

    // NOTE: unlike image/document (marker block THEN a separate media block), the
    // unsupportedMediaPolicy fallback paths render a SINGLE combined text block:
    // `[media id: ...]\n<enveloped fallback text>` — so these assertions read `result` directly
    // rather than through `bodyBlocks` (which is designed to strip a SEPARATE marker block, and
    // would incorrectly filter out this single combined block since it also starts with the marker
    // prefix).
    it("'synthetic-description' emits a single combined marker+synthetic-description text block", async () => {
      const result = await renderOpenAIResponsesMediaBlocks({
        media: makeAudio(),
        unsupportedMediaPolicy: 'synthetic-description',
        ...renderDeps,
      })
      expect(result).toHaveLength(1)
      expect(result[0]!.type).toBe('input_text')
      const text = (result[0] as { text: string }).text
      expect(text).toMatch(/^\[media id: /)
      expect(text).toContain('a.mp3')
      expect(text).toContain('audio/mp3')
    })

    it("'fallback-stash' with a matching entry renders the stash text (marker + body combined)", async () => {
      const audio = makeAudio()
      audio.stash.set('text:transcript', {
        value: 'A transcript of the audio.',
        trustTier: 'third-party-private',
      })
      const result = await renderOpenAIResponsesMediaBlocks({
        media: audio,
        unsupportedMediaPolicy: { mode: 'fallback-stash', stashKeys: ['text:transcript'] },
        ...renderDeps,
      })
      expect(result).toHaveLength(1)
      expect((result[0] as { text: string }).text).toContain('A transcript of the audio.')
    })

    it("'fallback-stash' with no matching entry falls through to synthetic description", async () => {
      const result = await renderOpenAIResponsesMediaBlocks({
        media: makeAudio(),
        unsupportedMediaPolicy: { mode: 'fallback-stash', stashKeys: ['text:missing'] },
        ...renderDeps,
      })
      expect(result).toHaveLength(1)
      expect((result[0] as { text: string }).text).toContain('a.mp3')
    })
  })

  describe('video × unsupportedMediaPolicy (no native representation)', () => {
    const makeVideo = () =>
      new Media({
        kind: 'video',
        mimeType: 'video/mp4',
        filename: 'v.mp4',
        reader: inMemoryMediaReader(tinyBuf),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })

    it("'throw' raises E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY", async () => {
      await expect(
        renderOpenAIResponsesMediaBlocks({
          media: makeVideo(),
          unsupportedMediaPolicy: 'throw',
          ...renderDeps,
        })
      ).rejects.toThrow(E_OPENAI_RESPONSES_UNSUPPORTED_MEDIA_MODALITY)
    })

    it("'synthetic-description' emits a single combined marker+synthetic-description text block", async () => {
      const result = await renderOpenAIResponsesMediaBlocks({
        media: makeVideo(),
        unsupportedMediaPolicy: 'synthetic-description',
        ...renderDeps,
      })
      expect(result).toHaveLength(1)
      const text = (result[0] as { text: string }).text
      expect(text).toContain('v.mp4')
      expect(text).toContain('video/mp4')
    })

    it("'fallback-stash' with a matching entry renders the stash text", async () => {
      const video = makeVideo()
      video.stash.set('text:caption', { value: 'A caption.', trustTier: 'third-party-public' })
      const result = await renderOpenAIResponsesMediaBlocks({
        media: video,
        unsupportedMediaPolicy: { mode: 'fallback-stash', stashKeys: ['text:caption'] },
        ...renderDeps,
      })
      expect((result[0] as { text: string }).text).toContain('A caption.')
    })

    it('default (bare string) fallback-stash mode uses the default stash keys', async () => {
      const video = makeVideo()
      video.stash.set('text:description', {
        value: 'Default-key description.',
        trustTier: 'first-party',
      })
      const result = await renderOpenAIResponsesMediaBlocks({
        media: video,
        unsupportedMediaPolicy: 'fallback-stash',
        ...renderDeps,
      })
      expect((result[0] as { text: string }).text).toContain('Default-key description.')
    })
  })
})

describe('OpenAI Responses — media in tool-call results (renderOpenAIResponsesToolCallResult)', () => {
  it('single image media result returns input_image content blocks', async () => {
    const media = new Media({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'p.png',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })
    const result = await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: media,
      tool: makeTool(),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })
    expect(Array.isArray(result)).toBe(true)
    const blocks = bodyBlocks<{ type: string }>(result)
    expect(blocks[0]!.type).toBe('input_image')
  })

  it('multi-asset media result returns one content block set per asset, in order', async () => {
    const img1 = new Media({
      id: 'm1',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'a.png',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })
    const img2 = new Media({
      id: 'm2',
      kind: 'image',
      mimeType: 'image/jpeg',
      filename: 'b.jpg',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })
    const result = await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: [img1, img2],
      tool: makeTool(),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })
    const blocks = result as OpenAIResponsesInputContentBlock[]
    // Open boundary, then (id-marker + native block) per media, then close boundary.
    expect(blocks.map((b) => b.type)).toEqual([
      'input_text',
      'input_text',
      'input_image',
      'input_text',
      'input_image',
      'input_text',
    ])
    // `makeTool()` is untrusted by default, and the boundary is keyed on the TOOL's trust — not on
    // the media's own tier, which is `first-party` for both images here.
    const first = blocks[0] as { text: string }
    const last = blocks[blocks.length - 1] as { text: string }
    expect(first.text).toMatch(/^<untrusted_content_/)
    expect(last.text).toMatch(/^<\/untrusted_content_/)
  })

  it('document media result returns an input_file content block', async () => {
    const media = new Media({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'd.pdf',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'extractable-instructions',
    })
    const result = await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: media,
      tool: makeTool(),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })
    const blocks = bodyBlocks<{ type: string; filename?: string }>(result)
    expect(blocks[0]!.type).toBe('input_file')
    expect(blocks[0]!.filename).toBe('d.pdf')
  })
})

describe('OpenAI Responses — media in timeline messages (renderOpenAIResponsesTimelineMessage)', () => {
  it('user message with text + image renders as a content array with id-marker + input_image', async () => {
    const img = new Media({
      id: 'attach-1',
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
      createdAt: dt('2026-01-01T00:00:00Z'),
      updatedAt: dt('2026-01-01T00:00:00Z'),
    })
    const out = await renderOpenAIResponsesTimelineMessage({
      message: m,
      selfIdentity: 'assistant',
      unsupportedMediaPolicy: 'throw',
      renderOpenAIResponsesMediaBlocks,
      ...renderDeps,
    })
    expect(out).not.toBeNull()
    const content = (out as OpenAIResponsesMessageItem)
      .content as OpenAIResponsesInputContentBlock[]
    expect(content[0]!.type).toBe('input_text')
    expect(content[1]!.type).toBe('input_text') // id-marker
    expect((content[1] as { text: string }).text).toContain('p.png')
    expect(content[2]!.type).toBe('input_image')
  })

  it('attachments-only user message still renders the (empty-bodied) envelope block, then the id-marker + media', async () => {
    // The default identity (`role` as both identifier/representation, per Message's own schema)
    // always has a non-empty identifier, so `renderOpenAIResponsesTimelineMessage` always emits
    // the `<message_...>` envelope block (even wrapping empty text) ahead of any media blocks —
    // there is no "no envelope, attachments only" shape reachable through the default identity.
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
      createdAt: dt('2026-01-01T00:00:00Z'),
      updatedAt: dt('2026-01-01T00:00:00Z'),
    })
    const out = await renderOpenAIResponsesTimelineMessage({
      message: m,
      selfIdentity: 'assistant',
      unsupportedMediaPolicy: 'throw',
      renderOpenAIResponsesMediaBlocks,
      ...renderDeps,
    })
    const content = (out as OpenAIResponsesMessageItem)
      .content as OpenAIResponsesInputContentBlock[]
    expect(content).toHaveLength(3)
    expect(content[0]!.type).toBe('input_text')
    expect((content[0] as { text: string }).text).toContain('<message_msg-2')
    expect(content[1]!.type).toBe('input_text')
    expect((content[1] as { text: string }).text).toMatch(/^\[media id: /)
    expect(content[2]!.type).toBe('input_image')
  })

  it('document attachment on a user message renders input_file', async () => {
    const doc = new Media({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'spec.pdf',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'extractable-instructions',
    })
    const m = new Message({
      id: 'msg-3',
      role: 'user',
      content: 'read this doc',
      attachments: [doc],
      createdAt: dt('2026-01-01T00:00:00Z'),
      updatedAt: dt('2026-01-01T00:00:00Z'),
    })
    const out = await renderOpenAIResponsesTimelineMessage({
      message: m,
      selfIdentity: 'assistant',
      unsupportedMediaPolicy: 'throw',
      renderOpenAIResponsesMediaBlocks,
      ...renderDeps,
    })
    const content = (out as OpenAIResponsesMessageItem)
      .content as OpenAIResponsesInputContentBlock[]
    const fileBlock = content.find((b) => b.type === 'input_file') as Extract<
      OpenAIResponsesInputContentBlock,
      { type: 'input_file' }
    >
    expect(fileBlock).toBeDefined()
    expect(fileBlock.filename).toBe('spec.pdf')
    expect(fileBlock.file_data).toMatch(/^data:application\/pdf;base64,/)
  })
})

// ─── Trust framing for tool-returned NATIVE media ─────────────────────────────
//
// A native `input_image`/`input_file` cannot be wrapped in a text envelope without destroying the
// wire representation, so the boundary BRACKETS the native blocks instead. Before this, an
// untrusted tool's image/document arrived preceded only by an id marker, leaving instructions
// embedded in the media indistinguishable from a first-party attachment.
describe('OpenAI Responses — tool-returned media carries a trust boundary', () => {
  const makeImage = (id: string) =>
    new Media({
      id,
      kind: 'image',
      mimeType: 'image/png',
      filename: `${id}.png`,
      reader: inMemoryMediaReader(tinyBuf),
      // Deliberately first-party: the boundary must key on the TOOL's trust, not the media's.
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })

  it('brackets an untrusted tool’s image in an untrusted_content boundary', async () => {
    const result = (await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: makeImage('untrusted-1'),
      tool: makeTool(false),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })) as Array<{ type: string; text?: string }>

    expect(result[0]!.text).toMatch(/^<untrusted_content_/)
    expect(result[0]!.text).toContain('kind="tool-result-media"')
    expect(result[result.length - 1]!.text).toMatch(/^<\/untrusted_content_/)
    // The native block still sits INSIDE the boundary, unaltered.
    expect(result.some((b) => b.type === 'input_image')).toBe(true)
  })

  it('brackets a trusted tool’s image in a trusted_content boundary', async () => {
    const result = (await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: makeImage('trusted-1'),
      tool: makeTool(true),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })) as Array<{ type: string; text?: string }>

    expect(result[0]!.text).toMatch(/^<trusted_content_/)
    expect(result[0]!.text).toContain('kind="trusted-tool-result-media"')
    expect(result[result.length - 1]!.text).toMatch(/^<\/trusted_content_/)
    expect(result.some((b) => b.type === 'input_image')).toBe(true)
  })

  it('never leaves a native media block outside the boundary', async () => {
    const result = (await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: [makeImage('a'), makeImage('b')],
      tool: makeTool(false),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      ...renderDeps,
    })) as Array<{ type: string }>

    const firstNative = result.findIndex((b) => b.type !== 'input_text')
    const lastNative = result.map((b) => b.type).lastIndexOf('input_image')
    expect(firstNative).toBeGreaterThan(0)
    expect(lastNative).toBeLessThan(result.length - 1)
  })
})

// A trust boundary is a SECURITY control: it must not degrade to "off" because a pluggable
// renderer misbehaved. The sentinel-split fallback previously returned the media UNFRAMED when a
// consumer override swallowed its body, silently disabling the boundary on exactly the untrusted
// tool media it exists to frame. It now falls back to the DEFAULT renderer instead.
describe('OpenAIResponsesAdapter — trust boundary survives a broken custom renderer', () => {
  it('falls back to the default envelope when an override drops its body', async () => {
    const swallowBody = (_content: string, attrs: { nonce: string; kind: string }) =>
      `<custom_${attrs.kind}_${attrs.nonce}></custom_${attrs.kind}_${attrs.nonce}>`
    const media = new Media({
      id: 'm-broken',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'p.png',
      reader: inMemoryMediaReader(tinyBuf),
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })
    const result = (await renderOpenAIResponsesToolCallResult({
      toolCall: makeToolCall(),
      results: media,
      tool: makeTool(false),
      renderOpenAIResponsesMediaBlocks,
      unsupportedMediaPolicy: 'throw',
      renderTrustedContent: swallowBody as never,
      renderUntrustedContent: swallowBody as never,
    })) as Array<{ type: string; text?: string }>

    // The native block is still bracketed — by the DEFAULT renderer, since the override could not
    // be split. Previously this returned the bare blocks with no boundary at all.
    expect(result[0]!.text).toMatch(/^<untrusted_content_/)
    expect(result[result.length - 1]!.text).toMatch(/^<\/untrusted_content_/)
    expect(result.some((b) => b.type === 'input_image')).toBe(true)
    const firstNative = result.findIndex((b) => b.type !== 'input_text')
    expect(firstNative).toBeGreaterThan(0)
    expect(result.map((b) => b.type).lastIndexOf('input_image')).toBeLessThan(result.length - 1)
  })
})
