import { describe, expect, it } from 'vitest'
import { defaultDecodeAudio } from '../../../../../src/batteries/specialists/_shared'

// Node-only: exercises the real `audio-decode` peer. Kept out of the `.cross.spec.ts` sibling
// because the FIRST browser-side dynamic import of an optional peer triggers a Vite
// dependency-optimization re-bundle that reloads the test page mid-run (a known vitest browser-mode
// flake) — this mirrors how `tests/unit/batteries/media/image_audio.node.spec.ts` keeps its own real
// audio-decode round-trip tests node-only rather than cross-env.

/** Mint a mono 16-bit PCM WAV file — pure bytes, no dependencies (mirrors the media engine's own). */
const makeMonoWav = (sampleRate: number, samples: number[]): Uint8Array => {
  const dataSize = samples.length * 2
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (const [i, char] of [...text].entries()) bytes[offset + i] = char.charCodeAt(0)
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)
  for (const [i, sample] of samples.entries()) {
    view.setInt16(44 + i * 2, sample, true)
  }
  return bytes
}

const sineWav = (sampleRate: number, seconds: number): Uint8Array => {
  const count = Math.round(sampleRate * seconds)
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    samples.push(Math.round(10_000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)))
  }
  return makeMonoWav(sampleRate, samples)
}

describe('defaultDecodeAudio', () => {
  it('decodes a real mono wav to PCM, reporting the source sample rate', async () => {
    const wav = sineWav(8_000, 0.5)
    const { pcm, sampleRate } = await defaultDecodeAudio(wav)
    expect(sampleRate).toBe(8_000)
    expect(pcm.length).toBeGreaterThan(0)
    expect(pcm).toBeInstanceOf(Float32Array)
  })

  it('downmixes a real decoded buffer consistently with a second decode of the same bytes', async () => {
    const wav = sineWav(8_000, 0.25)
    const first = await defaultDecodeAudio(wav)
    const second = await defaultDecodeAudio(wav)
    expect(Array.from(first.pcm)).toEqual(Array.from(second.pcm))
  })
})
