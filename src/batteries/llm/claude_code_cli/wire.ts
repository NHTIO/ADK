/**
 * The normalized adapter↔wrapper protocol shared by every CLI-harness LLM battery.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli/wire
 *
 * @remarks
 * Zero imports by design: this module is the seam between `adapter.ts` (which runs in the ADK
 * process and imports ADK barrels freely) and `wrapper.ts` (which runs as a separate spawned
 * process and must import nothing from `@nhtio/adk/*`). Depending on either side would break the
 * boundary, so this file depends on neither.
 *
 * The wrapper↔adapter protocol itself is deliberately harness-agnostic — `WrapperRunCommand` /
 * `WrapperEvent` name no Claude-Code-specific concept — so a future Codex-CLI or Pi-agent battery
 * can reuse this exact module, writing only its own wrapper.
 */

/** One entry in a `--json-schema`/`--effort`-style `extraArgs` escape hatch. */
export interface ClaudeCodeCliExtraArg {
  /** The exact CLI flag spelling. Restricted to a small, deliberately-chosen allowlist. */
  flag: '--effort' | '--agent' | '--betas' | '--json-schema' | '--name' | '--prompt-suggestions'
  /**
   * The flag's value. Required for every flag except `--prompt-suggestions` (optional, matching
   * the CLI's own `[value]` bracket syntax). A plain `string` for every flag except `--betas`,
   * which accepts `string[]` (matching its own `<betas...>` variadic arity). Every individual
   * value string, in every position, must not start with `-` — this is what makes it structurally
   * impossible for a value to be interpreted by the CLI's own parser as a separate flag.
   */
  value?: string | string[]
}

/** A bridged ADK tool's JSON-Schema-rendered description, as exposed to the CLI over MCP. */
export interface WrapperBridgedTool {
  /** The tool's raw name — matches `ctx.tools.visible()`, NOT the `mcp__<server>__<name>` permission spelling. */
  name: string
  /** Human/model-facing description. */
  description: string
  /** Plain JSON-Schema-shaped input schema (never a Zod schema — see Decision F in the design). */
  inputSchema: Record<string, unknown>
}

/** Explicit auth credential to forward to the grandchild's environment. Exactly one of the two fields is set. */
export interface WrapperAuth {
  /** Forwarded as `ANTHROPIC_API_KEY`. */
  apiKey?: string
  /** Forwarded as `ANTHROPIC_AUTH_TOKEN`. */
  authToken?: string
  /** Forwarded as `ANTHROPIC_BASE_URL`. */
  baseUrl?: string
}

/**
 * The one command `adapter.ts` sends per dispatch iteration, immediately after the wrapper's
 * `ready` event arrives. Exactly one `run` command is accepted per wrapper process lifetime — the
 * wrapper is spawned fresh per dispatch iteration, so there is no multi-run session.
 */
export interface WrapperRunCommand {
  /** Discriminant for the {@link WrapperCommand} union. */
  type: 'run'
  /** The fully-rendered history, as one `-p` positional prompt string. */
  prompt: string
  /** Forwarded verbatim to `--append-system-prompt`, when set. */
  appendSystemPrompt?: string
  /** The model identifier, forwarded to `--model`. */
  model?: string
  /** Working directory for the grandchild, forwarded to `--cwd`-equivalent spawn option. */
  cwd?: string
  /** Additional directories to allow tool access to, forwarded to `--add-dir`. */
  addDir?: string[]
  /**
   * The exact MCP-bridged tool names the grandchild is allowed to call, ALREADY filtered by the
   * adapter to exclude `disallowedTools`. Always sent, never omitted at this layer — the wrapper
   * itself decides whether to emit `--allowedTools` (omitted entirely when this array is empty,
   * since the flag is variadic and a bare `--allowedTools` with nothing after it would swallow the
   * next argv token).
   */
  allowedTools: string[]
  /** Included only if a prior capability probe confirmed the running CLI supports `--max-turns`. */
  maxTurns?: number
  /** Forwarded to `--max-budget-usd`. */
  maxBudgetUsd?: number
  /** Forwarded to `--fallback-model` as one comma-joined value, never as separate argv tokens. */
  fallbackModel?: string[]
  /** Explicit auth credential(s) for the grandchild's environment. */
  auth?: WrapperAuth
  /** Mapped to `DISABLE_TELEMETRY` on the grandchild's env, never a CLI flag. */
  disableTelemetry?: boolean
  /** Mapped to `DISABLE_ERROR_REPORTING` on the grandchild's env, never a CLI flag. */
  disableErrorReporting?: boolean
  /** Mapped to `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` on the grandchild's env, never a CLI flag. */
  disableNonessentialTraffic?: boolean
  /** Mapped to `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` on the grandchild's env, never a CLI flag. */
  mcpToolIdleTimeoutMs?: number
  /** Path to the `claude` binary to spawn. */
  claudeBin: string
  /** Forwarded to `--forward-subagent-text` when true. */
  forwardSubagentText?: boolean
  /**
   * Governs how the adapter rendered an ADK tool-result's unsupported `Media` kind (or oversized
   * inline `SpooledArtifact`) into the outbound `WrapperToolCallResponseCommand` — informational
   * only, since the adapter has already applied the policy before this command is sent.
   */
  unsupportedResultMediaPolicy: string
  /** The JSON-Schema-rendered subset of `ctx.tools.visible()` the wrapper exposes over MCP, already pre-filtered to exclude `disallowedTools`. */
  bridgedTools: WrapperBridgedTool[]
  /** Pre-validated additional argv entries, appended after every constructed flag and before the `--` prompt separator. */
  extraArgs?: ClaudeCodeCliExtraArg[]
}

