// Unit coverage for the deterministic battery-owned pooling helper (0f). Env-neutral (node + browser)
// → proves the pooling math is identical across runtimes, which is the entire point of moving pooling
// out of the per-runtime ONNX pipeline and into shared JS (tighter node↔browser embedding parity).

import { describe, expect, it } from 'vitest'
import { poolAndNormalize, l2Normalize } from '@nhtio/adk/batteries/embeddings/transformers_js'

describe('l2Normalize', () => {
  it('scales a vector to unit length', () => {
    const v = l2Normalize([3, 4])
    expect(v[0]).toBeCloseTo(0.6, 9)
    expect(v[1]).toBeCloseTo(0.8, 9)
  })

  it('returns a zero vector unchanged (no divide-by-zero)', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0])
  })

  it('does not mutate the input', () => {
    const input = [3, 4]
    l2Normalize(input)
    expect(input).toEqual([3, 4])
  })
})

describe('poolAndNormalize', () => {
  const states = [
    [
      [2, 0],
      [0, 2],
    ],
    [
      [1, 1],
      [3, 3],
    ],
  ]

  it('mean-pools each batch row then normalizes by default', () => {
    const out = poolAndNormalize(states, 'mean', true)
    expect(out).toHaveLength(2)
    // row0 mean = [1,1] → normalize → [0.707, 0.707]
    expect(out[0][0]).toBeCloseTo(Math.SQRT1_2, 6)
    expect(out[0][1]).toBeCloseTo(Math.SQRT1_2, 6)
    // row1 mean = [2,2] → normalize → [0.707, 0.707]
    expect(out[1][0]).toBeCloseTo(Math.SQRT1_2, 6)
  })

  it('mean-pools without normalization when normalize=false', () => {
    const out = poolAndNormalize(states, 'mean', false)
    expect(out[0]).toEqual([1, 1])
    expect(out[1]).toEqual([2, 2])
  })

  it('cls/first_token takes the first token', () => {
    expect(poolAndNormalize(states, 'cls', false)[0]).toEqual([2, 0])
    expect(poolAndNormalize(states, 'first_token', false)[1]).toEqual([1, 1])
  })

  it('eos/last_token takes the last token', () => {
    expect(poolAndNormalize(states, 'eos', false)[0]).toEqual([0, 2])
    expect(poolAndNormalize(states, 'last_token', false)[1]).toEqual([3, 3])
  })

  it("'none' falls back to mean (still yields a vector)", () => {
    expect(poolAndNormalize(states, 'none', false)[0]).toEqual([1, 1])
  })
})
