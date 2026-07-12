/**
 * transformers.js (ONNX, dual-environment) STT (speech-to-text) adapter battery.
 *
 * @remarks
 * Specialist battery backed by transformers.js's `automatic-speech-recognition` (Whisper-family)
 * pipeline. **Environment-neutral** — runs in Node (via `onnxruntime-node`) and the browser (via
 * `onnxruntime-web` / WebGPU), auto-selected by the package; there is no WebGPU requirement, mirroring
 * the transformers.js Embeddings battery this adapter is modeled on.
 *
 * Accepts any {@link @nhtio/adk/batteries/specialists/_shared!SpecialistAudioInput} form: already-
 * decoded mono PCM (skips decoding), or an encoded container (bytes / bytes+mime / a duck-typed
 * `Media`) decoded via an injectable {@link DecodeAudioFn}. Either path is resampled to the 16 kHz mono
 * PCM Whisper expects before the pipeline call.
 *
 * `@huggingface/transformers` is an optional peer dependency, imported lazily.
 */

import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { resampleTo } from '../../../../lib/utils/audio'
import { emitLifecycle } from '../../../llm/chat_common/lifecycle'
import { isPcmInput, toBytes, defaultDecodeAudio } from '../../_shared'
import { withModelSource } from '../../../llm/transformers_js/model_source'
import {
  E_INVALID_TRANSFORMERS_JS_STT_OPTIONS,
  E_TRANSFORMERS_JS_STT_ENGINE_ERROR,
} from './exceptions'
import type { SpecialistAudioInput } from '../../_shared'
import type {
  TransformersJsSttAdapterOptions,
  TransformersJsSttPipeline,
  CreateTransformersJsSttPipeline,
  TranscribeOptions,
  TranscribeResult,
  SttSegment,
} from './types'

/** The shape the transformers.js ASR pipeline resolves to (a subset of its documented output). */
interface AsrChunk {
  /** `[start, end]` in seconds; `end` may be `null` when the engine cannot bound the chunk. */
  timestamp: [number, number | null]
  /** The chunk's recognized text. */
  text: string
}

interface AsrPipelineOutput {
  text: string
  chunks?: AsrChunk[]
}

const makeDefaultCreatePipeline = (
  modelSource: TransformersJsSttAdapterOptions['modelSource']
): CreateTransformersJsSttPipeline => {
  return async ({ model, device, dtype, onInitProgress }) => {
    const transformers = await import('@huggingface/transformers')
    const { pipeline, env } = transformers
    const load = async () =>
      (await pipeline('automatic-speech-recognition', model, {
        ...(device ? { device } : {}),
        ...(dtype ? { dtype } : {}),
        ...(onInitProgress ? { progress_callback: onInitProgress } : {}),
      } as never)) as unknown as TransformersJsSttPipeline
    // When a custom model source is configured, serve files through it behind the global-`env` mutex.
    return modelSource ? withModelSource(env as never, modelSource, load) : load()
  }
}

/**
 * STT adapter for transformers.js's automatic-speech-recognition (Whisper-family) pipeline.
 *
 * @remarks
 * Reusable: construct once, call {@link TransformersJsSttAdapter.transcribe} as many times as needed.
 * The pipeline is resolved lazily on first use (or via {@link preload}) and cached with single-flight
 * semantics so concurrent calls share one load.
 */
export class TransformersJsSttAdapter {
  readonly #options: TransformersJsSttAdapterOptions
  #pipeline: TransformersJsSttPipeline | undefined
  #pipelinePromise: Promise<TransformersJsSttPipeline> | undefined

  /**
   * Whether this battery is available. transformers.js is environment-neutral (Node + browser), so
   * this is `true` whenever the runtime can import the peer — there is no WebGPU requirement.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries!E_INVALID_TRANSFORMERS_JS_STT_OPTIONS} when invalid.
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
    this.#pipeline = this.#options.pipeline
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? TransformersJsSttAdapter.isAvailable)()
  }

  /** Eagerly loads (and caches) the pipeline so the first `transcribe` call is fast. Idempotent. */
  async preload(): Promise<void> {
    await this.#resolvePipeline()
  }

