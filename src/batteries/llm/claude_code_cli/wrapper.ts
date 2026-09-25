#!/usr/bin/env node
/**
 * Standalone Node entry point that owns all Claude-Code-specific complexity: spawning the real
 * `claude` binary, hosting the MCP bridge, and translating its stream-json into the normalized
 * adapter↔wrapper protocol.
 *
 * @remarks
 * Self-contained with respect to `@nhtio/adk/*` — no such imports anywhere in this file or its
 * five siblings (`wire.ts`, `cli_protocol.ts`, `mcp_bridge.ts`, `message_id_state.ts`,
 * `line_queue.ts`). Only `node:*` builtins, `@modelcontextprotocol/sdk`, and those five
 * battery-local modules. Ships as a sibling dist asset (see Decision C in the design notes) —
 * never imported as a library, only ever spawned by file path via
 * `execa(process.execPath, [wrapperPath])` from `adapter.ts`.
 *
 * Carries no `@module` JSDoc tag: it is invisible to the `@module`-tag scraper that builds the
 * public `exports` map, and is added to `vite.config.mts`'s `build.lib.entry` as an explicit extra
 * key instead, following the `mcp/server.ts` precedent for a non-consumer-facing standalone
 * executable.
 */

import { spawn } from 'node:child_process'
import { startMcpBridge } from './mcp_bridge'
import { createSerialQueue } from './line_queue'
import { createNdjsonLineReader, encodeWrapperEvent } from './wire'
import {
  createMessageIdState,
  claimPartialDeltaId,
  claimCompleteMessageId,
} from './message_id_state'
import {
  parseClaudeStreamJsonLine,
  extractStreamEventTextDelta,
  extractMessageText,
} from './cli_protocol'
import type { McpBridge } from './mcp_bridge'
import type { ChildProcess } from 'node:child_process'
import type { WrapperCommand, WrapperRunCommand, WrapperEvent, ClaudeCodeCliExtraArg } from './wire'

// ─── stdout writer (every emit is an awaited, flush-confirmed write) ───────────

// Every stdout write this process makes — including `log()`'s fire-and-forget ones below — is
// counted while in flight. The normal-completion exit path (`shutdownNormally`, ~L220) awaits this
// counter reaching zero before calling `process.exit(0)`: Node's Writable stream ordering already
// guarantees any write ENQUEUED before the terminal `shutdown_complete` write has its callback fire
// no later than that write's own callback (same underlying fd, same queue, strictly FIFO), but a
// `log()` call is fire-and-forget by design and nothing stops one from being *enqueued* by a
// still-settling async step (e.g. inside `bridge.closeTransport()`/`closeHttpServer()`, whose
// internals this file does not control) concurrently with or after the terminal write — a counter
// is the only mechanism that also covers a write that hasn't been enqueued yet at the moment we
// check. `waitForPendingWrites()` resolves once every write outstanding AT THE TIME IT IS CALLED
// has settled, which is the correct instant to poll it: called synchronously right before
// `process.exit(0)`, with nothing awaited in between, so nothing new can slip in after the check.
let pendingWriteCount = 0
let pendingWritesSettled: (() => void) | undefined
const trackPendingWrite = (promise: Promise<void>): Promise<void> => {
  pendingWriteCount += 1
  const settle = (): void => {
    pendingWriteCount -= 1
    if (pendingWriteCount === 0) pendingWritesSettled?.()
  }
  // Both branches must decrement — a rejected write (e.g. EPIPE on a closed stdout) is still a
  // settled write for drain-tracking purposes; the rejection itself is handled by each write's own
  // caller (writeEvent's caller, or log()'s own `.catch(() => {})`).
  promise.then(settle, settle)
  return promise
}
const waitForPendingWrites = (): Promise<void> => {
  if (pendingWriteCount === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    pendingWritesSettled = resolve
  })
}

