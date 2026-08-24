import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: pipeline middleware survives multiple run() calls', () => {
  it('re-executes the input and output pipelines on every run(), not just the first', async () => {
    let inputRuns = 0
    let outputRuns = 0
    const { run } = makeFixtureRunner({
      // Each run() call constructs a fresh DispatchContext (ctx.iteration resets to 0), so a
      // single-step script is consumed identically on every call.
      executorCallback: scriptedExecutor([{ message: 'hi', ack: true }]),
      turnInputPipeline: [
        async (_ctx, next) => {
          inputRuns++
          await next()
        },
      ],
      turnOutputPipeline: [
        async (_ctx, next) => {
          outputRuns++
          await next()
        },
      ],
    })

    // A single TurnRunner instance backs every `run()` call below. Before the fix, TurnRunner
    // cached a single Runner<TurnPipelineMiddlewareFn> per pipeline in its constructor; a
    // Runner's internal cursor never resets across .run() invocations, so every call after the
    // first silently skipped all configured middleware.
    await run()
    expect(inputRuns).toBe(1)
    expect(outputRuns).toBe(1)

    await run()
    expect(inputRuns).toBe(2)
    expect(outputRuns).toBe(2)

    await run()
    expect(inputRuns).toBe(3)
    expect(outputRuns).toBe(3)
  })
})
