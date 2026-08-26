/**
 * TypeScript wire shapes, helper contracts, and option types for the native Ollama battery.
 *
 * @module @nhtio/adk/batteries/llm/ollama/types
 *
 * @remarks
 * Type aliases for the native Ollama `/api/chat` adapter — the native wire shapes (which differ
 * from OpenAI Chat Completions: flat string `content` + separate base64 `images[]`, `thinking` for
 * reasoning, object-form tool-call `arguments`, `tool_name` on tool-role messages, NDJSON
 * streaming terminated by `done: true`), the adapter's options shape, and the {@link OllamaHelpers}
 * contract. Runtime validation lives in `validation.ts` (`ollamaOptionsSchema`).
 *
 * Wire-shape-agnostic types (`JsonSchema`, the attribute envelopes, `UnsupportedMediaPolicy`, the
 * bucket order, the retry config, the function-tool wire) are imported from the shared, internal
 * `../chat_common/types` submodule and re-exported here so consumers of
 * `@nhtio/adk/batteries/llm/ollama` get a self-contained type surface.
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
  ChatCompletionsTool,
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
  ChatCompletionsTool,
  UnsupportedMediaPolicy,
  ChatCompletionsRetryConfig,
  ChatHelpersCommon,
} from '../chat_common/types'
export type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'

// ─── think control ────────────────────────────────────────────────────────────

/**
 * Native `think` control for thinking-capable models. `true`/`false` toggle reasoning; the effort
 * strings request a reasoning budget on models that support graded thinking.
 */
export type OllamaThink = boolean | 'low' | 'medium' | 'high'

// ─── format (structured output) ───────────────────────────────────────────────

/**
 * Native `format` control. `'json'` requests free-form JSON; a {@link JsonSchema} object requests
 * schema-constrained structured output (the model's `content` is then a JSON string matching it).
 */
export type OllamaFormat = 'json' | JsonSchema

// ─── runtime options (the nested `options` block) ─────────────────────────────

/**
 * Native Ollama runtime/sampling parameters — sent NESTED under the request body's `options` key,
 * NOT at the top level (this is the key structural divergence from the OpenAI wire, where these
 * sit at the top level). All fields are optional; set only the ones you want to override. An
 * index signature allows forward-compatible passthrough of llama.cpp parameters this type has not
 * yet enumerated.
 */
export interface OllamaRuntimeOptions {
  /** Context window (KV-cache) size in tokens. Independent of the ADK `contextWindow` guard. */
  num_ctx?: number
  /** Sampling temperature. */
  temperature?: number
  /** Nucleus sampling cutoff. */
  top_p?: number
  /** Top-k sampling cutoff. */
  top_k?: number
  /** Min-p sampling cutoff. */
  min_p?: number
  /** Typical-p sampling cutoff. */
  typical_p?: number
  /** RNG seed for reproducible outputs. */
  seed?: number
  /** Stop sequence(s). */
  stop?: string | string[]
  /** Max tokens to predict (`-1` = infinite, `-2` = fill context). */
  num_predict?: number
  /** Tokens to keep from the initial prompt when context is exceeded. */
  num_keep?: number
  /** Penalty applied to repeated tokens. */
  repeat_penalty?: number
  /** Look-back window for repeat penalty. */
  repeat_last_n?: number
  /** Presence penalty. */
  presence_penalty?: number
  /** Frequency penalty. */
  frequency_penalty?: number
  /** Penalize newline tokens. */
  penalize_newline?: boolean
  /** Prompt-processing batch size. */
  num_batch?: number
  /** Number of layers to offload to GPU(s). */
  num_gpu?: number
  /** Primary GPU index. */
  main_gpu?: number
  /** CPU thread count. */
  num_thread?: number
  /** Enable NUMA support. */
  numa?: boolean
  /** Memory-map the model. */
  use_mmap?: boolean
  /** Forward-compatible passthrough for additional llama.cpp parameters. */
  [key: string]: unknown
}

// ─── Wire shapes (native /api/chat) ────────────────────────────────────────────

/**
 * A native Ollama tool call as returned on a response/stream `message`. Note: `arguments` is a
 * parsed JSON OBJECT (not a string), and there is no `id` or `type` field — the adapter
 * synthesizes a correlation id.
 */
