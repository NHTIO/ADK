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

import type { ClaudeCodeCliExtraArg } from './wire'
import type { SpoolStore } from '@nhtio/adk/common'
import type { TokenEncodingId } from '@nhtio/adk/types'
import type {
  ChatCompletionsBucketOrder,
  UnsupportedMediaPolicy,
  ChatHelpersCommon,
  ToolCallIdFilterFn,
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
export type { ToolCallIdFilterFn } from '../chat_common/types'

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
  /**
   * Overridable path to the built wrapper asset. Defaults to `resolveDefaultWrapperPath()`,
   * falling back to a package-self-reference lookup if that path does not exist on disk (e.g.
   * this adapter was bundled by a consumer, relocating it outside `@nhtio/adk`'s own directory
   * tree). Set this explicitly if both of those fail — surfaced as
   * {@link @nhtio/adk/batteries/llm/claude_code_cli!E_CLAUDE_CODE_CLI_WRAPPER_NOT_FOUND}.
   */
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
  /** Size of the model's token context window for the ADK pre-flight guard. */
  contextWindow?: number
  /** Tokenizer encoding configuration for token counting. */
  tokenEncoding?: TokenEncodingId | null
  /**
   * @deprecated Single-turn dispatch is the fixed battery contract. Only `1` is accepted; the
   * option is ignored because argv always carries `--max-turns 1`.
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
  /**
   * Ingress hook for adapting the wrapper's per-spawn `requestId` into the ADK-facing tool-call
   * id.
   *
   * @remarks
   * Unlike every other Chat-family battery (where this hook is opt-in and its absence means
   * pass-through), this battery's wrapper protocol resets its `requestId` counter to `"0"` on
   * EVERY spawn (see `mcp_bridge.ts`), and a fresh wrapper is spawned per dispatch ITERATION —
   * so a multi-iteration turn structurally guarantees a same-id collision the moment a second
   * tool-calling iteration occurs, not merely as a vendor/model quirk. Concretely, a same-id
   * collision trips one of two DIFFERENT id-tracking structures depending on the shape of the
   * turn: `DispatchExecutorHelpers.reportToolCall`'s own internal per-dispatch bookkeeping (an
   * id -> stream-state map local to `dispatch_runner.ts`'s `#buildHelpers`, which throws `tool
   * call "<id>" is already complete` on a duplicate) if the earlier call with that id already
   * completed within the SAME dispatch's helpers instance; or `ctx.turnToolCalls` (the
   * `Set<ToolCall>` `deCollideToolCallIds` itself inspects to pick a fresh id) if the collision is
   * against a call recorded in an EARLIER iteration of the same turn. These are two distinct
   * pieces of state, not one — this option's default only needs to satisfy the second, since
   * {@link @nhtio/adk!deCollideToolCallIds} renames the id BEFORE it ever reaches
   * `reportToolCall`, which is what prevents both. Left unset, this defaults to
   * {@link @nhtio/adk!deCollideToolCallIds} — NOT identity pass-through — so the crash this option
   * exists to prevent cannot happen by omission; set an explicit filter (or `(id) => id` to opt
   * back into raw pass-through) only if a different id strategy is required. The wrapper's OWN
   * `requestId` (used to correlate the `tool_call_response` written back over the wire) is never
   * affected by this hook — only the ADK-facing `ToolCall.id`/`callId` are renamed.
   */
  toolCallIdFilter?: ToolCallIdFilterFn
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
  /**
   * Overrides the executable spawned for the wrapper process. Defaults to `process.execPath` — on
   * an Electron main process (issue #42), `process.execPath` there is the Electron binary itself,
   * not a Node binary, so spawning it boots a copy of Electron rather than plain Node unless
   * `ELECTRON_RUN_AS_NODE` is both set (see `autoDetectElectronHost`) AND honored — which it is not
   * once the host's packaged binary has its `RunAsNode` Fuse disabled; the env var is silently
   * ignored in that case and the spawned copy boots as a full Electron app regardless. As of issue
   * #42 Part A, this no longer affects whether the wrapper exits cleanly (it always does, via an
   * explicit `process.exit(0)`) — it only affects resource cost: a full Electron app boots GPU/
   * network/renderer utility processes the wrapper never needed, for every dispatch. Set this to
   * an actual Node binary path (e.g. one a consumer bundles alongside their Electron app
   * specifically to run this battery) to avoid that cost — most valuable when
   * `process.versions.electron` is set AND the host's fuse is disabled, since
   * `autoDetectElectronHost`'s own `ELECTRON_RUN_AS_NODE` mitigation cannot help at all in that
   * specific case (see its own doc comment for the measured evidence), but worthwhile even with
   * the fuse enabled if avoiding the Electron-boot cost matters more than the small code-path
   * difference. Has no effect on the `claude` grandchild binary itself (`claudeBin`), only on the
   * wrapper's own host process.
   */
  wrapperExecPath?: string
  /**
   * Additional environment variables merged into the wrapper's spawn env, applied AFTER
   * `autoDetectElectronHost`'s own `ELECTRON_RUN_AS_NODE` default — so a key set here (including
   * explicit `undefined`, which deletes the key from the child's env entirely) always wins over
   * that default. Everything else about the parent's own `process.env` is inherited as-is (execa's
   * normal behavior); this is only for additions/overrides, not a replacement env map.
   */
  wrapperEnv?: Record<string, string | undefined>
  /**
   * Whether to auto-detect an Electron main-process host (`process.versions.electron !== undefined`)
   * and default the wrapper's spawn env to include `ELECTRON_RUN_AS_NODE: '1'` — the documented
   * Electron mechanism for making a spawned copy of the Electron binary behave as plain Node
   * instead of booting a full second Electron app that runs the wrapper script as its main script.
   * Default `true`; every plain-Node host is unaffected either way (`process.versions.electron` is
   * `undefined` there, so this default is inert), and this can be disabled if a consumer has their
   * own mitigation or supplies `wrapperExecPath` instead.
   *
   * @remarks
   * **This option is a resource optimization, not a correctness requirement.** Earlier revisions of
   * this doc comment (pre-issue-#42-Part-A) framed it as the fix for an Electron host hanging
   * indefinitely; that is no longer accurate and this paragraph corrects it. The wrapper's own
   * explicit `process.exit(0)` on the normal-completion path (issue #42, Part A) now guarantees a
   * clean exit unconditionally, regardless of whether this option is enabled, disabled, or
   * defeated by a disabled `RunAsNode` fuse — correctness no longer depends on this option at all.
   * What it still controls is which of two ways a spawned Electron binary reaches that same clean
   * exit:
   *
   * Measured (this fix's own investigation, scratch harnesses against a real copy of
   * `Electron.app`, both with the `RunAsNode` Electron Fuse left at its default (ON) and explicitly
   * disabled via `npx @electron/fuses`, and separately re-measured end-to-end against the BUILT
   * wrapper after Part A landed):
   * - Fuse ON, `ELECTRON_RUN_AS_NODE=1` (this option's default effect): spawned copy runs as plain
   *   Node (`process.type === undefined`) — cheap, no GPU/network/renderer utility processes ever
   *   boot. Exits 0.
   * - Fuse ON, no env var (this option disabled): spawned copy boots as a full Electron app
   *   (`process.type === 'browser'`) — measurably more expensive (GPU process, network service
   *   process, etc., all spun up and torn down for a wrapper that never needed any of them). Still
   *   exits 0 with Part A in place.
   * - Fuse OFF, either way: `ELECTRON_RUN_AS_NODE` is silently ignored by the Electron runtime
   *   itself — this option categorically cannot make the spawned copy behave as plain Node once
   *   the fuse is disabled. The spawned copy boots as a full Electron app regardless (the same
   *   "expensive" path as the previous bullet). With Part A in place, it still exits 0 — just
   *   wastefully, having booted machinery it didn't need. `child_process.fork()` from within a
   *   genuine Electron main process throws synchronously in this state (`"...fork() is not
   *   supported when the runAsNode fuse is disabled; use utilityProcess.fork() instead"`), and
   *   Electron's own suggested replacement, `utilityProcess.fork()`, throws synchronously the
   *   instant a non-`'ignore'` stdin is requested (`"stdin value other than ignore is not
   *   supported."`) — incompatible with this wrapper's NDJSON-over-stdin protocol regardless of
   *   fuse state, so neither is a substitute spawn mechanism.
   *
   * `wrapperExecPath` (pointing at a real bundled Node binary) remains the recommended mitigation
   * for a fuse-disabled Electron host — not because it is needed for the process to exit (Part A
   * already guarantees that), but because it avoids the resource cost of booting a full Electron
   * app per dispatch, the same reason this option exists at all when the fuse is enabled.
   */
  autoDetectElectronHost?: boolean
}
