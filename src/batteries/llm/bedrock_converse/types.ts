/**
 * Wire shapes, helper contracts, and option types for the native Bedrock Converse battery.
 *
 * @module @nhtio/adk/batteries/llm/bedrock_converse/types
 *
 * @remarks
 * AWS Bedrock's Converse API is a content-BLOCK protocol, which is what separates it from Chat
 * Completions in ways a gateway has to paper over:
 *
 *  - A turn's payload is `content[]` — an array of typed blocks (`{text}`, `{image}`, `{toolUse}`,
 *    `{toolResult}`) — so ONE assistant turn can carry prose and a tool call together. In the
 *    OpenAI shape those are separate fields on separate messages.
 *  - A tool result is a **`user`** turn carrying a `{toolResult}` block, not a `tool`-role message.
 *  - System text is a top-level `system[]` array, not a message in the conversation.
 *  - Converse requires **strict `user` ↔ `assistant` alternation** and rejects consecutive
 *    same-role turns outright. This is the constraint most gateways silently repair by merging.
 *  - `toolConfig` MUST be present whenever any `toolUse` / `toolResult` block appears — omitting it
 *    is a hard rejection ("The toolConfig field must be defined when using toolUse and toolResult
 *    content blocks."), even when the history is only replaying past calls.
 *  - Tool input schemas go under `inputSchema.json` and must survive Converse's schema dialect,
 *    which rejects several JSON-Schema keywords.
 *
 * Auth is Bearer-token (`Authorization: Bearer <ABSK…>`) against
 * `bedrock-runtime.<region>.amazonaws.com`, so no SigV4 signer or AWS SDK dependency is required —
 * deliberately, since this battery must stay cross-environment and dependency-light.
 */

import type { TokenEncoding } from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { SpooledArtifact, Media, SpoolStore } from '@nhtio/adk/common'
import type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'
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
} from '@nhtio/adk/common'
import type {
  JsonSchema,
  ChatCompletionsBucketOrder,
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
  RawGenerationObserverFn,
  PromptAssembledObserverFn,
} from '../chat_common/types'

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
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
  RawGenerationObserverFn,
  PromptAssembledObserverFn,
} from '../chat_common/types'
export type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'

// ─── Native wire shapes ───────────────────────────────────────────────────────

/** Conversation role. Converse has no `system` or `tool` role — see the module remarks. */
export type ConverseRole = 'user' | 'assistant'

/** An image block. `bytes` is base64 on the wire despite the SDK's Uint8Array typing. */
export interface ConverseImageBlock {
  /** Image encoding Converse accepts. */
  format: 'png' | 'jpeg' | 'gif' | 'webp'
  /** Base64 payload wrapper. */
  source: { bytes: string }
}

/** A model-emitted tool invocation. */
export interface ConverseToolUse {
  /** Correlates with the matching `toolResult`. Converse rejects a null id. */
  toolUseId: string
  /** Declared tool name being invoked. */
  name: string
  /** Arguments the model chose. */
  input: Record<string, unknown>
}

/**
 * A tool result, carried on a **user** turn.
 *
 * @remarks
 * `toolUseId` must match the `toolUse` that requested it; an unmatched id is rejected.
 */
export interface ConverseToolResult {
  /** Must match the `toolUse` that requested it; an unmatched id is rejected. */
  toolUseId: string
  /** Result blocks; `text` or `json`. */
  content: Array<{ text?: string; json?: Record<string, unknown> }>
  /** Whether the tool succeeded; `'error'` lets the model react to a failure. */
  status?: 'success' | 'error'
}

/** One typed content block. Exactly one field is set per block. */
export interface ConverseContentBlock {
  /** Plain text. */
  text?: string
  /** Inline image payload. */
  image?: ConverseImageBlock
  /** A model-emitted tool invocation. */
  toolUse?: ConverseToolUse
  /** A tool result, on a `user` turn. */
  toolResult?: ConverseToolResult
  /** Extended-reasoning block, on models that support it. */
  reasoningContent?: { reasoningText?: { text: string; signature?: string } }
}

/** One conversation turn. */
export interface ConverseMessage {
  /** `'user'` or `'assistant'` — Converse has no `system` or `tool` role. */
  role: ConverseRole
  /** Typed blocks; one turn may mix prose and a tool call. */
  content: ConverseContentBlock[]
}

