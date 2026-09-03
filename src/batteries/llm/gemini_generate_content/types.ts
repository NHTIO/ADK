/**
 * Wire shapes, helper contracts, and option types for the native Gemini `generateContent` battery.
 *
 * @module @nhtio/adk/batteries/llm/gemini_generate_content/types
 *
 * @remarks
 * Gemini's native surface differs from OpenAI Chat Completions in every structural respect, which
 * is why pointing the `openai_chat_completions` battery at a Gemini-compatible gateway is not
 * equivalent to speaking `generateContent`:
 *
 *  - Turns are `contents[]`, not `messages[]`, and the assistant role is **`model`**, not
 *    `assistant`. There is no `system` role: system text goes in a separate top-level
 *    `systemInstruction`.
 *  - A turn's payload is `parts[]` — a heterogeneous array. A tool call is a `functionCall` part on
 *    a `model` turn; its result is a `functionResponse` part on a **`user`** turn. So the
 *    OpenAI-shaped "assistant with tool_calls, then a tool-role message" becomes
 *    "model turn with a functionCall part, then a user turn with a functionResponse part".
 *  - `functionResponse.name` must match the DECLARED tool name, not a call id. Gemini has no
 *    `tool_call_id` concept, so correlation is positional/by-name.
 *  - Gemini 3+ rejects a historical `functionCall` part that carries no `thoughtSignature`. Google
 *    documents two portable sentinels for replaying traces that did not originate from Gemini; see
 *    {@link GeminiGenerateContentAdapterOptions.thoughtSignatureSentinel}.
 *  - Generation settings live under `generationConfig` (`maxOutputTokens`, `temperature`, `topP`,
 *    `topK`, `stopSequences`, `thinkingConfig`), and tools under `tools[].functionDeclarations[]`.
 *
 * Wire-shape-agnostic types (`JsonSchema`, the attribute envelopes, `UnsupportedMediaPolicy`, the
 * bucket order, the retry config, the observability taps) come from the shared internal
 * `../chat_common/types` submodule and are re-exported so consumers of this battery get a
 * self-contained type surface.
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

/**
 * A conversation role on the `generateContent` wire.
 *
 * @remarks
 * Note `'model'` where OpenAI says `'assistant'`, and the ABSENCE of a system role — system text is
 * carried out-of-band in `systemInstruction`. A tool RESULT is a `user` turn carrying a
 * `functionResponse` part, which is the single most surprising difference from the OpenAI shape.
 */
export type GeminiRole = 'user' | 'model'

/** Inline binary data (image/audio/etc.) as Gemini carries it. */
export interface GeminiInlineData {
  /** IANA media type, e.g. `image/png`. */
  mimeType: string
  /** Base64, no data-URL prefix. */
  data: string
}

/** A model-emitted request to invoke a declared function. */
export interface GeminiFunctionCall {
  /** Must match a declared `functionDeclarations[].name`. */
  name: string
  /** Arguments the model chose. Absent for a zero-arg call. */
  args?: Record<string, unknown>
}

/**
 * The result of a function invocation, sent back on a `user` turn.
 *
 * @remarks
 * `name` is the DECLARED FUNCTION NAME, not a call id — Gemini has no `tool_call_id`. A mismatched
 * name is a common source of opaque `INVALID_ARGUMENT` rejections.
 */
export interface GeminiFunctionResponse {
  /** The DECLARED function name — not a call id. */
  name: string
  /** Result payload. Gemini requires an OBJECT here; a bare string is rejected. */
  response: Record<string, unknown>
}

/**
 * One element of a turn's `parts[]`.
 *
 * @remarks
 * Exactly one of the payload fields is normally set. `thought` marks a part as reasoning;
 * `thoughtSignature` is the opaque provenance token Gemini 3+ requires on historical
 * `functionCall` parts.
 */
