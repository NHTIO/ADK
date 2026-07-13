/**
 * Cross-environment Gemini media generation adapter battery.
 *
 * @module @nhtio/adk/batteries/generation/gemini/adapter
 *
 * @remarks
 * Opinionated media-generation battery for the native Gemini `generativelanguage` REST surface —
 * `POST /models/{model}:generateContent` — over raw `fetch`. No `@google/genai` SDK dependency, so
 * it runs unchanged in Node, the browser, edge runtimes, and workers.
 *
 * Construction validates options eagerly via
 * {@link @nhtio/adk/batteries/generation/gemini/validation!validateOptions} and throws
 * {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_INVALID_GEMINI_GENERATION_OPTIONS} on
 * failure — config bugs fail loud, not at generate/edit time.
 */

import { toBytes } from '../_shared'
import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { decodeBase64, encodeBase64 } from '../../../lib/helpers/base64'
import { computeBackoff, sleepWithJitter, parseRetryAfter } from '../../../lib/utils/retry'
import {
  E_GEMINI_GENERATION_HTTP_ERROR,
  E_GEMINI_GENERATION_REQUEST_TIMEOUT,
  E_GEMINI_GENERATION_MALFORMED_RESPONSE,
} from './exceptions'
import type { GenerationImageInput } from '../_shared'
import type {
  GenerationRetryConfig,
  GeneratedMediaOutput,
  GeminiGenerationAdapterOptions,
  GeminiGenerateOptions,
  GeminiEditOptions,
  GeminiRequestPart,
  GeminiGenerateContentRequestBody,
  GeminiGenerateContentResponse,
  GeminiResponsePart,
} from './types'

// ─── Wire helpers ──────────────────────────────────────────────────────────────

/** Default request base URL — probe-confirmed `generateContent` surface. */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** Derives a filename extension from a MIME type (e.g. `'image/jpeg'` → `'jpg'`). */
const extensionFromMimeType = (mimeType: string): string =>
  mimeType.toLowerCase().split(';')[0].trim().split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'

/** Reads the `inlineData`/`inline_data` payload off a response part, tolerating both casings. */
const inlineDataOf = (
  part: GeminiResponsePart
): { mimeType?: string; data: string } | undefined => {
  if ('inlineData' in part && part.inlineData) return part.inlineData
  if ('inline_data' in part && part.inline_data) return part.inline_data
  return undefined
}

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Media generation adapter for the native Gemini `generativelanguage` `generateContent` wire
 * shape.
 *
 * @remarks
 * Reusable: construct once, call {@link GeminiGenerationAdapter.generate} /
 * {@link GeminiGenerationAdapter.edit} as many times as needed.
 */
export class GeminiGenerationAdapter {
  readonly #options: GeminiGenerationAdapterOptions

  /**
   * Whether this battery can run in the current environment. For the HTTP-backed Gemini battery
   * this is always `true` (a `fetch` is always resolvable); present for surface-parity with
   * WebGPU-gated batteries.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_INVALID_GEMINI_GENERATION_OPTIONS} when `options` does not satisfy
   *   {@link @nhtio/adk/batteries/generation/gemini/validation!geminiGenerationOptionsSchema} (e.g. missing `model`).
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
  }

  /** See {@link GeminiGenerationAdapter.isAvailable}. Instance alias for surface-parity. */
  isAvailable(): boolean {
    return GeminiGenerationAdapter.isAvailable()
  }

  /**
   * No-op warm-up. The Gemini battery has no engine to preload; present for surface-parity with
   * on-device generation batteries so callers can treat them interchangeably.
   */
  async preload(): Promise<void> {
    // intentionally empty — nothing to warm for an HTTP-backed battery
  }

  /**
   * No-op state reset. Present for surface-parity with on-device generation batteries.
   */
  reset(): void {
    // intentionally empty — the Gemini battery holds no engine state
  }

