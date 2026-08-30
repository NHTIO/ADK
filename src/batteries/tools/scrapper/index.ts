/**
 * Factories for configured Scrapper web-extraction tools (article + links).
 *
 * @module @nhtio/adk/batteries/tools/scrapper
 *
 * @remarks
 * [Scrapper](https://github.com/amerkurev/scrapper) is a self-hosted service that loads a page in a
 * real headless browser and extracts either the readable article (`/api/article`) or the page's
 * links (`/api/links`). It gives an agent browser-grade reading power — JS-rendered pages a
 * renderless fetcher can't see — but as a **stateless** HTTP call: each request runs in a fresh
 * incognito context, stores no session or credentials, and shares nothing with any other call.
 *
 * Like the SearXNG battery, this exports **factories** (not ready-made `Tool` constants), because a
 * scrape tool needs per-deployment config (instance URL + custom auth headers). Two verbs, each with
 * an async factory ({@link createScrapperArticleTool} / {@link createScrapperLinksTool}, accepting a
 * dynamic-import `artifact` resolver) and a sync variant ({@link createScrapperArticleToolSync} /
 * {@link createScrapperLinksToolSync}). Because these are factories, they MUST NOT be bulk-registered
 * via `Object.values(batteries)` — call one, then register the returned tool.
 *
 * @see https://github.com/amerkurev/scrapper
 */

import { validator } from '@nhtio/validation'
import { SpooledJsonArtifact } from '@nhtio/adk/spooled_artifact'
import { resolveArtifact, resolveArtifactSync } from '../_shared'
import {
  failConfig,
  validateScrapperInstanceUrl,
  assembleScrapperTool,
  type ScrapperBaseConfig,
  type ScrapperParamSpec,
  type ScrapperVerb,
} from './shared'
import type { Tool } from '@nhtio/adk/forge'
import type { ArtifactResolver, SyncArtifactResolver } from '../_shared'

export { E_INVALID_SCRAPPER_CONFIG } from './exceptions'
export type {
  ScrapperRequestContext,
  ScrapperResponseContext,
  ScrapperInputMiddlewareFn,
  ScrapperOutputMiddlewareFn,
} from './shared'

// ── Param sets ───────────────────────────────────────────────────────────────

/** Model-facing params common to both verbs (snake_case; mapped to kebab on the wire). */
export interface ScrapperCommonParams {
  /** Return a cached result when available instead of re-scraping. */
  cache?: boolean
  /** Capture a screenshot; the result carries a `screenshotUri`. */
  screenshot?: boolean
  /** Run in an incognito browser context (no persisted browsing data). Default true upstream. */
  incognito?: boolean
  /** Browser navigation timeout in ms (`0` disables). Distinct from the tool's own fetch timeout. */
  timeout?: number
  /** When navigation is considered finished. */
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
  /** Wait this many ms after load before parsing. */
  sleep?: number
  /** Scroll down N pixels for lazy-loading pages. Requires a positive `sleep`. */
  scroll_down?: number
  /** Emulated device, e.g. `Desktop Chrome`. Overrides individual viewport/UA settings. */
  device?: string
  /** Explicit user-agent (prefer `device`). */
  user_agent?: string
  /** Extra headers the SCRAPER's browser sends to the TARGET site, `K:v;K2:v2` (NOT instance auth). */
  extra_http_headers?: string
  /** Upstream proxy, e.g. `http://host:3128` or `socks5://host:1080`. */
  proxy_server?: string
}

/** Model-facing params for `/api/article`. */
export interface ScrapperArticleParams extends ScrapperCommonParams {
  /** Populate `fullContent` with the page's full HTML. */
  full_content?: boolean
}

/** Model-facing params for `/api/links`. */
export interface ScrapperLinksParams extends ScrapperCommonParams {
  /** Median link-text length threshold for the link parser. */
  text_len_threshold?: number
  /** Median words-per-link threshold for the link parser. */
  words_threshold?: number
}

