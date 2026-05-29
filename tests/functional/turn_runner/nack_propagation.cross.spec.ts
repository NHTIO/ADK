import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: nack propagation', () => {
  it('runner.run() resolves (does not throw) when the executor nacks', async () => {
    const exec = scriptedExecutor([{ nack: new Error('boom') }])
    const { run } = makeFixtureRunner({ executorCallback: exec })
    // Notable contract: run() resolves successfully even on nack — errors surface via events.
    await expect(run()).resolves.toBeUndefined()
  })

  it('emits an error event on the observability bus when the executor nacks', async () => {
    const exec = scriptedExecutor([{ nack: new Error('engine failure') }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const errors = events.filter((e) => e.kind === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  it('dispatchEnd carries status "nack" and the original error', async () => {
    const cause = new Error('engine failure')
    const exec = scriptedExecutor([{ nack: cause }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const dispatchEnd = events.find((e) => e.kind === 'dispatchEnd')
    expect(dispatchEnd).toBeDefined()
    const payload = dispatchEnd!.payload as { status: string; error?: Error }
    expect(payload.status).toBe('nack')
    expect(payload.error).toBe(cause)
  })

  it('turnEnd still fires exactly once when the dispatch nacks', async () => {
    const exec = scriptedExecutor([{ nack: new Error('boom') }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
  })
})
