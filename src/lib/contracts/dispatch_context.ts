import { v6 as uuidv6 } from 'uuid'
import { Hooks } from '@nhtio/hooks'
import { validator } from '@nhtio/validation'
import { Registry } from '../classes/registry'
import { Tokenizable } from '../classes/tokenizable'
import { validateOrThrow } from '../utils/validation'
import { isInstanceOf, isError } from '../utils/guards'
import { ToolRegistry } from '../classes/tool_registry'
import {
  E_INVALID_LLM_EXECUTION_CONTEXT,
  E_LLM_EXECUTION_GATE_NOT_SUPPORTED,
  E_LLM_EXECUTION_ALREADY_SIGNALLED,
} from '../exceptions/runtime'
import type { Tool } from '../classes/tool'
import type { Memory } from '../classes/memory'
import type { Message } from '../classes/message'
import type { Thought } from '../classes/thought'
import type { ToolCall } from '../classes/tool_call'
import type { Retrievable } from '../classes/retrievable'
import type {
  DispatchContextHooks,
  DispatchContextHookRegistrations,
} from '../types/dispatch_context'
import type {
  EmitMessageFn,
  EmitThoughtFn,
  EmitToolCallFn,
  EmitToolExecutionStartFn,
  EmitToolExecutionEndFn,
  OpenGateFn,
} from '../types/turn_runner'

// ── LLM-scoped callback fn types ─────────────────────────────────────────────

/** Retrieves memories for an LLM execution context. */
export type DispatchMemoryRetrievalFn = (ctx: DispatchContext) => Memory[] | Promise<Memory[]>

/** Retrieves messages for an LLM execution context. */
export type DispatchMessageRetrievalFn = (ctx: DispatchContext) => Message[] | Promise<Message[]>

/** Retrieves thoughts for an LLM execution context. */
export type DispatchThoughtRetrievalFn = (ctx: DispatchContext) => Thought[] | Promise<Thought[]>

/** Retrieves tool calls for an LLM execution context. */
export type DispatchToolCallRetrievalFn = (ctx: DispatchContext) => ToolCall[] | Promise<ToolCall[]>

/** Retrieves tools for an LLM execution context. */
export type DispatchToolsRetrievalFn = (ctx: DispatchContext) => Tool[] | Promise<Tool[]>

/** Refreshes and returns standing instructions for an LLM execution context. */
export type DispatchStandingInstructionsRefreshFn = (
  ctx: DispatchContext
) => (string | Tokenizable)[] | Promise<(string | Tokenizable)[]>

/** Stores a new standing instruction (LLM execution context variant). */
export type DispatchStandingInstructionStoreFn = (
  ctx: DispatchContext,
  v: string | Tokenizable
) => void | Promise<void>

/** Updates an existing standing instruction (LLM execution context variant). */
export type DispatchStandingInstructionMutateFn = (
  ctx: DispatchContext,
  v: string | Tokenizable
) => void | Promise<void>

/** Removes a standing instruction (LLM execution context variant). */
export type DispatchStandingInstructionDeleteFn = (
  ctx: DispatchContext,
  v: string | Tokenizable
) => void | Promise<void>

/** Stores a new memory (LLM execution context variant). */
export type DispatchMemoryStoreFn = (ctx: DispatchContext, v: Memory) => void | Promise<void>

/** Updates an existing memory (LLM execution context variant). */
export type DispatchMemoryMutateFn = (ctx: DispatchContext, v: Memory) => void | Promise<void>

/** Removes a memory by ID (LLM execution context variant). */
export type DispatchMemoryDeleteFn = (ctx: DispatchContext, id: string) => void | Promise<void>

/** Retrieves retrievable records for an LLM execution context. */
export type DispatchRetrievableRetrievalFn = (
  ctx: DispatchContext
) => Retrievable[] | Promise<Retrievable[]>

/** Stores a new retrievable record (LLM execution context variant). */
export type DispatchRetrievableStoreFn = (
  ctx: DispatchContext,
  v: Retrievable
) => void | Promise<void>

/** Updates an existing retrievable record (LLM execution context variant). */
export type DispatchRetrievableMutateFn = (
  ctx: DispatchContext,
  v: Retrievable
) => void | Promise<void>

/** Removes a retrievable record by ID (LLM execution context variant). */
export type DispatchRetrievableDeleteFn = (ctx: DispatchContext, id: string) => void | Promise<void>

/** Stores a new message (LLM execution context variant). */
export type DispatchMessageStoreFn = (ctx: DispatchContext, v: Message) => void | Promise<void>

/** Updates an existing message (LLM execution context variant). */
export type DispatchMessageMutateFn = (ctx: DispatchContext, v: Message) => void | Promise<void>

/** Removes a message by ID (LLM execution context variant). */
export type DispatchMessageDeleteFn = (ctx: DispatchContext, id: string) => void | Promise<void>

/** Stores a new thought (LLM execution context variant). */
export type DispatchThoughtStoreFn = (ctx: DispatchContext, v: Thought) => void | Promise<void>