export interface GeminiPart {
  /** Plain text. Reasoning text sets {@link GeminiPart.thought} too. */
  text?: string
  /** Inline binary payload (image/audio). */
  inlineData?: GeminiInlineData
  /** A model-emitted request to invoke a declared function. */
  functionCall?: GeminiFunctionCall
  /** The result of a function invocation, on a `user` turn. */
  functionResponse?: GeminiFunctionResponse
  /** True when this part is model reasoning rather than user-visible output. */
  thought?: boolean
  /** Opaque reasoning-provenance token; required by Gemini 3+ on historical function calls. */
  thoughtSignature?: string
}

/** One conversation turn. */
export interface GeminiContent {
  /** `'user'` or `'model'` — never `'assistant'`, never `'system'`. */
  role: GeminiRole
  /** Heterogeneous payload; one turn may mix text, calls, and results. */
  parts: GeminiPart[]
}

/** A tool Gemini may call, in its native declaration shape. */
export interface GeminiFunctionDeclaration {
  /** Name the model must use in `functionCall.name`. */
  name: string
  /** What the tool does; the model's only guidance for choosing it. */
  description?: string
  /** OpenAPI-subset schema. Gemini rejects several JSON-Schema keywords; see `helpers.ts`. */
  parameters?: JsonSchema
}

/** The `tools[]` entry wrapping function declarations. */
export interface GeminiTool {
  /** The callable functions this entry declares. */
  functionDeclarations: GeminiFunctionDeclaration[]
}

/** Forces, permits, or forbids function calling. */
export interface GeminiToolConfig {
  /** The calling mode and its optional allow-list. */
  functionCallingConfig: {
    /** `AUTO` lets the model choose; `ANY` forces a call; `NONE` forbids one. */
    mode: 'AUTO' | 'ANY' | 'NONE'
    allowedFunctionNames?: string[]
  }
}

/** Reasoning-budget controls. */
export interface GeminiThinkingConfig {
  /** Token budget for reasoning; `0` disables, `-1` lets the model decide. */
  thinkingBudget?: number
  /** Whether reasoning parts are returned (as `thought: true` parts). */
  includeThoughts?: boolean
}

/** Sampling and output controls. */
export interface GeminiGenerationConfig {
  /** Upper bound on generated tokens. */
  maxOutputTokens?: number
  /** Sampling temperature. */
  temperature?: number
  /** Nucleus-sampling threshold. */
  topP?: number
  /** Top-k sampling cutoff. */
  topK?: number
  /** Sequences that halt generation when produced. */
  stopSequences?: string[]
  /** Forces a response media type, e.g. `application/json`. */
  responseMimeType?: string
  /** Schema the response must conform to, for structured output. */
  responseSchema?: JsonSchema
  /** Reasoning-budget controls. */
  thinkingConfig?: GeminiThinkingConfig
}

/** One safety-filter setting. */
export interface GeminiSafetySetting {
  /** Harm category, e.g. `HARM_CATEGORY_HARASSMENT`. */
  category: string
  /** Blocking threshold, e.g. `BLOCK_NONE`. */
  threshold: string
}

/** The complete `:generateContent` request body. */
export interface GeminiGenerateContentRequest {
  /** The conversation, in order. */
  contents: GeminiContent[]
  /** System text — there is no `system` role in `contents`. */
  systemInstruction?: { parts: GeminiPart[] }
  /** Callable function declarations. */
  tools?: GeminiTool[]
  /** Whether function calling is forced, permitted, or forbidden. */
  toolConfig?: GeminiToolConfig
  /** Sampling and output controls. */
  generationConfig?: GeminiGenerationConfig
  /** Per-category safety-filter overrides. */
  safetySettings?: GeminiSafetySetting[]
}

/** Per-candidate token accounting. */
export interface GeminiUsageMetadata {
  /** Input tokens billed for the prompt. */
  promptTokenCount?: number
  /** Output tokens across all candidates. */
  candidatesTokenCount?: number
  /** Prompt + candidates. */
  totalTokenCount?: number
  /** Reasoning tokens, when `includeThoughts` is on. */
  thoughtsTokenCount?: number
  /** Tokens served from context cache rather than re-billed. */
  cachedContentTokenCount?: number
}

