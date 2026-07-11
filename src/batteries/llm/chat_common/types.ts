/**
 * Wire-shape-agnostic TypeScript types shared across the Chat-family LLM batteries.
 *
 * @remarks
 * This module is INTERNAL to the bundled LLM batteries and is intentionally **not** tagged with
 * an `@module` JSDoc directive — `bin/utils/index.ts` `getEntries` only mints a public package
 * subpath for files that carry such a tag, so a tagless file stays private and is inlined into
 * each consumer by the bundler (the same way `src/lib/utils/retry.ts` is shared, minus the public
 * subpath). It holds the type aliases that the OpenAI Chat Completions battery and the native
 * Ollama battery both need: the validator-description envelope, the JSON Schema subset, the
 * trust-/memory-/retrievable-/thought-attribute envelopes, the system-prompt bucket ordering, the
 * function-tool wire shape, the unsupported-media policy, the retry config, and the
 * {@link ChatHelpersCommon} contract for the wire-shape-agnostic translation helpers.
 *
 * Battery-specific wire shapes (OpenAI Chat Completions message/chunk/response objects, the Ollama
 * native message/chunk objects) live in each battery's own `types.ts`, not here.
 */

import type { ParsedToolCall } from './tool_parsers'
import type {
  Tokenizable,
  Memory,
  Thought,
  Retrievable,
  Tool,
  ArtifactTool,
  MediaKind,
} from '@nhtio/adk/common'

// ─── DescriptionLike (validator description envelope) ─────────────────────────

/**
 * Structural shape of a validator/Joi `describe()` output, as consumed by the JSON-Schema
 * renderer. A loose superset — only the fields the renderer reads are typed; the index signature
 * carries everything else through untouched.
 */
export interface DescriptionLike {
  /** Validator type name (e.g. `'string'`, `'object'`, `'array'`). */
  type?: string
  /** Human-readable description of the field. */
  description?: string
  /** Presence flag (`'optional'`, `'required'`, or `'forbidden'`) at the top level. */
  presence?: string
  /** Default value supplied when the field is absent. */
  default?: unknown
  /** Permitted values declared via an enum/valid set. */
  enum?: unknown[]
  /** Permitted values declared via the validator's `valid()` rule. */
  valids?: unknown[]
  /** Example values for the field. */
  examples?: unknown[]
  /** Nested property descriptions, keyed by property name (for object types). */
  properties?: Record<string, DescriptionLike>
  /** Element description(s) for array types. */
  items?: DescriptionLike | DescriptionLike[]
  /** Names of required properties (for object types). */
  required?: string[]
  /** Validator flags bag carrying presence, description, and default. */
  flags?: { presence?: string; description?: string; default?: unknown }
  /** Pass-through for any other validator metadata the renderer does not read. */
  [key: string]: unknown
}

// ─── JSON Schema (Chat-Completions-compatible subset) ─────────────────────────

/**
 * The subset of JSON Schema that Chat-family tool/function `parameters` accept, as emitted by
 * {@link ChatHelpersCommon.descriptionToChatCompletionsJsonSchema}. The index signature allows
 * extra keywords to pass through to the wire.
 */
export interface JsonSchema {
  /** JSON Schema primitive/compound type. */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  /** Human-readable description of the schema node. */
  description?: string
  /** Permitted values for the node. */
  enum?: unknown[]
  /** Default value for the node. */
  default?: unknown
  /** Example values for the node. */
  examples?: unknown[]
  /** Property schemas keyed by property name (for `object` types). */
  properties?: Record<string, JsonSchema>
  /** Names of required properties (for `object` types). */
  required?: string[]
  /** Element schema(s) for `array` types. */
  items?: JsonSchema | JsonSchema[]
  /** Whether (or what schema) additional, undeclared properties are permitted. */
  additionalProperties?: boolean | JsonSchema
  /** Pass-through for any other JSON Schema keyword. */
  [key: string]: unknown
}

// ─── Helper-attribute envelopes ───────────────────────────────────────────────

/**
 * Attribute bag rendered onto the trust envelope that wraps untrusted (third-party) content.
 */