/** Updates an existing thought (LLM execution context variant). */
export type DispatchThoughtMutateFn = (ctx: DispatchContext, v: Thought) => void | Promise<void>

/** Removes a thought by ID (LLM execution context variant). */
export type DispatchThoughtDeleteFn = (ctx: DispatchContext, id: string) => void | Promise<void>

/** Stores a new tool call (LLM execution context variant). */
export type DispatchToolCallStoreFn = (ctx: DispatchContext, v: ToolCall) => void | Promise<void>

/** Updates an existing tool call (LLM execution context variant). */
export type DispatchToolCallMutateFn = (ctx: DispatchContext, v: ToolCall) => void | Promise<void>

/** Removes a tool call by ID (LLM execution context variant). */
export type DispatchToolCallDeleteFn = (ctx: DispatchContext, id: string) => void | Promise<void>

// ── RawDispatchContext ────────────────────────────────────────────────────

/**
 * Plain input object supplied to {@link DispatchContext} at construction time.
 *
 * @remarks
 * All fetch and mutation callbacks are required — every execution context must have a persistence
 * layer wired up, even in standalone mode. Optional pre-fetched arrays populate the context's Sets
 * at construction time without replacing the callbacks (the callbacks are still invoked on
 * subsequent fetch calls).
 */
export interface RawDispatchContext {
  /** `AbortController` whose signal can cancel execution mid-flight. */
  turnAbortController?: AbortController
  /** Arbitrary key-value store for cross-step state. */
  stash?: Record<string, unknown>
  /** The system prompt for this execution. */
  systemPrompt: string | Tokenizable
  /** Standing instructions for this execution. */
  standingInstructions?: (string | Tokenizable)[]

  // Pre-fetched data (optional — populates Sets at construction)
  /** Pre-fetched memories to populate the context at construction. */
  memories?: Memory[]
  /** Pre-fetched retrievable records to populate the context at construction. */
  retrievables?: Retrievable[]
  /** Pre-fetched messages to populate the context at construction. */
  messages?: Message[]
  /** Pre-fetched thoughts to populate the context at construction. */
  thoughts?: Thought[]
  /** Pre-fetched tool calls to populate the context at construction. */
  toolCalls?: ToolCall[]
  /** Pre-fetched tools to populate the tool registry at construction. */
  tools?: Tool[]

  // Fetch callbacks (required)
  /** Retrieves memories for this execution. */
  fetchMemories: DispatchMemoryRetrievalFn
  /** Retrieves retrievable records for this execution. */
  fetchRetrievables: DispatchRetrievableRetrievalFn
  /** Retrieves messages for this execution. */
  fetchMessages: DispatchMessageRetrievalFn
  /** Retrieves thoughts for this execution. */
  fetchThoughts: DispatchThoughtRetrievalFn
  /** Retrieves tool calls for this execution. */
  fetchToolCalls: DispatchToolCallRetrievalFn
  /** Retrieves tools for this execution. */
  fetchTools: DispatchToolsRetrievalFn
  /** Refreshes and returns standing instructions for this execution. */
  refreshStandingInstructions: DispatchStandingInstructionsRefreshFn

  // Mutation callbacks (required — persistence layer; called immediately on every mutation)
  /** Stores a new standing instruction. */
  storeStandingInstruction: DispatchStandingInstructionStoreFn
  /** Updates an existing standing instruction. */
  mutateStandingInstruction: DispatchStandingInstructionMutateFn
  /** Removes a standing instruction. */
  deleteStandingInstruction: DispatchStandingInstructionDeleteFn
  /** Stores a new memory. */
  storeMemory: DispatchMemoryStoreFn
  /** Updates an existing memory. */
  mutateMemory: DispatchMemoryMutateFn
  /** Removes a memory by ID. */
  deleteMemory: DispatchMemoryDeleteFn
  /** Stores a new retrievable record. */
  storeRetrievable: DispatchRetrievableStoreFn
  /** Updates an existing retrievable record. */
  mutateRetrievable: DispatchRetrievableMutateFn
  /** Removes a retrievable record by ID. */
  deleteRetrievable: DispatchRetrievableDeleteFn
  /** Stores a new message. */
  storeMessage: DispatchMessageStoreFn
  /** Updates an existing message. */
  mutateMessage: DispatchMessageMutateFn
  /** Removes a message by ID. */
  deleteMessage: DispatchMessageDeleteFn
  /** Stores a new thought. */
  storeThought: DispatchThoughtStoreFn
  /** Updates an existing thought. */
  mutateThought: DispatchThoughtMutateFn
  /** Removes a thought by ID. */
  deleteThought: DispatchThoughtDeleteFn
  /** Stores a new tool call. */
  storeToolCall: DispatchToolCallStoreFn
  /** Updates an existing tool call. */
  mutateToolCall: DispatchToolCallMutateFn
  /** Removes a tool call by ID. */
  deleteToolCall: DispatchToolCallDeleteFn

  /** Optional hook registrations for emit events. */
  hooks?: DispatchContextHookRegistrations
  /** Optional gate suspension function. When absent, `waitFor` rejects with {@link @nhtio/adk!E_LLM_EXECUTION_GATE_NOT_SUPPORTED}. */
  waitFor?: OpenGateFn
}

