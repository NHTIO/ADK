import { describe, expect, it } from 'vitest'
import { resampleTo, downmixToMono } from '../../../src/lib/utils/audio'

describe('resampleTo', () => {
  it('is a no-op (identity) when fromRate === toRate', () => {
    const pcm = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const out = resampleTo(pcm, 16_000, 16_000)
    expect(out).toBe(pcm)
  })

  it('halves the sample count when downsampling by 2x', () => {
    const pcm = new Float32Array(32_000)
    const out = resampleTo(pcm, 32_000, 16_000)
    expect(out.length).toBe(16_000)
  })

  it('doubles the sample count when upsampling by 2x', () => {
    const pcm = new Float32Array(8_000)
    const out = resampleTo(pcm, 8_000, 16_000)
    expect(out.length).toBe(16_000)
  })

  it('linearly interpolates between neighboring samples on a known ramp', () => {
    // A ramp 0, 1, 2, 3 at rate 4; resample to rate 2 → half the samples, positions 0 and 2.
    const pcm = new Float32Array([0, 1, 2, 3])
    const out = resampleTo(pcm, 4, 2)
    expect(out.length).toBe(2)
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[1]).toBeCloseTo(2, 6)
  })

  it('produces an exact interpolated fractional value at a non-integer source position', () => {
    // rate 3 -> rate 2: ratio = 1.5. out[1] samples source position 1.5, halfway between
    // pcm[1]=10 and pcm[2]=20 -> 15.
    const pcm = new Float32Array([0, 10, 20])
    const out = resampleTo(pcm, 3, 2)
    expect(out.length).toBe(2)
    expect(out[0]).toBeCloseTo(0, 6)
    expect(out[1]).toBeCloseTo(15, 6)
  })

  it('returns an empty array for empty input', () => {
    const out = resampleTo(new Float32Array(0), 16_000, 8_000)
    expect(out.length).toBe(0)
  })
})

describe('downmixToMono', () => {
  it('returns a single channel as-is (a copy, same values)', () => {
    const channel = new Float32Array([0.1, -0.2, 0.3])
    const out = downmixToMono([channel])
    expect(out).not.toBe(channel)
    expect(Array.from(out)).toEqual(Array.from(channel))
  })

  it('averages two channels sample-by-sample', () => {
    const left = new Float32Array([1, 2, 3])
    const right = new Float32Array([3, 4, 5])
    const out = downmixToMono([left, right])
    expect(Array.from(out)).toEqual([2, 3, 4])
  })

  it('averages three channels sample-by-sample', () => {
    const a = new Float32Array([0, 3, 6])
    const b = new Float32Array([0, 3, 6])
    const c = new Float32Array([0, 3, 6])
    const out = downmixToMono([a, b, c])
    expect(Array.from(out)).toEqual([0, 3, 6])
  })

  it('preserves channel length', () => {
    const left = new Float32Array(1024)
    const right = new Float32Array(1024)
    const out = downmixToMono([left, right])
    expect(out.length).toBe(1024)
  })
})