  /**
   * Generates one or more images from a text prompt.
   *
   * @param prompt - The text prompt describing the desired image(s).
   * @param opts - Per-call options (`n`, `aspectRatio`), each falling back to the adapter's
   *   configured default when applicable.
   * @returns One {@link GeneratedMediaOutput} per generated image part in the response.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_GEMINI_GENERATION_HTTP_ERROR} on a non-2xx response or transport failure.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_GEMINI_GENERATION_REQUEST_TIMEOUT} when the handshake exceeds `requestTimeoutMs`.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_GEMINI_GENERATION_MALFORMED_RESPONSE} when the 2xx body is not the expected shape, or contains zero image parts.
   */
  async generate(prompt: string, opts?: GeminiGenerateOptions): Promise<GeneratedMediaOutput[]> {
    const parts: GeminiRequestPart[] = [{ text: prompt }]
    const body = this.#buildRequestBody(parts, opts)
    const url = this.#url(this.#options.model)
    const headers = this.#headers()
    const response = await this.#sendRequest(url, headers, JSON.stringify(body))
    return this.#mapResponse(response)
  }

  /**
   * Edits one or more source images from a text prompt.
   *
   * @param inputs - One image, or several images, in any {@link GenerationImageInput} form.
   * @param prompt - The text prompt describing the desired edit.
   * @param opts - Per-call options (`n`, `aspectRatio`), each falling back to the adapter's
   *   configured default when applicable.
   * @returns One {@link GeneratedMediaOutput} per edited image part in the response.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_GEMINI_GENERATION_HTTP_ERROR} on a non-2xx response or transport failure.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_GEMINI_GENERATION_REQUEST_TIMEOUT} when the handshake exceeds `requestTimeoutMs`.
   * @throws {@link @nhtio/adk/batteries/generation/gemini/exceptions!E_GEMINI_GENERATION_MALFORMED_RESPONSE} when the 2xx body is not the expected shape, or contains zero image parts.
   */
  async edit(
    inputs: GenerationImageInput | GenerationImageInput[],
    prompt: string,
    opts?: GeminiEditOptions
  ): Promise<GeneratedMediaOutput[]> {
    const normalizedInputs = await Promise.all(
      (Array.isArray(inputs) ? inputs : [inputs]).map((input) => toBytes(input))
    )

    // Probe-confirmed ordering: image parts first (in input order), text prompt last.
    const parts: GeminiRequestPart[] = normalizedInputs.map(({ bytes, mimeType }) => ({
      inlineData: {
        mimeType: mimeType ?? 'image/png',
        data: encodeBase64(bytes),
      },
    }))
    parts.push({ text: prompt })

    const body = this.#buildRequestBody(parts, opts)
    const url = this.#url(this.#options.model)
    const headers = this.#headers()
    const response = await this.#sendRequest(url, headers, JSON.stringify(body))
    return this.#mapResponse(response)
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  #buildRequestBody(
    parts: GeminiRequestPart[],
    opts?: GeminiGenerateOptions | GeminiEditOptions
  ): GeminiGenerateContentRequestBody {
    const responseModalities = this.#options.responseModalities ?? ['TEXT', 'IMAGE']
    const aspectRatio = opts?.aspectRatio ?? this.#options.aspectRatio

    const generationConfig: GeminiGenerateContentRequestBody['generationConfig'] = {
      responseModalities,
      ...(opts?.n !== undefined && opts.n > 1 ? { candidateCount: opts.n } : {}),
      ...(aspectRatio !== undefined ? { imageConfig: { aspectRatio } } : {}),
    }

    return {
      contents: [{ role: 'user', parts }],
      generationConfig,
    }
  }

