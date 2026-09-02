/** Runtime helpers for the development-tools pipeline. */
import { isError, isInstanceOf } from '@nhtio/adk/guards'
// KNOWN DEVIATION from "Batteries — barrel imports only": no barrel re-exports these two, and
// `common` is value classes, so neither belongs there. Media reaches them the same way. The
// documented fix is to add the re-export to a barrel; that is a public-surface decision and is
// tracked separately rather than smuggled in here.
import { isTextual } from '@nhtio/adk/lib/mime/is_textual'
import { decodeText } from '@nhtio/adk/lib/text/decode_text'
import { resolveMime } from '../sandbox/defaults/extension_mime'
import { globMatches, isPattern, validatePattern } from './matcher'
import { applyOperations, normalizeWorkspacePath } from '../../lib/patch'
import { E_DEV_BAD_ARG, E_DEV_STEP_FAILED, E_DEV_WORKSPACE_BOUNDS } from './exceptions'
import {
  classifySandboxPathRejection,
  createExistingSymlinkGuard,
  normalizeSandboxPath,
} from '../sandbox/paths'
import type { FsNode } from '../sandbox/node/fs_node'
import type { ParsedApplyPatch, WorkspaceFile } from '../../lib/patch'
import type { MimeResolver } from '../sandbox/contracts/mime_resolver'
import type { SandboxFileSystem } from '../sandbox/contracts/file_system'
import type { PathTranslator } from '../sandbox/contracts/path_translator'
import type { DevFileAccess, DevInvocation, FileChangeSummary } from './types'
import type {
  Diagnostic,
  ExecutionState,
  RawDiagnostic,
  StampedDelta,
  WorkspaceBounds,
} from './types'

/** Internal provenance marker for runtime diagnostics that name an engine. */
export const runtimeDiagnostic = Symbol('runtimeDiagnostic')

/** Whole-file names that are known textual despite having no useful extension. */
export const DEV_FILENAME_MIME: Readonly<Record<string, string>> = Object.fromEntries(
  `Makefile makefile GNUmakefile Dockerfile Containerfile Jenkinsfile Procfile Rakefile Gemfile Brewfile Vagrantfile Justfile justfile CODEOWNERS LICENSE LICENCE NOTICE AUTHORS CHANGELOG README TODO VERSION .gitignore .gitattributes .gitmodules .dockerignore .npmignore .npmrc .nvmrc .editorconfig .prettierrc .eslintrc .babelrc .env .env.example .browserslistrc`
    .split(' ')
    .map((name) => [name, 'text/plain'])
)

/** Resolve an admission MIME, giving the normative filename map precedence. */
export const resolveDevMime = async (
  path: string,
  resolver: MimeResolver | undefined,
  bytes: Uint8Array
): Promise<string | undefined> => {
  const name = path.split('/').pop() ?? path
  return (
    DEV_FILENAME_MIME[name] ??
    resolveMime(path, resolver, { peek: async (count) => bytes.slice(0, count) })
  )
}

/** Canonicalize an absolute host workspace root for comparisons and engine requests. */
export const canonicalizeDevRoot = (value: string): string => {
  const normalized = value.replaceAll('\\', '/').replace(/\/+/g, '/')
  return normalized === '/' ? '/' : normalized.replace(/\/$/, '') || '/'
}

