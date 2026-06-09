/**
 * Factory for a configured SearXNG metasearch tool.
 *
 * @module @nhtio/adk/batteries/tools/searxng
 *
 * @remarks
 * Unlike the other bundled tool categories — every one of which exports a ready-made,
 * stateless `Tool` constant — the SearXNG battery exports a **factory**,
 * {@link createSearxngSearchTool}. A search tool has to talk to a *specific* SearXNG instance,
 * usually behind custom authentication, so it needs per-deployment configuration (a base URL
 * and headers) that cannot be baked in at module load.
 *
 * Because this module exports a factory rather than a `Tool` instance, it MUST NOT be
 * bulk-registered via `Object.values(batteries)`. Call the factory first, then register the
 * returned tool: `new ToolRegistry([createSearxngSearchTool({ instanceUrl })])`.
 *
 * @see https://docs.searxng.org/dev/search_api.html
 */

import { validator } from '@nhtio/validation'
import { Middleware } from '@nhtio/middleware'
import { isError, isObject } from '@nhtio/adk/guards'
import { E_INVALID_SEARXNG_CONFIG } from './exceptions'
import { Tool, SpooledJsonArtifact, type ArtifactConstructorResolver } from '@nhtio/adk/common'
import type { Schema } from '@nhtio/validation'
import type { NextFn } from '@nhtio/middleware'

export { E_INVALID_SEARXNG_CONFIG } from './exceptions'

/** A static set of request headers (used for custom authentication). */
export type SearxngHeaders = Record<string, string>

/**
 * A resolver returning request headers, sync or async. Use this form when the auth token is
 * refreshable — the resolver runs on every search, so a fresh token can be minted per call.
 */
export type SearxngHeadersResolver = () => SearxngHeaders | Promise<SearxngHeaders>

/** The output shape the tool serialises. `either` lets the model pick per call. */
export type SearxngResultFormat = 'normalized' | 'raw' | 'either'

/**
 * A single normalised SearXNG result. SearXNG result items are deliberately untyped upstream,
 * so every field except a best-effort `title`/`url` is optional.
 */
export interface SearxngResult {
  /** Result title, when the source engine provided one. */
  title?: string
  /** Result URL, when the source engine provided one. */
  url?: string
  /** Snippet / summary text for the result. */
  content?: string
  /** The SearXNG engine that produced this result (e.g. `google`, `duckduckgo`). */
  engine?: string
  /** Relevance score as reported by SearXNG (higher is more relevant). */
  score?: number
  /** Publication date, when the source engine exposed one (ISO-ish string, engine-dependent). */
  publishedDate?: string
}

/**
 * Mutable context handed to each input-pipeline stage **before** the HTTP request is sent.
 *
 * @remarks
 * Stages mutate this in place (onion `(ctx, next)` style) to adjust the outgoing request —
 * inject or rotate auth headers, force a language, rewrite the query — or call
 * {@link SearxngRequestContext.shortCircuit} to skip the fetch entirely (e.g. a cache hit).
 */
export interface SearxngRequestContext {
  /** The tool's name (read-only). */
  readonly toolName: string
  /** The search query. Mutable. */
  query: string
  /** Extra SearXNG query parameters (`categories`, `engines`, `language`, …). Mutable. */
  params: Record<string, string>
  /** Resolved request headers. Mutable — inject, redact, or rotate auth here. */
  headers: SearxngHeaders
  /** The target instance base URL (read-only). */
  readonly instanceUrl: string
  /** Cross-stage scratch space; also carried onto the response context. */
  readonly stash: Map<string, unknown>
  /** Skip the fetch and return `result` verbatim as the tool's output. */
  shortCircuit(result: string): void
}

/**
 * Mutable context handed to each output-pipeline stage **after** the response JSON is parsed.
 *
 * @remarks
 * Stages reshape, redact, enrich, or re-rank {@link SearxngResponseContext.results}, mutate the
 * raw body, or set {@link SearxngResponseContext.output} to override the serialised string
 * verbatim (e.g. to render markdown that matches a markdown `artifactConstructor`).
 */
export interface SearxngResponseContext {
  /** The tool's name (read-only). */
  readonly toolName: string
  /** The request context as it was sent (post-input-pipeline). */
  readonly request: SearxngRequestContext
  /** The parsed SearXNG JSON body. Mutable (used when `format` is `raw`). */
  raw: unknown
  /** The normalised result list. Mutable — filter, redact, or re-rank. */
  results: SearxngResult[]
  /** The effective payload shape for this call. */
  format: 'normalized' | 'raw'
  /** When set, used verbatim as the tool's output (overrides serialisation). */
  output?: string
  /** Cross-stage scratch space; carried over from the request context. */
  readonly stash: Map<string, unknown>
}

