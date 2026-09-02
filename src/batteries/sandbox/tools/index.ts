/** @module @nhtio/adk/batteries/sandbox/tools */
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '../../../guards'
import { createSandboxMedia } from '../media_reader'
import { defaultSandboxNarrator } from '../narrator'
import { classifySandboxPathRejection } from '../paths'
import { resolveMime } from '../defaults/extension_mime'
import { createModelPath, createModelWriteRoot } from '../types'
import { defaultArtifactMinter } from '../defaults/default_minter'
import { E_TURN_GATE_ABORTED, E_TURN_GATE_TIMEOUT } from '../../../lib/exceptions/runtime'
import { E_SANDBOX_FAILED, E_SANDBOX_GATE_REQUIRED, E_SANDBOX_REFUSED } from '../exceptions'
import {
  Tool,
  Media,
  SpooledArtifact,
  SpooledJsonArtifact,
  SpooledMarkdownArtifact,
} from '../../../common'
import type { DerivedRules } from '../types'
import type { SandboxHandle } from '../manager'
import type { SandboxOutcome } from '../narrator'
import type { SandboxSearch } from '../contracts/search'
import type { MimeResolver } from '../contracts/mime_resolver'
import type { Tool as AdkTool } from '../../../lib/classes/tool'
import type { MediaTrustTier, MediaKind } from '../../../common'
import type { SandboxFileSystem } from '../contracts/file_system'
import type { PathTranslator } from '../contracts/path_translator'
import type { ArtifactMinter } from '../contracts/artifact_minter'
import type { DispatchContext } from '../../../lib/contracts/dispatch_context'

type GateVerdict = { approved: true } | { approved: false; note?: string }
type Gate = (
  ctx: DispatchContext,
  call: { tool: string; args: unknown }
) => GateVerdict | void | Promise<GateVerdict | void>
/** Options for constructing the sandbox's eight untrusted filesystem tools. */
export interface SandboxToolsOptions {
  /**
   * The handle that owns this tool set and issues its reader epoch.
   *
   * @remarks
   * File-backed readers retain this epoch and check it before every operation. After
   * {@link SandboxHandle.dispose} they fail with `E_SANDBOX_NOT_INITIALIZED` rather than
   * falling through to the host filesystem.
   */
  handle: SandboxHandle
  /** The filesystem capability used for stat, traversal, reads, and writes. */
  fileSystem: SandboxFileSystem
  /** Translates model-visible paths into the sandbox backend and back. */
  pathTranslator: PathTranslator
  /**
   * Required approval callback for every tool, including reads and searches.
   *
   * @remarks
   * A read of `.env` is an exfiltration event, and `search_files` is a secret-discovery
   * primitive, so construction rejects a missing gate with `E_SANDBOX_GATE_REQUIRED`.
   * Calling the gate is a real suspension: a harness without a decider leaves the turn
   * waiting rather than silently allowing the operation.
   */
  gate: Gate
  /**
   * Search backend for `search_files` and `find_files`.
   *
   * @remarks
   * These tools spawn `rg` through the sandbox enforcer and are OS-enforced; they do not
   * have the in-process filesystem tools' weaker enforcement boundary.
   */
  search?: SandboxSearch
  /** Factory for artifacts returned by file-query tools; defaults to the battery minter. */
  artifactMinter?: ArtifactMinter
  /** Resolves MIME types while staging a file; defaults to the extension resolver. */
  mimeResolver?: MimeResolver
  /** Explicit host write root; it is never inferred. */
  writeRoot: string
  /**
   * Configuration-supplied provenance for staged media.
   *
   * @remarks
   * This value cannot be inferred from `source`: core requires an explicit trust tier and
   * batteries must not auto-classify content.
   */
  trustTier: MediaTrustTier
  /** Tools which are not registered are not named in descriptions. */
  registeredTools?: readonly string[]
}

const argsPath = (extra: Record<string, unknown> = {}) =>
  validator.object({ path: validator.string().required(), ...extra })
