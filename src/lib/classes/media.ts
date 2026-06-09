import { v6 as uuidv6 } from 'uuid'
import { Registry } from './registry'
import { isError } from '../utils/guards'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '../utils/guards'
import { validateOrThrow } from '../utils/validation'
import { implementsMediaReader, mediaReaderSchema } from '../contracts/media_reader'
import { E_INVALID_INITIAL_MEDIA_VALUE, E_NOT_A_MEDIA_READER } from '../exceptions/runtime'
import type { MediaReader } from '../contracts/media_reader'

/**
 * The set of supported media kinds.
 *
 * @remarks
 * Modality coverage is asymmetric across providers. The framework defines no
 * `supportedModalities` field — how a battery handles a modality it cannot natively render is
 * the battery author's call (see `unsupportedMediaPolicy` on the OpenAI Chat Completions
 * battery).
 */
export const MediaKind = ['image', 'audio', 'video', 'document'] as const

/**
 * Union of all recognised media kind identifier strings.
 */
export type MediaKind = (typeof MediaKind)[number]

/**
 * Provenance axis. *Who is the framework willing to vouch for as the source of these bytes?*
 *
 * @remarks
 * Mirrors `RetrievableTrustTier` deliberately — same vocabulary, same question:
 * *did this content come from a place the agent should treat as authoritative?*
 *
 * - `'first-party'` — deployer-vetted bytes (tool output the operator authored, signed
 *   internal assets).
 * - `'third-party-public'` — open-web fetches, public APIs, public corpora.
 * - `'third-party-private'` — user uploads, partner APIs, private corpora.
 */
export const MediaTrustTier = ['first-party', 'third-party-public', 'third-party-private'] as const
export type MediaTrustTier = (typeof MediaTrustTier)[number]

/**
 * Modality-hazard axis. *How dangerous is it to let the model decode these bytes?*
 *
 * @remarks
 * Orthogonal to provenance — a first-party trusted PDF can still carry hidden text layers; a
 * third-party-public raw image can still be encoded as opaque pixels with adversarial
 * perturbations.
 *
 * - `'inert'` — bytes the model never decodes as instructions (e.g. a handle that is never
 *   inlined into the prompt).
 * - `'extractable-instructions'` — text-bearing media: PDFs, screenshots with UI text, documents.
 *   Hazard is OCR / embedded-text-layer reads.
 * - `'opaque-perceptual'` — raw vision/audio/video the model encodes directly. Hazard is
 *   steganographic LSB prompts, adversarial perturbations, ultrasonic audio — invisible to any
 *   pre-screen.
 *
 * See `/the-loop/trust-tiers/media` and its research sub-page `/the-loop/trust-tiers/media/research`.
 */
export const MediaModalityHazard = [
  'inert',
  'extractable-instructions',
  'opaque-perceptual',
] as const
export type MediaModalityHazard = (typeof MediaModalityHazard)[number]

/**
 * Per-entry shape stored in a {@link Media}'s `stash` register.
 *
 * @remarks
 * Each entry carries its own trust tier so render code can route derived text (OCR, captions,
 * transcripts) through its own envelope independent of the parent media. How a battery or
 * middleware assigns those entry-level tiers is the implementor's call — the primitive contract
 * does not enforce a "downgrade derived interpretation from possibly-adversarial bytes" policy.
 */
export interface MediaStashEntry {
  /** The value of the entry — any serialisable shape the consumer wants to store. */
  value: unknown
  /** Trust tier for this specific entry; routed independently of the parent media. */
  trustTier: MediaTrustTier
  /** Optional pointer to the parent Media id this entry was derived from. */
  derivedFromMedia?: string
}

/**
 * Plain input object supplied to {@link Media} at construction time.
 *
 * @remarks
 * Validated against `rawMediaSchema` before the `Media` instance is created.
 */
