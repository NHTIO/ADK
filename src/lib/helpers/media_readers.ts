import type { MediaReader } from '../contracts/media_reader'

/**
 * Constructs a {@link @nhtio/adk!MediaReader} backed by an in-memory `Uint8Array`.
 *
 * @remarks
 * Each `stream()` call returns a fresh single-chunk `ReadableStream` over the same buffer. The
 * reader is re-openable by construction — call `stream()` as many times as needed.
 *
 * @param bytes - The buffer to serve.
 * @returns A {@link @nhtio/adk!MediaReader} that re-reads `bytes` on every call.
 */
export const inMemoryMediaReader = (bytes: Uint8Array): MediaReader => {
  return {
    stream(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    },
    byteLength(): number {
      return bytes.byteLength
    },
  }
}

/**
 * Constructs a {@link @nhtio/adk!MediaReader} backed by a fetch call.
 *
 * @remarks
 * Each `stream()` call re-issues the fetch. Tool authors whose underlying source is rate-limited
 * or expensive must cache locally before constructing the reader — the framework cannot make
 * that decision for them.
 *
 * `byteLength()` returns `undefined` because most remote sources do not promise it without an
 * extra HEAD request; consumers that need a byte size should resolve it out-of-band.
 *
 * @param url - The URL to fetch on each call.
 * @param init - Optional `fetch` init forwarded verbatim.
 * @returns A {@link @nhtio/adk!MediaReader} that re-issues `fetch(url, init)` on every call.
 */
export const fromFetch = (url: string | URL, init?: RequestInit): MediaReader => {
  return {
    async stream(): Promise<ReadableStream<Uint8Array>> {
      const response = await fetch(url, init)
      if (!response.ok) {
        throw new Error(`fromFetch: fetch failed with status ${response.status}`)
      }
      if (!response.body) {
        throw new Error('fromFetch: response has no body')
      }
      return response.body as ReadableStream<Uint8Array>
    },
    byteLength(): undefined {
      return undefined
    },
  }
}

/**
 * Constructs a {@link @nhtio/adk!MediaReader} backed by a browser `File` or `Blob`.
 *
 * @remarks
 * Each `stream()` call re-streams the underlying File via `File.stream()`. `byteLength()`
 * resolves from `file.size`.
 *
 * @param file - The browser `File` or `Blob` to stream.
 * @returns A {@link @nhtio/adk!MediaReader} that re-streams `file` on every call.
 */
export const fromWebFile = (file: Blob): MediaReader => {
  return {
    stream(): ReadableStream<Uint8Array> {
      return file.stream() as ReadableStream<Uint8Array>
    },
    byteLength(): number {
      return file.size
    },
  }
}
