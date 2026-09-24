/**
 * Cross-environment executor adapter that wraps the Claude Code CLI as a `DispatchExecutorFn`
 * destination.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli/adapter
 *
 * @remarks
 * The first battery in the "CLI harness" family: rather than a direct wire-format provider, this
 * adapter drives an external coding-agent CLI binary that is itself a complete agent loop. Since a
 * subprocess must be spawned anyway, ALL Claude-Code-specific complexity — spawning the real
 * `claude` binary, hosting an MCP bridge server, translating its stream-json — lives in a
 * dedicated wrapper process (`wrapper.ts`, shipped as a sibling dist asset); this adapter only
 * ever spawns and drives that wrapper over the small, harness-agnostic protocol in `./wire`.
 *
 * Every dispatch iteration is stateless and self-contained: the full accumulated history renders
 * into one `-p` prompt string (`buildClaudeCodeCliPrompt`), a fresh wrapper is spawned, and real
 * ADK tools are bridged into the CLI's own tool loop via MCP — but actual execution always happens
 * on the ADK side, through `tool.executor(ctx)(args)`, exactly like every other LLM battery.
 */

import { sha256 } from 'js-sha256'
import { validateOptions } from './validation'
import { deCollideToolCallIds } from '../chat_common'
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'
import { createNdjsonLineReader, encodeWrapperCommand } from './wire'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  Tokenizable,
  ToolCall,
  Memory,
  Message,
  Media,
  ArtifactTool,
  SpooledArtifact,
} from '@nhtio/adk/common'
import {
  E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR,
  E_CLAUDE_CODE_CLI_WRAPPER_CRASHED,
  E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO,
  E_CLAUDE_CODE_CLI_STREAM_ERROR,
  E_CLAUDE_CODE_CLI_STREAM_STALLED,
  E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT,
  E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED,
  E_CLAUDE_CODE_CLI_TURN_FAILED,
  E_INVALID_CLAUDE_CODE_CLI_OPTIONS,
  E_CLAUDE_CODE_CLI_CONTEXT_OVERFLOW,
  E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND,
} from './exceptions'
import {
  defaultDescriptionToChatCompletionsJsonSchema,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
  defaultRenderStandingInstructions,
  defaultRenderMemories,
  defaultRenderRetrievables,
  defaultRenderRetrievableHandleBody,
  defaultRenderRetrievableSafetyDirective,
  defaultRenderFirstPartyRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  defaultRenderThought,
  defaultFilterThoughts,
  defaultToolsToChatCompletionsTools,
  defaultRenderChatCompletionsSystemPrompt,
  defaultRenderClaudeCodeCliTimelineMessage,
  defaultRenderClaudeCodeCliToolCallResult,
  defaultBuildClaudeCodeCliPrompt,
  renderArtifactHandleBody,
  looksLikeSpooledArtifact,
} from './helpers'
import type { Tool } from '@nhtio/adk/common'
import type { SpoolStore } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { TokenEncoding, TokenEncodingId } from '@nhtio/adk/types'
import type { WrapperEvent, WrapperCommand, WrapperBridgedTool } from './wire'
import type { DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type {
  ClaudeCodeCliAdapterOptions,
  ClaudeCodeCliHelpers,
  ExecaLike,
  ExecaResolver,
  UnsupportedMediaPolicy,
} from './types'

type OutboundContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

// ─── wrapper path resolution (Decision C) ──────────────────────────────────────

/**
 * Resolve the built wrapper asset's on-disk path relative to this module's own compiled location.
 * `adapter.ts` carries its own `@module` tag (per the per-file tagging convention every other
 * multi-file battery uses), so it compiles to `dist/batteries/llm/claude_code_cli/adapter.mjs` —
 * three directories below the package root, where the wrapper (an explicit, un-tagged
 * `vite.config.mts` entry key) compiles to `dist/claude-code-cli-wrapper.mjs`.
 */
export const resolveDefaultWrapperPath = (): string => {
  // `typeof require === 'function'` alone is not a safe CJS-vs-ESM discriminator: rolldown's ESM
  // output wraps `require` in a shim/Proxy (falling back to itself when the real `require` is
  // absent) that still reports `typeof === 'function'`, but whose `.resolve` is not itself a
  // function — calling it throws instead of falling through to the URL-based ESM branch below.
  if (typeof require === 'function' && typeof require.resolve === 'function') {
    return require.resolve('../../../claude-code-cli-wrapper.cjs')
  }
  // `URL.pathname` is percent-encoded — a real install path containing a space, unicode, or any
  // other URL-reserved character would produce a non-existent argv path (e.g. `%20` instead of a
  // literal space) once handed to `execaFn`/`spawn` below. `decodeURIComponent` undoes that percent
  // encoding to recover the native filesystem path — equivalent to `node:url`'s `fileURLToPath` for
  // a POSIX path (verified directly), which this module avoids importing at module scope: this
  // file is transitively pulled into the browser test project via `src/batteries`'s barrel (e.g.
  // `tests/unit/batteries/index.cross.spec.ts`), and Vite externalizes `node:url` there, throwing
  // on any access to `fileURLToPath` at import time. This battery is POSIX-only in v1 anyway
  // (validated at options-construction time), so a POSIX-only decode is exactly the right amount
  // of `node:url` behavior to reimplement without importing it.
  return decodeURIComponent(
    new URL('../../../claude-code-cli-wrapper.mjs', import.meta.url).pathname
  )
}

/**
 * Existence-check a candidate wrapper path, lazily acquiring `node:fs`'s `existsSync` — never
 * imported at module scope for the same reason `resolveDefaultWrapperPath` avoids `node:url`
 * above: this file is transitively pulled into the browser test project via `src/batteries`'s
 * barrel, and a module-scope Node-builtin import would throw at import time there. Any failure to
 * even acquire `node:fs` (e.g. a hostile/exotic runtime) is treated as "does not exist" rather
 * than propagating, since this is only ever used to pick between fallback candidates.
 */
const existsOnDisk = async (path: string): Promise<boolean> => {
  try {
    const fs = (await import('node:fs')) as { existsSync?: (p: string) => boolean }
    return typeof fs.existsSync === 'function' && fs.existsSync(path)
  } catch {
    return false
  }
}

/**
 * Result of a self-reference resolution attempt: the resolved, existence-checked sibling path when
 * found, plus a full log of every candidate/reason tried — reported to the caller so
 * {@link E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND} can name everything actually checked, not just the
 * relative resolver's own error.
 */
interface SelfReferenceResolution {
  path?: string
  tried: string[]
}

/**
 * Injectable seams for {@link resolveWrapperPathViaSelfReference}'s two internal self-reference
 * routes — internal, non-breaking test hooks (mirrors {@link WrapperPathResolutionSeams} below,
 * one layer deeper). A real ambient `require` is module-scoped per compiled file, so a test file
 * patching its OWN `require.resolve` has no effect on `adapter.ts`'s ambient `require` (verified
 * directly — each ES module/CJS wrapper gets its own `require` binding, even within the same
 * vitest worker/module graph), and this repo's own `@nhtio/adk` package genuinely self-resolves
 * successfully inside the test environment (this worktree's own `package.json` is itself named
 * `@nhtio/adk`), so route 1 can't be made to fail deterministically without a seam either. These
 * two knobs let a unit test drive both "ambient require resolution failed" and "import.meta.url
 * unavailable" without needing a real bundled/stripped module environment. Both default to the
 * real ambient behavior when omitted.
 */
interface SelfReferenceResolutionSeams {
  ambientRequireResolve?: (specifier: string) => string
  importMetaUrl?: string | undefined
}

/**
 * Resolve the wrapper asset's sibling path relative to THIS PACKAGE's own already-published main
 * entry, rather than relative to the (possibly relocated-by-bundling) adapter module. Node's
 * package self-reference feature — a package resolving its own name as a bare specifier — is
 * depth-independent within `@nhtio/adk`'s own tree, so this survives the adapter code being moved
 * around WITHIN the package by a bundler. It only breaks once the calling code has been physically
 * bundled OUTSIDE `@nhtio/adk`'s own directory tree (e.g. into a consumer's Electron main-process
 * bundle) — at that point self-reference falls back to ordinary node_modules bare-specifier
 * resolution, which succeeds exactly when `@nhtio/adk` is still installed as a resolvable
 * dependency from the bundled code's new location. That is the same "normal case" the published
 * `wrapperPath` override already exists for, so this fallback is a strict improvement with no new
 * failure mode: when it can't resolve, behavior degrades to the pre-existing "throw a clear error"
 * path below rather than a worse outcome.
 *
 * Deliberately resolves this package's `exports['.']` main entry (already published, no `exports`
 * map change needed) and derives the wrapper's path as a sibling of that entry's directory — every
 * `vite.config.mts` `build.lib.entry` key (including the un-tagged wrapper) emits to a flat
 * `dist/` directory, so `dirname(mainEntry) === dirname(wrapperAsset)`.
 *
 * Two independent ways to reach a `require`-like resolver are tried, in this order, because a
 * bundled consumer may land in either shape and each leaves the OTHER unusable:
 *
 * 1. A real ambient `require` — present when THIS MODULE has itself been bundled into a CJS
 *    output (e.g. `esbuild --platform=node --format=cjs`, which is common for an Electron
 *    main-process bundle, the issue's reported scenario). Reused verbatim is the exact same
 *    discriminator `resolveDefaultWrapperPath` above already documents:
 *    `typeof require === 'function' && typeof require.resolve === 'function'` — because a bundled
 *    ESM output can ALSO leave a truthy `require` behind as a dynamic-require shim/Proxy (rolldown
 *    and esbuild both do this) whose `.resolve` is not itself a function, and calling it would
 *    throw rather than genuinely resolving anything. In a genuine CJS bundle this ambient
 *    `require.resolve('@nhtio/adk')` works directly with no `createRequire` bridge needed.
 * 2. `createRequire(import.meta.url)` — the ESM path, used only when step 1 didn't yield a usable
 *    resolver. Verified empirically that esbuild's `--format=cjs` output rewrites every
 *    `import.meta` reference in bundled source to a plain `var import_meta = {}`, so
 *    `import.meta.url` is `undefined` there — `createRequire(undefined)` throws
 *    `ERR_INVALID_ARG_VALUE` outright, so this branch is skipped by checking
 *    `typeof import.meta.url === 'string'` first rather than letting that throw surface as an
 *    opaque, unrelated-looking error. `createRequire` (rather than `import.meta.resolve`) is used
 *    here because — unlike `import.meta.resolve` — its `.resolve` performs a real filesystem
 *    existence check (verified directly: `import.meta.resolve` happily returns a URL for a target
 *    file that does not exist, since it only resolves the `exports` map syntactically;
 *    `require.resolve`, including through `createRequire`, throws `MODULE_NOT_FOUND` for a missing
 *    target), so a resolved path here is already known to exist and only the derived wrapper
 *    sibling still needs its own explicit check below.
 *
 * `tried` always accounts for BOTH routes once step 1 has not already produced a `mainEntry`: step
 * 2 either resolves, records its own failure, or — when `import.meta.url` isn't even a string —
 * records an explicit "skipped: import.meta.url unavailable" entry, so the thrown error's "Tried:"
 * list never silently omits a route just because it was never attempted.
 *
 * A `process.cwd()`-anchored resolution attempt is deliberately NOT included as a further
 * fallback: resolution should stay anchored to the bundle's own module identity, not to a mutable,
 * launch-directory-dependent value that has no necessary relationship to where the bundle — or
 * `@nhtio/adk` — actually live. Failing clearly and pointing at `wrapperPath` is a better outcome
 * than a resolution that silently varies with the process's current working directory.
 */
const resolveWrapperPathViaSelfReference = async (
  wrapperBasename: string,
  seams: SelfReferenceResolutionSeams = {}
): Promise<SelfReferenceResolution> => {
  const tried: string[] = []
  let mainEntry: string | undefined

  const hasAmbientRequire =
    seams.ambientRequireResolve !== undefined ||
    (typeof require === 'function' && typeof require.resolve === 'function')
  if (hasAmbientRequire) {
    try {
      mainEntry = (seams.ambientRequireResolve ?? require.resolve)('@nhtio/adk')
    } catch (err) {
      tried.push(
        `self-reference via ambient require('@nhtio/adk') failed: ${isError(err) ? err.message : String(err)}`
      )
    }
  }

  // Every branch below either resolves `mainEntry` or pushes a `tried` entry explaining why not —
  // so by the time we reach the `mainEntry === undefined` check further down, `tried` can no longer
  // be empty (a prior review round's "no usable ambient require and no import.meta.url" catch-all
  // for a silently-empty `tried` is gone because it is now unreachable: the branch below records
  // its OWN skip reason instead of leaving nothing behind).
  if (mainEntry === undefined) {
    const importMetaUrl = 'importMetaUrl' in seams ? seams.importMetaUrl : import.meta.url
    if (typeof importMetaUrl === 'string') {
      try {
        const { createRequire } = await import('node:module')
        mainEntry = createRequire(importMetaUrl).resolve('@nhtio/adk')
      } catch (err) {
        tried.push(
          `self-reference via createRequire(import.meta.url).resolve('@nhtio/adk') failed: ${isError(err) ? err.message : String(err)}`
        )
      }
    } else {
      // Regression for the AI-review finding: this route being unavailable used to leave no trace
      // at all whenever the ambient-`require` route above HAD recorded something (e.g. it existed
      // but failed) — the "Tried:" list would then name the ambient failure but silently omit that
      // the createRequire route was never even attempted. Recording the skip explicitly means every
      // self-reference route is always accounted for in the thrown error.
      tried.push(
        'self-reference via createRequire(import.meta.url) skipped: import.meta.url unavailable in this module context'
      )
    }
  }

  if (mainEntry === undefined) {
    return { tried }
  }

  const lastSlash = mainEntry.lastIndexOf('/')
  if (lastSlash < 0) {
    tried.push(
      `self-reference resolved '@nhtio/adk' to an unexpected path with no directory separator: ${mainEntry}`
    )
    return { tried }
  }
  const candidate = `${mainEntry.slice(0, lastSlash + 1)}${wrapperBasename}`
  tried.push(candidate)
  return (await existsOnDisk(candidate)) ? { path: candidate, tried } : { tried }
}

/**
 * Injectable seams for {@link resolveWrapperPathWithFallback}'s three collaborators — internal,
 * non-breaking test hooks (never new `ClaudeCodeCliAdapterOptions` fields): swapping these lets
 * unit tests exercise the bundled-fallback and unresolvable branches deterministically, without a
 * real `dist/` build or filesystem mocking. Each defaults to the real implementation above.
 */
interface WrapperPathResolutionSeams {
  resolveRelative?: () => string
  resolveSelfRef?: (wrapperBasename: string) => Promise<SelfReferenceResolution>
  checkExists?: (path: string) => Promise<boolean>
}

/**
 * Internal, non-public resolver used by the executor call site (never `resolveDefaultWrapperPath`
 * itself, which stays synchronous and unchanged for backwards compatibility with any caller that
 * already imports it directly). Tries the existing relative-to-module resolution FIRST — zero
 * behavior change for the common unbundled case — and only falls back to the self-reference
 * lookup when that candidate does not exist on disk (bundling relocated the adapter). Throws
 * {@link E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND} naming every path tried — the relative candidate (or
 * its resolution error) AND every self-reference candidate/reason from
 * {@link resolveWrapperPathViaSelfReference} — when neither resolves, rather than letting a bundled
 * consumer hit an opaque `MODULE_NOT_FOUND`/ENOENT deep inside `execa`, or a truncated error that
 * hides what the self-reference fallback actually attempted.
 *
 * @remarks
 * Electron/asar note: an app packaged into an `asar` archive can still `readFileSync`/`existsSync`
 * transparently-unpacked paths through Electron's patched `fs`, so this existence-check strategy
 * keeps working there without special-casing — but a wrapper asset that ships unpacked (outside
 * `asar`) is still the consumer's responsibility to arrange, same as any other spawned-executable
 * asset; `wrapperPath` remains the escape hatch when that layout doesn't line up.
 *
 * @remarks
 * Coverage note — deployment shapes: this resolver (both branches) only ever finds the wrapper
 * asset when `@nhtio/adk` itself (with `dist/claude-code-cli-wrapper.{cjs,mjs}` inside it) remains
 * an ordinarily-resolvable dependency from wherever the bundle ends up running — the bundle never
 * carries the wrapper asset itself. A bundle relocated outside its original project (so
 * `node_modules/@nhtio/adk` is no longer reachable), or an Electron app that prunes/asar-packs
 * `@nhtio/adk` out of its final package, is NOT covered by either branch and needs the explicit
 * `wrapperPath` option — which is exactly what the thrown error's message directs the caller to.
 */
const resolveWrapperPathWithFallback = async (
  seams: WrapperPathResolutionSeams = {}
): Promise<string> => {
  const resolveRelative = seams.resolveRelative ?? resolveDefaultWrapperPath
  const resolveSelfRef = seams.resolveSelfRef ?? resolveWrapperPathViaSelfReference
  const checkExists = seams.checkExists ?? existsOnDisk

  const tried: string[] = []

  let relative: string | undefined
  try {
    relative = resolveRelative()
  } catch (err) {
    tried.push(isError(err) ? err.message : String(err))
  }
  if (relative !== undefined) {
    tried.push(relative)
    if (await checkExists(relative)) return relative
  }

  // Bundled-CJS wrinkle, made explicit here: in a real esbuild `--format=cjs` bundle,
  // `resolveDefaultWrapperPath`'s ambient-`require.resolve` branch throws `MODULE_NOT_FOUND` for
  // the RELATIVE `../../../claude-code-cli-wrapper.cjs` specifier (that relative path no longer
  // exists once bundling has relocated this module outside `@nhtio/adk`'s own tree), so `relative`
  // stays `undefined` and `isCjsWrapper` defaults `false` — `wrapperBasename` picks the `.mjs`
  // variant even though the CALLING bundle is CJS. This is harmless: the wrapper asset is never
  // imported/required in-process, only spawned as a completely separate `node` child process (see
  // `execaFn(process.execPath, [wrapperPath, ...])` at the call site below), and Node runs a
  // `.mjs`-suffixed file as ESM regardless of the PARENT process's own module format. Picking `.cjs`
  // here would be no more correct — either extension resolves to a real, runnable file once
  // self-reference finds `@nhtio/adk`'s own `dist/` directory.
  const isCjsWrapper = relative !== undefined && relative.endsWith('.cjs')
  const wrapperBasename = isCjsWrapper
    ? 'claude-code-cli-wrapper.cjs'
    : 'claude-code-cli-wrapper.mjs'
  const selfRef = await resolveSelfRef(wrapperBasename)
  tried.push(...selfRef.tried)
  if (selfRef.path !== undefined) return selfRef.path

  throw new E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND([tried.join(', ') || '(no candidates)'])
}

// Test-only aliases, following `transformers_js/adapter.ts`'s `__extractGeneratedText` precedent.
// They are NOT re-exported from `index.ts` or any barrel, but because this file carries its own
// `@module` tag they ARE reachable at runtime through the published
// `@nhtio/adk/batteries/llm/claude_code_cli/adapter` subpath — and that reachability is load-bearing:
// `tests/unit/build/claude_code_cli_wrapper_resolves_bundled.node.spec.ts` imports
// `__resolveWrapperPathWithFallback` from that subpath to prove resolution inside a real bundle.
// They carry no stability guarantee and are not part of the supported API; do not depend on them.
// They are deliberately NOT marked `@internal`: `tsconfig.build.json` sets `stripInternal`, which
// would drop them from the published `.d.ts` and break that bundled test's typed import.
// `__resolveWrapperPathViaSelfReference` is exported one layer deeper than
// `__resolveWrapperPathWithFallback` so a unit test can drive its `SelfReferenceResolutionSeams`
// directly — see that interface's doc comment for why the outer seam (`resolveSelfRef`) can't
// itself deterministically exercise route 1 vs. route 2.
export { resolveWrapperPathWithFallback as __resolveWrapperPathWithFallback }
export { resolveWrapperPathViaSelfReference as __resolveWrapperPathViaSelfReference }

// ─── execa resolution (mirrors execa_executor.ts's lazy-resolver pattern) ──────

const resolveExeca = async (supplied: ExecaResolver | undefined): Promise<ExecaLike> => {
  let value: unknown =
    supplied ?? (() => import('execa') as unknown as Promise<{ execa: ExecaLike }>)
  if (typeof value === 'function' && !('exec' in (value as object))) {
    try {
      value = await (value as () => unknown)()
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR([
        `execa resolver failed: ${detail} — install the optional peer dependency "execa" or supply your own`,
      ])
    }
  }
  if (isObject(value) && 'execa' in value) {
    value = (value as { execa: unknown }).execa
  }
  if (typeof value !== 'function') {
    throw new E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR([
      'execa resolver did not resolve to a function',
    ])
  }
  return value as ExecaLike
}

// ─── option merging ─────────────────────────────────────────────────────────

const mergeRecord = <T extends Record<string, unknown>>(
  layers: ReadonlyArray<T | undefined>
): T | undefined => {
  let merged: T | undefined
  for (const layer of layers) {
    if (!layer) continue
    merged = { ...(merged ?? ({} as T)), ...layer }
  }
  return merged
}

const mergeOptions = (
  baseline: ClaudeCodeCliAdapterOptions,
  exec: Partial<ClaudeCodeCliAdapterOptions> | undefined,
  stash: Partial<ClaudeCodeCliAdapterOptions> | undefined
): Partial<ClaudeCodeCliAdapterOptions> => {
  const layers = [baseline as Partial<ClaudeCodeCliAdapterOptions>, exec ?? {}, stash ?? {}]
  const out: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue
      if (k === 'helpers') continue
      out[k] = v
    }
  }
  const helpers = mergeRecord(layers.map((l) => l.helpers as Record<string, unknown> | undefined))
  if (helpers !== undefined) out.helpers = helpers
  return out as Partial<ClaudeCodeCliAdapterOptions>
}

