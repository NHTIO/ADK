import { describe, expect, it } from 'vitest'
import { SpooledJsonArtifact } from '@nhtio/adk'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { parseCsvTool } from '@nhtio/adk/batteries/tools/parsing'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'
import { statsDescribeTool } from '@nhtio/adk/batteries/tools/statistics'

describe('statistics batteries through TurnRunner', () => {
  it('statsDescribeTool produces a SpooledJsonArtifact', async () => {
    const exec = scriptedExecutor([
      {
        toolCalls: [{ tool: 'stats_describe', args: { numbers: '[1, 2, 3, 4, 5]' } }],
      },
      { ack: true },
    ])
    const { run, store, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [statsDescribeTool],
    })

    await run()

    // Find the complete tool-call event
    const completeCall = events.find(
      (e) => e.kind === 'toolCall' && (e.payload as { isComplete: boolean }).isComplete === true
    )
    expect(completeCall).toBeDefined()
    const results = (completeCall!.payload as { results: unknown }).results
    expect(SpooledJsonArtifact.isSpooledJsonArtifact(results)).toBe(true)

    // And the bytes are valid JSON with the expected stats
    const reader = store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledJsonArtifact(reader!, 'json')
    const lines = await artifact.cat()
    const parsed = JSON.parse(lines.join('\n')) as Record<string, number>
    expect(parsed.count).toBe(5)
    expect(parsed.mean).toBe(3)
    expect(parsed.median).toBe(3)
  })

  it('chains parseCsv → statsDescribe in a multi-step script', async () => {
    const csv = 'value\n10\n20\n30\n40\n50'
    const exec = scriptedExecutor([
      // Iteration 0: parse CSV into JSON
      { toolCalls: [{ tool: 'parse_csv', args: { text: csv } }] },
      // Iteration 1: describe the numeric column. In a real agent, the LLM would
      // extract values from iteration 0's result and pass them here. The functional
      // test stubs that with a hardcoded array.
      {
        toolCalls: [
          {
            tool: 'stats_describe',
            args: { numbers: '[10, 20, 30, 40, 50]' },
          },
        ],
      },
      { message: 'mean is 30', ack: true },
    ])
    const { run, store } = makeFixtureRunner({
      executorCallback: exec,
      tools: [parseCsvTool, statsDescribeTool],
    })

    await run()

    expect(store.size).toBe(2)
    const csvReader = store.read('tc-i0-1')
    expect(csvReader).toBeDefined()
    const statsReader = store.read('tc-i1-1')
    expect(statsReader).toBeDefined()

    const statsArtifact = new SpooledJsonArtifact(statsReader!, 'json')
    const statsLines = await statsArtifact.cat()
    const parsed = JSON.parse(statsLines.join('\n')) as Record<string, number>
    expect(parsed.mean).toBe(30)
  })
})
