/**
 * TypeScript wire shapes, helper contracts, and option types for the OpenAI Responses battery.
 *
 * @module @nhtio/adk/batteries/llm/openai_responses/types
 *
 * @remarks
 * Type aliases for the OpenAI Responses adapter — wire shapes, helper input/output shapes, and the
 * adapter's options shape. These are documentation-level types only; runtime validation lives in
 * `validation.ts` (`openAIResponsesOptionsSchema`).
 *
 * The Responses API replaces the flat `messages[]` array with a flat `input: Item[]` array — a tool
 * call and its result are two SIBLING top-level items, not one message containing both. The system
 * prompt lives in a top-level `instructions` string field by default (or, via `systemPromptChannel`,
 * a leading `developer`/`system`-role item instead).
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
} from '../chat_common/types'
export type { ToolCallParserName, ToolCallParserFn } from '../chat_common/tool_parsers'

// ─── Input content blocks ──────────────────────────────────────────────────────

/**
 * Discriminated union of content block shapes accepted by the OpenAI Responses `input` item
 * content array (and, per the API reference, also the shape a `function_call_output.output` array
 * entry may take).
 *
 * @remarks
 * `input_audio` is deliberately absent — confirmed against the `openai` SDK's own type definitions
 * (`ResponseInputContent` has no audio member). Audio media routes through `unsupportedMediaPolicy`,
 * unlike `openai_chat_completions`.
 *
 * `input_file.file_data` uses a full `data:<mime>;base64,<b64>` data URI (not bare base64) —
 * confirmed via a live probe against the real Responses API (see the battery's design notes).
 * `filename` is required alongside `file_data`.
 */
export type OpenAIResponsesInputContentBlock =
  | { type: 'input_text'; text: string }
  | {
      type: 'input_image'
      detail: 'low' | 'high' | 'auto' | 'original'
      image_url?: string
      file_id?: string
    }
  | {
      type: 'input_file'
      filename?: string
      file_data?: string
      file_id?: string
      file_url?: string
      detail?: 'low' | 'high'
    }

// ─── Wire item types ────────────────────────────────────────────────────────────

/**
 * An input message item — the leading-content-channel item shape (`role: 'user'`, or the leading
 * `developer`/`system`-role item rendered when `systemPromptChannel` is not `'instructions'`, or a
 * trailing after-timeline bucket message), plus a peer-identity assistant timeline turn rendered as
 * a plain input message rather than the full output-item shape.
 *
 * @remarks
 * `role: 'assistant'` is included — the wire's shorthand `EasyInputMessage` form accepts it for a
 * plain, non-native-output assistant turn (distinct from {@link OpenAIResponsesOutputMessageItem},
 * which is the full native-output shape used only when replaying the model's OWN prior turn).
 */
export interface OpenAIResponsesMessageItem {
  /** Item discriminator. Optional on input items per the wire (defaults to `'message'`). */
  type?: 'message'
  /** The message's role. */
  role: 'user' | 'assistant' | 'system' | 'developer'
  /** Content blocks. */
  content: OpenAIResponsesInputContentBlock[]
  /** Optional item id. */
  id?: string
}

/** One output-message content part. */
export type OpenAIResponsesOutputMessageContentPart =
  | { type: 'output_text'; text: string; annotations: unknown[] }
  | { type: 'refusal'; refusal: string }

/**
 * An assistant output-message item, in the OUTPUT shape (not the input shape) — used when
 * replaying the ADK's OWN prior assistant text back into `input`, so the reasoning-pairing
 * validator (see the Known Gotchas) recognizes it correctly as a genuine prior output item.
 */
export interface OpenAIResponsesOutputMessageItem {
  /** Item discriminator; always `'message'` for an output message. */
  type: 'message'
  /** Always `'assistant'` on an output-shaped message item. */
  role: 'assistant'
  /** Present on replay (`'completed'`); the live streaming path observes richer statuses. */
  status?: 'completed' | 'incomplete' | 'in_progress'
  /** The item's id, as assigned by the provider. */
  id?: string
  /** The message's output content parts (text and/or refusal). */
  content: OpenAIResponsesOutputMessageContentPart[]
}

/** A model-emitted function (tool) call item. */
export interface OpenAIResponsesFunctionCallItem {
  /** Item discriminator; always `'function_call'`. */
  type: 'function_call'
  /** Correlates this call with its sibling `function_call_output` item. */
  call_id: string
  /** The tool name the model called. */
  name: string
  /** The JSON-encoded arguments string. */
  arguments: string
  /** Item id (distinct from `call_id`) — present on real provider-emitted items. */
  id?: string
  /** Lifecycle status of the call item. */
  status?: 'completed' | 'in_progress' | 'incomplete'
}