export interface RawMedia {
  /**
   * Stable unique identifier for this media instance. Required for strict symmetry with
   * `Message.id` and `ToolCall.id`. When omitted, a fresh UUIDv6 is assigned at construction
   * time.
   */
  id?: string
  /** The media kind. See {@link MediaKind}. */
  kind: MediaKind
  /** The MIME type of the underlying bytes. */
  mimeType: string
  /** Filename used by providers that key on it (e.g. OpenAI `file.filename`). */
  filename: string
  /** Re-openable byte source. See {@link @nhtio/adk!MediaReader}. */
  reader: MediaReader
  /**
   * Trust tier declared at construction time. Required — there is NO default.
   * See {@link MediaTrustTier}.
   */
  trustTier: MediaTrustTier
  /**
   * Modality hazard declared at construction time. Required — there is NO default.
   * See {@link MediaModalityHazard}.
   */
  modalityHazard: MediaModalityHazard
  /** Optional provenance pointer (URL, tool name, etc.) for audit / events. */
  source?: string
  /**
   * Free-form per-instance metadata register. Middleware pipelines append to this — typically
   * with a text description, transcript, caption, or alt-text — so downstream code that cannot
   * consume the media natively has a model-readable fallback. No keys are reserved by the
   * framework. Defaults to `{}`.
   */
  stash?: Record<string, MediaStashEntry>
}

const stashEntrySchema = validator
  .object<MediaStashEntry>({
    value: validator.any().required(),
    trustTier: validator
      .string()
      .valid(...MediaTrustTier)
      .required(),
    derivedFromMedia: validator.string().optional(),
  })
  .unknown(false)

/**
 * Validator schema used to validate a {@link RawMedia} before constructing a {@link Media}.
 */
const rawMediaSchema = validator.object<RawMedia>({
  id: validator.string().optional(),
  kind: validator
    .string()
    .valid(...MediaKind)
    .required(),
  mimeType: validator.string().required(),
  filename: validator.string().required(),
  reader: mediaReaderSchema.required(),
  trustTier: validator
    .string()
    .valid(...MediaTrustTier)
    .required(),
  modalityHazard: validator
    .string()
    .valid(...MediaModalityHazard)
    .required(),
  source: validator.string().optional(),
  stash: validator.object().pattern(validator.string(), stashEntrySchema).optional(),
})

interface ResolvedMedia {
  id?: string
  kind: MediaKind
  mimeType: string
  filename: string
  reader: MediaReader
  trustTier: MediaTrustTier
  modalityHazard: MediaModalityHazard
  source?: string
  stash?: Record<string, MediaStashEntry>
}

const conservativeHazardForKind = (kind: MediaKind): MediaModalityHazard => {
  return kind === 'document' ? 'extractable-instructions' : 'opaque-perceptual'
}

/**
 * Shape returned by {@link Media.toJSON}. Metadata-only — bytes and the reader are stripped so
 * naive event/log serialisation never materialises bytes.
 */
/** The plain-object, JSON-safe form of a {@link Media} produced by {@link Media.toJSON}. */
export interface SerializedMedia {
  /** Stable identifier for this media asset. */
  id: string
  /** High-level modality of the asset (e.g. image, audio, document). */
  kind: MediaKind
  /** MIME type of the underlying bytes (e.g. `image/png`). */
  mimeType: string
  /** Original or suggested file name for the asset. */
  filename: string
  /** Optional provenance string (URL, path, or other origin marker). */
  source?: string
  /** Trust tier governing how the asset's content is framed to the model. */
  trustTier: MediaTrustTier
  /** Whether the modality can carry hidden instructions (`extractable-instructions`) or is opaque-perceptual. */
  modalityHazard: MediaModalityHazard
  /** Adapter-scoped side-channel data keyed by name (e.g. provider upload handles). */
  stash: Record<string, MediaStashEntry>
  /** Size of the underlying bytes in bytes, when known. */
  byteLength?: number
}

/**
 * Cross-environment base64 encoder for a `Uint8Array`.
 *
 * @remarks
 * Prefers Node's `Buffer.from(buf).toString('base64')` when `globalThis.Buffer` exists; otherwise
 * chunk-encodes through `btoa` with a 0x8000-byte window to avoid `Maximum call stack size
 * exceeded` on large buffers.
 */
const encodeBase64 = (bytes: Uint8Array): string => {
  const maybeBuffer = (
    globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }
  ).Buffer
  if (maybeBuffer && typeof maybeBuffer.from === 'function') {
    return maybeBuffer.from(bytes).toString('base64')
  }
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk) as number[])
  }
  return btoa(binary)
}

/**
 * Lazy, re-openable view over a binary asset (image, audio, video, document).
 *
 * @remarks
 * Dual-peer to {@link @nhtio/adk!Tokenizable} (silo) and {@link @nhtio/adk!SpooledArtifact}
 * (handle). Wraps a {@link @nhtio/adk!MediaReader} contract — the framework owns the contract, the
 * implementor owns the storage backend. Bytes are reached only through the reader; the primitive
 * itself never inlines bytes.
 *
 * Construction requires `trustTier` and `modalityHazard` — the framework refuses to guess
 * provenance or decoding hazard. Ergonomic factories ({@link Media.userAttachment},
 * {@link Media.toolGenerated}, {@link Media.retrievedPublic}, {@link Media.retrievedPrivate})
 * force the labelling decision at the call site without becoming defaults on the bare
 * constructor.
 */
