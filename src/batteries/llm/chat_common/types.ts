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

import type {
  Tokenizable,
  Memory,
  Thought,
  Retrievable,
  Tool,
  ArtifactTool,
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
  /** Per-render nonce binding the envelope's open and close markers together. */
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
  /** Per-render nonce binding the envelope's open and close markers together. */
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
  /** Per-render nonce binding the block's open and close markers together. */
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
  /** Per-render nonce binding the block's open and close markers together. */
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
  /** Per-render nonce binding the block's open and close markers together. */
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
