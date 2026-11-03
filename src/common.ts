/**
 * Core value classes, runtime primitives, media helpers, and their companion input types.
 *
 * @module @nhtio/adk/common
 *
 * @remarks
 * A convenience barrel that re-exports the data primitives most consumers reach for: the
 * value classes ({@link @nhtio/adk!Tokenizable}, {@link @nhtio/adk!Registry}, {@link @nhtio/adk!Identity}, {@link @nhtio/adk!Memory},
 * {@link @nhtio/adk!Message}, {@link @nhtio/adk!Thought}, {@link @nhtio/adk!ToolCall}, {@link @nhtio/adk!Tool}, {@link @nhtio/adk!ToolRegistry},
 * and the spooled artifact family) plus their `Raw*` constructor inputs and small companion
 * types. {@link @nhtio/adk!TurnGate} is exported as a **type only** — it is constructed internally by the
 * runner and only surfaced to observers, never instantiated by user code.
 *
 * Use this barrel when you want one import for the everyday primitives without pulling the
 * runners or context surfaces. Per-class barrels remain available when you want narrower imports.
 */

/**
 * @primaryExport
 */
export { Tokenizable, TokenEncoding } from './lib/classes/tokenizable'

/**
 * @primaryExport
 */
export { Registry } from './lib/classes/registry'

/**
 * @primaryExport
 */
export { Identity } from './lib/classes/identity'
/**
 * @primaryExport
 */
export type { RawIdentity } from './lib/classes/identity'

/**
 * @primaryExport
 */
export { Memory } from './lib/classes/memory'
/**
 * @primaryExport
 */
export type { RawMemory } from './lib/classes/memory'

/**
 * @primaryExport
 */
export { Retrievable } from './lib/classes/retrievable'
/**
 * @primaryExport
 */
export type { RawRetrievable, RetrievableTrustTier } from './lib/classes/retrievable'

/**
 * @primaryExport
 */
export { Message } from './lib/classes/message'
/**
 * @primaryExport
 */
export type { RawMessage, MessageRole } from './lib/classes/message'

/**
 * @primaryExport
 */
export { Thought } from './lib/classes/thought'
/**
 * @primaryExport
 */
export type { RawThought } from './lib/classes/thought'

export { ToolCall } from './lib/classes/tool_call'
export type { RawToolCall, ToolCallResults } from './lib/classes/tool_call'

export { Tool } from './lib/classes/tool'
export type { RawTool, ToolHandler } from './lib/classes/tool'
export type {
  SpooledArtifactConstructor,
  ToolMethodDescriptor,
} from './lib/classes/spooled_artifact'

export { ArtifactTool } from './lib/classes/artifact_tool'
export type { RawArtifactTool, ArtifactToolHandler } from './lib/classes/artifact_tool'

export { ToolRegistry } from './lib/classes/tool_registry'
export type { MergeOptions } from './lib/classes/tool_registry'

/**
 * @primaryExport
 */
export type { TurnGate } from './lib/classes/turn_gate'
/**
 * @primaryExport
 */
export type { RawTurnGate } from './lib/classes/turn_gate'

export { SpooledArtifact, effectiveToolMethods } from './lib/classes/spooled_artifact'
export { implementsSpoolReader } from './lib/contracts/spool_reader'
export type { SpoolReader } from './lib/contracts/spool_reader'

/**
 * @primaryExport
 */
export type { ReaderDescriptor, LocatorValue } from './lib/contracts/reader_descriptor'
/**
 * @primaryExport
 */
export {
  registerMediaReaderResolver,
  registerSpoolReaderResolver,
  resolveMediaReader,
  resolveSpoolReader,
} from './lib/contracts/reader_resolvers'
/**
 * @primaryExport
 */
export type { MediaReaderResolver, SpoolReaderResolver } from './lib/contracts/reader_resolvers'

/**
 * @primaryExport
 */
export { implementsByteStore, byteStoreSchema } from './lib/contracts/byte_store'
/**
 * @primaryExport
 */
export type { ByteStore, SpoolStore, MediaStore } from './lib/contracts/byte_store'

/**
 * @primaryExport
 */
export { Media, isMedia } from './lib/classes/media'
/**
 * @primaryExport
 */
export type {
  RawMedia,
  SerializedMedia,
  MediaKind,
  MediaTrustTier,
  MediaModalityHazard,
  MediaStashEntry,
} from './lib/classes/media'
/**
 * @primaryExport
 */
export { implementsMediaReader, mediaReaderSchema } from './lib/contracts/media_reader'
/**
 * @primaryExport
 */
export type { MediaReader } from './lib/contracts/media_reader'
/**
 * @primaryExport
 */
