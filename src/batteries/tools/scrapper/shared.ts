/**
 * Internal core shared by both Scrapper verbs (article / links).
 *
 * @remarks
 * No `@module` tag — this is a sibling of `index.ts`, relative-imported, not its own entrypoint.
 * Houses the per-parameter disposition machinery (schema building from `fixed`/`defaults`), the
 * snake→kebab wire mapping, the request/response contexts, and the `fetch`+pipeline handler core.
 * Generic harness helpers (artifact/header resolution, pipeline runners) come from `../_shared`.
 */

import { Tool } from '@nhtio/adk/forge'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { Middleware } from '@nhtio/middleware'
import { E_INVALID_SCRAPPER_CONFIG } from './exceptions'
import {
  resolveHeaders,
  makeShortCircuit,
  isShortCircuit,
  runInputPipeline,
  runOutputPipeline,
  type ToolHeaders,
  type ToolHeadersResolver,
  type SpooledArtifactCtor,
  type MiddlewareFn,
} from '../_shared'
import type { Schema } from '@nhtio/validation'
import type { NextFn } from '@nhtio/middleware'

const DEFAULT_REQUEST_TIMEOUT = 65_000

/** Throw the battery-scoped config error. */
export const failConfig = (reason: string): never => {
  throw new E_INVALID_SCRAPPER_CONFIG([reason])
}

// ── Parameter specs (per-parameter disposition) ──────────────────────────────

/** The wire type of a Scrapper query parameter — controls serialisation. */
export type ScrapperParamType = 'string' | 'number' | 'boolean'

/**
 * One curated, model-facing Scrapper parameter: its snake_case key (used in the model schema and
 * in `fixed`/`defaults`), its kebab-case wire name, its type, the base validator, and a description.
 */
export interface ScrapperParamSpec {
  /** snake_case key as seen by the model and in `config.fixed` / `config.defaults`. */
  key: string
  /** kebab-case name sent to the Scrapper API. */
  wire: string
  /** Wire type, controlling string/number/boolean serialisation. */
  type: ScrapperParamType
  /** Base `@nhtio/validation` schema (no `.required()`/`.default()`/`.optional()` applied yet). */
  schema: Schema
  /** Human-readable description surfaced to the model. */
  description: string
}

/** Serialise a parameter value to its wire string. */
const toWire = (value: unknown): string => String(value)

/**
 * Build the model-facing input schema from a verb's param specs and the factory's disposition.
 * `url` is always required. A `fixed` param is omitted (the model can't set it); a `defaults` param
 * gets `.default(value)`; everything else is `.optional()`.
 */
export const buildScrapperSchema = (
  specs: ScrapperParamSpec[],
  fixed: Record<string, unknown> | undefined,
  defaults: Record<string, unknown> | undefined,
  extra: Record<string, Schema> = {}
): Schema => {
  const shape: Record<string, Schema> = {
    url: validator.string().required().description('The absolute URL of the page to load.'),
  }
  for (const spec of specs) {
    if (fixed && spec.key in fixed) continue // pinned → not model-visible
    let sch = spec.schema
    if (defaults && spec.key in defaults) {
      sch = sch.default(defaults[spec.key] as never)
    } else {
      sch = sch.optional()
    }
    shape[spec.key] = sch.description(spec.description)
  }
  return validator.object({ ...shape, ...extra })
}

/**
 * Assemble the wire-kebab query params for one request: each spec's value is `fixed` (if pinned)
 * else the validated model/default value; then `fixedQuery` raw passthrough is layered on. `url`
 * is handled separately (it is the search target, never pinned).
 */
export const buildWireParams = (
  args: Record<string, unknown>,
  specs: ScrapperParamSpec[],
  fixed: Record<string, unknown> | undefined,
  fixedQuery: Record<string, string> | undefined
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const spec of specs) {
    const value = fixed && spec.key in fixed ? fixed[spec.key] : args[spec.key]
    if (value !== undefined && value !== null) out[spec.wire] = toWire(value)
  }
  for (const [k, v] of Object.entries(fixedQuery ?? {})) out[k] = v
  return out
}

// ── Contexts ─────────────────────────────────────────────────────────────────

/**
 * Mutable context handed to each input-pipeline stage **before** the HTTP request is sent.
 * Identical for both verbs.
 */
