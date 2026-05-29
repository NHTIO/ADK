/**
 * TypeScript wire shapes, helper contracts, and option types for the Chat Completions battery.
 *
 * @module @nhtio/adk/batteries/llm/openai_chat_completions/types
 *
 * @remarks
 * Shared TypeScript type aliases for the OpenAI Chat Completions adapter — wire shapes,
 * helper input/output shapes, and the adapter's options shape. These are documentation-level
 * types only; runtime validation lives in `validation.ts` (`openAIChatCompletionsOptionsSchema`).
 */

import type { TokenEncoding } from '@nhtio/adk/common'
import type { SpooledArtifact, Media } from '@nhtio/adk/common'
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

// ─── DescriptionLike (validator description envelope) ─────────────────────────

export interface DescriptionLike {
  type?: string
  description?: string
  presence?: string
  default?: unknown
  enum?: unknown[]
  valids?: unknown[]
  examples?: unknown[]
  properties?: Record<string, DescriptionLike>
  items?: DescriptionLike | DescriptionLike[]
  required?: string[]
  flags?: { presence?: string; description?: string; default?: unknown }
  [key: string]: unknown
}

// ─── JSON Schema (Chat-Completions-compatible subset) ─────────────────────────

export interface JsonSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  description?: string
  enum?: unknown[]
  default?: unknown
  examples?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema | JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  [key: string]: unknown
}

// ─── Helper-attribute envelopes ───────────────────────────────────────────────

export interface UntrustedContentAttrs {
  nonce: string
  kind: string
  tool?: string
  /**
   * When wrapping a {@link @nhtio/adk!Media}-derived text marker, the modality hazard axis derived from
   * `media.modalityHazard`: `'inert'`, `'extractable'` (from `'extractable-instructions'`), or
   * `'opaque'` (from `'opaque-perceptual'`). Omitted for non-media envelopes.
   */
  modality?: 'inert' | 'extractable' | 'opaque'
}

export interface TrustedContentAttrs {
  nonce: string
  kind: string
  tool?: string
  /**
   * Same semantics as {@link UntrustedContentAttrs.modality}.
   */
  modality?: 'inert' | 'extractable' | 'opaque'
}

export interface StandingInstructionAttrs {
  version?: string
}

export interface MemoryAttrs {
  nonce: string
  source?: string
  createdAt?: string
  kind?: string
  score?: number
}

export interface RetrievableAttrs {
  nonce: string
  source?: string
  createdAt?: string
  kind?: string
  score?: number
}

export interface ThoughtAttrs {
  nonce: string
  kind: 'self-reasoning' | 'peer-reasoning' | 'opaque-reasoning'
  from: string
  createdAt?: string
  replayCompatibility?: string
}

// ─── Bucket order ─────────────────────────────────────────────────────────────

export type ChatCompletionsBucketLabel =
  | 'standingInstructions'
  | 'memories'
  | 'retrievables'
  | 'timeline'

export type ChatCompletionsBucketOrder = ReadonlyArray<ChatCompletionsBucketLabel>

// ─── Wire shapes ──────────────────────────────────────────────────────────────

export interface ChatCompletionsToolCallWire {
  id: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

/**
 * Discriminated union of content block shapes accepted by the OpenAI Chat Completions wire
 * format for a content-array message body.
 *
 * @remarks
 * `text` is the trust-envelope-wrapped string body. `image_url` carries either an inline
 * `data:` URI or a remote URL. `input_audio` carries base64-encoded audio plus a format hint.
 * `file` carries either a previously-uploaded `file_id` or an inline `file_data` blob with
 * a `filename`.
 */
export type ChatCompletionsContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' | 'mp3' } }
  | { type: 'file'; file: { file_id?: string; filename?: string; file_data?: string } }

export interface ChatCompletionsMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content: string | ChatCompletionsContentBlock[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: ChatCompletionsToolCallWire[]
}

export interface ChatCompletionsTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: JsonSchema
  }
}

export interface ChatCompletionsToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export interface AssembledToolCall {
  id: string
  type: 'function'
  name: string
  args: string
}

export interface ChatCompletionsToolCallDeltaAccumulator {
  feed(delta: ChatCompletionsToolCallDelta): void
  drain(): AssembledToolCall[]
}

