/**
 * Cross-environment base64 helpers for `Uint8Array` payloads.
 *
 * @module
 *
 * @remarks
 * Used by {@link @nhtio/adk!Media}'s `asBase64()` and by the in-memory reader handle path
 * (`describe()`/resolver), which inlines its buffer as base64 because it owns no external locator. Both
 * directions prefer Node's `Buffer` when present and fall back to `btoa`/`atob` with a chunked window so
 * large buffers do not overflow the call stack.
 */

interface MinimalBuffer {
  from(input: Uint8Array): { toString(enc: string): string }
  from(input: string, enc: string): Uint8Array
}

const getBuffer = (): MinimalBuffer | undefined => {
  return (globalThis as { Buffer?: MinimalBuffer }).Buffer
}

/**
 * Encode a `Uint8Array` as a base64 string.
 *
 * @remarks
 * Prefers `Buffer.from(bytes).toString('base64')` when `globalThis.Buffer` exists; otherwise
 * chunk-encodes through `btoa` with a `0x8000`-byte window to avoid `Maximum call stack size exceeded`
 * on large buffers.
 *
 * @param bytes - The buffer to encode.
 * @returns The base64 representation.
 */
export const encodeBase64 = (bytes: Uint8Array): string => {
  const buffer = getBuffer()
  if (buffer && typeof buffer.from === 'function') {
    return buffer.from(bytes).toString('base64')
  }
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk) as number[])
  }
  return btoa(binary)
}

/**
 * Decode a base64 string back into a `Uint8Array`.
 *
 * @remarks
 * Inverse of {@link encodeBase64}. Prefers `Buffer.from(b64, 'base64')` when `globalThis.Buffer` exists;
 * otherwise decodes through `atob` byte-by-byte.
 *
 * @param b64 - The base64 string to decode.
 * @returns The decoded bytes.
 */
export const decodeBase64 = (b64: string): Uint8Array => {
  const buffer = getBuffer()
  if (buffer && typeof buffer.from === 'function') {
    const decoded = buffer.from(b64, 'base64')
    // `Buffer` is a `Uint8Array` subclass; return a plain view over the same bytes.
    return new Uint8Array(decoded)
  }
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