/** The result of executing a `function_call_output`'s paired `function_call`. */
export interface OpenAIResponsesFunctionCallOutputItem {
  /** Item discriminator; always `'function_call_output'`. */
  type: 'function_call_output'
  /** Correlates this result with its sibling `function_call` item. */
  call_id: string
  /** The tool result — a plain string, or (per the API reference) an array of content blocks. */
  output: string | OpenAIResponsesInputContentBlock[]
  /** Item id, as assigned by the provider. */
  id?: string
  /** Lifecycle status of the output item. */
  status?: 'completed' | 'in_progress' | 'incomplete'
}

/** One summary-text part of a `reasoning` item. */
export interface OpenAIResponsesReasoningSummaryPart {
  /** Part discriminator; always `'summary_text'`. */
  type: 'summary_text'
  /** The summarized reasoning text. */
  text: string
}

/** One full-reasoning-text part of a `reasoning` item (present only under some `include` values). */
export interface OpenAIResponsesReasoningContentPart {
  /** Part discriminator; always `'reasoning_text'`. */
  type: 'reasoning_text'
  /** The unsummarized reasoning text. */
  text: string
}

/**
 * A model-emitted `reasoning` item — the native wire representation of a "thought." Only ever sent
 * back on `input` when `reasoningReplay !== 'off'` and its stored signature/prefix-fingerprint is
 * still valid; see the reasoning-pairing adjacency-sweep pass and Known Gotcha #1.
 */
export interface OpenAIResponsesReasoningItem {
  /** Item discriminator; always `'reasoning'`. */
  type: 'reasoning'
  /** Item id, used to correlate this reasoning item with adjacent output items on replay. */
  id: string
  /** Ordered summary-text parts for this reasoning item. */
  summary: OpenAIResponsesReasoningSummaryPart[]
  /** Ordered full-reasoning-text parts, present only under some `include` values. */
  content?: OpenAIResponsesReasoningContentPart[]
  /** Opaque, provider-signed reasoning payload. Present only when `include` requested it. */
  encrypted_content?: string | null
  /** Lifecycle status of the reasoning item. */
  status?: 'completed' | 'in_progress' | 'incomplete'
}

/**
 * Any other output item type the Responses API can emit that this battery does not natively
 * model (hosted server-side tools: `web_search_call`, `code_interpreter_call`, `mcp_call`, etc.).
 * Carried through structurally so the streaming state machine can recognize — and deliberately
 * decline to open a slot for — an item type it does not know, per Known Gotcha #6.
 */
export interface OpenAIResponsesOpaqueOutputItem {
  /** The provider's item-type discriminator, not one this battery recognizes structurally. */
  type: string
  /** Item id, as assigned by the provider, when present. */
  id?: string
  [key: string]: unknown
}

/** Discriminated union of every item shape this battery sends on the `input` array. */
export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesOutputMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem
  | OpenAIResponsesReasoningItem

/** Discriminated union of every item shape the Responses API can emit in `response.output`. */
export type OpenAIResponsesOutputItem =
  | OpenAIResponsesOutputMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesReasoningItem
  | OpenAIResponsesOpaqueOutputItem

// ─── Tool declaration / tool-choice ────────────────────────────────────────────

/**
 * Wire shape of a single function tool advertised to the model. `name` is TOP-LEVEL, unlike Chat
 * Completions' `{type:'function', function:{name, ...}}` nesting.
 */
export type OpenAIResponsesTool = {
  /** Tool-kind discriminator; always `'function'` for this battery's v1. */
  type: 'function'
  /** The tool's name, as the model will reference it in a `function_call` item. */
  name: string
  /** Human-readable description of what the tool does, shown to the model. */
  description?: string | null
  /** JSON Schema describing the tool's accepted arguments. */
  parameters: JsonSchema | null
  /** Whether the provider should enforce strict schema adherence for this tool's arguments. */
  strict?: boolean | null
}

/** Tool-choice directive accepted by this battery's v1 (a subset of the full wire union). */
export type OpenAIResponsesToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; name: string }

// ─── Usage / response object (non-streaming + terminal streaming event) ───────

/** Token-usage accounting on a Responses `response` object. */
export interface OpenAIResponsesUsage {
  /** Number of tokens in the request input. */
  input_tokens?: number
  /** Breakdown of the input token count, e.g. how many were served from cache. */
  input_tokens_details?: { cached_tokens?: number }
  /** Number of tokens generated in the response. */
  output_tokens?: number
  /** Breakdown of the output token count, e.g. how many were spent on reasoning. */
  output_tokens_details?: { reasoning_tokens?: number }
  /** Total tokens (input + output) accounted for by this usage record. */
  total_tokens?: number
}