export interface ChatCompletionsChunkDelta {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: ChatCompletionsToolCallDelta[]
}

export interface ChatCompletionsChunkChoice {
  index?: number
  delta?: ChatCompletionsChunkDelta
  finish_reason?: string | null
}

export interface ChatCompletionsChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: ChatCompletionsChunkChoice[]
  usage?: Record<string, unknown>
}

export interface ChatCompletionsResponseMessage {
  role?: 'assistant'
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: ChatCompletionsToolCallWire[]
}

export interface ChatCompletionsResponseChoice {
  index?: number
  message?: ChatCompletionsResponseMessage
  finish_reason?: string | null
}

export interface ChatCompletionsResponse {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: ChatCompletionsResponseChoice[]
  usage?: Record<string, unknown>
}

// ─── Unsupported-media policy ─────────────────────────────────────────────────

/**
 * Policy for how the OpenAI Chat Completions battery handles a {@link @nhtio/adk!Media} instance whose
 * modality the wire protocol cannot natively represent (today: video).
 *
 * @remarks
 * Three modes:
 *
 * - `'throw'` — raise `E_UNSUPPORTED_MEDIA_MODALITY` and fail the dispatch. Loud failure;
 *   the default, so a misconfigured pipeline surfaces immediately.
 * - `'fallback-stash'` — look for a model-readable text entry in `media.stash`. If
 *   present, render that text inside the appropriate trust envelope in lieu of a media block.
 *   If no entry is found, fall through to `'synthetic-description'` behaviour. The shorthand
 *   string form uses the battery's default key list (`['text:transcript', 'text:caption',
 *   'text:description']`, walked in order). The object form `{ mode: 'fallback-stash';
 *   stashKeys }` overrides the key list.
 * - `'synthetic-description'` — always render a synthetic text description constructed from
 *   `filename`, `byteLength`, and `mimeType` (e.g. `[media: report.mp4, video/mp4, 38.4 MB]`)
 *   regardless of `stash` presence.
 */
export type UnsupportedMediaPolicy =
  | 'throw'
  | 'fallback-stash'
  | 'synthetic-description'
  | { mode: 'fallback-stash'; stashKeys: ReadonlyArray<string> }

// ─── Retry config ─────────────────────────────────────────────────────────────

export interface ChatCompletionsRetryConfig {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  retriableStatuses?: number[]
  honorRetryAfter?: boolean
}

// ─── Helpers bag ──────────────────────────────────────────────────────────────