const rawDispatchContextSchema = validator.object<RawDispatchContext>({
  turnAbortController: validator
    .alternatives(
      validator.object().instance(AbortController as any),
      validator.function().instance(AbortController as any)
    )
    .optional(),
  stash: validator.object().pattern(validator.string(), validator.any()).default({}),
  systemPrompt: Tokenizable.schema.required(),
  standingInstructions: validator.array().items(Tokenizable.schema).default([]),
  memories: validator.array().default([]),
  retrievables: validator.array().default([]),
  messages: validator.array().default([]),
  thoughts: validator.array().default([]),
  toolCalls: validator.array().default([]),
  tools: validator.array().default([]),
  fetchMemories: validator.function().required(),
  fetchRetrievables: validator.function().required(),
  fetchMessages: validator.function().required(),
  fetchThoughts: validator.function().required(),
  fetchToolCalls: validator.function().required(),
  fetchTools: validator.function().required(),
  refreshStandingInstructions: validator.function().required(),
  storeStandingInstruction: validator.function().required(),
  mutateStandingInstruction: validator.function().required(),
  deleteStandingInstruction: validator.function().required(),
  storeMemory: validator.function().required(),
  mutateMemory: validator.function().required(),
  deleteMemory: validator.function().required(),
  storeRetrievable: validator.function().required(),
  mutateRetrievable: validator.function().required(),
  deleteRetrievable: validator.function().required(),
  storeMessage: validator.function().required(),
  mutateMessage: validator.function().required(),
  deleteMessage: validator.function().required(),
  storeThought: validator.function().required(),
  mutateThought: validator.function().required(),
  deleteThought: validator.function().required(),
  storeToolCall: validator.function().required(),
  mutateToolCall: validator.function().required(),
  deleteToolCall: validator.function().required(),
  hooks: validator.object().optional(),
  waitFor: validator.function().optional(),
})

// ── DispatchContext ───────────────────────────────────────────────────────

/**
 * Context object for a single LLM execution call.
 *
 * @remarks
 * Mirrors the surface of {@link @nhtio/adk!TurnContext} but is path-agnostic — it knows nothing about a
 * parent context. Mutations apply to local Sets immediately, call persistence callbacks
 * immediately, and fire the corresponding mutation hook (`storedMemory`, `mutatedMemory`,
 * `deletedMemory`, etc.) in both standalone and derived dispatches.
 *
 * The {@link @nhtio/adk!DispatchRunner} is the only thing that creates a context with a parent
 * relationship: when dispatched with a `source: TurnContext`, the runner subscribes to the
 * mutation hooks, queues deltas internally, and flushes them to the parent's Sets at the end of
 * each iteration. The context itself remains unaware of the parent.
 *
 * Middleware/executor signals termination via {@link DispatchContext.ack} (clean completion)
 * or {@link DispatchContext.nack} (failure). Both set an internal flag the runner reads at
 * end-of-iteration to decide whether to loop or exit. {@link DispatchContext.isSignalled},
 * {@link DispatchContext.isAcked}, and {@link DispatchContext.nackError} are publicly
 * readable getters so middleware can inspect signal state and bail early.
 */
export class DispatchContext {
  #id: string
  #dispatchId: string
  #iteration: number
  #turnAbortController: AbortController
  #stash: Registry
  #systemPrompt: Tokenizable
  #standingInstructions: Set<Tokenizable>
  #turnMemories: Set<Memory>
  #turnRetrievables: Set<Retrievable>
  #turnMessages: Set<Message>
  #turnThoughts: Set<Thought>
  #turnToolCalls: Set<ToolCall>
  #tools: ToolRegistry
  #hooks: Hooks<DispatchContextHooks>
  #ackHandlers: Set<() => void>

  // Persistence callbacks
  #fetchMemories: DispatchMemoryRetrievalFn
  #fetchRetrievables: DispatchRetrievableRetrievalFn
  #fetchMessages: DispatchMessageRetrievalFn
  #fetchThoughts: DispatchThoughtRetrievalFn
  #fetchToolCalls: DispatchToolCallRetrievalFn
  #fetchTools: DispatchToolsRetrievalFn
  #refreshStandingInstructions: DispatchStandingInstructionsRefreshFn
  #storeStandingInstruction: DispatchStandingInstructionStoreFn
  #mutateStandingInstruction: DispatchStandingInstructionMutateFn
  #deleteStandingInstruction: DispatchStandingInstructionDeleteFn
  #storeMemory: DispatchMemoryStoreFn
  #mutateMemory: DispatchMemoryMutateFn
  #deleteMemory: DispatchMemoryDeleteFn
  #storeRetrievable: DispatchRetrievableStoreFn
  #mutateRetrievable: DispatchRetrievableMutateFn
  #deleteRetrievable: DispatchRetrievableDeleteFn
  #storeMessage: DispatchMessageStoreFn
  #mutateMessage: DispatchMessageMutateFn
  #deleteMessage: DispatchMessageDeleteFn
  #storeThought: DispatchThoughtStoreFn
  #mutateThought: DispatchThoughtMutateFn
  #deleteThought: DispatchThoughtDeleteFn
  #storeToolCall: DispatchToolCallStoreFn
  #mutateToolCall: DispatchToolCallMutateFn
  #deleteToolCall: DispatchToolCallDeleteFn
  #waitFor: OpenGateFn | undefined