export interface UntrustedContentAttrs {
  /**
   * Nonce binding the envelope's open and close markers together — it becomes part of the tag NAME
   * (`<..._<nonce>>`) so a model mirroring the fence cannot forge a sibling's closer.
   *
   * FOOTGUN: this nonce MUST be unguessable AND non-path-shaped. It is typically the source record's id; a
   * path-shaped id (e.g. `chunk-assembly-events-9`) is copied by small models as a CITATION
   * (`/assembly/events-9`), which a doc-path validator then rejects → re-cite loop. Mint record ids with
   * `crypto.randomUUID()`; carry page/human provenance in `source=` (rendered before `nonce=`), never in the id.
   */
  nonce: string
  /** Content classifier rendered on the envelope. */
  kind: string
  /** Name of the tool that produced the content, when applicable. */
  tool?: string
  /**
   * When wrapping a {@link @nhtio/adk!Media}-derived text marker, the modality hazard axis derived from
   * `media.modalityHazard`: `'inert'`, `'extractable'` (from `'extractable-instructions'`), or
   * `'opaque'` (from `'opaque-perceptual'`). Omitted for non-media envelopes.
   */
  modality?: 'inert' | 'extractable' | 'opaque'
}

/**
 * Attribute bag rendered onto the trust envelope that wraps trusted (first-party) content.
 */
export interface TrustedContentAttrs {
  /**
   * Nonce binding the envelope's open and close markers together — it becomes part of the tag NAME
   * (`<..._<nonce>>`) so a model mirroring the fence cannot forge a sibling's closer.
   *
   * FOOTGUN: this nonce MUST be unguessable AND non-path-shaped. It is typically the source record's id; a
   * path-shaped id (e.g. `chunk-assembly-events-9`) is copied by small models as a CITATION
   * (`/assembly/events-9`), which a doc-path validator then rejects → re-cite loop. Mint record ids with
   * `crypto.randomUUID()`; carry page/human provenance in `source=` (rendered before `nonce=`), never in the id.
   */
  nonce: string
  /** Content classifier rendered on the envelope. */
  kind: string
  /** Name of the tool that produced the content, when applicable. */
  tool?: string
  /**
   * Same semantics as {@link UntrustedContentAttrs.modality}.
   */
  modality?: 'inert' | 'extractable' | 'opaque'
}

/**
 * Attribute bag rendered onto a standing-instruction block.
 */
export interface StandingInstructionAttrs {
  /** Optional version label for the standing instruction. */
  version?: string
}

/**
 * Attribute bag rendered onto a memory block.
 */
export interface MemoryAttrs {
  /**
   * Nonce binding the block's open and close markers together — it becomes part of the tag NAME
   * (`<..._<nonce>>`) so a model mirroring the block cannot forge a sibling's closer.
   *
   * FOOTGUN: this nonce MUST be unguessable AND non-path-shaped. It is typically the source record's id; a
   * path-shaped id (e.g. `chunk-assembly-events-9`) is copied by small models as a CITATION
   * (`/assembly/events-9`), which a doc-path validator then rejects → re-cite loop. Mint record ids with
   * `crypto.randomUUID()`; carry page/human provenance in `source=` (rendered before `nonce=`), never in the id.
   */
  nonce: string
  /** Origin of the memory (e.g. the producing subsystem). */
  source?: string
  /** ISO-8601 creation timestamp of the memory. */
  createdAt?: string
  /** Memory classifier. */
  kind?: string
  /** Relevance/recall score, when the memory was retrieved by similarity. */
  score?: number
}

/**
 * Attribute bag rendered onto a retrievable block.
 */
export interface RetrievableAttrs {
  /**
   * Nonce binding the block's open and close markers together — it becomes part of the tag NAME
   * (`<..._<nonce>>`) so a model mirroring the block cannot forge a sibling's closer.
   *
   * FOOTGUN: this nonce MUST be unguessable AND non-path-shaped. It is typically the source record's id; a
   * path-shaped id (e.g. `chunk-assembly-events-9`) is copied by small models as a CITATION
   * (`/assembly/events-9`), which a doc-path validator then rejects → re-cite loop. Mint record ids with
   * `crypto.randomUUID()`; carry page/human provenance in `source=` (rendered before `nonce=`), never in the id.
   */
  nonce: string
  /** Origin of the retrievable (e.g. the source document or system). */
  source?: string
  /** ISO-8601 creation timestamp of the retrievable. */
  createdAt?: string
  /** Retrievable classifier. */
  kind?: string
  /** Relevance score from the retrieval query. */
  score?: number
}

/**
 * Attribute bag rendered onto a thought block.
 */