const resolveHelpers = (
  overrides: Partial<ClaudeCodeCliHelpers> | undefined
): ClaudeCodeCliHelpers => {
  const src = overrides ?? {}
  return {
    descriptionToChatCompletionsJsonSchema:
      src.descriptionToChatCompletionsJsonSchema ?? defaultDescriptionToChatCompletionsJsonSchema,
    renderUntrustedContent: src.renderUntrustedContent ?? defaultRenderUntrustedContent,
    renderTrustedContent: src.renderTrustedContent ?? defaultRenderTrustedContent,
    renderStandingInstructions: src.renderStandingInstructions ?? defaultRenderStandingInstructions,
    renderMemories: src.renderMemories ?? defaultRenderMemories,
    renderRetrievables: src.renderRetrievables ?? defaultRenderRetrievables,
    renderRetrievableHandleBody:
      src.renderRetrievableHandleBody ?? defaultRenderRetrievableHandleBody,
    renderRetrievableSafetyDirective:
      src.renderRetrievableSafetyDirective ?? defaultRenderRetrievableSafetyDirective,
    renderFirstPartyRetrievables:
      src.renderFirstPartyRetrievables ?? defaultRenderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables:
      src.renderThirdPartyPublicRetrievables ?? defaultRenderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables:
      src.renderThirdPartyPrivateRetrievables ?? defaultRenderThirdPartyPrivateRetrievables,
    renderThought: src.renderThought ?? defaultRenderThought,
    filterThoughts: src.filterThoughts ?? defaultFilterThoughts,
    toolsToChatCompletionsTools:
      src.toolsToChatCompletionsTools ?? defaultToolsToChatCompletionsTools,
    renderChatCompletionsSystemPrompt:
      src.renderChatCompletionsSystemPrompt ?? defaultRenderChatCompletionsSystemPrompt,
    renderClaudeCodeCliTimelineMessage:
      src.renderClaudeCodeCliTimelineMessage ?? defaultRenderClaudeCodeCliTimelineMessage,
    renderClaudeCodeCliToolCallResult:
      src.renderClaudeCodeCliToolCallResult ?? defaultRenderClaudeCodeCliToolCallResult,
    buildClaudeCodeCliPrompt: src.buildClaudeCodeCliPrompt ?? defaultBuildClaudeCodeCliPrompt,
  }
}

