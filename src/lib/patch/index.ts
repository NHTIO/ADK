/**
 * The structured apply_patch envelope: parser and applier for the
 * `*** Begin Patch` multi-file dialect.
 *
 * @remarks
 * Shared structured-patch primitives for workspace-shaped batteries. This dialect derives from the
 * GitHub Copilot apply_patch format — one of the most robust and battle-tested patch formats
 * in production use, which is also why models already know how to write it. The grammar
 * (`*** Begin Patch` … `*** End Patch`, `*** Add File:` / `*** Delete File:` /
 * `*** Update File:` (+ `*** Move to:`), `@@` context hunks with `+`/`-`/space lines) is
 * preserved exactly — inventing a "better" variation would forfeit the pretraining. Ported
 * from the source server's `doc.apply_patch` adapter (its green e2e suite informs the spec
 * coverage); the context matcher rejects ambiguity (a hunk whose context matches more than
 * one location fails rather than guessing).
 */

/** One parsed `@@` hunk: the context+removal lines and their replacement. */
export interface ParsedHunk {
  oldLines: string[]
  newLines: string[]
  added: number
  removed: number
}

/** `*** Add File:` — create a new file from `+` lines. */
export interface AddOperation {
  type: 'add'
  path: string
  content: string
  added: number
}

/** `*** Delete File:` — remove a file. */
export interface DeleteOperation {
  type: 'delete'
  path: string
}

/** `*** Update File:` (+ optional `*** Move to:`) — apply hunks, optionally rename. */
export interface UpdateOperation {
  type: 'update'
  path: string
  movePath?: string
  hunks: ParsedHunk[]
  added: number
  removed: number
}

/** Any one operation of a structured patch. */
export type PatchOperation = AddOperation | DeleteOperation | UpdateOperation

/** The parsed envelope: ordered operations plus totals. */
export interface ParsedApplyPatch {
  operations: PatchOperation[]
  added: number
  removed: number
}

const PATCH_PREFIX = '*** Begin Patch'
const PATCH_SUFFIX = '*** End Patch'
const ADD_FILE_PREFIX = '*** Add File:'
const DELETE_FILE_PREFIX = '*** Delete File:'
const UPDATE_FILE_PREFIX = '*** Update File:'
const MOVE_TO_PREFIX = '*** Move to:'

/** `true` when `patch` is the structured envelope rather than a unified diff. */
export const isStructuredPatch = (patch: string): boolean =>
  patch.trimStart().startsWith(PATCH_PREFIX)

/** Normalize a workspace path: relative, no `.`/`..`/empty segments, forward slashes. */
export const normalizeWorkspacePath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').trim()
  if (!normalized) {
    throw new Error('apply_patch path cannot be empty')
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`apply_patch path "${path}" must be relative to the workspace root`)
  }
  const segments = normalized.split('/')
  const sanitizedSegments: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(
        `apply_patch path "${path}" contains invalid segment "${segment || '(empty)'}"`
      )
    }
    sanitizedSegments.push(segment)
  }
  return sanitizedSegments.join('/')
}

/**
 * Parse a structured `*** Begin Patch` envelope.
 *
 * @param patch - The raw patch text.
 * @returns The parsed operations.
 */