  #url(model: string): string {
    const rawBase = this.#options.baseURL ?? DEFAULT_BASE_URL
    const baseURL = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase
    return `${baseURL}/models/${model}:generateContent`
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.#options.apiKey) {
      headers['x-goog-api-key'] = this.#options.apiKey
    }
    if (this.#options.headers) {
      Object.assign(headers, this.#options.headers)
    }
    return headers
  }

  #mapResponse(response: GeminiGenerateContentResponse): GeneratedMediaOutput[] {
    if (!response || !Array.isArray(response.candidates) || response.candidates.length === 0) {
      throw new E_GEMINI_GENERATION_MALFORMED_RESPONSE(['response contained no candidates'])
    }

    const allParts = response.candidates.flatMap((candidate) => candidate.content?.parts ?? [])

    const outputs: GeneratedMediaOutput[] = []
    const textParts: string[] = []
    for (const part of allParts) {
      const inline = inlineDataOf(part)
      if (inline) {
        const mimeType = inline.mimeType ?? 'image/png'
        outputs.push({
          kind: 'image',
          mimeType,
          bytes: decodeBase64(inline.data),
          filename: `generated-${outputs.length + 1}.${extensionFromMimeType(mimeType)}`,
        })
      } else if ('text' in part && typeof part.text === 'string') {
        textParts.push(part.text)
      }
    }

    if (outputs.length === 0) {
      const detail =
        textParts.length > 0
          ? `response contained no image parts; text: ${textParts.join(' ')}`
          : 'response contained no image parts'
      throw new E_GEMINI_GENERATION_MALFORMED_RESPONSE([detail])
    }

    return outputs
  }

  // Shared HTTP request core — clones the OpenAI Generation adapter's retry loop exactly
  // (AbortController + requestTimeoutMs (0=disabled), retriable statuses, Retry-After honor,
  // transport-error status 0, exhaustion throws last HTTP error) so retry/timeout/error semantics
  // stay identical across every bundled HTTP-backed generation battery.
  async #sendRequest(
    url: string,
    headers: Record<string, string>,
    body: BodyInit
  ): Promise<GeminiGenerateContentResponse> {
    const retryCfg: Required<GenerationRetryConfig> = {
      maxAttempts: this.#options.retry?.maxAttempts ?? 1,
      baseDelayMs: this.#options.retry?.baseDelayMs ?? 500,
      maxDelayMs: this.#options.retry?.maxDelayMs ?? 30_000,
      retriableStatuses: this.#options.retry?.retriableStatuses ?? [429, 500, 502, 503, 504],
      honorRetryAfter: this.#options.retry?.honorRetryAfter ?? true,
    }

    const fetchFn = this.#options.fetch ?? globalThis.fetch
    const requestTimeoutMs = this.#options.requestTimeoutMs ?? 0
    const maxAttempts = retryCfg.maxAttempts

    let attempt = 1
    while (attempt <= maxAttempts) {
      const controller = new AbortController()
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined
      if (requestTimeoutMs > 0) {
        timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs)
      }

      let response: Response
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
      } catch (err) {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (controller.signal.aborted) {
          // Timed out before headers — retry if attempts remain.
          if (attempt < maxAttempts) {
            await sleepWithJitter(computeBackoff(attempt, retryCfg))
            attempt += 1
            continue
          }
          throw new E_GEMINI_GENERATION_REQUEST_TIMEOUT([requestTimeoutMs])
        }
        // Generic transport failure — retry if attempts remain, else surface as status 0.
        if (attempt < maxAttempts) {
          await sleepWithJitter(computeBackoff(attempt, retryCfg))
          attempt += 1
          continue
        }
        throw new E_GEMINI_GENERATION_HTTP_ERROR([0, isError(err) ? err.message : String(err)])
      }
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)

      if (!response.ok) {
        const status = response.status
        const retriable = retryCfg.retriableStatuses.includes(status)
        if (retriable && attempt < maxAttempts) {
          let delay = computeBackoff(attempt, retryCfg)
          if (retryCfg.honorRetryAfter) {
            const ra = response.headers.get('Retry-After')
            if (ra) {
              const raMs = parseRetryAfter(ra)
              if (raMs > 0) delay = Math.min(Math.max(delay, raMs), retryCfg.maxDelayMs)
            }
          }
          await sleepWithJitter(delay)
          attempt += 1
          continue
        }
        const detail = await response.text().catch(() => '')
        throw new E_GEMINI_GENERATION_HTTP_ERROR([status, detail])
      }

      try {
        return (await response.json()) as GeminiGenerateContentResponse
      } catch (err) {
        throw new E_GEMINI_GENERATION_MALFORMED_RESPONSE([isError(err) ? err.message : String(err)])
      }
    }

    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw new E_GEMINI_GENERATION_HTTP_ERROR([0, 'retry loop exhausted without a response'])
  }
}
