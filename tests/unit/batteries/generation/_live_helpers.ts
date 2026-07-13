/**
 * Shared helpers for the WP-3 LIVE gated generation specs (`openai/live.cross.spec.ts` and
 * `gemini/live.cross.spec.ts`).
 *
 * @remarks
 * Not itself a spec file — a plain helper module imported by both. Kept tiny and dependency-free
 * so it collects cleanly under both the `node` and `browser` vitest projects (the `.cross.spec.ts`
 * files that import it are collected by both; this module must not assume `process` exists at
 * import time — only inside {@link envFor}'s own guard).
 */

/** The env-derived live-gating info for one generation engine, or `undefined` when un-gated. */
export interface LiveGenerationEnv {
  /** The API key / bearer token read from `${prefix}_API_KEY`. */
  apiKey: string
  /** The optional base URL read from `${prefix}_BASE_URL`, or `undefined` when blank. */
  baseURL: string | undefined
  /** The model id read from `${prefix}_MODEL`, falling back to `defaultModel` when blank. */
  model: string
}

/**
 * Reads the `{prefix}_API_KEY` / `{prefix}_BASE_URL` / `{prefix}_MODEL` env vars guardedly.
 *
 * @remarks
 * Returns `undefined` — the live-gating signal `describe.skipIf` keys off of — whenever
 * `process` doesn't exist (a browser-project run of a `.cross.spec.ts` file) or the API key is
 * blank (the default in CI, per `.env.test.example`). Never throws.
 *
 * @param prefix - The env var prefix, e.g. `'TEST_GENERATION_OPENAI'`.
 * @param defaultModel - The model id to fall back to when `{prefix}_MODEL` is blank.
 */
export const envFor = (prefix: string, defaultModel: string): LiveGenerationEnv | undefined => {
  if (typeof process === 'undefined') return undefined
  const apiKey = process.env?.[`${prefix}_API_KEY`]
  if (!apiKey) return undefined
  return {
    apiKey,
    baseURL: process.env?.[`${prefix}_BASE_URL`] || undefined,
    model: process.env?.[`${prefix}_MODEL`] || defaultModel,
  }
}

/**
 * Checks a decoded image's leading bytes against the magic-byte signature implied by `mimeType`.
 *
 * @remarks
 * Covers the three encodings the bundled generation batteries can plausibly return: PNG, JPEG,
 * and WebP (a RIFF container tagged `WEBP` at offset 8). Unknown/unhandled MIME types return
 * `false` rather than throwing, so a live spec assertion failure reads as "wrong bytes" rather
 * than an unrelated crash.
 *
 * @param mimeType - The output's declared MIME type (e.g. `'image/png'`).
 * @param bytes - The decoded image bytes.
 */
export const magicMatches = (mimeType: string, bytes: Uint8Array): boolean => {
  const mt = mimeType.toLowerCase()
  if (mt.includes('png')) {
    const PNG = [0x89, 0x50, 0x4e, 0x47]
    return PNG.every((b, i) => bytes[i] === b)
  }
  if (mt.includes('jpeg') || mt.includes('jpg')) {
    const JPEG = [0xff, 0xd8, 0xff]
    return JPEG.every((b, i) => bytes[i] === b)
  }
  if (mt.includes('webp')) {
    const RIFF = [0x52, 0x49, 0x46, 0x46]
    const WEBP = [0x57, 0x45, 0x42, 0x50]
    return RIFF.every((b, i) => bytes[i] === b) && WEBP.every((b, i) => bytes[i + 8] === b)
  }
  return false
}
