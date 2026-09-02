import { isInstanceOf } from '../../lib/utils/guards'
import { E_INVALID_SANDBOX_CONFIG, E_SANDBOX_PATH_ESCAPE } from './exceptions'
import type { SandboxFileSystem } from './contracts/file_system'
import type { PathTranslator } from './contracts/path_translator'

/** Why a path was rejected outright, before any normalisation. */
export type SandboxPathRejection = 'nul' | 'home' | 'absolute-host' | 'device' | 'unc'

/**
 * Classify an unambiguous host escape, or `undefined` when the path is acceptable.
 *
 * @remarks
 * The REASON is returned, not just a boolean, because the narrated outcome carries it and the model
 * acts on it: "paths are workspace-relative" is useless advice for a NUL byte, and a UNC form needs
 * a different correction from a `~`. Reporting every rejection as `escape` collapses five distinct
 * mistakes into one unhelpful message.
 *
 * ORDER IS LOAD-BEARING and matches the plan's step 1. Recognition runs on the CANONICAL separator
 * representation (both `/` and `\` treated as separators) but still BEFORE any stripping, so a
 * slash-mixed form like `/\server\share` cannot slip past a naive prefix test and then become a
 * root-relative path once separators are collapsed. UNC is distinguished from merely-repeated
 * leading separators by having a NON-EMPTY first segment. Nothing is percent-decoded and nothing is
 * case-folded: a literal `%2e%2e` is a filename, not traversal.
 *
 * @param input - The model-supplied path, exactly as given.
 * @returns The rejection reason, or `undefined` to continue normalising.
 */
export const classifySandboxPathRejection = (input: string): SandboxPathRejection | undefined => {
  const canonical = input.replaceAll('\\', '/')
  if (canonical.includes('\0')) return 'nul'
  if (canonical.startsWith('~')) return 'home'
  if (/^[A-Za-z]:/.test(canonical)) return 'absolute-host'
  if (/^\/{2,}[?.]\//.test(canonical)) return 'device'
  if (/^\/{2,}[^/]+(?:\/|$)/.test(canonical)) return 'unc'
  return undefined
}

/** Return whether a path is an unambiguous host escape before normalisation. */
export const isRejectedSandboxPath = (input: string): boolean =>
  classifySandboxPathRejection(input) !== undefined

const joinSandboxBackendPath = (root: string, relative: string): string =>
  root === '/' ? `/${relative}` : `${root}${relative ? `/${relative}` : ''}`

/** Normalise a model path; leading separators denote the sandbox root. */
export const normalizeSandboxPath = (input: string): string => {
  const parts: string[] = []
  for (const part of input.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new E_SANDBOX_PATH_ESCAPE([`Path rejected: ${input}`])
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * Create a symlink guard for paths whose final component may not exist yet.
 * Stat failures are treated as absence, matching the sandbox regular-file helpers.
 */
export const createExistingSymlinkGuard = (
  root: string,
  fileSystem: SandboxFileSystem
): ((relative: string) => Promise<void>) => {
  const canonicalRoot = root.replaceAll('\\', '/').replace(/\/+$/g, '') || '/'
  return async (relative: string): Promise<void> => {
    const parts = relative ? relative.split('/') : []
    for (let index = 0; index <= parts.length; index += 1) {
      const candidate = parts.slice(0, index).join('/')
      try {
        const metadata = await fileSystem.stat(joinSandboxBackendPath(canonicalRoot, candidate))
        if (metadata.kind === 'symlink')
          throw new E_SANDBOX_PATH_ESCAPE([`Path rejected: ${relative}`])
      } catch (error) {
        if (isInstanceOf(error, 'E_SANDBOX_PATH_ESCAPE', E_SANDBOX_PATH_ESCAPE)) throw error
        break
      }
    }
  }
}

/** Create a translator that applies the five-step, workspace-relative path policy. */
export const createPathTranslator = (
  root: string,
  fileSystem: SandboxFileSystem
): PathTranslator => {
  if (root.includes('\0')) throw new E_INVALID_SANDBOX_CONFIG(['root contains NUL'])
  if (!root.startsWith('/')) throw new E_INVALID_SANDBOX_CONFIG(['root must be absolute'])
  const canonicalRoot = root.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  const containmentPrefix = canonicalRoot === '/' ? '/' : `${canonicalRoot}/`
  // The explicit annotation is load-bearing, not decoration: TypeScript only treats a call as
  // terminating control flow when the callee is a function declaration or a `const` with an
  // explicit type. Without it, every `reject(input)` below reads as a normal call and the
  // assignment analysis for `relative` fails — which is exactly the error this restores.
  const reject: (input: string) => never = (input) => {
    throw new E_SANDBOX_PATH_ESCAPE([`Path rejected: ${input}`])
  }
  const toRelative = async (input: string): Promise<string> => {
    const canonical = input.replaceAll('\\', '/')
    if (isRejectedSandboxPath(input)) reject(input)
    let relative: string
    try {
      relative = normalizeSandboxPath(canonical)
    } catch {
      reject(input)
    }
    const resolved = `${canonicalRoot}/${relative}`.replace(/\/+/g, '/')
    if (resolved !== canonicalRoot && !resolved.startsWith(containmentPrefix)) reject(input)
    await assertNoSymlinkComponents(relative)
    return relative
  }
  /** Refuse symlink components on the resolved path and every parent. */
  const assertNoSymlinkComponents = async (relative: string): Promise<void> => {
    const parts = relative ? relative.split('/') : []
    for (let index = 0; index <= parts.length; index += 1) {
      const candidate = parts.slice(0, index).join('/')
      const metadata = await fileSystem.stat(joinSandboxBackendPath(canonicalRoot, candidate))
      if (metadata.kind === 'symlink') reject(relative)
    }
  }
  const translator: PathTranslator = {
    toRelative,
    toBackendPath: (relative: string) => joinSandboxBackendPath(canonicalRoot, relative),
    redact: (text: string) =>
      text
        .replaceAll(canonicalRoot, '<sandbox-root>')
        .replaceAll(/\/(?:Users|home)\/[^\s/]+/g, '<host-user>'),
    assertNoSymlinkComponents,
  }
  return translator
}
