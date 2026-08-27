#!/usr/bin/env node
/**
 * Standalone Node entry point that owns all Claude-Code-specific complexity: spawning the real
 * `claude` binary, hosting the MCP bridge, and translating its stream-json into the normalized
 * adapter↔wrapper protocol.
 *
 * @remarks
 * Self-contained with respect to `@nhtio/adk/*` — no such imports anywhere in this file or its
 * three siblings (`wire.ts`, `cli_protocol.ts`, `mcp_bridge.ts`). Only `node:*` builtins,
 * `@modelcontextprotocol/sdk`, and those three battery-local modules. Ships as a sibling dist
 * asset (see Decision C in the design notes) — never imported as a library, only ever spawned by
 * file path via `execa(process.execPath, [wrapperPath])` from `adapter.ts`.
 *
 * Carries no `@module` JSDoc tag: it is invisible to the `@module`-tag scraper that builds the
 * public `exports` map, and is added to `vite.config.mts`'s `build.lib.entry` as an explicit extra
 * key instead, following the `mcp/server.ts` precedent for a non-consumer-facing standalone
 * executable.
 */

import { spawn } from 'node:child_process'
import { startMcpBridge } from './mcp_bridge'
import { createNdjsonLineReader, encodeWrapperEvent } from './wire'
import {
  parseClaudeStreamJsonLine,
  extractStreamEventTextDelta,
  extractMessageText,
} from './cli_protocol'
import type { McpBridge } from './mcp_bridge'
import type { ChildProcess } from 'node:child_process'
import type { WrapperCommand, WrapperRunCommand, WrapperEvent, ClaudeCodeCliExtraArg } from './wire'

// ─── stdout writer (every emit is an awaited, flush-confirmed write) ───────────

const writeEvent = (event: WrapperEvent): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(encodeWrapperEvent(event), (err) => (err ? reject(err) : resolve()))
  })

const log = (
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
  kind: string,
  message: string,
  payload?: unknown
): void => {
  void writeEvent({ type: 'log', level, kind, message, payload }).catch(() => {})
}

// ─── stdin command reader ───────────────────────────────────────────────────

let stdinDataListener: ((chunk: Uint8Array) => void) | undefined
let stdinEndListener: (() => void) | undefined

/** Stop the stdin command reader and detach its listeners — called on every exit path. */
const stopStdinReader = (): void => {
  if (stdinDataListener) process.stdin.off('data', stdinDataListener)
  if (stdinEndListener) process.stdin.off('end', stdinEndListener)
  stdinDataListener = undefined
  stdinEndListener = undefined
  try {
    process.stdin.pause()
  } catch {
    /* stdin may already be gone */
  }
}

// ─── argv construction (Decision F0) ───────────────────────────────────────

/** Validate one `extraArgs` entry has already been checked by the adapter; convert it to argv tokens. */
const extraArgToArgv = (entry: ClaudeCodeCliExtraArg): string[] => {
  if (entry.value === undefined) return [entry.flag]
  if (Array.isArray(entry.value)) return [entry.flag, ...entry.value]
  return [entry.flag, entry.value]
}