export const parseStructuredPatch = (patch: string): ParsedApplyPatch => {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const firstLine = lines[0]?.trim()
  if (firstLine !== PATCH_PREFIX) {
    throw new Error('a structured patch must start with "*** Begin Patch"')
  }

  const lastNonEmptyIndex = [...lines].reverse().findIndex((line) => line.trim() !== '')
  const endIndex = lastNonEmptyIndex === -1 ? -1 : lines.length - 1 - lastNonEmptyIndex
  if (endIndex < 0 || lines[endIndex]?.trim() !== PATCH_SUFFIX) {
    throw new Error('a structured patch must end with "*** End Patch"')
  }

  const body = lines.slice(1, endIndex)

  const operations: PatchOperation[] = []
  let totalAdded = 0
  let totalRemoved = 0
  let i = 0

  while (i < body.length) {
    const line = body[i] ?? ''

    if (line.trim() === '' || line.startsWith('*** End of File')) {
      i += 1
      continue
    }

    if (line.startsWith(ADD_FILE_PREFIX)) {
      const path = normalizeWorkspacePath(line.slice(ADD_FILE_PREFIX.length).trim())
      i += 1
      const contentLines: string[] = []
      while (i < body.length) {
        const next = body[i] ?? ''
        if (next.startsWith('*** ')) {
          break
        }
        if (!next.startsWith('+')) {
          throw new Error(`apply_patch add-file line must start with "+": "${next}"`)
        }
        contentLines.push(next.slice(1))
        i += 1
      }

      operations.push({
        type: 'add',
        path,
        content: contentLines.join('\n'),
        added: contentLines.length,
      })
      totalAdded += contentLines.length
      continue
    }

    if (line.startsWith(DELETE_FILE_PREFIX)) {
      const path = normalizeWorkspacePath(line.slice(DELETE_FILE_PREFIX.length).trim())
      operations.push({ type: 'delete', path })
      i += 1
      continue
    }

    if (!line.startsWith(UPDATE_FILE_PREFIX)) {
      throw new Error(`apply_patch invalid structured patch header: "${line}"`)
    }

    const path = normalizeWorkspacePath(line.slice(UPDATE_FILE_PREFIX.length).trim())
    i += 1

    let movePath: string | undefined
    if ((body[i] ?? '').startsWith(MOVE_TO_PREFIX)) {
      movePath = normalizeWorkspacePath((body[i] ?? '').slice(MOVE_TO_PREFIX.length).trim())
      i += 1
    }

    const hunks: ParsedHunk[] = []
    let opAdded = 0
    let opRemoved = 0

    while (i < body.length && (body[i] ?? '').startsWith('@@')) {
      i += 1
      const hunkLines: string[] = []
      while (i < body.length) {
        const next = body[i] ?? ''
        if (next.startsWith('@@') || next.startsWith('*** ')) {
          break
        }
        hunkLines.push(next)
        i += 1
      }

      if (hunkLines.length === 0) {
        throw new Error('apply_patch contains an empty hunk')
      }

      const oldLines: string[] = []
      const newLines: string[] = []
      let added = 0
      let removed = 0

      for (const hunkLine of hunkLines) {
        if (hunkLine.startsWith('+')) {
          newLines.push(hunkLine.slice(1))
          added += 1
        } else if (hunkLine.startsWith('-')) {
          oldLines.push(hunkLine.slice(1))
          removed += 1
        } else if (hunkLine.startsWith(' ')) {
          const contextLine = hunkLine.slice(1)
          oldLines.push(contextLine)
          newLines.push(contextLine)
        } else {
          throw new Error(
            `apply_patch invalid hunk line (must start with +, -, or space): "${hunkLine}"`
          )
        }
      }

      if (added === 0 && removed === 0) {
        throw new Error('apply_patch hunk must contain at least one added or removed line')
      }

      opAdded += added
      opRemoved += removed
      hunks.push({ oldLines, newLines, added, removed })
    }

    if (hunks.length === 0) {
      throw new Error(`apply_patch update operation for "${path}" must contain at least one hunk`)
    }

    operations.push({ type: 'update', path, movePath, hunks, added: opAdded, removed: opRemoved })
    totalAdded += opAdded
    totalRemoved += opRemoved
  }

  if (operations.length === 0) {
    throw new Error('apply_patch contains no operations')
  }

  return {
    operations,
    added: totalAdded,
    removed: totalRemoved,
  }
}

const countSequenceMatches = (haystack: string[], needle: string[], start: number): number => {
  if (needle.length === 0) {
    return 0
  }
  let matches = 0
  let i = start
  while (i <= haystack.length - needle.length) {
    let matched = true
    let j = 0
    while (j < needle.length) {
      if (haystack[i + j] !== needle[j]) {
        matched = false
        break
      }
      j += 1
    }
    if (matched) {
      matches += 1
    }
    i += 1
  }
  return matches
}