const readBytes = async (fileSystem: SandboxFileSystem, path: string): Promise<Uint8Array> => {
  const stream = await fileSystem.read(path)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
    length += next.value.length
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/** Check all workspace resource limits against a proposed map. */
export const assertBounds = (
  files: ReadonlyMap<string, WorkspaceFile>,
  bounds: WorkspaceBounds
): void => {
  if (files.size > bounds.maxFiles)
    throw new E_DEV_WORKSPACE_BOUNDS([
      `maxFiles limit ${bounds.maxFiles} exceeded by ${files.size}`,
    ])
  let total = 0
  for (const [path, file] of files) {
    const size = new TextEncoder().encode(file.text).length
    if (size > bounds.maxBytesPerFile)
      throw new E_DEV_WORKSPACE_BOUNDS([
        `maxBytesPerFile limit ${bounds.maxBytesPerFile} exceeded by ${path} (${size})`,
      ])
    total += size
  }
  if (total > bounds.maxTotalBytes)
    throw new E_DEV_WORKSPACE_BOUNDS([
      `maxTotalBytes limit ${bounds.maxTotalBytes} exceeded by ${total}`,
    ])
}

/** Resolve acquisition paths without reading file contents. */
export const resolveAcquisitionTargets = async (options: {
  paths: readonly string[]
  fileSystem: SandboxFileSystem
  pathTranslator: PathTranslator
  signal?: AbortSignal
}): Promise<string[]> => {
  const root = canonicalizeDevRoot(options.pathTranslator.toBackendPath('') as string)
  const concrete = new Set<string>()
  for (const authored of options.paths) {
    if (typeof authored !== 'string') throw new E_DEV_BAD_ARG(['acquisition paths must be strings'])
    const value = authored.trim()
    if (!isPattern(value)) {
      try {
        concrete.add(await options.pathTranslator.toRelative(value))
      } catch (error) {
        throw new E_DEV_BAD_ARG([
          `acquisition path "${authored}" does not exist: ${isError(error) ? error.message : String(error)}`,
        ])
      }
      continue
    }
    let pattern: string
    try {
      pattern = validatePattern(normalizeSandboxPath(value))
    } catch (error) {
      throw new E_DEV_BAD_ARG([
        `invalid acquisition pattern "${authored}": ${isError(error) ? error.message : String(error)}`,
      ])
    }
    let done = false
    let matched = false
    for await (const frame of options.fileSystem.list(root, {
      maxDepth: 20,
      signal: options.signal,
    })) {
      if (frame.kind === 'done') {
        done = true
        continue
      }
      if (frame.entryKind !== 'file') continue
      const relative =
        frame.path === root
          ? ''
          : frame.path.startsWith(`${root}/`)
            ? frame.path.slice(root.length + 1)
            : frame.path
      if (globMatches(pattern, relative)) {
        concrete.add(normalizeSandboxPath(relative))
        matched = true
      }
    }
    if (!done)
      throw new E_DEV_STEP_FAILED(['acquire', 'filesystem list ended without a done frame'])
    if (!matched) throw new E_DEV_BAD_ARG([`acquisition pattern "${authored}" matched no files`])
  }
  return [...concrete].sort()
}

/** Acquire explicitly requested files, expanding only entries containing an asterisk. */
export const acquireWorkspace = async (options: {
  paths: readonly string[]
  fileSystem: SandboxFileSystem
  pathTranslator: PathTranslator
  bounds: WorkspaceBounds
  mimeResolver?: MimeResolver
  signal?: AbortSignal
  /** Previously resolved targets, used to keep approval and acquisition consistent. */
  targets?: readonly string[]
}): Promise<Map<string, WorkspaceFile>> => {
  const files = new Map<string, WorkspaceFile>()
  for (const input of options.targets ?? (await resolveAcquisitionTargets(options))) {
    // A real translator probes symlink components in toRelative. Probe literals first so an
    // absent literal remains the caller's bad argument rather than a translator failure.
    if (!isPattern(input)) {
      try {
        await options.fileSystem.stat(options.pathTranslator.toBackendPath(input) as string)
      } catch (error) {
        throw new E_DEV_BAD_ARG([
          `acquisition path "${input}" does not exist: ${isError(error) ? error.message : String(error)}`,
        ])
      }
    }
    let relative: string
    try {
      relative = await options.pathTranslator.toRelative(input)
    } catch (error) {
      throw new E_DEV_STEP_FAILED([
        'acquire',
        `cannot acquire "${input}": ${isError(error) ? error.message : String(error)}`,
      ])
    }
    if (relative.split('/').length > 20)
      throw new E_DEV_WORKSPACE_BOUNDS([`path "${relative}" exceeds depth limit 20`])
    const backend = options.pathTranslator.toBackendPath(relative) as string
    let metadata: Awaited<ReturnType<SandboxFileSystem['stat']>>
    try {
      metadata = await options.fileSystem.stat(backend)
    } catch (error) {
      throw new E_DEV_BAD_ARG([
        `acquisition path "${input}" does not exist: ${isError(error) ? error.message : String(error)}`,
      ])
    }
    if (metadata.kind !== 'file')
      throw new E_DEV_BAD_ARG([`"${input}" is not a file; use a glob to acquire files`])
    const bytes = await readBytes(options.fileSystem, backend)
    const mimeType = await resolveDevMime(relative, options.mimeResolver, bytes)
    if (mimeType === undefined || !isTextual(mimeType))
      throw new E_DEV_STEP_FAILED(['acquire', `"${relative}" has no textual MIME type`])
    files.set(relative, { text: decodeText(bytes), mimeType })
    assertBounds(files, options.bounds)
  }
  return files
}

/**
 * Derive the canonical workspace delta for a completely parsed structured patch.
 *
 * The patch primitive mutates its input map, so this always applies it to a clone and returns
 * nothing until the entire operation list has succeeded.
 */
export const derivePatchOutcome = (files: Map<string, WorkspaceFile>, parsed: ParsedApplyPatch) => {
  const clone = new Map(files)
  applyOperations(clone, parsed)
  const moves = new Map<string, string>()
  const deletedThenAdded = new Set<string>()
  const absent = new Set<string>()
  for (const operation of parsed.operations) {
    if (operation.type === 'delete') absent.add(operation.path)
    if (operation.type === 'add') {
      if (absent.has(operation.path) && files.has(operation.path))
        deletedThenAdded.add(operation.path)
      absent.delete(operation.path)
    }
    if (operation.type === 'update' && operation.movePath) {
      const origin = moves.get(operation.path) ?? operation.path
      moves.delete(operation.path)
      if (origin !== operation.movePath) moves.set(operation.movePath, origin)
      absent.add(operation.path)
      absent.delete(operation.movePath)
    }
  }
  const renamed = new Map<string, string>()
  for (const [to, from] of moves) {
    if (to !== from && files.has(from) && clone.has(to)) renamed.set(from, to)
  }
  const destinations = new Set(renamed.values())
  const sources = new Set(renamed.keys())
  const added = new Map<string, WorkspaceFile>()
  const deleted = new Set<string>()
  const changed = new Map<string, string>()
  for (const [path, file] of clone) {
    const original = files.get(path)
    if (!original) {
      const source = [...renamed].find(([, destination]) => destination === path)?.[0]
      if (source !== undefined && files.get(source)?.text !== file.text)
        changed.set(path, file.text)
      else if (!destinations.has(path)) added.set(path, file)
    } else if (sources.has(path)) {
      added.set(path, file)
    } else if (original.text !== file.text) changed.set(path, file.text)
  }
  for (const path of files.keys()) if (!clone.has(path) && !sources.has(path)) deleted.add(path)
  return {
    delta: { changed, added, deleted, renamed, diagnostics: [] },
    recreated: deletedThenAdded,
  }
}

const normalizedDeltaPath = (path: string): string => {
  if (classifySandboxPathRejection(path) !== undefined)
    throw new E_DEV_STEP_FAILED(['delta', `invalid path "${path}"`])
  try {
    return normalizeWorkspacePath(path)
  } catch (error) {
    throw new E_DEV_STEP_FAILED([
      'delta',
      `invalid path "${path}": ${isError(error) ? error.message : String(error)}`,
    ])
  }
}

/** Normalize, validate, and apply one engine delta without mutating it. */
export const applyDelta = async (options: {
  delta: StampedDelta
  files: Map<string, WorkspaceFile>
  state: ExecutionState
  bounds: WorkspaceBounds
  fileSystem: SandboxFileSystem
  pathTranslator: PathTranslator
  mimeResolver?: MimeResolver
  persistedPaths?: Map<string, string>
  pendingDeletions?: Map<string, string>
  recreated?: Set<string>
  renames?: Map<string, string>
  /** Paths vacated earlier in this execution by a deletion or rename. */
  vacated?: Set<string>
  unreadable?: ReadonlySet<string>
  engineId?: string
  /** Resolved existing paths this engine invocation was authorized to modify. */
  invocationPaths?: readonly string[]
  /** Authored selector patterns; additions must match these when present. */
  selector?: readonly string[] | null
  /** Structured patch additions are textual by construction and retain their inferred MIME. */
  skipAddedMimeResolution?: boolean
}): Promise<StampedDelta> => {
  const changed = new Map<string, string>()
  const added = new Map<string, WorkspaceFile>()
  const deleted = new Set<string>()
  const renamed = new Map<string, string>()
  const addUnique = <T>(target: Map<string, T>, path: string, value: T): void => {
    if (target.has(path)) throw new E_DEV_STEP_FAILED(['delta', `duplicate path "${path}"`])
    target.set(path, value)
  }
  for (const [path, text] of options.delta.changed ?? [])
    addUnique(changed, normalizedDeltaPath(path), text)
  for (const [path, file] of options.delta.added ?? [])
    addUnique(added, normalizedDeltaPath(path), file)
  for (const rawPath of options.delta.deleted ?? []) {
    const path = normalizedDeltaPath(rawPath)
    if (deleted.has(path)) throw new E_DEV_STEP_FAILED(['delta', `duplicate path "${path}"`])
    deleted.add(path)
  }
  for (const [from, to] of options.delta.renamed ?? []) {
    const source = normalizedDeltaPath(from)
    const destination = normalizedDeltaPath(to)
    if (renamed.has(source) || [...renamed.values()].includes(destination))
      throw new E_DEV_STEP_FAILED([
        'delta',
        `duplicate rename path "${source === from ? destination : source}"`,
      ])
    renamed.set(source, destination)
  }
  const noOpChanges: string[] = []
  for (const [path, text] of [...changed]) {
    if (options.files.get(path)?.text === text) {
      changed.delete(path)
      noOpChanges.push(path)
    }
  }
  const destinations = new Set(renamed.values())
  const sources = new Set(renamed.keys())
  const collide = (path: string, reason: string): never => {
    throw new E_DEV_STEP_FAILED(['delta', `${reason}: "${path}"`])
  }
  // Existing-file mutations are confined to precisely the paths dispatch resolved.
  // Additions instead use the authored selector: a resolved path set contains no absent paths.
  if (options.invocationPaths !== undefined) {
    const allowed = new Set(options.invocationPaths)
    const selector = options.selector ?? null
    const unauthorized = (path: string): never => {
      throw new E_DEV_STEP_FAILED([
        options.engineId ?? 'delta',
        `path "${path}" is outside the authorized selector "${selector?.join(', ') ?? '(workspace root)'}"`,
      ])
    }
    for (const path of changed.keys()) if (!allowed.has(path)) unauthorized(path)
    for (const path of deleted) if (!allowed.has(path)) unauthorized(path)
    for (const path of sources) if (!allowed.has(path)) unauthorized(path)
    // A rename destination is authorized by its source, so it is intentionally not selector-bound.
    if (selector !== null)
      for (const path of added.keys())
        if (!selector.some((pattern) => globMatches(pattern, path))) unauthorized(path)
  }
  for (const path of added.keys())
    if (deleted.has(path)) collide(path, 'path is both added and deleted')
  for (const path of changed.keys())
    if (sources.has(path)) collide(path, 'changed path is a rename source')
  for (const path of destinations) {
    if (options.files.has(path)) collide(path, 'rename destination already exists')
    if (sources.has(path)) collide(path, 'rename chain is not allowed')
    if (deleted.has(path)) collide(path, 'rename destination is also deleted')
  }
  for (const path of sources) {
    if (deleted.has(path)) collide(path, 'rename source is also deleted')
    if (!options.files.has(path)) collide(path, 'rename source is absent')
  }
  for (const path of deleted)
    if (destinations.has(path)) collide(path, 'deleted path is a rename destination')
  for (const path of changed.keys()) {
    if (deleted.has(path)) collide(path, 'changed path is also deleted')
    if (!options.files.has(path) && !added.has(path) && !destinations.has(path))
      collide(path, 'changed path is absent')
  }
  for (const [path, file] of added) {
    if (options.files.has(path) && !sources.has(path)) collide(path, 'added path already exists')
    const bytes = new TextEncoder().encode(file.text)
    const mimeType = options.skipAddedMimeResolution
      ? file.mimeType
      : await resolveDevMime(path, options.mimeResolver, bytes)
    if (mimeType === undefined || !isTextual(mimeType)) collide(path, 'added file is not textual')
    added.set(path, { ...file, mimeType: mimeType! })
    const exempt =
      options.recreated?.has(path) === true ||
      options.persistedPaths?.has(path) === true ||
      options.unreadable?.has(path) === true ||
      sources.has(path)
    if (!exempt) {
      try {
        await options.fileSystem.stat(options.pathTranslator.toBackendPath(path) as string)
        collide(path, 'added path exists but was not acquired')
      } catch (error) {
        if (isInstanceOf(error, 'E_DEV_STEP_FAILED', E_DEV_STEP_FAILED)) throw error
      }
    }
  }
  for (const [from, to] of renamed) {
    const file = options.files.get(from)!
    options.files.delete(from)
    options.files.set(to, file)
    options.vacated?.add(from)
    options.vacated?.delete(to)
    const onDisk = options.persistedPaths?.get(from)
    if (onDisk !== undefined) {
      options.persistedPaths!.delete(from)
      options.persistedPaths!.set(to, onDisk)
    }
    if (options.recreated?.delete(from)) {
      options.recreated.add(to)
      // This is a newly-created identity, not the acquired file's rename.
      options.renames?.delete(to)
    } else {
      // Resolve a source that was renamed by an earlier step before checking the
      // acquisition baseline: b→c after a→b is still the acquired a→c identity.
      const origin = options.renames?.get(from)
      if (origin !== undefined) {
        options.renames!.set(to, origin)
        options.renames!.delete(from)
      } else if (options.state.acquisitionBaseline.has(from)) {
        options.renames?.set(to, from)
        options.renames?.delete(from)
      }
    }
  }
  for (const path of deleted) {
    options.files.delete(path)
    options.vacated?.add(path)
    const onDisk = options.persistedPaths?.get(path)
    if (onDisk !== undefined) {
      options.persistedPaths!.delete(path)
      options.pendingDeletions?.set(path, onDisk)
    }
    options.recreated?.delete(path)
    options.renames?.delete(path)
  }
  for (const [path, file] of added) {
    if (
      options.state.acquisitionBaseline.has(path) &&
      (options.vacated?.has(path) ||
        sources.has(path) ||
        deleted.has(path) ||
        options.pendingDeletions?.has(path))
    )
      options.recreated?.add(path)
    options.vacated?.delete(path)
    if (sources.has(path)) options.state.addedBy.set(path, 'delta')
    options.files.set(path, file)
  }
  for (const [path, text] of changed) {
    const file = options.files.get(path)
    if (!file) collide(path, 'changed path is absent')
    options.files.set(path, { ...file!, text })
  }
  assertBounds(options.files, options.bounds)
  const diagnostics = [...options.delta.diagnostics]
  if (noOpChanges.length > 0) {
    const warning = {
      path: null,
      severity: 'warning' as const,
      message: `engine "${options.engineId ?? 'unknown'}" reported ${noOpChanges.length} unchanged changed entr${noOpChanges.length === 1 ? 'y' : 'ies'}; ignored`,
      engineId: options.engineId ?? 'unknown',
      [runtimeDiagnostic]: true,
    }
    diagnostics.push(warning as unknown as (typeof diagnostics)[number])
  }
  return { ...options.delta, diagnostics, changed, added, deleted, renamed }
}

/** Normalize and scope-stamp diagnostics after the workspace mutation has completed. */
/** Build the deliberately narrow disk API handed to an in-place engine. */
export const makeDevFileAccess = (options: {
  invocation: DevInvocation
  allowlist: readonly string[]
  fileSystem: SandboxFileSystem
  pathTranslator: PathTranslator
  policy: FsNode | undefined
  selector: readonly string[] | null
  signal?: AbortSignal
  renameDestinations: Set<string>
}): DevFileAccess => {
  const fail = (message: string): never => {
    throw new E_DEV_STEP_FAILED([options.invocation.engineId, message])
  }
  const guard = createExistingSymlinkGuard(
    options.pathTranslator.toBackendPath('') as string,
    options.fileSystem
  )
  const scope = [...new Set(options.allowlist)].sort()
  const lexical = (input: string): { relative: string; backend: string } => {
    if (input.startsWith('/'))
      fail(`path "${input}" must be workspace-relative (leading / is not allowed)`)
    if (classifySandboxPathRejection(input) !== undefined) fail(`path "${input}" is rejected`)
    let relative = ''
    try {
      relative = normalizeSandboxPath(input)
    } catch {
      return fail(`path "${input}" is rejected`)
    }
    return { relative, backend: options.pathTranslator.toBackendPath(relative) as string }
  }
  const policy = (backend: string, read: boolean): void => {
    const node = options.policy
    if (!node) return fail('effective policy was unavailable')
    if (!node.canWrite(backend) || (read && !node.canRead(backend)))
      fail(`path is refused by sandbox policy: ${backend}`)
  }
  const createAuthorized = (path: string): boolean =>
    options.invocation.scope !== null &&
    options.invocation.scope.some((pattern) => globMatches(pattern, path)) &&
    (options.selector === null || options.selector.some((pattern) => globMatches(pattern, path)))
  const permitted = (path: string, create = false): void => {
    if (scope.includes(path)) return
    if (create && createAuthorized(path)) return
    fail(
      `path "${path}" is outside the allowlist (${scope.length} paths) and declared scope (${options.invocation.scope?.join(', ') ?? ''})`
    )
  }
  const absent = async (backend: string): Promise<boolean> => {
    try {
      await options.fileSystem.stat(backend)
      return false
    } catch {
      return true
    }
  }
  const mutation = async (
    input: string,
    create = false
  ): Promise<{ relative: string; backend: string }> => {
    const target = lexical(input)
    permitted(target.relative, create)
    policy(target.backend, false)
    await guard(target.relative)
    return target
  }
  const mkdirParents = async (relative: string): Promise<void> => {
    const parts = relative.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      const backend = options.pathTranslator.toBackendPath(parent) as string
      try {
        const stat = await options.fileSystem.stat(backend)
        if (stat.kind !== 'dir') fail(`parent "${parent}" is not a directory`)
      } catch (error) {
        if (isInstanceOf(error, 'E_DEV_STEP_FAILED', E_DEV_STEP_FAILED)) throw error
        if (!options.invocation.needs.includes('mkdir'))
          fail('parent creation requires "mkdir" to be declared in needs')
        if (!options.fileSystem.mkdir)
          fail(`parent directory "${parent}" does not exist and filesystem cannot create it`)
        policy(backend, false)
        await guard(parent)
        await options.fileSystem.mkdir!(backend, { signal: options.signal })
      }
    }
  }
  return {
    scope,
    async read(path) {
      const target = lexical(path)
      permitted(target.relative)
      policy(target.backend, true)
      await guard(target.relative)
      return decodeText(await readBytes(options.fileSystem, target.backend))
    },
    async exists(path) {
      const target = lexical(path)
      permitted(target.relative, true)
      policy(target.backend, true)
      try {
        await options.fileSystem.stat(target.backend)
        return true
      } catch {
        return false
      }
    },
    async write(path, text) {
      const target = await mutation(path, true)
      if (!scope.includes(target.relative) && !(await absent(target.backend)))
        fail(`create target "${target.relative}" already exists`)
      if (target.relative.split('/').length > 20)
        fail(`path "${target.relative}" exceeds depth limit 20`)
      await mkdirParents(target.relative)
      await guard(target.relative)
      await options.fileSystem.write(target.backend, new TextEncoder().encode(text), {
        signal: options.signal,
      })
    },
    async delete(path) {
      if (!options.invocation.needs.includes('delete')) fail('delete was not declared in needs')
      const target = await mutation(path)
      if (!options.fileSystem.delete) return fail('filesystem does not support delete')
      await options.fileSystem.delete(target.backend, { signal: options.signal })
    },
    async rename(from, to) {
      if (!options.invocation.needs.includes('rename')) fail('rename was not declared in needs')
      const source = await mutation(from)
      const destination = await mutation(to, true)
      if (!(await absent(destination.backend)))
        fail(`rename destination "${destination.relative}" already exists`)
      if (!options.fileSystem.rename) return fail('filesystem does not support rename')
      await mkdirParents(destination.relative)
      await guard(source.relative)
      await guard(destination.relative)
      await options.fileSystem.rename(source.backend, destination.backend, {
        signal: options.signal,
      })
      options.renameDestinations.add(destination.relative)
    },
    async mkdir(path) {
      if (!options.invocation.needs.includes('mkdir')) fail('mkdir was not declared in needs')
      const target = lexical(path)
      if (
        !(options.invocation.scope ?? []).some((pattern) =>
          globMatches(pattern, `${target.relative}/x`)
        ) ||
        (options.selector !== null &&
          !options.selector.some((pattern) => globMatches(pattern, `${target.relative}/x`)))
      )
        fail(`mkdir "${target.relative}" is outside declared scope`)
      policy(target.backend, false)
      if (!options.fileSystem.mkdir) fail('filesystem does not support mkdir')
      await mkdirParents(`${target.relative}/x`)
      try {
        const stat = await options.fileSystem.stat(target.backend)
        if (stat.kind !== 'dir') fail(`"${target.relative}" exists as ${stat.kind}`)
      } catch (error) {
        if (isInstanceOf(error, 'E_DEV_STEP_FAILED', E_DEV_STEP_FAILED)) throw error
        await guard(target.relative)
        await options.fileSystem.mkdir!(target.backend, { signal: options.signal })
      }
    },
  }
}

