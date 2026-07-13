/**
 * Cross-environment OpenAI media generation adapter battery.
 *
 * @module @nhtio/adk/batteries/generation/openai/adapter
 *
 * @remarks
 * Opinionated media-generation battery for the OpenAI `/v1/images/generations` and
 * `/v1/images/edits` wire shapes. Ships an {@link OpenAIGenerationAdapter} that targets any
 * OpenAI-`/v1/images`-compatible endpoint (OpenAI proper, Azure-behind-proxy, a local gateway,
 * etc.) over raw `fetch` — no SDK dependency, so it runs unchanged in Node, the browser, edge
 * runtimes, and workers.
 *
 * Construction validates options eagerly via
 * {@link @nhtio/adk/batteries/generation/openai/validation!validateOptions} and throws
 * {@link @nhtio/adk/batteries/generation/openai/exceptions!E_INVALID_OPENAI_GENERATION_OPTIONS} on
 * failure — config bugs fail loud, not at generate/edit time.
 */

import { toBytes } from '../_shared'
import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { decodeBase64 } from '../../../lib/helpers/base64'
import { computeBackoff, sleepWithJitter, parseRetryAfter } from '../../../lib/utils/retry'
import {
  E_OPENAI_GENERATION_HTTP_ERROR,
  E_OPENAI_GENERATION_REQUEST_TIMEOUT,
  E_OPENAI_GENERATION_MALFORMED_RESPONSE,
} from './exceptions'
import type { GenerationImageInput } from '../_shared'
import type {
  GenerationRetryConfig,
  GeneratedMediaOutput,
  OpenAIGenerationAdapterOptions,
  OpenAIGenerateOptions,
  OpenAIEditOptions,
  OpenAIImagesGenerationRequestBody,
  OpenAIImagesResponse,
} from './types'

// ─── Wire constants ────────────────────────────────────────────────────────────

/**
 * The multipart field name used for each image appended to an `/v1/images/edits` request.
 *
 * @remarks
 * Defined once, in this one place, so the WP-0 upstream-probe finding (whether the live API
 * expects the array-suffixed `'image[]'` form or the bare `'image'` form for multi-image edit
 * requests) can flip the wire behavior by changing a single constant, with every call site and
 * test following automatically.
 */
export const EDIT_IMAGE_FIELD_NAME = 'image[]'

// ─── Adapter class ────────────────────────────────────────────────────────────

/**
 * Media generation adapter for the OpenAI `/v1/images/generations` and `/v1/images/edits` wire
 * shapes.
 *
 * @remarks
 * Reusable: construct once, call {@link OpenAIGenerationAdapter.generate} /
 * {@link OpenAIGenerationAdapter.edit} as many times as needed.
 */
export class OpenAIGenerationAdapter {
  readonly #options: OpenAIGenerationAdapterOptions

  /**
   * Whether this battery can run in the current environment. For the HTTP-backed OpenAI battery
   * this is always `true` (a `fetch` is always resolvable); present for surface-parity with
   * WebGPU-gated batteries.
   */
  public static isAvailable(): boolean {
    return true
  }