const findExactSequence = (haystack: string[], needle: string[], start: number): number => {
  if (needle.length === 0) {
    return start
  }
  let i = start
  while (i <= haystack.length - needle.length) {
    let matched = true
    let j = 0
    while (j < needle.length) {
      if (haystack[i + j] !== needle[j]) {
        matched = false
        break
      }
      j += 1
    }
    if (matched) {
      return i
    }
    i += 1
  }
  return -1
}

/**
 * Apply an update operation's hunks to `inputText`. Context matching is exact and rejects
 * ambiguity: a hunk whose old-lines match more than one location past the cursor fails
 * rather than guessing.
 *
 * The input's line-ending convention is preserved: a file containing CRLF is rejoined with CRLF,
 * so a one-line edit stays a one-line diff rather than a whole-file newline rewrite.
 *
 * @param inputText - The file's current text.
 * @param hunks - The parsed hunks, in order.
 * @returns The patched text, using the input's dominant line terminator.
 */
export const applyUpdateHunks = (inputText: string, hunks: ParsedHunk[]): string => {
  // Match the input's dominant terminator so a localized edit does not rewrite every line of a
  // CRLF file. Hunk text is always LF-split internally; only the join is convention-aware.
  const newline = inputText.includes('\r\n') ? '\r\n' : '\n'
  const lines = inputText.replace(/\r\n/g, '\n').split('\n')
  let cursor = 0
  for (const hunk of hunks) {
    const matchCount = countSequenceMatches(lines, hunk.oldLines, cursor)
    if (matchCount > 1) {
      throw new Error('patch context is ambiguous and matches multiple locations')
    }
    const start = findExactSequence(lines, hunk.oldLines, cursor)
    if (start === -1) {
      throw new Error('the patch could not be applied cleanly to the source text')
    }
    lines.splice(start, hunk.oldLines.length, ...hunk.newLines)
    cursor = start + hunk.newLines.length
  }
  return lines.join(newline)
}

/** One file in the virtual workspace a structured patch operates over. */
export interface WorkspaceFile {
  text: string
  mimeType: string
}

/**
 * Apply a parsed structured patch to a virtual workspace of files keyed by normalized path.
 *
 * @param files - The workspace (mutated in place).
 * @param patch - The parsed envelope.
 * @returns The workspace and the number of files touched.
 */
export const applyOperations = (
  files: Map<string, WorkspaceFile>,
  patch: ParsedApplyPatch
): { files: Map<string, WorkspaceFile>; modifiedFiles: number } => {
  let modifiedFiles = 0

  for (const operation of patch.operations) {
    if (operation.type === 'add') {
      if (files.has(operation.path)) {
        throw new Error(`cannot add file "${operation.path}": the path already exists`)
      }
      files.set(operation.path, {
        text: operation.content,
        mimeType: inferTextMimeFromPath(operation.path),
      })
      modifiedFiles += 1
      continue
    }

    if (operation.type === 'delete') {
      if (!files.has(operation.path)) {
        throw new Error(`cannot delete file "${operation.path}": the path does not exist`)
      }
      files.delete(operation.path)
      modifiedFiles += 1
      continue
    }

    const current = files.get(operation.path)
    if (!current) {
      throw new Error(`cannot update file "${operation.path}": the path does not exist`)
    }

    const updatedText = applyUpdateHunks(current.text, operation.hunks)
    const targetPath = operation.movePath ?? operation.path

    if (operation.movePath && files.has(targetPath)) {
      throw new Error(
        `cannot move file "${operation.path}" to "${targetPath}": the target already exists`
      )
    }

    files.delete(operation.path)
    files.set(targetPath, {
      text: updatedText,
      mimeType: current.mimeType,
    })
    modifiedFiles += 1
  }

  return { files, modifiedFiles }
}

/** Infer a text MIME from a workspace path's extension (Add File outputs). */
export const inferTextMimeFromPath = (path: string): string => {
  const dot = path.lastIndexOf('.')
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (ext === 'json') return 'application/json'
  if (ext === 'md' || ext === 'markdown') return 'text/markdown'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'yaml' || ext === 'yml') return 'application/yaml'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  return 'text/plain'
}
