import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  inMemoryMediaReader,
  Media,
  SpooledArtifact,
  Tool,
  ToolCall,
  Tokenizable,
} from '@nhtio/adk/common'
import {
  E_ANTHROPIC_MESSAGES_UNSUPPORTED_MEDIA_MODALITY,
  renderAnthropicMediaBlocks,
  renderAnthropicToolCallResult,
  renderUntrustedContent,
  renderTrustedContent,
} from '@nhtio/adk/batteries/llm/anthropic_messages'

const bytes = (list: number[]) => new Uint8Array(list)
const dt = DateTime.fromISO('2026-01-01T00:00:00Z', { zone: 'utc' })

const makeToolCall = (overrides: Record<string, unknown> = {}) =>
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
    ...overrides,
  })

const trustedTool = new Tool({
  name: 'emit_media',
  description: 'emits media',
  inputSchema: validator.object({}).unknown(true),
  trusted: true,
  handler: async () => 'ok',
})

describe('Anthropic media rendering', () => {
  const spooled = (text: string): SpooledArtifact => {
    const store = new InMemorySpoolStore()
    return new SpooledArtifact(store.write('tc-1', text))
  }

  it('respects inline for single spooled results; array path pinned as the known six-adapter defect', async () => {
    const artifact = spooled('full artifact text')
    const handle = await renderAnthropicToolCallResult({
      toolCall: makeToolCall({ results: artifact }),
      results: artifact,
      tool: undefined,
      renderUntrustedContent,
      renderTrustedContent,
      renderAnthropicMediaBlocks,
      unsupportedMediaPolicy: 'throw',
    })
    expect(handle.content).toContain('was not inlined to preserve context budget')
    expect(handle.content).not.toContain('full artifact text')

    const inlineArtifact = spooled('full inline text')
    const inline = await renderAnthropicToolCallResult({
      toolCall: makeToolCall({ results: inlineArtifact, inline: true }),
      results: inlineArtifact,
      tool: undefined,
      renderUntrustedContent,
      renderTrustedContent,
      renderAnthropicMediaBlocks,
      unsupportedMediaPolicy: 'throw',
    })
    expect(inline.content).toContain('full inline text')

    // ⚠ CURRENT BEHAVIOUR, NOT A DESIRED CONTRACT — do not read the two assertions below as a
    // guarantee. `SpooledArtifact[]` ignores `inline` on ALL SIX adapters, not just this one: OpenAI's
    // array branch calls `asString()` and returns BEFORE its `inline` test, and transformers_js /
    // litert_lm gate their handle branch on `!Array.isArray(results)`. That is a separate, WIDER defect
    // — "defect (b)" in the plan's action item #2 — deliberately OUT OF SCOPE here, because fixing it
    // changes behaviour for every provider at once and deserves its own decision (does a
    // handle-per-artifact block make sense, or does an array of handles need a different render?).
    // This commit restores PARITY on the single-result path only. When defect (b) is fixed, these two
    // assertions flip — which is the point of pinning them explicitly rather than leaving the array
    // path untested and having the change discovered as a surprise regression.
    const first = spooled('first array text')
    const second = spooled('second array text')
    const array = await renderAnthropicToolCallResult({
      toolCall: makeToolCall({ results: [first, second] }),
      results: [first, second],
      tool: undefined,
      renderUntrustedContent,
      renderTrustedContent,
      renderAnthropicMediaBlocks,
      unsupportedMediaPolicy: 'throw',
    })
    expect(array.content).toContain('first array text')
    expect(array.content).toContain('second array text')
  })

  // A THROWN `E_SANDBOX_*` — not a returned one. The adapter's own catch is the only thing that sets
  // `ToolCall.isError`, so this fixture models the post-catch state: the narrated refusal has already
  // been converted into a `Tokenizable` and the call flagged. A RETURNED refusal string would be
  // `isError: false`, which is why the sandbox battery throws instead of returning — see the plan's
  // "Failures" decision. This asserts the throw path stays INLINE on Anthropic (never a handle), which
  // is what makes a narrated failure readable on all six adapters.
  it('renders a THROWN sandbox refusal inline and preserves the adapter-set error flag', async () => {
    const result = await renderAnthropicToolCallResult({
      toolCall: makeToolCall({
        results: new Tokenizable('E_SANDBOX_REFUSED: denied'),
        isError: true,
      }),
      results: new Tokenizable('E_SANDBOX_REFUSED: denied'),
      tool: undefined,
      renderUntrustedContent,
      renderTrustedContent,
      renderAnthropicMediaBlocks,
      unsupportedMediaPolicy: 'throw',
    })
    expect(result.content).toContain('E_SANDBOX_REFUSED: denied')
    expect(result.is_error).toBe(true)
  })

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
