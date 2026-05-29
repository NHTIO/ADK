import { DispatchContext } from '../../src/lib/contracts/dispatch_context'
import type { RawDispatchContext } from '../../src/lib/contracts/dispatch_context'

/**
 * Overrides accepted by {@link makeDispatchContext}. Anything you pass replaces the
 * corresponding stubbed field on the resulting raw input.
 */
export type DispatchContextOverrides = Partial<RawDispatchContext>

/**
 * Builds a real {@link DispatchContext} with no-op persistence callbacks suitable for unit
 * tests that need a fully-functional context (ack/nack signal flow, hook machinery,
 * `turnToolCalls` Set, etc.) without dragging in a full {@link import('../../src/lib/turn_runner').TurnRunner}
 * dispatch.
 *
 * @remarks
 * Every required fetch and mutation callback is stubbed: fetches resolve to empty arrays, mutations
 * resolve to `undefined`. The `systemPrompt` defaults to `'test prompt'`. Pass any override field to
 * customise — including `hooks`, `tools`, pre-fetched `toolCalls`, etc.
 *
 * The returned context's `ack()` and `nack()` flow exactly as in production, so this fixture is
 * the canonical way to unit-test code that subscribes via `ctx.onAck(...)` or `ToolRegistry.bindContext(ctx)`.
 *
 * @param overrides - Optional partial raw input. Replaces stub defaults field-by-field.
 * @returns A fully-constructed {@link DispatchContext}.
 */
export const makeDispatchContext = (overrides: DispatchContextOverrides = {}): DispatchContext => {
  const raw: RawDispatchContext = {
    systemPrompt: 'test prompt',
    fetchMemories: async () => [],
    fetchMessages: async () => [],
    fetchThoughts: async () => [],
    fetchToolCalls: async () => [],
    fetchTools: async () => [],
    refreshStandingInstructions: async () => [],
    storeStandingInstruction: async () => {},
    mutateStandingInstruction: async () => {},
    deleteStandingInstruction: async () => {},
    storeMemory: async () => {},
    mutateMemory: async () => {},
    deleteMemory: async () => {},
    fetchRetrievables: async () => [],
    storeRetrievable: async () => {},
    mutateRetrievable: async () => {},
    deleteRetrievable: async () => {},
    storeMessage: async () => {},
    mutateMessage: async () => {},
    deleteMessage: async () => {},
    storeThought: async () => {},
    mutateThought: async () => {},
    deleteThought: async () => {},
    storeToolCall: async () => {},
    mutateToolCall: async () => {},
    deleteToolCall: async () => {},
    ...overrides,
  }
  return new DispatchContext(raw)
}
