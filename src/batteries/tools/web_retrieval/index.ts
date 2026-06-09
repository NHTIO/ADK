/**
 * RAG glue: turn web-search and web-scrape results into `Retrievable` records for a turn.
 *
 * @module @nhtio/adk/batteries/tools/web_retrieval
 *
 * @remarks
 * The seam from "I searched / scraped something" to "it is in the turn as a `Retrievable`",
 * shared by the SearXNG and Scrapper batteries. It is deliberately **decoupled** from the ADK
 * core at runtime:
 *
 * - The converters are **pure** `(payload) => RawRetrievable[]` — they build plain data objects and
 *   never instantiate a core class, so the module's only core coupling is erased `import type`.
 * - The recommended spool-artifact type travels as an **open resolver**
 *   ({@link @nhtio/adk/forge!ArtifactConstructorResolver}), never a closed string enum — a consumer's
 *   future YAML/HTML `SpooledArtifact` subclass works with no change here. The converter hands the
 *   recommendation to the caller's `spool` hook; the caller owns the actual class import.
 * - The one helper that must construct a `Retrievable` ({@link storeRetrievables}) takes the
 *   constructor via a **resolver** (constructor / sync / async / dynamic-import), exactly like the
 *   vector battery's `createVectorStore` `client`.
 *
 * Web content is `'third-party-public'` by default — a definitional constant for open-web data
 * (NOT inferred from the URL, which CONTRIBUTING Design Decision #12 forbids); override via
 * `trustTier` when you know better.
 */

import { sha256 } from 'js-sha256'
import { isInstanceOf } from '@nhtio/adk/guards'
import type { SpooledArtifact } from '@nhtio/adk/spooled_artifact'
import type { ArtifactConstructorResolver } from '@nhtio/adk/forge'
import type { RawRetrievable, Retrievable, RetrievableTrustTier } from '@nhtio/adk/common'

/** A constructor that builds a {@link @nhtio/adk!Retrievable} from a {@link @nhtio/adk!RawRetrievable}. */
export type RetrievableCtor = new (raw: RawRetrievable) => Retrievable

/** A resolver of `T`: the value itself, or a (sync/async) thunk, optionally a module `{ default }`. */
export type Resolver<T> = T | (() => T | { default: T }) | (() => Promise<T | { default: T }>)

/**
 * A reader-backed-artifact hook. Called by a converter for content that may be large; the
 * converter passes the artifact constructor it **recommends** for this content (an open
 * {@link @nhtio/adk/forge!ArtifactConstructorResolver}) so the caller can wrap with the right
 * subclass — preserving its forged query tools — using the caller's own core import. Return a
 * {@link @nhtio/adk!SpooledArtifact} to store the content reader-backed, or `undefined` to keep it
 * inline as a string.
 */
export type SpoolHook = (
  id: string,
  text: string,
  recommended: ArtifactConstructorResolver
) => SpooledArtifact | undefined

/** Options common to every converter. */
export interface ToRetrievableOptions {
  /**
   * Trust tier for the produced records. Default `'third-party-public'` (web content is
   * third-party by definition — this is a constant, not URL inference).
   */
  trustTier?: RetrievableTrustTier
  /** Semantic `kind` label, e.g. `'web-search-result'`, `'web-article'`, `'web-links'`. */
  kind?: string
  /** Prefix for the stable, hashed record id (namespacing across sources). */
  idPrefix?: string
  /** Optional reader-backed-artifact hook for large content. See {@link SpoolHook}. */
  spool?: SpoolHook
}

/**
 * The artifact-resolver recommendations a caller may supply so the glue names no concrete class
 * itself. Each converter asks for the relevant key; if the caller omits it, content stays inline.
 */
export interface ArtifactRecommendations {
  /** Recommended for plain-text / HTML content (base `SpooledArtifact`). */
  text?: ArtifactConstructorResolver
  /** Recommended for markdown content (`SpooledMarkdownArtifact`). */
  markdown?: ArtifactConstructorResolver
  /** Recommended for JSON content (`SpooledJsonArtifact`). */
  json?: ArtifactConstructorResolver
}

const nowIso = (): string => new Date().toISOString()

/** A stable, unguessable id derived from a source string (URL) plus an optional prefix. */
const stableId = (prefix: string | undefined, source: string): string => {
  const h = sha256(source)
  return prefix ? `${prefix}:${h}` : h
}

/** Clamp a possibly-unbounded score into `[0, 1]`; drop non-finite. */
const clampScore = (score: unknown): number | undefined => {
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
  if (score < 0) return 0
  if (score > 1) return 1
  return score
}

/**
 * Resolve content to either an inline string or a caller-provided {@link SpooledArtifact}. When a
 * `spool` hook is supplied it is offered the recommended resolver; whatever it returns (artifact or
 * `undefined`→inline) is used.
 */
