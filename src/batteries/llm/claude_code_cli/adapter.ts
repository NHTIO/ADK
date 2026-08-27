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
import { isError, isObject, isInstanceOf } from '@nhtio/adk/guards'
import { createNdjsonLineReader, encodeWrapperCommand } from './wire'
import { canonicalStringify } from '../../../lib/utils/canonical_json'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  Tokenizable,
  ToolCall,
  Message,
  Media,
  ArtifactTool,
  SpooledArtifact,
} from '@nhtio/adk/common'
import {
  E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR,
  E_CLAUDE_CODE_CLI_WRAPPER_CRASHED,
  E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO,
  E_CLAUDE_CODE_CLI_STREAM_STALLED,
  E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT,
  E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED,
  E_CLAUDE_CODE_CLI_TURN_FAILED,
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

// ─── capability probe (--max-turns) ─────────────────────────────────────────

/** Cache of `--max-turns` capability probes, keyed by resolved `claudeBin`, shared across dispatches for one adapter-instance lifetime. */
const maxTurnsProbeCache = new Map<string, Promise<boolean>>()

const probeMaxTurnsSupport = (execaFn: ExecaLike, claudeBin: string): Promise<boolean> => {
  let cached = maxTurnsProbeCache.get(claudeBin)
  if (cached) return cached
  cached = (async () => {
    try {
      const result = await Promise.resolve(execaFn(claudeBin, ['--help'], { cleanup: true }))
      const stdout = (result as unknown as { stdout?: unknown }).stdout
      return typeof stdout === 'string' && stdout.includes('--max-turns')
    } catch {
      return false
    }
  })()
  maxTurnsProbeCache.set(claudeBin, cached)
  return cached
}

// ─── time / checksum helpers ────────────────────────────────────────────────

const nowIso = (): string => new Date().toISOString()

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
      const wrapperPath = merged.wrapperPath ?? resolveDefaultWrapperPath()
      const claudeBin = merged.claudeBin ?? 'claude'

      // ── Step 4: capability-probe maxTurns (cached per adapter-instance lifetime) ──
      let maxTurns: number | undefined
      if (merged.maxTurns !== undefined) {
        const supported = await probeMaxTurnsSupport(execaFn, claudeBin)
        if (supported) {
          maxTurns = merged.maxTurns
        } else {
          helpers.log.debug({
            kind: 'max-turns-unsupported',
            message:
              'The installed Claude Code CLI does not support --max-turns; maxTurns option ignored.',
          })
        }
      }

      // ── Step 5: pre-render inbound tool-call results (for history) ────────
      const renderedToolCallResults = new Map<string, string>()
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
        renderedToolCallResults.set(tc.id, rendered)
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

      // ── Step 8: spawn the wrapper ──────────────────────────────────────────
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
          void Promise.resolve(child).finally(() => {
            clearTimeout(timer)
            resolve()
          })
        })
        try {
          child.kill('SIGTERM')
        } catch {
          /* already exited */
        }
      }

      const abortListener = (): void => {
        void gracefulShutdown()
      }
      ctx.abortSignal.addEventListener('abort', abortListener, { once: true })
      const detachAbortListener = (): void =>
        ctx.abortSignal.removeEventListener('abort', abortListener)

      const settleOnce = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearStartupTimer()
        clearIdleTimer()
        detachAbortListener()
        fn()
      }

      startupTimer = setTimeout(() => {
        settleOnce(() => {
          resolveIteration?.()
          void gracefulShutdown()
          ctx.nack(new E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT([startupTimeoutMs]))
        })
      }, startupTimeoutMs)

      const armIdleTimer = (): void => {
        if (!sawReady || !sawInit) return
        clearIdleTimer()
        idleTimer = setTimeout(() => {
          settleOnce(() => {
            resolveIteration?.()
            void gracefulShutdown()
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
        helpers.reportToolCall(requestId, { tool: tool.name, args })
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
            const reader = await spoolStore.write(requestId, raw)
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          } else {
            const reader = await spoolStore.write(requestId, String(raw))
            const ArtifactCtor = (tool as Tool).artifactConstructor?.() ?? SpooledArtifact
            results = new ArtifactCtor(reader)
          }
        } catch (err) {
          toolHadError = true
          results = new Tokenizable(isError(err) ? err.message : String(err))
        }
        helpers.reportToolCall(requestId, { results, isError: toolHadError, isComplete: true })
        const completedAt = nowIso()
        await ctx.storeToolCall(
          new ToolCall({
            id: requestId,
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
            callId: requestId,
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
              maxTurns,
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
            armIdleTimer()
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
                void gracefulShutdown()
                ctx.nack(
                  new E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED([
                    event.mcpServerErrors!.join(', '),
                  ])
                )
              })
            }
            return
          }
          if (event.type === 'retry') {
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
            return
          }
          if (event.type === 'thought_delta') {
            helpers.reportThought(event.id, event.delta, { isComplete: event.isComplete })
            return
          }
          if (event.type === 'tool_call_request') {
            await handleToolCallRequest(event.requestId, event.tool, event.args)
            return
          }
          if (event.type === 'result') {
            sawTerminalEvent = true
            await sealCurrentMessage()
            settleOnce(() => {
              if (event.isError) {
                ctx.nack(
                  new E_CLAUDE_CODE_CLI_TURN_FAILED([
                    event.stopReason ?? 'unknown',
                    event.resultText ?? '',
                  ])
                )
                return
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
              void gracefulShutdown()
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
          void onEvent(event)
          return event
        })

        child.stdout?.on('data', (chunk: Uint8Array) => {
          // Parse BEFORE arming: `armIdleTimer()` is gated on `sawReady && sawInit`, and the very
          // chunk that carries the `init` event is what flips `sawInit` — parsing first lets that
          // same chunk's processing arm the timer immediately, rather than requiring a chunk AFTER
          // init to ever arrive (which, on a genuinely idle stream, never happens).
          eventReader.push(chunk)
          armIdleTimer()
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
