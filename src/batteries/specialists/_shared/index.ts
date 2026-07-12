/**
 * Structural contracts and normalization helpers shared by the on-device specialist batteries
 * (STT / OCR / caption).
 *
 * @module @nhtio/adk/batteries/specialists/_shared
 *
 * @remarks
 * This module imports **nothing** from `@nhtio/adk` core — not even a type-only import — per
 * CONTRIBUTING.md → Design Decisions → #13 "Battery design — no concrete core-class coupling",
 * tier 2 (locally-declared structural duck-types). A specialist adapter is *handed* media at
 * runtime (an image to caption, an audio clip to transcribe) but never constructs a `Media`
 * itself, so it has no genuine reason to import the class: {@link SpecialistMediaLike} declares
 * the exact shape it reads (`mimeType` + `asBytes()`), and a real core `Media` instance satisfies
 * it automatically, with zero import edge between the specialists domain and core.
 *
 * {@link defaultDecodeAudio} is the one capability a specialist adapter cannot perform itself
 * (turning arbitrary container bytes into PCM) — it lazily imports the optional `audio-decode`
 * peer (already a package dependency, mirroring `src/batteries/media/engines/audio_decode.ts`)
 * rather than requiring every consumer to inject a decoder. Consumers who want a different decode
 * path (or want to avoid the peer entirely) inject their own {@link DecodeAudioFn}.
 */

import { downmixToMono } from '../../../lib/utils/audio'
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'

/**
 * Structural duck-type of core `Media`: the exact shape a specialist adapter reads off a media
 * value — its declared MIME type, and an async accessor for its raw bytes.
 *
 * @remarks
 * A real `@nhtio/adk` `Media` instance satisfies this interface structurally (it has both a
 * `mimeType` string property and an `asBytes(): Promise<Uint8Array>` method), so callers can pass
 * a `Media` straight through without the specialists domain ever importing the class. See the
 * module remarks for why this is a deliberate decoupling choice (CONTRIBUTING.md Design Decision
 * #13, tier 2).
 */
export interface SpecialistMediaLike {
  /** The media's declared MIME type, e.g. `'image/png'` or `'audio/wav'`. */
  mimeType: string
  /** Resolves the media's raw bytes. */
  asBytes(): Promise<Uint8Array>
}

/** Raw bytes plus an optional MIME type — the plain-object form of image/document input. */
export interface SpecialistBytesInput {
  /** The raw encoded bytes (e.g. a PNG/JPEG/PDF page image). */
  bytes: Uint8Array
  /** The MIME type of `bytes`, when known. */
  mimeType?: string
}

/**
 * Any of the three forms a specialist adapter accepts as image/document input: a bare
 * `Uint8Array` (MIME type unknown), a {@link SpecialistBytesInput} record (bytes + declared
 * MIME), or a {@link SpecialistMediaLike} (a real `Media` or any duck-typed equivalent).
 */
export type SpecialistImageInput = Uint8Array | SpecialistBytesInput | SpecialistMediaLike

/** Already-decoded mono PCM audio at a known sample rate — bypasses container decoding entirely. */
export interface SpecialistPcmInput {
  /** Mono PCM samples. */
  pcm: Float32Array
  /** The sample rate of `pcm`, in Hz. */
  sampleRate: number
}

/**
 * Any of the forms a specialist adapter accepts as audio input: an encoded container (any
 * {@link SpecialistImageInput} form — bytes, bytes+mime, or media-like) that the adapter decodes
 * via a {@link DecodeAudioFn}, or pre-decoded {@link SpecialistPcmInput} that skips decoding.
 */
export type SpecialistAudioInput = SpecialistImageInput | SpecialistPcmInput

/**
 * Narrows `input` to {@link SpecialistPcmInput} — `true` when it carries a `Float32Array` `pcm`
 * field and a numeric `sampleRate` field.
 *
 * @param input - The value to test (typically a {@link SpecialistAudioInput}).
 * @returns Whether `input` is already-decoded PCM rather than an encoded container.
 */
export const isPcmInput = (input: unknown): input is SpecialistPcmInput => {
  if (!isObject(input)) return false
  const candidate = input as Record<string, unknown>
  return (
    isInstanceOf(candidate.pcm, 'Float32Array', Float32Array) &&
    typeof candidate.sampleRate === 'number'
  )
}

