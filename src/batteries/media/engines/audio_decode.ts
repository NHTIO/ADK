/**
 * A cross-environment audio-decoding {@link @nhtio/adk/batteries/media/contracts!MediaEngine}
 * backed by the `audio-decode` package (pure JS/WASM codecs — no ffmpeg, no native bindings;
 * works in Node and browsers).
 *
 * @module @nhtio/adk/batteries/media/engines/audio_decode
 *
 * @remarks
 * Declares one convert capability: audio containers to the virtual `pcm` token (mp3 /
 * m4a-aac / ogg-vorbis / opus / flac / wav), downmixed to mono. The PCM output reports the
 * SOURCE sample rate in `meta.sampleRate` — the pipeline's transcribe step resamples to the
 * 16 kHz transcription engines expect. For exotic containers, compose an ffmpeg-backed
 * engine instead; the capability declaration is the seam.
 *
 * `audio-decode` is an optional peer dependency, lazily imported on first actual use.
 */

import { isError } from '@nhtio/adk/guards'
import { pcmToBytes, PCM_MIME } from '../contracts'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type { MediaEngine, ConvertRequest, ConvertResult } from '../contracts'

/**
 * The decoded shapes audio-decode resolves to. Some codecs return an AudioBuffer-compatible
 * object (`numberOfChannels` + `getChannelData`); others (e.g. the wav path in Node) return a
 * plain `{ channelData: Float32Array[], sampleRate }` record. The engine normalizes both.
 */
export interface AudioBufferLike {
  /** Channel count when the AudioBuffer-compatible shape is returned. */
  numberOfChannels?: number
  /** Sample rate of the decoded audio, in Hz. Present on both shapes. */
  sampleRate: number
  /** Per-channel sample accessor on the AudioBuffer-compatible shape. */
  getChannelData?(channel: number): Float32Array
  /** Raw per-channel sample arrays on the plain-record shape. */
  channelData?: Float32Array[]
}

/** The decode function shape the `audio-decode` package exports. */
export type AudioDecodeFn = (bytes: Uint8Array | ArrayBuffer) => Promise<AudioBufferLike>

const channelsOf = (buffer: AudioBufferLike): Float32Array[] => {
  if (Array.isArray(buffer.channelData)) return buffer.channelData
  if (typeof buffer.getChannelData === 'function') {
    const count = buffer.numberOfChannels ?? 1
    return Array.from({ length: count }, (_, c) => buffer.getChannelData!(c))
  }
  throw new Error('audio-decode returned an unrecognized buffer shape')
}

/** Options for {@link audioDecodeEngine}. */
export interface AudioDecodeEngineOptions {
  /** Override the module resolution. Default: `import('audio-decode')`. */
  audioDecode?: () =>
    | AudioDecodeFn
    | { default: AudioDecodeFn }
    | Promise<AudioDecodeFn | { default: AudioDecodeFn }>
}

/**
 * Construct the audio-decode-backed engine.
 *
 * @param options - Optional module resolver override.
 * @returns The engine.
 */
export const audioDecodeEngine = (options: AudioDecodeEngineOptions = {}): MediaEngine => {
  let fnPromise: Promise<AudioDecodeFn> | undefined
  const getDecode = (): Promise<AudioDecodeFn> => {
    fnPromise ??= Promise.resolve(
      options.audioDecode ? options.audioDecode() : import('audio-decode')
    )
      .then((mod) => {
        const fn = typeof mod === 'function' ? mod : (mod as { default: AudioDecodeFn }).default
        if (typeof fn !== 'function') {
          throw new Error('audio-decode did not resolve to a decode function')
        }
        return fn
      })
      .catch((err) => {
        const detail = isError(err) ? err.message : String(err)
        throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
          `the audio-decode engine could not load its peer dependency "audio-decode": ${detail} — install it (pnpm add audio-decode)`,
        ])
      })
    return fnPromise
  }

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const decode = await getDecode()
    const buffer = await decode(request.bytes)
    const channels = channelsOf(buffer)
    let pcm: Float32Array
    if (channels.length <= 1) {
      pcm = channels[0]
    } else {
      // Downmix to mono by averaging channels.
      const length = channels[0].length
      const mono = new Float32Array(length)
      for (const data of channels) {
        for (let i = 0; i < length; i++) mono[i] += data[i] / channels.length
      }
      pcm = mono
    }
    return {
      outputs: [
        { bytes: pcmToBytes(pcm), mimeType: PCM_MIME, meta: { sampleRate: buffer.sampleRate } },
      ],
    }
  }

  return {
    id: 'audio-decode',
    converts: [
      {
        from: [
          'audio/mpeg',
          'audio/mp3',
          'audio/mp4',
          'audio/aac',
          'audio/x-m4a',
          'audio/ogg',
          'audio/opus',
          'audio/flac',
          'audio/x-flac',
          'audio/wav',
          'audio/x-wav',
          'audio/wave',
        ],
        to: ['pcm'],
        convert,
      },
    ],
  }
}