export interface ChatCompletionsHelpers {
  descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema
  renderUntrustedContent: (content: string, attrs: UntrustedContentAttrs) => string
  renderTrustedContent: (content: string, attrs: TrustedContentAttrs) => string
  renderStandingInstructions: (
    items: Iterable<Tokenizable>,
    attrs?: StandingInstructionAttrs
  ) => string
  renderMemories: (items: Iterable<{ memory: Memory; attrs: MemoryAttrs }>) => string
  renderRetrievableSafetyDirective: () => string
  renderFirstPartyRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>
  ) => string
  renderThirdPartyPublicRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>,
    deps: { renderUntrustedContent: ChatCompletionsHelpers['renderUntrustedContent'] }
  ) => string
  renderThirdPartyPrivateRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>,
    deps: { renderUntrustedContent: ChatCompletionsHelpers['renderUntrustedContent'] }
  ) => string
  renderRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>,
    deps: {
      renderRetrievableSafetyDirective: ChatCompletionsHelpers['renderRetrievableSafetyDirective']
      renderFirstPartyRetrievables: ChatCompletionsHelpers['renderFirstPartyRetrievables']
      renderThirdPartyPublicRetrievables: ChatCompletionsHelpers['renderThirdPartyPublicRetrievables']
      renderThirdPartyPrivateRetrievables: ChatCompletionsHelpers['renderThirdPartyPrivateRetrievables']
      renderUntrustedContent: ChatCompletionsHelpers['renderUntrustedContent']
    }
  ) => string
  renderTimelineMessage: (input: {
    message: Message
    selfIdentity: string
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<ChatCompletionsMessage>
  renderThought: (content: string, attrs: ThoughtAttrs, payload?: unknown) => string
  filterThoughts: (
    thoughts: Iterable<Thought>,
    mode: 'all-self' | 'latest-self' | 'all',
    selfIdentity: string,
    replayCompatibility: ReadonlyArray<string>
  ) => Thought[]
  toolsToChatCompletionsTools: (
    tools: ReadonlyArray<Tool | ArtifactTool>,
    deps: { descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema }
  ) => ChatCompletionsTool[]
  renderChatCompletionsSystemPrompt: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    bucketOrder: ChatCompletionsBucketOrder
    renderStandingInstructions: ChatCompletionsHelpers['renderStandingInstructions']
    renderMemories: ChatCompletionsHelpers['renderMemories']
    renderRetrievables: ChatCompletionsHelpers['renderRetrievables']
    renderRetrievableSafetyDirective: ChatCompletionsHelpers['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatCompletionsHelpers['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatCompletionsHelpers['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatCompletionsHelpers['renderThirdPartyPrivateRetrievables']
    renderUntrustedContent: ChatCompletionsHelpers['renderUntrustedContent']
  }) => string
  renderChatCompletionsToolCallResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatCompletionsHelpers['renderUntrustedContent']
    renderTrustedContent: ChatCompletionsHelpers['renderTrustedContent']
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<string | ChatCompletionsContentBlock[]>
  buildChatCompletionsHistory: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    messages: Iterable<Message>
    thoughts: Iterable<Thought>
    toolCalls: Iterable<ToolCall>
    tools: ToolRegistry
    renderedToolCallResults: Map<string, string | ChatCompletionsContentBlock[]>
    bucketOrder: ChatCompletionsBucketOrder
    selfIdentity: string
    thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
    replayCompatibility: ReadonlyArray<string>
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderChatCompletionsToolCallResult: ChatCompletionsHelpers['renderChatCompletionsToolCallResult']
    renderChatCompletionsSystemPrompt: ChatCompletionsHelpers['renderChatCompletionsSystemPrompt']
    renderStandingInstructions: ChatCompletionsHelpers['renderStandingInstructions']
    renderMemories: ChatCompletionsHelpers['renderMemories']
    renderRetrievables: ChatCompletionsHelpers['renderRetrievables']
    renderRetrievableSafetyDirective: ChatCompletionsHelpers['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatCompletionsHelpers['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatCompletionsHelpers['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatCompletionsHelpers['renderThirdPartyPrivateRetrievables']
    renderTimelineMessage: ChatCompletionsHelpers['renderTimelineMessage']
    renderThought: ChatCompletionsHelpers['renderThought']
    filterThoughts: ChatCompletionsHelpers['filterThoughts']
    renderUntrustedContent: ChatCompletionsHelpers['renderUntrustedContent']
    renderTrustedContent: ChatCompletionsHelpers['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<{
    messages: ChatCompletionsMessage[]
    reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  }>
  createChatCompletionsToolCallDeltaAccumulator: () => ChatCompletionsToolCallDeltaAccumulator
}

// ─── Request body ─────────────────────────────────────────────────────────────

export interface OpenAIChatCompletionsRequestBody {
  model: string
  messages: ChatCompletionsMessage[]
  stream: boolean
  tools?: ChatCompletionsTool[]
  /**
   * Side-channel for opaque vendor reasoning payloads. Forwarded to gateways that understand
   * them; stripped by gateways that don't.
   */
  _adk_reasoning_payloads?: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  [key: string]: unknown
}

// ─── Adapter options ──────────────────────────────────────────────────────────

export interface OpenAIChatCompletionsAdapterOptions {
  // ADK control
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
  stream?: boolean
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  retry?: ChatCompletionsRetryConfig
  fetch?: typeof globalThis.fetch
  bucketOrder?: ChatCompletionsBucketOrder
  contextWindow?: number
  selfIdentity?: string
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  tokenEncoding?: TokenEncoding | null
  replayCompatibility?: ReadonlyArray<string>
  helpers?: Partial<ChatCompletionsHelpers>
  /**
   * When `tool_choice` (or the `allowed_tools` variant) forces the model onto a specific tool
   * name, and that name resolves to an ephemeral, forged artifact-query tool (one produced by
   * `<Subclass>.forgeTools(ctx)` — i.e. `tool.ephemeral === true`), this flag controls how the
   * adapter reacts:
   *
   *   - `false` (default): emit a single `helpers.log.warn({ kind: 'tool-choice-forged-artifact', ... })`
   *     record and continue. Forging an artifact-query tool by name is almost always a
   *     misconfiguration — the tool may not exist in the next iteration once the artifact ages
   *     out — but the call still goes through.
   *   - `true`: hard-fail with `E_INVALID_OPENAI_CHAT_COMPLETIONS_OPTIONS`. Use this in
   *     production deployments where forcing a forged tool indicates a real bug.
   *
   * @defaultValue `false`
   */
  strictToolChoice?: boolean

  /**
   * Policy for how the adapter handles a {@link @nhtio/adk!Media} instance whose modality the OpenAI Chat
   * Completions wire format does not natively support (today: video). See
   * {@link UnsupportedMediaPolicy}.
   *
   * @defaultValue `'throw'`
   */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy

  /**
   * Whether the executor should call {@link @nhtio/adk!DispatchContext.ack | ctx.ack()} itself when a
   * generation completes with no tool calls (a terminal text answer).
   *
   * @remarks
   * `ack()` is terminal and one-shot: once called, the dispatch loop exits after the current
   * iteration. When the executor acks automatically, it seizes turn-completion control from the
   * implementor — a `dispatchOutputPipeline` quality gate can never run, because the signal is
   * already set before the output pipeline executes.
   *
   * This option therefore defaults to **`false`** (opt-in). With `autoAck: false`, a tool-call-free
   * response leaves the context unsignalled and the executor returns; the implementor's output
   * pipeline (or a later iteration) is responsible for calling `ctx.ack()` / `ctx.nack()`. This is
   * the seam that makes output-side quality gates (citation enforcement, schema validation,
   * regenerate-on-reject) possible.
   *
   * Set `autoAck: true` to restore single-shot behavior: the executor acks the moment a
   * tool-call-free answer finishes, terminating the turn without giving the output pipeline a vote.
   * The tool-call path is unaffected by this flag — it always withholds ack so the runner can
   * iterate and execute the calls. Error paths always {@link @nhtio/adk!DispatchContext.nack | nack}
   * regardless of this flag.
   *
   * @defaultValue `false`
   */
  autoAck?: boolean

  // Chat Completions request body
  model: string
  audio?: { voice: string; format: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16' }
  frequency_penalty?: number
  function_call?: 'none' | 'auto' | { name: string }
  functions?: Array<{ name: string; description?: string; parameters?: JsonSchema }>
  logit_bias?: Record<string, number>
  logprobs?: boolean
  max_completion_tokens?: number
  max_tokens?: number
  metadata?: Record<string, string>
  modalities?: Array<'text' | 'audio'>
  n?: number
  parallel_tool_calls?: boolean
  prediction?: {
    type: 'content'
    content: string | Array<{ type: 'text'; text: string }>
  }
  presence_penalty?: number
  prompt_cache_key?: string
  prompt_cache_retention?: 'in_memory' | '24h'
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
  response_format?:
    | { type: 'text' }
    | { type: 'json_object' }
    | {
        type: 'json_schema'
        json_schema: {
          name: string
          schema: JsonSchema
          strict?: boolean
          description?: string
        }
      }
  safety_identifier?: string
  seed?: number
  service_tier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale'
  stop?: string | string[]
  store?: boolean
  stream_options?: { include_usage?: boolean; include_obfuscation?: boolean }
  temperature?: number
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | { type: 'custom'; custom: { name: string } }
    | {
        type: 'allowed_tools'
        allowed_tools: {
          mode: 'auto' | 'required'
          tools: Array<
            | { type: 'function'; function: { name: string } }
            | { type: 'custom'; custom: { name: string } }
          >
        }
      }
  top_logprobs?: number
  top_p?: number
  user?: string
  verbosity?: 'low' | 'medium' | 'high'
  web_search_options?: {
    search_context_size?: 'low' | 'medium' | 'high'
    user_location?: {
      type: 'approximate'
      approximate: {
        city?: string
        country?: string
        region?: string
        timezone?: string
      }
    }
  }
}
