// The portable, battery-agnostic GENERATION contract (chat_common/generation.ts). Proves the canonical
// resolver's defaults + canonical-wins precedence, env-neutral (node + browser), no peers.
//
// The end-to-end "same canonical config → correct native mapping on each battery" proof lives in the
// per-battery adapter specs (transformers_js generate-kwargs / litert samplerParams); this file pins the
// shared resolver those mappings are built on.

import { describe, expect, it } from 'vitest'
import {
  resolveGenerationOptions,
  GENERATION_DEFAULTS,
} from '@nhtio/adk/batteries/llm/transformers_js'

describe('resolveGenerationOptions — defaults', () => {
  it('fills deterministic-friendly defaults when nothing is supplied', () => {
    const r = resolveGenerationOptions({})
    expect(r).toEqual(GENERATION_DEFAULTS)
    expect(r.sampler).toBe('greedy')
    expect(r.maxTokens).toBe(1024)
    expect(r.temperature).toBeCloseTo(0.7)
    expect(r.topK).toBe(40)
    expect(r.topP).toBeCloseTo(0.95)
    expect(r.enableThinking).toBe(false)
    expect(r.multimodal).toEqual({ image: false, audio: false })
  })
})

describe('resolveGenerationOptions — canonical fields', () => {
  it('honours explicit canonical values', () => {
    const r = resolveGenerationOptions({
      maxTokens: 256,
      sampler: 'top-p',
      temperature: 0.2,
      topK: 10,
      topP: 0.5,
      seed: 7,
      enableThinking: true,
      multimodal: { image: true },
    })
    expect(r.maxTokens).toBe(256)
    expect(r.sampler).toBe('top-p')
    expect(r.temperature).toBeCloseTo(0.2)
    expect(r.topK).toBe(10)
    expect(r.topP).toBeCloseTo(0.5)
    expect(r.seed).toBe(7)
    expect(r.enableThinking).toBe(true)
    // partial multimodal fills the missing kind with its default (off)
    expect(r.multimodal).toEqual({ image: true, audio: false })
  })
})

describe('resolveGenerationOptions — canonical-wins precedence', () => {
  it('the canonical value overrides the native fallback when both are set', () => {
    const r = resolveGenerationOptions(
      { maxTokens: 256, sampler: 'top-k' },
      { maxTokens: 999, sampler: 'greedy', topK: 5 }
    )
    expect(r.maxTokens).toBe(256) // canonical wins
    expect(r.sampler).toBe('top-k') // canonical wins
    expect(r.topK).toBe(5) // native fallback used (no canonical topK)
  })

  it('the native fallback is used only when the canonical field is absent', () => {
    const r = resolveGenerationOptions({}, { maxTokens: 333, sampler: 'top-p', temperature: 0.9 })
    expect(r.maxTokens).toBe(333)
    expect(r.sampler).toBe('top-p')
    expect(r.temperature).toBeCloseTo(0.9)
  })

  it('multimodal: canonical object wins wholesale over the native fallback', () => {
    const r = resolveGenerationOptions(
      { multimodal: { image: true, audio: false } },
      { multimodal: { image: false, audio: true } }
    )
    expect(r.multimodal).toEqual({ image: true, audio: false })
  })
})