  // Checksum frequency index for this execution
  #toolCallChecksums: Map<string, number>

  // Termination signal state
  #signalled: 'ack' | 'nack' | undefined
  #nackError: Error | undefined

  /**
   * @param raw - Raw input validated against the schema.
   * @throws {@link @nhtio/adk!E_INVALID_LLM_EXECUTION_CONTEXT} when `raw` does not satisfy the schema.
   */
  constructor(raw: RawDispatchContext) {
    let resolved: RawDispatchContext & {
      stash: Record<string, unknown>
      standingInstructions: (string | Tokenizable)[]
      memories: Memory[]
      retrievables: Retrievable[]
      messages: Message[]
      thoughts: Thought[]
      toolCalls: ToolCall[]
      tools: Tool[]
    }
    try {
      resolved = validateOrThrow(rawDispatchContextSchema, raw, true) as typeof resolved
    } catch (err) {
      throw new E_INVALID_LLM_EXECUTION_CONTEXT({ cause: isError(err) ? err : undefined })
    }

    this.#id = uuidv6()
    this.#dispatchId = ''
    this.#iteration = 0
    this.#turnAbortController = resolved.turnAbortController ?? new AbortController()
    this.#stash = new Registry(resolved.stash)
    this.#systemPrompt = Tokenizable.isTokenizable(resolved.systemPrompt)
      ? resolved.systemPrompt
      : new Tokenizable(resolved.systemPrompt)
    this.#standingInstructions = new Set(
      resolved.standingInstructions.map((i) =>
        Tokenizable.isTokenizable(i) ? i : new Tokenizable(i)
      )
    )
    this.#turnMemories = new Set(resolved.memories)
    this.#turnRetrievables = new Set(resolved.retrievables)
    this.#turnMessages = new Set(resolved.messages)
    this.#turnThoughts = new Set(resolved.thoughts)
    this.#turnToolCalls = new Set(resolved.toolCalls)
    this.#tools = new ToolRegistry(resolved.tools)
    this.#toolCallChecksums = new Map()
    for (const tc of resolved.toolCalls) {
      const prev = this.#toolCallChecksums.get(tc.checksum) ?? 0
      this.#toolCallChecksums.set(tc.checksum, prev + 1)
    }

    this.#fetchMemories = resolved.fetchMemories
    this.#fetchRetrievables = resolved.fetchRetrievables
    this.#fetchMessages = resolved.fetchMessages
    this.#fetchThoughts = resolved.fetchThoughts
    this.#fetchToolCalls = resolved.fetchToolCalls
    this.#fetchTools = resolved.fetchTools
    this.#refreshStandingInstructions = resolved.refreshStandingInstructions
    this.#storeStandingInstruction = resolved.storeStandingInstruction
    this.#mutateStandingInstruction = resolved.mutateStandingInstruction
    this.#deleteStandingInstruction = resolved.deleteStandingInstruction
    this.#storeMemory = resolved.storeMemory
    this.#mutateMemory = resolved.mutateMemory
    this.#deleteMemory = resolved.deleteMemory
    this.#storeRetrievable = resolved.storeRetrievable
    this.#mutateRetrievable = resolved.mutateRetrievable
    this.#deleteRetrievable = resolved.deleteRetrievable
    this.#storeMessage = resolved.storeMessage
    this.#mutateMessage = resolved.mutateMessage
    this.#deleteMessage = resolved.deleteMessage
    this.#storeThought = resolved.storeThought
    this.#mutateThought = resolved.mutateThought
    this.#deleteThought = resolved.deleteThought
    this.#storeToolCall = resolved.storeToolCall
    this.#mutateToolCall = resolved.mutateToolCall
    this.#deleteToolCall = resolved.deleteToolCall
    this.#waitFor = resolved.waitFor

    this.#signalled = undefined
    this.#nackError = undefined

    // Register hooks
    this.#hooks = new Hooks<DispatchContextHooks>()
    this.#ackHandlers = new Set()
    if (resolved.hooks) {
      const regs = resolved.hooks
      for (const key of Object.keys(regs) as (keyof DispatchContextHooks)[]) {
        const entry = regs[key]
        if (!entry) continue
        const handlers = Array.isArray(entry) ? entry : [entry]
        for (const h of handlers) {
          this.#hooks.add(key, h as any)
        }
      }
    }

