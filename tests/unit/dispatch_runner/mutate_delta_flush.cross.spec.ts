import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

const now = (): DateTime => DateTime.now()

/**
 * A child DispatchContext's mutateToolCall correctly deduplicates its OWN local Set
 * (see tests/unit/contracts/dispatch_context.cross.spec.ts), but that fix is worthless if the
 * delta DispatchRunner flushes back to the parent TurnContext at the end of the iteration
 * re-introduces the exact same bug — Set.add() of a same-id replacement without first removing
 * the stale parent-side instance. TurnContext itself never mutates its own #turnToolCalls Set
 * internally; the ONLY path that keeps it in sync with a nested dispatch's mutation is
 * DispatchRunner's mutatedToolCall hook -> delta queue -> #applyDeltaToParent flush. This file
 * proves that flush path is duplicate-safe end-to-end through a real TurnRunner/DispatchRunner
 * pair, not just the isolated DispatchContext class.
 */
describe('DispatchRunner parent-flush deduplicates a mutated ToolCall by id', () => {
  it('a mutateToolCall issued mid-dispatch does not leave a stale duplicate on the parent TurnContext', async () => {
    const original = new ToolCall({
      id: 'call-flush-1',
      tool: 'sample',
      args: {},
      checksum: 'flush-1-checksum',
      isComplete: true,
      isError: false,
      results: new Tokenizable('first'),
      createdAt: now(),
      updatedAt: now(),
      completedAt: now(),
    })

    const exec = scriptedExecutor([
      { message: 'iteration one', ack: false },
      { message: 'iteration two', ack: true },
    ])

    let iterationCount = 0
    let finalToolCallIds: string[] = []

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      turnInputPipeline: [
        async (ctx, next) => {
          // Seed the REAL parent TurnContext's turnToolCalls Set directly — this is the Set
          // DispatchRunner's #applyDeltaToParent writes back into, distinct from any per-
          // iteration child DispatchContext's own local copy.
          ctx.turnToolCalls.add(original)
          return next()
        },
      ],
      turnOutputPipeline: [
        async (ctx, next) => {
          // Runs once, after the whole dispatch loop completes, on the SAME parent TurnContext
          // that was seeded above — this is what a real adapter's next history assembly would see.
          finalToolCallIds = [...ctx.turnToolCalls].map((tc) => tc.id)
          return next()
        },
      ],
      dispatchInputPipeline: [
        async (ctx, next) => {
          iterationCount++
          if (iterationCount === 1) {
            // The child DispatchContext is seeded from the parent's Set at iteration start, so
            // `original` is visible here. Mutating it queues a 'mutate' delta that DispatchRunner
            // must flush back to the parent WITHOUT leaving `original` behind as a duplicate.
            const existing = [...ctx.turnToolCalls].find((tc) => tc.id === 'call-flush-1')
            if (existing) {
              const replacement = new ToolCall({
                id: existing.id,
                tool: existing.tool,
                args: existing.args,
                checksum: existing.checksum,
                isComplete: true,
                isError: false,
                results: new Tokenizable('updated'),
                createdAt: existing.createdAt,
                updatedAt: DateTime.now(),
                completedAt: existing.completedAt ?? now(),
              })
              await ctx.mutateToolCall(replacement)
            }
          }
          return next()
        },
      ],
    })

    await run()

    expect(iterationCount).toBe(2)
    // Exactly one entry for this id must survive on the parent — not the stale original AND
    // the replacement both, which is exactly what an unfixed Set.add()-only flush would produce.
    expect(finalToolCallIds.filter((id) => id === 'call-flush-1')).toHaveLength(1)
  })
})
