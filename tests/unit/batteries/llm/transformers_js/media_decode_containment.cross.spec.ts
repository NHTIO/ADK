// Part 6b: decode-failure containment. A malformed media payload (zero-byte, truncated, polyglot,
// resolution bomb) must NOT throw out of the battery turn — a decode failure becomes a policy decision.
// buildTransformersJsMessages wraps the injected decodeMedia in try-catch and degrades through the SAME
// unsupportedMediaPolicy path as a disabled modality. We drive it with a throwing decodeMedia stub.
//
// Cross-env (no model peers, no node:fs) — buildTransformersJsMessages + the bundled default helpers.

import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import {
  Media,
  Message,
  Tokenizable,
  ToolCall,
  ToolRegistry,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import {
  buildTransformersJsMessages,
  mediaToTransformersInput,
  toolsToTransformersJsTools,
  renderThought,
  filterThoughts,
  renderUntrustedContent,
  renderTrustedContent,
  renderChatCompletionsSystemPrompt,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
} from '@nhtio/adk/batteries/llm/transformers_js'

const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])

const baseDeps = {
  systemPrompt: new Tokenizable('You are a test agent.'),
  standingInstructions: [] as Tokenizable[],
  memories: [],
  retrievables: [],
  thoughts: [],
  toolCalls: [],
  tools: new ToolRegistry(),
  renderedToolCallResults: new Map<ToolCall, string>(),
  bucketOrder: ['timeline'] as const,
  selfIdentity: 'agent',
  thoughtSurfacing: 'all-self' as const,
  replayCompatibility: [] as string[],
  toolsToTransformersJsTools,
  renderThought,
  filterThoughts,
  renderUntrustedContent,
  renderTrustedContent,
  renderChatCompletionsSystemPrompt,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
}

const makeImageMessage = (overrides: { stash?: boolean } = {}): Message => {
  const media = new Media({
    kind: 'image',
    mimeType: 'image/png',
    filename: 'broken.png',
    reader: inMemoryMediaReader(tinyPng),
    trustTier: 'third-party-private',
    modalityHazard: 'opaque-perceptual',
  })
  if (overrides.stash) {
    media.stash.set('text:description', {
      value: 'a fallback caption',
      trustTier: 'third-party-private',
    })
  }
  const now = DateTime.now()
  return new Message({
    id: 'm-img',
    role: 'user',
    content: 'look at this',
    attachments: [media],
    createdAt: now,
    updatedAt: now,
  })
}

describe('transformers_js — results are keyed by ToolCall instance', () => {
  it('renders each colliding-id call with its own pre-rendered result', async () => {
    const createdAt = DateTime.fromISO('2026-01-01T12:00:00Z')
    const first = new ToolCall({
      id: 'call_0',
      tool: 'lookup',
      args: { city: 'Paris' },
      checksum: 'first',
      isComplete: true,
      isError: false,
      results: new Tokenizable('Paris: 18C'),
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
    })
    const second = new ToolCall({
      id: 'call_0',
      tool: 'lookup',
      args: { city: 'Tokyo' },
      checksum: 'second',
      isComplete: true,
      isError: false,
      results: new Tokenizable('Tokyo: 25C'),
      createdAt: createdAt.plus({ seconds: 1 }),
      updatedAt: createdAt.plus({ seconds: 1 }),
      completedAt: createdAt.plus({ seconds: 1 }),
    })

    const out = await buildTransformersJsMessages({
      ...baseDeps,
      messages: [],
      toolCalls: [first, second],
      renderedToolCallResults: new Map([
        [first, 'Paris: 18C'],
        [second, 'Tokyo: 25C'],
      ]),
    })

    expect(
      out.messages.filter((message) => message.role === 'tool').map((message) => message.content)
    ).toEqual(['Paris: 18C', 'Tokyo: 25C'])
  })
})

describe('transformers_js — decode-failure containment', () => {
  it("a throwing decodeMedia under 'synthetic-description' degrades to a text block (no throw escapes)", async () => {
    const decodeMedia = vi.fn(async () => {
      throw new Error('Tensor size mismatch: 42336 vs 60000')
    })
    const warn = vi.fn()
    const out = await buildTransformersJsMessages({
      ...baseDeps,
      messages: [makeImageMessage()],
      multimodal: { image: true, audio: true },
      decodeMedia,
      unsupportedMediaPolicy: 'synthetic-description',
      warn,
    })
    expect(decodeMedia).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
    // The message degraded to a content-array carrying a synthetic text description — no images decoded.
    expect(out.images).toHaveLength(0)
    const msg = out.messages.find((m) => Array.isArray((m as { content?: unknown }).content)) as
      | { content: Array<{ type: string; text?: string }> }
      | undefined
    expect(msg).toBeDefined()
    const synthetic = msg!.content.find(
      (p) => p.type === 'text' && /broken\.png/.test(p.text ?? '')
    )
    expect(synthetic).toBeDefined()
  })

  it("a throwing decodeMedia under 'fallback-stash' uses the stash entry", async () => {
    const decodeMedia = vi.fn(async () => {
      throw new Error('decode boom')
    })
    const out = await buildTransformersJsMessages({
      ...baseDeps,
      messages: [makeImageMessage({ stash: true })],
      multimodal: { image: true, audio: true },
      decodeMedia,
      unsupportedMediaPolicy: { mode: 'fallback-stash', stashKeys: ['text:description'] },
      warn: vi.fn(),
    })
    expect(out.images).toHaveLength(0)
    const msg = out.messages.find((m) => Array.isArray((m as { content?: unknown }).content)) as
      | { content: Array<{ type: string; text?: string }> }
      | undefined
    const stashText = msg!.content.find((p) => /a fallback caption/.test(p.text ?? ''))
    expect(stashText).toBeDefined()
  })

  it("a throwing decodeMedia under 'throw' raises (undecodable under 'throw' is fatal by design)", async () => {
    const decodeMedia = vi.fn(async () => {
      throw new Error('decode boom')
    })
    await expect(
      buildTransformersJsMessages({
        ...baseDeps,
        messages: [makeImageMessage()],
        multimodal: { image: true, audio: true },
        decodeMedia,
        unsupportedMediaPolicy: 'throw',
        warn: vi.fn(),
      })
    ).rejects.toThrow()
  })

  it('a SUCCESSFUL decode still collects the image (containment is failure-only, no regression)', async () => {
    const decodeMedia = vi.fn(async () => ({ kind: 'image' as const, data: { fake: 'rawimage' } }))
    const out = await buildTransformersJsMessages({
      ...baseDeps,
      messages: [makeImageMessage()],
      multimodal: { image: true, audio: true },
      decodeMedia,
      unsupportedMediaPolicy: 'throw',
      warn: vi.fn(),
    })
    expect(out.images).toHaveLength(1)
  })
})

