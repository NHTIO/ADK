/**
 * TypeScript wire shapes, helper contracts, and option types for the Claude Code CLI battery.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli/types
 *
 * @remarks
 * Type aliases for the `ClaudeCodeCliAdapter` — the public options shape, the
 * {@link ClaudeCodeCliHelpers} contract (extends the wire-shape-agnostic {@link ChatHelpersCommon}
 * with the battery's own history-rendering and outbound tool-result-rendering members), and
 * re-exports of the wire-shape-agnostic types consumers of this battery need. The
 * adapter↔wrapper protocol itself lives in `./wire` (zero imports, shared across future CLI
 * harnesses) and is re-exported here for convenience.
 */

import type { SpoolStore } from '@nhtio/adk/common'
import type { ClaudeCodeCliExtraArg } from './wire'
import type {
  ChatCompletionsBucketOrder,
  UnsupportedMediaPolicy,
  ChatHelpersCommon,
} from '../chat_common/types'
import type {
  Tokenizable,
  Memory,
  Message,
  Thought,
  ToolCall,
  Retrievable,
  Tool,
  ArtifactTool,
  ToolRegistry,
  SpooledArtifact,
  Media,
} from '@nhtio/adk/common'

// ─── Re-exported shared (wire-shape-agnostic) types ───────────────────────────
export type {
  DescriptionLike,
  JsonSchema,
  UntrustedContentAttrs,
  TrustedContentAttrs,
  StandingInstructionAttrs,
  MemoryAttrs,
  RetrievableAttrs,
  ThoughtAttrs,
  ChatCompletionsBucketLabel,
  ChatCompletionsBucketOrder,
  ChatCompletionsTool,
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
} from '../chat_common/types'

// ─── Re-exported wire protocol types ───────────────────────────────────────────
export type {
  ClaudeCodeCliExtraArg,
  WrapperBridgedTool,
  WrapperAuth,
  WrapperRunCommand,
  WrapperToolResultContentBlock,
  WrapperToolCallResponseCommand,
  WrapperShutdownCommand,
  WrapperCommand,
  WrapperReadyEvent,
  WrapperInitEvent,
  WrapperMessageDeltaEvent,
  WrapperThoughtDeltaEvent,
  WrapperToolCallRequestEvent,
  WrapperRetryEvent,
  WrapperResultEvent,
  WrapperErrorEvent,
  WrapperLogEvent,
  WrapperShutdownCompleteEvent,
  WrapperEvent,
} from './wire'

// ─── Helpers bag ──────────────────────────────────────────────────────────────

/**
 * Full translation-helper contract for the Claude Code CLI battery. Extends the wire-shape-
 * agnostic {@link ChatHelpersCommon} (shared with every other Chat-family battery) and adds the
 * battery-specific members: a plain-text-only timeline-message renderer (a `-p` prompt string has
 * no native image side-channel, unlike Ollama's `images[]`), a plain-text-only tool-call-result
 * renderer for the *inbound* history direction, and the top-level history-to-prompt assembler.
 */
