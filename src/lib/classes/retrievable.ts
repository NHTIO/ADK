import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { E_INVALID_INITIAL_RETRIEVABLE_VALUE } from '../exceptions/runtime'
import type { DateTime } from 'luxon'

/**
 * Trust-tier discriminator declared by the retrieval middleware at construction time. Drives
 * which envelope the LLM battery wraps the record in.
 *
 * @remarks
 * Vocabulary deliberately mirrors the published security-research taxonomy ("first-party /
 * third-party" per *Hidden-in-Plain-Text* WWW '26 and *When AI Meets the Web* IEEE S&P 2026)
 * and explicitly avoids the words "user" or "system" so the names cannot leak into the model's
 * OpenAI-Model-Spec role-tier authority resolution.
 *
 * - `'first-party'` — deployer-vetted corpora (signed internal docs, policy KBs, curated
 *   reference material). Rendered as a `<retrieved_corpus>` parent with per-record nonce-keyed
 *   `<retrieved>` children. The label "first-party" never appears in the envelope itself.
 * - `'third-party-public'` — open-web scrapes, search results, public APIs. Rendered through
 *   the untrusted-content envelope with `kind: 'retrieved-third-party-public'`.
 * - `'third-party-private'` — user uploads, pasted attachments, partner APIs. Rendered through
 *   the untrusted-content envelope with `kind: 'retrieved-third-party-private'`.
 */
export type RetrievableTrustTier = 'first-party' | 'third-party-public' | 'third-party-private'

/**
 * Plain input object supplied to {@link Retrievable} at construction time.
 *
 * @remarks
 * Validated against `rawRetrievableSchema` before the `Retrievable` instance is created.
 * Temporal fields accept any value that Luxon can parse — ISO strings, Unix timestamps,
 * `Date` objects, or existing `DateTime` instances.
 */
export interface RawRetrievable {
  /**
   * Stable unique identifier for this retrieved record. Used as the closing-tag nonce in the
   * rendered envelope, so it must be unguessable from the payload.
   */
  id: string
  /** The retrieved content as a plain string or an existing {@link @nhtio/adk!Tokenizable} instance. */
  content: string | Tokenizable
  /**
   * Trust tier declared by the retrieval middleware at construction time. Required — there is
   * NO default. The decision must be conscious. See {@link RetrievableTrustTier}.
   */
  trustTier: RetrievableTrustTier
  /** Optional provenance string: URL, document path, knowledge-base id, etc. */
  source?: string
  /** Optional semantic label: 'policy' | 'reference' | 'web-page' | 'pdf' | etc. */
  kind?: string
  /** Optional relevance / similarity score in `[0, 1]` from the retrieval middleware. */
  score?: number
  /** When the source record was created (publication date, upload date, etc.). */
  createdAt: string | number | Date | DateTime
  /** When the source record was last modified. */
  updatedAt: string | number | Date | DateTime
}

/**
 * A fully-resolved {@link RawRetrievable} where all fields have been validated and temporal
 * values normalised to Luxon `DateTime` instances.
 */
interface ResolvedRetrievable {
  id: string
  content: Tokenizable
  trustTier: RetrievableTrustTier
  source?: string
  kind?: string
  score?: number
  createdAt: DateTime
  updatedAt: DateTime
}

/**
 * Validator schema used to validate a {@link RawRetrievable} before constructing a
 * {@link Retrievable}.
 *
 * @remarks
 * - `id` — required non-empty string.
 * - `content` — required {@link @nhtio/adk!Tokenizable.schema}.
 * - `trustTier` — required, one of `'first-party'`, `'third-party-public'`,
 *   `'third-party-private'`. Unknown / missing values reject.
 * - `source` / `kind` — optional strings.
 * - `score` — optional number in `[0, 1]`.
 * - `createdAt` / `updatedAt` — required datetime-parseable values.
 *
 * Throws {@link @nhtio/adk/exceptions!E_INVALID_INITIAL_RETRIEVABLE_VALUE} (via the {@link Retrievable} constructor)
 * when validation fails.
 */