/** A system-text block. Top-level, never part of `messages[]`. */
export interface ConverseSystemBlock {
  /** System text. Top-level, never part of `messages[]`. */
  text: string
}

/** A tool declaration. */
export interface ConverseToolSpec {
  /** The declaration body. */
  toolSpec: {
    name: string
    description?: string
    /** Converse rejects several JSON-Schema keywords; see `helpers.ts`. */
    inputSchema: { json: JsonSchema }
  }
}

/** Forces, permits, or forbids tool use. */
export type ConverseToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } }

/**
 * Tool configuration.
 *
 * @remarks
 * REQUIRED whenever any `toolUse`/`toolResult` block appears anywhere in `messages`, including
 * pure history replay. Omitting it is a hard rejection.
 */
export interface ConverseToolConfig {
  /** Declared tools. Must be NON-EMPTY when present; an empty array is rejected. */
  tools: ConverseToolSpec[]
  /** Force, permit, or forbid tool use. */
  toolChoice?: ConverseToolChoice
}

/** Sampling and output controls. */
export interface ConverseInferenceConfig {
  /** Upper bound on generated tokens. */
  maxTokens?: number
  /** Sampling temperature. */
  temperature?: number
  /** Nucleus-sampling threshold. */
  topP?: number
  /** Sequences that halt generation. */
  stopSequences?: string[]
}

/** The complete Converse request body. */
export interface ConverseRequest {
  /** The conversation, in order. Roles must strictly alternate. */
  messages: ConverseMessage[]
  /** Top-level; there is no system role in `messages`. */
  system?: ConverseSystemBlock[]
  /** REQUIRED whenever any tool block appears, including pure history replay. */
  toolConfig?: ConverseToolConfig
  /** Sampling and output controls. */
  inferenceConfig?: ConverseInferenceConfig
  /** Model-specific fields Converse does not expose directly. */
  additionalModelRequestFields?: Record<string, unknown>
}

/** Token accounting. */
export interface ConverseUsage {
  /** Input tokens billed. */
  inputTokens?: number
  /** Generated tokens. */
  outputTokens?: number
  /** Input + output. */
  totalTokens?: number
  /** Tokens served from cache. */
  cacheReadInputTokens?: number
  /** Tokens written to cache. */
  cacheWriteInputTokens?: number
}

/** The Converse response body. */
export interface ConverseResponse {
  /** The generated turn. */
  output?: { message?: ConverseMessage }
  /** `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `guardrail_intervened`, `content_filtered` */
  stopReason?: string
  /** Token accounting. */
  usage?: ConverseUsage
  /** Server-side latency. */
  metrics?: { latencyMs?: number }
}

// ─── Helper contract ──────────────────────────────────────────────────────────

/**
 * The injectable translation seam. Every function has a `default*` implementation.
 *
 * @remarks
 * `buildConverseRequest` is the ordering seam — it is where ADK primitives become `messages[]`,
 * including the alternation repair Converse requires. A consumer needing different behaviour
 * overrides it rather than forking.
 */
export interface BedrockConverseHelpers extends ChatHelpersCommon {
  /** ADK tools → native `toolConfig.tools`. */
  toolsToConverseTools: (tools: Iterable<Tool | ArtifactTool>) => ConverseToolSpec[]
  /** Render one tool result into `toolResult.content[]`. */
  renderConverseToolResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    unsupportedMediaPolicy: UnsupportedMediaPolicy | undefined
    warn?: (message: string) => void
  }) => Promise<Array<{ text?: string; json?: Record<string, unknown> }>>
  /** Assemble the full request from turn state. The primary ordering seam. */
  buildConverseRequest: (input: ConverseRequestBuildInput) => Promise<ConverseRequest>
}

