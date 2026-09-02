import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'
import type { ListFrame } from '../types'

/** Filesystem capability with no copy primitive; traversal is complete and terminal-framed. */
export interface SandboxFileSystem {
  /** Return metadata. A changed version token is evidence of change; equality is not a no-change guarantee. */
  stat(path: string): Promise<{
    size: number
    version: string
    kind: 'file' | 'dir' | 'symlink' | 'other'
    mtimeMs?: number
    ino?: number
    dev?: number
  }>
  /** Lazily yield every item, followed by exactly one mandatory done frame. */
  list(path: string, o: { maxDepth: number; signal?: AbortSignal }): AsyncIterable<ListFrame>
  /** Open a fresh, replayable byte stream; non-regular kinds are refused by adapters. */
  read(path: string, o?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>
  /** Write bytes without imposing a battery-level size cap. */
  write(
    path: string,
    bytes: ReadableStream<Uint8Array> | Uint8Array,
    o?: { signal?: AbortSignal }
  ): Promise<void>
  /** Delete a path. Deletion is idempotent: deleting an absent path resolves. */
  delete?(path: string, o?: { signal?: AbortSignal }): Promise<void>
  /**
   * Move a path. MUST overwrite an existing destination (POSIX move semantics).
   * Dev-tools relies on this behaviour when breaking rename cycles.
   */
  rename?(from: string, to: string, o?: { signal?: AbortSignal }): Promise<void>
  /** Create a directory. */
  mkdir?(path: string, o?: { signal?: AbortSignal }): Promise<void>
}

/** Duck-type schema. */
export const sandboxFileSystemSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).stat === 'function' &&
      typeof (value as any).list === 'function' &&
      typeof (value as any).read === 'function' &&
      typeof (value as any).write === 'function'
    )
      return value
    return helpers.error('any.invalid')
  })

/** Structural guard. */
export const implementsSandboxFileSystem = (value: unknown): value is SandboxFileSystem =>
  passesSchema(sandboxFileSystemSchema, value)