export {
  inMemoryMediaReader,
  fromFetch,
  fromWebFile,
  MEDIA_READER_TAG_IN_MEMORY,
  MEDIA_READER_TAG_FETCH,
} from './lib/helpers/media_readers'
/**
 * @primaryExport
 */
export { encodeBase64, decodeBase64 } from './lib/helpers/base64'

// ── Retry primitives (issue #52) ────────────────────────────────────────────

/**
 * @internal
 *
 * Shared retry primitives used by batteries; surfaced here so batteries consume the same barrel
 * as external consumers rather than importing the private utility subpath.
 */
export {
  computeBackoff,
  sleepWithJitter,
  parseRetryAfter,
  linkAbortSignals,
} from './lib/utils/retry'
export type { BackoffConfig } from './lib/utils/retry'

// ── Canonical JSON (issue #52) ───────────────────────────────────────────────

/**
 * @internal
 *
 * Canonical `JSON.stringify` that sorts object keys recursively so that semantically-equal objects
 * produce identical strings. The harness derives stable identities (tool-call ids, checksums) from
 * it; the bundled LLM batteries hash request envelopes with it. Surfaced through the common barrel
 * (next to the other `lib/utils/` helpers) so a battery consumes it exactly as a consumer would
 * instead of reaching the private `lib/utils/` path.
 */
export { canonicalStringify } from './lib/utils/canonical_json'

// ── Audio PCM primitives (issue #52) ─────────────────────────────────────────

/**
 * @internal
 *
 * Linearly resamples mono PCM from one sample rate to another. Shared by the media battery's
 * image-audio steps and the on-device specialist batteries; surfaced through the common barrel so
 * they import it as consumers do instead of reaching the private `lib/utils/audio` path.
 */
export { resampleTo, downmixToMono } from './lib/utils/audio'

// ── Retrievable auto-spool (issue #52) ───────────────────────────────────────

/**
 * @internal
 *
 * Spools a static retrievable's content through the context's byte store (the auto-spool half of
 * Design Decision #14). Surfaced through the common barrel so the skills battery consumes it as a
 * consumer would instead of reaching the private `lib/utils/` path.
 */
export { autoSpoolRetrievable } from './lib/utils/retrievable_spool'

// ── Encoder symbol keys (issue #52) ─────────────────────────────────────────

/**
 * @internal
 *
 * The `Symbol.for()` keys every ADK primitive implements `@nhtio/encoder`'s custom-class contract
 * under. They exist so the primitives need no dependency on the optional encoder peer; a battery
 * that walks an encoded snapshot needs the same keys, and this barrel is where it gets them
 * without reaching into `lib/utils/encoder_symbols`.
 */
export { ENCODE_METHOD, DECODE_METHOD } from './lib/utils/encoder_symbols'

// ── MIME / text / middleware helpers (issue #52) ─────────────────────────────

/**
 * @internal
 *
 * Returns `true` when `mime` is text the string-shaped steps can handle as markup or plain text
 * (`text/*`, JSON, YAML, XML and `+xml` subtypes). One predicate shared by the media battery's
 * text verbs and the dev-tools battery's acquisition gate; surfaced through the common barrel so
 * both batteries consume it as consumers would instead of reaching the private `lib/mime/` path.
 */
export { isTextual } from './lib/mime/is_textual'

/**
 * @internal
 *
 * Decodes payload bytes as text: UTF-16 byte-order marks are honoured, everything else reads as
 * UTF-8, and CRLF/CR normalize to LF — the canonical text form every text consumer downstream of
 * acquisition sees. Same story as {@link isTextual}: one helper shared by media and dev-tools,
 * reachable only through this barrel.
 */
export { decodeText } from './lib/text/decode_text'

/**
 * @internal
 *
 * Executes an asynchronous middleware onion around a terminal operation (a fresh single-use
 * runner per invocation, capture-and-rethrow error handling, and a loud diagnostic when the chain
 * stops without invoking `next`). The batteries that run their own step pipelines through
 * `@nhtio/middleware` onions consume it through this barrel instead of the private
 * `lib/middleware/` path.
 */
export { runOnion } from './lib/middleware/run_onion'

export { SpooledJsonArtifact } from './lib/classes/spooled_json_artifact'
export type { JsonArtifactFormat } from './lib/classes/spooled_json_artifact'

export { SpooledMarkdownArtifact } from './lib/classes/spooled_markdown_artifact'
export type {
  MarkdownHeadingEntry,
  MarkdownCodeEntry,
  MarkdownSection,
} from './lib/classes/spooled_markdown_artifact'
