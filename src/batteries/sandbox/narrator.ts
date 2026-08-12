import type { ModelPath, ModelWriteRoot } from './types'

/** Exhaustive model-facing sandbox outcome. */
export type SandboxOutcome =
  | { kind: 'not-found'; path: string }
  | { kind: 'denied-by-policy'; path: string; axis: 'read' | 'write' }
  | { kind: 'gate-declined'; note?: string }
  | { kind: 'gate-unavailable'; reason: 'timeout' | 'error' }
  | {
      kind: 'over-budget'
      bound: 'maxTerminalPayloadBytes'
      observedAtLeast: number
      limit: number
    }
  | { kind: 'scope-limited'; shown: number; atDepth: number; bound: 'maxDepth' }
  | { kind: 'not-a-regular-file'; path: string; kind_: string }
  | { kind: 'is-a-directory'; path: string }
  | {
      kind: 'path-rejected'
      input: string
      reason: 'escape' | 'absolute-host' | 'home' | 'unc' | 'device' | 'nul'
    }
  /** Model-facing root, conventionally `/`; NEVER the configured absolute host path. */
  | { kind: 'outside-write-root'; path: ModelPath; writeRoot: ModelWriteRoot }
  | { kind: 'sandbox-violation'; violations: readonly string[]; exitCode: number }
  | { kind: 'nonzero-exit'; exitCode: number }
  | { kind: 'no-matches'; pattern: string; scope: string }
  | { kind: 'unknown-media'; mediaId: string }
  | { kind: 'invalid-pattern'; pattern: string; detail: string }
  | { kind: 'not-a-directory'; path: string }
  | { kind: 'io-failure'; path?: string; detail: string }
  | { kind: 'aborted' }
  | { kind: 'timed-out'; bound: 'timeout_seconds'; limitSeconds: number }
/** Model-facing narration seam; implementations must be total over {@link SandboxOutcome}. */
export type SandboxNarrator = (outcome: SandboxOutcome) => string
/**
 * Render a path rejection with the remedy that fits its REASON.
 *
 * @remarks
 * Rule 2 of the LLM-operator rules: a failure is actionable or it is a loop. "Use a workspace-relative
 * path" is right for a `../` escape and useless for a NUL byte — the model cannot act on it, so it
 * retries a variation that fails identically. Each arm states the accepted form and echoes the input
 * as understood. Extracted rather than nested so exhaustiveness is enforced by this function's own
 * return type, with no `default` arm to silently mis-narrate a future reason.
 *
 * @param reason - Why the path was refused.
 * @param input - The model's path, echoed back.
 * @returns The model-facing message.
 */
const narratePathRejection = (
  reason: Extract<SandboxOutcome, { kind: 'path-rejected' }>['reason'],
  input: string
): string => {
  switch (reason) {
    case 'nul':
      return `Path rejected: it contains a NUL byte, which cannot appear in a filename. Remove it and try again (${JSON.stringify(input)}).`
    case 'home':
      return `Path rejected: '~' is not expanded here. Paths are relative to the workspace root, so name the directory directly (${input}).`
    case 'absolute-host':
      return `Path rejected: a drive letter names a host path, which is outside the workspace. Use a workspace-relative path (${input}).`
    case 'device':
      return `Path rejected: device and verbatim prefixes are not addressable here. Use a workspace-relative path (${input}).`
    case 'unc':
      return `Path rejected: a network share is outside the workspace. Use a workspace-relative path (${input}).`
    case 'escape':
      return `Path rejected: '../' leads outside the workspace root. Try a path within it, such as 'src/index.ts' (${input}).`
  }
}

/** Existence-blind default narrator; not-found and denied-by-policy intentionally share wording. */
export const defaultSandboxNarrator: SandboxNarrator = (o) => {
  switch (o.kind) {
    case 'not-found':
    case 'denied-by-policy':
      return `No readable entry at <${o.path}>; retry with a known sandbox-relative path or provide a valid handle.`
    case 'gate-declined':
      return o.note
        ? `Approval was declined: ${o.note}; request approval again or retry without the declined option.`
        : 'Approval was declined; request approval and try again.'
    case 'gate-unavailable':
      return `Sandbox gate ${o.reason}; retry when available.`
    case 'over-budget':
      return `Output exceeded ${o.bound} (${o.observedAtLeast}+ bytes; limit ${o.limit}); retry with a smaller request or raise the limit.`
    case 'scope-limited':
      return `Search stopped at depth ${o.atDepth}; raise max_depth and try again.`
    case 'not-a-regular-file':
      return `Not a regular file: <${o.path}>; retry with a regular file or use the directory operation.`
    case 'is-a-directory':
      return `Path is a directory: <${o.path}>; retry with a file path or use a directory operation if available.`
    case 'path-rejected':
      return narratePathRejection(o.reason, o.input)
    case 'outside-write-root':
      // `createModelWriteRoot` normalises the sandbox root to the empty relative string; render it as
      // `/` — the model-facing "top of what you can see" — so the message never reads `outside <>`.
      return `Write path <${o.path}> is outside <${o.writeRoot === '' ? '/' : o.writeRoot}>; choose a path inside it.`
    case 'sandbox-violation':
      return `Sandbox blocked the command (exit ${o.exitCode}): ${o.violations.join('; ')}; narrow the command to an allowed path or request access.`
    case 'nonzero-exit':
      return `Command exited with status ${o.exitCode}; inspect the command arguments and retry with a narrower operation.`
    case 'no-matches':
      return `No matches for pattern <${o.pattern}> in scope <${o.scope}>; use a narrower operation or try a different pattern or scope.`
    case 'unknown-media':
      return `Unknown media: ${o.mediaId}; retry with a valid media handle or use a media-discovery operation if available.`
    case 'invalid-pattern':
      return `Invalid pattern ${o.pattern}: ${o.detail}; correct the pattern and retry.`
    case 'not-a-directory':
      return `Not a directory: <${o.path}>; choose a directory path and retry.`
    case 'io-failure':
      return `I/O failure${o.path ? ` at <${o.path}>` : ''}: ${o.detail}; retry the operation or choose a narrower path.`
    case 'aborted':
      return 'Operation aborted; try again.'
    case 'timed-out':
      return `Operation timed out after ${o.limitSeconds} seconds; raise timeout_seconds and try again.`
  }
  const exhaustive: never = o
  return exhaustive
}
