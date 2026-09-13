/**
 * A Node-native image {@link @nhtio/adk/batteries/media/contracts!MediaEngine}
 * backed by sharp (libvips bindings — fast, full-format).
 *
 * @module @nhtio/adk/batteries/media/engines/sharp
 *
 * @remarks
 * The performance/fidelity engine for Node deployments: native speed plus webp/avif output
 * and the full `fit` mode set, plus a generation edge — `EMPTY_MIME` → a blank 1024×1024
 * white canvas in any supported encoding (resize in the same statement). sharp is permanently
 * Node-only (native bindings); for a cross-environment engine compose the jimp implementation
 * instead — the capability declaration is the seam, and BYO instances adapt via
 * {@link fromSharp}.
 *
 * `sharp` is an optional peer dependency, lazily imported on first actual use.
 */

import { EMPTY_MIME } from '../contracts'
import { isError } from '@nhtio/adk/guards'
import { default as SharpDefault } from 'sharp'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type {
  ImageAnnotation,
  MediaEngine,
  MutateCapability,
  MutateRequest,
  EngineBytesResult,
  ConvertCapability,
  ConvertRequest,
  ConvertResult,
} from '../contracts'

type SharpFn = typeof SharpDefault

/** Options for {@link sharpEngine}. */
export interface SharpEngineOptions {
  /** Override the module resolution (electron/custom builds). Default: `import('sharp')`. */
  sharp?: () => SharpFn | { default: SharpFn } | Promise<SharpFn | { default: SharpFn }>
}

const SUPPORTED_OUTPUT = ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'avif', 'gif'] as const

const MIME_BY_FORMAT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  tiff: 'image/tiff',
  avif: 'image/avif',
  gif: 'image/gif',
}

const resolveSharp = async (supplied: SharpEngineOptions['sharp']): Promise<SharpFn> => {
  try {
    const mod = await (supplied ? supplied() : import('sharp'))
    const fn = typeof mod === 'function' ? mod : (mod as { default: SharpFn }).default
    if (typeof fn !== 'function') throw new Error('sharp did not resolve to a function')
    return fn
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      `the sharp engine could not load its peer dependency "sharp": ${detail} — install it (pnpm add sharp); note sharp is Node-only`,
    ])
  }
}

