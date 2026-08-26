import { Tokenizable } from './tokenizable'
import { validator } from '@nhtio/validation'
import { SpooledArtifact } from './spooled_artifact'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { ENCODE_METHOD, DECODE_METHOD } from '../utils/encoder_symbols'
import { E_INVALID_INITIAL_RETRIEVABLE_VALUE } from '../exceptions/runtime'
import { artifactConstructorResolverSchema } from '../contracts/spooled_artifact_constructor'
import type { DateTime } from 'luxon'
import type { TokenEncoding } from './tokenizable'
import type { AdkEncodableSnapshot } from './encodable'
import type { ArtifactConstructorResolver } from './tool'

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
  /**
   * The retrieved content. A plain `string` or {@link @nhtio/adk!Tokenizable} for small inline text, or a
   * {@link @nhtio/adk!SpooledArtifact} when the extracted text is large and lives in a consumer
   * {@link @nhtio/adk/common!ByteStore} (persist it via {@link @nhtio/adk!DispatchContext.storeRetrievableBytes}, wrap
   * the returned reader in a `SpooledArtifact`, and pass it here). Reader-backed content keeps the
   * body out of the permanent heap, but token estimation and render still materialise it
   * transiently (see {@link Retrievable.estimateTokens}).
   */
  content: string | Tokenizable | SpooledArtifact
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
  /** Whether to render this record inline rather than as a retrievable handle; defaults to `false`. */
  inline?: boolean
  /** Resolver for the spooled-artifact constructor used when plain content is auto-spooled; defaults to `undefined` (the base artifact). */
  artifactConstructor?: ArtifactConstructorResolver
}

/**
 * A fully-resolved {@link RawRetrievable} where all fields have been validated and temporal
 * values normalised to Luxon `DateTime` instances.
 */