export class Media {
  /**
   * Validator schema that accepts a {@link RawMedia} object.
   */
  public static schema = rawMediaSchema

  /**
   * The set of recognised media kinds. Exposed for downstream schemas that need to discriminate
   * on `kind`.
   */
  public static MediaKind = MediaKind

  /**
   * The set of recognised trust tiers.
   */
  public static MediaTrustTier = MediaTrustTier

  /**
   * The set of recognised modality hazards.
   */
  public static MediaModalityHazard = MediaModalityHazard

  /**
   * Returns `true` if `value` is a {@link Media} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Media} instance.
   */
  public static isMedia(value: unknown): value is Media {
    return isInstanceOf(value, 'Media', Media)
  }

  /** Stable unique identifier. */
  declare readonly id: string
  /** Media kind. */
  declare readonly kind: MediaKind
  /** MIME type of the underlying bytes. */
  declare readonly mimeType: string
  /** Filename surfaced to providers that key on it. */
  declare readonly filename: string
  /** Optional provenance pointer. */
  declare readonly source: string | undefined
  /** Trust tier declared at construction time. */
  declare readonly trustTier: MediaTrustTier
  /** Modality hazard declared at construction time. */
  declare readonly modalityHazard: MediaModalityHazard
  /** Mutable per-instance metadata register; middleware pipelines append to this. */
  declare readonly stash: Registry

  #id: string
  #kind: MediaKind
  #mimeType: string
  #filename: string
  #source?: string
  #trustTier: MediaTrustTier
  #modalityHazard: MediaModalityHazard
  #reader: MediaReader
  #stash: Registry

