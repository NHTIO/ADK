import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall, Tokenizable } from '@nhtio/adk/common'
import { makeFixtureRunner } from '../../_fixtures/runner'

const makeCall = (id: string, checksum = id): ToolCall =>
  new ToolCall({
    id,
    tool: 'sample',
    args: { checksum },
    checksum,
    isComplete: true,
    isError: false,
    results: new Tokenizable('done'),
    createdAt: DateTime.now(),
    updatedAt: DateTime.now(),
    completedAt: DateTime.now(),
  })

describe('DispatchRunner replaceToolCallGroup integration', () => {
  it('forwards replacement hooks to the parent turn with the deleted id and stored replacements', async () => {
    const originalA = makeCall('group-call-a', 'old-a')
    const originalB = makeCall('group-call-b', 'old-b')
    const replacementA = makeCall('replacement-a', 'new-a')
    const replacementB = makeCall('replacement-b', 'new-b')
    let replacements: ToolCall[] = []
    let seeded = false

    const { run } = makeFixtureRunner({
      executorCallback: async (ctx) => {
        if (ctx.iteration === 0) {
          await ctx.replaceToolCallGroup(
            ['group-call-a', 'group-call-b'],
            [replacementA, replacementB]
          )
        }
        ctx.ack()
      },
      turnInputPipeline: [
        async (ctx, next) => {
          if (!seeded) {
            seeded = true
            ctx.turnToolCalls.add(originalA)
            ctx.turnToolCalls.add(originalB)
          }
          return next()
        },
      ],
      turnOutputPipeline: [
        async (ctx, next) => {
          replacements = [...ctx.turnToolCalls]
          return next()
        },
      ],
    })

    await run()

    expect(replacements).toEqual([replacementA, replacementB])
    expect(replacements).not.toContain(originalA)
    expect(replacements).not.toContain(originalB)
  })

  it.each([true, false])(
    'uses the configured transactional callback when present, and degraded writes when absent (%s)',
    async (hasTransactionalCallback) => {
      const originalA = makeCall('group-call-a', 'old-a')
      const originalB = makeCall('group-call-b', 'old-b')
      const replacement = makeCall('replacement', 'new')
      const transactional = vi.fn(
        async (_ctx: unknown, _ids: readonly string[], _replacements: readonly ToolCall[]) => {}
      )
      const deleted: string[] = []
      const stored: ToolCall[] = []
      let finalCalls: ToolCall[] = []
      let seeded = false

      const { run } = makeFixtureRunner({
        executorCallback: async (ctx) => {
          if (ctx.iteration === 0) {
            await ctx.replaceToolCallGroup(['group-call-a', 'group-call-b'], [replacement])
          }
          ctx.ack()
        },
        replaceToolCallGroupCallback: hasTransactionalCallback
          ? async (ctx, ids, replacements) => transactional(ctx, ids, replacements)
          : undefined,
        deleteToolCallCallback: async (_ctx, id) => {
          deleted.push(id)
        },
        storeToolCallCallback: async (_ctx, call) => {
          stored.push(call)
        },
        turnInputPipeline: [
          async (ctx, next) => {
            if (!seeded) {
              seeded = true
              ctx.turnToolCalls.add(originalA)
              ctx.turnToolCalls.add(originalB)
            }
            return next()
          },
        ],
        turnOutputPipeline: [
          async (ctx, next) => {
            finalCalls = [...ctx.turnToolCalls]
            return next()
          },
        ],
      })

      await run()

      expect(finalCalls).toEqual([replacement])
      if (hasTransactionalCallback) {
        expect(transactional).toHaveBeenCalledWith(
          expect.any(Object),
          ['group-call-a', 'group-call-b'],
          [replacement]
        )
        expect(deleted).toEqual([])
        expect(stored).toEqual([])
      } else {
        expect(transactional).not.toHaveBeenCalled()
        expect(deleted).toEqual(['group-call-a', 'group-call-b'])
        expect(stored).toEqual([replacement])
      }
    }
  )

  it.each([true, false])(
    'keeps TURN state in step with persistence on a group replacement (transactional=%s)',
    async (hasTransactionalCallback) => {
      // TurnContext.replaceToolCallGroup persisted the replacement but left `turnToolCalls`
      // holding the calls it had just renamed away. `#doStoreToolCall`/`#doMutateToolCall` both
      // maintain that Set, so skipping it here meant a later dispatch — seeded from this turn —
      // would re-process the stale colliding members and diverge from what was stored.
      const originalA = makeCall('turn-call-a', 'old-a')
      const originalB = makeCall('turn-call-b', 'old-b')
      const replacement = makeCall('turn-replacement', 'new')
      let observed: ToolCall[] = []

      const { run } = makeFixtureRunner({
        executorCallback: async (ctx) => ctx.ack(),
        ...(hasTransactionalCallback
          ? {
              replaceToolCallGroupCallback: async (
                _ctx: unknown,
                _ids: readonly string[],
                _replacements: readonly ToolCall[]
              ) => {},
            }
          : {}),
        turnInputPipeline: [
          async (ctx, next) => {
            ctx.turnToolCalls.add(originalA)
            ctx.turnToolCalls.add(originalB)
            await ctx.replaceToolCallGroup(['turn-call-a', 'turn-call-b'], [replacement])
            observed = [...ctx.turnToolCalls]
            return next()
          },
        ],
      })

      await run()

      expect(observed).toEqual([replacement])
      expect(observed).not.toContain(originalA)
      expect(observed).not.toContain(originalB)
    }
  )
})
