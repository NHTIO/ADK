/**
 * Claude Code CLI's own stream-json vocabulary types and parser. Wrapper-only — never imported by
 * `adapter.ts`.
 *
 * @remarks
 * No `@nhtio/adk/*` imports (this module runs inside the wrapper process, per Decision A/C — the
 * wrapper is self-contained with respect to the ADK). Parses the `--output-format stream-json`
 * NDJSON lines `claude` emits into a small internal shape `wrapper.ts` then translates into the
 * normalized `WrapperEvent` union from `./wire`.
 *
 * The vocabulary here converges across the official docs and two independent prior-art parsers
 * (`nhtio-agent-delegator`'s `claude_harness.ts`, `giveon-claude-max-api-proxy`'s `manager.ts`):
 * `system` (init/api_retry subtypes), `assistant`/`user` (with `parent_tool_use_id` distinguishing
 * main-conversation from subagent text), `stream_event` (partial message deltas), and a terminal
 * `result` (success/error).
 */

/** A `system` event — either the one-time init handshake or a mid-turn retry notice. */
export interface ClaudeSystemInitLine {
  type: 'system'
  subtype: 'init'
  model?: string
  tools?: string[]
  mcp_servers?: Array<{ name: string; status?: string }>
  [key: string]: unknown
}

export interface ClaudeSystemApiRetryLine {
  type: 'system'
  subtype: 'api_retry'
  attempt?: number
  max_retries?: number
  retry_delay_ms?: number
  error_status?: number
  error?: string
  [key: string]: unknown
}

/** An `assistant`/`user` message line. `parent_tool_use_id` distinguishes subagent from main-conversation text. */
export interface ClaudeMessageLine {
  type: 'assistant' | 'user'
  parent_tool_use_id?: string | null
  message?: {
    id?: string
    content?: Array<{ type: string; text?: string; [key: string]: unknown }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** A `stream_event` line — a partial message delta under `--include-partial-messages`. */
export interface ClaudeStreamEventLine {
  type: 'stream_event'
  event?: {
    type?: string
    delta?: { type?: string; text?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  parent_tool_use_id?: string | null
  [key: string]: unknown
}

/** The terminal `result` line — always exactly one per turn, success or error. */
export interface ClaudeResultLine {
  type: 'result'
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
  total_cost_usd?: number
  usage?: Record<string, unknown>
  stop_reason?: string
  [key: string]: unknown
}

export type ClaudeStreamJsonLine =
  | ClaudeSystemInitLine
  | ClaudeSystemApiRetryLine
  | ClaudeMessageLine
  | ClaudeStreamEventLine
  | ClaudeResultLine

/**
 * Parse one already-newline-split `claude --output-format stream-json` line. Returns `undefined`
 * for anything that fails to parse as JSON or does not match a recognized `type` — the caller
 * (`wrapper.ts`) treats an `undefined` result as a non-fatal `log` event at `trace`, never throws.
 */
export const parseClaudeStreamJsonLine = (raw: string): ClaudeStreamJsonLine | undefined => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  const type = obj.type
  if (type === 'system' && obj.subtype === 'init') return obj as unknown as ClaudeSystemInitLine
  if (type === 'system' && obj.subtype === 'api_retry')
    return obj as unknown as ClaudeSystemApiRetryLine
  if (type === 'assistant' || type === 'user') return obj as unknown as ClaudeMessageLine
  if (type === 'stream_event') return obj as unknown as ClaudeStreamEventLine
  if (type === 'result') return obj as unknown as ClaudeResultLine
  return undefined
}

/**
 * Extract the plain-text delta from a `stream_event` line's content-block delta, or `undefined`
 * if this particular stream_event carries no text delta (e.g. a tool-call-argument delta, which
 * this battery does not surface as message text).
 */
export const extractStreamEventTextDelta = (line: ClaudeStreamEventLine): string | undefined => {
  const delta = line.event?.delta
  if (!delta) return undefined
  if (delta.type === 'text_delta' && typeof delta.text === 'string') return delta.text
  return undefined
}

/** Extract the concatenated plain text from a complete (non-streamed) assistant/user message line. */
export const extractMessageText = (line: ClaudeMessageLine): string => {
  const blocks = line.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}