const rawRetrievableSchema = validator.object<RawRetrievable>({
  id: validator.string().required(),
  content: Tokenizable.schema.required(),
  trustTier: validator
    .string()
    .valid('first-party', 'third-party-public', 'third-party-private')
    .required(),
  source: validator.string().optional(),
  kind: validator.string().optional(),
  score: validator.number().min(0).max(1).optional(),
  createdAt: validator.datetime().required(),
  updatedAt: validator.datetime().required(),
})

/**
 * An immutable, validated retrieved record (RAG content) held by the agent.
 *
 * @remarks
 * Peer of {@link @nhtio/adk!Memory} / `Message` / `Thought` / `ToolCall`. Carries an explicit `trustTier`
 * that LLM batteries branch on to choose the rendering envelope. The retrieval middleware that
 * produced the record is the only party that knows its provenance — batteries MUST NOT
 * auto-classify or infer the tier from `source`.
 */
export class Retrievable {
  /**
   * Validator schema that accepts a {@link RawRetrievable} object.
   *
   * @remarks
   * Reusable fragment for any schema that needs to validate or nest a retrievable record.
   */
  public static schema = rawRetrievableSchema

  /**
   * Returns `true` if `value` is a {@link Retrievable} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   */
  public static isRetrievable(value: unknown): value is Retrievable {
    return isInstanceOf(value, 'Retrievable', Retrievable)
  }

  /** Stable unique identifier for this retrieved record. */
  declare readonly id: string
  /** The retrieved content as a {@link @nhtio/adk!Tokenizable} for inline token estimation. */
  declare readonly content: Tokenizable
  /** Trust tier declared by the retrieval middleware. */
  declare readonly trustTier: RetrievableTrustTier
  /** Optional provenance string. */
  declare readonly source: string | undefined
  /** Optional semantic label. */
  declare readonly kind: string | undefined
  /** Optional relevance / similarity score in `[0, 1]`. */
  declare readonly score: number | undefined
  /** When the source record was created. */
  declare readonly createdAt: DateTime
  /** When the source record was last modified. */
  declare readonly updatedAt: DateTime

  #id: string
  #content: Tokenizable
  #trustTier: RetrievableTrustTier
  #source: string | undefined
  #kind: string | undefined
  #score: number | undefined
  #createdAt: DateTime
  #updatedAt: DateTime

  /**
   * @param raw - The raw retrievable input validated against `rawRetrievableSchema`.
   * @throws {@link @nhtio/adk/exceptions!E_INVALID_INITIAL_RETRIEVABLE_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawRetrievable) {
    let resolved: ResolvedRetrievable
    try {
      resolved = validateOrThrow<ResolvedRetrievable>(rawRetrievableSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_RETRIEVABLE_VALUE({ cause: isError(err) ? err : undefined })
    }
    this.#id = resolved.id
    this.#content = Tokenizable.isTokenizable(resolved.content)
      ? resolved.content
      : new Tokenizable(resolved.content)
    this.#trustTier = resolved.trustTier
    this.#source = resolved.source
    this.#kind = resolved.kind
    this.#score = resolved.score
    this.#createdAt = resolved.createdAt
    this.#updatedAt = resolved.updatedAt

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      content: {
        get: () => this.#content,
        enumerable: true,
        configurable: false,
      },
      trustTier: {
        get: () => this.#trustTier,
        enumerable: true,
        configurable: false,
      },
      source: {
        get: () => this.#source,
        enumerable: true,
        configurable: false,
      },
      kind: {
        get: () => this.#kind,
        enumerable: true,
        configurable: false,
      },
      score: {
        get: () => this.#score,
        enumerable: true,
        configurable: false,
      },
      createdAt: {
        get: () => this.#createdAt,
        enumerable: true,
        configurable: false,
      },
      updatedAt: {
        get: () => this.#updatedAt,
        enumerable: true,
        configurable: false,
      },
    })
  }
}