/** One MCP content block a tool-call response may carry. */
export type WrapperToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * The adapter's answer to a `tool_call_request` — a finished `CallToolResult`-shaped payload the
 * wrapper hands straight to the CLI's MCP bridge with no further interpretation.
 */
export interface WrapperToolCallResponseCommand {
  /** Discriminant for the {@link WrapperCommand} union. */
  type: 'tool_call_response'
  /** Correlates with the `requestId` on the originating `tool_call_request` event. */
  requestId: string
  /** A finished `CallToolResult`-shaped payload, handed straight to the CLI's MCP bridge. */
  results: {
    /** MCP content blocks to return for the call. */
    content: WrapperToolResultContentBlock[]
    /** Whether the tool call itself failed (as opposed to the wrapper/transport). */
    isError?: boolean
  }
}

/** Graceful-stop advisory sent to the wrapper (e.g. on `ctx.abortSignal` firing). */
export interface WrapperShutdownCommand {
  /** Discriminant for the {@link WrapperCommand} union. */
  type: 'shutdown'
}

/** The full adapter→wrapper command union. */
export type WrapperCommand =
  | WrapperRunCommand
  | WrapperToolCallResponseCommand
  | WrapperShutdownCommand

// ─── Wrapper → adapter events ──────────────────────────────────────────────

/** The bridge's HTTP listener is bound and the wrapper is about to spawn `claude`. */
export interface WrapperReadyEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'ready'
}

/** Mirrors Claude's own `system/init` stream-json event. */
export interface WrapperInitEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'init'
  /** The model Claude reports it initialized with. */
  model?: string
  /** The built-in tool names Claude reports as available (expected empty under `--tools ""`). */
  tools?: string[]
  /** Any MCP server connection errors Claude reported during its own startup handshake. */
  mcpServerErrors?: string[]
  /** The original, unmodified `system/init` stream-json line. */
  raw?: unknown
}

/** A streamed chunk of assistant text or reasoning. */
export interface WrapperMessageDeltaEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'message_delta'
  /** Identifier correlating deltas belonging to the same in-progress message. */
  id: string
  /** The incremental text chunk. */
  delta: string
  /** Set on the final delta for this message id. */
  isComplete?: boolean
}

/** A streamed chunk of reasoning/thinking text. */
export interface WrapperThoughtDeltaEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'thought_delta'
  /** Identifier correlating deltas belonging to the same in-progress thought. */
  id: string
  /** The incremental text chunk. */
  delta: string
  /** Set on the final delta for this thought id. */
  isComplete?: boolean
}

/** A real ADK tool the wrapper's MCP bridge is asking the adapter to execute. */
export interface WrapperToolCallRequestEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'tool_call_request'
  /** Correlates with the `requestId` the adapter must echo back on its `tool_call_response`. */
  requestId: string
  /** The bridged tool's raw name, matching `ctx.tools.visible()`. */
  tool: string
  /** The call arguments Claude supplied, as received from the MCP `CallTool` request. */
  args: unknown
}

/** Mirrors Claude's own `system/api_retry` stream-json event. Observability only. */
export interface WrapperRetryEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'retry'
  /** The retry attempt number. */
  attempt: number
  /** The maximum number of retries Claude will attempt. */
  maxRetries?: number
  /** The delay, in milliseconds, before the next retry. */
  retryDelayMs?: number
  /** The HTTP status code that triggered the retry. */
  errorStatus?: number
  /** The error message associated with the retry. */
  error?: string
}

/** The terminal event for a dispatch iteration. */
export interface WrapperResultEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'result'
  /** The final assistant-facing result text, when present. */
  resultText?: string
  /** Claude's own session identifier for this turn. */
  sessionId?: string
  /** Total cost, in USD, Claude reports for this turn. */
  totalCostUsd?: number
  /** Token/usage accounting Claude reports for this turn. */
  usage?: Record<string, unknown>
  /** Whether this turn ended in an error (e.g. `--max-turns`/`--max-budget-usd` exhaustion). */
  isError: boolean
  /** Claude's own stated reason the turn stopped. */
  stopReason?: string
  /** The original, unmodified terminal `result` stream-json line. */
  raw?: unknown
}

/** A wrapper-level failure (spawn error, unexpected exit, MCP bridge startup failure). */
export interface WrapperErrorEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'error'
  /** Human-readable summary of the failure. */
  message: string
  /** Additional detail, when available (e.g. the underlying error's message). */
  detail?: string
}