const depth = validator.number().integer().min(0).default(20)
const json = (value: unknown): string => JSON.stringify(value)
const relativeFramePath = (root: string, value: string): string => {
  const prefix = root === '/' ? '/' : `${root}/`
  return value === root ? '' : value.startsWith(prefix) ? value.slice(prefix.length) : value
}
const isDenied = (
  rules: DerivedRules | undefined,
  path: string,
  axis: 'read' | 'write'
): boolean => {
  if (!rules || rules.filesystemDisabled) return false
  const under = (rule: string): boolean =>
    rule === '/' || path === rule || path.startsWith(`${rule}/`)
  const list = axis === 'read' ? rules.read.denyOnly : rules.write.denyWithinAllow
  if (axis === 'read')
    return rules.read.denyOnly.some(under) && !rules.read.allowWithinDeny.some(under)
  return !rules.write.allowOnly.some(under) || list.some(under)
}
const narrateThrow = (outcome: SandboxOutcome, refused = true): never => {
  const message = defaultSandboxNarrator(outcome)
  if (refused) throw new E_SANDBOX_REFUSED([message])
  throw new E_SANDBOX_FAILED([message])
}

/**
 * Run a `PathTranslator` operation and narrate any refusal it raises.
 *
 * @remarks
 * EVERY translator call must go through here, not just the obvious `toRelative`. `toBackendPath` and
 * `assertNoSymlinkComponents` both reject — the latter is the symlinked-component refusal, which is a
 * security control — and a bare call lets that escape as the translator's native error, bypassing the
 * narrator seam the whole battery depends on. The model then receives an unactionable message for the
 * one class of failure it could actually correct.
 *
 * An already-narrated exception passes through untouched, so wrapping a call that itself narrates is
 * safe and the outcome is never rendered twice.
 *
 * @param operation - The translator call.
 * @param input - The model-supplied path, echoed back in the outcome.
 * @param reason - The `path-rejected` reason to narrate.
 * @returns The operation's result.
 */
export const narratingPath = async <T>(
  operation: () => T | Promise<T>,
  input: string
): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    if (
      isInstanceOf(error, 'E_SANDBOX_REFUSED', E_SANDBOX_REFUSED) ||
      isInstanceOf(error, 'E_SANDBOX_FAILED', E_SANDBOX_FAILED)
    )
      throw error
    // The REASON is classified from the input rather than assumed. Hardcoding `'escape'` told a model
    // that supplied a NUL byte or a UNC path to "use a workspace-relative path", which is unactionable
    // advice for those mistakes — and the plan asks for one distinct case per reason.
    return narrateThrow(
      { kind: 'path-rejected', input, reason: classifySandboxPathRejection(input) ?? 'escape' },
      false
    )
  }
}
/**
 * Classify an unexpected fault as `io-failure`, PRESERVING any already-narrated outcome.
 *
 * @remarks
 * A catch that wraps unconditionally destroys the classification the seam just made: a per-child
 * `path-rejected` inside a traversal would reach the model as "the listing broke" — wrong, and
 * unactionable. Only genuinely unclassified faults become `io-failure`.
 *
 * @param error - The caught value.
 * @param path - The model-facing path for the outcome.
 * @returns Never; always throws.
 */
const rethrowAsIoFailure: (error: unknown, path: string) => never = (error, path) => {
  if (
    isInstanceOf(error, 'E_SANDBOX_REFUSED', E_SANDBOX_REFUSED) ||
    isInstanceOf(error, 'E_SANDBOX_FAILED', E_SANDBOX_FAILED)
  )
    throw error
  throw new E_SANDBOX_FAILED([
    defaultSandboxNarrator({ kind: 'io-failure', path, detail: String(error) }),
  ])
}

