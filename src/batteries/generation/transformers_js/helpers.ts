/**
 * Env-branched PNG-encoding helper for transformers.js Generation's `RawImage` results.
 *
 * @module @nhtio/adk/batteries/generation/transformers_js/helpers
 *
 * @remarks
 * `generate_images()` resolves an array of `RawImage` instances (raw decoded pixel data, not encoded
 * bytes). Encoding those to PNG is environment-branched in the installed `@huggingface/transformers`
 * source (`src/utils/image.js`): browser/web-worker → `await img.toBlob('image/png')` (throws outside
 * a web env); Node/other → `img.toSharp().png().toBuffer()` (its `toSharp()` throws *inside* a web
 * env). Mirrors `RawImage.save()`'s own branch (`apis.IS_WEB_ENV` there) — but this module cannot
 * import `apis` itself: `@huggingface/transformers`'s package root only re-exports `env`/`LogLevel`
 * from `env.js` (verified against `src/transformers.js`'s export list), not `apis`. A local,
 * structurally-equivalent environment check (`typeof window !== 'undefined' && typeof
 * window.document !== 'undefined'`, matching `IS_BROWSER_ENV`'s own definition in `env.js`) stands in
 * for it, with a try/catch fallback to the other branch as a safety net for exotic runtimes (e.g. a
 * web worker, which has no `window` but is still a "web env" per `apis.IS_WEB_ENV`).
 */

const isBrowserLikeEnv = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as { document?: unknown }).document !== 'undefined'

/** The exact `toBlob`/`toSharp` surface this helper reads off a resolved `RawImage`-like value. */
export interface RawImageLike {
  /** Browser-only: encodes the image to a `Blob` of the given MIME type. Throws outside a web env. */
  toBlob?: (type?: string, quality?: number) => Promise<Blob>
  /** Node-only: wraps the raw pixel data in a `sharp.Sharp` instance. Throws inside a web env. */
  toSharp?: () => { png: () => { toBuffer: () => Promise<Buffer> } }
}

const viaBlob = async (image: RawImageLike): Promise<Uint8Array> => {
  const blob = await image.toBlob!('image/png')
  const buf = await blob.arrayBuffer()
  return new Uint8Array(buf)
}

const viaSharp = async (image: RawImageLike): Promise<Uint8Array> => {
  const buf = await image.toSharp!().png().toBuffer()
  return new Uint8Array(buf)
}

/**
 * Encodes a resolved `RawImage`-like value to PNG bytes.
 *
 * @remarks
 * When `encodeImage` is supplied it takes over entirely — the primary hermetic-test seam, since a
 * fake `RawImage` double need not implement `toBlob`/`toSharp` at all. Otherwise this picks the
 * browser (`toBlob`) or Node (`toSharp`) path by a local environment probe, falling back to whichever
 * method is actually present on `image` if the probe disagrees with reality (e.g. a web worker with
 * neither `window` nor `document`, but a `toBlob`-only `RawImage`).
 *
 * @param image - The `RawImage`-like value to encode (one element of `generate_images()`'s result).
 * @param encodeImage - Optional override that fully replaces the env-branch.
 * @returns The encoded PNG bytes.
 */
export const rawImageToEncodedBytes = async (
  image: RawImageLike,
  encodeImage?: (image: RawImageLike) => Promise<Uint8Array>
): Promise<Uint8Array> => {
  if (encodeImage) return encodeImage(image)
  if (isBrowserLikeEnv()) {
    if (typeof image.toBlob === 'function') return viaBlob(image)
    if (typeof image.toSharp === 'function') return viaSharp(image)
  } else {
    if (typeof image.toSharp === 'function') return viaSharp(image)
    if (typeof image.toBlob === 'function') return viaBlob(image)
  }
  throw new Error(
    'the resolved image exposes neither toBlob() nor toSharp() — cannot encode PNG bytes'
  )
}
