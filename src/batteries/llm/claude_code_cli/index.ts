/**
 * Claude Code CLI battery — the first in the "CLI harness" LLM-battery family, wrapping the
 * `claude` CLI binary as a `DispatchExecutorFn` destination.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli
 *
 * @remarks
 * A fundamentally different kind of "model call" than the other bundled LLM batteries: the CLI is
 * itself a complete agent loop (its own tool use, its own context management, its own
 * retry/backoff), not a stateless completion endpoint. Since a subprocess must be spawned anyway,
 * ALL Claude-Code-specific complexity — spawning the real `claude` binary, hosting an MCP bridge
 * server, translating its stream-json — lives in a dedicated wrapper process shipped as a sibling
 * dist asset; the adapter only ever spawns and drives that wrapper over a small, harness-agnostic
 * protocol (`./wire`), reusable by future CLI harnesses (Codex CLI, the Pi coding agent).
 *
 * Key design decisions: history is ADK-owned and each dispatch is a stateless `claude --bare -p`
 * invocation (no `--resume`/`--session-id` reliance); Claude Code's own built-in tools are fully
 * disabled via `--tools ""`; real ADK tools are bridged into the CLI's tool loop via an injected
 * MCP server, but actual execution always happens on the ADK side via `tool.executor(ctx)(args)`;
 * permissions are bypassed wholesale (`--dangerously-skip-permissions`) since the bridge itself —
 * not a CLI allow-flag — is what enforces which bridged tools are callable; and there is no
 * client-side `contextWindow` guard, since `--max-budget-usd`/`--max-turns` are the CLI-native
 * substitutes.
 */

export { ClaudeCodeCliAdapter, resolveDefaultWrapperPath } from './adapter'

export {
  descriptionToChatCompletionsJsonSchema,
  defaultDescriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  defaultRenderUntrustedContent,
  renderTrustedContent,
  defaultRenderTrustedContent,
  renderStandingInstructions,
  defaultRenderStandingInstructions,
  renderMemories,
  defaultRenderMemories,
  renderRetrievableSafetyDirective,
  defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  renderRetrievables,
  defaultRenderRetrievables,
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  toolsToChatCompletionsTools,
  defaultToolsToChatCompletionsTools,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  renderClaudeCodeCliTimelineMessage,
  defaultRenderClaudeCodeCliTimelineMessage,
  renderClaudeCodeCliToolCallResult,
  defaultRenderClaudeCodeCliToolCallResult,
  buildClaudeCodeCliPrompt,
  defaultBuildClaudeCodeCliPrompt,
} from './helpers'

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
  ClaudeCodeCliHelpers,
  ClaudeCodeCliAdapterOptions,
  ExecaLike,
  ExecaResolver,
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
} from './types'

export { claudeCodeCliOptionsSchema, validateOptions } from './validation'

export {
  E_INVALID_CLAUDE_CODE_CLI_OPTIONS,
  E_CLAUDE_CODE_CLI_BINARY_NOT_FOUND,
  E_CLAUDE_CODE_CLI_WRAPPER_SPAWN_ERROR,
  E_CLAUDE_CODE_CLI_WRAPPER_CRASHED,
  E_CLAUDE_CODE_CLI_PROCESS_EXITED_NONZERO,
  E_CLAUDE_CODE_CLI_STREAM_ERROR,
  E_CLAUDE_CODE_CLI_STREAM_STALLED,
  E_CLAUDE_CODE_CLI_STARTUP_TIMEOUT,
  E_CLAUDE_CODE_CLI_MCP_BRIDGE_STARTUP_FAILED,
  E_CLAUDE_CODE_CLI_TURN_FAILED,
  E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY,
} from './exceptions'