const writeEvent = (event: WrapperEvent): Promise<void> =>
  trackPendingWrite(
    new Promise<void>((resolve) => {
      process.stdout.write(encodeWrapperEvent(event), (err) => {
        // issue #42 defect #2: writeEvent itself must never reject. The stream-level
        // `process.stdout.on('error', ...)` handler installed in `main()` only covers the
        // STREAM's own 'error' event — it does nothing to protect the many call sites throughout
        // this file that `await`/`void` a `writeEvent(...)` call without their own `.catch()`
        // (e.g. `ready`, `init`, `message_delta`, `result`, `grandchild_spawned`,
        // `tool_call_request`). A rejected promise from one of those unguarded call sites is an
        // unhandled rejection that crashes this process with exit code 1 — confirmed empirically
        // against a real closed-stdout/EPIPE condition — precisely the ungraceful crash Part A
        // (and this defect's stream-level handler) already exists to eliminate. Every caller
        // that DOES branch on write success only ever does so via `waitForPendingWrites`'s
        // settle-on-either-outcome tracking (see `trackPendingWrite` above), which is unaffected
        // by resolving here instead of rejecting, so there is no behavioral loss in never
        // rejecting.
        if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
          process.stderr.write(`[claude_code_cli wrapper] stdout write error: ${String(err)}\n`)
        }
        resolve()
      })
    })
  )

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
  // Fixed single-turn dispatch contract: the harness owns iteration boundaries.
  args.push('--max-turns', '1')
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
  // issue #42 defect #3: `ELECTRON_RUN_AS_NODE` in THIS wrapper's own env may have been injected
  // by the adapter (Part C, issue #42) purely to make an Electron-host copy of the wrapper itself
  // run as plain Node — that injection has nothing to do with the `claude` grandchild, which
  // could itself be a Node/Electron-based binary whose behavior this stray var could unexpectedly
  // change. The marker is set ONLY alongside the adapter's own injection (see adapter.ts's
  // `wrapperEnv` construction), never by a consumer setting `ELECTRON_RUN_AS_NODE` in their own
  // ambient environment for an unrelated reason — so stripping is conditional on the marker being
  // present, not unconditional, to avoid surprising a consumer who relies on it being forwarded.
  // Both the marker itself and the var it gates are removed; neither should reach `claude`.
  if (env.ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD !== undefined) {
    delete env.ELECTRON_RUN_AS_NODE
  }
  delete env.ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD
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
  // issue #42 defect #2: a closed stdout (EPIPE — the reader on the other end of the pipe is
  // gone) is a normal shutdown-adjacent condition here, not a bug. Without an explicit listener,
  // Node's default behavior for an unhandled Writable 'error' event is to throw, crashing this
  // process with exit code 1 — precisely the kind of ungraceful crash Part A exists to eliminate.
  // Every write's own promise (see `trackPendingWrite`/`writeEvent` above) already settles via its
  // callback's `err` branch regardless of this listener, so `waitForPendingWrites()` still
  // resolves correctly on its own (nothing further to wait on once the reader is gone) — this
  // listener's only job is to stop Node from treating a gone reader as fatal.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    // Any other stdout stream error is unexpected; surface it to stderr for diagnosis (stdout
    // itself may not be usable) rather than silently discarding it.
    process.stderr.write(`[claude_code_cli wrapper] stdout stream error: ${String(err)}\n`)
  })

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
  // and calls process.exit(1) — a SEPARATE, hang-recovery process.exit() call from the one
  // `shutdownNormally` makes below on its own (non-hung) success path. The two can never both run
  // for the same shutdown: `disarmBackstop()` always clears this timer before `shutdownNormally`'s
  // own `process.exit(0)`, and this callback body itself exits before returning control, so at most
  // one of the two `process.exit()` calls in this function's family actually executes.
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
    process.exitCode = 0
    // Explicit process.exit(0) — this is the actual fix for the reported bug (issue #42): when the
    // host process is an Electron main process (or any other host with a persistent, non-draining
    // event loop — an open BrowserWindow, a live timer, an open server socket the host itself
    // owns), a bare "fall off the end of main()" never terminates the process, because Node only
    // exits on its own once the event loop has NOTHING left to do, and this wrapper does not own
    // every handle that might be keeping that loop alive in an Electron host. A plain Node CLI host
    // exits fine either way (its own loop drains once `main()`'s promise settles with nothing else
    // pending), so this exit is safe and equivalent there — it is only ever OBSERVABLE as a fix in
    // a host with something else keeping the loop alive.
    //
    // `runShutdownSequence` above already `await`s `writeEvent({ type: 'shutdown_complete' })`
    // directly, so its OWN write's callback (and, by Node's strictly-FIFO per-stream write-callback
    // ordering, every write enqueued to this same stdout stream BEFORE it) has already fired by
    // this point. That does not cover every write, though: `log()` (used for diagnostics
    // throughout this file, including possibly from something like a lingering 'close'/'error'
    // handler on the MCP bridge's HTTP server) is fire-and-forget by design (`void writeEvent(...)`)
    // and can be invoked from a callback that is not sequenced via any `await` in this function —
    // such a call could still be IN FLIGHT (enqueued to stdout, callback not yet fired) at this
    // exact point, arbitrarily AFTER `shutdown_complete`'s own write settled, which the FIFO
    // guarantee above says nothing about. `waitForPendingWrites()` (see its definition and the
    // `pendingWriteCount` machinery near the top of this file) is the flush barrier that actually
    // accounts for that case: it tracks every `writeEvent(...)` call site (not just this one), and
    // resolves only once every write outstanding at the moment it's called has actually settled —
    // so a `log()` call racing the shutdown sequence is never truncated by this `process.exit(0)`.
    //
    // issue #42 defect #2: the backstop (armed above) MUST stay live through this await, not be
    // disarmed before it — a stuck/backpressured stdout flush (e.g. a slow or paused reader on
    // the other end of the pipe) is exactly the kind of hang Part A exists to recover from, and
    // disarming here would leave this final await with no timeout protection at all. Disarm only
    // now, immediately before the exit call that makes the backstop's own alternate exit path
    // moot.
    await waitForPendingWrites()
    disarmBackstop()
    process.exit(0)
  }

  // Idempotent SIGTERM/SIGINT handling. Registering a handler REPLACES Node's default
  // terminate-on-signal behavior, so this path must explicitly call process.exit() itself once the
  // shutdown sequence completes — same requirement `shutdownNormally` above now has for the same
  // reason (a signal handler being registered at all is itself evidence of "something else may be
  // keeping this event loop alive", exactly the condition that motivates `shutdownNormally`'s own
  // explicit exit). This path does not thread through the `pendingWriteCount` flush barrier the
  // way `shutdownNormally` does — a killed/interrupted process discarding its last `log()` line is
  // an acceptable loss on a signal-driven shutdown, unlike the normal-completion path where
  // preserving every diagnostic write matters more. Uses its own `handlingSignal` guard rather than
  // the `shuttingDown` flag `shutdownNormally` sets, so the two CAN run concurrently if a signal
  // arrives mid-shutdown — a pre-existing race, unaffected by this fix: whichever `process.exit()`
  // call reaches the event loop first wins, and Node ignores a second one against an
  // already-terminating process.
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
    // issue #42 defect #1: report the grandchild's pid (== pgid, since it's detached) so the
    // adapter can escalate a SIGKILL to the whole process group, not just the wrapper itself.
    if (typeof grandchild.pid === 'number') {
      void writeEvent({ type: 'grandchild_spawned', pid: grandchild.pid })
    }

    // Per-spawn message-id claim/reset state (issue #43, fix B) — see `message_id_state.ts` for
    // why this lives in its own synchronous, awaitless module rather than as loose locals mutated
    // around an `await`.
    const messageIdState = createMessageIdState()

    // Every stdout `'data'` chunk can carry several NDJSON lines, and `createNdjsonLineReader`
    // invokes its callback SYNCHRONOUSLY, once per complete line, in the order they appear in the
    // chunk — but `handleClaudeLine` itself is `async` and `await`s (e.g. `writeEvent`), so firing
    // it unawaited per line (the original shape here) let a SECOND line's handler start running,
    // reach its own synchronous prefix, and even complete entirely, WHILE the first line's handler
    // was still suspended at an `await`. That is exactly the race a verification pass caught
    // against the initial fix-B patch: two `assistant`/`user` lines arriving in one chunk could
    // have their `writeEvent(..., isComplete: true)` calls (and any state built on top of them)
    // resolve out of order relative to the input. `createSerialQueue` (see `line_queue.ts`) chains
    // every line's handling onto a single promise tail, so the processing of one line strictly
    // happen-afters the full completion (including every `await` inside it) of the line before it
    // — `messageIdState`'s claim/reset calls, and the `writeEvent`s they gate, always run in input
    // order, with no window for a later line to observe stale state left over from an earlier one
    // still in flight. A handler that throws/rejects is caught by the queue's `onError` so one bad
    // line can never break the chain for every line after it.
    const lineQueue = createSerialQueue((err: unknown) => {
      log('error', 'stream-line-handler-error', 'Error handling a Claude stream-json line.', {
        // eslint-disable-next-line adk/prefer-is-error -- self-contained wrt @nhtio/adk/* (Decision A)
        detail: err instanceof Error ? err.message : String(err),
      })
    })

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
      lineQueue.enqueue(() => handleClaudeLine(line))
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
          // `claimPartialDeltaId` reads AND assigns `messageIdState.partialMessageId` in one
          // synchronous call, with no `await` in between — see `message_id_state.ts`'s header for
          // why this matters (the line-handling queue above already serializes calls into this
          // function, but the claim itself staying synchronous is what keeps this function safe to
          // call from anywhere, including a future caller that isn't behind that queue).
          const id = claimPartialDeltaId(messageIdState)
          await writeEvent({ type: 'message_delta', id, delta })
        }
        return
      }
      if (line.type === 'assistant' || line.type === 'user') {
        if (line.parent_tool_use_id && command.forwardSubagentText !== true) return
        const text = extractMessageText(line)
        if (text.length > 0) {
          // Claim this message's id AND reset the state for whatever distinct message this SAME
          // spawn may still emit next (text -> tool_use -> more text) in one synchronous call,
          // strictly BEFORE the `await writeEvent(...)` below — the original fix-B patch mutated
          // `partialMessageId`/`messageIndex` AFTER that `await`, which let a second message's
          // handler (running concurrently, per the queue-serialization note above) read the
          // stale, not-yet-reset id and collide with the one just sealed here (issue #43, fix B
          // race, caught by a subsequent verification pass against f3d7fde).
          const { id, hadPriorPartialDelta } = claimCompleteMessageId(messageIdState)
          // If no prior stream_event deltas arrived for this id, the complete message carries the
          // ONLY copy of the text — send it as the delta itself, not an empty seal, or the
          // adapter's per-id accumulator (which treats the first call's deltaText as the full
          // content) would create an empty message despite real text having arrived.
          const delta = hadPriorPartialDelta ? '' : text
          await writeEvent({ type: 'message_delta', id, delta, isComplete: true })
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
          subtype: line.subtype,
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
      // issue #42 round-2 defect #1: tell the adapter the grandchild is gone, unconditionally and
      // regardless of the `sawResult`/`shuttingDown` guard below — this is what lets the adapter
      // clear its own cached pid/pgid so a later SIGKILL escalation never signals a stale value
      // that the OS may have already reused for an unrelated process group. This wrapper process
      // itself may be mid-shutdown (or about to be) when this fires; Node still delivers the
      // `ChildProcess` 'exit' event to this handler regardless, unless the wrapper is wedged badly
      // enough to never run any JS at all — in which case no event this process could emit would
      // help the adapter anyway (see the matching comment on `gracefulShutdown()` in adapter.ts).
      void writeEvent({ type: 'grandchild_exited' }).catch(() => {})
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