/** One generation candidate. */
export interface GeminiCandidate {
  /** The generated turn. Absent when the candidate was filtered. */
  content?: GeminiContent
  /** `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER`, … */
  finishReason?: string
  /** Candidate ordinal when more than one was requested. */
  index?: number
  /** Per-category safety scores for this candidate. */
  safetyRatings?: Array<{ category: string; probability: string }>
}

/** The `:generateContent` response body (also each SSE frame of `:streamGenerateContent`). */
export interface GeminiGenerateContentResponse {
  /** Generations. Absent or empty when the prompt itself was blocked. */
  candidates?: GeminiCandidate[]
  /** Token accounting for the call. */
  usageMetadata?: GeminiUsageMetadata
  /** Why the PROMPT was rejected, when it was. */
  promptFeedback?: { blockReason?: string }
  /** The concrete model version that served the request — pin this when an alias was requested. */
  modelVersion?: string
}

// ─── Helper contract ──────────────────────────────────────────────────────────

/**
 * The injectable translation seam.
 *
 * @remarks
 * Mirrors the other batteries: every function here has a `default*` implementation and can be
 * replaced per-adapter. `buildGeminiRequest` is the one that matters for ordering work — it is
 * where ADK primitives become `contents[]`, so a consumer whose vendor needs a different shape
 * overrides it rather than forking the battery.
 */
export interface GeminiGenerateContentHelpers extends ChatHelpersCommon {
  /** ADK tools → native `functionDeclarations`. */
  toolsToGeminiTools: (tools: Iterable<Tool | ArtifactTool>) => GeminiTool[]
  /** Render one tool result into a `functionResponse.response` object. */
  renderGeminiToolResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    unsupportedMediaPolicy: UnsupportedMediaPolicy | undefined
    warn?: (message: string) => void
  }) => Promise<Record<string, unknown>>
  /** Assemble the full request from turn state. The primary ordering seam. */
  buildGeminiRequest: (input: GeminiRequestBuildInput) => Promise<GeminiGenerateContentRequest>
}

/** Everything `buildGeminiRequest` needs to assemble a request. */
export interface GeminiRequestBuildInput {
  /** Base system text; becomes `systemInstruction`, never a `contents[]` turn. */
  systemPrompt: Tokenizable
  /** Standing instructions, rendered into the system instruction. */
  standingInstructions: Iterable<Tokenizable>
  /** Memories, rendered into the system instruction. */
  memories: Iterable<Memory>
  /** Retrievables, rendered into the system instruction. */
  retrievables: Iterable<Retrievable>
  /** Conversation messages; `role: 'assistant'` maps to `'model'`. */
  messages: Iterable<Message>
  /** Reasoning to replay, subject to {@link GeminiRequestBuildInput.thoughtSurfacing}. */
  thoughts: Iterable<Thought>
  /** Tool calls to replay; each becomes a `functionCall` + `functionResponse` pair. */
  toolCalls: Iterable<ToolCall>
  /** Tools offered this turn, rendered into `functionDeclarations`. */
  tools: ToolRegistry
  /** Pre-rendered tool results, keyed by ToolCall id. Gemini requires objects, not strings. */
  renderedToolCallResults: Map<string, Record<string, unknown>>
  /** Optional; `buildGeminiRequest` falls back to {@link DEFAULT_GEMINI_BUCKET_ORDER}. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Identity attributed to this agent's own thoughts. */
  selfIdentity: string
  /** Which reasoning to replay. */
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  /** Replay tags whose opaque payloads may be sent back to this model. */
  replayCompatibility: ReadonlyArray<string>
  /** Sentinel stamped on the first historical `functionCall` when none carries a signature. */
  thoughtSignatureSentinel: string | false
  /** Resolved helper set; the assembler calls these rather than module globals. */
  helpers: GeminiGenerateContentHelpers
  /** Decode an attachment into `inlineData`. Attachments are skipped when absent. */
  decodeMedia?: (media: Media) => Promise<GeminiInlineData>
  /** What to do with a modality Gemini cannot accept. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Non-fatal diagnostics sink. */
  warn?: (message: string) => void
}

// ─── Adapter options ──────────────────────────────────────────────────────────