export interface ScrapperRequestContext {
  /** The tool's name (read-only). */
  readonly toolName: string
  /** The target page URL (the `url` argument). Mutable. */
  url: string
  /** Wire-kebab query params (everything except `url`). Mutable. */
  params: Record<string, string>
  /** Resolved request headers sent to the SCRAPPER INSTANCE (auth). Mutable. */
  headers: ToolHeaders
  /** The Scrapper instance base URL (read-only). */
  readonly instanceUrl: string
  /** Cross-stage scratch space; also carried onto the response context. */
  readonly stash: Map<string, unknown>
  /** Skip the fetch and return `result` verbatim as the tool's output (e.g. a cache hit). */
  shortCircuit(result: string): void
}

/**
 * Mutable context handed to each output-pipeline stage **after** the response JSON is parsed.
 *
 * @typeParam R - The verb's normalised result type (article object or links payload).
 */
export interface ScrapperResponseContext<R> {
  /** The tool's name (read-only). */
  readonly toolName: string
  /** The request context as it was sent (post-input-pipeline). */
  readonly request: ScrapperRequestContext
  /** The parsed Scrapper JSON body. Mutable (used when `format` is `raw`). */
  raw: unknown
  /** The normalised result. Mutable — reshape, redact, enrich. */
  result: R
  /** The effective payload shape for this call. */
  format: 'normalized' | 'raw'
  /** When set, used verbatim as the tool's output (overrides serialisation). */
  output?: string
  /** Cross-stage scratch space; carried over from the request context. */
  readonly stash: Map<string, unknown>
}

/** An input-pipeline stage. Onion middleware over {@link ScrapperRequestContext}. */
export type ScrapperInputMiddlewareFn = (
  ctx: ScrapperRequestContext,
  next: NextFn
) => void | Promise<void>

/** An output-pipeline stage over a verb's {@link ScrapperResponseContext}. */
export type ScrapperOutputMiddlewareFn<R> = (
  ctx: ScrapperResponseContext<R>,
  next: NextFn
) => void | Promise<void>

// ── Config (shared shape; `artifact` variant supplied by the verb factory) ────

/** Configuration common to every Scrapper factory. `A` is the accepted `artifact` resolver type. */
export interface ScrapperBaseConfig<P, R, A> {
  /** Base URL of the Scrapper instance, e.g. `https://scrapper.example.org`. Required. */
  instanceUrl: string
  /** Headers sent to the Scrapper INSTANCE for auth (X-API-Key / Basic) — static or resolver. */
  headers?: ToolHeaders | ToolHeadersResolver
  /** The tool's own `fetch` AbortController timeout in ms. Default `65_000` (> Scrapper's 60s browser default). */
  requestTimeoutMs?: number
  /** Output shape. `normalized`/`raw` pin it; `either` (default) exposes a `format` arg to the model. */
  resultFormat?: 'normalized' | 'raw' | 'either'
  /** Spool-artifact resolver for the output. Default `() => SpooledJsonArtifact`. */
  artifact?: A
  /** Tool name override. */
  name?: string
  /** Tool description override. */
  description?: string
  /** Pinned params — sent always, removed from the model schema. */
  fixed?: Partial<P>
  /** Model-overridable default param values. */
  defaults?: Partial<P>
  /** Raw, un-modeled wire params (kebab keys) — always sent, never model-visible. Keeps the battery generic. */
  fixedQuery?: Record<string, string>
  /** Stages run before the HTTP request. See {@link ScrapperRequestContext}. */
  inputPipeline?: ScrapperInputMiddlewareFn[]
  /** Stages run after the response is parsed. See {@link ScrapperResponseContext}. */
  outputPipeline?: ScrapperOutputMiddlewareFn<R>[]
}

/** Verb-specific wiring passed to {@link assembleScrapperTool}. */
export interface ScrapperVerb<R> {
  /** Scrapper endpoint path, e.g. `/api/article`. */
  endpoint: string
  /** The curated param specs for this verb. */
  specs: ScrapperParamSpec[]
  /** Default tool name (`scrapper_article` / `scrapper_links`). */
  defaultName: string
  /** Default tool description. */
  defaultDescription: string
  /** Map a parsed Scrapper body to the verb's normalised result. */
  normalize: (body: Record<string, unknown>) => R
}

/** Parse a Scrapper error body (`{ detail: [{ msg }] }`) into a single message, best-effort. */
const parseScrapperError = (body: unknown, status: number, statusText: string): string => {
  if (body && typeof body === 'object' && Array.isArray((body as { detail?: unknown }).detail)) {
    const detail = (body as { detail: Array<{ msg?: unknown; loc?: unknown }> }).detail
    const msgs = detail
      .map((d) => {
        const loc = Array.isArray(d.loc) ? d.loc.join('.') : undefined
        const msg = typeof d.msg === 'string' ? d.msg : undefined
        if (msg && loc) return `${loc}: ${msg}`
        return msg ?? loc
      })
      .filter((m): m is string => typeof m === 'string')
    if (msgs.length) return msgs.join('; ')
  }
  return `HTTP ${status} ${statusText}`.trim()
}

