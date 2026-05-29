import { SpooledArtifact } from '@nhtio/adk'
import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'
import { calculateTool, evaluateKatexTool } from '@nhtio/adk/batteries/tools/math'

describe('math batteries through TurnRunner', () => {
  it('calculateTool runs end-to-end and produces a SpooledArtifact result', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '2 + 2' } }] },
      { message: 'It is 4.', ack: true },
    ])
    const { run, store } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const reader = store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledArtifact(reader!)
    const lines = await artifact.cat()
    expect(lines.some((l) => /Result:\s*4/.test(l))).toBe(true)
  })

  it('evaluateKatexTool runs end-to-end with a LaTeX expression', async () => {
    const exec = scriptedExecutor([
      {
        toolCalls: [{ tool: 'evaluate_katex', args: { katex: '\\frac{1}{2} + \\sqrt{9}' } }],
      },
      { ack: true },
    ])
    const { run, store } = makeFixtureRunner({
      executorCallback: exec,
      tools: [evaluateKatexTool],
    })

    await run()

    const reader = store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledArtifact(reader!)
    const lines = await artifact.cat()
    expect(lines.some((l) => /Result:\s*3\.5/.test(l))).toBe(true)
  })

  it('multiple tool calls in a single iteration each get their own callId / artifact', async () => {
    const exec = scriptedExecutor([
      {
        toolCalls: [
          { tool: 'calculate', args: { expression: '1 + 1' } },
          { tool: 'calculate', args: { expression: '10 * 10' } },
        ],
      },
      { ack: true },
    ])
    const { run, store } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    expect(store.size).toBe(2)
    const r1 = store.read('tc-i0-1')
    const r2 = store.read('tc-i0-2')
    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    const a1 = new SpooledArtifact(r1!)
    const a2 = new SpooledArtifact(r2!)
    const lines1 = await a1.cat()
    const lines2 = await a2.cat()
    expect(lines1.some((l) => /Result:\s*2/.test(l))).toBe(true)
    expect(lines2.some((l) => /Result:\s*100/.test(l))).toBe(true)
  })
})