/** The full `response` object — returned directly (non-streaming), or nested under a terminal streaming event. */
export interface OpenAIResponsesResponseObject {
  /** The response's unique identifier. */
  id?: string
  /** Object-type discriminator, typically `'response'`. */
  object?: string
  /** Unix timestamp (seconds) when the response was created. */
  created_at?: number
  /** Terminal or in-flight lifecycle status of the response. */
  status?: 'completed' | 'incomplete' | 'failed' | 'in_progress' | 'cancelled' | 'queued'
  /** The model that generated the response. */
  model?: string
  /** The ordered output items the model produced. */
  output?: OpenAIResponsesOutputItem[]
  /** Convenience concatenation of the response's output text, when the provider supplies it. */
  output_text?: string
  /** Token-usage accounting for this response. */
  usage?: OpenAIResponsesUsage
  /** Present when `status` is `'incomplete'`; explains why generation stopped early. */
  incomplete_details?: { reason?: string } | null
  /** Present when `status` is `'failed'`; the provider's error details. */
  error?: { code?: string; message?: string; type?: string } | null
  [key: string]: unknown
}

// ─── Streaming events ──────────────────────────────────────────────────────────

interface OpenAIResponsesStreamEventBase {
  /** The event's type discriminator. */
  type: string
  /** Monotonically increasing sequence number for this event within the stream. */
  sequence_number?: number
}

/** SSE event emitted when a new output item is opened (streaming begins for that item). */
export interface OpenAIResponsesOutputItemAddedEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.output_item.added'`. */
  type: 'response.output_item.added'
  /** The index of the newly-opened item within `response.output`. */
  output_index: number
  /** The item as it stood at the moment it was opened (fields fill in as later deltas arrive). */
  item: OpenAIResponsesOutputItem
}

/** SSE event emitted when an output item is finalized — its terminal, fully-populated shape. */
export interface OpenAIResponsesOutputItemDoneEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.output_item.done'`. */
  type: 'response.output_item.done'
  /** The index of the finalized item within `response.output`. */
  output_index: number
  /** The fully-populated item. */
  item: OpenAIResponsesOutputItem
}

/** SSE event emitted when a text fragment streams in for an output message's content. */
export interface OpenAIResponsesOutputTextDeltaEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.output_text.delta'`. */
  type: 'response.output_text.delta'
  /** The id of the output-message item this delta belongs to. */
  item_id: string
  /** The index of the output-message item within `response.output`. */
  output_index: number
  /** The index of the content part within the item's `content` array. */
  content_index: number
  /** The incremental text fragment to append. */
  delta: string
}

/** SSE event emitted when an output message's text content part is finalized. */
export interface OpenAIResponsesOutputTextDoneEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.output_text.done'`. */
  type: 'response.output_text.done'
  /** The id of the output-message item this text belongs to. */
  item_id: string
  /** The index of the output-message item within `response.output`. */
  output_index: number
  /** The index of the content part within the item's `content` array. */
  content_index: number
  /** The complete, finalized text. */
  text: string
}

/** SSE event emitted when a refusal fragment streams in for an output message's content. */
export interface OpenAIResponsesRefusalDeltaEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.refusal.delta'`. */
  type: 'response.refusal.delta'
  /** The id of the output-message item this delta belongs to. */
  item_id: string
  /** The index of the output-message item within `response.output`. */
  output_index: number
  /** The index of the content part within the item's `content` array. */
  content_index: number
  /** The incremental refusal-text fragment to append. */
  delta: string
}

/** SSE event emitted when an output message's refusal content part is finalized. */
export interface OpenAIResponsesRefusalDoneEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.refusal.done'`. */
  type: 'response.refusal.done'
  /** The id of the output-message item this refusal belongs to. */
  item_id: string
  /** The index of the output-message item within `response.output`. */
  output_index: number
  /** The index of the content part within the item's `content` array. */
  content_index: number
  /** The complete, finalized refusal text. */
  refusal: string
}

/** SSE event emitted when a reasoning-summary text fragment streams in for a `reasoning` item. */
export interface OpenAIResponsesReasoningSummaryTextDeltaEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.reasoning_summary_text.delta'`. */
  type: 'response.reasoning_summary_text.delta'
  /** The id of the reasoning item this delta belongs to. */
  item_id: string
  /** The index of the reasoning item within `response.output`. */
  output_index: number
  /** The index of the summary part within the item's `summary` array. */
  summary_index: number
  /** The incremental summary-text fragment to append. */
  delta: string
}

/** SSE event emitted when a `reasoning` item's summary-text part is finalized. */
export interface OpenAIResponsesReasoningSummaryTextDoneEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.reasoning_summary_text.done'`. */
  type: 'response.reasoning_summary_text.done'
  /** The id of the reasoning item this summary belongs to. */
  item_id: string
  /** The index of the reasoning item within `response.output`. */
  output_index: number
  /** The index of the summary part within the item's `summary` array. */
  summary_index: number
  /** The complete, finalized summary text. */
  text: string
}

/** SSE event emitted when a full-reasoning text fragment streams in for a `reasoning` item. */
export interface OpenAIResponsesReasoningTextDeltaEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.reasoning_text.delta'`. */
  type: 'response.reasoning_text.delta'
  /** The id of the reasoning item this delta belongs to. */
  item_id: string
  /** The index of the reasoning item within `response.output`. */
  output_index: number
  /** The index of the content part within the item's `content` array. */
  content_index: number
  /** The incremental reasoning-text fragment to append. */
  delta: string
}

