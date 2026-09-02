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
    maxDepth: number
    /** Maximum results to yield. MUST be an integer >= 1; adapters reject anything else. */
    limit: number
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
    maxDepth: number
    /** Maximum results to yield. MUST be an integer >= 1; adapters reject anything else. */
    limit: number
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