/** An input-pipeline stage. Onion middleware over {@link SearxngRequestContext}. */
export type SearxngInputMiddlewareFn = (
  ctx: SearxngRequestContext,
  next: NextFn
) => void | Promise<void>

/** An output-pipeline stage. Onion middleware over {@link SearxngResponseContext}. */
export type SearxngOutputMiddlewareFn = (
  ctx: SearxngResponseContext,
  next: NextFn
) => void | Promise<void>

/** Configuration for {@link createSearxngSearchTool}. */
export interface SearxngToolConfig {
  /** Base URL of the SearXNG instance, e.g. `https://searx.example.org`. Required. */
  instanceUrl: string
  /** Custom request headers — a static object or a (sync/async) resolver for refreshable auth. */
  headers?: SearxngHeaders | SearxngHeadersResolver
  /** Request timeout in milliseconds. Default `10_000`. */
  timeout?: number
  /**
   * Output shape. `normalized`/`raw` pin the shape (the model cannot change it); `either`
   * (default) exposes a `format` argument so the model chooses per call.
   */
  resultFormat?: SearxngResultFormat
  /** Tool name. Default `searxng_search`. */
  name?: string
  /** Tool description override. */
  description?: string
  /**
   * Spool artifact constructor for the tool's output. Default `() => SpooledJsonArtifact`.
   * Pass `() => SpooledMarkdownArtifact` (paired with an output stage that renders markdown into
   * `ctx.output`) or `() => SpooledArtifact` for plain text.
   */
  artifactConstructor?: ArtifactConstructorResolver
  /** Stages run before the HTTP request. See {@link SearxngRequestContext}. */
  inputPipeline?: SearxngInputMiddlewareFn[]
  /** Stages run after the response is parsed. See {@link SearxngResponseContext}. */
  outputPipeline?: SearxngOutputMiddlewareFn[]
}

const DEFAULT_NAME = 'searxng_search'
const DEFAULT_TIMEOUT = 10_000
const DEFAULT_DESCRIPTION =
  'Search the web via a SearXNG metasearch instance. Returns aggregated results (title, url, ' +
  'snippet, source engine) plus any answers, infoboxes, and suggestions.'

/** Internal sentinel a short-circuiting input stage throws to unwind the pipeline immediately. */
const SHORT_CIRCUIT = Symbol('searxng.shortCircuit')

interface ShortCircuitSignal {
  [SHORT_CIRCUIT]: true
  result: string
}

const isShortCircuit = (value: unknown): value is ShortCircuitSignal =>
  isObject(value) && (value as Record<symbol, unknown>)[SHORT_CIRCUIT] === true

/** Normalise a loose SearXNG result item into a {@link SearxngResult}. */
const normaliseResult = (raw: unknown): SearxngResult => {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: SearxngResult = {}
  if (typeof r.title === 'string') out.title = r.title
  if (typeof r.url === 'string') out.url = r.url
  if (typeof r.content === 'string') out.content = r.content
  if (typeof r.engine === 'string') out.engine = r.engine
  if (typeof r.score === 'number') out.score = r.score
  if (typeof r.publishedDate === 'string') out.publishedDate = r.publishedDate
  return out
}

/** Resolve the configured headers (static object or resolver) for a single request. */
const resolveHeaders = async (headers: SearxngToolConfig['headers']): Promise<SearxngHeaders> => {
  if (typeof headers === 'function') return { ...(await headers()) }
  return { ...(headers ?? {}) }
}

/**
 * Create a configured SearXNG search {@link Tool}.
 *
 * @remarks
 * The handler always requests `format=json`. Note that SearXNG ships with JSON output
 * **disabled** by default (it is abused by bots); an instance that has not enabled
 * `search.formats: [json]` in its `settings.yml` answers with HTTP 403, which the tool returns
 * as a graceful `Error:` string naming the setting.
 *
 * @warning
 * Do not trust the `number_of_results` field for a result count — SearXNG frequently reports `0`
 * in JSON output even when `results` is non-empty. This is a long-standing upstream quirk, not a
 * tool defect (see {@link https://github.com/searxng/searxng/issues/2987 | searxng#2987} and
 * {@link https://github.com/searxng/searxng/issues/2457 | searxng#2457}). The tool passes the
 * field through verbatim; use `results.length` as the authoritative count.
 *
 * @param config - The instance URL, optional custom headers, output-format policy, artifact
 *   type, and input/output middleware pipelines. See {@link SearxngToolConfig}.
 * @returns A `Tool` ready to register in a `ToolRegistry`.
 * @throws {@link E_INVALID_SEARXNG_CONFIG} when `instanceUrl` is missing or unparseable.
 */