/** A generic diagnostic passthrough, never fatal. */
export interface WrapperLogEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'log'
  /** Severity of the diagnostic. */
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  /** A short machine-readable category for the diagnostic (e.g. `'malformed-stream-json'`). */
  kind: string
  /** Human-readable message. */
  message: string
  /** Additional structured detail, when available. */
  payload?: unknown
}

/**
 * The wrapper's bridge HTTP listener and `claude` grandchild have both been torn down and the
 * wrapper is about to exit.
 */
export interface WrapperShutdownCompleteEvent {
  /** Discriminant for the {@link WrapperEvent} union. */
  type: 'shutdown_complete'
}

/** The full wrapper→adapter event union. */
export type WrapperEvent =
  | WrapperReadyEvent
  | WrapperInitEvent
  | WrapperMessageDeltaEvent
  | WrapperThoughtDeltaEvent
  | WrapperToolCallRequestEvent
  | WrapperRetryEvent
  | WrapperResultEvent
  | WrapperErrorEvent
  | WrapperLogEvent
  | WrapperShutdownCompleteEvent

// ─── Encoding ───────────────────────────────────────────────────────────────

/** Encode a `WrapperCommand` as one NDJSON line, including its terminating newline. */
export const encodeWrapperCommand = (command: WrapperCommand): string =>
  `${JSON.stringify(command)}\n`

/** Encode a `WrapperEvent` as one NDJSON line, including its terminating newline. */
export const encodeWrapperEvent = (event: WrapperEvent): string => `${JSON.stringify(event)}\n`

// ─── Byte-oriented NDJSON line framing ─────────────────────────────────────

const LF = 0x0a
const CR = 0x0d

/**
 * Create an incremental, byte-oriented NDJSON line reader. Generalizes
 * `local_diffusion/protocol.ts`'s `createFrameReader` discipline (bounded memory via a hard
 * `maxLineBytes` cap enforced while consuming, fatal-UTF8-decode, malformed-line-is-non-fatal) for
 * pure JSON-per-line framing with no tag-prefixed grammar. `onLine` receives each decoded line and
 * returns the parsed value, or `undefined` for a line that failed to parse — the reader itself
 * never throws and never classifies content, it only frames bytes into lines.
 *
 * @throws RangeError if `maxLineBytes` is provided but is not a positive, finite, safe integer.
 */
export const createNdjsonLineReader = <T>(
  onLine: (raw: string) => T | undefined,
  opts?: { maxLineBytes?: number }
): { push(chunk: Uint8Array): void; end(): void } => {
  if (
    opts?.maxLineBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxLineBytes) || opts.maxLineBytes < 1)
  ) {
    throw new RangeError(
      `maxLineBytes must be a positive safe integer, received ${String(opts.maxLineBytes)}`
    )
  }
  const cap = opts?.maxLineBytes ?? 1_048_576
  const segments: Uint8Array[] = []
  let pending = 0
  let discarding = false
  let ended = false

  const resetLine = (): void => {
    segments.length = 0
    pending = 0
  }

  const assemble = (chunk: Uint8Array, start: number, end: number): Uint8Array => {
    const tail = end - start
    if (segments.length === 0) return chunk.subarray(start, end)
    const line = new Uint8Array(pending + tail)
    let at = 0
    for (const seg of segments) {
      line.set(seg, at)
      at += seg.length
    }
    if (tail > 0) line.set(chunk.subarray(start, end), at)
    return line
  }

  const decodeLine = (bytes: Uint8Array): void => {
    let end = bytes.length
    if (end > 0 && bytes[end - 1] === CR) end -= 1
    if (end === 0) return
    const slice = bytes.subarray(0, end)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(slice)
    } catch {
      // Invalid UTF-8 — not a fatal condition for the reader; the caller cannot parse it either,
      // so treat it exactly like a line onLine failed to parse (return undefined, no callback).
      return
    }
    onLine(text)
  }

  const consume = (chunk: Uint8Array): void => {
    let pos = 0
    if (discarding) {
      const nl = chunk.indexOf(LF, pos)
      if (nl === -1) return
      discarding = false
      pos = nl + 1
    }
    while (pos < chunk.length) {
      const nl = chunk.indexOf(LF, pos)
      if (nl === -1) {
        if (pending + (chunk.length - pos) > cap) {
          resetLine()
          discarding = true
        } else if (chunk.length > pos) {
          const seg = chunk.subarray(pos, chunk.length)
          segments.push(seg)
          pending += seg.length
        }
        return
      }
      if (pending + (nl - pos) > cap) {
        resetLine()
      } else {
        const line = assemble(chunk, pos, nl)
        resetLine()
        decodeLine(line)
      }
      pos = nl + 1
    }
  }

  return {
    push(chunk) {
      if (!ended) consume(chunk)
    },
    end() {
      if (ended) return
      ended = true
      resetLine()
      discarding = false
    },
  }
}