const estimateTokensOf = async (
  value: { estimateTokens: (encoding: TokenEncoding) => number | Promise<number> },
  encoding: TokenEncodingId
): Promise<number> => Promise.resolve(value.estimateTokens(encoding as TokenEncoding))

// ─── time / checksum helpers ────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString()

/**
 * Normalise a thrown/rejected value into a real `Error` suitable as an exception `.cause`. Mirrors
 * `dispatch_runner.ts`'s internal (non-exported) `toErrorCause` convention: a genuine `Error` (per
 * the cross-realm-safe {@link isError} guard) passes through unchanged; anything else — a string,
 * a plain object, a cross-realm error whose `instanceof Error` is false — is wrapped in a real
 * `Error` whose message is the value's best string form, with the original preserved on `.cause`.
 *
 * Never throws. It runs inside the adapter's last-line-of-defence catch handlers (the `onEvent`
 * rejection handler, the stdout `'data'` listener, the background-shutdown rejection handler), so a
 * throw here would recreate the exact unhandled-rejection / uncaught-exception class it exists to
 * prevent. A hostile thrown value can defeat BOTH `JSON.stringify` and `String` (a `Proxy` with a
 * throwing trap, or an object whose `toJSON` and `toString` both throw) and can even make the
 * `isError` guard itself throw, so each step is guarded and the last resort is a fixed string.
 */