export interface ThoughtAttrs {
  /**
   * Nonce binding the block's open and close markers together — it becomes part of the tag NAME
   * (`<..._<nonce>>`) so a model mirroring the block cannot forge a sibling's closer.
   *
   * FOOTGUN: this nonce MUST be unguessable AND non-path-shaped. It is typically the source record's id; a
   * path-shaped id (e.g. `chunk-assembly-events-9`) is copied by small models as a CITATION
   * (`/assembly/events-9`), which a doc-path validator then rejects → re-cite loop. Mint record ids with
   * `crypto.randomUUID()`; carry page/human provenance in `source=` (rendered before `nonce=`), never in the id.
   */
  nonce: string
  /** Whether the thought is the model's own, a peer's, or opaque vendor reasoning. */
  kind: 'self-reasoning' | 'peer-reasoning' | 'opaque-reasoning'
  /** Identity of the agent the thought originated from. */
  from: string
  /** ISO-8601 creation timestamp of the thought. */
  createdAt?: string
  /** Replay-compatibility label gating whether the thought is surfaced on replay. */
  replayCompatibility?: string
}

// ─── Bucket order ─────────────────────────────────────────────────────────────

/**
 * Name of a system-prompt content bucket whose render order is configurable.
 */
export type ChatCompletionsBucketLabel =
  | 'standingInstructions'
  | 'memories'
  | 'retrievables'
  | 'timeline'

/**
 * Ordered list of {@link ChatCompletionsBucketLabel}s controlling the sequence in which content
 * buckets are assembled into the prompt.
 */
export type ChatCompletionsBucketOrder = ReadonlyArray<ChatCompletionsBucketLabel>

// ─── Function-tool wire shape (identical for OpenAI Chat Completions and Ollama) ──

/**
 * Wire shape of a single function tool advertised to the model — identical for OpenAI Chat
 * Completions and Ollama.
 */
export interface ChatCompletionsTool {
  /** Tool kind; always `'function'` for the bundled batteries. */
  type: 'function'
  /** The function declaration: its name, description, and JSON-Schema parameters. */
  function: {
    name: string
    description?: string
    parameters?: JsonSchema
  }
}

// ─── Unsupported-media policy ─────────────────────────────────────────────────

/**
 * Policy for how a Chat-family battery handles a {@link @nhtio/adk!Media} instance whose modality the
 * wire protocol cannot natively represent.
 *
 * @remarks
 * The option SHAPE is shared; each battery decides which modalities count as "unsupported"
 * (OpenAI Chat Completions: video; Ollama native `/api/chat`: everything except image). Three
 * modes:
 *
 * - `'throw'` — raise the battery's unsupported-media exception and fail the dispatch. Loud
 *   failure; the default, so a misconfigured pipeline surfaces immediately.
 * - `'fallback-stash'` — look for a model-readable text entry in `media.stash`. If present, render
 *   that text inside the appropriate trust envelope in lieu of a media block. If no entry is found,
 *   fall through to `'synthetic-description'` behaviour. The shorthand string form uses the
 *   battery's default key list (`['text:transcript', 'text:caption', 'text:description']`, walked
 *   in order). The object form `{ mode: 'fallback-stash'; stashKeys }` overrides the key list.
 * - `'synthetic-description'` — always render a synthetic text description constructed from
 *   `filename`, `byteLength`, and `mimeType` regardless of `stash` presence.
 */
export type UnsupportedMediaPolicy =
  | 'throw'
  | 'fallback-stash'
  | 'synthetic-description'
  | { mode: 'fallback-stash'; stashKeys: ReadonlyArray<string> }

// ─── Media OUTPUT (generated media surfaced as assistant attachments) ─────────

/**
 * One piece of media a model GENERATED as turn output — the descriptor a
 * {@link MediaOutputExtractorFn} returns for the adapter to persist + attach to the assistant
 * {@link @nhtio/adk!Message}.
 *
 * @remarks
 * The LLM batteries are multimodal-IN, text-OUT by default: the tested open-weight chat checkpoints
 * emit only text, so no media output is produced unless a consumer wraps a media-emitting model AND
 * supplies an extractor. The framework contract already supports the output direction —
 * `Message.attachments` is symmetric across roles and `ctx.storeMediaBytes` persists generated bytes —
 * so this descriptor is all the adapter needs: it calls `storeMediaBytes` with `bytes`, builds a
 * `Media.toolGenerated({ kind, mimeType, filename, reader })` from the returned reader, and attaches it.
 */
export interface GeneratedMediaOutput {
  /** Media modality (`'image'`/`'audio'`/`'video'`/`'document'`). */
  kind: MediaKind
  /** Concrete MIME type of the generated bytes (e.g. `'audio/wav'`, `'image/png'`). */
  mimeType: string
  /** The generated media bytes. */
  bytes: Uint8Array
  /** Optional filename for the attachment; the adapter supplies a default when omitted. */
  filename?: string
}