    Object.defineProperties(this, {
      id: {
        get: () => this.#id,
        enumerable: true,
        configurable: false,
      },
      dispatchId: {
        get: () => this.#dispatchId,
        enumerable: true,
        configurable: false,
      },
      iteration: {
        get: () => this.#iteration,
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
      isSignalled: {
        get: () => this.#signalled !== undefined,
        enumerable: true,
        configurable: false,
      },
      isAcked: {
        get: () => this.#signalled === 'ack',
        enumerable: true,
        configurable: false,
      },
      nackError: {
        get: () => this.#nackError,
        enumerable: true,
        configurable: false,
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
      tools: {
        get: () => this.#tools,
        enumerable: true,
        configurable: false,
      },
      fetchMemories: {
        value: () => this.#fetchMemories(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchRetrievables: {
        value: () => this.#fetchRetrievables(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchMessages: {
        value: () => this.#fetchMessages(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchThoughts: {
        value: () => this.#fetchThoughts(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchToolCalls: {
        value: () => this.#fetchToolCalls(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      fetchTools: {
        value: () => this.#fetchTools(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      refreshStandingInstructions: {
        value: () => this.#refreshStandingInstructions(this),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeStandingInstruction: {
        value: (v: string | Tokenizable) => this.#doStoreStandingInstruction(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateStandingInstruction: {
        value: (v: string | Tokenizable) => this.#doMutateStandingInstruction(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteStandingInstruction: {
        value: (v: string | Tokenizable) => this.#doDeleteStandingInstruction(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeMemory: {
        value: (v: Memory) => this.#doStoreMemory(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateMemory: {
        value: (v: Memory) => this.#doMutateMemory(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteMemory: {
        value: (id: string) => this.#doDeleteMemory(id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeRetrievable: {
        value: (v: Retrievable) => this.#doStoreRetrievable(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateRetrievable: {
        value: (v: Retrievable) => this.#doMutateRetrievable(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteRetrievable: {
        value: (id: string) => this.#doDeleteRetrievable(id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeMessage: {
        value: (v: Message) => this.#doStoreMessage(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateMessage: {
        value: (v: Message) => this.#doMutateMessage(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteMessage: {
        value: (id: string) => this.#doDeleteMessage(id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeThought: {
        value: (v: Thought) => this.#doStoreThought(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateThought: {
        value: (v: Thought) => this.#doMutateThought(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteThought: {
        value: (id: string) => this.#doDeleteThought(id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      storeToolCall: {
        value: (v: ToolCall) => this.#doStoreToolCall(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      mutateToolCall: {
        value: (v: ToolCall) => this.#doMutateToolCall(v),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      deleteToolCall: {
        value: (id: string) => this.#doDeleteToolCall(id),
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitMessage: {
        value: (content: Parameters<EmitMessageFn>[0]) => {
          void this.#hooks.runner('message').run(content)
        },
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitThought: {
        value: (content: Parameters<EmitThoughtFn>[0]) => {
          void this.#hooks.runner('thought').run(content)
        },
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitToolCall: {
        value: (content: Parameters<EmitToolCallFn>[0]) => {
          void this.#hooks.runner('toolCall').run(content)
        },
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitToolExecutionStart: {
        value: (event: Parameters<EmitToolExecutionStartFn>[0]) => {
          void this.#hooks.runner('toolExecutionStart').run(event)
        },
        enumerable: true,
        configurable: false,
        writable: false,
      },
      emitToolExecutionEnd: {
        value: (event: Parameters<EmitToolExecutionEndFn>[0]) => {
          void this.#hooks.runner('toolExecutionEnd').run(event)
        },
        enumerable: true,
        configurable: false,
        writable: false,
      },
      waitFor: {
        value: <T>(gateRaw: Parameters<OpenGateFn>[0]): Promise<T> => {
          if (!this.#waitFor) {
            return Promise.reject(new E_LLM_EXECUTION_GATE_NOT_SUPPORTED())
          }
          return this.#waitFor<T>(gateRaw)
        },
        enumerable: true,
        configurable: false,
        writable: false,
      },
    })
  }

  // ── Mutation helpers ──────────────────────────────────────────────────────

  async #doStoreStandingInstruction(v: string | Tokenizable): Promise<void> {
    const t = Tokenizable.isTokenizable(v) ? v : new Tokenizable(v)
    this.#standingInstructions.add(t)
    await this.#storeStandingInstruction(this, v)
    void this.#hooks.runner('storedStandingInstruction').run(t)
  }

  async #doMutateStandingInstruction(v: string | Tokenizable): Promise<void> {
    const t = Tokenizable.isTokenizable(v) ? v : new Tokenizable(v)
    this.#standingInstructions.add(t)
    await this.#mutateStandingInstruction(this, v)
    void this.#hooks.runner('mutatedStandingInstruction').run(t)
  }

  async #doDeleteStandingInstruction(v: string | Tokenizable): Promise<void> {
    const t = Tokenizable.isTokenizable(v) ? v : new Tokenizable(v)
    this.#standingInstructions.delete(t)
    await this.#deleteStandingInstruction(this, v)
    void this.#hooks.runner('deletedStandingInstruction').run(t)
  }

  async #doStoreMemory(v: Memory): Promise<void> {
    this.#turnMemories.add(v)
    await this.#storeMemory(this, v)
    void this.#hooks.runner('storedMemory').run(v)
  }

  async #doMutateMemory(v: Memory): Promise<void> {
    this.#turnMemories.add(v)
    await this.#mutateMemory(this, v)
    void this.#hooks.runner('mutatedMemory').run(v)
  }

