import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'
import type { HitFrame, PathFrame } from '../types'

/** Search capability; every result is lazy, complete, and terminal-framed. */
export interface SandboxSearch {
  /** Lazily yield every whole matching line, then one done frame. */
  searchContent(o: {
    root: string
    pattern: string
    maxDepth: number
    signal?: AbortSignal
  }): AsyncIterable<HitFrame>
  /** Lazily yield every matching path, then one done frame. */
  findPaths(o: {
    root: string
    glob: string
    maxDepth: number
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
