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

export { SpooledArtifact } from './lib/classes/spooled_artifact'
export { implementsSpoolReader } from './lib/contracts/spool_reader'
export type { SpoolReader } from './lib/contracts/spool_reader'

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
export { inMemoryMediaReader, fromFetch, fromWebFile } from './lib/helpers/media_readers'

export { SpooledJsonArtifact } from './lib/classes/spooled_json_artifact'
export type { JsonArtifactFormat } from './lib/classes/spooled_json_artifact'

export { SpooledMarkdownArtifact } from './lib/classes/spooled_markdown_artifact'
export type {
  MarkdownHeadingEntry,
  MarkdownCodeEntry,
  MarkdownSection,
} from './lib/classes/spooled_markdown_artifact'
