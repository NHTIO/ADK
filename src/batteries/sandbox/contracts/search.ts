import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'
import type { HitFrame, PathFrame } from '../types'

/** Search capability; every result is lazy, complete, and terminal-framed. */
export interface SandboxSearch {
  /**
   * Whether this adapter can CONTAIN symlinked descendants when `follow` is enabled.
   *
   * `rg --follow` traverses links whose targets never pass through the path translator, so an
   * uncontained backend turns `follow: true` into an unbounded read of wherever they point.
   * The tools layer cannot inspect what is behind this interface, so an adapter declares it:
   * omitted or `false` means the forged `search_files`/`find_files` schemas REJECT `follow: true`
   * outright rather than accepting it and failing at execution. Set it only if you have verified
   * containment; the bundled ripgrep adapter has not, and does not set it.
   */
  readonly supportsFollow?: boolean
  /** Lazily yield every whole matching line, then one done frame. */
  searchContent(o: {
    root: string
    pattern: string
    /**
     * Traversal depth. Omit for an unbounded scan; an explicit value must be a non-negative integer.
     *
     * @remarks
     * An adapter MUST NOT name a depth on its own initiative when omitted — the unbounded request is
     * the caller's choice, and `Number.MAX_SAFE_INTEGER` is a disguised cap, not an implementation of
     * it (issue #48).
     */
    maxDepth?: number
    /**
     * Maximum results to yield. Omit for an unbounded search; an explicit value MUST be an integer
     * >= 1, and adapters reject anything else.
     *
     * @remarks
     * Omission is the documented unbounded mode, NOT a default cap: every match is returned and the
     * scan finishes `{ kind: 'done', complete: true }`. There is deliberately no sentinel —`undefined`
     * cannot be confused with an explicit number, so `Infinity`/`NaN`/`0`/negatives stay rejections
     * even though they conceptually mean the same thing (issue #48).
     *
     * MEMORY: an unbounded search is collected by the adapter before results are yielded (rg's
     * stdout is buffered whole), so peak memory grows in proportion to the OUTPUT on very large
     * trees — an explicit `limit` truncates only after collection. Pass a `limit` (or `maxDepth`)
     * wherever the tree size is untrusted or unknown.
     */
    limit?: number
    ignoreCase?: boolean
    literal?: boolean
    glob?: string
    iglob?: string
    follow?: boolean
    hidden?: boolean
    noIgnore?: boolean
    signal?: AbortSignal
  }): AsyncIterable<HitFrame>
  /** Lazily yield every matching path, then one done frame. */
  findPaths(o: {
    root: string
    glob: string
    /**
     * Traversal depth. Omit for an unbounded scan; an explicit value must be a non-negative integer.
     *
     * @remarks
     * An adapter MUST NOT name a depth on its own initiative when omitted — see `searchContent`.
     */
    maxDepth?: number
    /**
     * Maximum results to yield. Omit for an unbounded search; an explicit value MUST be an integer
     * >= 1, and adapters reject anything else — see `searchContent` (issue #48).
     */
    limit?: number
    iglob?: string
    follow?: boolean
    hidden?: boolean
    noIgnore?: boolean
    signal?: AbortSignal
  }): AsyncIterable<PathFrame>
}

/** Duck-type schema. */
export const sandboxSearchSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).searchContent === 'function' &&
      typeof (value as any).findPaths === 'function'
    )
      return value
    return helpers.error('any.invalid')
  })

/** Structural guard. */
export const implementsSandboxSearch = (value: unknown): value is SandboxSearch =>
  passesSchema(sandboxSearchSchema, value)
