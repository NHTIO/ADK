import { v6 as uuidv6 } from 'uuid'
import { validator } from '@nhtio/validation'
import { Registry } from '../classes/registry'
import { Tokenizable } from '../classes/tokenizable'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { E_INVALID_TURN_CONTEXT } from '../exceptions/runtime'
import type { Tool } from '../classes/tool'
import type { Memory } from '../classes/memory'
import type { Message } from '../classes/message'
import type { Thought } from '../classes/thought'
import type { SpoolReader } from './spool_reader'
import type { MediaReader } from './media_reader'
import type { ToolCall } from '../classes/tool_call'
import type { ConduitBytes } from './dispatch_context'
import type { Retrievable } from '../classes/retrievable'
import type { ToolRegistry } from '../classes/tool_registry'
import type {
  EmitMessageFn,
  EmitThoughtFn,
  EmitToolCallFn,
  EmitToolExecutionEndFn,
  EmitToolExecutionStartFn,
  OpenGateFn,
} from '../types/turn_runner'

/**
 * Plain input object supplied to {@link TurnContext} at construction time.
 *
 * @remarks
 * Validated against `turnContextSchema` before the `TurnContext` instance is created.
 * Fields will grow as the turn execution model takes shape (e.g. input message, tool
 * definitions, model client config).
 */
export interface RawTurnContext {
  /** `AbortController` whose signal can be used to cancel the turn mid-flight. */
  turnAbortController: AbortController
  /** A registry for arbitrary additional data to be added to the context as needed; initially empty. */
  stash?: Record<string, unknown>
  /** The system prompt guiding the agent's behavior for this turn. */
  systemPrompt: string | Tokenizable
  /** Standing instructions for the agent, applied to every turn. */
  standingInstructions: (string | Tokenizable)[]
}

/**
 * A fully-resolved {@link RawTurnContext} where all optional fields have been filled in by the
 * schema (e.g. `stash` defaulted to `{}`).
 *
 * @remarks
 * This is the shape returned by `turnContextSchema` after validation — use it wherever a
 * guaranteed-present context is needed rather than the raw caller-supplied input.
 */
export type ResolvedTurnContext = Required<RawTurnContext>

/**
 * Validator schema used to validate a {@link RawTurnContext} before constructing a {@link TurnContext}.
 *
 * @remarks
 * Validates all four fields of {@link RawTurnContext}:
 * - `turnAbortController` — required `AbortController` instance.
 * - `stash` — optional string-keyed object; defaults to `{}`.
 * - `systemPrompt` — required string or {@link @nhtio/adk!Tokenizable}, via {@link @nhtio/adk!Tokenizable.schema}.
 * - `standingInstructions` — optional array of strings or {@link @nhtio/adk!Tokenizable} instances, each
 *   validated via {@link @nhtio/adk!Tokenizable.schema}; defaults to `[]`.
 *
 * Throws a `ValidationException` (via {@link validateOrThrow}) when validation fails.
 */
export const turnContextSchema = validator
  .object<RawTurnContext>({
    turnAbortController: validator
      .alternatives(
        validator.object().instance(AbortController as any),
        validator.function().instance(AbortController as any)
      )
      .required(),
    stash: validator.object().pattern(validator.string(), validator.any()).default({}),
    systemPrompt: Tokenizable.schema.required(),
    standingInstructions: validator.array().items(Tokenizable.schema).default([]),
  })
  .required()

/**
 * A function that retrieves the memories relevant to the current turn.
 *
 * @remarks
 * Receives the active {@link TurnContext} so implementations can filter or rank memories
 * based on turn-specific state (e.g. the system prompt, standing instructions, or stash).
 * May be synchronous or asynchronous.
 */
export type MemoryRetrievalFn = (ctx: TurnContext) => Memory[] | Promise<Memory[]>

/**
 * A function that retrieves the retrievable (RAG) records relevant to the current turn.
 *
 * @remarks
 * Receives the active {@link TurnContext} so implementations can rank, filter, or compose
 * retrieval results against the turn-specific state (system prompt, standing instructions, etc.).
 * The retrieval middleware that produces these records is responsible for assigning each one's
 * `trustTier` — batteries MUST NOT auto-classify retrieved content.
 * May be synchronous or asynchronous.
 */