/**
 * Extracts generated media from a battery's raw generation result so the adapter can surface it as
 * assistant `Message.attachments`. Injectable + defaulted to absent (no media output) on every LLM
 * battery, mirroring the `toolCallParser` / `reasoningParser` / `decodeMedia` injection seams.
 *
 * @remarks
 * `result` is the battery-native generation object (transformers.js `model.generate` / pipeline output;
 * the LiteRT-LM final `Message` + raw content items) — deliberately typed `unknown` because its shape is
 * battery-specific and the extractor is supplied by whoever wraps a media-emitting model. Returning an
 * empty array (or not supplying the hook) yields today's text-only behavior, byte-for-byte unchanged.
 */
export type MediaOutputExtractorFn = (
  result: unknown
) => GeneratedMediaOutput[] | Promise<GeneratedMediaOutput[]>

// ─── Raw generation observability (the model's text BEFORE parsing) ───────────

/**
 * One observation of a battery's raw model output for a single completed generation, fired the instant
 * the full text is in hand — AFTER envelope-token stripping + reasoning/tool-call parsing, but BEFORE
 * the parsed result is persisted. The whole point is to expose the gap between what the model literally
 * emitted (`rawText`) and what the battery managed to extract (`cleanedText` / `toolCalls` /
 * `reasoning`): when a small on-device model emits a tool call in a shape no parser matches, the call
 * silently leaks into `cleanedText` as prose, and this is the ONLY seam where that is visible.
 *
 * @remarks
 * This is a pure observability tap — it returns `void`, never mutates the result, and never throws into
 * the generation path (the adapter swallows callback errors). It fires once per terminal generation
 * (one per non-streamed turn; one per stream at stream end), for BOTH the transformers.js and LiteRT-LM
 * on-device batteries, at the identical point in each. Use it for parser bring-up against a new model,
 * live debugging ("why did the agent abstain?"), or capturing ground-truth fixtures — exactly the job
 * that previously required patching a temporary hook into the adapter.
 */
export interface RawGenerationObservation {
  /**
   * The model's complete decoded output for this generation, with non-semantic envelope/turn-boundary
   * special tokens already stripped (the same text handed to the parsers) — i.e. what the parsers
   * actually saw. This is the field to inspect when a tool call did not parse.
   */
  rawText: string
  /**
   * The residual prose after reasoning + tool-call extraction — what becomes the assistant message
   * `content`. If a tool call failed to parse, its source text is still here (the leak).
   */
  cleanedText: string
  /** The reasoning/thinking traces the reasoning parser extracted (empty when none / not applicable). */
  reasoning: ReadonlyArray<string>
  /** The tool calls the tool-call parser extracted (empty when the model emitted none, or none parsed). */
  toolCalls: ReadonlyArray<ParsedToolCall>
  /** Whether this generation streamed its prose to the consumer (vs. a single batch decode). */
  streamed: boolean
  /** The adapter's stream/message id for this generation, for correlating with other telemetry. */
  streamId: string
}

/**
 * Observe a battery's raw model output for one completed generation. Injectable + defaulted to absent
 * on the on-device LLM batteries (transformers.js, LiteRT-LM), mirroring the `toolCallParser` /
 * `reasoningParser` / `extractMediaOutputs` injection seams. Fired once per terminal generation, after
 * parsing and before persistence; purely observational (return value ignored, errors swallowed).
 */
export type RawGenerationObserverFn = (observation: RawGenerationObservation) => void

// ─── Prompt observability (the exact request BEFORE it is dispatched) ──────────

/**
 * One observation of the fully-assembled request a battery is about to send TO the model, fired the
 * instant assembly completes and BEFORE the engine/HTTP dispatch. It is the mirror of
 * {@link RawGenerationObservation}: that seam exposes the raw text coming back FROM the model; this one
 * exposes the raw request going TO it. Together they let you read ground truth at both ends of the wire —
 * e.g. to settle whether a "smart quote" in a rendered answer came from the model itself or from a
 * downstream markdown renderer, you inspect the bytes here, not the DOM.
 *
 * @remarks
 * This is a pure observability tap — it returns `void`, never mutates the request, and never throws into
 * the generation path (the adapter swallows callback errors). It fires once per terminal generation
 * (one per non-streamed turn; one per stream, at dispatch), across ALL five LLM batteries.
 *
 * **Handed back AS-IS — no redaction.** The observation carries the request exactly as assembled. The ADK
 * does not scrub credentials, headers, or any other field for you: what you put on the request is what you
 * see here, and if you route this to a persistent sink (a log, `localStorage`, a file) you may persist
 * secrets that rode the request (an `apiKey`, `Authorization` header, etc.). That is your responsibility to
 * handle, not the battery's — the ADK surfaces the truth and lets you decide what to do with it. (In
 * practice the API batteries strip ADK-control keys like `apiKey` out of the wire body before this fires,
 * but that is incidental to how the body is built, not a guarantee.)
 */