/** SSE event emitted when a `reasoning` item's full-reasoning-text part is finalized. */
export interface OpenAIResponsesReasoningTextDoneEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.reasoning_text.done'`. */
  type: 'response.reasoning_text.done'
  /** The id of the reasoning item this text belongs to. */
  item_id: string
  /** The index of the reasoning item within `response.output`. */
  output_index: number
  /** The index of the content part within the item's `content` array. */
  content_index: number
  /** The complete, finalized reasoning text. */
  text: string
}

/** SSE event emitted when a fragment of a tool call's JSON arguments streams in. */
export interface OpenAIResponsesFunctionCallArgumentsDeltaEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.function_call_arguments.delta'`. */
  type: 'response.function_call_arguments.delta'
  /** The id of the function-call item this delta belongs to. */
  item_id: string
  /** The index of the function-call item within `response.output`. */
  output_index: number
  /** The incremental arguments-string fragment to append. */
  delta: string
}

/** SSE event emitted when a tool call's JSON arguments string is finalized. */
export interface OpenAIResponsesFunctionCallArgumentsDoneEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.function_call_arguments.done'`. */
  type: 'response.function_call_arguments.done'
  /** The id of the function-call item this arguments string belongs to. */
  item_id: string
  /** The index of the function-call item within `response.output`. */
  output_index: number
  /** The complete, finalized JSON-encoded arguments string. This REPLACES, never merges with, prior deltas. */
  arguments: string
}

/** Terminal SSE event emitted when the response completes successfully. */
export interface OpenAIResponsesCompletedEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.completed'`. */
  type: 'response.completed'
  /** The full, terminal response object. */
  response: OpenAIResponsesResponseObject
}

/** Terminal SSE event emitted when the response stops before completing (e.g. hit `max_output_tokens`). */
export interface OpenAIResponsesIncompleteEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.incomplete'`. */
  type: 'response.incomplete'
  /** The full response object, with `incomplete_details` explaining why it stopped early. */
  response: OpenAIResponsesResponseObject
}

