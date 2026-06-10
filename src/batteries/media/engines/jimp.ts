/**
 * A cross-environment image {@link @nhtio/adk/batteries/media/contracts!MediaEngine}
 * backed by Jimp (pure JavaScript — no native bindings, no binaries).
 *
 * @module @nhtio/adk/batteries/media/engines/jimp
 *
 * @remarks
 * The local-by-default raster engine: runs anywhere TypeScript runs. Declares one mutate
 * capability over png/jpeg/bmp/gif/tiff with resize (cover/contain approximations), rotate,
 * flip, quality, and metadata stripping (Jimp re-encodes pixels, so EXIF never survives —
 * `strip_metadata` is inherently satisfied). For webp/avif output or native-speed processing,
 * compose a sharp-backed engine instead — the capability declaration is the seam.
 *
 * `jimp` is an optional peer dependency, lazily imported on first actual use (constructing
 * the engine — and therefore the pipeline — never loads it).
 */

import { isError } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type * as JimpNS from 'jimp'
import type { MediaEngine, MutateRequest, EngineBytesResult } from '../contracts'

type JimpModule = typeof JimpNS

/** Options for {@link jimpEngine}. */
export interface JimpEngineOptions {
  /** Override the module resolution (tests / custom builds). Default: `import('jimp')`. */
  jimp?: () => JimpModule | Promise<JimpModule>
}

const SUPPORTED_OUTPUT = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'tiff'] as const

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  gif: 'image/gif',
  tiff: 'image/tiff',
}

/**
 * Construct the Jimp-backed image engine.
 *
 * @param options - Optional module resolver override.
 * @returns The engine.
 */
export const jimpEngine = (options: JimpEngineOptions = {}): MediaEngine => {
  let modPromise: Promise<JimpModule> | undefined
  const getJimp = (): Promise<JimpModule> => {
    modPromise ??= Promise.resolve(options.jimp ? options.jimp() : import('jimp')).catch((err) => {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `the jimp engine could not load its peer dependency "jimp": ${detail} — install it (pnpm add jimp)`,
      ])
    })
    return modPromise
  }

  const mutate = async (request: MutateRequest): Promise<EngineBytesResult> => {
    const { Jimp } = await getJimp()
    const image = await Jimp.read(
      request.bytes.buffer.slice(
        request.bytes.byteOffset,
        request.bytes.byteOffset + request.bytes.byteLength
      ) as ArrayBuffer
    )

    if (request.resize) {
      const { width, height, fit } = request.resize
      if (width !== undefined && height !== undefined) {
        if (fit === 'cover') image.cover({ w: width, h: height })
        else if (fit === 'contain') image.contain({ w: width, h: height })
        else image.resize({ w: width, h: height })
      } else if (width !== undefined) {
        image.resize({ w: width })
      } else if (height !== undefined) {
        image.resize({ h: height })
      }
    }
    if (request.rotate) {
      image.rotate(request.rotate)
    }
    if (request.flip) {
      image.flip({
        horizontal: request.flip.horizontal === true,
        vertical: request.flip.vertical === true,
      })
    }

    const targetFormat = request.format?.to ?? mimeToFormat(request.mimeType)
    const mimeType = MIME_BY_FORMAT[targetFormat]
    if (!mimeType) {
      throw new Error(
        `jimp cannot encode "${targetFormat}"; supported: ${SUPPORTED_OUTPUT.join(', ')} (compose a sharp engine for webp/avif)`
      )
    }
    const quality = request.format?.quality
    const buffer =
      mimeType === 'image/jpeg' && quality !== undefined
        ? await image.getBuffer('image/jpeg', { quality })
        : await image.getBuffer(mimeType as 'image/png')
    return { bytes: new Uint8Array(buffer), mimeType }
  }

  return {
    id: 'jimp',
    mutates: [
      {
        over: ['image/png', 'image/jpeg', 'image/bmp', 'image/gif', 'image/tiff'],
        ops: ['resize', 'rotate', 'flip', 'strip_metadata'],
        encodes: SUPPORTED_OUTPUT,
        mutate,
      },
    ],
  }
}

const mimeToFormat = (mimeType: string): string => {
  const sub = mimeType.toLowerCase().split(';')[0].trim().split('/')[1] ?? 'png'
  return sub === 'jpeg' ? 'jpg' : sub
}