const resolveContent = (
  id: string,
  text: string,
  opts: ToRetrievableOptions,
  recommended: ArtifactConstructorResolver
): string | SpooledArtifact => {
  if (opts.spool) {
    const artifact = opts.spool(id, text, recommended)
    if (artifact) return artifact
  }
  return text
}

// ── SearXNG ──────────────────────────────────────────────────────────────────

/** Minimal structural shape of a SearXNG normalised result the converter reads. */
export interface SearxngResultLike {
  /** Result URL (becomes the record's `source`). */
  url?: string
  /** Result title (joined into the inline content). */
  title?: string
  /** Result snippet (joined into the inline content). */
  content?: string
  /** Relevance score (clamped to `[0,1]` on the record). */
  score?: number
}
/** Minimal structural shape of a SearXNG normalised payload. */
export interface SearxngPayloadLike {
  /** The result list. */
  results?: SearxngResultLike[]
}

/**
 * Convert a SearXNG normalised payload into one {@link @nhtio/adk!RawRetrievable} per result.
 *
 * @remarks
 * Snippets are short, so `content` stays an inline string (the `spool` hook, if any, is still
 * offered the `text` recommendation). `source` is the result URL; `score` is clamped to `[0,1]`.
 *
 * @param payload - The SearXNG normalised payload (`{ results: [{ url, title, content, score }] }`).
 * @param opts - Trust tier, kind, id prefix, optional spool hook.
 * @param recommend - Optional artifact-resolver recommendations (the glue names no class itself).
 * @returns One `RawRetrievable` per result.
 */
export const searxngResultsToRetrievables = (
  payload: SearxngPayloadLike,
  opts: ToRetrievableOptions = {},
  recommend: ArtifactRecommendations = {}
): RawRetrievable[] => {
  const trustTier: RetrievableTrustTier = opts.trustTier ?? 'third-party-public'
  const kind = opts.kind ?? 'web-search-result'
  const created = nowIso()
  const results = payload.results ?? []
  return results.map((r, i) => {
    const source = r.url ?? ''
    const id = stableId(opts.idPrefix, source || `${kind}:${i}`)
    const text = [r.title, r.content].filter((s): s is string => typeof s === 'string').join('\n')
    const recommended = recommend.text ?? recommend.markdown ?? recommend.json
    const content = recommended ? resolveContent(id, text, opts, recommended) : text
    const raw: RawRetrievable = {
      id,
      content,
      trustTier,
      kind,
      createdAt: created,
      updatedAt: created,
    }
    if (source) raw.source = source
    const score = clampScore(r.score)
    if (score !== undefined) raw.score = score
    return raw
  })
}

// ── Scrapper: article ──────────────────────────────────────────────────────────

/** Minimal structural shape of a Scrapper normalised article. */
export interface ScrapperArticleLike {
  /** The page URL (becomes the record's `source`). */
  url?: string
  /** Article title. */
  title?: string
  /** Article text with HTML stripped (the default content source). */
  textContent?: string
  /** Processed article HTML (the `'content'` content source). */
  content?: string
}

/** Which article text field to use as the record content. */
export type ArticleContentSource = 'textContent' | 'content'

/** Options for {@link scrapperArticleToRetrievable}. */
export interface ArticleToRetrievableOptions extends ToRetrievableOptions {
  /** Which field to use as content (default `'textContent'`). `'content'` is HTML. */
  contentSource?: ArticleContentSource
  /**
   * Whether the chosen content is markdown (recommend `markdown`) rather than plain text.
   * Default false. Use when an output pipeline rendered the article to markdown.
   */
  asMarkdown?: boolean
}

/**
 * Convert a Scrapper normalised article into a single {@link @nhtio/adk!RawRetrievable}.
 *
 * @remarks
 * Long article text is exactly what a reader-backed {@link @nhtio/adk!SpooledArtifact} is for: pass a
 * `spool` hook and the converter offers it the recommended artifact resolver (markdown when
 * `asMarkdown`, else text/HTML) so the model gets the right forged query tools. Without a hook,
 * content stays inline.
 *
 * @param article - The Scrapper normalised article.
 * @param opts - Trust tier, kind, id prefix, content source, markdown flag, optional spool hook.
 * @param recommend - Optional artifact-resolver recommendations.
 * @returns A single `RawRetrievable`.
 */
export const scrapperArticleToRetrievable = (
  article: ScrapperArticleLike,
  opts: ArticleToRetrievableOptions = {},
  recommend: ArtifactRecommendations = {}
): RawRetrievable => {
  const trustTier: RetrievableTrustTier = opts.trustTier ?? 'third-party-public'
  const kind = opts.kind ?? 'web-article'
  const created = nowIso()
  const source = article.url ?? ''
  const id = stableId(opts.idPrefix, source || kind)
  const field = opts.contentSource ?? 'textContent'
  const text = (field === 'content' ? article.content : article.textContent) ?? ''
  const recommended = opts.asMarkdown ? (recommend.markdown ?? recommend.text) : recommend.text
  const content = recommended ? resolveContent(id, text, opts, recommended) : text
  const raw: RawRetrievable = {
    id,
    content,
    trustTier,
    kind,
    createdAt: created,
    updatedAt: created,
  }
  if (source) raw.source = source
  return raw
}