/** Snapshot an in-place authorization envelope before its capability mutates disk. */
export const snapshotInPlaceEnvelope = async (options: {
  envelope: readonly (readonly string[])[]
  excluded?: ReadonlySet<string>
  files: ReadonlyMap<string, WorkspaceFile>
  fileSystem: SandboxFileSystem
  pathTranslator: PathTranslator
  signal?: AbortSignal
}): Promise<{ paths: Set<string>; diagnostics: RawDiagnostic[] }> => {
  const root = options.pathTranslator.toBackendPath('') as string
  const paths = new Set<string>()
  const diagnostics: RawDiagnostic[] = []
  const matches = (path: string) =>
    !options.excluded?.has(path) &&
    options.envelope.some((patterns) => patterns.every((pattern) => globMatches(pattern, path)))
  try {
    for await (const frame of options.fileSystem.list(root, {
      maxDepth: 20,
      signal: options.signal,
    })) {
      if (frame.kind !== 'item' || frame.entryKind !== 'file') continue
      const path = frame.path.startsWith(`${root}/`)
        ? frame.path.slice(root.length + 1)
        : frame.path
      if (matches(path)) paths.add(path)
    }
  } catch (error) {
    diagnostics.push({
      path: null,
      severity: 'error',
      message: `could not enumerate re-read envelope (${options.envelope.join(', ')}): ${isError(error) ? error.message : String(error)}`,
    })
    for (const path of options.files.keys()) if (matches(path)) paths.add(path)
  }
  return { paths, diagnostics }
}

