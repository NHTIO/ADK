import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall } from '../../../src/lib/classes/tool_call'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { TurnContext } from '../../../src/lib/contracts/turn_runner_context'
import { E_ARTIFACT_ID_COLLISION } from '../../../src/lib/exceptions/runtime'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'

const makeRetrievable = (id: string, content: string = 'content') =>
  new Retrievable({
    id,
    content,
    trustTier: 'first-party',
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
  })

const makeToolCall = (id: string) =>
  new ToolCall({
    id,
    tool: 'sample',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('done'),
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
    completedAt: DateTime.now(),
  })

const makeContext = (fetchRetrievables: (ctx: TurnContext) => unknown[] = () => []) => {
  const storeRetrievableBytes = vi.fn(
    (_id: string, bytes: string) => new InMemorySpoolReader(bytes)
  )
  const noop = async () => {}
  const ctx = new TurnContext(
    {
      turnAbortController: new AbortController(),
      systemPrompt: 'test',
      standingInstructions: [],
    },
    {
      fetchMemories: async () => [],
      fetchMessages: async () => [],
      fetchThoughts: async () => [],
      fetchToolCalls: async () => [],
      fetchTools: async () => [],
      refreshStandingInstructions: async () => [],
      fetchRetrievables,
      storeStandingInstruction: noop,
      mutateStandingInstruction: noop,
      deleteStandingInstruction: noop,
      storeMemory: noop,
      mutateMemory: noop,
      deleteMemory: noop,
      storeRetrievable: noop,
      mutateRetrievable: noop,
      deleteRetrievable: noop,
      storeMessage: noop,
      mutateMessage: noop,
      deleteMessage: noop,
      storeThought: noop,
      mutateThought: noop,
      deleteThought: noop,
      storeToolCall: noop,
      mutateToolCall: noop,
      deleteToolCall: noop,
      storeMediaBytes: async () => ({}) as never,
      storeRetrievableBytes,
      emitMessage: noop,
      emitThought: noop,
      emitToolCall: noop,
      emitToolExecutionStart: noop,
      emitToolExecutionEnd: noop,
      openGate: noop,
      tools: { all: () => [] } as never,
    } as never
  )
  return { ctx, storeRetrievableBytes }
}

describe('TurnContext retrievable and artifact bookkeeping', () => {
  it('rejects a retrievable colliding with an existing tool call immediately', async () => {
    const { ctx } = makeContext()
    await ctx.storeToolCall(makeToolCall('same-id'))
    await expect(ctx.storeRetrievable(makeRetrievable('same-id'))).rejects.toBeInstanceOf(
      E_ARTIFACT_ID_COLLISION
    )
  })

  it('rejects a tool call colliding with an existing retrievable immediately', async () => {
    const { ctx } = makeContext()
    await ctx.storeRetrievable(makeRetrievable('same-id'))
    await expect(ctx.storeToolCall(makeToolCall('same-id'))).rejects.toBeInstanceOf(
      E_ARTIFACT_ID_COLLISION
    )
  })

  it('stores and mutates the normalized instance in the turn set and returns it', async () => {
    const { ctx } = makeContext()
    const stored = await ctx.storeRetrievable(makeRetrievable('stored'))
    expect([...ctx.turnRetrievables]).toContain(stored)
    expect([...ctx.turnRetrievables][0]).toBe(stored)

    const mutated = await ctx.mutateRetrievable(makeRetrievable('stored', 'updated'))
    expect([...ctx.turnRetrievables]).toHaveLength(1)
    expect([...ctx.turnRetrievables][0]).toBe(mutated)
    expect(mutated).not.toBe(stored)
  })

  it('checks fetched duplicate ids before any spool write', async () => {
    const { ctx, storeRetrievableBytes } = makeContext(() => [
      makeRetrievable('duplicate'),
      makeRetrievable('duplicate'),
    ])
    await expect(ctx.fetchRetrievables()).rejects.toThrow('Duplicate retrievable id: duplicate')
    expect(storeRetrievableBytes).not.toHaveBeenCalled()
  })

  it('auto-spools fetched plain-string content before returning it', async () => {
    const { ctx, storeRetrievableBytes } = makeContext(() => [
      makeRetrievable('fetched', 'plain text'),
    ])
    const [result] = await ctx.fetchRetrievables()
    expect(result.content).toBeInstanceOf(SpooledArtifact)
    expect(storeRetrievableBytes).toHaveBeenCalledOnce()
  })
})