const toErrorCause = (value: unknown): Error => {
  try {
    if (isError(value)) return value
  } catch {
    /* a hostile value can throw from the guard's own property reads; treat it as a non-Error */
  }
  let text: string
  try {
    text =
      typeof value === 'string'
        ? value
        : value === undefined
          ? 'undefined'
          : (JSON.stringify(value) ?? String(value))
  } catch {
    try {
      text = String(value)
    } catch {
      text = '[unserialisable thrown value]'
    }
  }
  return new Error(`non-Error thrown while handling a wrapper event: ${text}`, { cause: value })
}

/**
 * Integrity checksum over `tool`/`args` — matches every other LLM battery's convention
 * (`sha256(canonicalStringify({tool, args}))`, see `ollama/adapter.ts`'s `computeChecksum`), NOT
 * the per-call `requestId`. Identical repeat calls must share this checksum: it feeds
 * `DispatchContext`'s own `#toolCallChecksums` loop-detection counter and cross-bus correlation,
 * neither of which can see a repeat if every call gets a unique value.
 */
const computeChecksum = (tool: string, args: unknown): string =>
  sha256(canonicalStringify({ tool, args }))

// ─── outbound tool-result rendering (decision 8) ───────────────────────────────

const renderMediaListAsOutbound = async (
  mediaList: Media[],
  unsupportedResultMediaPolicy: UnsupportedMediaPolicy
): Promise<{ content: OutboundContentBlock[]; isError: boolean }> => {
  const content: OutboundContentBlock[] = []
  let anyUnsupported = false
  for (const media of mediaList) {
    if (media.kind === 'image') {
      content.push({ type: 'image', data: await media.asBase64(), mimeType: media.mimeType })
      continue
    }
    // Every non-image modality is unsupported on the outbound MCP wire (only text/image content
    // blocks exist there) — routed through the SAME policy family the inbound direction uses
    // (decision 8), rather than an unconditional hardcoded error.
    if (unsupportedResultMediaPolicy === 'throw') {
      anyUnsupported = true
      content.push({
        type: 'text',
        text: `Unsupported result media modality: ${media.kind} (${media.mimeType})`,
      })
      continue
    }
    const byteLen = await media.byteLength().catch(() => undefined)
    content.push({
      type: 'text',
      text: `[media: ${media.filename}, ${media.mimeType}, ${byteLen ?? 'unknown'} bytes]`,
    })
  }
  return { content, isError: anyUnsupported }
}

const renderOutboundResult = async (input: {
  raw: string | Uint8Array | SpooledArtifact | Media | Media[]
  callId: string
  inline: boolean
  spoolStore: SpoolStore
  unsupportedResultMediaPolicy: UnsupportedMediaPolicy
}): Promise<{ content: OutboundContentBlock[]; isError: boolean }> => {
  const { raw, callId, inline } = input

  if (Media.isMedia(raw)) {
    return renderMediaListAsOutbound([raw], input.unsupportedResultMediaPolicy)
  }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((m) => Media.isMedia(m))) {
    return renderMediaListAsOutbound(raw, input.unsupportedResultMediaPolicy)
  }
  if (looksLikeSpooledArtifact(raw)) {
    const artifact = raw as SpooledArtifact
    if (inline === false) {
      let byteLength = 0
      let lineCount = 0
      try {
        byteLength = await artifact.byteLength()
      } catch {
        byteLength = 0
      }
      try {
        lineCount = await artifact.lineCount()
      } catch {
        lineCount = 0
      }
      const body = renderArtifactHandleBody({ callId, artifact, byteLength, lineCount })
      return { content: [{ type: 'text', text: body }], isError: false }
    }
    const text = await artifact.asString()
    return { content: [{ type: 'text', text }], isError: false }
  }
  if (typeof raw === 'string') {
    return { content: [{ type: 'text', text: raw }], isError: false }
  }
  if (isInstanceOf(raw, 'Uint8Array', Uint8Array)) {
    await input.spoolStore.write(callId, raw)
    return {
      content: [{ type: 'text', text: '[binary tool result — see history for details]' }],
      isError: false,
    }
  }
  return { content: [{ type: 'text', text: String(raw) }], isError: false }
}

// ─── the adapter ────────────────────────────────────────────────────────────

/**
 * Opinionated CLI-harness LLM adapter that drives the Claude Code CLI as a `DispatchExecutorFn`
 * destination.
 *
 * @remarks
 * Construction validates options eagerly via {@link validateOptions} and throws
 * {@link @nhtio/adk/batteries/llm/claude_code_cli!E_INVALID_CLAUDE_CODE_CLI_OPTIONS} on failure
 * (including the POSIX-only platform guard and the `apiKey`/`authToken` XOR check). The returned
 * instance is reusable: call {@link ClaudeCodeCliAdapter.executor} once per `DispatchRunner`
 * configuration.
 */
export class ClaudeCodeCliAdapter {
  /** Customary key for per-iteration overrides on `ctx.stash`. */
  public static readonly STASH_KEY = 'claudeCodeCli' as const

  readonly #baseline: ClaudeCodeCliAdapterOptions

  /**
   * @param options - Constructor-baseline options. Re-validated on every iteration after
   *   per-dispatch and per-iteration overrides are layered in.
   * @throws {@link @nhtio/adk/batteries/llm/claude_code_cli!E_INVALID_CLAUDE_CODE_CLI_OPTIONS} when
   *   `options` does not satisfy `claudeCodeCliOptionsSchema`.
   */
  constructor(options: unknown) {
    this.#baseline = validateOptions(options)
  }

  /**
   * Returns a {@link @nhtio/adk!DispatchExecutorFn} bound to this adapter's baseline plus optional
   * executor-scope overrides.
   */
  executor(overrides?: Partial<ClaudeCodeCliAdapterOptions>): DispatchExecutorFn {
    const baseline = this.#baseline
    const adapterClass = ClaudeCodeCliAdapter

    return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
      const localWarn = (msg: string): void => {
        helpers.log.warn({ kind: 'helper-warning', message: msg })
      }

      // ── Step 1: merge & validate ──────────────────────────────────────────
      const stashRaw = ctx.stash.get(adapterClass.STASH_KEY, {}) as unknown
      const stashOverrides =
        stashRaw && typeof stashRaw === 'object'
          ? (stashRaw as Partial<ClaudeCodeCliAdapterOptions>)
          : {}
      const merged = validateOptions(mergeOptions(baseline, overrides, stashOverrides))

      if (merged.tokenEncoding !== null && merged.contextWindow === undefined) {
        throw new E_INVALID_CLAUDE_CODE_CLI_OPTIONS([
          'tokenEncoding is non-null but contextWindow is undefined',
        ])
      }

      // ── Step 2: resolve helpers ───────────────────────────────────────────
      const resolvedHelpers = resolveHelpers(merged.helpers)

      // ── Step 3: resolve execa + wrapper path ──────────────────────────────
      let execaFn: ExecaLike
      try {
        execaFn = await resolveExeca(merged.execa)
      } catch (err) {
        ctx.nack(isError(err) ? err : new Error(String(err)))
        return
      }
      let wrapperPath: string
      try {
        wrapperPath = merged.wrapperPath ?? (await resolveWrapperPathWithFallback())
      } catch (err) {
        ctx.nack(isError(err) ? err : new Error(String(err)))
        return
      }
      const claudeBin = merged.claudeBin ?? 'claude'

      // ── Step 5: pre-render inbound tool-call results (for history) ────────
      // Key by primitive identity, not id: repeated vendor/request ids must not cross-wire results.
      const renderedToolCallResults = new Map<ToolCall, string>()
      for (const tc of ctx.turnToolCalls) {
        const rendered = await resolvedHelpers.renderClaudeCodeCliToolCallResult({
          toolCall: tc,
          results: tc.results as
            | Tokenizable
            | SpooledArtifact
            | SpooledArtifact[]
            | Media
            | Media[],
          tool: ctx.tools.get(tc.tool) as Tool | undefined,
          renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
          renderTrustedContent: resolvedHelpers.renderTrustedContent,
          unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
          warn: localWarn,
        })
        renderedToolCallResults.set(tc, rendered)
      }

      // ── Step 6: build the -p prompt ────────────────────────────────────────
      const { prompt, reasoningPayloads } = await resolvedHelpers.buildClaudeCodeCliPrompt({
        systemPrompt: ctx.systemPrompt,
        renderCtx: ctx,
        standingInstructions: ctx.standingInstructions,
        memories: ctx.turnMemories,
        retrievables: ctx.turnRetrievables,
        messages: ctx.turnMessages,
        thoughts: ctx.turnThoughts,
        toolCalls: ctx.turnToolCalls,
        tools: ctx.tools,
        renderedToolCallResults,
        bucketOrder: merged.bucketOrder ?? [
          'standingInstructions',
          'memories',
          'retrievables',
          'timeline',
        ],
        selfIdentity: merged.selfIdentity ?? 'assistant',
        thoughtSurfacing: merged.thoughtSurfacing ?? 'all-self',
        replayCompatibility: merged.replayCompatibility ?? [],
        unsupportedMediaPolicy: merged.unsupportedMediaPolicy ?? 'throw',
        renderChatCompletionsSystemPrompt: resolvedHelpers.renderChatCompletionsSystemPrompt,
        renderStandingInstructions: resolvedHelpers.renderStandingInstructions,
        renderMemories: resolvedHelpers.renderMemories,
        renderRetrievables: resolvedHelpers.renderRetrievables,
        renderRetrievableSafetyDirective: resolvedHelpers.renderRetrievableSafetyDirective,
        renderFirstPartyRetrievables: resolvedHelpers.renderFirstPartyRetrievables,
        renderThirdPartyPublicRetrievables: resolvedHelpers.renderThirdPartyPublicRetrievables,
        renderThirdPartyPrivateRetrievables: resolvedHelpers.renderThirdPartyPrivateRetrievables,
        renderRetrievableHandleBody: resolvedHelpers.renderRetrievableHandleBody,
        renderClaudeCodeCliTimelineMessage: resolvedHelpers.renderClaudeCodeCliTimelineMessage,
        renderClaudeCodeCliToolCallResult: resolvedHelpers.renderClaudeCodeCliToolCallResult,
        renderThought: resolvedHelpers.renderThought,
        filterThoughts: resolvedHelpers.filterThoughts,
        renderUntrustedContent: resolvedHelpers.renderUntrustedContent,
        renderTrustedContent: resolvedHelpers.renderTrustedContent,
        warn: localWarn,
      })

      // A `-p` prompt string has no side channel for an opaque, vendor-specific reasoning payload
      // the way Ollama/OpenAI's JSON request bodies do (`_adk_reasoning_payloads`) — there is
      // nowhere in this wire to forward one. Surface that loss as a diagnostic rather than
      // silently dropping it, matching the honesty standard applied to every other documented v1
      // limitation of this battery (text-only media, subagent text).
      if (reasoningPayloads.length > 0) {
        helpers.log.debug({
          kind: 'reasoning-payload-dropped',
          message: `${reasoningPayloads.length} opaque reasoning payload(s) matched replayCompatibility but have no destination on the Claude Code CLI wire (no side channel exists for a '-p' prompt) and were dropped.`,
        })
      }

      // ── Step 7: build the bridged-tools set (excluding disallowedTools) ───
      const disallowed = new Set(merged.disallowedTools ?? [])
      const visibleTools = ctx.tools.visible().filter((t) => !disallowed.has(t.name))
      const bridgedTools: WrapperBridgedTool[] = visibleTools.map((t) => {
        const described = t.describe()
        const inputSchema = resolvedHelpers.descriptionToChatCompletionsJsonSchema(
          described.inputSchema as never
        )
        return {
          name: described.name,
          description: described.description,
          inputSchema:
            inputSchema && Object.keys(inputSchema).length > 0
              ? (inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} },
        }
      })