const regular = async (options: SandboxToolsOptions, relative: string, axis: 'read' | 'write') => {
  // Also narrated: this is the shared pre-flight for `open_file*` and `stage_file`, so an unguarded
  // translation here would bypass the seam on the two most-used tools rather than just one.
  const backend = await narratingPath(
    () => options.pathTranslator.toBackendPath(relative),
    relative
  )
  if (isDenied(options.handle.effectivePolicy(), backend, axis))
    narrateThrow({ kind: 'denied-by-policy', path: relative, axis })
  let stat
  try {
    stat = await options.fileSystem.stat(backend)
  } catch {
    narrateThrow({ kind: 'not-found', path: relative })
  }
  if (stat!.kind === 'dir') narrateThrow({ kind: 'is-a-directory', path: relative })
  if (stat!.kind !== 'file')
    narrateThrow({ kind: 'not-a-regular-file', path: relative, kind_: stat!.kind })
  return backend
}
const gated = async (
  options: SandboxToolsOptions,
  ctx: DispatchContext,
  tool: string,
  args: unknown
) => {
  try {
    const verdict = await options.gate(ctx, { tool, args })
    if (verdict && !verdict.approved) narrateThrow({ kind: 'gate-declined', note: verdict.note })
  } catch (error) {
    if (
      isInstanceOf(error, 'E_SANDBOX_REFUSED', E_SANDBOX_REFUSED) ||
      isInstanceOf(error, 'E_SANDBOX_FAILED', E_SANDBOX_FAILED)
    )
      throw error
    // THE THREE-CASE ABORT SPLIT. Both a turn-level abort and `TurnGate.abort()` reject with the
    // SAME `E_TURN_GATE_ABORTED`, so the error type cannot tell them apart — only the signal can,
    // and only best-effort (two benign races are named in the plan; neither can approve work).
    //   · signal already set ⇒ the dispatch is unwinding and there is no reader ⇒ rethrow RAW;
    //   · signal not yet set ⇒ the gate alone was cancelled and the model IS reading ⇒ narrate.
    // Collapsing both into `gate-unavailable` would narrate into a torn-down dispatch and mislabel
    // a cancellation as a broken gate.
    if (isInstanceOf(error, 'E_TURN_GATE_ABORTED', E_TURN_GATE_ABORTED)) {
      if (ctx.abortSignal?.aborted) throw error
      narrateThrow({ kind: 'aborted' })
    }
    // A gate TIMEOUT is its own cause and its own reason. Reporting it as `'error'` tells the
    // operator the gate broke when in fact nobody answered it — the headless-decider trap.
    narrateThrow({
      kind: 'gate-unavailable',
      reason: isInstanceOf(error, 'E_TURN_GATE_TIMEOUT', E_TURN_GATE_TIMEOUT) ? 'timeout' : 'error',
    })
  }
}
const makeOpen = (
  options: SandboxToolsOptions,
  name: string,
  ctor: typeof SpooledArtifact,
  description: string
) =>
  new Tool({
    name,
    description,
    trusted: false,
    artifactConstructor: () => ctor,
    inputSchema: argsPath(),
    handler: async (raw, ctx) => {
      await gated(options, ctx, name, raw)
      let path!: string
      try {
        path = await options.pathTranslator.toRelative((raw as { path: string }).path)
      } catch {
        narrateThrow({
          kind: 'path-rejected',
          input: (raw as { path: string }).path,
          reason: classifySandboxPathRejection((raw as { path: string }).path) ?? 'escape',
        })
      }
      const backend = await regular(options, path!, 'read')
      try {
        const reader = await ctx.storeRetrievableBytes(
          `${ctx.id}:${name}:${path}`,
          await options.fileSystem.read(backend, { signal: ctx.abortSignal })
        )
        return new ctor(reader)
      } catch (error) {
        rethrowAsIoFailure(error, path)
      }
    },
  })
