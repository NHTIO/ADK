import { describe, expect, it } from 'vitest'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import type { RawDispatchContext } from '../../../src/lib/contracts/dispatch_context'
import type {
  DispatchExecutorFn,
  DispatchPipelineMiddlewareFn,
} from '../../../src/lib/types/dispatch_runner'

const makeRaw = (): Omit<RawDispatchContext, 'hooks'> => ({
  systemPrompt: 'test',
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
  storeMediaBytes: () => {
    throw new Error('storeMediaBytes not used in this test')
  },
  storeRetrievableBytes: () => {
    throw new Error('storeRetrievableBytes not used in this test')
  },
})

// Regression: the dispatch loop runs the input/output pipelines once PER
// iteration. DispatchRunner used to build the @nhtio/middleware Runner ONCE in
// its constructor and call .run() on that single instance every iteration. A
// Runner is single-use — its internal cursor is never reset by run() — so every
// iteration after the 0th executed ZERO middleware. That silently broke the
// canonical "output-pipeline quality gate withholds ack to drive a retry"
// pattern: the gate only ran on iteration 0, never re-acked, and the loop ran
// unbounded. The fix derives a FRESH runner from the held Middleware each
// iteration. These tests pin that behavior.
describe('DispatchRunner — pipelines run every iteration (not just the first)', () => {
  it('runs the output pipeline on EACH iteration, so a withhold-ack-then-ack gate terminates', async () => {
    let executorCalls = 0
    const executor: DispatchExecutorFn = (_ctx) => {
      executorCalls++
      // Deliberately do NOT ack here — the output gate owns completion.
    }

    const gateCalls: number[] = []
    const gate: DispatchPipelineMiddlewareFn = async (ctx, next) => {
      gateCalls.push(ctx.iteration)
      // Iteration 0: withhold ack → loop must iterate again.
      // Iteration 1: ack → loop terminates.
      if (ctx.iteration >= 1) ctx.ack()
      await next()
    }

    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      turnOutputPipeline: [gate],
    })

    // If the runner were reused (the bug), the gate would fire only on
    // iteration 0, never ack, and this dispatch would hang forever.
    expect(gateCalls).toEqual([0, 1])
    expect(executorCalls).toBe(2)
  })

  it('runs the input pipeline on EACH iteration', async () => {
    const inputCalls: number[] = []
    const input: DispatchPipelineMiddlewareFn = async (ctx, next) => {
      inputCalls.push(ctx.iteration)
      await next()
    }
    const gate: DispatchPipelineMiddlewareFn = async (ctx, next) => {
      if (ctx.iteration >= 2) ctx.ack()
      await next()
    }
    const executor: DispatchExecutorFn = () => {}

    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      turnInputPipeline: [input],
      turnOutputPipeline: [gate],
    })

    // Input pipeline must run on every iteration up to and including the one
    // that acks (0, 1, 2) — not only on iteration 0.
    expect(inputCalls).toEqual([0, 1, 2])
  })

  it('runs ALL output middleware (not just the first) on later iterations', async () => {
    const aCalls: number[] = []
    const bCalls: number[] = []
    const a: DispatchPipelineMiddlewareFn = async (_ctx, next) => {
      aCalls.push(_ctx.iteration)
      await next()
    }
    const b: DispatchPipelineMiddlewareFn = async (ctx, next) => {
      bCalls.push(ctx.iteration)
      if (ctx.iteration >= 1) ctx.ack()
      await next()
    }
    const executor: DispatchExecutorFn = () => {}

    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      turnOutputPipeline: [a, b],
    })

    // Both middleware run on both iterations; the cursor must reset each pass.
    expect(aCalls).toEqual([0, 1])
    expect(bCalls).toEqual([0, 1])
  })
})