/**
 * Constructor and per-dispatch options.
 *
 * @remarks
 * Layered exactly like the other batteries: constructor baseline, then executor-scope overrides,
 * then per-iteration `ctx.stash` overrides, re-validated each iteration.
 */
export interface GeminiGenerateContentAdapterOptions {
  /** Model id, e.g. `gemini-2.5-flash-lite`. Prefer a CONCRETE id over a floating alias. */
  model: string
  /** API key. Sent as `x-goog-api-key` unless {@link useBearerAuth} is set. */
  apiKey?: string
  /**
   * Send the key as `Authorization: Bearer` instead of `x-goog-api-key`.
   *
   * @remarks
   * Google's own endpoint wants `x-goog-api-key`; several gateways in front of it accept only
   * `Authorization`. Default `false`.
   */
  useBearerAuth?: boolean
  /** Defaults to `https://generativelanguage.googleapis.com/v1beta`. */
  baseURL?: string
  /** Use `:streamGenerateContent` (SSE) instead of `:generateContent`. */
  stream?: boolean
  /** Upper bound on generated tokens. */
  maxOutputTokens?: number
  /** Sampling temperature. */
  temperature?: number
  /** Nucleus-sampling threshold. */
  topP?: number
  /** Top-k sampling cutoff. */
  topK?: number
  /** Sequences that halt generation. */
  stopSequences?: string[]
  /** Reasoning-budget controls. */
  thinkingConfig?: GeminiThinkingConfig
  /** Per-category safety-filter overrides. */
  safetySettings?: GeminiSafetySetting[]
  /** Force, permit, or forbid function calling. */
  toolConfig?: GeminiToolConfig
  /**
   * Sentinel to stamp on the first historical `functionCall` part that carries no
   * `thoughtSignature`, or `false` to send history untouched.
   *
   * @remarks
   * Gemini 3+ REJECTS a historical `functionCall` with no signature. When history did not originate
   * from Gemini (a replay, a model switch, a cross-vendor panel) there is no genuine signature to
   * send, and Google documents two portable sentinels for exactly that case —
   * `'skip_thought_signature_validator'` (Gemini API and Vertex) and
   * `'context_engineering_is_the_way_to_go'` (Gemini API only).
   *
   * Defaults to `'skip_thought_signature_validator'` because the alternative is a hard 400 on any
   * non-Gemini-originated tool history. It is nonetheless a PROVENANCE CLAIM about reasoning the
   * model did not produce, and Google cautions it may degrade quality relative to a real
   * signature — set `false` to opt out and surface the vendor's own error instead.
   */
  thoughtSignatureSentinel?: string | false
  /** Per-request timeout. Falls back to the dispatch abort signal when absent. */
  timeoutMs?: number
  /** Retry/backoff policy for transport failures. */
  retry?: ChatCompletionsRetryConfig
  /** Injectable `fetch`, for tests or a custom transport. */
  fetch?: typeof globalThis.fetch
  /** Encoding used for token accounting. */
  tokenEncoding?: TokenEncoding
  /** Spool store backing artifact-handle results. */
  spoolStore?: SpoolStore
  /** Order of context buckets in the system instruction. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Which reasoning to replay. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** What to do with a modality Gemini cannot accept. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Recover tool calls the provider returned as prose rather than `functionCall` parts. */
  localToolCallParser?: ToolCallParserName | ToolCallParserFn
  /** Observe the raw generation. Purely observational; errors swallowed. */
  onRawGeneration?: RawGenerationObserverFn
  /**
   * Observe the assembled request the instant before dispatch.
   *
   * @remarks
   * The honest way to check what a vendor actually received — see the validation battery's
   * "Which API surface a rule applies to" guide. An ADK-control key: stripped from the wire body.
   */
  onPromptAssembled?: PromptAssembledObserverFn
  /** Override any translation helper; unset entries fall back to the `default*` implementation. */
  helpers?: Partial<GeminiGenerateContentHelpers>
  /** Narrow the artifact-reader tools forged from prior-turn results before they merge in. */
  forgeToolsFilter?: (forged: ToolRegistry, ctx: DispatchContext) => ToolRegistry
}