      // ── Step 8: context window enforcement ────────────────────────────────
      if (merged.tokenEncoding !== null && merged.contextWindow !== undefined) {
        const encoding = merged.tokenEncoding as TokenEncodingId
        // The rendered prompt is the actual `-p` wire value. Measure it directly rather than
        // re-summing its source buckets: renderers add envelopes, provenance, and ordering.
        const promptTokens = await estimateTokensOf(new Tokenizable(prompt), encoding)
        const appendSystemPromptTokens = merged.appendSystemPrompt
          ? await estimateTokensOf(new Tokenizable(merged.appendSystemPrompt), encoding)
          : 0

        // Keep source-bucket diagnostics for middleware deciding what to shed. They are not part
        // of the authoritative total above, since their content is already represented by prompt.
        const rawSystemPrompt = await estimateTokensOf(ctx.systemPrompt, encoding)
        let rawStandingInstructions = 0
        for (const value of ctx.standingInstructions)
          rawStandingInstructions += await estimateTokensOf(value, encoding)
        let rawMemories = 0
        for (const value of ctx.turnMemories as Set<Memory>)
          rawMemories += await estimateTokensOf(value.content, encoding)
        let rawRetrievables = 0
        for (const r of ctx.turnRetrievables) {
          rawRetrievables +=
            !r.inline && SpooledArtifact.isSpooledArtifact(r.content) && r.content.hasSizeHints()
              ? r.content.estimateHandleTokens(
                  r.id,
                  encoding as TokenEncoding,
                  resolvedHelpers.renderRetrievableHandleBody
                )
              : await estimateTokensOf(r.content, encoding)
        }
        let rawTimeline = 0
        for (const msg of ctx.turnMessages)
          if (msg.content !== undefined)
            rawTimeline += await estimateTokensOf(msg.content, encoding)
        for (const thought of ctx.turnThoughts)
          rawTimeline += await estimateTokensOf(thought.content, encoding)
        for (const rendered of renderedToolCallResults.values())
          rawTimeline += await estimateTokensOf(new Tokenizable(rendered), encoding)
        // Claude Code receives declarations through MCP, not a wire `tools` array. This stable
        // serialization is an honest floor: JSON declarations plus the CLI-visible names.
        const toolSerialization = `${JSON.stringify(bridgedTools)}|${bridgedTools
          .map((t) => `mcp__adk_bridge__${t.name}`)
          .join(',')}`
        const tools = await estimateTokensOf(new Tokenizable(toolSerialization), encoding)
        const perBucket = {
          prompt: promptTokens,
          appendSystemPrompt: appendSystemPromptTokens,
          tools,
          raw: {
            systemPrompt: rawSystemPrompt,
            standingInstructions: rawStandingInstructions,
            memories: rawMemories,
            retrievables: rawRetrievables,
            timeline: rawTimeline,
          },
        }
        const total = promptTokens + appendSystemPromptTokens + tools
        helpers.log.debug({
          kind: 'context-window-usage',
          message: `Context window usage: ${total}/${merged.contextWindow} tokens`,
          payload: { total, limit: merged.contextWindow, encoding, perBucket },
        })
        if (total > merged.contextWindow)
          throw new E_CLAUDE_CODE_CLI_CONTEXT_OVERFLOW([
            total,
            merged.contextWindow,
            encoding,
            JSON.stringify(perBucket),
          ])
      }

      // ── Step 9: spawn the wrapper ──────────────────────────────────────────
      const spoolStore = merged.spoolStore ?? new InMemorySpoolStore()
      let child: ReturnType<ExecaLike>
      try {
        child = execaFn(process.execPath, [wrapperPath], { cleanup: true })
      } catch (err) {
        ctx.nack(
          new E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR([isError(err) ? err.message : String(err)])
        )
        return
      }

      const startupTimeoutMs = merged.startupTimeoutMs ?? 45_000
      const streamIdleTimeoutMs = merged.streamIdleTimeoutMs ?? 60_000
      const disposeGraceMs = merged.disposeGraceMs ?? 2_000

      let sawReady = false
      let sawInit = false
      // Set SYNCHRONOUSLY the instant a terminal `result`/`error` event is observed — before any
      // `await` (e.g. `sealCurrentMessage()`) runs. The wrapper closing stdout immediately after
      // writing its terminal line is a real, observed race: without this flag, `stdout`'s `'end'`
      // handler can fire and call `settleOnce` (nacking the turn as an unexpected exit) while the
      // `result` handler is still awaiting `sealCurrentMessage()`, even though `settleOnce` itself
      // is idempotent-guarded — the guard only helps once one of the two paths has actually run.
      let sawTerminalEvent = false
      let startupTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      // Set once the outer `await new Promise<void>(...)` below is constructed. The startup/idle
      // timers are armed BEFORE that promise exists, so their settleOnce() callbacks must resolve
      // it through this indirection rather than a `finish` closure defined only inside it — without
      // this, a startup or stream-idle timeout would settle ctx (nack) but never resolve the outer
      // promise, hanging the executor forever.
      let resolveIteration: (() => void) | undefined
      let currentMessageId: string | undefined
      let currentMessageBuffer = ''
      let sealedMessage = false
      // Count of `tool_call_request`s currently executing (accepted but not yet answered with a
      // `tool_call_response`). `streamIdleTimeoutMs` measures MODEL-stream idleness — the wrapper
      // waiting on Claude — not ADK tool-execution latency; a real tool (a web search, a sandboxed
      // run) can legitimately take longer than a short idle timeout with zero model-stream activity
      // in between, which would otherwise be falsely nacked as `STREAM_STALLED`. While this is
      // positive, the idle timer is suspended entirely; it re-arms only once EVERY in-flight call
      // has answered, using a counter (not a boolean) because the wrapper's MCP bridge hands out a
      // fresh id per JSON-RPC CallTool request and can in principle have more than one call in
      // flight before the first is answered. This intentionally does NOT add a separate
      // tool-execution timeout — that is a different feature, out of scope here.
      let inFlightToolCalls = 0

