/**
 * Battery-scoped exception constructors for the Claude Code CLI adapter.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli/exceptions
 *
 * @remarks
 * Battery-scoped exception classes minted via `createException` from `@nhtio/adk/factories`.
 * Malformed NDJSON frames (either the wrapper's own inbound-command reader, or its translation of
 * Claude's stream-json) are explicitly NOT a distinct exception — they are swallowed and surfaced
 * via `helpers.log.trace`, matching the Ollama battery's malformed-line policy.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options (constructor, executor overrides, or per-dispatch
 * `stash.claudeCodeCli`) fail validation — including `extraArgs` security-flag rejection, the
 * `apiKey`/`authToken` XOR violation, and the POSIX-only platform guard.
 */
export const E_INVALID_CLAUDE_CODE_CLI_OPTIONS = createException<[string]>(
  'E_INVALID_CLAUDE_CODE_CLI_OPTIONS',
  'Invalid Claude Code CLI adapter options: %s',
  'E_INVALID_CLAUDE_CODE_CLI_OPTIONS',
  529,
  true
)

/** Thrown when the `claude` binary cannot be located/spawned. */
export const E_CLAUDE_CODE_CLI_BINARY_NOT_FOUND = createException<[string]>(
  'E_CLAUDE_CODE_CLI_BINARY_NOT_FOUND',
  'Claude Code CLI binary not found: %s',
  'E_CLAUDE_CODE_CLI_BINARY_NOT_FOUND',
  500,
  true
)

/** Thrown when the wrapper process itself fails to spawn. */
export const E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR = createException<[string]>(
  'E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR',
  'Failed to spawn the Claude Code CLI wrapper process: %s',
  'E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR',
  500,
  true
)

/** Thrown when the wrapper process crashes or exits abnormally mid-dispatch. */
export const E_CLAUDE_CODE_CLI_WRAPPER_CRASHED = createException<[string]>(
  'E_CLAUDE_CODE_CLI_WRAPPER_CRASHED',
  'Claude Code CLI wrapper process crashed: %s',
  'E_CLAUDE_CODE_CLI_WRAPPER_CRASHED',
  500,
  false
)

/** Thrown when the wrapper process exits with no terminal `result`/`error` event observed. */
export const E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO = createException<[number, string]>(
  'E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO',
  'Claude Code CLI wrapper process exited (code %d) with no terminal event observed: %s',
  'E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO',
  502,
  false
)

/** Thrown on a transport-level stream failure between the adapter and the wrapper. */
export const E_CLAUDE_CODE_CLI_STREAM_ERROR = createException<[string]>(
  'E_CLAUDE_CODE_CLI_STREAM_ERROR',
  'Claude Code CLI stream error: %s',
  'E_CLAUDE_CODE_CLI_STREAM_ERROR',
  502,
  false
)

/** Thrown when the wrapper's stdout goes idle for longer than `streamIdleTimeoutMs`. */
export const E_CLAUDE_CODE_CLI_STREAM_STALLED = createException<[number]>(
  'E_CLAUDE_CODE_CLI_STREAM_STALLED',
  'Claude Code CLI stream stalled (no output for %dms)',
  'E_CLAUDE_CODE_CLI_STREAM_STALLED',
  504,
  false
)

/** Thrown when the wrapper does not signal `ready` and Claude's `system/init` within `startupTimeoutMs`. */
export const E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT = createException<[number]>(
  'E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT',
  'Claude Code CLI wrapper did not complete startup within %dms',
  'E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT',
  504,
  false
)

/**
 * Thrown when the wrapper's own MCP bridge server fails to start, OR Claude's `system/init`
 * reports an `mcp_server_errors` entry naming the bridge, OR the `@modelcontextprotocol/sdk`
 * optional peer is missing at wrapper startup.
 */
export const E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED = createException<[string]>(
  'E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED',
  'Claude Code CLI MCP bridge failed to start: %s',
  'E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED',
  500,
  false
)

/**
 * Thrown when Claude's terminal `result` reports `isError: true` — includes `--max-budget-usd`/
 * `--max-turns` exhaustion, the CLI-native substitutes for a client-side `contextWindow` guard.
 */
export const E_CLAUDE_CODE_CLI_TURN_FAILED = createException<[string, string]>(
  'E_CLAUDE_CODE_CLI_TURN_FAILED',
  'Claude Code CLI turn failed (%s): %s',
  'E_CLAUDE_CODE_CLI_TURN_FAILED',
  529,
  false
)

/**
 * Thrown when a {@link @nhtio/adk!Media} whose modality cannot be represented reaches either
 * direction of this battery under the corresponding `unsupportedMediaPolicy`/
 * `unsupportedResultMediaPolicy: 'throw'` — bidirectional: inbound prompt media (a `-p` string has
 * no native image channel) and outbound tool-result media (only text/image MCP content blocks are
 * supported).
 */
export const E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY = createException<
  [string, string, string]
>(
  'E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY',
  'Claude Code CLI battery does not support media of kind %s (mime=%s, filename=%s) in this direction. Configure the relevant unsupportedMediaPolicy option to `fallback-stash` or `synthetic-description` to handle this case.',
  'E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY',
  422,
  true
)