const framesArtifact = async (
  ctx: DispatchContext,
  id: string,
  frames: unknown[],
  note?: string
) => {
  const body = `${note ? `${note}\n` : ''}${frames.map(json).join('\n')}${frames.length ? '\n' : ''}`
  const reader = await ctx.storeRetrievableBytes(id, body)
  return new SpooledJsonArtifact(reader)
}
const descriptions = {
  open: 'Read a file from disk into the turn to query, not to change. Use artifact_* tools; use stage_file to change it.',
  stage:
    'Change a file: use stage_file, then media verbs and save_media; mutations are in memory until saved. Use open_file to read or grep first; no artifact_* tools attach.',
  save: 'Write to a file on disk: save bytes already in this turn, produced by media verbs; you cannot author content here. This overwrites and makes a stage_file edit real.',
}
/**
 * Construct the sandbox's file, media, directory, and search tools.
 *
 * @remarks
 * All returned tools are untrusted and gate their operations, including reads. The factory
 * keeps the supplied handle, filesystem, path translator, search backend, and configuration
 * together so the tools cannot accidentally bypass the sandbox boundary.
 *
 * @param options - Capabilities and configuration for the sandbox tool set.
 * @returns The eight tools registered for a sandbox handle.
 */
export const createSandboxTools = async (options: SandboxToolsOptions): Promise<AdkTool[]> => {
  if (typeof options.gate !== 'function')
    throw new E_SANDBOX_GATE_REQUIRED(['A gate is required for every sandbox tool'])
  const minter = options.artifactMinter ?? defaultArtifactMinter
  void minter
  const open = makeOpen(
    options,
    'open_file',
    SpooledArtifact,
    `${descriptions.open} open_file works for any regular file and provides generic query tools.`
  )
  const openJson = makeOpen(
    options,
    'open_json_file',
    SpooledJsonArtifact,
    `${descriptions.open} This format-specific tool provides artifact_json_*; invalid JSON remains queryable as text.`
  )
  const openMarkdown = makeOpen(
    options,
    'open_markdown_file',
    SpooledMarkdownArtifact,
    `${descriptions.open} This format-specific tool provides markdown query tools.`
  )
  const stage = new Tool({
    name: 'stage_file',
    description: descriptions.stage,
    trusted: false,
    inputSchema: argsPath(),
    handler: async (raw, ctx) => {
      await gated(options, ctx, 'stage_file', raw)
      let path!: string
      try {
        path = await options.pathTranslator.toRelative((raw as { path: string }).path)
      } catch {
        narrateThrow({
          kind: 'path-rejected',
          input: (raw as { path: string }).path,
          reason: classifySandboxPathRejection((raw as { path: string }).path) ?? 'escape',
        })
      }
      const backend = await regular(options, path!, 'read')
      let mime: string | undefined
      try {
        mime = await resolveMime(path, options.mimeResolver, {
          peek: async (n) => {
            const stream = await options.fileSystem.read(backend)
            const r = stream.getReader()
            const x = await r.read()
            r.releaseLock()
            return (x.value ?? new Uint8Array()).slice(0, n)
          },
        })
      } catch (error) {
        rethrowAsIoFailure(error, path)
      }
      const kind: MediaKind = mime?.startsWith('image/')
        ? 'image'
        : mime?.startsWith('audio/')
          ? 'audio'
          : mime?.startsWith('video/')
            ? 'video'
            : 'document'
      return createSandboxMedia({
        fileSystem: options.fileSystem,
        path: backend,
        epoch: options.handle.epoch,
        isEpochLive: options.handle.isEpochLive,
        kind,
        mimeType: mime ?? 'application/octet-stream',
        filename: path,
        trustTier: options.trustTier,
      })
    },
  })
  const save = new Tool({
    name: 'save_media',
    description: descriptions.save,
    trusted: false,
    inputSchema: validator.object({
      media_id: validator.string().required(),
      path: validator.string().required(),
    }),
    handler: async (raw, ctx) => {
      await gated(options, ctx, 'save_media', raw)
      const a = raw as { media_id: string; path: string }
      let path!: string
      try {
        path = await options.pathTranslator.toRelative(a.path)
      } catch {
        narrateThrow({
          kind: 'path-rejected',
          input: a.path,
          reason: classifySandboxPathRejection(a.path) ?? 'escape',
        })
      }
      let root!: string
      try {
        root = await options.pathTranslator.toRelative(options.writeRoot)
      } catch {
        narrateThrow({
          kind: 'path-rejected',
          input: options.writeRoot,
          reason: classifySandboxPathRejection(options.writeRoot) ?? 'escape',
        })
      }
      if (!(root === '' || path === root || path.startsWith(`${root}/`)))
        narrateThrow({
          kind: 'outside-write-root',
          path: createModelPath(path),
          writeRoot: createModelWriteRoot(root),
        })
      const mediaResults = [...ctx.turnToolCalls]
        .map((call) => call.results)
        .flatMap((result) => (Array.isArray(result) ? result : [result]))
      const media = mediaResults.find(
        (result): result is Media => Media.isMedia(result) && result.id === a.media_id
      )
      if (!Media.isMedia(media)) narrateThrow({ kind: 'unknown-media', mediaId: a.media_id })
      const backend = await narratingPath(() => options.pathTranslator.toBackendPath(path), a.path)
      if (isDenied(options.handle.effectivePolicy(), backend, 'write'))
        narrateThrow({ kind: 'denied-by-policy', path, axis: 'write' })
      // The symlinked-component refusal is a SECURITY control, so its rejection must reach the model
      // as an actionable `path-rejected` rather than the translator's native error.
      await narratingPath(() => options.pathTranslator.assertNoSymlinkComponents(path), a.path)
      try {
        await options.fileSystem.write(backend, await media!.stream(), {
          signal: ctx.abortSignal,
        })
        const written = await options.fileSystem.stat(backend)
        return `Saved ${path} (${written.size} bytes)`
      } catch (error) {
        rethrowAsIoFailure(error, path)
      }
    },
  })
  const list = new Tool({
    name: 'list_directory',
    description:
      'Return a complete queryable JSON listing. The only boundary is max_depth; raise it to inspect an unexplored subtree. Prefer find_files for names and list_media for media already in the turn.',
    trusted: false,
    inputSchema: argsPath({ max_depth: depth }),
    handler: async (raw, ctx) => {
      await gated(options, ctx, 'list_directory', raw)
      const a = raw as { path: string; max_depth: number }
      let root!: string
      try {
        root = await options.pathTranslator.toRelative(a.path)
      } catch {
        narrateThrow({
          kind: 'path-rejected',
          input: a.path,
          reason: classifySandboxPathRejection(a.path) ?? 'escape',
        })
      }
      const backend = await narratingPath(() => options.pathTranslator.toBackendPath(root!), a.path)
      if (isDenied(options.handle.effectivePolicy(), backend, 'read'))
        narrateThrow({ kind: 'denied-by-policy', path: root, axis: 'read' })
      let frames: unknown[] = []
      let limited = false
      let sawDone = false
      try {
        for await (const frame of options.fileSystem.list(backend, {
          maxDepth: a.max_depth,
          signal: ctx.abortSignal,
        })) {
          if (
            frame.kind === 'item' &&
            !isDenied(
              options.handle.effectivePolicy(),
              // Per CHILD, inside the traversal: a refusal here must still narrate rather than
              // surface as the directory's I/O failure carrying the translator's native text.
              await narratingPath(
                () => options.pathTranslator.toBackendPath(relativeFramePath(backend, frame.path)),
                frame.path
              ),
              'read'
            )
          )
            frames.push({ ...frame, path: relativeFramePath(backend, frame.path) })
          if (frame.kind === 'done') {
            // `list_directory` HAS NO `limit` — its only boundary is max_depth — so a
            // `bound: 'limit'` frame cannot be a legitimate truncation here and means the backend
            // is broken. `Done` is a union shared with the search frames, which is the only reason
            // the shape is expressible at all.
            //
            // This is deliberately the OPPOSITE of `search_files`/`find_files` (see `makeSearch`
            // below): those take a required `limit`, so the same frame is their ORDINARY
            // truncation outcome and narrates `result-limited`. The rule is per-operation, not
            // per-frame, and this throw belongs to `list_directory` alone — a copy of it inside
            // `makeSearch` made every broad `find_files` query fail on its own limit.
            if (!frame.complete && frame.bound === 'limit')
              throw new Error('list backend emitted an over-limit frame')
            sawDone = true
            limited = !frame.complete
          }
        }
        if (!sawDone) throw new Error('listing ended without a done frame')
      } catch (error) {
        rethrowAsIoFailure(error, root)
      }
      return framesArtifact(
        ctx,
        `${ctx.id}:list:${root}`,
        frames,
        limited
          ? defaultSandboxNarrator({
              kind: 'scope-limited',
              shown: 0,
              atDepth: a.max_depth,
              bound: 'maxDepth',
            })
          : undefined
      )
    },
  })
  /**
   * `follow` is deliberately schema-VALID while the bundled ripgrep adapter refuses it. The schema
   * is shared by every deployment, and a BYO `SandboxSearch` that has verified its own containment
   * of symlinked descendants may honour the flag; narrowing the schema to `valid(false)` would make
   * it unreachable for them too. The bundled refusal is adapter-specific and names the pending
   * containment audit, so a caller learns why rather than finding the option silently absent.
   */
  // `follow` traverses symlinked DESCENDANTS, which never pass through the path translator, so
  // an uncontained backend turns it into an unbounded read. The tools layer cannot see what is
  // behind `SandboxSearch`, so the ADAPTER declares whether it contains them. Undeclared, the
  // schema rejects `follow: true` at validation rather than advertising an option that fails at
  // execution — a narrowed COPY of the permissive rule, so an adapter that HAS verified
  // containment still gets the full option.
  // Over-limit is the ORDINARY outcome for these two: `limit` is required, so exceeding it
  // narrates `result-limited` and returns the bounded results. Contrast `list_directory` above,
  // which has no `limit` and treats the same frame as a backend protocol violation.
  const permissiveFollow = validator.boolean().default(false)
  // REJECTS `follow: true` unless the adapter declared containment. `.valid(false)` on a COPY,
  // so an adapter that DID declare it still gets the permissive rule.
  const followRejectedUnlessDeclared = options.search?.supportsFollow
    ? permissiveFollow
    : permissiveFollow.valid(false)
  const makeSearch = (name: string, content: boolean) =>
    new Tool({
      name,
      description: content
        ? 'Search file contents on disk that you have not opened; artifact_grep searches one artifact you already opened. Every whole hit is queryable JSON. Bounded by max_depth and a required limit; exceeding limit returns the bounded hits with a result-limited note, not an error. follow (symlink traversal) is not available in this deployment.'
        : 'Find file names across the disk tree, rather than searching contents. Every result is queryable JSON. Bounded by max_depth and a required limit; exceeding limit returns the bounded paths with a result-limited note, not an error. follow (symlink traversal) is not available in this deployment.',
      trusted: false,
      inputSchema: validator.object({
        [content ? 'pattern' : 'glob']: validator.string().required(),
        path: validator.string().allow('').default(''),
        max_depth: depth,
        limit: validator.number().integer().min(1).required(),
        ...(content
          ? {
              ignore_case: validator.boolean().default(false),
              literal: validator.boolean().default(false),
              glob: validator.string().allow('').optional(),
              iglob: validator.string().allow('').optional(),
              // Rejects `true` at validation unless the adapter set `supportsFollow` (see above).
              follow: followRejectedUnlessDeclared,
              hidden: validator.boolean().default(false),
              no_ignore: validator.boolean().default(false),
            }
          : {
              iglob: validator.string().allow('').optional(),
              // Rejects `true` at validation unless the adapter set `supportsFollow` (see above).
              follow: followRejectedUnlessDeclared,
              hidden: validator.boolean().default(false),
              no_ignore: validator.boolean().default(false),
            }),
      }),
      handler: async (raw, ctx) => {
        await gated(options, ctx, name, raw)
        const a = raw as {
          pattern?: string
          glob?: string
          path: string
          max_depth: number
          limit: number
          ignore_case?: boolean
          literal?: boolean
          iglob?: string
          follow?: boolean
          hidden?: boolean
          no_ignore?: boolean
        }
        const root = await narratingPath(() => options.pathTranslator.toRelative(a.path), a.path)
        const search = options.search
        if (!search)
          narrateThrow(
            { kind: 'io-failure', path: root, detail: 'search backend unavailable' },
            false
          )
        // Translated ONCE, through the seam. Three separate bare calls previously let a translator
        // refusal escape as a generic downstream error instead of a narrated `path-rejected`.
        const backendRoot = await narratingPath(
          () => options.pathTranslator.toBackendPath(root),
          a.path
        )
        const iterable = content
          ? search!.searchContent({
              root: backendRoot,
              pattern: a.pattern!,
              maxDepth: a.max_depth,
              limit: a.limit,
              ignoreCase: a.ignore_case,
              literal: a.literal,
              glob: a.glob,
              iglob: a.iglob,
              follow: a.follow,
              hidden: a.hidden,
              noIgnore: a.no_ignore,
              signal: ctx.abortSignal,
            })
          : search!.findPaths({
              root: backendRoot,
              glob: a.glob!,
              maxDepth: a.max_depth,
              limit: a.limit,
              iglob: a.iglob,
              follow: a.follow,
              hidden: a.hidden,
              noIgnore: a.no_ignore,
              signal: ctx.abortSignal,
            })
        const frames: unknown[] = []
        let terminal:
          | Extract<typeof iterable extends AsyncIterable<infer F> ? F : never, { kind: 'done' }>
          | undefined
        let sawDone = false
        try {
          for await (const frame of iterable) {
            if (frame.kind === 'item')
              frames.push({
                ...frame,
                path: relativeFramePath(backendRoot, frame.path),
              })
            else {
              sawDone = true
              terminal = frame
            }
          }
          if (!sawDone) throw new Error('search ended without a done frame')
        } catch (error) {
          rethrowAsIoFailure(error, root)
        }
        const note = frames.length
          ? undefined
          : defaultSandboxNarrator({
              kind: 'no-matches',
              pattern: content ? a.pattern! : a.glob!,
              scope: root,
            })
        return framesArtifact(
          ctx,
          `${ctx.id}:${name}:${root}`,
          frames,
          terminal && !terminal.complete
            ? // `limit` is REQUIRED on both search tools, so an over-limit terminal frame is the
              // ordinary truncation outcome: narrate it and return the bounded results. It is NOT
              // an error here, unlike `list_directory`, which has no `limit` and treats the same
              // frame as a backend protocol violation.
              terminal.bound === 'limit'
              ? defaultSandboxNarrator({
                  kind: 'result-limited',
                  shown: terminal.shown,
                  limit: a.limit,
                  bound: 'limit',
                })
              : defaultSandboxNarrator({
                  kind: 'scope-limited',
                  shown: frames.length,
                  atDepth: terminal.atDepth,
                  bound: 'maxDepth',
                })
            : note
        )
      },
    })
  return [
    open,
    openJson,
    openMarkdown,
    stage,
    save,
    list,
    makeSearch('search_files', true),
    makeSearch('find_files', false),
  ]
}
/** Alias for {@link createSandboxTools}, used by tool-forging integrations. */
export const forgeSandboxTools = createSandboxTools
/** Human-readable descriptions shared by the sandbox's workspace tools. */
export { descriptions as sandboxToolDescriptions }