export type RetrievableRetrievalFn = (ctx: TurnContext) => Retrievable[] | Promise<Retrievable[]>

/**
 * A function that retrieves the conversation messages relevant to the current turn.
 *
 * @remarks
 * Receives the active {@link TurnContext} so implementations can apply turn-aware filtering or
 * windowing. Returns only `user` and `assistant` {@link @nhtio/adk!Message} entries — system instructions
 * and tool results are not part of the persisted message history.
 * May be synchronous or asynchronous.
 */
export type MessageRetrievalFn = (ctx: TurnContext) => Message[] | Promise<Message[]>

/**
 * A function that retrieves the thought traces relevant to the current turn.
 *
 * @remarks
 * Receives the active {@link TurnContext} so implementations can apply turn-aware filtering or
 * attribution (e.g. filtering to a specific agent's identity in multi-agent conversations).
 * May be synchronous or asynchronous.
 */
export type ThoughtRetrievalFn = (ctx: TurnContext) => Thought[] | Promise<Thought[]>

/**
 * A function that retrieves the tool call records relevant to the current turn.
 *
 * @remarks
 * Receives the active {@link TurnContext} so implementations can filter by completion state,
 * agent identity, or any other turn-specific criteria.
 * May be synchronous or asynchronous.
 */
export type ToolCallRetrievalFn = (ctx: TurnContext) => ToolCall[] | Promise<ToolCall[]>

/**
 * A function that retrieves the tools available for the current turn.
 *
 * @remarks
 * Receives the active {@link TurnContext} so implementations can apply turn-aware filtering
 * (e.g. RBAC scopes, feature flags). May be synchronous or asynchronous.
 */
export type ToolsRetrievalFn = (ctx: TurnContext) => Tool[] | Promise<Tool[]>

/**
 * A function that refreshes and returns the standing instructions for the current turn.
 *
 * @remarks
 * Called to re-derive standing instructions mid-turn when they may have changed.
 * May be synchronous or asynchronous.
 */
export type StandingInstructionsRefreshFn = (
  ctx: TurnContext
) => (string | Tokenizable)[] | Promise<(string | Tokenizable)[]>

/** Stores a new standing instruction in the persistence layer. */
export type StandingInstructionStoreFn = (
  ctx: TurnContext,
  v: string | Tokenizable
) => void | Promise<void>

/** Updates an existing standing instruction in the persistence layer. */
export type StandingInstructionMutateFn = (
  ctx: TurnContext,
  v: string | Tokenizable
) => void | Promise<void>

/** Removes a standing instruction from the persistence layer. */
export type StandingInstructionDeleteFn = (
  ctx: TurnContext,
  v: string | Tokenizable
) => void | Promise<void>

/** Stores a new memory in the persistence layer. */
export type MemoryStoreFn = (ctx: TurnContext, v: Memory) => void | Promise<void>

/** Updates an existing memory in the persistence layer. */
export type MemoryMutateFn = (ctx: TurnContext, v: Memory) => void | Promise<void>

/** Removes a memory from the persistence layer by ID. */
export type MemoryDeleteFn = (ctx: TurnContext, id: string) => void | Promise<void>

/** Stores a new retrievable record in the persistence layer. */
export type RetrievableStoreFn = (ctx: TurnContext, v: Retrievable) => void | Promise<void>

/** Updates an existing retrievable record in the persistence layer. */
export type RetrievableMutateFn = (ctx: TurnContext, v: Retrievable) => void | Promise<void>

/** Removes a retrievable record from the persistence layer by ID. */
export type RetrievableDeleteFn = (ctx: TurnContext, id: string) => void | Promise<void>

/** Stores a new message in the persistence layer. */
export type MessageStoreFn = (ctx: TurnContext, v: Message) => void | Promise<void>

