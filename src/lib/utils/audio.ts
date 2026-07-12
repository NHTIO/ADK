/**
 * Environment-neutral PCM audio primitives shared across the media battery and the on-device
 * specialist batteries.
 *
 * @module @nhtio/adk/lib/utils/audio
 *
 * @remarks
 * These are pure helpers over `Float32Array` — no DOM, no Node built-ins, no core class coupling.
 * They are shared (not duplicated) by `src/batteries/media` (which re-exports {@link resampleTo}
 * from its `image_audio` step and calls {@link downmixToMono} from its `audio_decode` engine) and
 * by `src/batteries/specialists/_shared` (whose default audio decoder downmixes before handing PCM
 * to a specialist model). The bundler inlines this module into each consumer, so sharing introduces
 * no build coupling.
 */

/**
 * Linearly resamples a mono PCM buffer from one sample rate to another.
 *
 * @remarks
 * Pure resample only — no channel/downmix logic lives here (see {@link downmixToMono} for that).
 * Uses linear interpolation between the two nearest source samples for each output sample; a
 * no-op (returns `pcm` as-is) when `fromRate === toRate`.
 *
 * @param pcm - The source mono PCM samples.
 * @param fromRate - The source sample rate, in Hz.
 * @param toRate - The target sample rate, in Hz.
 * @returns The resampled mono PCM samples, `Math.floor(pcm.length * toRate / fromRate)` long.
 */
export const resampleTo = (pcm: Float32Array, fromRate: number, toRate: number): Float32Array => {
  if (fromRate === toRate) return pcm
  const ratio = fromRate / toRate
  const outLength = Math.floor(pcm.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const left = Math.floor(pos)
    const right = Math.min(left + 1, pcm.length - 1)
    const frac = pos - left
    out[i] = pcm[left] * (1 - frac) + pcm[right] * frac
  }
  return out
}

/**
 * Downmixes one or more PCM channels to a single mono channel by averaging samples across
 * channels.
 *
 * @remarks
 * A single channel is returned as-is (a copy, not the original reference — callers may safely
 * mutate the result). Two or more channels are averaged sample-by-sample: `mono[i] = mean(channels
 * .map(c => c[i]))`, using each channel's own length contribution (`data[i] / channels.length`
 * accumulated across channels) so the result is numerically identical regardless of channel order.
 *
 * @param channels - The per-channel PCM sample arrays, all the same length.
 * @returns The mono PCM samples, the same length as each input channel.
 */
export const downmixToMono = (channels: Float32Array[]): Float32Array => {
  if (channels.length <= 1) return new Float32Array(channels[0] ?? [])
  const length = channels[0].length
  const mono = new Float32Array(length)
  for (const data of channels) {
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels.length
  }
  return mono
}