/**
 * Normalizes any {@link SpecialistImageInput} form to plain bytes plus an optional MIME type.
 *
 * @remarks
 * A bare `Uint8Array` passes through with `mimeType: undefined` (the caller declared no MIME).
 * A {@link SpecialistBytesInput} passes its `bytes`/`mimeType` through unchanged. A
 * {@link SpecialistMediaLike} is resolved by awaiting `asBytes()` and reading `mimeType` off it.
 *
 * @param input - The image/document input in any accepted form.
 * @returns The normalized bytes and MIME type (MIME `undefined` only for the bare-`Uint8Array` form).
 */
export const toBytes = async (
  input: SpecialistImageInput
): Promise<{ bytes: Uint8Array; mimeType?: string }> => {
  if (isInstanceOf(input, 'Uint8Array', Uint8Array)) return { bytes: input, mimeType: undefined }
  if (typeof (input as SpecialistMediaLike).asBytes === 'function') {
    const media = input as SpecialistMediaLike
    return { bytes: await media.asBytes(), mimeType: media.mimeType }
  }
  const bytesInput = input as SpecialistBytesInput
  return { bytes: bytesInput.bytes, mimeType: bytesInput.mimeType }
}

/**
 * Injected audio-decode seam: turns encoded container bytes into mono PCM at the container's
 * source sample rate. Consumers may swap this for their own decoder (a different codec library, a
 * cached/pre-warmed instance, or a test double) without the specialists domain ever depending on a
 * concrete implementation.
 *
 * @param bytes - The encoded audio container bytes (wav/mp3/flac/etc).
 * @returns The decoded mono PCM samples and the source sample rate, in Hz.
 */
export type DecodeAudioFn = (
  bytes: Uint8Array
) => Promise<{ pcm: Float32Array; sampleRate: number }>

/** The decoded shapes `audio-decode` resolves to (mirrors the media battery's own decode engine). */
interface AudioDecodeBufferLike {
  /** Channel count when the AudioBuffer-compatible shape is returned. */
  numberOfChannels?: number
  /** Sample rate of the decoded audio, in Hz. Present on both shapes. */
  sampleRate: number
  /** Per-channel sample accessor on the AudioBuffer-compatible shape. */
  getChannelData?(channel: number): Float32Array
  /** Raw per-channel sample arrays on the plain-record shape. */
  channelData?: Float32Array[]
}

type RawAudioDecodeFn = (bytes: Uint8Array | ArrayBuffer) => Promise<AudioDecodeBufferLike>

const channelsOf = (buffer: AudioDecodeBufferLike): Float32Array[] => {
  if (Array.isArray(buffer.channelData)) return buffer.channelData
  if (typeof buffer.getChannelData === 'function') {
    const count = buffer.numberOfChannels ?? 1
    return Array.from({ length: count }, (_, c) => buffer.getChannelData!(c))
  }
  throw new Error('audio-decode returned an unrecognized buffer shape')
}

/**
 * Default {@link DecodeAudioFn}: lazily imports the optional `audio-decode` peer, decodes the
 * container, then downmixes to mono via {@link downmixToMono}.
 *
 * @remarks
 * `audio-decode` resolves to one of two shapes depending on codec/environment: an
 * AudioBuffer-compatible object (`numberOfChannels` + `getChannelData()`) or a plain
 * `{ channelData: Float32Array[], sampleRate }` record (e.g. the wav path in Node). Both are
 * normalized identically to how `src/batteries/media/engines/audio_decode.ts` handles them,
 * lifted into this standalone function rather than shared code (that engine's own copy stays
 * untouched — it belongs to the media battery, not to specialists).
 *
 * @param bytes - The encoded audio container bytes.
 * @returns The decoded mono PCM samples and the source sample rate, in Hz.
 * @throws An `Error` naming the install command when the `audio-decode` peer is not installed.
 */
export const defaultDecodeAudio: DecodeAudioFn = async (bytes: Uint8Array) => {
  let decode: RawAudioDecodeFn
  try {
    const mod = await import('audio-decode')
    const fn = typeof mod === 'function' ? mod : (mod as { default: RawAudioDecodeFn }).default
    if (typeof fn !== 'function') {
      throw new Error('audio-decode did not resolve to a decode function')
    }
    decode = fn
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    throw new Error(
      `defaultDecodeAudio could not load its peer dependency "audio-decode": ${detail} — install it (pnpm add audio-decode)`
    )
  }
  const buffer = await decode(bytes)
  const channels = channelsOf(buffer)
  return { pcm: downmixToMono(channels), sampleRate: buffer.sampleRate }
}
