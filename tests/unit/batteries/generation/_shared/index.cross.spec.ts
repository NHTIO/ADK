import { describe, expect, it } from 'vitest'
import { toBytes } from '../../../../../src/batteries/generation/_shared'
import type { GenerationMediaLike } from '../../../../../src/batteries/generation/_shared'

describe('toBytes', () => {
  it('passes a bare Uint8Array through with mimeType undefined', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const out = await toBytes(bytes)
    expect(out.bytes).toBe(bytes)
    expect(out.mimeType).toBeUndefined()
  })

  it('passes a { bytes, mimeType } record through unchanged', async () => {
    const bytes = new Uint8Array([4, 5, 6])
    const out = await toBytes({ bytes, mimeType: 'image/png' })
    expect(out.bytes).toBe(bytes)
    expect(out.mimeType).toBe('image/png')
  })

  it('passes a { bytes } record with no mimeType through as undefined', async () => {
    const bytes = new Uint8Array([7, 8])
    const out = await toBytes({ bytes })
    expect(out.bytes).toBe(bytes)
    expect(out.mimeType).toBeUndefined()
  })

  it('resolves a GenerationMediaLike via asBytes() + mimeType', async () => {
    const mediaBytes = new Uint8Array([9, 10, 11])
    const media: GenerationMediaLike = {
      mimeType: 'image/jpeg',
      asBytes: async () => mediaBytes,
    }
    const out = await toBytes(media)
    expect(out.bytes).toBe(mediaBytes)
    expect(out.mimeType).toBe('image/jpeg')
  })

  it('propagates a webp mimeType through the media-like path', async () => {
    const mediaBytes = new Uint8Array([1])
    const media: GenerationMediaLike = {
      mimeType: 'image/webp',
      asBytes: async () => mediaBytes,
    }
    const out = await toBytes(media)
    expect(out.mimeType).toBe('image/webp')
  })
})