const commonSpecs: ScrapperParamSpec[] = [
  {
    key: 'cache',
    wire: 'cache',
    type: 'boolean',
    schema: validator.boolean(),
    description: 'Return a cached result when available instead of re-scraping.',
  },
  {
    key: 'screenshot',
    wire: 'screenshot',
    type: 'boolean',
    schema: validator.boolean(),
    description: 'Capture a screenshot; the result carries a screenshotUri.',
  },
  {
    key: 'incognito',
    wire: 'incognito',
    type: 'boolean',
    schema: validator.boolean(),
    description: 'Run in an incognito browser context (no persisted data).',
  },
  {
    key: 'timeout',
    wire: 'timeout',
    type: 'number',
    schema: validator.number().min(0),
    description: 'Browser navigation timeout in ms (0 disables).',
  },
  {
    key: 'wait_until',
    wire: 'wait-until',
    type: 'string',
    schema: validator.string().valid('load', 'domcontentloaded', 'networkidle', 'commit'),
    description: 'When navigation is considered finished.',
  },
  {
    key: 'sleep',
    wire: 'sleep',
    type: 'number',
    schema: validator.number().min(0),
    description: 'Wait this many ms after load before parsing.',
  },
  {
    key: 'scroll_down',
    wire: 'scroll-down',
    type: 'number',
    schema: validator.number().min(0),
    description: 'Scroll down N pixels for lazy-loading pages (requires a positive sleep).',
  },
  {
    key: 'device',
    wire: 'device',
    type: 'string',
    schema: validator.string().allow(''),
    description:
      'Emulated device, e.g. "Desktop Chrome". Omit or send an empty string to leave it unset.',
  },
  {
    key: 'user_agent',
    wire: 'user-agent',
    type: 'string',
    schema: validator.string().allow(''),
    description:
      'Explicit user-agent (prefer device). Omit or send an empty string to leave it unset.',
  },
  {
    key: 'extra_http_headers',
    wire: 'extra-http-headers',
    type: 'string',
    schema: validator.string().allow(''),
    description:
      'Extra headers the scraper sends to the TARGET site, formatted "K:v;K2:v2". Omit or send an empty string to send none.',
  },
  {
    key: 'proxy_server',
    wire: 'proxy-server',
    type: 'string',
    schema: validator.string().allow(''),
    description:
      'Upstream proxy, e.g. "http://host:3128" or "socks5://host:1080". Omit or send an empty string to use no proxy.',
  },
]

const articleSpecs: ScrapperParamSpec[] = [
  ...commonSpecs,
  {
    key: 'full_content',
    wire: 'full-content',
    type: 'boolean',
    schema: validator.boolean(),
    description: 'Populate fullContent with the page full HTML.',
  },
]

const linksSpecs: ScrapperParamSpec[] = [
  ...commonSpecs,
  {
    key: 'text_len_threshold',
    wire: 'text-len-threshold',
    type: 'number',
    schema: validator.number().min(0),
    description: 'Median link-text length threshold for the link parser.',
  },
  {
    key: 'words_threshold',
    wire: 'words-threshold',
    type: 'number',
    schema: validator.number().min(0),
    description: 'Median words-per-link threshold for the link parser.',
  },
]

// ── Normalised result shapes ─────────────────────────────────────────────────

/** A normalised Scrapper article (loose/nullable upstream). */
export interface ScrapperArticle {
  /** The page URL the article was extracted from. */
  url?: string
  /** Article title. */
  title?: string
  /** Author / byline metadata. */
  byline?: string
  /** Short excerpt or description of the article. */
  excerpt?: string
  /** Name of the site the article came from. */
  siteName?: string
  /** Detected content language. */
  lang?: string
  /** Character count of the extracted article text. */
  length?: number
  /** Publication time, when the page exposed one. */
  publishedTime?: string
  /** Scrapper's own date field for the result. */
  date?: string
  /** Article text with HTML stripped. */
  textContent?: string
  /** Processed article HTML; present when the caller requested it. */
  content?: string
  /** Full page HTML; present only when `full_content` was set. */
  fullContent?: string
  /** Screenshot URI; present only when `screenshot` was set. */
  screenshotUri?: string
}

/** A single link from `/api/links` (verified live: `{ url, text }`). */
export interface ScrapperLink {
  /** The link's target URL. */
  url?: string
  /** The link's anchor text. */
  text?: string
}