/** Build the complete, authoritative argv for the `claude` grandchild. */
const buildClaudeArgv = (cmd: WrapperRunCommand, bridgeUrl: string): string[] => {
  const args: string[] = [
    '--bare',
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { adk_bridge: { type: 'http', url: bridgeUrl } } }),
    '--dangerously-skip-permissions',
  ]
  // --allowedTools: OMITTED ENTIRELY when there are no bridged tools — the flag is variadic, and a
  // bare `--allowedTools` with nothing after it swallows the very next argv token (confirmed by
  // direct reproduction against the live CLI during design).
  if (cmd.allowedTools.length > 0) {
    args.push(
      '--allowedTools',
      cmd.allowedTools.map((name) => `mcp__adk_bridge__${name}`).join(',')
    )
  }
  if (cmd.appendSystemPrompt !== undefined) {
    args.push('--append-system-prompt', cmd.appendSystemPrompt)
  }
  if (cmd.model !== undefined) {
    args.push('--model', cmd.model)
  }
  if (cmd.addDir !== undefined && cmd.addDir.length > 0) {
    args.push('--add-dir', ...cmd.addDir)
  }
  if (cmd.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(cmd.maxBudgetUsd))
  }
  if (cmd.maxTurns !== undefined) {
    args.push('--max-turns', String(cmd.maxTurns))
  }
  if (cmd.fallbackModel !== undefined && cmd.fallbackModel.length > 0) {
    // ONE comma-joined value, never separate argv tokens — confirmed by direct reproduction: the
    // flag is singular (`--fallback-model <model>`) and documented as accepting "a comma-separated
    // list to try each in order."
    args.push('--fallback-model', cmd.fallbackModel.join(','))
  }
  if (cmd.forwardSubagentText === true) {
    args.push('--forward-subagent-text')
  }
  for (const entry of cmd.extraArgs ?? []) {
    args.push(...extraArgToArgv(entry))
  }
  args.push('--', cmd.prompt)
  return args
}

/** Build the grandchild's env: start from the ambient env, then explicitly delete-then-set every credential/behavior variable this command controls. */
const buildClaudeEnv = (cmd: WrapperRunCommand): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_BASE_URL
  delete env.DISABLE_TELEMETRY
  delete env.DISABLE_ERROR_REPORTING
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  delete env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT
  if (cmd.auth?.apiKey !== undefined) env.ANTHROPIC_API_KEY = cmd.auth.apiKey
  if (cmd.auth?.authToken !== undefined) env.ANTHROPIC_AUTH_TOKEN = cmd.auth.authToken
  if (cmd.auth?.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = cmd.auth.baseUrl
  if (cmd.disableTelemetry === true) env.DISABLE_TELEMETRY = '1'
  if (cmd.disableErrorReporting === true) env.DISABLE_ERROR_REPORTING = '1'
  if (cmd.disableNonessentialTraffic === true) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  if (cmd.mcpToolIdleTimeoutMs !== undefined) {
    env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = String(cmd.mcpToolIdleTimeoutMs)
  }
  return env
}