// ─── PCM WAV decode: env-neutral, no `@huggingface/transformers` peer, no AudioContext ───────────────
//
// transformers.js `read_audio` decodes via the Web Audio API (`AudioContext`), which Node lacks — it
// throws "AudioContext is not available in your environment" (verified). For uncompressed PCM WAV (the
// 16 kHz mono container speech models expect) `mediaToTransformersInput` parses the RIFF itself with a
// DataView — dependency-free, runs in Node AND the browser, and returns BEFORE importing the heavy peer.
// These cross-env tests exercise that fast path directly (synthetic WAV bytes, no node:fs).

/** Build a minimal canonical PCM/IEEE-float RIFF/WAVE buffer for `samples` (one channel). */
const makeWav = (
  samples: number[],
  opts: { sampleRate?: number; bits?: number; float?: boolean; channels?: number } = {}
): Uint8Array => {
  const sampleRate = opts.sampleRate ?? 16000
  const bits = opts.bits ?? 16
  const float = opts.float ?? false
  const channels = opts.channels ?? 1
  const bytesPerSample = bits >> 3
  const dataSize = samples.length * bytesPerSample
  const buf = new Uint8Array(44 + dataSize)
  const dv = new DataView(buf.buffer)
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, float ? 3 : 1, true) // 3 = IEEE float, 1 = PCM int
  dv.setUint16(22, channels, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * bytesPerSample * channels, true)
  dv.setUint16(32, bytesPerSample * channels, true)
  dv.setUint16(34, bits, true)
  ascii(36, 'data')
  dv.setUint32(40, dataSize, true)
  for (const [i, sample] of samples.entries()) {
    const off = 44 + i * bytesPerSample
    if (float) dv.setFloat32(off, sample, true)
    else if (bits === 16) dv.setInt16(off, Math.round(sample * 32767), true)
    else if (bits === 8) dv.setUint8(off, Math.round(sample * 128) + 128)
    else if (bits === 32) dv.setInt32(off, Math.round(sample * 2147483647), true)
  }
  return buf
}

const wavMedia = (bytes: Uint8Array): Media =>
  new Media({
    kind: 'audio',
    mimeType: 'audio/wav',
    filename: 'tone.wav',
    reader: inMemoryMediaReader(bytes),
    trustTier: 'third-party-private',
    modalityHazard: 'opaque-perceptual',
  })

describe('transformers_js — PCM WAV decode (env-neutral, no peer)', () => {
  it('decodes 16-bit mono PCM to a Float32Array at the source rate (no resample)', async () => {
    const samples = [0, 0.5, -0.5, 1, -1, 0.25]
    const out = await mediaToTransformersInput(wavMedia(makeWav(samples, { sampleRate: 16000 })))
    expect(out.kind).toBe('audio')
    const pcm = out.data as Float32Array
    expect(pcm).toBeInstanceOf(Float32Array)
    expect(pcm.length).toBe(samples.length)
    // 16-bit round-trips to within a quantization step.
    for (let i = 0; i < samples.length; i++) expect(pcm[i]).toBeCloseTo(samples[i], 4)
  })

  it('resamples to the requested target rate via linear interpolation', async () => {
    // 8 samples @ 16 kHz → 4 samples @ 8 kHz.
    const wav = makeWav([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25], { sampleRate: 16000 })
    const out = await mediaToTransformersInput(wavMedia(wav), { audioSampleRate: 8000 })
    const pcm = out.data as Float32Array
    expect(pcm.length).toBe(4)
  })

  it('downmixes a stereo PCM WAV to mono by averaging channels', async () => {
    // Interleaved L/R: L=+1, R=-1 → mono 0; L=0.5,R=0.5 → 0.5.
    const wav = makeWav([1, -1, 0.5, 0.5], { sampleRate: 16000, channels: 2 })
    const out = await mediaToTransformersInput(wavMedia(wav))
    const pcm = out.data as Float32Array
    expect(pcm.length).toBe(2)
    expect(pcm[0]).toBeCloseTo(0, 3)
    expect(pcm[1]).toBeCloseTo(0.5, 3)
  })

  it('decodes 32-bit IEEE float PCM (format 3)', async () => {
    const samples = [0, 0.5, -0.5, 0.123]
    const out = await mediaToTransformersInput(
      wavMedia(makeWav(samples, { bits: 32, float: true }))
    )
    const pcm = out.data as Float32Array
    expect(pcm.length).toBe(samples.length)
    for (let i = 0; i < samples.length; i++) expect(pcm[i]).toBeCloseTo(samples[i], 5)
  })
})
