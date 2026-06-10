/**
 * A cross-environment transcription {@link @nhtio/adk/batteries/media/contracts!MediaEngine}
 * backed by `@huggingface/transformers` Whisper (ONNX in Node, WASM/WebGPU in browsers).
 *
 * @module @nhtio/adk/batteries/media/engines/transformers_asr
 *
 * @remarks
 * The local-by-default speech-to-text engine: no external API, no binary. Declares one
 * convert capability: the virtual `pcm` token to `txt`/`srt`/`vtt`/`json` (transcription is a
 * format conversion — PCM in, text out). The Whisper model id is REQUIRED — models are
 * multi-hundred-megabyte downloads on first use and the battery never triggers one silently
 * (the loud-config rule). Input is 16 kHz mono PCM, exactly what the transcribe step
 * supplies; `lang`/`translate` ride `request.options`. `srt`/`vtt` output is assembled from
 * chunk timestamps; `json` returns the chunk structure verbatim.
 *
 * `@huggingface/transformers` is an optional peer dependency, lazily imported on first
 * actual use.
 */

import { isError } from '@nhtio/adk/guards'
import { bytesToPcm, PCM_MIME } from '../contracts'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type * as TransformersNS from '@huggingface/transformers'
import type { MediaEngine, ConvertRequest, ConvertResult } from '../contracts'

type TransformersModule = typeof TransformersNS

interface AsrChunk {
  timestamp: [number, number | null]
  text: string
}

interface AsrPipelineOutput {
  text: string
  chunks?: AsrChunk[]
}

type AsrPipelineFn = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<AsrPipelineOutput | AsrPipelineOutput[]>

/** Options for {@link transformersAsrEngine}. */
export interface TransformersAsrEngineOptions {
  /**
   * The Whisper model id, e.g. `onnx-community/whisper-base`. REQUIRED — no default, no
   * surprise downloads.
   */
  model: string
  /** Override the module resolution. Default: `import('@huggingface/transformers')`. */
  transformers?: () => TransformersModule | Promise<TransformersModule>
  /** Extra options forwarded to `pipeline()` (device, dtype, cache_dir…). */
  pipelineOptions?: Record<string, unknown>
}

const pad = (n: number, width = 2): string => String(Math.floor(n)).padStart(width, '0')

const formatTimestamp = (seconds: number, separator: ',' | '.'): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${String(ms).padStart(3, '0')}`
}

const toSubtitles = (chunks: AsrChunk[], kind: 'srt' | 'vtt'): string => {
  const sep = kind === 'srt' ? ',' : '.'
  const blocks = chunks.map((chunk, i) => {
    const [start, end] = chunk.timestamp
    const range = `${formatTimestamp(start, sep)} --> ${formatTimestamp(end ?? start, sep)}`
    return kind === 'srt'
      ? `${i + 1}\n${range}\n${chunk.text.trim()}`
      : `${range}\n${chunk.text.trim()}`
  })
  return kind === 'vtt' ? `WEBVTT\n\n${blocks.join('\n\n')}\n` : `${blocks.join('\n\n')}\n`
}

/**
 * Construct the transformers.js Whisper ASR engine.
 *
 * @param options - Model id (required) and overrides.
 * @returns The engine.
 */
export const transformersAsrEngine = (options: TransformersAsrEngineOptions): MediaEngine => {
  if (typeof options?.model !== 'string' || options.model.length === 0) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      'transformersAsrEngine requires an explicit Whisper model id (e.g. onnx-community/whisper-base) — models are large downloads and are never chosen silently',
    ])
  }
  let pipePromise: Promise<AsrPipelineFn> | undefined
  const getPipeline = (): Promise<AsrPipelineFn> => {
    pipePromise ??= (async () => {
      let mod: TransformersModule
      try {
        mod = await (options.transformers
          ? options.transformers()
          : import('@huggingface/transformers'))
      } catch (err) {
        const detail = isError(err) ? err.message : String(err)
        throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
          `the transformers ASR engine could not load its peer dependency "@huggingface/transformers": ${detail} — install it (pnpm add @huggingface/transformers)`,
        ])
      }
      const pipe = await mod.pipeline('automatic-speech-recognition', options.model, {
        ...(options.pipelineOptions ?? {}),
      } as never)
      return pipe as unknown as AsrPipelineFn
    })()
    return pipePromise
  }

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const pipe = await getPipeline()
    const lang = request.options?.lang
    const translate = request.options?.translate
    const wantsTimestamps = request.to === 'srt' || request.to === 'vtt' || request.to === 'json'
    const result = await pipe(bytesToPcm(request.bytes), {
      ...(lang ? { language: lang } : {}),
      ...(translate ? { task: 'translate' } : {}),
      ...(wantsTimestamps ? { return_timestamps: true } : {}),
      chunk_length_s: 30,
    })
    const output = Array.isArray(result) ? result[0] : result
    let text: string
    let mimeType = 'text/plain'
    if (request.to === 'json') {
      text = JSON.stringify({ text: output.text, chunks: output.chunks ?? [] })
      mimeType = 'application/json'
    } else if (request.to === 'srt' || request.to === 'vtt') {
      const chunks = output.chunks ?? [
        { timestamp: [0, null] as [number, null], text: output.text },
      ]
      text = toSubtitles(chunks, request.to)
    } else {
      text = output.text.trim()
    }
    return { outputs: [{ bytes: new TextEncoder().encode(text), mimeType }] }
  }

  return {
    id: 'transformers-asr',
    converts: [
      {
        from: [PCM_MIME],
        to: ['txt', 'srt', 'vtt', 'json'],
        convert,
      },
    ],
  }
}