      const clearStartupTimer = (): void => {
        if (startupTimer) clearTimeout(startupTimer)
        startupTimer = undefined
      }
      const clearIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = undefined
      }
      const maybeClearStartupTimer = (): void => {
        if (sawReady && sawInit) clearStartupTimer()
      }

      const writeCommand = (command: WrapperCommand): void => {
        try {
          child.stdin?.write(encodeWrapperCommand(command))
        } catch {
          /* the wrapper's stdin may already be gone */
        }
      }

      const gracefulShutdown = async (): Promise<void> => {
        writeCommand({ type: 'shutdown' })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, disposeGraceMs)
          // This inner chain is its own, independently-floating promise (the surrounding `new
          // Promise<void>` executor above never calls `reject`, so `gracefulShutdown()`'s own
          // returned promise cannot reject from this step) — `.finally()` runs its callback on
          // EITHER outcome but still re-raises the original rejection on its OWN returned promise
          // afterwards, and that returned promise is not otherwise referenced. If `child` rejects
          // (e.g. an execa spawn failure), this becomes an unhandled rejection entirely on its own,
          // regardless of whether callers of `gracefulShutdown()` attach a `.catch()` — the `.catch`
          // below is what actually closes that off.
          void Promise.resolve(child)
            .finally(() => {
              clearTimeout(timer)
              resolve()
            })
            .catch(() => {
              /* already handled above by resolving the outer promise; nothing else to do with a
                 rejected child here */
            })
        })
        try {
          child.kill('SIGTERM')
        } catch {
          /* already exited */
        }
      }

      // Fire-and-forget `gracefulShutdown()` at every non-awaited call site below: it is async and
      // CAN reject (e.g. the `child` promise it awaits inside a `.finally` can itself reject, and
      // `child.kill('SIGTERM')`'s own try/catch only guards the synchronous call, not any of the
      // awaited steps before it) — a bare `void gracefulShutdown()` leaves that rejection with no
      // attached handler, becoming an unhandled promise rejection that crashes the host process by
      // default (Node >= 15). That is exactly the class of bug issue #39 is about; best-effort
      // teardown must never surface as one. `settleOnce`'s own resolution must also never wait on
      // this — shutdown is a courtesy to the wrapper process, not a precondition for the executor
      // settling.
      const shutdownInBackground = (): void => {
        gracefulShutdown().catch((err: unknown) => {
          const cause = toErrorCause(err)
          try {
            helpers.log.debug({
              kind: 'graceful-shutdown-rejected',
              message: `Best-effort wrapper shutdown failed; ignoring (the turn has already settled or is settling independently): ${cause.message}`,
              payload: { cause: cause.message },
            })
          } catch {
            /* logging itself must never escape a fire-and-forget cleanup path */
          }
        })
      }

      const abortListener = (): void => {
        shutdownInBackground()
      }
      ctx.abortSignal.addEventListener('abort', abortListener, { once: true })
      const detachAbortListener = (): void =>
        ctx.abortSignal.removeEventListener('abort', abortListener)

      // `fn` used to run with no try/catch: a throw inside a settlement callback (e.g.
      // `helpers.reportGenerationStats(...)` or `ctx.ack()`/`ctx.nack()` throwing
      // `E_LLM_EXECUTION_ALREADY_SIGNALLED` on a lost race) propagated out of `settleOnce` itself
      // AFTER `settled` had already flipped true. Every OTHER settlement call site resolves the
      // iteration promise from WITHIN its own `fn` (the startup/idle timers, the `error` branch, the
      // Fix-B `onEvent(...).catch(...)` handler, the stdout `'end'` handler, the wrapper-process
      // `.then/.catch`) — a throw meant that code never ran. The `result` branch is the one
      // exception: it deliberately calls `finish()` AFTER `settleOnce(...)` returns (to await the
      // wrapper's real exit first, see the comment at that call site) rather than inside `fn`, so a
      // throw there aborted the branch before `finish()` was ever reached. Either way, nothing else
      // in the file resolves the promise, and the executor hangs forever.
      //
      // The catch below guarantees resolution ONLY on that failure path — nacking (unless something
      // already signalled) and force-resolving the iteration promise — without changing the timing
      // of the NORMAL, non-throwing path for any caller (in particular, the `result` branch above
      // still resolves only after awaiting the wrapper's exit when `fn` does not throw).
      //
      // Every step inside the `catch` is individually try/catch-guarded, and `resolveIteration?.()`
      // runs in a `finally` gated on a local `threw` flag — NOT sequentially after the log/nack/
      // shutdown calls — because review round 2 found that the original version called
      // `helpers.log.error(...)` (itself capable of throwing, e.g. a caller-supplied logger) BEFORE
      // `resolveIteration?.()`: if the logger threw, resolution was skipped entirely even though
      // `settled` was already `true`, so every LATER `settleOnce` call anywhere in the file becomes
      // a silent no-op (its own `if (settled) return` guard fires first) — hanging the executor with
      // no remaining path to resolve it, and the throw itself would escape whichever caller invoked
      // `settleOnce` (e.g. the stdout `'data'` listener's own catch block, becoming an uncaught
      // exception). Guaranteeing `resolveIteration?.()` via `finally` makes `settleOnce` itself
      // incapable of throwing or skipping resolution, regardless of which best-effort step fails.
      const settleOnce = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearStartupTimer()
        clearIdleTimer()
        detachAbortListener()
        let threw = false
        try {
          fn()
        } catch (err) {
          threw = true
          try {
            const cause = toErrorCause(err)
            try {
              helpers.log.error({
                kind: 'settlement-handler-threw',
                message: `A dispatch settlement handler threw while finalising the turn; nacking (if not already signalled) instead of leaving the executor hung: ${cause.message}`,
                payload: { cause: cause.message },
              })
            } catch {
              /* a throwing logger must not itself prevent nacking/resolving below */
            }
            // `ctx.ack()`/`ctx.nack()` are single-shot and throw `E_LLM_EXECUTION_ALREADY_SIGNALLED`
            // on a second call — `fn` may have already signalled successfully before a LATER
            // statement in the same callback threw (e.g. `reportGenerationStats` throwing before
            // `ctx.ack()` runs is safe to nack; `ctx.ack()` itself throwing means it was already
            // signalled by a race, and nacking again would itself throw). Only nack if nothing has
            // signalled yet, and never let a lost race here escape as a second thrown error.
            if (!ctx.isSignalled) {
              try {
                ctx.nack(new E_CLAUDE_CODE_CLI_STREAM_ERROR([cause.message], { cause }))
              } catch {
                /* lost a race with a concurrent signal between the check above and this call */
              }
            }
          } catch {
            /* toErrorCause itself is not expected to throw, but this is the last line of defence */
          }
        } finally {
          if (threw) {
            // Best-effort teardown; never lets a rejection or a synchronous throw from starting it
            // stop resolution below.
            try {
              shutdownInBackground()
            } catch {
              /* starting shutdown must never prevent forced resolution */
            }
            // `fn` threw partway through, so whatever branch called `settleOnce` never reached its
            // own `resolveIteration?.()`/`finish()` call (whether that call lived inside `fn` or,
            // like the `result` branch, was deferred until after `settleOnce` returned) — force it
            // here, unconditionally, regardless of what failed above. Calling an already-resolved
            // `resolve()` again is a safe no-op. The NORMAL (non-throwing) path is untouched: this
            // branch only runs when `fn` threw, so the `result` branch's deliberate "resolve only
            // after awaiting the wrapper's exit" timing is unaffected when `fn` succeeds.
            try {
              resolveIteration?.()
            } catch {
              /* resolveIteration is a bare Promise executor's resolve(); it cannot throw, but this
                 call must never be what makes settleOnce itself throw */
            }
          }
        }
      }

      startupTimer = setTimeout(() => {
        settleOnce(() => {
          resolveIteration?.()
          shutdownInBackground()
          ctx.nack(new E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT([startupTimeoutMs]))
        })
      }, startupTimeoutMs)

      const armIdleTimer = (): void => {
        if (!sawReady || !sawInit) return
        // Suspended while any ADK tool call is executing — see `inFlightToolCalls`. Re-armed by
        // `handleToolCallRequest`'s own completion path once the counter returns to zero.
        if (inFlightToolCalls > 0) return
        clearIdleTimer()
        idleTimer = setTimeout(() => {
          settleOnce(() => {
            resolveIteration?.()
            shutdownInBackground()
            ctx.nack(new E_CLAUDE_CODE_CLI_STREAM_STALLED([streamIdleTimeoutMs]))
          })
        }, streamIdleTimeoutMs)
      }

      const sealCurrentMessage = async (): Promise<void> => {
        if (sealedMessage || currentMessageId === undefined) return
        sealedMessage = true
        await ctx.storeMessage(
          new Message({
            id: currentMessageId,
            role: 'assistant',
            content: currentMessageBuffer,
            identity: merged.selfIdentity ?? 'assistant',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          })
        )
      }

      const handleToolCallRequest = async (
        requestId: string,
        toolName: string,
        rawArgs: unknown
      ): Promise<void> => {
        const tool = ctx.tools.get(toolName)
        if (!tool) {
          writeCommand({
            type: 'tool_call_response',
            requestId,
            results: {
              content: [{ type: 'text', text: `Tool not found: ${toolName}` }],
              isError: true,
            },
          })
          return
        }
        // MCP's own JSON-RPC CallTool wire always sends `arguments` as an object; a non-object
        // here would indicate a malformed request from the bridge, not a legitimate call — defend
        // the same way the Ollama battery does for its own non-object case.
        const args: string | Record<string, unknown> = isObject(rawArgs) ? rawArgs : {}
        // Rename the wrapper's per-spawn `requestId` into a turn-unique ADK id BEFORE it touches
        // any internal bookkeeping (reportToolCall/ToolCall/spoolStore/renderOutboundResult) —
        // every wrapper spawn resets its own counter to "0" (see mcp_bridge.ts), so a
        // multi-iteration dispatch would otherwise hand the SAME id to `ctx.storeToolCall`/
        // `helpers.reportToolCall` twice and collide with the first (already-complete) call. The
        // literal wrapper `requestId` is preserved untouched for both `tool_call_response`
        // `writeCommand` calls below — the bridge correlates those by ITS OWN id, not this one.
        const callId = (merged.toolCallIdFilter ?? deCollideToolCallIds)(requestId, ctx)
        helpers.reportToolCall(callId, { tool: tool.name, args })
        const isArtifactTool = ArtifactTool.isArtifactTool(tool)
        let results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[] =
          new Tokenizable('')
        let toolHadError = false
        try {
          const raw = await tool.executor(ctx)(args)
          if (isArtifactTool) {
            if (Tokenizable.isTokenizable(raw)) {
              results = raw
            } else if (typeof raw === 'string') {
              results = new Tokenizable(raw)
            } else {
              throw new Error(
                `ArtifactTool "${tool.name}" returned a non-string/non-Tokenizable value`
              )
            }
          } else if (Media.isMedia(raw)) {
            results = raw
          } else if (Array.isArray(raw) && raw.length > 0 && raw.every((m) => Media.isMedia(m))) {
            results = raw as Media[]
          } else if (looksLikeSpooledArtifact(raw)) {
            results = raw as SpooledArtifact
          } else if (typeof raw === 'string' || isInstanceOf(raw, 'Uint8Array', Uint8Array)) {
            const reader = await spoolStore.write(callId, raw)
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          } else {
            const reader = await spoolStore.write(callId, String(raw))
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          }
        } catch (err) {
          toolHadError = true
          results = new Tokenizable(isError(err) ? err.message : String(err))
        }
        helpers.reportToolCall(callId, { results, isError: toolHadError, isComplete: true })
        const completedAt = nowIso()
        await ctx.storeToolCall(
          new ToolCall({
            id: callId,
            tool: tool.name,
            args,
            checksum: computeChecksum(tool.name, args),
            isComplete: true,
            isError: toolHadError,
            results,
            fromArtifactTool: isArtifactTool,
            inline: isArtifactTool,
            createdAt: completedAt,
            updatedAt: completedAt,
            completedAt,
          })
        )

        let rendered: { content: OutboundContentBlock[]; isError: boolean }
        try {
          rendered = await renderOutboundResult({
            raw: results as string | Uint8Array | SpooledArtifact | Media | Media[],
            callId,
            inline: isArtifactTool,
            spoolStore,
            unsupportedResultMediaPolicy:
              merged.unsupportedResultMediaPolicy ?? merged.unsupportedMediaPolicy ?? 'throw',
          })
        } catch (err) {
          rendered = {
            content: [{ type: 'text', text: isError(err) ? err.message : String(err) }],
            isError: true,
          }
        }
        writeCommand({
          type: 'tool_call_response',
          requestId,
          results: { content: rendered.content, isError: toolHadError || rendered.isError },
        })
      }

      await new Promise<void>((resolve) => {
        const finish = (): void => resolve()
        resolveIteration = finish

        const onEvent = async (event: WrapperEvent): Promise<void> => {
          if (event.type === 'ready') {
            sawReady = true
            maybeClearStartupTimer()
            const runCommand: WrapperCommand = {
              type: 'run',
              prompt,
              appendSystemPrompt: merged.appendSystemPrompt,
              model: merged.model,
              cwd: merged.cwd,
              addDir: merged.addDir,
              allowedTools: bridgedTools.map((t) => t.name),
              maxBudgetUsd: merged.maxBudgetUsd,
              fallbackModel: merged.fallbackModel,
              auth: {
                apiKey: merged.apiKey,
                authToken: merged.authToken,
                baseUrl: merged.baseURL,
              },
              disableTelemetry: merged.disableTelemetry,
              disableErrorReporting: merged.disableErrorReporting,
              disableNonessentialTraffic: merged.disableNonessentialTraffic,
              mcpToolIdleTimeoutMs: merged.mcpToolIdleTimeoutMs,
              claudeBin,
              forwardSubagentText: merged.forwardSubagentText,
              unsupportedResultMediaPolicy: String(
                merged.unsupportedResultMediaPolicy ?? merged.unsupportedMediaPolicy ?? 'throw'
              ),
              bridgedTools,
              extraArgs: merged.extraArgs,
            }
            writeCommand(runCommand)
            // No `armIdleTimer()` call here: its own `sawReady && sawInit` gate always returns
            // immediately at this point, since `init` (per the wrapper protocol) always arrives
            // strictly after `ready` — verified by the full existing test suite passing unchanged
            // with this call removed. The `init` branch below is what actually starts the clock.
            return
          }
          if (event.type === 'init') {
            sawInit = true
            maybeClearStartupTimer()
            helpers.log.info({
              kind: 'claude-init',
              message: 'Claude Code CLI initialized.',
              payload: event as unknown as Record<string, unknown>,
            })
            if (event.mcpServerErrors && event.mcpServerErrors.length > 0) {
              settleOnce(() => {
                finish()
                shutdownInBackground()
                ctx.nack(
                  new E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED([
                    event.mcpServerErrors!.join(', '),
                  ])
                )
              })
              return
            }
            // Genuine progress: the handshake completed cleanly, so this is what actually starts
            // the stream-idle clock (armIdleTimer's own `sawReady && sawInit` gate makes every
            // earlier call, e.g. the one in the `ready` branch above, a no-op) — NOT merely "a
            // stdout chunk arrived" (see the `'data'` listener below for why that distinction
            // matters).
            armIdleTimer()
            return
          }
          if (event.type === 'retry') {
            // Deliberately does NOT re-arm the idle timer. This is a diagnostic passthrough of
            // Claude's own `system/api_retry` line, not evidence that the model is making
            // progress — it fires precisely WHILE the model is stalled waiting on a retryable
            // upstream error. Under exponential backoff, retries commonly land well under
            // `streamIdleTimeoutMs` apart (e.g. 1s/2s/4s/8s/16s/32s), so treating them as
            // idle-resetting activity (as an unconditional per-chunk re-arm would) lets a
            // sustained retry storm suppress the stall timeout indefinitely. Issue #39 itself does
            // not establish what actually caused its "dispatch hangs for 11+ minutes despite a 60s
            // streamIdleTimeoutMs" report — this is a PLAUSIBLE mechanism, not a confirmed root
            // cause: `wrapper.ts` genuinely emits `retry` (api_retry passthrough, ~L369) and `log`
            // (e.g. `malformed-command` ~L275, `duplicate-run-command` ~L253,
            // malformed-stream-json inside `dispatchReader` ~L331) on the SAME stdout stream that
            // carries progress events, with no periodic heartbeat gating their cadence, so the
            // shape of the bug is real and reproducible (see the fix-C test below) — it is fixed
            // for THIS scenario regardless of whether it was the exact mechanism behind the
            // original report.
            helpers.log.warn({
              kind: 'claude-retry',
              message: `Claude API retry, attempt ${event.attempt}`,
              payload: event as unknown as Record<string, unknown>,
            })
            return
          }
          if (event.type === 'message_delta') {
            currentMessageId = event.id
            currentMessageBuffer += event.delta
            helpers.reportMessage(event.id, event.delta, { isComplete: event.isComplete })
            if (event.isComplete) {
              await sealCurrentMessage()
            }
            armIdleTimer()
            return
          }
          if (event.type === 'thought_delta') {
            helpers.reportThought(event.id, event.delta, { isComplete: event.isComplete })
            armIdleTimer()
            return
          }
          if (event.type === 'tool_call_request') {
            // Suspend the model-stream idle clock for the duration of ADK tool EXECUTION, not just
            // the round trip's arrival/departure: `streamIdleTimeoutMs` exists to catch the wrapper
            // going silent while waiting on Claude, and a slow-but-healthy tool (a web search, a
            // sandboxed run) produces no wrapper stdout of its own while it runs. Track with a
            // counter, not a boolean, since more than one `tool_call_request` can be in flight
            // before the first is answered (the MCP bridge assigns each JSON-RPC CallTool its own
            // id independently of completion order).
            inFlightToolCalls += 1
            clearIdleTimer()
            try {
              await handleToolCallRequest(event.requestId, event.tool, event.args)
            } finally {
              inFlightToolCalls = Math.max(0, inFlightToolCalls - 1)
            }
            // Re-arm on completion, not arrival — a genuine round trip (request handled, response
            // written back to the wrapper's stdin) is progress. `armIdleTimer`'s own
            // `inFlightToolCalls > 0` gate means this is a no-op while any OTHER concurrent call is
            // still executing; the timer resumes only once the last one has answered.
            armIdleTimer()
            return
          }
          if (event.type === 'result') {
            sawTerminalEvent = true
            await sealCurrentMessage()
            settleOnce(() => {
              if (event.isError && event.subtype !== 'error_max_turns') {
                ctx.nack(
                  new E_CLAUDE_CODE_CLI_TURN_FAILED([
                    event.stopReason ?? 'unknown',
                    event.resultText ?? '',
                  ])
                )
                return
              }
              if (event.isError && event.subtype === 'error_max_turns') {
                helpers.log.debug({
                  kind: 'claude-max-turns-reached',
                  message:
                    'Claude reached the fixed single-turn limit; treating it as normal completion.',
                  payload: { subtype: event.subtype },
                })
              }
              helpers.reportGenerationStats({
                provider: 'claude_code_cli',
                model: merged.model,
                raw: event.raw as Record<string, unknown> | undefined,
              })
              if (merged.autoAck) ctx.ack()
            })
            // The wrapper, not the adapter, initiates its own shutdown on this path (Decision D
            // step 5) — a terminal NDJSON line proves the wrapper WROTE it, not that the OS
            // process has actually exited yet. Await the wrapper's real exit before resolving so
            // the executor doesn't return while the wrapper (and its `claude` grandchild) are
            // still tearing down.
            await Promise.resolve(child).catch(() => undefined)
            finish()
            return
          }
          if (event.type === 'error') {
            settleOnce(() => {
              finish()
              shutdownInBackground()
              ctx.nack(new E_CLAUDE_CODE_CLI_WRAPPER_CRASHED([event.message]))
            })
            return
          }
          if (event.type === 'log') {
            helpers.log[event.level]({
              kind: event.kind,
              message: event.message,
              payload: event.payload as Record<string, unknown> | undefined,
            })
            return
          }
          // 'shutdown_complete' — nothing further to do; the wrapper is exiting on its own.
        }

        const eventReader = createNdjsonLineReader<WrapperEvent>((raw) => {
          let event: WrapperEvent
          try {
            event = JSON.parse(raw) as WrapperEvent
          } catch {
            helpers.log.trace({
              kind: 'malformed-wrapper-event',
              message: 'Failed to parse wrapper event line; skipping.',
              payload: { linePreview: raw.slice(0, 256) },
            })
            return undefined
          }
          // `onEvent` is async and this callback is itself invoked synchronously from
          // `child.stdout.on('data', ...)` (below): a bare `void onEvent(event)` would leave any
          // rejection with no attached `.catch`, becoming an unhandled promise rejection that
          // crashes the host process by default (Node >= 15) — a single malformed/erroring
          // wrapper event or tool handler must fail only THIS candidate's dispatch, never the
          // host. `settleOnce`'s own idempotency guard makes this safe even when `onEvent` already
          // settled normally along another path before throwing/rejecting further down its body.
          onEvent(event).catch((err: unknown) => {
            const cause = toErrorCause(err)
            settleOnce(() => {
              resolveIteration?.()
              shutdownInBackground()
              ctx.nack(new E_CLAUDE_CODE_CLI_STREAM_ERROR([cause.message], { cause }))
            })
          })
          return event
        })

        child.stdout?.on('data', (chunk: Uint8Array) => {
          // Deliberately does NOT re-arm the idle timer unconditionally here (as an earlier
          // version of this listener did) — that treated ANY stdout chunk as "progress", but
          // `log`/`retry` `WrapperEvent`s (diagnostic passthroughs the wrapper emits on the same
          // stdout stream — see `wrapper.ts`'s `log()` helper and its `system/api_retry`
          // translation) carry no evidence the model is actually advancing, and a sustained
          // sequence of them (e.g. exponential-backoff API retries a few seconds apart) could
          // suppress the stall timeout indefinitely — this is a plausible mechanism for the
          // "dispatch hangs for 11+ minutes despite a 60s streamIdleTimeoutMs" report (see issue
          // #39), now fixed for that scenario. Each `onEvent` branch below now re-arms
          // individually, only for event types that constitute genuine progress (`init`,
          // `message_delta`, `thought_delta`, a completed `tool_call_request` round trip);
          // `ready`/`retry`/`log` do not. `init`'s own branch handles the "very first chunk after
          // the handshake" case that this comment used to describe, since `armIdleTimer()`'s
          // `sawReady && sawInit` gate means no earlier call in this turn could have armed it
          // anyway.
          //
          // `eventReader.push` calls `onLine` (below) SYNCHRONOUSLY, all the way down to the
          // `JSON.parse`-failure `helpers.log.trace(...)` call — a throw from either escapes this
          // listener directly, bypassing the Fix-B `onEvent(event).catch(...)` chain entirely
          // (that chain only guards `onEvent`'s own async rejection, not a synchronous throw that
          // happens before `onEvent` is even reached). An uncaught throw from inside a
          // `'data'` listener is exactly as fatal to the host process as the unhandled rejection
          // Fix B closed off, so route it through the same reliable settlement path.
          try {
            eventReader.push(chunk)
          } catch (err) {
            const cause = toErrorCause(err)
            settleOnce(() => {
              resolveIteration?.()
              shutdownInBackground()
              ctx.nack(new E_CLAUDE_CODE_CLI_STREAM_ERROR([cause.message], { cause }))
            })
          }
        })
        child.stdout?.on('end', () => {
          // A terminal `result`/`error` event was already observed and its own handler is (or will
          // shortly be) in the middle of its own `settleOnce` — defer to it rather than racing it
          // with a wrong "stdout ended without a terminal event" nack for what was actually a
          // successful turn. `sawTerminalEvent` is set synchronously by that handler before any
          // `await`, so it is already true here whenever this really is that race.
          if (sawTerminalEvent) return
          settleOnce(() => {
            finish()
            ctx.nack(
              new E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO([
                0,
                'stdout ended without a terminal event',
              ])
            )
          })
        })

        void Promise.resolve(child)
          .then((result: unknown) => {
            // Same race as the `stdout.on('end')` guard above: the `result` handler may still be
            // awaiting `sealCurrentMessage()`/the child's own exit when the wrapper process itself
            // settles — defer to the terminal-event path rather than nacking a successful turn.
            if (sawTerminalEvent) return
            const exitCode =
              isObject(result) && 'exitCode' in result
                ? ((result as { exitCode: number | null }).exitCode ?? -1)
                : -1
            settleOnce(() => {
              finish()
              ctx.nack(
                new E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO([
                  exitCode,
                  'wrapper process exited with no terminal event observed',
                ])
              )
            })
          })
          .catch(() => {
            if (sawTerminalEvent) return
            settleOnce(() => {
              finish()
              ctx.nack(new E_CLAUDE_CODE_CLI_WRAPPER_CRASHED(['wrapper process rejected']))
            })
          })
      })
    }
  }

  /**
   * Returns `true` when `value` is a {@link ClaudeCodeCliAdapter} instance.
   */
  public static isClaudeCodeCliAdapter(value: unknown): value is ClaudeCodeCliAdapter {
    return isInstanceOf(value, 'ClaudeCodeCliAdapter', ClaudeCodeCliAdapter)
  }
}