/** Assemble final-state changes, retaining rename identity rather than guessing from text. */
/** Re-read an in-place invocation's authorized envelope against its pre-step snapshot. */
export const rereadInPlace = async (options: {
  envelope: readonly (readonly string[])[]
  /** Dirty workspace paths whose disk copies must not be admitted by this re-read. */
  excluded?: ReadonlySet<string>
  beforeSnapshot?: Set<string>
  files: Map<string, WorkspaceFile>
  unreadable: Set<string>
  persistedPaths: Map<string, string>
  persistedBaseline: Map<string, WorkspaceFile>
  renames: Map<string, string>
  recreated: Set<string>
  fileSystem: SandboxFileSystem
  pathTranslator: PathTranslator
  bounds: WorkspaceBounds
  mimeResolver?: MimeResolver
  signal?: AbortSignal
}): Promise<{ changed: Set<string>; diagnostics: RawDiagnostic[] }> => {
  const root = options.pathTranslator.toBackendPath('') as string
  const before = options.beforeSnapshot ?? new Set<string>()
  const diagnostics: RawDiagnostic[] = []
  const matches = (path: string) =>
    !options.excluded?.has(path) &&
    options.envelope.some((patterns) => patterns.every((pattern) => globMatches(pattern, path)))
  if (!options.beforeSnapshot) {
    const snapshot = await snapshotInPlaceEnvelope(options)
    for (const path of snapshot.paths) before.add(path)
    diagnostics.push(...snapshot.diagnostics)
  }
  const after = new Set<string>()
  try {
    for await (const frame of options.fileSystem.list(root, {
      maxDepth: 20,
      signal: options.signal,
    })) {
      if (frame.kind !== 'item' || frame.entryKind !== 'file') continue
      const path = frame.path.startsWith(`${root}/`)
        ? frame.path.slice(root.length + 1)
        : frame.path
      if (matches(path)) after.add(path)
    }
  } catch (error) {
    diagnostics.push({
      path: null,
      severity: 'error',
      message: `could not re-read envelope (${options.envelope.join(', ')}): ${isError(error) ? error.message : String(error)}`,
    })
  }
  const changed = new Set<string>()
  for (const path of new Set([...before, ...after, ...options.files.keys()])) {
    if (!matches(path)) continue
    const existing = options.files.get(path)
    if (!after.has(path)) {
      if (existing) {
        options.files.delete(path)
        options.persistedPaths.delete(path)
        options.persistedBaseline.delete(path)
        options.renames.delete(path)
        options.recreated.delete(path)
        changed.add(path)
      }
      continue
    }
    // Do not import a pre-existing file the workspace never acquired. unreadable is tracked ownership.
    if (!existing && before.has(path) && !options.unreadable.has(path)) continue
    try {
      const bytes = await readBytes(
        options.fileSystem,
        options.pathTranslator.toBackendPath(path) as string
      )
      const mimeType = await resolveDevMime(path, options.mimeResolver, bytes)
      if (!mimeType || !isTextual(mimeType) || bytes.length > options.bounds.maxBytesPerFile)
        throw new Error(
          !mimeType || !isTextual(mimeType) ? 'not textual' : 'exceeds maxBytesPerFile'
        )
      const file = { text: decodeText(bytes), mimeType }
      if (!existing && options.files.size >= options.bounds.maxFiles)
        throw new Error('exceeds maxFiles')
      if (existing?.text !== file.text || !existing) changed.add(path)
      options.files.set(path, file)
      options.persistedPaths.set(path, path)
      options.persistedBaseline.set(path, { ...file })
      options.unreadable.delete(path)
    } catch (error) {
      if (existing) {
        options.files.delete(path)
        options.persistedPaths.delete(path)
        options.persistedBaseline.delete(path)
        options.unreadable.add(path)
        changed.add(path)
      }
      diagnostics.push({
        path,
        severity: 'error',
        message: `could not admit re-read file "${path}": ${isError(error) ? error.message : String(error)}`,
      })
    }
  }
  return { changed, diagnostics }
}

