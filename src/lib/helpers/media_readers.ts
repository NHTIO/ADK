import { encodeBase64 } from './base64'
import { isInstanceOf } from '../utils/guards'
import type { MediaReader } from '../contracts/media_reader'

/**
 * Resolver tag for the in-memory media reader handle. The locator inlines the bytes as base64 because an
 * in-memory reader owns its buffer outright — there is no external store to point at.
 */
export const MEDIA_READER_TAG_IN_MEMORY = 'media:in-memory'

/**
 * Resolver tag for the fetch-backed media reader handle. The locator captures the URL (and any fetch
 * init) so decode can re-issue the request — no live binding to re-inject.
 */
export const MEDIA_READER_TAG_FETCH = 'media:fetch'

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
    describe() {
      // The buffer IS the backing store — inline it as base64, no external locator exists.
      return { tag: MEDIA_READER_TAG_IN_MEMORY, locator: { bytesBase64: encodeBase64(bytes) } }
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
    describe() {
      // The URL is the re-openable locator; decode re-issues fetch(url, init). Only JSON-expressible
      // init is captured (method/headers) — a streaming/AbortSignal init cannot survive serialisation
      // and is dropped, which is correct: a re-issued fetch on decode starts fresh.
      const locator: { url: string; init?: { method?: string; headers?: Record<string, string> } } =
        {
          url: typeof url === 'string' ? url : url.toString(),
        }
      if (init) {
        const captured: { method?: string; headers?: Record<string, string> } = {}
        if (typeof init.method === 'string') captured.method = init.method
        if (
          init.headers &&
          !isInstanceOf(init.headers, 'Headers', Headers) &&
          !Array.isArray(init.headers)
        ) {
          captured.headers = { ...(init.headers as Record<string, string>) }
        }
        if (Object.keys(captured).length > 0) locator.init = captured
      }
      return { tag: MEDIA_READER_TAG_FETCH, locator }
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
 * @remarks
 * **Not describable / not encodable.** A browser `Blob` is not re-openable across a serialisation
 * boundary (it has no stable locator), and draining its bytes requires `await` — which the encoder's
 * synchronous `[ENCODE_METHOD]()` cannot do. So this reader intentionally omits `describe()`, and
 * `encode()`-ing a {@link @nhtio/adk!Media} backed by it throws {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE}.
 * To serialise such media, persist the bytes to a media/spool store and wrap them in a describable
 * reader first.
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