interface ResolvedRetrievable {
  id: string
  content: Tokenizable | SpooledArtifact
  trustTier: RetrievableTrustTier
  source?: string
  kind?: string
  score?: number
  createdAt: DateTime
  updatedAt: DateTime
  inline: boolean
  artifactConstructor?: ArtifactConstructorResolver
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
const contentSchema = validator.alternatives(
  validator.string(),
  validator.custom((value, helpers) => {
    if (Tokenizable.isTokenizable(value) || SpooledArtifact.isSpooledArtifact(value)) {
      return value
    }
    return helpers.error('any.invalid')
  })
)

const rawRetrievableSchema = validator.object<RawRetrievable>({
  id: validator.string().required(),
  content: contentSchema.required(),
  trustTier: validator
    .string()
    .valid('first-party', 'third-party-public', 'third-party-private')
    .required(),
  source: validator.string().optional(),
  kind: validator.string().optional(),
  score: validator.number().min(0).max(1).optional(),
  createdAt: validator.datetime().required(),
  updatedAt: validator.datetime().required(),
  inline: validator.boolean().default(false),
  artifactConstructor: artifactConstructorResolverSchema().optional(),
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
  /**
   * The retrieved content: a {@link @nhtio/adk!Tokenizable} (inline text) or a
   * {@link @nhtio/adk!SpooledArtifact} (reader-backed, large text living in a consumer store). Use
   * {@link Retrievable.estimateTokens} for budgeting and {@link Retrievable.contentString} to
   * materialise the body at render time.
   */
  declare readonly content: Tokenizable | SpooledArtifact
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
  /** Whether this record is rendered inline; defaults to `false` (handle mode for spooled content). */
  declare readonly inline: boolean
  /** Producer-declared resolver for the artifact subclass used during auto-spooling, if any. */
  declare readonly artifactConstructor: ArtifactConstructorResolver | undefined
  /** Whether a non-inline spooled artifact lacks cached size metadata. */
  declare readonly sizeUnknown: boolean

  #id: string
  #content: Tokenizable | SpooledArtifact
  #trustTier: RetrievableTrustTier
  #source: string | undefined
  #kind: string | undefined
  #score: number | undefined
  #createdAt: DateTime
  #updatedAt: DateTime
  #inline: boolean
  #artifactConstructor: ArtifactConstructorResolver | undefined

  /**
   * @param raw - The raw retrievable input validated against `rawRetrievableSchema`.
   * @throws {@link @nhtio/adk/exceptions!E_INVALID_INITIAL_RETRIEVABLE_VALUE} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawRetrievable) {
    let resolved: ResolvedRetrievable
    try {
      resolved = validateOrThrow<ResolvedRetrievable>(rawRetrievableSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_RETRIEVABLE_VALUE({
        cause: isError(err) ? err : undefined,
      })
    }
    this.#id = resolved.id
    this.#content =
      Tokenizable.isTokenizable(resolved.content) ||
      SpooledArtifact.isSpooledArtifact(resolved.content)
        ? resolved.content
        : new Tokenizable(resolved.content)
    this.#trustTier = resolved.trustTier
    this.#source = resolved.source
    this.#kind = resolved.kind
    this.#score = resolved.score
    this.#createdAt = resolved.createdAt
    this.#updatedAt = resolved.updatedAt
    this.#inline = resolved.inline
    this.#artifactConstructor = resolved.artifactConstructor

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
      inline: {
        get: () => this.#inline,
        enumerable: true,
        configurable: false,
      },
      artifactConstructor: {
        get: () => this.#artifactConstructor,
        enumerable: true,
        configurable: false,
      },
      sizeUnknown: {
        get: () =>
          SpooledArtifact.isSpooledArtifact(this.#content) &&
          !this.#inline &&
          !this.#content.hasSizeHints(),
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Estimates the token count of the content under `encoding`.
   *
   * @remarks
   * Delegates to the content's own `estimateTokens`: synchronous for a {@link @nhtio/adk!Tokenizable}
   * (returns `number`), asynchronous for a {@link @nhtio/adk!SpooledArtifact} (returns
   * `Promise<number>`, reading the bytes from the backing store on demand). Both shapes satisfy the
   * adapter's token-budget path, which already awaits estimates.
   *
   * Note: the `SpooledArtifact` branch materialises the full decoded string transiently to count
   * tokens — reader-backing keeps the body off the *permanent* heap, but does not eliminate the
   * transient allocation at budgeting time.
   *
   * @param encoding - The encoding identifier to use for counting.
   * @returns The estimated token count.
   */
  estimateTokens(encoding: TokenEncoding): number | Promise<number> {
    if (
      SpooledArtifact.isSpooledArtifact(this.#content) &&
      !this.#inline &&
      this.#content.hasSizeHints()
    ) {
      return this.#content.estimateHandleTokens(this.#id, encoding)
    }
    return this.#content.estimateTokens(encoding)
  }

  /**
   * Returns the content body as a single string.
   *
   * @remarks
   * For a {@link @nhtio/adk!Tokenizable} this is synchronous in effect (resolved immediately); for a
   * {@link @nhtio/adk!SpooledArtifact} it reads the full body from the backing store via
   * {@link @nhtio/adk!SpooledArtifact.asString}. Always returns a `Promise` so callers have one
   * code path; render helpers `await` it at the point the trust-tier envelope is built.
   *
   * @returns The full content body as a string.
   */
  async contentString(): Promise<string> {
    return SpooledArtifact.isSpooledArtifact(this.#content)
      ? this.#content.asString()
      : this.#content.toString()
  }

  /**
   * Serialise this Retrievable into an `@nhtio/encoder` snapshot.
   *
   * @remarks
   * Emits a {@link RawRetrievable}-shaped object; `content` is the live {@link @nhtio/adk!Tokenizable} or
   * {@link @nhtio/adk!SpooledArtifact} (the encoder recurses — a reader-backed artifact round-trips as a
   * handle, throwing {@link @nhtio/adk!E_READER_NOT_DESCRIBABLE} if its reader cannot describe itself).
   * Round-trips via {@link Retrievable.[DECODE_METHOD]}, which re-validates through the constructor.
   *
   * @returns A {@link RawRetrievable}-shaped snapshot.
   */
  [ENCODE_METHOD](): AdkEncodableSnapshot {
    return {
      id: this.#id,
      content: this.#content,
      trustTier: this.#trustTier,
      source: this.#source,
      kind: this.#kind,
      score: this.#score,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      inline: this.#inline,
      artifactConstructor: this.#artifactConstructor,
    }
  }

  /**
   * Reconstruct a {@link Retrievable} from a {@link Retrievable.[ENCODE_METHOD]} snapshot.
   *
   * @param data - The snapshot produced by {@link Retrievable.[ENCODE_METHOD]}.
   * @returns A fully-validated {@link Retrievable}.
   */
  static [DECODE_METHOD](data: AdkEncodableSnapshot): Retrievable {
    return new Retrievable(data as RawRetrievable)
  }
}