/** Everything `buildConverseRequest` needs. */
export interface ConverseRequestBuildInput {
  /** Base system text; becomes `system[]`. */
  systemPrompt: Tokenizable
  /** Rendered into the system blocks. */
  standingInstructions: Iterable<Tokenizable>
  /** Rendered into the system blocks. */
  memories: Iterable<Memory>
  /** Rendered into the system blocks. */
  retrievables: Iterable<Retrievable>
  /** Conversation messages. */
  messages: Iterable<Message>
  /** Reasoning to replay. */
  thoughts: Iterable<Thought>
  /** Tool calls to replay as toolUse/toolResult pairs. */
  toolCalls: Iterable<ToolCall>
  /** Tools offered this turn. */
  tools: ToolRegistry
  /** Pre-rendered result blocks, keyed by ToolCall id. */
  renderedToolCallResults: Map<string, Array<{ text?: string; json?: Record<string, unknown> }>>
  /** Order of context buckets in the system blocks. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Identity attributed to this agent's own thoughts. */
  selfIdentity: string
  /** Which reasoning to replay. */
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  /** Replay tags whose opaque payloads may be resent. */
  replayCompatibility: ReadonlyArray<string>
  /**
   * How to handle turn state that breaks Converse's strict alternation.
   *
   * @remarks
   * `'merge'` (default) folds consecutive same-role turns into one, concatenating their content
   * blocks — lossless, and what Converse itself would have accepted had the caller written it that
   * way. `'reject'` sends the history untouched so Converse's own error surfaces, which is what you
   * want when you are AUDITING whether the vendor really enforces alternation rather than relying
   * on a repair. `'filler'` inserts a placeholder turn instead of merging; it is lossier (it puts
   * words in the model's mouth) and is offered only because some callers need positional stability.
   */
  alternationPolicy?: 'merge' | 'filler' | 'reject'
  /** Resolved helper set. */
  helpers: BedrockConverseHelpers
  /** Decode an attachment into an image block. */
  decodeMedia?: (media: Media) => Promise<ConverseImageBlock>
  /** What to do with a modality Converse cannot accept. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Non-fatal diagnostics sink. */
  warn?: (message: string) => void
}

// ─── Adapter options ──────────────────────────────────────────────────────────

/** Constructor and per-dispatch options. */
export interface BedrockConverseAdapterOptions {
  /** Bedrock model id, e.g. `us.amazon.nova-2-lite-v1:0`. */
  model: string
  /** Bedrock API key (`ABSK…`), sent as `Authorization: Bearer`. */
  apiKey?: string
  /** AWS region. Ignored when {@link baseURL} is set. Defaults to `us-east-1`. */
  region?: string
  /** Full override, e.g. a gateway. Defaults to `https://bedrock-runtime.<region>.amazonaws.com`. */
  baseURL?: string
  /** Use `/converse-stream` instead of `/converse`. */
  stream?: boolean
  /** Upper bound on generated tokens. */
  maxTokens?: number
  /** Sampling temperature. */
  temperature?: number
  /** Nucleus-sampling threshold. */
  topP?: number
  /** Sequences that halt generation. */
  stopSequences?: string[]
  /** Force, permit, or forbid tool use. */
  toolChoice?: ConverseToolChoice
  /** Model-specific fields Converse does not expose. */
  additionalModelRequestFields?: Record<string, unknown>
  /**
   * See {@link ConverseRequestBuildInput.alternationPolicy}. Defaults to `'merge'`.
   *
   * @remarks
   * Set `'reject'` when you need to observe what Converse itself does with non-alternating history
   * — a repair that happens before dispatch is invisible in the response, which makes it easy to
   * mistake a gateway's fix for a vendor's tolerance.
   */
  alternationPolicy?: 'merge' | 'filler' | 'reject'
  /** Per-request timeout; falls back to the dispatch abort signal. */
  timeoutMs?: number
  /** Retry/backoff policy for transport failures. */
  retry?: ChatCompletionsRetryConfig
  /** Injectable `fetch`, for tests or a custom transport. */
  fetch?: typeof globalThis.fetch
  /** Encoding used for token accounting. */
  tokenEncoding?: TokenEncoding
  /** Spool store backing artifact-handle results. */
  spoolStore?: SpoolStore
  /** Order of context buckets in the system blocks. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Which reasoning to replay. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** What to do with a modality Converse cannot accept. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Recover tool calls the provider returned as prose. */
  localToolCallParser?: ToolCallParserName | ToolCallParserFn
  /** Observe the raw generation. Purely observational. */
  onRawGeneration?: RawGenerationObserverFn
  /** Observe the assembled request immediately before dispatch. An ADK-control key. */
  onPromptAssembled?: PromptAssembledObserverFn
  /** Override any translation helper. */
  helpers?: Partial<BedrockConverseHelpers>
  /** Narrow the artifact-reader tools forged from prior-turn results. */
  forgeToolsFilter?: (forged: ToolRegistry, ctx: DispatchContext) => ToolRegistry
}