/** Updates an existing message in the persistence layer. */
export type MessageMutateFn = (ctx: TurnContext, v: Message) => void | Promise<void>

/** Removes a message from the persistence layer by ID. */
export type MessageDeleteFn = (ctx: TurnContext, id: string) => void | Promise<void>

/** Stores a new thought in the persistence layer. */
export type ThoughtStoreFn = (ctx: TurnContext, v: Thought) => void | Promise<void>

/** Updates an existing thought in the persistence layer. */
export type ThoughtMutateFn = (ctx: TurnContext, v: Thought) => void | Promise<void>

/** Removes a thought from the persistence layer by ID. */
export type ThoughtDeleteFn = (ctx: TurnContext, id: string) => void | Promise<void>

/** Stores a new tool call in the persistence layer. */
export type ToolCallStoreFn = (ctx: TurnContext, v: ToolCall) => void | Promise<void>

/** Updates an existing tool call in the persistence layer. */
export type ToolCallMutateFn = (ctx: TurnContext, v: ToolCall) => void | Promise<void>

/** Removes a tool call from the persistence layer by ID. */
export type ToolCallDeleteFn = (ctx: TurnContext, id: string) => void | Promise<void>

/**
 * Persists tool-generated media bytes into consumer storage and returns a {@link @nhtio/adk!MediaReader}.
 * A byte-persistence conduit, not a mutation — returns a value and touches no turn state.
 */
export type MediaBytesStoreFn = (
  ctx: TurnContext,
  id: string,
  bytes: ConduitBytes
) => MediaReader | Promise<MediaReader>

/**
 * Persists extracted retrievable text bytes into consumer storage and returns a
 * {@link @nhtio/adk!SpoolReader}. A byte-persistence conduit, not a mutation.
 */
export type RetrievableBytesStoreFn = (
  ctx: TurnContext,
  id: string,
  bytes: ConduitBytes
) => SpoolReader | Promise<SpoolReader>

/**
 * Callbacks injected into a {@link TurnContext} by `TurnRunner` at run time.
 *
 * @remarks
 * These are supplied by the `TurnRunnerConfig` and bound to the context so middleware
 * can call fetch, emit, and mutation methods directly on the context without needing a reference
 * to the runner or its emitters. Not exported — `TurnContext` is constructed internally and
 * callers never need to reference this shape.
 *
 * @internal
 */