  /**
   * @param raw - The raw media input validated against `rawMediaSchema`.
   * @throws {@link @nhtio/adk/exceptions!E_INVALID_INITIAL_MEDIA_VALUE} when `raw` does not satisfy the schema.
   * @throws {@link @nhtio/adk/exceptions!E_NOT_A_MEDIA_READER} when `raw.reader` does not implement {@link @nhtio/adk!MediaReader}.
   */
  constructor(raw: RawMedia) {
    let resolved: ResolvedMedia
    try {
      resolved = validateOrThrow<ResolvedMedia>(rawMediaSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_INITIAL_MEDIA_VALUE({ cause: isError(err) ? err : undefined })
    }
    if (!implementsMediaReader(resolved.reader)) {
      throw new E_NOT_A_MEDIA_READER()
    }
    this.#id = resolved.id ?? uuidv6()
    this.#kind = resolved.kind
    this.#mimeType = resolved.mimeType
    this.#filename = resolved.filename
    this.#source = resolved.source
    this.#trustTier = resolved.trustTier
    this.#modalityHazard = resolved.modalityHazard
    this.#reader = resolved.reader
    this.#stash = new Registry(resolved.stash as Record<string, unknown> | undefined)

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      kind: {
        get: () => this.#kind,
        enumerable: true,
        configurable: false,
      },
      mimeType: {
        get: () => this.#mimeType,
        enumerable: true,
        configurable: false,
      },
      filename: {
        get: () => this.#filename,
        enumerable: true,
        configurable: false,
      },
      source: {
        get: () => this.#source,
        enumerable: true,
        configurable: false,
      },
      trustTier: {
        get: () => this.#trustTier,
        enumerable: true,
        configurable: false,
      },
      modalityHazard: {
        get: () => this.#modalityHazard,
        enumerable: true,
        configurable: false,
      },
      stash: {
        get: () => this.#stash,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /**
   * Re-opens the underlying byte source and returns a fresh ReadableStream.
   *
   * @returns A drainable `ReadableStream` over the underlying bytes.
   */
  async stream(): Promise<ReadableStream<Uint8Array>> {
    return this.#reader.stream()
  }

  /**
   * Returns the total number of bytes in the underlying data, or `undefined` if unknown.
   *
   * @returns The byte length, or `undefined` when the underlying source cannot report it.
   */
  async byteLength(): Promise<number | undefined> {
    return this.#reader.byteLength()
  }

  /**
   * Drains the reader's stream and returns the underlying bytes as a single `Uint8Array`.
   *
   * @remarks
   * Convenience for callers that need the full buffer (e.g. inline base64 encoding). Forces
   * full materialisation — large assets should be piped through {@link Media.stream} instead.
   */
  async asBytes(): Promise<Uint8Array> {
    const stream = await this.stream()
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  /**
   * Drains the reader's stream and returns the underlying bytes as a base64 string.
   *
   * @remarks
   * Cross-environment: prefers Node's `Buffer.from(buf).toString('base64')` when available;
   * otherwise chunk-encodes through `btoa` with a 0x8000-byte window to avoid stack overflow
   * on large buffers.
   */
  async asBase64(): Promise<string> {
    const bytes = await this.asBytes()
    return encodeBase64(bytes)
  }

  /**
   * Returns the metadata-only serialisation of this Media. Bytes and the reader are stripped
   * so naive event/log serialisation never materialises bytes.
   *
   * @remarks
   * Implementations that have cheap, already-cached `byteLength` may opt to include it; this
   * default implementation omits it to preserve the "lazy by default" invariant. Consumers that
   * need byteLength on the serialised payload should call `await media.byteLength()` and merge
   * the result.
   */
  toJSON(): SerializedMedia {
    return {
      id: this.#id,
      kind: this.#kind,
      mimeType: this.#mimeType,
      filename: this.#filename,
      source: this.#source,
      trustTier: this.#trustTier,
      modalityHazard: this.#modalityHazard,
      stash: this.#stash.all() as Record<string, MediaStashEntry>,
    }
  }

  /**
   * Factory: constructs a {@link Media} representing a user-supplied attachment.
   *
   * @remarks
   * Pre-fills `trustTier: 'third-party-private'` and derives `modalityHazard` from `kind`
   * (`document` → `'extractable-instructions'`; everything else → `'opaque-perceptual'`).
   * Use the bare constructor when the conservative kind→hazard mapping is wrong for your case.
   */
  public static userAttachment(args: {
    id?: string
    kind: MediaKind
    mimeType: string
    filename: string
    reader: MediaReader
    source?: string
    stash?: Record<string, MediaStashEntry>
  }): Media {
    return new Media({
      ...args,
      trustTier: 'third-party-private',
      modalityHazard: conservativeHazardForKind(args.kind),
    })
  }

  /**
   * Factory: constructs a {@link Media} produced by a first-party tool.
   *
   * @remarks
   * Pre-fills `trustTier: 'first-party'` and derives `modalityHazard` from `kind`.
   */
  public static toolGenerated(args: {
    id?: string
    kind: MediaKind
    mimeType: string
    filename: string
    reader: MediaReader
    source?: string
    stash?: Record<string, MediaStashEntry>
  }): Media {
    return new Media({
      ...args,
      trustTier: 'first-party',
      modalityHazard: conservativeHazardForKind(args.kind),
    })
  }

  /**
   * Factory: constructs a {@link Media} retrieved from a public third-party source.
   *
   * @remarks
   * Pre-fills `trustTier: 'third-party-public'` and derives `modalityHazard` from `kind`.
   */
  public static retrievedPublic(args: {
    id?: string
    kind: MediaKind
    mimeType: string
    filename: string
    reader: MediaReader
    source?: string
    stash?: Record<string, MediaStashEntry>
  }): Media {
    return new Media({
      ...args,
      trustTier: 'third-party-public',
      modalityHazard: conservativeHazardForKind(args.kind),
    })
  }

  /**
   * Factory: constructs a {@link Media} retrieved from a private third-party source.
   *
   * @remarks
   * Pre-fills `trustTier: 'third-party-private'` and derives `modalityHazard` from `kind`.
   */
  public static retrievedPrivate(args: {
    id?: string
    kind: MediaKind
    mimeType: string
    filename: string
    reader: MediaReader
    source?: string
    stash?: Record<string, MediaStashEntry>
  }): Media {
    return new Media({
      ...args,
      trustTier: 'third-party-private',
      modalityHazard: conservativeHazardForKind(args.kind),
    })
  }
}

/**
 * Returns `true` if `value` is a {@link Media} instance.
 *
 * @remarks
 * Module-level convenience alias for {@link Media.isMedia}. Uses {@link @nhtio/adk!isInstanceOf} for
 * cross-realm safety.
 */
export const isMedia = (value: unknown): value is Media => {
  return isInstanceOf(value, 'Media', Media)
}