export const createSearxngSearchTool = (config: SearxngToolConfig): Tool => {
  if (typeof config?.instanceUrl !== 'string' || config.instanceUrl.trim() === '') {
    throw new E_INVALID_SEARXNG_CONFIG(['instanceUrl is required'])
  }
  try {
    // Parse-validate only; the normalised string below is what we actually use.
    new URL(config.instanceUrl)
  } catch {
    throw new E_INVALID_SEARXNG_CONFIG([`instanceUrl is not a valid URL: ${config.instanceUrl}`])
  }
  // Normalise away a trailing slash so `new URL('/search', base)` resolves cleanly.
  const instanceUrl = config.instanceUrl.replace(/\/+$/, '')

  const timeout = config.timeout ?? DEFAULT_TIMEOUT
  const resultFormat: SearxngResultFormat = config.resultFormat ?? 'either'
  const toolName = config.name ?? DEFAULT_NAME
  const artifactConstructor: ArtifactConstructorResolver =
    config.artifactConstructor ?? (() => SpooledJsonArtifact)

  // Stages are fixed at factory time; build the Middleware shells once. A fresh `.runner()` is
  // minted per invocation inside the handler (runners are single-use).
  const inputMw = new Middleware<SearxngInputMiddlewareFn>()
  for (const fn of config.inputPipeline ?? []) inputMw.add(fn)
  const outputMw = new Middleware<SearxngOutputMiddlewareFn>()
  for (const fn of config.outputPipeline ?? []) outputMw.add(fn)
  const hasInput = (config.inputPipeline ?? []).length > 0
  const hasOutput = (config.outputPipeline ?? []).length > 0

  // Build the input schema, conditionally exposing `format` only when the factory is neutral.
  const schemaShape: Record<string, Schema> = {
    query: validator.string().required().description('The search query.'),
    categories: validator
      .string()
      .optional()
      .description('Comma-separated SearXNG categories (e.g. "general,news").'),
    engines: validator
      .string()
      .optional()
      .description('Comma-separated SearXNG engines (e.g. "google,duckduckgo").'),
    language: validator.string().optional().description('Language code (e.g. "en", "de").'),
    pageno: validator.number().min(1).default(1).description('Result page number (1-based).'),
    time_range: validator
      .string()
      .valid('day', 'month', 'year')
      .optional()
      .description('Restrict results to a time range.'),
    safesearch: validator
      .number()
      .valid(0, 1, 2)
      .optional()
      .description('Safe-search level: 0 (off), 1 (moderate), 2 (strict).'),
  }
  if (resultFormat === 'either') {
    schemaShape.format = validator
      .string()
      .valid('normalized', 'raw')
      .default('normalized')
      .description('Output shape: "normalized" (trimmed) or "raw" (full SearXNG JSON).')
  }
  const inputSchema = validator.object(schemaShape)

  return new Tool({
    name: toolName,
    description: config.description ?? DEFAULT_DESCRIPTION,
    inputSchema,
    artifactConstructor,
    handler: async (args) => {
      const a = args as {
        query: string
        categories?: string
        engines?: string
        language?: string
        pageno?: number
        time_range?: string
        safesearch?: number
        format?: 'normalized' | 'raw'
      }

      try {
        // 1. Effective output format: a pinned factory format wins; else the model's choice.
        const format: 'normalized' | 'raw' =
          resultFormat === 'either' ? (a.format ?? 'normalized') : resultFormat

        // 2. Resolve headers, merged over portable defaults (caller headers win).
        const headers: SearxngHeaders = {
          'Accept': 'application/json',
          'User-Agent': 'adk-searxng-tool',
          ...(await resolveHeaders(config.headers)),
        }

        // 3. Assemble the SearXNG query params from validated args.
        const params: Record<string, string> = {}
        if (a.categories) params.categories = a.categories
        if (a.engines) params.engines = a.engines
        if (a.language) params.language = a.language
        if (a.pageno && a.pageno !== 1) params.pageno = String(a.pageno)
        if (a.time_range) params.time_range = a.time_range
        if (typeof a.safesearch === 'number') params.safesearch = String(a.safesearch)

        const stash = new Map<string, unknown>()

        // 4. Run the input pipeline (fresh runner) over a mutable request context.
        const requestCtx: SearxngRequestContext = {
          toolName,
          query: a.query,
          params,
          headers,
          instanceUrl,
          stash,
          shortCircuit: (result: string) => {
            const signal: ShortCircuitSignal = { [SHORT_CIRCUIT]: true, result }
            throw signal
          },
        }

        if (hasInput) {
          const short = await runInputPipeline(inputMw, requestCtx)
          if (short !== undefined) return short
        }

        // 5. Build the request URL from the (possibly mutated) query + params.
        const url = new URL('/search', instanceUrl + '/')
        url.searchParams.set('q', requestCtx.query)
        for (const [k, v] of Object.entries(requestCtx.params)) url.searchParams.set(k, v)
        url.searchParams.set('format', 'json')

        // 6. Fetch with an AbortController timeout.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        let response: Response
        try {
          response = await fetch(url, {
            method: 'GET',
            headers: requestCtx.headers,
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }

        if (!response.ok) {
          if (response.status === 403) {
            return (
              `Error: SearXNG returned 403 Forbidden. The instance likely has the JSON output ` +
              `format disabled — enable it under "search.formats: [json]" in its settings.yml.`
            )
          }
          return `Error: SearXNG returned HTTP ${response.status} ${response.statusText}.`
        }

        const body = (await response.json()) as Record<string, unknown>

        // 7. Run the output pipeline (fresh runner) over a mutable response context.
        const responseCtx: SearxngResponseContext = {
          toolName,
          request: requestCtx,
          raw: body,
          results: Array.isArray(body.results) ? body.results.map(normaliseResult) : [],
          format,
          stash,
        }

        if (hasOutput) await runOutputPipeline(outputMw, responseCtx)

        // 8. Serialise and return.
        if (typeof responseCtx.output === 'string') return responseCtx.output
        if (responseCtx.format === 'raw') return JSON.stringify(responseCtx.raw, null, 2)
        return JSON.stringify(buildNormalisedPayload(responseCtx), null, 2)
      } catch (err) {
        if (isShortCircuit(err)) return err.result
        return `Error: ${isError(err) ? err.message : String(err)}`
      }
    },
  })
}

/** Assemble the trimmed normalised payload, dropping empty aggregate arrays. */
const buildNormalisedPayload = (ctx: SearxngResponseContext): Record<string, unknown> => {
  const raw = (ctx.raw ?? {}) as Record<string, unknown>
  const payload: Record<string, unknown> = {
    query: typeof raw.query === 'string' ? raw.query : ctx.request.query,
    results: ctx.results,
  }
  // NOTE: SearXNG's `number_of_results` is frequently `0` in JSON output even when `results`
  // is non-empty — a long-standing upstream quirk, not a tool bug (see
  // https://github.com/searxng/searxng/issues/2987 and
  // https://github.com/searxng/searxng/issues/2457). We pass through whatever the instance
  // reports; treat `results.length` as the authoritative count, not this field.
  if (typeof raw.number_of_results === 'number') payload.number_of_results = raw.number_of_results
  for (const key of ['answers', 'infoboxes', 'suggestions', 'corrections'] as const) {
    const value = raw[key]
    if (Array.isArray(value) && value.length > 0) payload[key] = value
  }
  return payload
}

/**
 * Run the input pipeline. Returns the short-circuit string when a stage short-circuited, or
 * `undefined` when the pipeline reached its terminal handler. A non-terminal pipeline (a stage
 * that neither called `next()` nor short-circuited) is surfaced as a thrown Error so the handler
 * converts it to an `Error:` string.
 */
const runInputPipeline = async (
  mw: Middleware<SearxngInputMiddlewareFn>,
  ctx: SearxngRequestContext
): Promise<string | undefined> => {
  let reached = false
  let shortResult: string | undefined
  let caught: unknown
  await mw
    .runner()
    .errorHandler(async (error: unknown) => {
      caught = error
    })
    .finalHandler(async () => {
      reached = true
    })
    .run((fn, next) => Promise.resolve(fn(ctx, next)))

  if (caught !== undefined) {
    if (isShortCircuit(caught)) {
      shortResult = caught.result
    } else {
      throw caught
    }
  } else if (!reached) {
    throw new Error('SearXNG input pipeline did not call next() and did not short-circuit.')
  }
  return shortResult
}

/** Run the output pipeline; rethrow any stage error to the handler's try/catch. */
const runOutputPipeline = async (
  mw: Middleware<SearxngOutputMiddlewareFn>,
  ctx: SearxngResponseContext
): Promise<void> => {
  let reached = false
  let caught: unknown
  await mw
    .runner()
    .errorHandler(async (error: unknown) => {
      caught = error
    })
    .finalHandler(async () => {
      reached = true
    })
    .run((fn, next) => Promise.resolve(fn(ctx, next)))

  if (caught !== undefined) throw caught
  if (!reached) {
    throw new Error('SearXNG output pipeline did not call next().')
  }
}