interface TurnRunnerInjected {
  /** Retrieves memories relevant to this turn. */
  fetchMemories: MemoryRetrievalFn
  /** Retrieves conversation messages relevant to this turn. */
  fetchMessages: MessageRetrievalFn
  /** Retrieves thought traces relevant to this turn. */
  fetchThoughts: ThoughtRetrievalFn
  /** Retrieves tool call records relevant to this turn. */
  fetchToolCalls: ToolCallRetrievalFn
  /** Retrieves tools available for this turn. */
  fetchTools: ToolsRetrievalFn
  /** Refreshes and returns the standing instructions for this turn. */
  refreshStandingInstructions: StandingInstructionsRefreshFn
  /** Stores a new standing instruction in the persistence layer. */
  storeStandingInstruction: StandingInstructionStoreFn
  /** Updates an existing standing instruction in the persistence layer. */
  mutateStandingInstruction: StandingInstructionMutateFn
  /** Removes a standing instruction from the persistence layer. */
  deleteStandingInstruction: StandingInstructionDeleteFn
  /** Stores a new memory in the persistence layer. */
  storeMemory: MemoryStoreFn
  /** Updates an existing memory in the persistence layer. */
  mutateMemory: MemoryMutateFn
  /** Removes a memory from the persistence layer by ID. */
  deleteMemory: MemoryDeleteFn
  /** Retrieves retrievable records relevant to this turn. */
  fetchRetrievables: RetrievableRetrievalFn
  /** Stores a new retrievable record in the persistence layer. */
  storeRetrievable: RetrievableStoreFn
  /** Updates an existing retrievable record in the persistence layer. */
  mutateRetrievable: RetrievableMutateFn
  /** Removes a retrievable record from the persistence layer by ID. */
  deleteRetrievable: RetrievableDeleteFn
  /** Stores a new message in the persistence layer. */
  storeMessage: MessageStoreFn
  /** Updates an existing message in the persistence layer. */
  mutateMessage: MessageMutateFn
  /** Removes a message from the persistence layer by ID. */
  deleteMessage: MessageDeleteFn
  /** Stores a new thought in the persistence layer. */
  storeThought: ThoughtStoreFn
  /** Updates an existing thought in the persistence layer. */
  mutateThought: ThoughtMutateFn
  /** Removes a thought from the persistence layer by ID. */
  deleteThought: ThoughtDeleteFn
  /** Stores a new tool call in the persistence layer. */
  storeToolCall: ToolCallStoreFn
  /** Updates an existing tool call in the persistence layer. */
  mutateToolCall: ToolCallMutateFn
  /** Removes a tool call from the persistence layer by ID. */
  deleteToolCall: ToolCallDeleteFn
  /** Persists tool-generated media bytes; returns a `MediaReader`. */
  storeMediaBytes: MediaBytesStoreFn
  /** Persists extracted retrievable text bytes; returns a `SpoolReader`. */
  storeRetrievableBytes: RetrievableBytesStoreFn
  /** Emits a `message` event on the runner. */
  emitMessage: EmitMessageFn
  /** Emits a `thought` event on the runner. */
  emitThought: EmitThoughtFn
  /** Emits a `toolCall` event on the runner. */
  emitToolCall: EmitToolCallFn
  /** Emits a `toolExecutionStart` event on the observability bus. */
  emitToolExecutionStart: EmitToolExecutionStartFn
  /** Emits a `toolExecutionEnd` event on the observability bus. */
  emitToolExecutionEnd: EmitToolExecutionEndFn
  /** Opens a turn gate; `turnId` and `abortSignal` are injected by the runner. */
  openGate: OpenGateFn
  /** The turn-scoped tool registry constructed from the runner's baseline tools. */
  tools: ToolRegistry
}

/**
 * The validated, strongly-typed context object threaded through every middleware step in a
 * single agent turn.
 *
 * @remarks
 * Constructed from a {@link RawTurnContext} by {@link @nhtio/adk!TurnRunner.run}. Middleware functions
 * receive this object and use it to read and share state across pipeline steps.
 */
export class TurnContext {
  /**
   * Returns `true` if `value` is a {@link TurnContext} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety. The ADK does not export the
   * `TurnContext` class itself as a constructable value — use this guard plus the
   * {@link TurnContext} type for runtime detection and TypeScript narrowing.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link TurnContext} instance.
   */
  public static isTurnContext(value: unknown): value is TurnContext {
    return isInstanceOf(value, 'TurnContext', TurnContext)
  }

  #id: string
  #turnAbortController: AbortController
  #stash: Registry
  #systemPrompt: Tokenizable
  #standingInstructions: Set<Tokenizable>
  #turnMemories: Set<Memory>
  #turnRetrievables: Set<Retrievable>
  #turnMessages: Set<Message>
  #turnThoughts: Set<Thought>
  #turnToolCalls: Set<ToolCall>

  /**
   * @param raw - The raw context input validated against {@link turnContextSchema}.
   * @param injected - Runtime callbacks supplied by `TurnRunner`; bound as instance methods so
   *   middleware can call fetch and emit methods directly on the context.
   * @throws {@link @nhtio/adk!E_INVALID_TURN_CONTEXT} when `raw` does not satisfy the schema.
   *
   * @internal
   */
  constructor(raw: RawTurnContext, injected: TurnRunnerInjected) {
    try {
      raw = validateOrThrow<ResolvedTurnContext>(turnContextSchema, raw, true)
    } catch (err) {
      throw new E_INVALID_TURN_CONTEXT({ cause: isError(err) ? err : undefined })
    }
    this.#id = uuidv6()
    this.#turnAbortController = raw.turnAbortController
    this.#stash = new Registry(raw.stash)
    this.#systemPrompt = Tokenizable.isTokenizable(raw.systemPrompt)
      ? raw.systemPrompt
      : new Tokenizable(raw.systemPrompt)
    this.#standingInstructions = new Set(
      (raw.standingInstructions || []).map((instr) =>
        Tokenizable.isTokenizable(instr) ? instr : new Tokenizable(instr)
      )
    )
    this.#turnMemories = new Set()
    this.#turnRetrievables = new Set()
    this.#turnMessages = new Set()
    this.#turnThoughts = new Set()
    this.#turnToolCalls = new Set()