export const assembleChanges = async (
  baseline: ReadonlyMap<string, WorkspaceFile>,
  files: ReadonlyMap<string, WorkspaceFile>,
  renames: ReadonlyMap<string, string>,
  recreated: ReadonlySet<string>,
  unreadable: ReadonlySet<string>
): Promise<{ changes: FileChangeSummary[]; lineCountsAvailable: boolean }> => {
  let diffLines:
    | ((a: string, b: string) => Array<{ added?: boolean; removed?: boolean; count?: number }>)
    | undefined
  try {
    const diffModule = await import('diff')
    diffLines = diffModule.diffLines
  } catch {
    /* optional peer */
  }
  const rows: FileChangeSummary[] = []
  const consumed = new Set<string>()
  const counts = (before: string, after: string): Pick<FileChangeSummary, 'added' | 'removed'> => {
    if (!diffLines) return {}
    let added = 0
    let removed = 0
    for (const part of diffLines(before, after)) {
      if (part.added) added += part.count ?? 0
      if (part.removed) removed += part.count ?? 0
    }
    return { added, removed }
  }
  for (const [path, from] of renames) {
    if (unreadable.has(path) || unreadable.has(from) || !files.has(path)) continue
    const before = baseline.get(from)
    const after = files.get(path)!
    if (!before) continue
    rows.push({ path, kind: 'renamed', from, ...counts(before.text, after.text) })
    consumed.add(path)
    consumed.add(from)
  }
  for (const [path, file] of files) {
    if (consumed.has(path) || unreadable.has(path)) continue
    const before = baseline.get(path)
    if (!before || recreated.has(path)) rows.push({ path, kind: 'added', ...counts('', file.text) })
    else if (before.text !== file.text)
      rows.push({ path, kind: 'modified', ...counts(before.text, file.text) })
  }
  for (const [path, file] of baseline)
    if (!consumed.has(path) && !unreadable.has(path) && !files.has(path))
      rows.push({ path, kind: 'deleted', ...counts(file.text, '') })
  rows.sort((a, b) => a.path.localeCompare(b.path))
  return { changes: rows, lineCountsAvailable: diffLines !== undefined }
}