// ─── main ───────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  let bridge: McpBridge | undefined
  let grandchild: ChildProcess | undefined
  let shuttingDown = false
  let sawResult = false

  /** Kill the grandchild's entire detached process group. POSIX only (enforced by the adapter's own options validation before this wrapper is ever spawned). */
  const killGrandchildGroup = (signal: NodeJS.Signals): void => {
    if (!grandchild || grandchild.pid === undefined || grandchild.exitCode !== null) return
    try {
      process.kill(-grandchild.pid, signal)
    } catch {
      /* the group may already be gone */
    }
  }

  /** Await the grandchild's actual exit for a bounded period; fall through to a process-group kill if it hasn't exited in time. */
  const waitForGrandchildExit = async (graceMs: number): Promise<void> => {
    if (!grandchild || grandchild.exitCode !== null || grandchild.signalCode !== null) return
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs)
      grandchild?.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (!exited) {
      killGrandchildGroup('SIGTERM')
    }
  }

  /**
   * The corrected shutdown sequence (Decision D step 5), shared by the normal-completion path and
   * the SIGTERM/SIGINT handler. Order matters: reject pending calls, THEN close the transport
   * (which tears down any open SSE stream), THEN close the HTTP listener (now genuinely
   * unblocked), THEN bound-wait/kill the grandchild, THEN flush `shutdown_complete`, THEN stop the
   * stdin reader.
   */
  const runShutdownSequence = async (disposeGraceMs: number): Promise<void> => {
    bridge?.rejectPending('The Claude Code CLI wrapper is shutting down.')
    if (bridge) await bridge.closeTransport()
    if (bridge) await bridge.closeHttpServer()
    await waitForGrandchildExit(disposeGraceMs)
    await writeEvent({ type: 'shutdown_complete' }).catch(() => {})
    stopStdinReader()
  }

  // A 5-second backstop, entirely separate from the normal-completion path: if the graceful
  // sequence above hangs, this fires, force-kills the grandchild's process group unconditionally,
  // and calls process.exit(1) — the ONE and ONLY process.exit() call on the normal-completion path.
  let backstopTimer: ReturnType<typeof setTimeout> | undefined
  const armBackstop = (): void => {
    backstopTimer = setTimeout(() => {
      killGrandchildGroup('SIGKILL')
      process.exitCode = 1
      process.exit(1)
    }, 5_000)
  }
  const disarmBackstop = (): void => {
    if (backstopTimer) clearTimeout(backstopTimer)
    backstopTimer = undefined
  }

  const shutdownNormally = async (disposeGraceMs: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    armBackstop()
    await runShutdownSequence(disposeGraceMs)
    disarmBackstop()
    process.exitCode = 0
    // Natural return — never process.exit() on this path, so a stdout write in flight is never
    // truncated by an immediate process termination.
  }

  // Idempotent SIGTERM/SIGINT handling. Registering a handler REPLACES Node's default
  // terminate-on-signal behavior, so — unlike the normal-completion path — this path explicitly
  // calls process.exit() itself once the shutdown sequence completes.
  let handlingSignal = false
  const onSignal = (): void => {
    if (handlingSignal) return
    handlingSignal = true
    void runShutdownSequence(2_000)
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  // Final, synchronous, best-effort safety net — cannot await anything per Node's own `exit` event
  // contract, so it is not the primary cleanup mechanism for any path above.
  process.on('exit', () => {
    killGrandchildGroup('SIGTERM')
  })

  let runCommand: WrapperRunCommand | undefined

  const handleCommand = (command: WrapperCommand): void => {
    if (command.type === 'run') {
      if (runCommand !== undefined) {
        log('error', 'duplicate-run-command', 'A run command was already accepted; ignoring.')
        return
      }
      runCommand = command
      void startTurn(command)
      return
    }
    if (command.type === 'tool_call_response') {
      bridge?.resolveToolCall(command.requestId, command.results)
      return
    }
    if (command.type === 'shutdown') {
      void shutdownNormally(runCommand ? 2_000 : 0)
      return
    }
  }

  const commandReader = createNdjsonLineReader<WrapperCommand>((raw) => {
    let command: WrapperCommand
    try {
      command = JSON.parse(raw) as WrapperCommand
    } catch {
      log('trace', 'malformed-command', 'Failed to parse inbound command line; skipping.', {
        linePreview: raw.slice(0, 256),
      })
      return undefined
    }
    handleCommand(command)
    return command
  })
  stdinDataListener = (chunk) => commandReader.push(chunk)
  stdinEndListener = () => commandReader.end()
  process.stdin.on('data', stdinDataListener)
  process.stdin.on('end', stdinEndListener)

  // The bridge starts and binds its port IMMEDIATELY at wrapper boot, with an empty tool set —
  // NOT inside `startTurn`. The adapter waits for `ready` before ever sending `run` (which is what
  // carries the real tool list), so starting the bridge only after `run` arrives would deadlock
  // both sides: the adapter waiting for `ready`, the wrapper waiting for `run`. `run`'s own
  // handling (`startTurn`, below) calls `bridge.setBridgedTools(...)` once the real list is known,
  // before spawning `claude`.
  try {
    bridge = await startMcpBridge((requestId, toolName, args) => {
      void writeEvent({ type: 'tool_call_request', requestId, tool: toolName, args })
    })
  } catch (err) {
    await writeEvent({
      type: 'error',
      message: 'Failed to start the MCP bridge.',
      // eslint-disable-next-line adk/prefer-is-error -- self-contained wrt @nhtio/adk/* (Decision A)
      detail: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
    process.exitCode = 1
    return
  }

  await writeEvent({ type: 'ready' })

  const startTurn = async (command: WrapperRunCommand): Promise<void> => {
    if (!bridge) return
    bridge.setBridgedTools(command.bridgedTools)

    const bridgeUrl = `http://127.0.0.1:${bridge.port}/`
    const argv = buildClaudeArgv(command, bridgeUrl)
    const env = buildClaudeEnv(command)

    grandchild = spawn(command.claudeBin, argv, {
      cwd: command.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let partialMessageId: string | undefined

    const dispatchReader = createNdjsonLineReader((raw) => {
      const line = parseClaudeStreamJsonLine(raw)
      if (line === undefined) {
        log(
          'trace',
          'malformed-stream-json',
          'Failed to parse Claude stream-json line; skipping.',
          {
            linePreview: raw.slice(0, 256),
          }
        )
        return undefined
      }
      void handleClaudeLine(line)
      return line
    })
    grandchild.stdout?.on('data', (chunk: Uint8Array) => {
      dispatchReader.push(chunk)
    })

    const handleClaudeLine = async (
      line: ReturnType<typeof parseClaudeStreamJsonLine>
    ): Promise<void> => {
      if (line === undefined) return
      if (line.type === 'system' && line.subtype === 'init') {
        const mcpServerErrors = Array.isArray(line.mcp_servers)
          ? line.mcp_servers
              .filter((s) => s.status === 'failed' && s.name === 'adk_bridge')
              .map((s) => s.name)
          : []
        await writeEvent({
          type: 'init',
          model: line.model,
          tools: line.tools,
          mcpServerErrors: mcpServerErrors.length > 0 ? mcpServerErrors : undefined,
          raw: line,
        })
        return
      }
      if (line.type === 'system' && line.subtype === 'api_retry') {
        await writeEvent({
          type: 'retry',
          attempt: line.attempt ?? 0,
          maxRetries: line.max_retries,
          retryDelayMs: line.retry_delay_ms,
          errorStatus: line.error_status,
          error: line.error,
        })
        return
      }
      if (line.type === 'stream_event') {
        if (line.parent_tool_use_id && command.forwardSubagentText !== true) return
        const delta = extractStreamEventTextDelta(line)
        if (delta !== undefined) {
          const id = partialMessageId ?? 'message'
          partialMessageId = id
          await writeEvent({ type: 'message_delta', id, delta })
        }
        return
      }
      if (line.type === 'assistant' || line.type === 'user') {
        if (line.parent_tool_use_id && command.forwardSubagentText !== true) return
        const text = extractMessageText(line)
        if (text.length > 0) {
          const id = partialMessageId ?? 'message'
          // If no prior stream_event deltas arrived for this id, the complete message carries the
          // ONLY copy of the text — send it as the delta itself, not an empty seal, or the
          // adapter's per-id accumulator (which treats the first call's deltaText as the full
          // content) would create an empty message despite real text having arrived.
          const delta = partialMessageId === undefined ? text : ''
          await writeEvent({ type: 'message_delta', id, delta, isComplete: true })
          partialMessageId = id
        }
        return
      }
      if (line.type === 'result') {
        sawResult = true
        await writeEvent({
          type: 'result',
          resultText: line.result,
          sessionId: line.session_id,
          totalCostUsd: line.total_cost_usd,
          usage: line.usage,
          isError: line.is_error === true,
          stopReason: line.stop_reason,
          raw: line,
        })
        await shutdownNormally(2_000)
      }
    }

    grandchild.on('error', (err) => {
      void writeEvent({
        type: 'error',
        message: 'The claude grandchild process failed to spawn.',
        detail: err.message,
      }).catch(() => {})
    })
    grandchild.on('exit', (code, signal) => {
      if (sawResult || shuttingDown) return
      void writeEvent({
        type: 'error',
        message: `claude exited (code=${String(code)}, signal=${String(signal)}) with no terminal result observed.`,
      }).catch(() => {})
    })
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line adk/prefer-is-error -- self-contained wrt @nhtio/adk/* (Decision A)
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`claude_code_cli wrapper fatal: ${message}\n`)
  process.exitCode = 1
})
