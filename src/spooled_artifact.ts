/**
 * Lazy, line-oriented artifact readers and format-aware spooled artifact subclasses.
 *
 * @module @nhtio/adk/spooled_artifact
 *
 * @remarks
 * All spooled-artifact primitives in one barrel: {@link @nhtio/adk!SpooledArtifact} (the base lazy
 * line-oriented view over a {@link @nhtio/adk!SpoolReader}), plus its format-aware subclasses
 * {@link @nhtio/adk!SpooledJsonArtifact} and {@link @nhtio/adk!SpooledMarkdownArtifact}. These artifacts are designed
 * to keep both runtime memory usage and LLM context-window consumption bounded by reading the
 * backing store on demand rather than materialising it up front.
 */

/**
 * @primaryExport
 */
export { SpooledArtifact } from './lib/classes/spooled_artifact'
/**
 * @primaryExport
 */
export { implementsSpoolReader } from './lib/contracts/spool_reader'
/**
 * @primaryExport
 */
export type { SpoolReader } from './lib/contracts/spool_reader'

/**
 * @primaryExport
 */
export { SpooledJsonArtifact } from './lib/classes/spooled_json_artifact'
/**
 * @primaryExport
 */
export type { JsonArtifactFormat } from './lib/classes/spooled_json_artifact'

/**
 * @primaryExport
 */
export { SpooledMarkdownArtifact } from './lib/classes/spooled_markdown_artifact'
/**
 * @primaryExport
 */
export type {
  MarkdownHeadingEntry,
  MarkdownCodeEntry,
  MarkdownSection,
} from './lib/classes/spooled_markdown_artifact'
