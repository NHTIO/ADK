import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { Retrievable, Tokenizable } from '@nhtio/adk/common'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

const nowISO = () => DateTime.now().toISO()

const makeRetrievable = (id: string, trustTier: Retrievable['trustTier']) =>
  new Retrievable({
    id,
    content: `Body for ${id}`,
    trustTier,
    source: `src://${id}`,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  })

describe('Retrievable through TurnRunner (offline)', () => {
  describe('fetch callback wiring', () => {
    it('fetchRetrievablesCallback is called once during input phase and seeds turnRetrievables', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      let fetchCalls = 0
      const r1 = makeRetrievable('ret-1', 'first-party')
      const r2 = makeRetrievable('ret-2', 'third-party-public')

      const { run, runner } = makeFixtureRunner({
        executorCallback: exec,
        fetchRetrievablesCallback: () => {
          fetchCalls += 1
          return [r1, r2]
        },
        turnOutputPipeline: [
          async (ctx, next) => {
            expect(ctx.turnRetrievables.has(r1)).toBe(true)
            expect(ctx.turnRetrievables.has(r2)).toBe(true)
            expect(ctx.turnRetrievables.size).toBe(2)
            return next()
          },
        ],
      })

      await run()
      expect(fetchCalls).toBe(1)
      expect(runner).toBeDefined()
    })

    it('with no fetchRetrievablesCallback, turnRetrievables is empty', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        turnOutputPipeline: [
          async (ctx, next) => {
            expect(ctx.turnRetrievables.size).toBe(0)
            return next()
          },
        ],
      })

      await run()
    })
  })

  describe('mutation callback wiring', () => {
    it('ctx.storeRetrievable routes to storeRetrievableCallback with (ctx, retrievable)', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const stored: Array<{ id: string; tier: string }> = []
      const r = makeRetrievable('ret-store-1', 'first-party')

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        storeRetrievableCallback: async (_ctx, v) => {
          stored.push({ id: v.id, tier: v.trustTier })
        },
        turnInputPipeline: [
          async (ctx, next) => {
            await ctx.storeRetrievable(r)
            return next()
          },
        ],
      })

      await run()
      expect(stored).toEqual([{ id: 'ret-store-1', tier: 'first-party' }])
    })

    it('ctx.mutateRetrievable routes to mutateRetrievableCallback with the updated value', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const mutated: string[] = []
      const r = makeRetrievable('ret-mut-1', 'third-party-public')

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        mutateRetrievableCallback: async (_ctx, v) => {
          mutated.push(`${v.id}:${v.trustTier}`)
        },
        turnInputPipeline: [
          async (ctx, next) => {
            await ctx.mutateRetrievable(r)
            return next()
          },
        ],
      })

      await run()
      expect(mutated).toEqual(['ret-mut-1:third-party-public'])
    })

    it('ctx.deleteRetrievable routes to deleteRetrievableCallback with the id', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const deleted: string[] = []

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        deleteRetrievableCallback: async (_ctx, id) => {
          deleted.push(id)
        },
        turnInputPipeline: [
          async (ctx, next) => {
            await ctx.deleteRetrievable('ret-del-1')
            await ctx.deleteRetrievable('ret-del-2')
            return next()
          },
        ],
      })

      await run()
      expect(deleted).toEqual(['ret-del-1', 'ret-del-2'])
    })

    it('mutation callbacks each receive the live TurnContext as first argument', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      let receivedStoreCtx: unknown
      let receivedMutateCtx: unknown
      let receivedDeleteCtx: unknown
      const r = makeRetrievable('ret-ctx-check', 'third-party-private')

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        storeRetrievableCallback: async (ctx, _v) => {
          receivedStoreCtx = ctx
        },
        mutateRetrievableCallback: async (ctx, _v) => {
          receivedMutateCtx = ctx
        },
        deleteRetrievableCallback: async (ctx, _id) => {
          receivedDeleteCtx = ctx
        },
        turnInputPipeline: [
          async (ctx, next) => {
            await ctx.storeRetrievable(r)
            await ctx.mutateRetrievable(r)
            await ctx.deleteRetrievable(r.id)
            return next()
          },
        ],
      })

      await run()
      // The three callbacks received the same context object.
      expect(receivedStoreCtx).toBe(receivedMutateCtx)
      expect(receivedMutateCtx).toBe(receivedDeleteCtx)
      // It exposes the retrievable surface (so it's a TurnContext, not a stub).
      expect(typeof (receivedStoreCtx as { storeRetrievable: unknown }).storeRetrievable).toBe(
        'function'
      )
    })
  })

  describe('Set semantics', () => {
    it('turnRetrievables is a Set — same retrievable added twice only counts once', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const r = makeRetrievable('ret-once', 'first-party')

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        fetchRetrievablesCallback: () => [r, r],
        turnOutputPipeline: [
          async (ctx, next) => {
            expect(ctx.turnRetrievables.size).toBe(1)
            return next()
          },
        ],
      })

      await run()
    })

    it('middleware can add additional retrievables to turnRetrievables via the Set reference', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const r1 = makeRetrievable('ret-seed', 'first-party')
      const r2 = makeRetrievable('ret-added', 'third-party-public')

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        fetchRetrievablesCallback: () => [r1],
        turnInputPipeline: [
          async (ctx, next) => {
            ctx.turnRetrievables.add(r2)
            return next()
          },
        ],
        turnOutputPipeline: [
          async (ctx, next) => {
            expect(ctx.turnRetrievables.size).toBe(2)
            expect(ctx.turnRetrievables.has(r1)).toBe(true)
            expect(ctx.turnRetrievables.has(r2)).toBe(true)
            return next()
          },
        ],
      })

      await run()
    })
  })

  describe('trust-tier preservation', () => {
    it('all three trust tiers survive the round-trip from fetch through middleware', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const r1 = makeRetrievable('ret-fp', 'first-party')
      const r2 = makeRetrievable('ret-pub', 'third-party-public')
      const r3 = makeRetrievable('ret-pri', 'third-party-private')

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        fetchRetrievablesCallback: () => [r1, r2, r3],
        turnOutputPipeline: [
          async (ctx, next) => {
            const tiers = [...ctx.turnRetrievables].map((r) => r.trustTier).sort()
            expect(tiers).toEqual(['first-party', 'third-party-private', 'third-party-public'])
            return next()
          },
        ],
      })

      await run()
    })

    it('a Tokenizable-bodied retrievable survives the round-trip with content reference intact', async () => {
      const exec = scriptedExecutor([{ message: 'ok', ack: true }])
      const tk = new Tokenizable('pre-wrapped body')
      const r = new Retrievable({
        id: 'ret-tk',
        content: tk,
        trustTier: 'first-party',
        createdAt: nowISO(),
        updatedAt: nowISO(),
      })

      const { run } = makeFixtureRunner({
        executorCallback: exec,
        fetchRetrievablesCallback: () => [r],
        turnOutputPipeline: [
          async (ctx, next) => {
            const seen = [...ctx.turnRetrievables][0]
            expect(seen.content).toBe(tk)
            return next()
          },
        ],
      })

      await run()
    })
  })
})