export interface PromptAssembledObservation {
  /** Which battery assembled this request (e.g. `'litert_lm'`, `'openai_chat_completions'`). */
  battery: string
  /**
   * The shape of the assembled request. `'rendered-prompt'` for the on-device batteries (transformers.js,
   * LiteRT-LM), which render a preface string + a messages array for the engine; `'request-body'` for the
   * API batteries (OpenAI-compatible, Ollama, WebLLM), which POST a JSON body.
   */
  kind: 'rendered-prompt' | 'request-body'
  /**
   * On-device leading/system content rendered ahead of the timeline (e.g. the LiteRT `preface` object,
   * which carries the assembled system message text and — for native tool delivery — the tool list), when
   * applicable. Its concrete shape is battery-specific; captured verbatim. Absent for the API batteries.
   */
  preface?: unknown
  /**
   * The per-turn messages exactly as handed to the engine (on-device) or placed on the wire (API): the
   * engine's message array, or the request body's `messages`.
   */
  messages: unknown
  /**
   * The tool declarations exactly as dispatched: the rendered `<tool_definitions>` prompt text (on-device
   * prompt-delivery) or the wire `tools` array (API / native tool delivery). Absent when no tools are sent.
   */
  tools?: unknown
  /**
   * API batteries only: the complete assembled request body, exactly as it will be sent (see the AS-IS /
   * no-redaction note above). Absent for the on-device batteries.
   */
  requestBody?: unknown
  /** Whether this generation streams its response (vs. a single batch call). */
  streamed: boolean
  /** The adapter's stream/message id for this generation, for correlating with other telemetry. */
  streamId: string
}

/**
 * Observe the fully-assembled request a battery is about to dispatch. Injectable + defaulted to absent on
 * every LLM battery, mirroring {@link RawGenerationObserverFn}. Fired once per terminal generation, after
 * assembly and before dispatch; purely observational (return value ignored, errors swallowed). The request
 * is handed back AS-IS — see {@link PromptAssembledObservation} for the no-redaction contract.
 */
export type PromptAssembledObserverFn = (observation: PromptAssembledObservation) => void

// ─── Retry config ─────────────────────────────────────────────────────────────

/**
 * Retry/backoff configuration for a Chat-family battery's HTTP requests.
 */
export interface ChatCompletionsRetryConfig {
  /** Maximum number of attempts (including the first) before giving up. */
  maxAttempts?: number
  /** Base delay in milliseconds for the first retry; doubles each attempt. */
  baseDelayMs?: number
  /** Upper bound in milliseconds on any single backoff delay. */
  maxDelayMs?: number
  /** HTTP status codes that trigger a retry. */
  retriableStatuses?: number[]
  /** Whether to honour a server `Retry-After` header in place of computed backoff. */
  honorRetryAfter?: boolean
}

// ─── Shared helper contract (wire-shape-agnostic members) ─────────────────────

/**
 * The wire-shape-agnostic subset of a Chat-family battery's translation helpers — every helper
 * that produces a plain `string` (or JSON Schema / tool-definition wire, which is identical across
 * the family) rather than a battery-specific message object.
 *
 * @remarks
 * Both `ChatCompletionsHelpers` (OpenAI battery) and `OllamaHelpers` (Ollama battery) extend this
 * contract and add their own wire-specific members (timeline-message rendering, tool-call-result
 * rendering, history assembly, and — for OpenAI — streaming tool-call delta accumulation). Helpers
 * that compose other helpers receive their dependents via explicit `deps` arguments typed against
 * THIS contract (never against a battery-specific bag), so the shared implementations carry no
 * import edge back to any individual battery.
 */
