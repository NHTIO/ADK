import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: basic dispatch', () => {
  it('runs a single-iteration "hi" → ack scenario end-to-end', async () => {
    const exec = scriptedExecutor([{ message: 'Hi.', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const turnStartCount = events.filter((e) => e.kind === 'turnStart').length
    const turnEndCount = events.filter((e) => e.kind === 'turnEnd').length
    expect(turnStartCount).toBe(1)
    expect(turnEndCount).toBe(1)
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'dispatchStart')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'dispatchEnd')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'iterationStart')).toHaveLength(1)
    // iterationEnd does NOT fire when the executor signals ack — the runner short-circuits the
    // iteration immediately after the executor returns when ctx.isSignalled is set.
    expect(events.filter((e) => e.kind === 'iterationEnd')).toHaveLength(0)
  })

  it('emits the message content via the functional bus', async () => {
    const exec = scriptedExecutor([{ message: 'Hello world.', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const messages = events.filter((e) => e.kind === 'message')
    expect(messages).toHaveLength(1)
    expect((messages[0].payload as { full: string }).full).toBe('Hello world.')
    expect((messages[0].payload as { isComplete: boolean }).isComplete).toBe(true)
  })

  it('reports dispatchEnd with status "ack" when the executor acks', async () => {
    const exec = scriptedExecutor([{ message: 'done', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const dispatchEnd = events.find((e) => e.kind === 'dispatchEnd')
    expect(dispatchEnd).toBeDefined()
    expect((dispatchEnd!.payload as { status: string }).status).toBe('ack')
  })

  it('iterationStart fires exactly once for a single-step script', async () => {
    const exec = scriptedExecutor([{ ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const iterationStarts = events.filter((e) => e.kind === 'iterationStart')
    expect(iterationStarts).toHaveLength(1)
    expect((iterationStarts[0].payload as { iteration: number }).iteration).toBe(0)
  })
})