/** Run a fused mutate request through a sharp instance function. */
const runTransform = async (sharp: SharpFn, request: MutateRequest): Promise<EngineBytesResult> => {
  let img = sharp(request.bytes, { animated: true })

  if (request.annotate) {
    const metadata = await img.metadata()
    const pages = metadata.pages ?? 1
    const width = metadata.width ?? 1
    const height = metadata.pageHeight ?? metadata.height ?? 1
    const esc = (value: string): string =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    const stroke = (shape: ImageAnnotation): string => esc(shape.color ?? '#ff0000')
    const elements = request.annotate
      .map((shape) => {
        switch (shape.type) {
          case 'rect':
            return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${esc(shape.fill ?? 'none')}" stroke="${stroke(shape)}" stroke-width="${shape.strokeWidth ?? 2}"/>`
          case 'line':
            return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="${stroke(shape)}" stroke-width="${shape.strokeWidth ?? 2}"/>`
          case 'arrow': {
            const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1)
            const size = Math.max(shape.strokeWidth ?? 2, 6)
            const left = `${shape.x2 - size * Math.cos(angle - Math.PI / 6)},${shape.y2 - size * Math.sin(angle - Math.PI / 6)}`
            const right = `${shape.x2 - size * Math.cos(angle + Math.PI / 6)},${shape.y2 - size * Math.sin(angle + Math.PI / 6)}`
            return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="${stroke(shape)}" stroke-width="${shape.strokeWidth ?? 2}"/><polygon points="${shape.x2},${shape.y2} ${left} ${right}" fill="${stroke(shape)}"/>`
          }
          case 'ellipse':
            return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" fill="${esc(shape.fill ?? 'none')}" stroke="${stroke(shape)}" stroke-width="${shape.strokeWidth ?? 2}"/>`
          case 'text':
            return `<text x="${shape.x}" y="${shape.y}" fill="${stroke(shape)}" font-size="${shape.size ?? 16}" font-family="${esc(shape.font ?? 'sans-serif')}">${esc(shape.text)}</text>`
        }
      })
      .join('')
    const overlay = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g>${elements}</g></svg>`
    )
    const composites: Array<{
      input: Buffer
      blend: 'over'
      top: number
      left: number
    }> = []
    for (let i = 0; i < pages; i++) {
      composites.push({
        input: overlay,
        blend: 'over',
        top: i * height,
        left: 0,
      })
    }
    img = img.composite(composites)

    // Sharp evaluates operations lazily. If we chain resize or rotate after composite, Sharp
    // applies the resize FIRST, breaking the original-coordinate geometry of the SVG overlay.
    // Force materialization here to apply annotations in original image space before rotating/resizing.
    img = sharp(await img.toBuffer(), { animated: true })
  }

  if (request.rotate) img = img.rotate(request.rotate)
  if (request.flip?.vertical) img = img.flip()
  if (request.flip?.horizontal) img = img.flop()

  if (
    request.resize &&
    (request.resize.width !== undefined || request.resize.height !== undefined)
  ) {
    img = img.resize({
      width: request.resize.width,
      height: request.resize.height,
      fit: request.resize.fit ?? 'cover',
    })
  }
  const target = request.format?.to ?? mimeToFormat(request.mimeType)
  const mimeType = MIME_BY_FORMAT[target]
  if (!mimeType) {
    throw new Error(`sharp cannot encode "${target}"; supported: ${SUPPORTED_OUTPUT.join(', ')}`)
  }
  const formatKey = (target === 'jpg' ? 'jpeg' : target) as
    | 'png'
    | 'jpeg'
    | 'webp'
    | 'tiff'
    | 'avif'
    | 'gif'
  img = img.toFormat(
    formatKey,
    request.format?.quality !== undefined ? { quality: request.format.quality } : {}
  )
  if (request.stripMetadata !== true) {
    // sharp strips metadata by default; keep it when NOT asked to strip.
    img = img.keepMetadata()
  }
  const buffer = await img.toBuffer()
  return { bytes: new Uint8Array(buffer), mimeType }
}

/** Build the single mutate capability over a sharp source. */
const capabilityOf = (
  run: (request: MutateRequest) => Promise<EngineBytesResult>
): MutateCapability => ({
  over: ['image/*'],
  ops: ['resize', 'rotate', 'flip', 'strip_metadata', 'annotate'],
  encodes: SUPPORTED_OUTPUT,
  mutate: run,
})

/**
 * Build the generation capability over a sharp source: `EMPTY_MIME` → a blank 1024×1024
 * white canvas (3 channels, so jpeg never trips on alpha) in any supported encoding.
 */
const blankCapability = (getSharp: () => Promise<SharpFn>): ConvertCapability => ({
  from: [EMPTY_MIME],
  to: SUPPORTED_OUTPUT,
  convert: async (request: ConvertRequest): Promise<ConvertResult> => {
    const mimeType = MIME_BY_FORMAT[request.to]
    if (!mimeType) {
      throw new Error(
        `sharp cannot generate "${request.to}"; supported: ${SUPPORTED_OUTPUT.join(', ')}`
      )
    }
    const sharp = await getSharp()
    const formatKey = (request.to === 'jpg' ? 'jpeg' : request.to) as
      | 'png'
      | 'jpeg'
      | 'webp'
      | 'tiff'
      | 'avif'
      | 'gif'
    const buffer = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .toFormat(formatKey)
      .toBuffer()
    return { outputs: [{ bytes: new Uint8Array(buffer), mimeType }] }
  },
})

/**
 * Construct the sharp-backed image engine.
 *
 * @param options - Optional module resolver override.
 * @returns The engine.
 */
export const sharpEngine = (options: SharpEngineOptions = {}): MediaEngine => {
  let sharpPromise: Promise<SharpFn> | undefined
  const getSharp = (): Promise<SharpFn> => {
    sharpPromise ??= resolveSharp(options.sharp)
    return sharpPromise
  }
  return {
    id: 'sharp',
    converts: [blankCapability(getSharp)],
    mutates: [capabilityOf(async (request) => runTransform(await getSharp(), request))],
  }
}

/**
 * Adapt an already-configured sharp module (your import, your build flags) to the engine
 * contract — the BYO transformer.
 *
 * @param sharp - The sharp function you imported.
 * @returns The engine.
 */
export const fromSharp = (sharp: SharpFn): MediaEngine => ({
  id: 'sharp',
  converts: [blankCapability(async () => sharp)],
  mutates: [capabilityOf(async (request) => runTransform(sharp, request))],
})

const mimeToFormat = (mimeType: string): string => {
  const sub = mimeType.toLowerCase().split(';')[0].trim().split('/')[1] ?? 'png'
  return sub === 'jpeg' ? 'jpg' : sub
}