/** A normalised Scrapper links payload. */
export interface ScrapperLinks {
  /** The page URL the links were collected from. */
  url?: string
  /** The page title. */
  title?: string
  /** The page's domain. */
  domain?: string
  /** Scrapper's own date field for the result. */
  date?: string
  /** The collected links, each `{ url, text }`. */
  links: ScrapperLink[]
  /** Screenshot URI; present only when `screenshot` was set. */
  screenshotUri?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

const normalizeArticle = (body: Record<string, unknown>): ScrapperArticle => {
  const out: ScrapperArticle = {}
  out.url = str(body.url)
  out.title = str(body.title)
  out.byline = str(body.byline)
  out.excerpt = str(body.excerpt)
  out.siteName = str(body.siteName)
  out.lang = str(body.lang)
  out.length = num(body.length)
  out.publishedTime = str(body.publishedTime)
  out.date = str(body.date)
  out.textContent = str(body.textContent)
  if (str(body.content)) out.content = str(body.content)
  if (str(body.fullContent)) out.fullContent = str(body.fullContent)
  if (str(body.screenshotUri)) out.screenshotUri = str(body.screenshotUri)
  // Drop undefined keys so the serialised payload stays tight.
  return JSON.parse(JSON.stringify(out)) as ScrapperArticle
}

const normalizeLinks = (body: Record<string, unknown>): ScrapperLinks => {
  const rawLinks = Array.isArray(body.links) ? body.links : []
  const links: ScrapperLink[] = rawLinks.map((l) => {
    const r = (l ?? {}) as Record<string, unknown>
    const item: ScrapperLink = {}
    if (str(r.url)) item.url = str(r.url)
    if (str(r.text)) item.text = str(r.text)
    return item
  })
  const out: ScrapperLinks = { links }
  if (str(body.url)) out.url = str(body.url)
  if (str(body.title)) out.title = str(body.title)
  if (str(body.domain)) out.domain = str(body.domain)
  if (str(body.date)) out.date = str(body.date)
  if (str(body.screenshotUri)) out.screenshotUri = str(body.screenshotUri)
  return out
}

const articleVerb: ScrapperVerb<ScrapperArticle> = {
  endpoint: '/api/article',
  specs: articleSpecs,
  defaultName: 'scrapper_article',
  defaultDescription:
    'Load a web page in a real (headless) browser and extract its readable article — title, ' +
    'byline, text content, and metadata. Renders JavaScript-heavy pages a plain fetch cannot. ' +
    'Each call is stateless (fresh incognito context, no stored session).',
  normalize: normalizeArticle,
}

const linksVerb: ScrapperVerb<ScrapperLinks> = {
  endpoint: '/api/links',
  specs: linksSpecs,
  defaultName: 'scrapper_links',
  defaultDescription:
    'Load a web page in a real (headless) browser and collect its article/navigation links ' +
    '(each { url, text }). Renders JavaScript-heavy index pages a plain fetch cannot. ' +
    'Each call is stateless (fresh incognito context, no stored session).',
  normalize: normalizeLinks,
}

// ── Config aliases ────────────────────────────────────────────────────────────

export type { ScrapperBaseConfig } from './shared'

/** Async-factory config for `/api/article` (full `artifact` resolver, incl. dynamic import). */
export type ScrapperArticleConfig = ScrapperBaseConfig<
  ScrapperArticleParams,
  ScrapperArticle,
  ArtifactResolver
>
/** Sync-factory config for `/api/article` (`artifact` narrowed to the sync subset). */
export type ScrapperArticleConfigSync = ScrapperBaseConfig<
  ScrapperArticleParams,
  ScrapperArticle,
  SyncArtifactResolver
>
/** Async-factory config for `/api/links`. */
export type ScrapperLinksConfig = ScrapperBaseConfig<
  ScrapperLinksParams,
  ScrapperLinks,
  ArtifactResolver
>
/** Sync-factory config for `/api/links`. */
export type ScrapperLinksConfigSync = ScrapperBaseConfig<
  ScrapperLinksParams,
  ScrapperLinks,
  SyncArtifactResolver
>

const defaultArtifact = () => SpooledJsonArtifact

// ── Factories ──────────────────────────────────────────────────────────────────

/**
 * Create a configured Scrapper **article** {@link Tool} (async — accepts a dynamic-import `artifact`).
 *
 * @remarks
 * Async because `artifact` may be an async / dynamic-import resolver, which must resolve to the sync
 * `() => Ctor` `Tool.artifactConstructor` requires before the tool is built. For the common case,
 * use {@link createScrapperArticleToolSync} and skip the `await`.
 *
 * @warning
 * Two distinct "headers": `config.headers` authenticates to the Scrapper *instance*; the
 * `extra_http_headers` *parameter* is what the scraper's browser sends to the *target site* — do not
 * conflate them. Also note `scroll_down` requires a positive `sleep`, and `resultUri`/`screenshotUri`
 * are instance-relative and may come back `http://` even over HTTPS — do not assume they match
 * `instanceUrl`.
 *
 * @param config - Instance URL, instance-auth headers, output policy, `artifact` resolver,
 *   per-parameter disposition (`fixed`/`defaults`/`fixedQuery`), and middleware pipelines.
 * @returns A promise of a `Tool` ready to register in a `ToolRegistry`.
 * @throws {@link E_INVALID_SCRAPPER_CONFIG} when `instanceUrl` or `artifact` is invalid.
 */
export const createScrapperArticleTool = async (config: ScrapperArticleConfig): Promise<Tool> => {
  const instanceUrl = validateScrapperInstanceUrl(config)
  const artifact = await resolveArtifact(config.artifact ?? defaultArtifact, failConfig)
  return assembleScrapperTool(articleVerb, config, instanceUrl, artifact)
}

/**
 * Synchronous {@link createScrapperArticleTool} — `artifact` narrowed to the sync subset.
 *
 * @param config - Same as {@link createScrapperArticleTool}, with a sync-only `artifact`.
 * @returns A `Tool` ready to register in a `ToolRegistry`.
 * @throws {@link E_INVALID_SCRAPPER_CONFIG} when `instanceUrl` or `artifact` is invalid (incl. an async resolver).
 */
export const createScrapperArticleToolSync = (config: ScrapperArticleConfigSync): Tool => {
  const instanceUrl = validateScrapperInstanceUrl(config)
  const artifact = resolveArtifactSync(config.artifact ?? defaultArtifact, failConfig)
  return assembleScrapperTool(articleVerb, config, instanceUrl, artifact)
}

/**
 * Create a configured Scrapper **links** {@link Tool} (async — accepts a dynamic-import `artifact`).
 *
 * @remarks
 * See {@link createScrapperArticleTool} for the two-headers caveat and the async rationale. Each
 * `links` item is `{ url, text }`.
 *
 * @param config - Instance URL, instance-auth headers, output policy, `artifact` resolver,
 *   per-parameter disposition, and middleware pipelines.
 * @returns A promise of a `Tool` ready to register in a `ToolRegistry`.
 * @throws {@link E_INVALID_SCRAPPER_CONFIG} when `instanceUrl` or `artifact` is invalid.
 */
export const createScrapperLinksTool = async (config: ScrapperLinksConfig): Promise<Tool> => {
  const instanceUrl = validateScrapperInstanceUrl(config)
  const artifact = await resolveArtifact(config.artifact ?? defaultArtifact, failConfig)
  return assembleScrapperTool(linksVerb, config, instanceUrl, artifact)
}

/**
 * Synchronous {@link createScrapperLinksTool} — `artifact` narrowed to the sync subset.
 *
 * @param config - Same as {@link createScrapperLinksTool}, with a sync-only `artifact`.
 * @returns A `Tool` ready to register in a `ToolRegistry`.
 * @throws {@link E_INVALID_SCRAPPER_CONFIG} when `instanceUrl` or `artifact` is invalid (incl. an async resolver).
 */
export const createScrapperLinksToolSync = (config: ScrapperLinksConfigSync): Tool => {
  const instanceUrl = validateScrapperInstanceUrl(config)
  const artifact = resolveArtifactSync(config.artifact ?? defaultArtifact, failConfig)
  return assembleScrapperTool(linksVerb, config, instanceUrl, artifact)
}