/** Terminal SSE event emitted when the response fails outright. */
export interface OpenAIResponsesFailedEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'response.failed'`. */
  type: 'response.failed'
  /** The full response object, with `error` describing the failure. */
  response: OpenAIResponsesResponseObject
}

/** Terminal SSE event emitted when the stream itself errors, outside of any particular response object. */
export interface OpenAIResponsesErrorEvent extends OpenAIResponsesStreamEventBase {
  /** Event-type discriminator; always `'error'`. */
  type: 'error'
  /** Provider-defined machine-readable error code, when available. */
  code?: string | null
  /** Human-readable error message. */
  message: string
  /** The request parameter the error relates to, when applicable. */
  param?: string | null
}

/**
 * Discriminated union of every streaming event this battery handles explicitly, plus a structural
 * fallback (`{type: string, ...}`) for the many other event types the Responses API emits
 * (`response.created`, `response.in_progress`, `response.content_part.added/.done`, hosted-tool
 * progress events, etc.) that this battery does not act on.
 */
export type OpenAIResponsesStreamEvent =
  | OpenAIResponsesOutputItemAddedEvent
  | OpenAIResponsesOutputItemDoneEvent
  | OpenAIResponsesOutputTextDeltaEvent
  | OpenAIResponsesOutputTextDoneEvent
  | OpenAIResponsesRefusalDeltaEvent
  | OpenAIResponsesRefusalDoneEvent
  | OpenAIResponsesReasoningSummaryTextDeltaEvent
  | OpenAIResponsesReasoningSummaryTextDoneEvent
  | OpenAIResponsesReasoningTextDeltaEvent
  | OpenAIResponsesReasoningTextDoneEvent
  | OpenAIResponsesFunctionCallArgumentsDeltaEvent
  | OpenAIResponsesFunctionCallArgumentsDoneEvent
  | OpenAIResponsesCompletedEvent
  | OpenAIResponsesIncompleteEvent
  | OpenAIResponsesFailedEvent
  | OpenAIResponsesErrorEvent
  | (OpenAIResponsesStreamEventBase & Record<string, unknown>)

// ─── Output-slot state machine ─────────────────────────────────────────────────

/** A streaming text (assistant output-message) slot. */
export interface ResponsesTextSlot {
  /** Slot-kind discriminator; always `'text'`. */
  kind: 'text'
  /** The id of the output-message item this slot accumulates. */
  itemId: string
  /** Accumulated output text so far. */
  text: string
  /** Accumulated refusal text so far. */
  refusal: string
}

/** A streaming reasoning ("thinking") slot. */
export interface ResponsesThinkingSlot {
  /** Slot-kind discriminator; always `'thinking'`. */
  kind: 'thinking'
  /** The id of the reasoning item this slot accumulates. */
  itemId: string
  /** Accumulated reasoning-summary text so far. */
  summaryText: string
  /** Accumulated full-reasoning text so far. */
  reasoningText: string
  /** The opaque, provider-signed reasoning payload, once captured on finalization. */
  encryptedContent?: string
}

/** A streaming tool-call slot. */
export interface ResponsesToolCallSlot {
  /** Slot-kind discriminator; always `'toolCall'`. */
  kind: 'toolCall'
  /** The id of the function-call item this slot accumulates. */
  itemId: string
  /** Correlates this call with its sibling `function_call_output` item. */
  callId: string
  /** The tool name the model called. */
  name: string
  /** Accumulated (or authoritatively replaced) JSON-encoded arguments string so far. */
  args: string
}

/** Union of every tracked per-`output_index` slot kind. */
export type ResponsesOutputSlot = ResponsesTextSlot | ResponsesThinkingSlot | ResponsesToolCallSlot

/**
 * Per-dispatch streaming-state accumulator, keyed by `output_index` (one slot per output item —
 * NOT a tool-call `index`, unlike Chat Completions). Constructed fresh per generation via
 * {@link OpenAIResponsesHelpers.createResponsesOutputSlotMachine}.
 */
export interface ResponsesOutputSlotMachine {
  /** Opens a slot for `outputIndex` from a `response.output_item.added` event's `item`. Unknown/hosted item types open no slot and return `undefined`. */
  openSlot(outputIndex: number, item: OpenAIResponsesOutputItem): ResponsesOutputSlot | undefined
  /** Returns the slot at `outputIndex`, if one is open. */
  getSlot(outputIndex: number): ResponsesOutputSlot | undefined
  /** Appends an `output_text` delta to the text slot at `outputIndex`. */
  appendText(outputIndex: number, delta: string): void
  /** Appends a `refusal` delta to the text slot at `outputIndex`. */
  appendRefusal(outputIndex: number, delta: string): void
  /** Appends a `reasoning_summary_text` delta to the thinking slot at `outputIndex`. */
  appendReasoningSummary(outputIndex: number, delta: string): void
  /** Appends a `reasoning_text` delta to the thinking slot at `outputIndex`. */
  appendReasoningText(outputIndex: number, delta: string): void
  /** Appends a `function_call_arguments` delta to the tool-call slot at `outputIndex`. */
  appendFunctionCallArgumentsDelta(outputIndex: number, delta: string): void
  /** Authoritatively REPLACES (never merges) the tool-call slot's `args` at `outputIndex`. */
  setFunctionCallArgumentsDone(outputIndex: number, args: string): void
  /** Finalizes the slot at `outputIndex` from a `response.output_item.done` event's `item` — the ONLY point at which a reasoning item's `encrypted_content`/signature is captured. */
  finalizeSlot(outputIndex: number, item: OpenAIResponsesOutputItem): void
  /** Backfills `encryptedContent` on the thinking slot at `outputIndex` from the terminal event's `response.output`, when `.done` omitted it. */
  backfillEncryptedContent(outputIndex: number, encryptedContent: string): void
  /** Returns every currently tracked slot, keyed by `output_index`. */
  slots(): ReadonlyMap<number, ResponsesOutputSlot>
}

// ─── Reasoning replay ───────────────────────────────────────────────────────────

/**
 * Opaque payload stored on a replayable OpenAI Responses reasoning `Thought`. Sibling to the
 * Anthropic battery's `AnthropicThinkingReplayPayload`.
 */
export interface OpenAIResponsesReasoningReplayPayload {
  /** Payload variant discriminator; always `'responses-reasoning'`. */
  variant: 'responses-reasoning'
  /** The reasoning item exactly as the provider emitted it. */
  item: OpenAIResponsesReasoningItem
  /** The id of the item that immediately followed this reasoning item in `response.output`. */
  pairedItemId: string | undefined
  /** Stable fingerprint of the signed conversation prefix. */
  prefixFingerprint: string
}

/** Reasoning-replay mode. See {@link OpenAIResponsesAdapterOptions.reasoningReplay}. */
export type ReasoningReplayMode = 'off' | 'encrypted' | 'summary-only'

/** Channel the ADK-rendered system prompt is placed on. See {@link OpenAIResponsesAdapterOptions.systemPromptChannel}. */
export type SystemPromptChannel = 'instructions' | 'developer-item' | 'system-item'

// ─── Request body ──────────────────────────────────────────────────────────────

/** Value(s) requestable via the wire `include` array. */
export type OpenAIResponsesIncludable =
  | 'reasoning.encrypted_content'
  | 'message.output_text.logprobs'
  | (string & {})

/**
 * The WIRE body shape this battery constructs and sends — not a 1:1 mirror of consumer-settable
 * options. `instructions` and `store` are ALWAYS adapter-computed; neither is a key on
 * {@link OpenAIResponsesAdapterOptions}.
 */
export interface OpenAIResponsesRequestBody {
  /** ID of the model to use for generation. */
  model: string
  /** The flat array of input items — messages, tool calls/results, and reasoning items. */
  input: OpenAIResponsesInputItem[]
  /** If set, partial output deltas are sent as server-sent events. */
  stream: boolean
  /** ALWAYS ADK-rendered; never a consumer-settable option. */
  instructions?: string
  /** ALWAYS `false` — this adapter is stateless; see the battery's design notes. */
  store: false
  /** Additional output data requested from the model, e.g. `'reasoning.encrypted_content'`. */
  include?: OpenAIResponsesIncludable[]
  /** Function-tool definitions the model may call. */
  tools?: OpenAIResponsesTool[]
  /** Tool-choice directive constraining which (if any) tool the model may call. */
  tool_choice?: OpenAIResponsesToolChoice
  /** Reasoning-effort / summary configuration for reasoning-capable models. */
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    summary?: 'auto' | 'concise' | 'detailed'
  }
  /** Hard limit on the number of generated output tokens. */
  max_output_tokens?: number
  /** Allow the model to emit multiple tool calls in one turn. */
  parallel_tool_calls?: boolean
  /** Sampling temperature control. */
  temperature?: number
  /** Nucleus sampling probability threshold. */
  top_p?: number
  /** Top log-probability tokens limit. */
  top_logprobs?: number
  /** Context-truncation strategy. */
  truncation?: 'auto' | 'disabled'
  /** Service reliability tier for processing the request. */
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority'
  /** Vendor cache key for caching prefix content. */
  prompt_cache_key?: string
  /** Cache retention strategy for cached prefix content. */
  prompt_cache_retention?: 'in_memory' | '24h'
  /** Unique safety system identifier or configuration id. */
  safety_identifier?: string
  /** Metadata key-value pairs forwarded to the provider. */
  metadata?: Record<string, string>
  /** Structured-output format / verbosity configuration. */
  text?: { format?: Record<string, unknown>; verbosity?: 'low' | 'medium' | 'high' }
  /** Request the generation run in the background (async). */
  background?: boolean
  /** Configuration options for response streaming. */
  stream_options?: { include_obfuscation?: boolean }
  [key: string]: unknown
}

// ─── Helpers bag ────────────────────────────────────────────────────────────────

/**
 * Full translation-helper contract for the OpenAI Responses battery.
 */
export interface OpenAIResponsesHelpers extends ChatHelpersCommon {
  /** Renders one ADK media value into Responses content blocks. */
  renderOpenAIResponsesMediaBlocks: (input: {
    media: Media
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<OpenAIResponsesInputContentBlock[]>
  /** Renders an ADK timeline message into a Responses input message item. */
  renderOpenAIResponsesTimelineMessage: (input: {
    message: Message
    selfIdentity: string
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderOpenAIResponsesMediaBlocks: OpenAIResponsesHelpers['renderOpenAIResponsesMediaBlocks']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<OpenAIResponsesInputItem | null>
  /** Renders a tool call's result into a `function_call_output` item's `output`. */
  renderOpenAIResponsesToolCallResult: (input: {
    toolCall: ToolCall
    results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
    tool: Tool | ArtifactTool | undefined
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    renderOpenAIResponsesMediaBlocks: OpenAIResponsesHelpers['renderOpenAIResponsesMediaBlocks']
    renderArtifactHandleBody?: ChatHelpersCommon['renderArtifactHandleBody']
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    warn?: (msg: string) => void
  }) => Promise<string | OpenAIResponsesInputContentBlock[]>
  /** Translates the ADK tool registry into Responses function-tool definitions (`name` top-level). */
  toolsToOpenAIResponsesTools: (
    tools: ReadonlyArray<Tool | ArtifactTool>,
    deps: { descriptionToChatCompletionsJsonSchema: (d: unknown) => JsonSchema; strict?: boolean }
  ) => OpenAIResponsesTool[]
  /** Computes the fingerprint used to gate reasoning-item replay. */
  fingerprintOpenAIResponsesPrefix: (input: {
    model: string
    instructions?: string
    tools?: OpenAIResponsesTool[]
    input: OpenAIResponsesInputItem[]
    throughItem?: number
  }) => Promise<string>
  /** Converts an eligible stored reasoning-replay payload into a wire `reasoning` item, or `undefined` if ineligible. */
  renderOpenAIResponsesReasoningItem: (input: {
    thought: Thought
    prefixFingerprint: string
    replayCompatibility: ReadonlyArray<string>
    reasoningReplay: ReasoningReplayMode
    warn?: (msg: string) => void
  }) => OpenAIResponsesReasoningItem | undefined
  /** Assembles the full Responses `input` array, `instructions`, and `tools`, including the reasoning-pairing enforcement pass. */
  buildOpenAIResponsesInput: (input: {
    model: string
    systemPrompt: Tokenizable
    /**
     * Live dispatch context used to resolve a DYNAMIC `systemPrompt` via `.render(ctx)`. Forwarded
     * to `renderChatCompletionsSystemPrompt`, whose own `renderCtx` seam exists for this. Without
     * it a context-reading system prompt renders against `undefined` and silently loses whatever
     * it was reading.
     */
    renderCtx?: unknown
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    messages: Iterable<Message>
    thoughts: Iterable<Thought>
    toolCalls: Iterable<ToolCall>
    tools: ToolRegistry
    strict?: boolean
    renderedToolCallResults: Map<string, string | OpenAIResponsesInputContentBlock[]>
    bucketOrder: ChatCompletionsBucketOrder
    selfIdentity: string
    thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
    replayCompatibility: ReadonlyArray<string>
    reasoningReplay: ReasoningReplayMode
    systemPromptChannel: SystemPromptChannel
    unsupportedMediaPolicy: UnsupportedMediaPolicy
    renderOpenAIResponsesToolCallResult: OpenAIResponsesHelpers['renderOpenAIResponsesToolCallResult']
    renderOpenAIResponsesMediaBlocks: OpenAIResponsesHelpers['renderOpenAIResponsesMediaBlocks']
    renderChatCompletionsSystemPrompt: ChatHelpersCommon['renderChatCompletionsSystemPrompt']
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderRetrievableHandleBody?: ChatHelpersCommon['renderRetrievableHandleBody']
    renderOpenAIResponsesTimelineMessage: OpenAIResponsesHelpers['renderOpenAIResponsesTimelineMessage']
    renderOpenAIResponsesReasoningItem: OpenAIResponsesHelpers['renderOpenAIResponsesReasoningItem']
    fingerprintOpenAIResponsesPrefix: OpenAIResponsesHelpers['fingerprintOpenAIResponsesPrefix']
    toolsToOpenAIResponsesTools: OpenAIResponsesHelpers['toolsToOpenAIResponsesTools']
    descriptionToChatCompletionsJsonSchema: ChatHelpersCommon['descriptionToChatCompletionsJsonSchema']
    renderThought: ChatHelpersCommon['renderThought']
    filterThoughts: ChatHelpersCommon['filterThoughts']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    renderTrustedContent: ChatHelpersCommon['renderTrustedContent']
    warn?: (msg: string) => void
  }) => Promise<{
    instructions?: string
    input: OpenAIResponsesInputItem[]
    tools?: OpenAIResponsesTool[]
    /**
     * Number of leading `input` items that make up the FINGERPRINTABLE region — everything the
     * reasoning-pairing adjacency sweep can see, i.e. `input` minus any trailing-bucket item
     * appended after the sweep has already run.
     *
     * Reasoning-replay fingerprints must be computed over this slice, never over the whole
     * `input`. The sweep validates a replayed item against a prefix of the items it saw, so a
     * persist-side hash that also covered a trailing bucket could never match on the next turn,
     * and every replayed reasoning item would be dropped as stale. Equal to `input.length` when
     * no trailing bucket was emitted (the default `bucketOrder`, which ends in `'timeline'`).
     */
    fingerprintableLength: number
  }>
  /** Instantiates a new streaming output-slot state machine. */
  createResponsesOutputSlotMachine: () => ResponsesOutputSlotMachine
}

// ─── Adapter options ────────────────────────────────────────────────────────────

/**
 * Configuration options for the OpenAI Responses adapter.
 */
export interface OpenAIResponsesAdapterOptions {
  // ADK control
  /** API key for authenticating requests. */
  apiKey?: string
  /** Base URL for the OpenAI-compatible Responses endpoint. */
  baseURL?: string
  /** Optional OpenAI organization id, sent as `OpenAI-Organization`. */
  organization?: string
  /** Optional OpenAI project id, sent as `OpenAI-Project`. */
  project?: string
  /** Extra HTTP headers to include with each request. */
  headers?: Record<string, string>
  /** Whether to stream the response via SSE. */
  stream?: boolean
  /** Idle timeout in milliseconds for the stream before aborting. */
  streamIdleTimeoutMs?: number
  /** Request timeout in milliseconds for API calls. */
  requestTimeoutMs?: number
  /** Configures request retry behavior. */
  retry?: ChatCompletionsRetryConfig
  /** Custom fetch implementation to use for HTTP requests. */
  fetch?: typeof globalThis.fetch
  /** Determines order of memory and retrievable buckets in history assembly. */
  bucketOrder?: ChatCompletionsBucketOrder
  /** Size of the model's token context window. */
  contextWindow?: number
  /** Unique identity label for the assistant instance. */
  selfIdentity?: string
  /** Determines which thoughts are surfaced back to the model. */
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  /** Tokenizer encoding configuration for token counting. */
  tokenEncoding?: TokenEncoding | null
  /** List of replay labels supported by the assistant. */
  replayCompatibility?: ReadonlyArray<string>
  /** Optional overrides for OpenAI Responses helpers. */
  helpers?: Partial<OpenAIResponsesHelpers>
  /** Backing store for `string` / `Uint8Array` tool returns. */
  spoolStore?: SpoolStore
  /** Whether a `tool_choice` forcing a forged ephemeral artifact-query tool throws instead of warning. */
  strictToolChoice?: boolean
  /** Whether the executor should call `ctx.ack()` itself when a generation completes with no tool calls. */
  autoAck?: boolean
  /** Policy for a {@link @nhtio/adk!Media} instance whose modality this wire cannot represent (audio, video). */
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  /** Observe the model's raw response for each completed generation. */
  onRawGeneration?: RawGenerationObserverFn
  /** Observe the fully-assembled request before dispatch. */
  onPromptAssembled?: PromptAssembledObserverFn
  /** Optional fallback parser for tool calls the provider did not return structurally. */
  localToolCallParser?: ToolCallParserName | ToolCallParserFn
  /** Optional hook to shape forged artifact-query tools before they merge into the visible tool set. */
  forgeToolsFilter?: (forged: ToolRegistry, ctx: DispatchContext) => ToolRegistry

  // Responses-specific ADK control
  /**
   * Where the ADK-rendered system prompt is placed on the wire.
   *
   * @remarks
   * `'instructions'` (default) — the top-level `instructions` string field. `'developer-item'` /
   * `'system-item'` — a leading `developer`/`system`-role input message item instead, for gateways
   * that only understand the item form. Either way the CONTENT is always ADK-rendered; there is no
   * consumer-facing escape hatch to hand-author it directly (see the `instructions` note below).
   *
   * @defaultValue `'instructions'`
   */
  systemPromptChannel?: SystemPromptChannel
  /**
   * Reasoning-replay mode.
   *
   * @remarks
   * `'off'` (default) — thoughts never replay as native `reasoning` items; they render as plain
   * text instead. `'encrypted'` — replay signed reasoning items, auto-adding
   * `'reasoning.encrypted_content'` to `include`. `'summary-only'` — replay reasoning items without
   * requesting the encrypted payload.
   *
   * This is real, scoped, stateful machinery (persisted opaque payloads, prefix-fence fingerprinting,
   * adjacency enforcement, item-id manipulation) — see the battery's design notes for the
   * reasoning/output-item pairing hazard this default guards against.
   *
   * @defaultValue `'off'`
   */
  reasoningReplay?: ReasoningReplayMode
  /**
   * Global `strict` default forwarded to every emitted tool declaration's `strict` field, when the
   * caller hasn't already got a reason not to (kept `undefined` by default since `strict: true`
   * requires `additionalProperties: false` and full `required` coverage that ADK's Joi-derived
   * schemas don't guarantee).
   */
  strict?: boolean

  // Wire body (spread through, minus ADK-control keys)
  /** Name of the model to use for generation. REQUIRED. */
  model: string
  /**
   * Additional output data requested from the model.
   *
   * @remarks
   * `'reasoning.encrypted_content'` is auto-added when `reasoningReplay === 'encrypted'`; a caller
   * value does not need to repeat it (de-duplicated).
   */
  include?: OpenAIResponsesIncludable[]
  /** Reasoning-effort / summary configuration for reasoning-capable models. */
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    summary?: 'auto' | 'concise' | 'detailed'
  }
  /**
   * Hard limit on generated output tokens.
   *
   * @remarks
   * The API enforces an UNDOCUMENTED minimum of 16 (`400 Invalid 'max_output_tokens'... Expected a
   * value >= 16`) — enforced in this battery's validation schema so a too-small value fails at
   * config time, not dispatch time.
   */
  max_output_tokens?: number
  /** Allow the model to emit multiple tool calls in one turn. */
  parallel_tool_calls?: boolean
  /** Sampling temperature control. */
  temperature?: number
  /** Nucleus sampling probability threshold. */
  top_p?: number
  /** Top log-probability tokens limit. */
  top_logprobs?: number
  /** Context-truncation strategy. */
  truncation?: 'auto' | 'disabled'
  /** Service reliability tier for processing the request. */
  service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority'
  /** Vendor cache key for caching system/prefix content. */
  prompt_cache_key?: string
  /** Cache retention strategy for cached prefix content. */
  prompt_cache_retention?: 'in_memory' | '24h'
  /** Unique safety system identifier or configuration id. */
  safety_identifier?: string
  /** Metadata key-value pairs forwarded to the provider. */
  metadata?: Record<string, string>
  /** Tool-choice directive. */
  tool_choice?: OpenAIResponsesToolChoice
  /** Structured-output format / verbosity configuration. */
  text?: { format?: Record<string, unknown>; verbosity?: 'low' | 'medium' | 'high' }
  /**
   * Request the generation run in the background (async). NOT SUPPORTED — this adapter has no
   * polling/resumption logic for a `queued`/`in_progress` background response, so `true` is
   * rejected at validation time (`E_INVALID_OPENAI_RESPONSES_OPTIONS`) rather than silently treated
   * as a completed, empty answer. `false`/`undefined` (the default, synchronous request/response)
   * are unaffected.
   */
  background?: boolean
  /** Configuration options for response streaming. */
  stream_options?: { include_obfuscation?: boolean }
}