export interface OllamaToolCall {
  /** The called function: its name and its parsed-JSON-object arguments. */
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

/**
 * A native Ollama chat message. Flat shape: `content` is always a string; image attachments ride
 * in a separate base64 `images[]` array (no content blocks); `thinking` carries reasoning; a
 * tool-role result message labels its origin with `tool_name` (NOT a `tool_call_id`).
 */
export interface OllamaMessage {
  /** Author role of the message. */
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Flat text body of the message (never a content-block array). */
  content: string
  /** Reasoning/thinking text emitted by thinking-capable models. */
  thinking?: string
  /** Base64-encoded image attachments, sent out-of-band from `content`. */
  images?: string[]
  /** Tool calls the model emitted on this (assistant) message. */
  tool_calls?: OllamaToolCall[]
  /** Name of the tool a tool-role result message corresponds to. */
  tool_name?: string
}

/** Native function-tool definition (structurally identical to the Chat Completions tool wire). */
export type OllamaTool = ChatCompletionsTool

/** The native `/api/chat` request body. */
export interface OllamaChatRequestBody {
  /** Ollama model name to run. */
  model: string
  /** The conversation history sent to the model. */
  messages: OllamaMessage[]
  /** Whether the response is streamed as NDJSON chunks. */
  stream: boolean
  /** Function tools advertised to the model. */
  tools?: OllamaTool[]
  /** Native reasoning control for thinking-capable models. */
  think?: OllamaThink
  /** Structured-output control: `'json'` or a JSON schema. */
  format?: OllamaFormat
  /** Native sampling/runtime parameters, nested under this key. */
  options?: OllamaRuntimeOptions
  /** How long the model stays resident after the request. */
  keep_alive?: string | number
  /**
   * Side-channel for opaque vendor reasoning payloads. Vanilla Ollama ignores unknown top-level
   * keys; gateways that understand it can forward it. Only set when non-empty.
   */
  _adk_reasoning_payloads?: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  [key: string]: unknown
}

/** A streamed NDJSON chunk from `/api/chat`. The terminal chunk carries `done: true` + stats. */
export interface OllamaChatStreamChunk {
  /** Model that produced the chunk. */
  model?: string
  /** ISO-8601 timestamp the chunk was created. */
  created_at?: string
  /** Partial assistant message carried by this chunk. */
  message?: {
    role?: 'assistant'
    content?: string
    thinking?: string
    images?: string[]
    tool_calls?: OllamaToolCall[]
  }
  /** `true` on the terminal chunk. */
  done?: boolean
  /** Why generation stopped, present on the terminal chunk. */
  done_reason?: 'stop' | 'load' | 'unload' | string
  /** Total request time in nanoseconds (terminal chunk). */
  total_duration?: number
  /** Model load time in nanoseconds (terminal chunk). */
  load_duration?: number
  /** Number of prompt tokens evaluated (terminal chunk). */
  prompt_eval_count?: number
  /** Prompt evaluation time in nanoseconds (terminal chunk). */
  prompt_eval_duration?: number
  /** Number of tokens generated (terminal chunk). */
  eval_count?: number
  /** Generation time in nanoseconds (terminal chunk). */
  eval_duration?: number
}

/** A non-streaming `/api/chat` response (single object with `done: true`). */
export interface OllamaChatResponse {
  /** Model that produced the response. */
  model?: string
  /** ISO-8601 timestamp the response was created. */
  created_at?: string
  /** The completed assistant message. */
  message?: {
    role?: 'assistant'
    content?: string
    thinking?: string
    images?: string[]
    tool_calls?: OllamaToolCall[]
  }
  /** Always `true` for a non-streaming response. */
  done?: boolean
  /** Why generation stopped. */
  done_reason?: 'stop' | 'load' | 'unload' | string
  /** Total request time in nanoseconds. */
  total_duration?: number
  /** Model load time in nanoseconds. */
  load_duration?: number
  /** Number of prompt tokens evaluated. */
  prompt_eval_count?: number
  /** Prompt evaluation time in nanoseconds. */
  prompt_eval_duration?: number
  /** Number of tokens generated. */
  eval_count?: number
  /** Generation time in nanoseconds. */
  eval_duration?: number
}

// ─── Helpers bag ──────────────────────────────────────────────────────────────

/**
 * Full translation-helper contract for the native Ollama battery. Extends the wire-shape-agnostic
 * {@link ChatHelpersCommon} (shared with the OpenAI battery) and adds the Ollama-WIRE-SPECIFIC
 * members: flat timeline-message rendering (`images[]` + `thinking`), string-only tool-call-result
 * rendering, and native-history assembly (`tool_name`, object-form tool-call `arguments`). There is
 * no streaming tool-call delta accumulator — native `/api/chat` emits whole `tool_calls` per chunk.
 */
export interface OllamaHelpers extends ChatHelpersCommon {
  /** Renders a timeline message into a native Ollama message (`images[]` + `thinking`). */
  renderOllamaTimelineMessage: (input: {
    message: Message
    selfIdentity: string
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<OllamaMessage>
  /** Renders a tool call's result into a native Ollama tool-role message body (string-only). */
  renderOllamaToolCallResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<string>
  /** Assembles the full native history (system prompt, buckets, timeline, thoughts) into messages. */
  buildOllamaHistory: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    messages: Iterable<Message>
    thoughts: Iterable<Thought>
    toolCalls: Iterable<ToolCall>
    tools: ToolRegistry
    renderedToolCallResults: Map<string, string>
    bucketOrder: ChatCompletionsBucketOrder
    selfIdentity: string
    thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
    replayCompatibility: ReadonlyArray<string>
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderOllamaToolCallResult: OllamaHelpers['renderOllamaToolCallResult']
    renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderOllamaTimelineMessage: OllamaHelpers['renderOllamaTimelineMessage']
    renderThought: ChatHelpersCommon['renderThought']
    filterThoughts: ChatHelpersCommon['filterThoughts']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<{
    messages: OllamaMessage[]
    reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
  }>
}

// ─── Adapter options ──────────────────────────────────────────────────────────

/**
 * Configuration options for the native Ollama `/api/chat` adapter.
 */
export interface OllamaAdapterOptions {
  // ADK control
  /** Bearer token for cloud Ollama (`https://ollama.com`). Omit for local (no auth). */
  apiKey?: string
  /**
   * Endpoint base URL. The adapter targets `<baseURL>/api/chat`. Defaults to
   * `http://localhost:11434` (local); cloud is `https://ollama.com`. Native Ollama is HTTP-only —
   * for a Unix-socket deployment, point this at an HTTP bridge (nginx `proxy_pass` / `socat`) or
   * inject a custom {@link OllamaAdapterOptions.fetch} instead.
   */
  baseURL?: string
  /** Custom HTTP headers sent with every request (override built defaults, including auth). */
  headers?: Record<string, string>
  /**
   * Custom `fetch` implementation. Use to reach a Unix-socket Ollama via a custom transport (e.g.
   * undici with a `unix:` socket path) — native Ollama is HTTP-only, so socket access is a
   * fetch/bridge concern, not an adapter option.
   */
  fetch?: typeof globalThis.fetch
  /** Whether to stream the response chunk by chunk. */
  stream?: boolean
  /** Idle timeout in milliseconds for the stream before aborting. */
  streamIdleTimeoutMs?: number
  /** Request timeout in milliseconds for API calls. */
  requestTimeoutMs?: number
  /** Configures request retry behavior. */
  retry?: ChatCompletionsRetryConfig
  /** Determines order of the system-prompt content buckets in history assembly. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Size of the model's token context window (the ADK guard, independent of `num_ctx`). */
  contextWindow?: number
  /** Unique identity label for the assistant instance. */
  selfIdentity?: string
  /** Determines which thoughts are surfaced back to the model. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** Tokenizer encoding configuration for token counting. */
  tokenEncoding?: TokenEncoding | null
  /** List of replay labels supported by the assistant. */
  replayCompatibility?: ReadonlyArray<string>
  /** Optional overrides for the Ollama translation helpers. */
  helpers?: Partial<OllamaHelpers>
  /** Backing store for `string` / `Uint8Array` tool returns; defaults to a per-dispatch in-memory store. */
  spoolStore?: SpoolStore
  /** Whether the executor acks automatically on a tool-call-free terminal answer. */
  autoAck?: boolean
  /** Policy for handling a {@link @nhtio/adk!Media} whose modality the Ollama wire cannot represent. */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy

  // Native /api/chat request body
  /** Required. The Ollama model name (e.g. `llama3.2`, `gpt-oss:120b` for cloud). */
  model: string
  /** Native reasoning control for thinking-capable models. */
  think?: OllamaThink
  /** Structured-output control: `'json'` or a JSON schema object. */
  format?: OllamaFormat
  /** Native sampling/runtime parameters, sent nested under the request body's `options` key. */
  options?: OllamaRuntimeOptions
  /** How long the model stays resident after the request (e.g. `'5m'`, `0` to unload). */
  keep_alive?: string | number
  /**
   * Observe the model's RAW response for each completed generation — fired once per terminal generation,
   * after the provider's reply is parsed but before the result is persisted, with the returned assistant
   * content (`rawText`), the residual `cleanedText`, and the extracted `reasoning` / `toolCalls`. Purely
   * observational (return value ignored, errors swallowed). Default absent. See
   * {@link RawGenerationObserverFn}.
   */
  onRawGeneration?: RawGenerationObserverFn
  /**
   * Observe the fully-assembled request this battery is about to POST TO Ollama — fired once per terminal
   * generation, the instant the body is built and BEFORE the fetch, with the wire `messages`, `tools`, and
   * the complete `requestBody`. The mirror of {@link onRawGeneration}. Purely observational (return value
   * ignored, errors swallowed). Default absent. The request is handed back AS-IS — no redaction — so treat
   * it as potentially sensitive if you persist it. See {@link PromptAssembledObserverFn}.
   */
  onPromptAssembled?: PromptAssembledObserverFn
  /**
   * OPTIONAL fallback parser for tool calls the provider's chat template did NOT return structurally.
   *
   * @remarks
   * Native `/api/chat` tool-calling is authoritative: when Ollama returns `message.tool_calls`, those are
   * used and this option is never consulted. But small models (Gemma, Phi, and others) frequently emit a
   * tool call in a surface form the server template does not recognize — `<call:name{…}`, a fenced
   * ```` ```json ```` block, `<tool_code…>`, or bare `name\nkey: value` — in which case the call arrives as
   * plain `message.content` and `tool_calls` is empty, silently dropping the call. This is a cross-model,
   * cross-weight reality, not a single-provider quirk.
   *
   * Set this to a parser family name (e.g. `'gemma'`), `'auto'` (try every bundled parser in priority
   * order), or a custom {@link ToolCallParserFn} to recover such calls from `content` ONLY when the provider
   * returned none. Recovered calls execute exactly like native ones. Default absent = disabled = today's
   * native-only behaviour (fully backward-compatible). Mirrors the on-device batteries' `toolCallParser`,
   * which parse from text unconditionally because those runtimes never return structured calls.
   */
  localToolCallParser?: ToolCallParserName | ToolCallParserFn
  /**
   * OPTIONAL hook to SHAPE the artifact-query tools forged from prior-turn SpooledArtifact results, before
   * they merge into the visible tool set.
   *
   * @remarks
   * When a prior tool returned a {@link @nhtio/adk!SpooledArtifact}, this battery forges that artifact class's
   * reader tools (via `ctor.forgeTools(ctx)`) so the model can read the handle. A JSON artifact forges ~14
   * readers (~2.4k tokens of tool schema) — an unsheddable floor on a tight window, because the forge happens
   * INSIDE the battery, downstream of any middleware subtractive pass. This hook lets the ASSEMBLER shape that
   * forged set: it receives the merged forged registry + the dispatch context and returns a (possibly narrowed)
   * registry, applied BEFORE the merge with `ctx.tools`. e.g. return only the core readers
   * (`artifact_head`, `artifact_json_get`) so a tight window fits; the rest stay reachable via
   * `tool_catalog`/`call_a_tool`. Default absent = identity (all forged tools) = fully backward-compatible.
   *
   * The battery stays BUDGET-AGNOSTIC (per the CONTRIBUTING size-threshold rule): it does NOT measure or
   * compare against `contextWindow` — it just applies whatever filter the assembler supplied. Any budget
   * logic lives in the caller's filter (middleware-side), which legitimately knows the turn's budget.
   */
  forgeToolsFilter?: (forged: ToolRegistry, ctx: DispatchContext) => ToolRegistry
}
