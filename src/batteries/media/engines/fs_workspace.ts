/**
 * A {@link @nhtio/adk/batteries/media/contracts!ScratchWorkspace} implementation backed by the
 * local filesystem via `node:fs/promises`.
 *
 * @module @nhtio/adk/batteries/media/engines/fs_workspace
 *
 * @remarks
 * The bundled filesystem workspace. `node:fs/promises` is acquired through an async resolver
 * (default: a lazy dynamic import) so this module carries no static `node:*` import and the
 * builtin loads only when a workspace is actually minted.
 *
 * The factory requires an explicit `root` directory — there is no `os.tmpdir()` silent
 * default. Each minted workspace is a fresh unique subdirectory of `root`, removed on
 * `dispose()`. Any BYO implementation whose paths the paired `BinaryExecutor` can open
 * satisfies the same contract (tmpfs mounts, container volumes, sandbox dirs…).
 */

import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type { ScratchWorkspace, ScratchWorkspaceFactory } from '../contracts'

/** The slice of `node:fs/promises` the workspace uses. */
export interface FsLike {
  /** Create a directory (recursively). */
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  /** Write bytes to a path. */
  writeFile(path: string, data: Uint8Array): Promise<void>
  /** Read a file's bytes. */
  readFile(path: string): Promise<Uint8Array>
  /** List directory entries (basenames). */
  readdir(path: string): Promise<string[]>
  /** Remove a path recursively, ignoring absence. */
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

/** Resolver forms accepted for the fs module. */
export type FsResolver = FsLike | (() => FsLike | Promise<FsLike>)

/** Options for {@link fsScratchWorkspace}. */
export interface FsScratchWorkspaceOptions {
  /** The directory all workspaces are minted under. Required — no platform default. */
  root: string
  /** The fs module or a resolver for it. Defaults to a lazy `import('node:fs/promises')`. */
  fs?: FsResolver
}

const resolveFs = async (supplied: FsResolver | undefined): Promise<FsLike> => {
  let value: unknown = supplied ?? ((): Promise<FsLike> => import('node:fs/promises'))
  if (typeof value === 'function') {
    try {
      value = await (value as () => unknown)()
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([`fs resolver failed: ${detail}`])
    }
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as FsLike).writeFile !== 'function'
  ) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      'fs resolver did not resolve to a node:fs/promises-compatible module',
    ])
  }
  return value as FsLike
}

let counter = 0
const uniqueName = (): string => {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `media-${rand}-${counter}`
}

const joinPath = (...parts: string[]): string => parts.join('/').replace(/\/{2,}/g, '/')

/**
 * Construct a {@link ScratchWorkspaceFactory} minting per-invocation directories under `root`.
 *
 * @param options - The root directory and fs resolver.
 * @returns A factory binary engines call once per invocation.
 */
export const fsScratchWorkspace = (options: FsScratchWorkspaceOptions): ScratchWorkspaceFactory => {
  if (typeof options?.root !== 'string' || options.root.length === 0) {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
      'fsScratchWorkspace requires an explicit root directory (no platform default)',
    ])
  }
  let fsPromise: Promise<FsLike> | undefined
  const getFs = (): Promise<FsLike> => {
    fsPromise ??= resolveFs(options.fs)
    return fsPromise
  }

  return async (): Promise<ScratchWorkspace> => {
    const fs = await getFs()
    const dir = joinPath(options.root, uniqueName())
    await fs.mkdir(dir, { recursive: true })
    return {
      async materialize(bytes: Uint8Array, filename: string): Promise<string> {
        const safe = filename.replace(/[/\\]/g, '_')
        const path = joinPath(dir, safe)
        await fs.writeFile(path, bytes)
        return path
      },
      async read(path: string): Promise<Uint8Array> {
        const bytes = await fs.readFile(path)
        return isInstanceOf(bytes, 'Uint8Array', Uint8Array) ? bytes : new Uint8Array(bytes)
      },
      dir(): string {
        return dir
      },
      async list(): Promise<string[]> {
        return fs.readdir(dir)
      },
      async dispose(): Promise<void> {
        await fs.rm(dir, { recursive: true, force: true })
      },
    }
  }
}
