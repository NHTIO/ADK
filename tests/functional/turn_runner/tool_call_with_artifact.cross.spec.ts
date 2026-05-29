import { SpooledArtifact } from '@nhtio/adk'
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { calculateTool } from '@nhtio/adk/batteries/tools/math'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner: tool-call artifact path', () => {
  it('persists tool-call bytes through the InMemorySpoolStore', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '1 + 1' } }] },
      { message: 'two', ack: true },
    ])
    const { run, store } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    expect(store.size).toBe(1)
  })

  it('builds a ToolCall whose results is a SpooledArtifact over the produced bytes', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '2 + 2' } }] },
      { ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const completeCalls = events.filter(
      (e) => e.kind === 'toolCall' && (e.payload as { isComplete: boolean }).isComplete === true
    )
    expect(completeCalls.length).toBeGreaterThanOrEqual(1)
    const results = (completeCalls[0].payload as { results: unknown }).results
    expect(SpooledArtifact.isSpooledArtifact(results)).toBe(true)
  })

  it('the SpooledArtifact yields the calculator result bytes', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '1 + 1' } }] },
      { ack: true },
    ])
    const { run, store } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    // scriptStep names ids as tc-i{iteration}-{stepIndex}; this is iteration 0's first call.
    const reader = store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledArtifact(reader!)
    const lines = await artifact.cat()
    // calculateTool emits a "Result: 2" line plus the KaTeX line
    expect(lines.some((l) => /Result:\s*2/.test(l))).toBe(true)
  })

  it('fires toolExecutionStart and toolExecutionEnd around each tool execution', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '3 * 4' } }] },
      { ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const starts = events.filter((e) => e.kind === 'toolExecutionStart')
    const ends = events.filter((e) => e.kind === 'toolExecutionEnd')
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
  })
})