export interface ClaudeCodeCliHelpers extends ChatHelpersCommon {
  /**
   * Renders a single timeline {@link @nhtio/adk!Message} into plain text for the `-p` prompt
   * string. Structurally identical to `renderOllamaTimelineMessage`'s trust-envelope/identity
   * logic, except every attachment (image or otherwise) routes through `unsupportedMediaPolicy`
   * and renders as text, since there is no native image channel to push into.
   */
  renderClaudeCodeCliTimelineMessage: (input: {
    message: Message
    selfIdentity: string
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<string>
  /**
   * Renders a completed {@link @nhtio/adk!ToolCall}'s result into plain text for the *inbound*
   * history direction (i.e. how a past tool call reads back into a subsequent dispatch's rendered
   * prompt) — the counterpart to the *outbound* MCP `CallToolResult` rendering the adapter performs
   * directly when a tool call happens mid-turn (see `wire.ts`'s `WrapperToolCallResponseCommand`).
   */
  renderClaudeCodeCliToolCallResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<string>
  /**
   * Assembles the full history into a single joined prompt string: the leading system-prompt
   * block, the timestamp-sorted timeline (messages/thoughts/tool-calls), and any trailing buckets
   * after `'timeline'` in `bucketOrder` — a direct structural port of `buildOllamaHistory`'s
   * ordering, with the target shape collapsed from a message array to one string (this wire has
   * one `-p` positional argument, not a message array).
   */
  buildClaudeCodeCliPrompt: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    messages: Iterable<Message>
    thoughts: Iterable<Thought>
    toolCalls: Iterable<ToolCall>
    tools: ToolRegistry
    /** Pre-rendered results keyed by the live ToolCall instances used during assembly. */
    renderedToolCallResults: Map<ToolCall, string>
    bucketOrder: ChatCompletionsBucketOrder
    selfIdentity: string
    thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
    replayCompatibility: ReadonlyArray<string>
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    /** Live dispatch context, forwarded to `renderChatCompletionsSystemPrompt`'s own `renderCtx` for resolving a DYNAMIC `Tokenizable` systemPrompt. */
    renderCtx?: unknown
    renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
    renderClaudeCodeCliTimelineMessage: ClaudeCodeCliHelpers['renderClaudeCodeCliTimelineMessage']
    renderClaudeCodeCliToolCallResult: ClaudeCodeCliHelpers['renderClaudeCodeCliToolCallResult']
    renderThought: ChatHelpersCommon['renderThought']
    filterThoughts: ChatHelpersCommon['filterThoughts']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<{
    prompt: string
    reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  }>
}

// ─── execa resolver (mirrors execa_executor.ts's ExecaResolver, for `execa` only) ──────────

/** The slice of execa this adapter uses to spawn the wrapper. */
export interface ExecaLike {
  (
    cmd: string,
    args: readonly string[],
    options: {
      cleanup?: boolean
      cwd?: string
      env?: Record<string, string | undefined>
    }
  ): {
    stdin: { write(chunk: string): void; end(): void } | null
    stdout: {
      on(event: 'data', listener: (chunk: Uint8Array) => void): void
      on(event: 'end', listener: () => void): void
    } | null
    kill(signal?: string): boolean
    readonly exitCode: number | null
    then: Promise<{ exitCode: number | null }>['then']
    catch: Promise<{ exitCode: number | null }>['catch']
  }
}

/** Resolver forms accepted for the `execa` module — mirrors `ExecaResolver` in `execa_executor.ts`. */
export type ExecaResolver =
  | ExecaLike
  | (() => ExecaLike | { execa: ExecaLike } | Promise<ExecaLike | { execa: ExecaLike }>)

// ─── Adapter options ──────────────────────────────────────────────────────────

/**
 * Configuration options for the {@link @nhtio/adk/batteries/llm/claude_code_cli!ClaudeCodeCliAdapter}.
 */
export interface ClaudeCodeCliAdapterOptions {
  // ADK control
  /** The `execa` function or an async resolver for it. Defaults to a lazy dynamic import of the `execa` package (optional peer). */
  execa?: ExecaResolver
  /** Overridable path to the built wrapper asset. Defaults to `resolveDefaultWrapperPath()`. */
  wrapperPath?: string
  /** Path to the `claude` binary. Defaults to `'claude'` (resolved via `PATH`). */
  claudeBin?: string
  /**
   * Forwarded verbatim to `--append-system-prompt`, appending to Claude Code's OWN system
   * prompt — a wholly separate channel from this battery's rendered `-p` history prompt. No
   * merge/concatenation logic against the history prompt itself.
   */
  appendSystemPrompt?: string
  /** Forwarded as `ANTHROPIC_API_KEY`. Exactly one of `apiKey`/`authToken` must be set. */
  apiKey?: string
  /** Forwarded as `ANTHROPIC_AUTH_TOKEN`. Exactly one of `apiKey`/`authToken` must be set. Empirically confirmed to work under `--bare`. */
  authToken?: string
  /** Forwarded as `ANTHROPIC_BASE_URL`. Valid with either auth mechanism. */
  baseURL?: string
  /** Working directory for the grandchild `claude` process. */
  cwd?: string
  /** Additional directories to allow tool access to, forwarded to `--add-dir`. */
  addDir?: string[]
  /**
   * Tool names to exclude from the bridged MCP tool set BEFORE it ever reaches the wrapper — the
   * real enforcement point (see the battery's design notes on why `--allowedTools` cannot do this
   * once `--dangerously-skip-permissions` is set). Never emitted as its own CLI flag.
   */
  disallowedTools?: string[]
  /**
   * Forwarded to `--max-turns` ONLY when a capability probe confirms the running CLI supports it
   * (the flag does not exist in every CLI version). Silently omitted otherwise.
   */
  maxTurns?: number
  /** Forwarded to `--max-budget-usd`. Always available. */
  maxBudgetUsd?: number
  /** Forwarded to `--fallback-model` as one comma-joined value. */
  fallbackModel?: string[]
  /** Required. The Claude model identifier, forwarded to `--model`. */
  model: string
  /** Adapter-side, ADK-owned stream-idle watchdog (ms). Reset on every raw stdout byte from the wrapper. Default 60_000. */
  streamIdleTimeoutMs?: number
  /**
   * Adapter-side startup watchdog (ms), spanning from the wrapper's spawn through BOTH the
   * wrapper's own `ready` event AND Claude's `system/init` stream-json event. Default 45_000.
   */
  startupTimeoutMs?: number
  /** Grace period (ms) the graceful-shutdown sequence waits for the wrapper/grandchild to exit before escalating. Default 2000. */
  disposeGraceMs?: number
  /** Mapped to `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` on the grandchild's env, never a CLI flag. Default unset (falls through to the CLI's own 5-minute default). */
  mcpToolIdleTimeoutMs?: number
  /** Mapped to `DISABLE_TELEMETRY` on the grandchild's env, never a CLI flag. */
  disableTelemetry?: boolean
  /** Mapped to `DISABLE_ERROR_REPORTING` on the grandchild's env, never a CLI flag. */
  disableErrorReporting?: boolean
  /** Mapped to `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` on the grandchild's env, never a CLI flag. */
  disableNonessentialTraffic?: boolean
  /** Unique identity label for the assistant instance. */
  selfIdentity?: string
  /** Whether the executor acks automatically on a tool-call-free terminal answer. */
  autoAck?: boolean
  /** Forwarded to `--forward-subagent-text` when true. Default false — subagent text is invisible by default (documented v1 limitation). */
  forwardSubagentText?: boolean
  /** Determines order of the system-prompt content buckets in history assembly. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Determines which thoughts are surfaced back to the model. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** List of replay labels supported by the assistant. */
  replayCompatibility?: ReadonlyArray<string>
  /** Optional overrides for the translation helpers. */
  helpers?: Partial<ClaudeCodeCliHelpers>
  /** Backing store for spooled tool results; defaults to a per-dispatch in-memory store. */
  spoolStore?: SpoolStore
  /** Policy for handling a {@link @nhtio/adk!Media} whose modality cannot be represented in the INBOUND (`-p` prompt) direction. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /**
   * Policy for handling a {@link @nhtio/adk!Media} whose modality cannot be represented in the
   * OUTBOUND (MCP tool-result) direction. A real, independently-settable branch — defaults to the
   * same value as `unsupportedMediaPolicy` when omitted, but can diverge.
   */
  unsupportedResultMediaPolicy?: UnsupportedMediaPolicy
  /**
   * A strict, structured allowlist escape hatch for genuinely orthogonal CLI flags
   * (`--effort`/`--agent`/`--betas`/`--json-schema`/`--name`/`--prompt-suggestions`). Validated at
   * options-construction time; never accepts a flag capable of touching tool/permission/MCP/
   * session-state configuration, and never accepts a value string starting with `-`.
   */
  extraArgs?: ClaudeCodeCliExtraArg[]
}
