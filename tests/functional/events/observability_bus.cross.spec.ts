import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { calculateTool } from '@nhtio/adk/batteries/tools'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'
import type { DispatchExecutorFn, LogEvent } from '@nhtio/adk'

describe('TurnRunner observability event bus', () => {
  it('turnStart fires before dispatchStart, and turnEnd fires after dispatchEnd', async () => {
    const exec = scriptedExecutor([{ message: 'hi', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const ts = events.findIndex((e) => e.kind === 'turnStart')
    const ds = events.findIndex((e) => e.kind === 'dispatchStart')
    const de = events.findIndex((e) => e.kind === 'dispatchEnd')
    const te = events.findIndex((e) => e.kind === 'turnEnd')
    expect(ts).toBeLessThan(ds)
    expect(ds).toBeLessThan(de)
    expect(de).toBeLessThan(te)
  })

  it('turnStart carries a non-empty turnId', async () => {
    const exec = scriptedExecutor([{ ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const turnStart = events.find((e) => e.kind === 'turnStart')
    expect(turnStart).toBeDefined()
    const payload = turnStart!.payload as { turnId: string; startedAt: unknown }
    expect(typeof payload.turnId).toBe('string')
    expect(payload.turnId.length).toBeGreaterThan(0)
    expect(payload.startedAt).toBeDefined()
  })

  it('turnEnd carries the same turnId and a positive duration', async () => {
    const exec = scriptedExecutor([{ ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const turnStart = events.find((e) => e.kind === 'turnStart')
    const turnEnd = events.find((e) => e.kind === 'turnEnd')
    expect(turnStart).toBeDefined()
    expect(turnEnd).toBeDefined()
    const startPayload = turnStart!.payload as { turnId: string }
    const endPayload = turnEnd!.payload as { turnId: string; durationMs: number }
    expect(endPayload.turnId).toBe(startPayload.turnId)
    expect(endPayload.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('dispatchStart and dispatchEnd share a dispatchId', async () => {
    const exec = scriptedExecutor([{ ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const ds = events.find((e) => e.kind === 'dispatchStart')!
    const de = events.find((e) => e.kind === 'dispatchEnd')!
    expect((ds.payload as { dispatchId: string }).dispatchId).toBe(
      (de.payload as { dispatchId: string }).dispatchId
    )
  })

  it('toolExecutionStart fires before toolExecutionEnd for each tool invocation', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '1+1' } }] },
      { ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const startIdx = events.findIndex((e) => e.kind === 'toolExecutionStart')
    const endIdx = events.findIndex((e) => e.kind === 'toolExecutionEnd')
    expect(startIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(startIdx)
  })

  it('error event fires when the executor nacks', async () => {
    const exec = scriptedExecutor([{ nack: new Error('intentional') }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    expect(events.some((e) => e.kind === 'error')).toBe(true)
  })

  it('no error event fires on a clean ack', async () => {
    const exec = scriptedExecutor([{ message: 'hi', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)
  })

  it('log events emitted by the executor surface on TurnRunner.observe(`log`)', async () => {
    const exec: DispatchExecutorFn = (ctx, helpers) => {
      helpers.log.warn({
        kind: 'retry-attempt',
        message: 'simulated retry from executor',
        payload: { attempt: 1, delayMs: 100 },
      })
      helpers.log.debug({ kind: 'phase', message: 'mid-iteration' })
      ctx.ack()
    }
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const logs = events.filter((e) => e.kind === 'log')
    expect(logs).toHaveLength(2)
    const warn = logs[0].payload as LogEvent
    expect(warn.level).toBe('warn')
    expect(warn.kind).toBe('retry-attempt')
    expect(warn.message).toBe('simulated retry from executor')
    expect(warn.payload).toEqual({ attempt: 1, delayMs: 100 })
    expect(typeof warn.dispatchId).toBe('string')
    expect(warn.dispatchId.length).toBeGreaterThan(0)
    expect(warn.iteration).toBe(0)
    expect(warn.emittedAt).toBeDefined()

    const debug = logs[1].payload as LogEvent
    expect(debug.level).toBe('debug')
    expect(debug.kind).toBe('phase')
    expect('payload' in debug).toBe(false)

    const ds = events.findIndex((e) => e.kind === 'dispatchStart')
    const de = events.findIndex((e) => e.kind === 'dispatchEnd')
    const firstLog = events.findIndex((e) => e.kind === 'log')
    expect(firstLog).toBeGreaterThan(ds)
    expect(firstLog).toBeLessThan(de)
  })
})
