/**
 * A cross-environment OCR {@link @nhtio/adk/batteries/media/contracts!MediaEngine}
 * backed by tesseract.js (WASM Tesseract — Node and browsers, no binary).
 *
 * @module @nhtio/adk/batteries/media/engines/tesseract_js
 *
 * @remarks
 * The local-by-default OCR engine. Language data files download on first use of each
 * language; point `langPath`/`cachePath` at a writable location to control where (the
 * factory requires `languages` up front so a deployment never silently fetches packs for
 * languages it didn't plan for). Workers are created per recognize call and terminated in
 * `finally` — slower than a pooled setup but leak-free by construction; consumers who need
 * pooling can BYO an engine that holds a worker.
 *
 * `tesseract.js` is an optional peer dependency, lazily imported on first actual use.
 *
 * Declares one convert capability: `image/*` to `txt`/`hocr`/`json` (OCR is a format
 * conversion — image in, text out). Language hints ride `request.options.languages`.
 */

import { isError } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type * as TesseractNS from 'tesseract.js'
import type { MediaEngine, ConvertRequest, ConvertResult } from '../contracts'

type TesseractModule = typeof TesseractNS

/** Options for {@link tesseractJsEngine}. */
export interface TesseractJsEngineOptions {
  /** Languages to load, e.g. `['eng']`. REQUIRED — language packs download on first use. */
  languages: readonly string[]
  /** Where language data is fetched from / cached (forwarded to createWorker). */
  langPath?: string
  /** Local cache directory for downloaded language data. */
  cachePath?: string
  /** Override the module resolution. Default: `import('tesseract.js')`. */
  tesseract?: () => TesseractModule | Promise<TesseractModule>
}

/**
 * Construct the tesseract.js OCR engine.
 *
 * @param options - Languages (required) and data-path overrides.
 * @returns The engine.
 */
export const tesseractJsEngine = (options: TesseractJsEngineOptions): MediaEngine => {
  if (!Array.isArray(options?.languages) || options.languages.length === 0) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      'tesseractJsEngine requires languages (e.g. ["eng"]) — language packs download on first use and are never chosen silently',
    ])
  }
  let modPromise: Promise<TesseractModule> | undefined
  const getModule = (): Promise<TesseractModule> => {
    modPromise ??= Promise.resolve(
      options.tesseract ? options.tesseract() : import('tesseract.js')
    ).catch((err) => {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `the tesseract.js engine could not load its peer dependency "tesseract.js": ${detail} — install it (pnpm add tesseract.js)`,
      ])
    })
    return modPromise
  }

  const convert = async (request: ConvertRequest): Promise<ConvertResult> => {
    const mod = await getModule()
    const languages = (request.options?.languages ?? options.languages) as string[]
    const worker = await mod.createWorker(languages, undefined, {
      ...(options.langPath ? { langPath: options.langPath } : {}),
      ...(options.cachePath ? { cachePath: options.cachePath } : {}),
    })
    try {
      const result = await worker.recognize(
        // tesseract.js accepts Buffer/Blob/ImageLike; raw bytes work via Buffer in Node
        typeof globalThis.Buffer !== 'undefined'
          ? globalThis.Buffer.from(
              request.bytes.buffer,
              request.bytes.byteOffset,
              request.bytes.byteLength
            )
          : new Blob([request.bytes as BlobPart], { type: request.mimeType })
      )
      let text = result.data.text
      let mimeType = 'text/plain'
      if (request.to === 'json') {
        text = JSON.stringify({ text: result.data.text, confidence: result.data.confidence })
        mimeType = 'application/json'
      } else if (request.to === 'hocr') {
        // hocr requires opting into the output at recognize time in tesseract.js v5+;
        // fall back to text when unavailable rather than failing the read.
        const hocr = (result.data as { hocr?: string | null }).hocr
        text = hocr ?? result.data.text
        mimeType = hocr ? 'text/html' : 'text/plain'
      }
      return { outputs: [{ bytes: new TextEncoder().encode(text), mimeType }] }
    } finally {
      await worker.terminate()
    }
  }

  return {
    id: 'tesseract.js',
    converts: [
      {
        from: ['image/*'],
        to: ['txt', 'hocr', 'json'],
        convert,
      },
    ],
  }
}
