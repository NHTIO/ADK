import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { TurnContext } from '../../../src/lib/contracts/turn_runner_context'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import type { DispatchExecutorFn } from '../../../src/lib/types/dispatch_runner'

// DispatchRunner.dispatch({ source }) snapshots source.turnRetrievables into a fresh
// DispatchContext, then spools that snapshot via normalizeRetrievables (Decision A.5's preload
// normalization phase). Without writing the spooled result back onto the SOURCE TurnContext's own
// Set, every subsequent dispatch from the same TurnContext re-snapshots the ORIGINAL, still-plain
// Tokenizable content and re-spools it from scratch -- a fresh store write and a fresh
// SpooledArtifact instance every time, never reusing the artifact handle already produced.

const makeContext = () => {
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
      fetchRetrievables: async () => [],
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

const noopExecutor: DispatchExecutorFn = (ctx) => {
  ctx.ack()
}

describe('DispatchRunner.dispatch — preload retrievable retention on the source TurnContext', () => {
  it('writes the spooled record back onto source.turnRetrievables, so a second dispatch reuses the artifact handle instead of re-spooling', async () => {
    const { ctx, storeRetrievableBytes } = makeContext()
    ctx.turnRetrievables.add(
      new Retrievable({
        id: 'preload-1',
        content: 'plain string content',
        trustTier: 'first-party',
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      })
    )

    await DispatchRunner.dispatch({ source: ctx, executor: noopExecutor })
    expect(storeRetrievableBytes).toHaveBeenCalledTimes(1)

    const afterFirst = [...ctx.turnRetrievables]
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]!.content).toBeInstanceOf(SpooledArtifact)
    const spooledOnce = afterFirst[0]!.content

    await DispatchRunner.dispatch({ source: ctx, executor: noopExecutor })
    // Same underlying artifact handle reused — no second store write for content already spooled.
    expect(storeRetrievableBytes).toHaveBeenCalledTimes(1)
    const afterSecond = [...ctx.turnRetrievables]
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0]!.content).toBe(spooledOnce)
  })
})