  /**
   * @param options - Constructor options. Validated eagerly.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_INVALID_OPENAI_GENERATION_OPTIONS} when `options` does not satisfy
   *   {@link @nhtio/adk/batteries/generation/openai/validation!openAIGenerationOptionsSchema} (e.g. missing `model`).
   */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
  }

  /** See {@link OpenAIGenerationAdapter.isAvailable}. Instance alias for surface-parity. */
  isAvailable(): boolean {
    return OpenAIGenerationAdapter.isAvailable()
  }

  /**
   * No-op warm-up. The OpenAI battery has no engine to preload; present for surface-parity with
   * on-device generation batteries so callers can treat them interchangeably.
   */
  async preload(): Promise<void> {
    // intentionally empty — nothing to warm for an HTTP-backed battery
  }

  /**
   * No-op state reset. Present for surface-parity with on-device generation batteries.
   */
  reset(): void {
    // intentionally empty — the OpenAI battery holds no engine state
  }

  /**
   * Generates one or more images from a text prompt.
   *
   * @param prompt - The text prompt describing the desired image(s).
   * @param opts - Per-call options (`n`, `size`, `quality`, `outputFormat`, `background`), each
   *   falling back to the adapter's configured default when omitted.
   * @returns One {@link GeneratedMediaOutput} per generated image.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_OPENAI_GENERATION_HTTP_ERROR} on a non-2xx response or transport failure.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_OPENAI_GENERATION_REQUEST_TIMEOUT} when the handshake exceeds `requestTimeoutMs`.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_OPENAI_GENERATION_MALFORMED_RESPONSE} when the 2xx body is not the expected shape.
   */
  async generate(prompt: string, opts?: OpenAIGenerateOptions): Promise<GeneratedMediaOutput[]> {
    const model = this.#options.model
    const size = opts?.size ?? this.#options.size
    const quality = opts?.quality ?? this.#options.quality
    const outputFormat = opts?.outputFormat ?? this.#options.outputFormat ?? 'png'
    const background = opts?.background ?? this.#options.background

    const body: OpenAIImagesGenerationRequestBody = {
      model,
      prompt,
      ...(opts?.n !== undefined ? { n: opts.n } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(quality !== undefined ? { quality } : {}),
      ...(outputFormat !== undefined ? { output_format: outputFormat } : {}),
      ...(background !== undefined ? { background } : {}),
    }

    const responseFormat = this.#resolveResponseFormat(model)
    if (responseFormat !== undefined) {
      body.response_format = responseFormat
    }

    const url = this.#url('/images/generations')
    const headers = this.#headers(true)
    const response = await this.#sendRequest(url, headers, JSON.stringify(body))
    return this.#mapResponse(response, outputFormat)
  }

  /**
   * Edits one or more source images from a text prompt, optionally constrained to a masked
   * region.
   *
   * @param inputs - One image, or several images, in any {@link GenerationImageInput} form.
   * @param prompt - The text prompt describing the desired edit.
   * @param opts - Per-call options (`n`, `size`, `quality`, `mask`), each falling back to the
   *   adapter's configured default when omitted (`mask` has no adapter-level default).
   * @returns One {@link GeneratedMediaOutput} per edited image.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_OPENAI_GENERATION_HTTP_ERROR} on a non-2xx response or transport failure.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_OPENAI_GENERATION_REQUEST_TIMEOUT} when the handshake exceeds `requestTimeoutMs`.
   * @throws {@link @nhtio/adk/batteries/generation/openai/exceptions!E_OPENAI_GENERATION_MALFORMED_RESPONSE} when the 2xx body is not the expected shape.
   */
  async edit(
    inputs: GenerationImageInput | GenerationImageInput[],
    prompt: string,
    opts?: OpenAIEditOptions
  ): Promise<GeneratedMediaOutput[]> {
    const model = this.#options.model
    const size = opts?.size ?? this.#options.size
    const quality = opts?.quality ?? this.#options.quality
    const outputFormat = this.#options.outputFormat ?? 'png'

    const normalizedInputs = await Promise.all(
      (Array.isArray(inputs) ? inputs : [inputs]).map((input) => toBytes(input))
    )

    const form = new FormData()
    normalizedInputs.forEach(({ bytes, mimeType }, i) => {
      form.append(
        EDIT_IMAGE_FIELD_NAME,
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType ?? 'image/png' }),
        `input-${i + 1}.png`
      )
    })
    form.append('prompt', prompt)
    form.append('model', model)
    if (opts?.n !== undefined) form.append('n', String(opts.n))
    if (size !== undefined) form.append('size', size)
    if (quality !== undefined) form.append('quality', quality)
    if (opts?.mask !== undefined) {
      const mask = await toBytes(opts.mask)
      form.append(
        'mask',
        new Blob([mask.bytes as Uint8Array<ArrayBuffer>], { type: mask.mimeType ?? 'image/png' }),
        'mask.png'
      )
    }

    const url = this.#url('/images/edits')
    // CRITICAL: no Content-Type here — fetch supplies the multipart boundary itself.
    const headers = this.#headers(false)
    const response = await this.#sendRequest(url, headers, form)
    return this.#mapResponse(response, outputFormat)
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  #resolveResponseFormat(model: string): string | undefined {
    const mode = this.#options.responseFormatMode ?? 'auto'
    if (mode === 'omit') return undefined
    if (mode === 'send') return 'b64_json'
    // 'auto' — dall-e-* defaults to a hosted URL unless told otherwise; gpt-image-* always
    // returns base64 and rejects the parameter entirely.
    return model.startsWith('dall-e') ? 'b64_json' : undefined
  }

  #url(path: string): string {
    const rawBase = this.#options.baseURL ?? 'https://api.openai.com/v1'
    const baseURL = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase
    return `${baseURL}${path}`
  }

  #headers(isJson: boolean): Record<string, string> {
    const headers: Record<string, string> = {}
    if (isJson) headers['Content-Type'] = 'application/json'
    if (this.#options.apiKey) {
      headers['Authorization'] = `Bearer ${this.#options.apiKey}`
    }
    if (this.#options.headers) {
      Object.assign(headers, this.#options.headers)
    }
    return headers
  }

  #mapResponse(response: OpenAIImagesResponse, outputFormat: string): GeneratedMediaOutput[] {
    if (!response || !Array.isArray(response.data) || response.data.length === 0) {
      throw new E_OPENAI_GENERATION_MALFORMED_RESPONSE(['response contained no image data'])
    }
    return response.data.map((entry, i) => {
      if (!entry.b64_json) {
        throw new E_OPENAI_GENERATION_MALFORMED_RESPONSE([`entry ${i} is missing "b64_json"`])
      }
      return {
        kind: 'image',
        mimeType: `image/${outputFormat}`,
        bytes: decodeBase64(entry.b64_json),
        filename: `generated-${i + 1}.${outputFormat}`,
      }
    })
  }

  // Shared HTTP request core — clones the OpenAI Embeddings adapter's retry loop exactly
  // (AbortController + requestTimeoutMs (0=disabled), retriable statuses, Retry-After honor,
  // transport-error status 0, exhaustion throws last HTTP error) so retry/timeout/error semantics
  // stay identical across every bundled OpenAI-style HTTP battery.
  async #sendRequest(
    url: string,
    headers: Record<string, string>,
    body: BodyInit
  ): Promise<OpenAIImagesResponse> {
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
          throw new E_OPENAI_GENERATION_REQUEST_TIMEOUT([requestTimeoutMs])
        }
        // Generic transport failure — retry if attempts remain, else surface as status 0.
        if (attempt < maxAttempts) {
          await sleepWithJitter(computeBackoff(attempt, retryCfg))
          attempt += 1
          continue
        }
        throw new E_OPENAI_GENERATION_HTTP_ERROR([0, isError(err) ? err.message : String(err)])
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
        throw new E_OPENAI_GENERATION_HTTP_ERROR([status, detail])
      }

      try {
        return (await response.json()) as OpenAIImagesResponse
      } catch (err) {
        throw new E_OPENAI_GENERATION_MALFORMED_RESPONSE([isError(err) ? err.message : String(err)])
      }
    }

    // Unreachable: the loop either returns or throws. Satisfies the type checker.
    throw new E_OPENAI_GENERATION_HTTP_ERROR([0, 'retry loop exhausted without a response'])
  }
}