  async #doDeleteMemory(id: string): Promise<void> {
    for (const m of this.#turnMemories) {
      if ((m as any).id === id) {
        this.#turnMemories.delete(m)
        break
      }
    }
    await this.#deleteMemory(this, id)
    void this.#hooks.runner('deletedMemory').run(id)
  }

  async #doStoreRetrievable(v: Retrievable): Promise<void> {
    this.#turnRetrievables.add(v)
    await this.#storeRetrievable(this, v)
    void this.#hooks.runner('storedRetrievable').run(v)
  }

  async #doMutateRetrievable(v: Retrievable): Promise<void> {
    this.#turnRetrievables.add(v)
    await this.#mutateRetrievable(this, v)
    void this.#hooks.runner('mutatedRetrievable').run(v)
  }

  async #doDeleteRetrievable(id: string): Promise<void> {
    for (const r of this.#turnRetrievables) {
      if ((r as any).id === id) {
        this.#turnRetrievables.delete(r)
        break
      }
    }
    await this.#deleteRetrievable(this, id)
    void this.#hooks.runner('deletedRetrievable').run(id)
  }

  async #doStoreMessage(v: Message): Promise<void> {
    this.#turnMessages.add(v)
    await this.#storeMessage(this, v)
    void this.#hooks.runner('storedMessage').run(v)
  }

  async #doMutateMessage(v: Message): Promise<void> {
    this.#turnMessages.add(v)
    await this.#mutateMessage(this, v)
    void this.#hooks.runner('mutatedMessage').run(v)
  }

  async #doDeleteMessage(id: string): Promise<void> {
    for (const m of this.#turnMessages) {
      if ((m as any).id === id) {
        this.#turnMessages.delete(m)
        break
      }
    }
    await this.#deleteMessage(this, id)
    void this.#hooks.runner('deletedMessage').run(id)
  }

  async #doStoreThought(v: Thought): Promise<void> {
    this.#turnThoughts.add(v)
    await this.#storeThought(this, v)
    void this.#hooks.runner('storedThought').run(v)
  }

  async #doMutateThought(v: Thought): Promise<void> {
    this.#turnThoughts.add(v)
    await this.#mutateThought(this, v)
    void this.#hooks.runner('mutatedThought').run(v)
  }

  async #doDeleteThought(id: string): Promise<void> {
    for (const t of this.#turnThoughts) {
      if ((t as any).id === id) {
        this.#turnThoughts.delete(t)
        break
      }
    }
    await this.#deleteThought(this, id)
    void this.#hooks.runner('deletedThought').run(id)
  }

  async #doStoreToolCall(v: ToolCall): Promise<void> {
    this.#turnToolCalls.add(v)
    const prev = this.#toolCallChecksums.get(v.checksum) ?? 0
    this.#toolCallChecksums.set(v.checksum, prev + 1)
    await this.#storeToolCall(this, v)
    void this.#hooks.runner('storedToolCall').run(v)
  }

  async #doMutateToolCall(v: ToolCall): Promise<void> {
    // Checksum is over tool+args, which do not change on mutation — checksum map is unchanged.
    this.#turnToolCalls.add(v)
    await this.#mutateToolCall(this, v)
    void this.#hooks.runner('mutatedToolCall').run(v)
  }

  async #doDeleteToolCall(id: string): Promise<void> {
    for (const tc of this.#turnToolCalls) {
      if ((tc as any).id === id) {
        this.#turnToolCalls.delete(tc)
        const count = this.#toolCallChecksums.get(tc.checksum) ?? 1
        if (count <= 1) this.#toolCallChecksums.delete(tc.checksum)
        else this.#toolCallChecksums.set(tc.checksum, count - 1)
        break
      }
    }
    await this.#deleteToolCall(this, id)
    void this.#hooks.runner('deletedToolCall').run(id)
  }

  // ── Internal setters (used by DispatchRunner) ─────────────────────────

  /** @internal Set by {@link @nhtio/adk!DispatchRunner} after construction. */
  _setDispatchId(id: string): void {
    this.#dispatchId = id
  }

  /** @internal Updated by {@link @nhtio/adk!DispatchRunner} on each iteration. */
  _setIteration(n: number): void {
    this.#iteration = n
  }

  /** @internal Accessor used by {@link @nhtio/adk!DispatchRunner} to register forwarding handlers. */
  _getHooks(): Hooks<DispatchContextHooks> {
    return this.#hooks
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns how many times a tool call with the given checksum has been stored in this execution.
   *
   * @remarks
   * Checksums are computed over `tool + args` (see {@link @nhtio/adk!ToolCall.checksum}). This count lets
   * the executor detect repeat invocations of the same call without scanning the full Set.
   * Returns `0` when the checksum has not been seen.
   *
   * @param checksum - The `ToolCall.checksum` value to look up.
   */
  toolCallCount(checksum: string): number {
    return this.#toolCallChecksums.get(checksum) ?? 0
  }

  /**
   * Signals successful completion of this execution.
   *
   * @remarks
   * Sets the context's internal signal flag. The {@link @nhtio/adk!DispatchRunner} reads the flag at the
   * end of each iteration to decide whether to loop or exit. Calling `ack()` does NOT abort the
   * current iteration — the current pipeline and flush complete first.
   *
   * @throws {@link @nhtio/adk!E_LLM_EXECUTION_ALREADY_SIGNALLED} when the context has already been signalled
   *   (whether via `ack()` or `nack()`).
   */
  ack(): void {
    if (this.#signalled !== undefined) {
      throw new E_LLM_EXECUTION_ALREADY_SIGNALLED()
    }
    this.#signalled = 'ack'
    // Sync iteration — handlers must observe each other's side-effects in registration order
    // (e.g. ToolRegistry.bindContext relies on this for ephemeral pruning). The hook bus is
    // unsuitable here because its `await` between handlers reorders sync side-effects via
    // microtask queuing.
    for (const handler of this.#ackHandlers) {
      try {
        handler()
      } catch {
        // Swallow individual handler errors so one misbehaving subscriber can't prevent the
        // others from running. Ack itself has already succeeded.
      }
    }
  }

  /**
   * Registers a handler to run when this context completes successfully via {@link ack}.
   *
   * @remarks
   * The handler does NOT fire on {@link nack} — failed executor runs should leave any
   * ack-tied subscriptions alone so the consumer can inspect what was registered when
   * debugging the failure. Returns an unsubscribe function; subscriptions are short-lived
   * and die with the context regardless.
   *
   * The canonical consumer is `ToolRegistry.bindContext(ctx)`, which uses this hook to drop
   * ephemeral tools (notably forged artifact-query tools from `SpooledArtifact.forgeTools(ctx)`)
   * at ctx-completion. Consumers may also register custom handlers here for any per-executor
   * cleanup.
   *
   * @param handler - Callback invoked when `ack()` is called.
   * @returns An unsubscribe function that removes the handler.
   *
   * @see {@link @nhtio/adk!ToolRegistry.bindContext}
   * @see {@link @nhtio/adk!SpooledArtifact.forgeTools}
   */
  onAck(handler: () => void): () => void {
    this.#ackHandlers.add(handler)
    return () => {
      this.#ackHandlers.delete(handler)
    }
  }

  /**
   * Signals failed completion of this execution, optionally with an error.
   *
   * @remarks
   * Sets the context's internal signal flag and stores the error. The {@link @nhtio/adk!DispatchRunner}
   * reads the flag at the end of each iteration and surfaces the error via the `dispatchEnd`
   * observability payload and as the rejection reason of `dispatch()`. Calling `nack()` does NOT
   * abort the current iteration — the current pipeline and flush complete first.
   *
   * @param error - Optional error describing the failure. If omitted, a generic Error is used.
   * @throws {@link @nhtio/adk!E_LLM_EXECUTION_ALREADY_SIGNALLED} when the context has already been signalled.
   */
  nack(error?: Error): void {
    if (this.#signalled !== undefined) {
      throw new E_LLM_EXECUTION_ALREADY_SIGNALLED()
    }
    this.#signalled = 'nack'
    this.#nackError = error ?? new Error('LLM execution was nacked without an explicit error.')
  }

  /**
   * Returns `true` if `value` is a {@link DispatchContext} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety. The ADK does not export the
   * `DispatchContext` class itself as a constructable value — use this guard plus the
   * {@link DispatchContext} type for runtime detection and TypeScript narrowing.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link DispatchContext} instance.
   */
  public static isDispatchContext(value: unknown): value is DispatchContext {
    return isInstanceOf(value, 'DispatchContext', DispatchContext)
  }

  // ── declare readonly (TypeScript public surface) ──────────────────────────

  /** Unique identifier for this execution context, generated as UUIDv6 at construction time. */
  declare readonly id: string
  /** Stable identifier for the dispatch this context belongs to; set by `DispatchRunner`. */
  declare readonly dispatchId: string
  /** 0-based iteration count within the current dispatch; updated by `DispatchRunner`. */
  declare readonly iteration: number
  /** `true` when the abort controller signal has fired. */
  declare readonly aborted: boolean
  /** The `AbortSignal` from the execution's `AbortController`. */
  declare readonly abortSignal: AbortSignal
  /**
   * Aborts the dispatch's `AbortController` with the supplied reason. Middleware should call this
   * when refusing to proceed — the runner short-circuits cleanly, `dispatchEnd.status` resolves
   * to `'aborted'`, and no `error` event is emitted.
   */
  declare readonly abort: (reason?: unknown) => void
  /** `true` once {@link DispatchContext.ack} or {@link DispatchContext.nack} has been called. */
  declare readonly isSignalled: boolean
  /** `true` when the context was signalled via {@link DispatchContext.ack}. */
  declare readonly isAcked: boolean
  /** The error stored by {@link DispatchContext.nack}, or `undefined` if not nacked. */
  declare readonly nackError: Error | undefined
  /** Arbitrary key-value store for cross-step state. */
  declare readonly stash: Registry
  /** The system prompt for this execution. */
  declare readonly systemPrompt: Tokenizable
  /** Standing instructions for this execution, in insertion order. */
  declare readonly standingInstructions: Set<Tokenizable>
  /** Memories loaded for this execution. */
  declare readonly turnMemories: Set<Memory>
  /** Retrievable records loaded for this execution. */
  declare readonly turnRetrievables: Set<Retrievable>
  /** Messages loaded for this execution. */
  declare readonly turnMessages: Set<Message>
  /** Thoughts loaded for this execution. */
  declare readonly turnThoughts: Set<Thought>
  /** Tool calls loaded for this execution. */
  declare readonly turnToolCalls: Set<ToolCall>
  /** Tool registry for this execution. */
  declare readonly tools: ToolRegistry
  /** Fetches memories; delegates to the callback supplied at construction. */
  declare readonly fetchMemories: () => Memory[] | Promise<Memory[]>
  /** Fetches retrievable records; delegates to the callback supplied at construction. */
  declare readonly fetchRetrievables: () => Retrievable[] | Promise<Retrievable[]>
  /** Fetches messages; delegates to the callback supplied at construction. */
  declare readonly fetchMessages: () => Message[] | Promise<Message[]>
  /** Fetches thoughts; delegates to the callback supplied at construction. */
  declare readonly fetchThoughts: () => Thought[] | Promise<Thought[]>
  /** Fetches tool calls; delegates to the callback supplied at construction. */
  declare readonly fetchToolCalls: () => ToolCall[] | Promise<ToolCall[]>
  /** Fetches tools; delegates to the callback supplied at construction. */
  declare readonly fetchTools: () => Tool[] | Promise<Tool[]>
  /** Refreshes and returns standing instructions. */
  declare readonly refreshStandingInstructions: () =>
    | (string | Tokenizable)[]
    | Promise<(string | Tokenizable)[]>
  /** Stores a new standing instruction in the local Set and persistence layer. */
  declare readonly storeStandingInstruction: (v: string | Tokenizable) => Promise<void>
  /** Updates an existing standing instruction in the local Set and persistence layer. */
  declare readonly mutateStandingInstruction: (v: string | Tokenizable) => Promise<void>
  /** Removes a standing instruction from the local Set and persistence layer. */
  declare readonly deleteStandingInstruction: (v: string | Tokenizable) => Promise<void>
  /** Stores a new memory in the local Set and persistence layer. */
  declare readonly storeMemory: (v: Memory) => Promise<void>
  /** Updates an existing memory in the local Set and persistence layer. */
  declare readonly mutateMemory: (v: Memory) => Promise<void>
  /** Removes a memory from the local Set and persistence layer by ID. */
  declare readonly deleteMemory: (id: string) => Promise<void>
  /** Stores a new retrievable record in the local Set and persistence layer. */
  declare readonly storeRetrievable: (v: Retrievable) => Promise<void>
  /** Updates an existing retrievable record in the local Set and persistence layer. */
  declare readonly mutateRetrievable: (v: Retrievable) => Promise<void>
  /** Removes a retrievable record from the local Set and persistence layer by ID. */
  declare readonly deleteRetrievable: (id: string) => Promise<void>
  /** Stores a new message in the local Set and persistence layer. */
  declare readonly storeMessage: (v: Message) => Promise<void>
  /** Updates an existing message in the local Set and persistence layer. */
  declare readonly mutateMessage: (v: Message) => Promise<void>
  /** Removes a message from the local Set and persistence layer by ID. */
  declare readonly deleteMessage: (id: string) => Promise<void>
  /** Stores a new thought in the local Set and persistence layer. */
  declare readonly storeThought: (v: Thought) => Promise<void>
  /** Updates an existing thought in the local Set and persistence layer. */
  declare readonly mutateThought: (v: Thought) => Promise<void>
  /** Removes a thought from the local Set and persistence layer by ID. */
  declare readonly deleteThought: (id: string) => Promise<void>
  /** Stores a new tool call in the local Set and persistence layer. */
  declare readonly storeToolCall: (v: ToolCall) => Promise<void>
  /** Updates an existing tool call in the local Set and persistence layer. */
  declare readonly mutateToolCall: (v: ToolCall) => Promise<void>
  /** Removes a tool call from the local Set and persistence layer by ID. */
  declare readonly deleteToolCall: (id: string) => Promise<void>
  /** Emits a `message` hook; fires registered handlers synchronously. */
  declare readonly emitMessage: EmitMessageFn
  /** Emits a `thought` hook; fires registered handlers synchronously. */
  declare readonly emitThought: EmitThoughtFn
  /** Emits a `toolCall` hook; fires registered handlers synchronously. */
  declare readonly emitToolCall: EmitToolCallFn
  /** Emits a `toolExecutionStart` hook; fires registered handlers synchronously. */
  declare readonly emitToolExecutionStart: EmitToolExecutionStartFn
  /** Emits a `toolExecutionEnd` hook; fires registered handlers synchronously. */
  declare readonly emitToolExecutionEnd: EmitToolExecutionEndFn
  /** Opens a gate and suspends until it resolves, rejects, times out, or is aborted. */
  declare readonly waitFor: OpenGateFn
}
