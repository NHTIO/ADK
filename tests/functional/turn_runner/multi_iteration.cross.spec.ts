import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { calculateTool } from '@nhtio/adk/batteries/tools/math'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: multi-iteration dispatch', () => {
  it('loops once: iteration 0 (tool call) → iteration 1 (response + ack)', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '2 + 3' } }] },
      { message: 'The answer is 5.', ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    // Two iterations started; the second ack'd before iterationEnd fires, so only iteration 0
    // produces an iterationEnd event.
    const iterStarts = events.filter((e) => e.kind === 'iterationStart')
    const iterEnds = events.filter((e) => e.kind === 'iterationEnd')
    expect(iterStarts).toHaveLength(2)
    expect(iterEnds).toHaveLength(1)
    expect((iterStarts[0].payload as { iteration: number }).iteration).toBe(0)
    expect((iterStarts[1].payload as { iteration: number }).iteration).toBe(1)
    expect((iterEnds[0].payload as { iteration: number }).iteration).toBe(0)
  })

  it('emits a toolCall event in iteration 0 and a message event in iteration 1', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '6 * 7' } }] },
      { message: 'Forty-two.', ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const toolCalls = events.filter((e) => e.kind === 'toolCall')
    // Each toolCall is reported twice: once for the request, once for the result
    expect(toolCalls.length).toBeGreaterThanOrEqual(2)
    const completeCall = toolCalls.find(
      (e) => (e.payload as { isComplete: boolean }).isComplete === true
    )
    expect(completeCall).toBeDefined()
    expect((completeCall!.payload as { tool: string }).tool).toBe('calculate')

    const messages = events.filter((e) => e.kind === 'message')
    expect(messages).toHaveLength(1)
    expect((messages[0].payload as { full: string }).full).toBe('Forty-two.')
  })

  it('produces a single dispatchStart and dispatchEnd regardless of iteration count', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '1 + 1' } }] },
      { message: 'two', ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    expect(events.filter((e) => e.kind === 'dispatchStart')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'dispatchEnd')).toHaveLength(1)
  })
})
