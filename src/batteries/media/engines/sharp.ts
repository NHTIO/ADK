/**
 * A Node-native image {@link @nhtio/adk/batteries/media/contracts!MediaEngine}
 * backed by sharp (libvips bindings — fast, full-format).
 *
 * @module @nhtio/adk/batteries/media/engines/sharp
 *
 * @remarks
 * The performance/fidelity engine for Node deployments: native speed plus webp/avif output
 * and the full `fit` mode set. sharp is permanently Node-only (native bindings); for a
 * cross-environment engine compose the jimp implementation instead — the capability
 * declaration is the seam, and BYO instances adapt via {@link fromSharp}.
 *
 * `sharp` is an optional peer dependency, lazily imported on first actual use.
 */

import { isError } from '@nhtio/adk/guards'
import { default as SharpDefault } from 'sharp'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type { MediaEngine, MutateCapability, MutateRequest, EngineBytesResult } from '../contracts'

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
  let img = sharp(request.bytes)
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
  ops: ['resize', 'rotate', 'flip', 'strip_metadata'],
  encodes: SUPPORTED_OUTPUT,
  mutate: run,
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
  mutates: [capabilityOf(async (request) => runTransform(sharp, request))],
})

const mimeToFormat = (mimeType: string): string => {
  const sub = mimeType.toLowerCase().split(';')[0].trim().split('/')[1] ?? 'png'
  return sub === 'jpeg' ? 'jpg' : sub
}
