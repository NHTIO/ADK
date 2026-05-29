import { isInstanceOf } from '@nhtio/adk'
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: pipeline short-circuit detection', () => {
  it('emits E_PIPELINE_SHORT_CIRCUITED when an input middleware skips next()', async () => {
    const exec = scriptedExecutor([{ message: 'should not reach', ack: true }])
    let executorCalled = false
    const wrapped = async (...args: Parameters<typeof exec>): Promise<void> => {
      executorCalled = true
      await exec(...args)
    }
    const { run, events } = makeFixtureRunner({
      executorCallback: wrapped,
      turnInputPipeline: [
        async () => {
          // forget to call next()
        },
      ],
    })

    await run()

    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(isInstanceOf(errors[0].payload, 'E_PIPELINE_SHORT_CIRCUITED')).toBe(true)
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
    // dispatch was skipped because the input pipeline failed
    expect(executorCalled).toBe(false)
    expect(events.filter((e) => e.kind === 'dispatchStart')).toHaveLength(0)
  })

  it('emits E_PIPELINE_SHORT_CIRCUITED when an output middleware skips next()', async () => {
    const exec = scriptedExecutor([{ message: 'hi', ack: true }])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      turnOutputPipeline: [
        async () => {
          // forget to call next()
        },
      ],
    })

    await run()

    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(isInstanceOf(errors[0].payload, 'E_PIPELINE_SHORT_CIRCUITED')).toBe(true)
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
  })

  it('does NOT emit E_PIPELINE_SHORT_CIRCUITED when an input middleware aborts the turn', async () => {
    const exec = scriptedExecutor([{ message: 'should not reach', ack: true }])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      turnInputPipeline: [
        async (ctx) => {
          ctx.abort(new Error('deliberate refusal'))
        },
      ],
    })

    await run()

    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
  })

  it('skips downstream input middlewares once the turn is aborted, without emitting an error', async () => {
    const exec = scriptedExecutor([{ message: 'should not reach', ack: true }])
    let downstreamRan = false
    let downstreamPostRan = false
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      turnInputPipeline: [
        async (ctx, next) => {
          ctx.abort(new Error('deliberate refusal'))
          await next()
        },
        async (_ctx, next) => {
          downstreamRan = true
          await next()
          downstreamPostRan = true
        },
      ],
    })

    await run()

    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(0)
    expect(downstreamRan).toBe(false)
    expect(downstreamPostRan).toBe(false)
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'dispatchStart')).toHaveLength(0)
  })

  it('aborting in middleware A still runs A own post-step (mid-flight cleanup is intact)', async () => {
    const exec = scriptedExecutor([{ message: 'should not reach', ack: true }])
    let aPostRan = false
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      turnInputPipeline: [
        async (ctx, next) => {
          ctx.abort(new Error('deliberate refusal'))
          await next()
          aPostRan = true
        },
      ],
    })

    await run()

    expect(aPostRan).toBe(true)
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)
  })

  it('does NOT emit E_PIPELINE_SHORT_CIRCUITED on the happy path', async () => {
    const exec = scriptedExecutor([{ message: 'hi', ack: true }])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      turnInputPipeline: [
        async (_ctx, next) => {
          await next()
        },
      ],
      turnOutputPipeline: [
        async (_ctx, next) => {
          await next()
        },
      ],
    })

    await run()

    const errors = events.filter((e) => e.kind === 'error')
    expect(errors).toHaveLength(0)
  })
})