export interface ChatHelpersCommon {
  /** Converts a validator `describe()` envelope into the Chat-Completions JSON-Schema subset. */
  descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema
  /** Wraps untrusted (third-party) text in the untrusted-content trust envelope. */
  renderUntrustedContent: (content: string, attrs: UntrustedContentAttrs) => string
  /** Wraps trusted (first-party) text in the trusted-content trust envelope. */
  renderTrustedContent: (content: string, attrs: TrustedContentAttrs) => string
  /** Renders standing instructions into a single prompt block. */
  renderStandingInstructions: (
    items: Iterable<Tokenizable>,
    attrs?: StandingInstructionAttrs
  ) => string
  /** Renders memories (each with its attribute bag) into a single prompt block. */
  renderMemories: (items: Iterable<{ memory: Memory; attrs: MemoryAttrs }>) => string
  /** Renders the safety directive that precedes any retrievable content. */
  renderRetrievableSafetyDirective: () => string
  /** Renders first-party (trusted) retrievables into a single prompt block. */
  renderFirstPartyRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>
  ) => Promise<string>
  /** Renders third-party public retrievables, wrapping each in the untrusted-content envelope. */
  renderThirdPartyPublicRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>,
    deps: { renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent'] }
  ) => Promise<string>
  /** Renders third-party private retrievables, wrapping each in the untrusted-content envelope. */
  renderThirdPartyPrivateRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>,
    deps: { renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent'] }
  ) => Promise<string>
  /** Assembles the full retrievables block: safety directive plus the trust-tiered sub-renderers. */
  renderRetrievables: (
    items: Iterable<{ retrievable: Retrievable; attrs: RetrievableAttrs }>,
    deps: {
      renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
      renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
      renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
      renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
      renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
    }
  ) => Promise<string>
  /**
   * Renders the directions-bearing "handle" body for a non-inlined {@link @nhtio/adk!SpooledArtifact}
   * tool result: metadata (callId/kind/byteLength/lineCount) plus the forged `artifact_*` tools the
   * model should call to read it incrementally.
   *
   * @remarks
   * Optional override seam. When omitted the battery uses the shared
   * {@link defaultRenderArtifactHandleBody}. A consumer overrides it to change WHICH reader the model
   * is steered toward first — e.g. promoting the JSON content-readers (`artifact_json_get` /
   * `artifact_json_keys`) ahead of the metadata-only `artifact_json_type` for a small model that grabs
   * the first listed tool. The tool list itself comes from the artifact's `constructor.toolMethods`;
   * an override typically reorders or re-annotates that list before delegating to the default renderer.
   */
  renderArtifactHandleBody?: (input: {
    callId: string
    artifact: unknown
    byteLength: number
    lineCount: number
    estimatedTokens?: number
    encoding?: string
  }) => string
  /** Renders a single thought into its prompt block, optionally carrying an opaque replay payload. */
  renderThought: (content: string, attrs: ThoughtAttrs, payload?: unknown) => string
  /** Selects which thoughts to surface, by surfacing mode, self identity, and replay compatibility. */
  filterThoughts: (
    thoughts: Iterable<Thought>,
    mode: 'all-self' | 'latest-self' | 'all',
    selfIdentity: string,
    replayCompatibility: ReadonlyArray<string>
  ) => Thought[]
  /** Translates the tool registry into the function-tool wire array advertised to the model. */
  toolsToChatCompletionsTools: (
    tools: ReadonlyArray<Tool | ArtifactTool>,
    deps: { descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema }
  ) => ChatCompletionsTool[]
  /** Assembles the system-prompt message from its constituent buckets in {@link ChatCompletionsBucketOrder}. */
  renderChatCompletionsSystemPrompt: (input: {
    systemPrompt: Tokenizable
    standingInstructions: Iterable<Tokenizable>
    memories: Iterable<Memory>
    retrievables: Iterable<Retrievable>
    bucketOrder: ChatCompletionsBucketOrder
    renderStandingInstructions: ChatHelpersCommon['renderStandingInstructions']
    renderMemories: ChatHelpersCommon['renderMemories']
    renderRetrievables: ChatHelpersCommon['renderRetrievables']
    renderRetrievableSafetyDirective: ChatHelpersCommon['renderRetrievableSafetyDirective']
    renderFirstPartyRetrievables: ChatHelpersCommon['renderFirstPartyRetrievables']
    renderThirdPartyPublicRetrievables: ChatHelpersCommon['renderThirdPartyPublicRetrievables']
    renderThirdPartyPrivateRetrievables: ChatHelpersCommon['renderThirdPartyPrivateRetrievables']
    renderUntrustedContent: ChatHelpersCommon['renderUntrustedContent']
  }) => Promise<string>
}
