import { describe, expect, it } from 'vitest'
import { isPcmInput, toBytes } from '../../../../../src/batteries/specialists/_shared'
import type { SpecialistMediaLike } from '../../../../../src/batteries/specialists/_shared'

describe('isPcmInput', () => {
  it('is true for a { pcm, sampleRate } record', () => {
    expect(isPcmInput({ pcm: new Float32Array(4), sampleRate: 16_000 })).toBe(true)
  })

  it('is false for a bare Uint8Array', () => {
    expect(isPcmInput(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('is false for a { bytes, mimeType } record', () => {
    expect(isPcmInput({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' })).toBe(false)
  })

  it('is false when pcm is present but not a Float32Array', () => {
    expect(isPcmInput({ pcm: [1, 2, 3], sampleRate: 16_000 })).toBe(false)
  })

  it('is false when sampleRate is missing', () => {
    expect(isPcmInput({ pcm: new Float32Array(4) })).toBe(false)
  })

  it('is false for null/undefined/primitives', () => {
    expect(isPcmInput(null)).toBe(false)
    expect(isPcmInput(undefined)).toBe(false)
    expect(isPcmInput('pcm')).toBe(false)
    expect(isPcmInput(42)).toBe(false)
  })
})

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

  it('resolves a SpecialistMediaLike via asBytes() + mimeType', async () => {
    const mediaBytes = new Uint8Array([9, 10, 11])
    const media: SpecialistMediaLike = {
      mimeType: 'image/jpeg',
      asBytes: async () => mediaBytes,
    }
    const out = await toBytes(media)
    expect(out.bytes).toBe(mediaBytes)
    expect(out.mimeType).toBe('image/jpeg')
  })
})