export const stampDiagnostics = (
  diagnostics: readonly (RawDiagnostic & { engineId: string | null })[],
  files: ReadonlyMap<string, WorkspaceFile>,
  root: string,
  translator: PathTranslator,
  fallbackEngineId: string | null = null
): Diagnostic[] => {
  let trimmedCount = 0
  const stamped: Diagnostic[] = diagnostics.map((diagnostic) => {
    const { line, column, endLine, endColumn, ...rest } = diagnostic
    const valid = (value: number | undefined): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value > 0
    const coordinates: Pick<Diagnostic, 'line' | 'column' | 'endLine' | 'endColumn'> = {}
    if (valid(line)) {
      coordinates.line = line
      if (valid(endLine) && endLine >= line) coordinates.endLine = endLine
      if (valid(column)) {
        coordinates.column = column
        if (
          valid(endColumn) &&
          (coordinates.endLine === undefined || coordinates.endLine === line
            ? endColumn >= column
            : true)
        )
          coordinates.endColumn = endColumn
      }
    }
    if (
      (line !== undefined && !valid(line)) ||
      (column !== undefined && (!valid(line) || !valid(column))) ||
      (endLine !== undefined && (!valid(line) || !valid(endLine) || endLine < line!)) ||
      (endColumn !== undefined &&
        (!valid(line) ||
          !valid(column) ||
          !valid(endColumn) ||
          ((endLine === undefined || endLine === line) && endColumn < column!)))
    )
      trimmedCount++
    const isRuntimeDiagnostic =
      (diagnostic as typeof diagnostic & { [runtimeDiagnostic]?: boolean })[runtimeDiagnostic] ===
      true
    // An explicit null denotes a runtime diagnostic with no reporting engine; only
    // diagnostics that omit the field receive the dispatch engine as a fallback.
    const engineId = Object.hasOwn(diagnostic, 'engineId') ? diagnostic.engineId : fallbackEngineId
    if (diagnostic.path === null) {
      if (engineId !== null && !isRuntimeDiagnostic && diagnostic.engineId !== null)
        throw new E_DEV_STEP_FAILED([engineId, 'returned a diagnostic without a path'])
      return { ...rest, ...coordinates, engineId, outOfScope: false }
    }
    const raw = diagnostic.path
    let path = raw
    let normalized: string | undefined
    if (classifySandboxPathRejection(raw) === undefined) {
      try {
        const canonicalRoot = canonicalizeDevRoot(root)
        const rootPrefix = canonicalRoot === '/' ? '/' : `${canonicalRoot}/`
        const direct = raw.startsWith(rootPrefix) ? raw.slice(rootPrefix.length) : raw
        if (raw.startsWith('/') && !raw.startsWith(rootPrefix))
          throw new Error('host path outside root')
        normalized = normalizeSandboxPath(direct)
        path = normalized
      } catch {
        /* redact below */
      }
    }
    if (normalized === undefined) path = translator.redact(raw)
    return {
      ...rest,
      ...coordinates,
      engineId,
      path,
      outOfScope: normalized === undefined || !files.has(normalized),
    }
  })
  if (trimmedCount > 0 && fallbackEngineId !== null)
    stamped.push({
      path: null,
      severity: 'warning',
      message: `engine "${fallbackEngineId}" returned ${trimmedCount} diagnostic(s) with invalid coordinates; coordinates were trimmed`,
      engineId: fallbackEngineId,
      outOfScope: false,
    })
  return stamped
}
