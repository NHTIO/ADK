import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: abort signal', () => {
  it('a pre-aborted controller short-circuits the dispatch loop', async () => {
    // If we abort before run() is called, the runner should still produce a turnStart/turnEnd
    // and not loop indefinitely.
    const controller = new AbortController()
    controller.abort()
    // The script wants to keep looping ("never acks") — only the abort can terminate it.
    const exec = scriptedExecutor([{ message: 'one' }, { message: 'two' }, { message: 'three' }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run({ turnAbortController: controller })

    expect(events.filter((e) => e.kind === 'turnStart')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
  })

  it('aborting mid-dispatch (between iterations) terminates the loop', async () => {
    const controller = new AbortController()
    // Sentinel: how many times the executor ran. If abort works, the executor never sees
    // ctx.iteration past the abort point.
    let executorRunCount = 0
    const exec = scriptedExecutor([
      // Each step intentionally doesn't ack — we want the abort to be the termination cause.
      { message: 'one' },
      { message: 'two' },
      { message: 'three' },
    ])
    const wrapped = async (...args: Parameters<typeof exec>): Promise<void> => {
      executorRunCount++
      // Abort before the second iteration starts.
      if (executorRunCount === 1) {
        // schedule abort *after* this iteration returns
        queueMicrotask(() => controller.abort())
      }
      await exec(...args)
    }

    const { run, events } = makeFixtureRunner({ executorCallback: wrapped })

    await run({ turnAbortController: controller })

    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
    // The executor ran at least once but the abort prevented an unbounded loop.
    expect(executorRunCount).toBeGreaterThanOrEqual(1)
  })
})
