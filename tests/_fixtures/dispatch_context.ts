import { isInstanceOf } from '../../src/lib/utils/guards'
import { inMemoryMediaReader } from '../../src/lib/helpers/media_readers'
import { DispatchContext } from '../../src/lib/contracts/dispatch_context'
import { InMemorySpoolStore } from '../../src/batteries/storage/in_memory'
import type { ConduitBytes, RawDispatchContext } from '../../src/lib/contracts/dispatch_context'

/** Drains a `ConduitBytes` value to a `Uint8Array` for the stub media conduit. */
const toBytes = async (bytes: ConduitBytes): Promise<Uint8Array> => {
  if (typeof bytes === 'string') return new TextEncoder().encode(bytes)
  if (!isInstanceOf(bytes, 'ReadableStream', ReadableStream)) return bytes
  const chunks: Uint8Array[] = []
  const reader = bytes.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

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
    storeMediaBytes: async (_ctx, _id, bytes) => inMemoryMediaReader(await toBytes(bytes)),
    storeRetrievableBytes: (_ctx, id, bytes) => new InMemorySpoolStore().write(id, bytes),
    ...overrides,
  }
  return new DispatchContext(raw)
}