/**
 * Build a configured Scrapper {@link Tool} from validated config + an already-resolved sync
 * artifact constructor. Shared by every verb and by both the async and sync factories.
 */
export const assembleScrapperTool = <P, R>(
  verb: ScrapperVerb<R>,
  config: ScrapperBaseConfig<P, R, unknown>,
  instanceUrl: string,
  artifactConstructor: () => SpooledArtifactCtor
): Tool => {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT
  const resultFormat = config.resultFormat ?? 'either'
  const toolName = config.name ?? verb.defaultName
  const fixed = config.fixed as Record<string, unknown> | undefined
  const defaults = config.defaults as Record<string, unknown> | undefined

  const inputMw = new Middleware<MiddlewareFn<ScrapperRequestContext>>()
  for (const fn of config.inputPipeline ?? []) inputMw.add(fn)
  const outputMw = new Middleware<MiddlewareFn<ScrapperResponseContext<R>>>()
  for (const fn of config.outputPipeline ?? [])
    outputMw.add(fn as MiddlewareFn<ScrapperResponseContext<R>>)
  const hasInput = (config.inputPipeline ?? []).length > 0
  const hasOutput = (config.outputPipeline ?? []).length > 0

  // Build the schema, conditionally exposing `format` only when the factory is neutral.
  const extra: Record<string, Schema> =
    resultFormat === 'either'
      ? {
          format: validator
            .string()
            .valid('normalized', 'raw')
            .default('normalized')
            .description('Output shape: "normalized" (trimmed) or "raw" (full Scrapper JSON).'),
        }
      : {}
  const inputSchema = buildScrapperSchema(verb.specs, fixed, defaults, extra)

  return new Tool({
    name: toolName,
    description: config.description ?? verb.defaultDescription,
    inputSchema,
    artifactConstructor,
    handler: async (args) => {
      const a = args as Record<string, unknown> & { url: string; format?: 'normalized' | 'raw' }
      try {
        const format: 'normalized' | 'raw' =
          resultFormat === 'either' ? (a.format ?? 'normalized') : resultFormat

        const headers: ToolHeaders = {
          Accept: 'application/json',
          ...(await resolveHeaders(config.headers)),
        }

        const params = buildWireParams(a, verb.specs, fixed, config.fixedQuery)
        const stash = new Map<string, unknown>()

        const requestCtx: ScrapperRequestContext = {
          toolName,
          url: a.url,
          params,
          headers,
          instanceUrl,
          stash,
          shortCircuit: makeShortCircuit(),
        }

        if (hasInput) {
          const short = await runInputPipeline(inputMw, requestCtx, 'Scrapper')
          if (short !== undefined) return short
        }

        const url = new URL(verb.endpoint, instanceUrl + '/')
        url.searchParams.set('url', requestCtx.url)
        for (const [k, v] of Object.entries(requestCtx.params)) url.searchParams.set(k, v)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
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
          let body: unknown
          try {
            body = await response.json()
          } catch {
            body = undefined
          }
          return `Error: Scrapper request failed — ${parseScrapperError(body, response.status, response.statusText)}.`
        }

        const body = (await response.json()) as Record<string, unknown>

        const responseCtx: ScrapperResponseContext<R> = {
          toolName,
          request: requestCtx,
          raw: body,
          result: verb.normalize(body),
          format,
          stash,
        }

        if (hasOutput) await runOutputPipeline(outputMw, responseCtx, 'Scrapper')

        if (typeof responseCtx.output === 'string') return responseCtx.output
        if (responseCtx.format === 'raw') return JSON.stringify(responseCtx.raw, null, 2)
        return JSON.stringify(responseCtx.result, null, 2)
      } catch (err) {
        if (isShortCircuit(err)) return err.result
        return `Error: ${isError(err) ? err.message : String(err)}`
      }
    },
  })
}

/** Validate `instanceUrl` and return the trailing-slash-normalised base. */
export const validateScrapperInstanceUrl = (config: { instanceUrl?: string }): string => {
  if (typeof config?.instanceUrl !== 'string' || config.instanceUrl.trim() === '') {
    failConfig('instanceUrl is required')
  }
  try {
    new URL(config.instanceUrl as string)
  } catch {
    failConfig(`instanceUrl is not a valid URL: ${config.instanceUrl}`)
  }
  return (config.instanceUrl as string).replace(/\/+$/, '')
}