// ── Scrapper: links ──────────────────────────────────────────────────────────

/** Minimal structural shape of a Scrapper normalised link. */
export interface ScrapperLinkLike {
  /** The link's target URL (becomes the record's `source`). */
  url?: string
  /** The link's anchor text (becomes the record's content). */
  text?: string
}
/** Minimal structural shape of a Scrapper normalised links payload. */
export interface ScrapperLinksLike {
  /** The page URL the links were collected from. */
  url?: string
  /** The collected links. */
  links?: ScrapperLinkLike[]
}

/**
 * Convert a Scrapper normalised links payload into one {@link @nhtio/adk!RawRetrievable} per link.
 *
 * @remarks
 * Each link's `text` becomes the (inline) content and its `url` the `source`. Link text is short,
 * so no spooling is applied.
 *
 * @param payload - The Scrapper normalised links payload (`{ links: [{ url, text }] }`).
 * @param opts - Trust tier, kind, id prefix.
 * @returns One `RawRetrievable` per link.
 */
export const scrapperLinksToRetrievables = (
  payload: ScrapperLinksLike,
  opts: ToRetrievableOptions = {}
): RawRetrievable[] => {
  const trustTier: RetrievableTrustTier = opts.trustTier ?? 'third-party-public'
  const kind = opts.kind ?? 'web-link'
  const created = nowIso()
  const links = payload.links ?? []
  return links.map((l, i) => {
    const source = l.url ?? ''
    const id = stableId(opts.idPrefix, source || `${kind}:${i}`)
    const raw: RawRetrievable = {
      id,
      content: l.text ?? source,
      trustTier,
      kind,
      createdAt: created,
      updatedAt: created,
    }
    if (source) raw.source = source
    return raw
  })
}

// ── Store helper (the single core-touching function) ─────────────────────────

/** The minimal context surface {@link storeRetrievables} needs. */
export interface RetrievableStoreCtx {
  /** Persist a single `Retrievable` into the turn (a `DispatchContext` method, or a stub). */
  storeRetrievable: (v: Retrievable) => unknown | Promise<unknown>
}

/**
 * Resolve a {@link Resolver} of the `Retrievable` constructor (sync / async / `{ default }`).
 *
 * @remarks
 * Both a bare class and a resolver are `typeof 'function'`, and we hold `Retrievable` only as an
 * `import type` (no runtime value to duck-type against). We disambiguate by behaviour: invoking a
 * real ES class without `new` throws, so a bare constructor is caught and returned as-is; a resolver
 * invokes cleanly and yields the constructor (possibly via a Promise and/or a `{ default }`).
 */
const resolveRetrievableCtor = async (
  resolver: Resolver<RetrievableCtor>
): Promise<RetrievableCtor> => {
  if (typeof resolver !== 'function') {
    throw new TypeError('retrievable must be a constructor or a resolver returning one')
  }
  let resolved: unknown
  try {
    resolved = (resolver as () => unknown)()
  } catch {
    return resolver as RetrievableCtor // bare class: threw on no-`new` invocation
  }
  if (isInstanceOf(resolved, 'Promise', Promise)) resolved = await resolved
  if (resolved && typeof resolved === 'object' && 'default' in resolved) {
    resolved = (resolved as { default?: unknown }).default
  }
  if (typeof resolved === 'function') return resolved as RetrievableCtor
  return resolver as RetrievableCtor // resolver returned a non-function: it was itself the ctor
}

/**
 * Construct {@link @nhtio/adk!Retrievable}s from `RawRetrievable`s and store each via `ctx`.
 *
 * @remarks
 * This is the only function here that touches a core class, and it does so through an injected
 * **resolver** (`deps.retrievable`) so the glue itself never value-imports `Retrievable`. Each
 * record's `RawRetrievable` validation (including the required `trustTier`) fires at construction.
 * For reader-backed content, the caller's `spool` hook will typically have used
 * `ctx.storeRetrievableBytes` already; this helper just persists the records into the turn.
 *
 * @param ctx - Anything with a `storeRetrievable` method (a `DispatchContext`, or a stub).
 * @param raws - The plain records from the converters.
 * @param deps - `{ retrievable }`: the `Retrievable` constructor or a resolver of it.
 * @returns The constructed `Retrievable` instances, in input order.
 */
export const storeRetrievables = async (
  ctx: RetrievableStoreCtx,
  raws: RawRetrievable[],
  deps: { retrievable: Resolver<RetrievableCtor> }
): Promise<Retrievable[]> => {
  const Ctor = await resolveRetrievableCtor(deps.retrievable)
  const out: Retrievable[] = []
  for (const raw of raws) {
    const record = new Ctor(raw)
    await ctx.storeRetrievable(record)
    out.push(record)
  }
  return out
}