  /** Drops the cached pipeline and in-flight load so the next call reloads. */
  reset(): void {
    this.#pipeline = undefined
    this.#pipelinePromise = undefined
  }

  /**
   * Release the loaded model's ONNX sessions + GPU/wasm buffers, then drop the cached pipeline.
   *
   * @remarks
   * `reset()` only nulls the JS reference; the native ONNX Runtime sessions and WebGPU/wasm device
   * memory stay alive until GC. `AutomaticSpeechRecognitionPipeline` extends `Pipeline`, which exposes
   * `dispose()` — this awaits it so the memory is reclaimed between loads, swallows a disposal error
   * (teardown must not throw), and finishes with `reset()`. Idempotent.
   */
  async dispose(): Promise<void> {
    const pipeline = this.#pipeline ?? (await this.#pipelinePromise?.catch(() => undefined))
    const pipeWithDispose = pipeline as { dispose?: () => Promise<unknown> } | undefined
    if (typeof pipeWithDispose?.dispose === 'function') {
      await Promise.resolve(pipeWithDispose.dispose()).catch(() => undefined)
    }
    this.reset()
  }

  async #resolvePipeline(): Promise<TransformersJsSttPipeline> {
    if (this.#pipeline) return this.#pipeline
    if (!this.isAvailable()) {
      throw new E_INVALID_TRANSFORMERS_JS_STT_OPTIONS([
        'the transformers.js STT battery is not available in this runtime',
      ])
    }
    const opts = this.#options
    this.#pipelinePromise ??= (async () => {
      emitLifecycle(opts, 'transformers_js_stt', opts.model, 'loading', {
        detail: 'loading automatic-speech-recognition pipeline',
      })
      // Forward each provider download event into a normalized `loading` lifecycle report.
      const hasLifecycle =
        opts.onLifecycle ?? opts.onLoading ?? opts.onReady ?? opts.onGenerating ?? opts.onError
      const forwardedInitProgress = hasLifecycle
        ? (info: unknown) => {
            const p = (info as { progress?: number } | undefined)?.progress
            emitLifecycle(opts, 'transformers_js_stt', opts.model, 'loading', {
              ...(typeof p === 'number' ? { progress: p / 100 } : {}),
              raw: info,
            })
            opts.onInitProgress?.(info as never)
          }
        : opts.onInitProgress
      const createPipeline = opts.createPipeline ?? makeDefaultCreatePipeline(opts.modelSource)
      try {
        // `from_pretrained` covers both fetch (reported via progress_callback → `loading`) and the
        // ONNX-graph / WebGPU-WASM warmup. Mark the latter as `compiling` — a COARSE upper-bound marker
        // (fetch + compile overlap inside the call), consistent with the LLM/embeddings batteries.
        emitLifecycle(opts, 'transformers_js_stt', opts.model, 'compiling', {
          detail: 'compiling automatic-speech-recognition graph',
        })
        const pipe = await createPipeline({
          model: opts.model,
          device: opts.device,
          dtype: opts.dtype,
          onInitProgress: forwardedInitProgress,
        })
        this.#pipeline = pipe
        emitLifecycle(opts, 'transformers_js_stt', opts.model, 'ready', {
          detail: 'automatic-speech-recognition pipeline ready',
        })
        return pipe
      } catch (err) {
        this.#pipelinePromise = undefined
        emitLifecycle(opts, 'transformers_js_stt', opts.model, 'error', { error: err })
        throw new E_TRANSFORMERS_JS_STT_ENGINE_ERROR([
          `could not load the transformers.js pipeline: ${isError(err) ? err.message : String(err)} — install the peer dependency (pnpm add @huggingface/transformers)`,
        ])
      }
    })()
    return this.#pipelinePromise
  }

  /**
   * Normalizes any accepted audio input form to 16 kHz mono PCM, the shape the Whisper pipeline
   * expects.
   *
   * @remarks
   * Already-decoded {@link @nhtio/adk/batteries/specialists/_shared!SpecialistPcmInput} is resampled
   * directly (a no-op when already 16 kHz — {@link resampleTo} returns the same reference in that
   * case). Any encoded-container form is normalized to bytes via
   * {@link @nhtio/adk/batteries/specialists/_shared!toBytes}, decoded via the injected/default
   * {@link @nhtio/adk/batteries/specialists/_shared!DecodeAudioFn} (already mono per that seam's
   * contract), then resampled.
   *
   * @param input - The audio input in any accepted form.
   * @returns 16 kHz mono PCM samples.
   */
  async #toPcm16k(input: SpecialistAudioInput): Promise<Float32Array> {
    if (isPcmInput(input)) {
      return resampleTo(input.pcm, input.sampleRate, 16000)
    }
    const { bytes } = await toBytes(input)
    const decode = this.#options.decodeAudio ?? defaultDecodeAudio
    const decoded = await decode(bytes)
    return resampleTo(decoded.pcm, decoded.sampleRate, 16000)
  }

  /**
   * Transcribes an audio clip.
   *
   * @param input - The audio input, in any {@link @nhtio/adk/batteries/specialists/_shared!SpecialistAudioInput}
   *   form (pre-decoded PCM or an encoded container).
   * @param opts - Per-call transcription options (language / translate / timestamps).
   * @returns The recognized text, plus per-segment timing when `opts.timestamps` was set.
   * @throws {@link @nhtio/adk/batteries!E_TRANSFORMERS_JS_STT_ENGINE_ERROR} when the pipeline fails to
   *   load or the transcription call fails.
   */
  async transcribe(
    input: SpecialistAudioInput,
    opts?: TranscribeOptions
  ): Promise<TranscribeResult> {
    const pcm = await this.#toPcm16k(input)
    const pipe = await this.#resolvePipeline()
    const chunkLengthS = this.#options.chunkLengthS ?? 30

    emitLifecycle(this.#options, 'transformers_js_stt', this.#options.model, 'generating')

    let output: AsrPipelineOutput
    try {
      const result = await (
        pipe as unknown as (
          audio: Float32Array,
          options: Record<string, unknown>
        ) => Promise<AsrPipelineOutput | AsrPipelineOutput[]>
      )(pcm, {
        chunk_length_s: chunkLengthS,
        ...(opts?.language ? { language: opts.language } : {}),
        ...(opts?.translate ? { task: 'translate' } : {}),
        ...(opts?.timestamps ? { return_timestamps: true } : {}),
      })
      output = Array.isArray(result) ? result[0] : result
    } catch (err) {
      emitLifecycle(this.#options, 'transformers_js_stt', this.#options.model, 'error', {
        error: err,
      })
      throw new E_TRANSFORMERS_JS_STT_ENGINE_ERROR([isError(err) ? err.message : String(err)])
    }

    if (!output || typeof output.text !== 'string') {
      emitLifecycle(this.#options, 'transformers_js_stt', this.#options.model, 'error', {
        error: new Error('automatic-speech-recognition returned a malformed result'),
      })
      throw new E_TRANSFORMERS_JS_STT_ENGINE_ERROR([
        'automatic-speech-recognition returned a malformed result',
      ])
    }

    let segments: SttSegment[] | undefined
    if (opts?.timestamps && Array.isArray(output.chunks)) {
      segments = output.chunks.map((chunk) => ({
        start: chunk.timestamp[0],
        end: chunk.timestamp[1] ?? null,
        text: chunk.text,
      }))
    }

    emitLifecycle(this.#options, 'transformers_js_stt', this.#options.model, 'complete')
    return segments ? { text: output.text, segments } : { text: output.text }
  }
}