    // Expose read-only properties on the instance for easy access in middleware.
    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      aborted: {
        get: () => Boolean(this.#turnAbortController.signal.aborted),
        enumerable: true,
        configurable: false,
      },
      abortSignal: {
        get: () => this.#turnAbortController.signal,
        enumerable: true,
        configurable: false,
      },
      abort: {
        value: (reason?: unknown) => this.#turnAbortController.abort(reason),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      stash: {
        get: () => this.#stash,
        enumerable: true,
        configurable: false,
      },
      systemPrompt: {
        get: () => this.#systemPrompt,
        enumerable: true,
        configurable: false,
      },
      standingInstructions: {
        get: () => this.#standingInstructions,
        enumerable: true,
        configurable: false,
      },
      turnMemories: {
        get: () => this.#turnMemories,
        enumerable: true,
        configurable: false,
      },
      turnRetrievables: {
        get: () => this.#turnRetrievables,
        enumerable: true,
        configurable: false,
      },
      turnMessages: {
        get: () => this.#turnMessages,
        enumerable: true,
        configurable: false,
      },
      turnThoughts: {
        get: () => this.#turnThoughts,
        enumerable: true,
        configurable: false,
      },
      turnToolCalls: {
        get: () => this.#turnToolCalls,
        enumerable: true,
        configurable: false,
      },
    })

    // Attach injected dependencies as instance methods for access in middleware.
    Object.defineProperties(this, {
      fetchMemories: {
        value: () => injected.fetchMemories(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchMessages: {
        value: () => injected.fetchMessages(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchThoughts: {
        value: () => injected.fetchThoughts(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchToolCalls: {
        value: () => injected.fetchToolCalls(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchTools: {
        value: () => injected.fetchTools(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      refreshStandingInstructions: {
        value: () => injected.refreshStandingInstructions(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeStandingInstruction: {
        value: (v: string | Tokenizable) => injected.storeStandingInstruction(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateStandingInstruction: {
        value: (v: string | Tokenizable) => injected.mutateStandingInstruction(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteStandingInstruction: {
        value: (v: string | Tokenizable) => injected.deleteStandingInstruction(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeMemory: {
        value: (v: Memory) => injected.storeMemory(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateMemory: {
        value: (v: Memory) => injected.mutateMemory(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteMemory: {
        value: (id: string) => injected.deleteMemory(this, id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchRetrievables: {
        value: () => injected.fetchRetrievables(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeRetrievable: {
        value: (v: Retrievable) => injected.storeRetrievable(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateRetrievable: {
        value: (v: Retrievable) => injected.mutateRetrievable(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteRetrievable: {
        value: (id: string) => injected.deleteRetrievable(this, id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeMessage: {
        value: (v: Message) => injected.storeMessage(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateMessage: {
        value: (v: Message) => injected.mutateMessage(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteMessage: {
        value: (id: string) => injected.deleteMessage(this, id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeThought: {
        value: (v: Thought) => injected.storeThought(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateThought: {
        value: (v: Thought) => injected.mutateThought(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteThought: {
        value: (id: string) => injected.deleteThought(this, id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeToolCall: {
        value: (v: ToolCall) => injected.storeToolCall(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateToolCall: {
        value: (v: ToolCall) => injected.mutateToolCall(this, v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteToolCall: {
        value: (id: string) => injected.deleteToolCall(this, id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeMediaBytes: {
        value: (id: string, bytes: ConduitBytes) => injected.storeMediaBytes(this, id, bytes),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeRetrievableBytes: {
        value: (id: string, bytes: ConduitBytes) => injected.storeRetrievableBytes(this, id, bytes),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitMessage: {
        value: injected.emitMessage,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitThought: {
        value: injected.emitThought,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitToolCall: {
        value: injected.emitToolCall,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitToolExecutionStart: {
        value: injected.emitToolExecutionStart,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitToolExecutionEnd: {
        value: injected.emitToolExecutionEnd,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      waitFor: {
        value: injected.openGate,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      tools: {
        get: () => injected.tools,
        enumerable: true,
        configurable: false,
      },
    })
  }

  /** Unique identifier for this turn, generated as a UUIDv6 at construction time. */
  declare readonly id: string
  /** `true` when the turn's `AbortController` signal has fired. */
  declare readonly aborted: boolean
  /** The `AbortSignal` from the turn's `AbortController`. */
  declare readonly abortSignal: AbortSignal
  /**
   * Aborts the turn's `AbortController` with the supplied reason. Middleware should call this
   * when refusing the turn — the runner reads `aborted` between every stage and short-circuits
   * cleanly: `turnEnd` still fires, no `error` event is emitted, and during dispatch
   * `dispatchEnd.status === 'aborted'` carries the operational signal.
   */
  declare readonly abort: (reason?: unknown) => void
  /** Arbitrary key-value store that middleware can read and write across pipeline steps. */
  declare readonly stash: Registry
  /** The system prompt guiding the agent's behaviour for this turn. */
  declare readonly systemPrompt: Tokenizable
  /** Standing instructions applied to every turn, in insertion order. */
  declare readonly standingInstructions: Set<Tokenizable>
  /** Memories loaded for this turn; populated by middleware after calling `fetchMemories()`. */
  declare readonly turnMemories: Set<Memory>
  /** Retrievable records loaded for this turn; populated by middleware after calling `fetchRetrievables()`. */
  declare readonly turnRetrievables: Set<Retrievable>
  /** Conversation messages loaded for this turn; populated by middleware after calling `fetchMessages()`. */
  declare readonly turnMessages: Set<Message>
  /** Thought traces loaded for this turn; populated by middleware after calling `fetchThoughts()`. */
  declare readonly turnThoughts: Set<Thought>
  /** Tool call records loaded for this turn; populated by middleware after calling `fetchToolCalls()`. */
  declare readonly turnToolCalls: Set<ToolCall>
  /** Fetches memories relevant to this turn; delegates to the callback supplied at construction. */
  declare readonly fetchMemories: () => Memory[] | Promise<Memory[]>
  /** Fetches conversation messages relevant to this turn; delegates to the callback supplied at construction. */
  declare readonly fetchMessages: () => Message[] | Promise<Message[]>
  /** Fetches thought traces relevant to this turn; delegates to the callback supplied at construction. */
  declare readonly fetchThoughts: () => Thought[] | Promise<Thought[]>
  /** Fetches tool call records relevant to this turn; delegates to the callback supplied at construction. */
  declare readonly fetchToolCalls: () => ToolCall[] | Promise<ToolCall[]>
  /** Fetches tools available for this turn; delegates to the callback supplied at construction. */
  declare readonly fetchTools: () => Tool[] | Promise<Tool[]>
  /** Refreshes and returns the standing instructions; delegates to the callback supplied at construction. */
  declare readonly refreshStandingInstructions: () =>
    | (string | Tokenizable)[]
    | Promise<(string | Tokenizable)[]>
  /** Stores a new standing instruction in the persistence layer. */
  declare readonly storeStandingInstruction: (v: string | Tokenizable) => void | Promise<void>
  /** Updates an existing standing instruction in the persistence layer. */
  declare readonly mutateStandingInstruction: (v: string | Tokenizable) => void | Promise<void>
  /** Removes a standing instruction from the persistence layer. */
  declare readonly deleteStandingInstruction: (v: string | Tokenizable) => void | Promise<void>
  /** Stores a new memory in the persistence layer. */
  declare readonly storeMemory: (v: Memory) => void | Promise<void>
  /** Updates an existing memory in the persistence layer. */
  declare readonly mutateMemory: (v: Memory) => void | Promise<void>
  /** Removes a memory from the persistence layer by ID. */
  declare readonly deleteMemory: (id: string) => void | Promise<void>
  /** Fetches retrievable records relevant to this turn; delegates to the callback supplied at construction. */
  declare readonly fetchRetrievables: () => Retrievable[] | Promise<Retrievable[]>
  /** Stores a new retrievable record in the persistence layer. */
  declare readonly storeRetrievable: (v: Retrievable) => void | Promise<void>
  /** Updates an existing retrievable record in the persistence layer. */
  declare readonly mutateRetrievable: (v: Retrievable) => void | Promise<void>
  /** Removes a retrievable record from the persistence layer by ID. */
  declare readonly deleteRetrievable: (id: string) => void | Promise<void>
  /** Stores a new message in the persistence layer. */
  declare readonly storeMessage: (v: Message) => void | Promise<void>
  /** Updates an existing message in the persistence layer. */
  declare readonly mutateMessage: (v: Message) => void | Promise<void>
  /** Removes a message from the persistence layer by ID. */
  declare readonly deleteMessage: (id: string) => void | Promise<void>
  /** Stores a new thought in the persistence layer. */
  declare readonly storeThought: (v: Thought) => void | Promise<void>
  /** Updates an existing thought in the persistence layer. */
  declare readonly mutateThought: (v: Thought) => void | Promise<void>
  /** Removes a thought from the persistence layer by ID. */
  declare readonly deleteThought: (id: string) => void | Promise<void>
  /** Stores a new tool call in the persistence layer. */
  declare readonly storeToolCall: (v: ToolCall) => void | Promise<void>
  /** Updates an existing tool call in the persistence layer. */
  declare readonly mutateToolCall: (v: ToolCall) => void | Promise<void>
  /** Removes a tool call from the persistence layer by ID. */
  declare readonly deleteToolCall: (id: string) => void | Promise<void>
  /**
   * Persists tool-generated media bytes into consumer storage and returns a {@link @nhtio/adk!MediaReader}.
   * Low-level conduit — returns a value, touches no turn state; build a {@link @nhtio/adk!Media} from the
   * reader and persist the owning primitive separately.
   */
  declare readonly storeMediaBytes: (
    id: string,
    bytes: ConduitBytes
  ) => MediaReader | Promise<MediaReader>
  /**
   * Persists extracted retrievable text bytes into consumer storage and returns a
   * {@link @nhtio/adk!SpoolReader}. Wrap it in a {@link @nhtio/adk!SpooledArtifact} for `Retrievable.content`
   * and persist the record via {@link TurnContext.storeRetrievable} separately.
   */
  declare readonly storeRetrievableBytes: (
    id: string,
    bytes: ConduitBytes
  ) => SpoolReader | Promise<SpoolReader>
  /** Emits a `message` event on the runner; may be called at any point during the turn. */
  declare readonly emitMessage: EmitMessageFn
  /** Emits a `thought` event on the runner; may be called at any point during the turn. */
  declare readonly emitThought: EmitThoughtFn
  /** Emits a `toolCall` event on the runner; may be called at any point during the turn. */
  declare readonly emitToolCall: EmitToolCallFn
  /** Emits a `toolExecutionStart` event on the observability bus; forwarded from `DispatchContext` by `DispatchRunner` when a tool is invoked inside a dispatch. */
  declare readonly emitToolExecutionStart: EmitToolExecutionStartFn
  /** Emits a `toolExecutionEnd` event on the observability bus; forwarded from `DispatchContext` by `DispatchRunner` when a tool finishes executing inside a dispatch. */
  declare readonly emitToolExecutionEnd: EmitToolExecutionEndFn
  /** Opens a turn gate and suspends until it resolves, rejects, times out, or is aborted. */
  declare readonly waitFor: OpenGateFn
  /** Turn-scoped tool registry constructed from the runner's baseline tools; middleware may trim or extend it. */
  declare readonly tools: ToolRegistry
}
