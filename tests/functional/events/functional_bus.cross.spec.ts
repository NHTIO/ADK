import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { calculateTool } from '@nhtio/adk/batteries/tools/math'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'

describe('TurnRunner functional event bus', () => {
  it('emits message events with TurnStreamableContent payload shape', async () => {
    const exec = scriptedExecutor([{ message: 'hello.', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const messages = events.filter((e) => e.kind === 'message')
    expect(messages).toHaveLength(1)
    const payload = messages[0].payload as {
      id: string
      full: string
      isComplete: boolean
      createdAt: unknown
      updatedAt: unknown
      completedAt?: unknown
    }
    expect(payload.id).toBeTruthy()
    expect(payload.full).toBe('hello.')
    expect(payload.isComplete).toBe(true)
    expect(payload.createdAt).toBeDefined()
    expect(payload.updatedAt).toBeDefined()
    expect(payload.completedAt).toBeDefined()
  })

  it('emits thought events when the executor reports thoughts', async () => {
    const exec = scriptedExecutor([{ thought: 'thinking...', message: 'answer', ack: true }])
    const { run, events } = makeFixtureRunner({ executorCallback: exec })

    await run()

    const thoughts = events.filter((e) => e.kind === 'thought')
    expect(thoughts).toHaveLength(1)
    expect((thoughts[0].payload as { full: string }).full).toBe('thinking...')
  })

  it('emits toolCall events twice per tool call (announce + complete)', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '1+1' } }] },
      { ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const toolCalls = events.filter((e) => e.kind === 'toolCall')
    // First emission: tool + args present, isComplete false
    // Second emission: results present, isComplete true
    expect(toolCalls.length).toBe(2)
    expect((toolCalls[0].payload as { isComplete: boolean }).isComplete).toBe(false)
    expect((toolCalls[1].payload as { isComplete: boolean }).isComplete).toBe(true)
  })

  it('functional events fire in the order: tool announcement → tool result → message', async () => {
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'calculate', args: { expression: '1+1' } }] },
      { message: 'two', ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    const functional = events.filter(
      (e) => e.kind === 'toolCall' || e.kind === 'message' || e.kind === 'thought'
    )
    expect(functional[0].kind).toBe('toolCall') // announcement
    expect(functional[1].kind).toBe('toolCall') // result
    expect(functional[2].kind).toBe('message') // assistant reply
  })
})
