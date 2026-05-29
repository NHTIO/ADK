import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { Tool, Message, SpooledArtifact } from '@nhtio/adk'
import { scriptStep } from '../../_fixtures/scripted_executor'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import type { DispatchContext, DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk'

// A tool whose handler returns bytes that include both a trailing newline and a CRLF terminator —
// the two shapes that `cat()` would discard but `asString()` must preserve verbatim.
const PAYLOAD = 'alpha\r\nbeta\ngamma\n'

const fixtureTool = new Tool({
  name: 'emit_payload',
  description: 'Emits a fixed multi-line payload for asString round-trip testing.',
  inputSchema: validator.object({}),
  handler: () => PAYLOAD,
})

describe('TurnRunner: artifact asString() — inline path', () => {
  it('inlines the tool-call bytes verbatim via asString(), preserving trailing newlines and CRLF', async () => {
    const store = new InMemorySpoolStore()

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        // Iteration 0: run the fixture tool through scriptStep so the spool store + ToolCall
        // record are populated exactly the way a real executor would.
        await scriptStep({ toolCalls: [{ tool: 'emit_payload', args: {} }] }, store)(ctx, helpers)
        return
      }

      if (ctx.iteration === 1) {
        // Iteration 1: read the prior tool call's artifact, render it via asString(), and
        // forward the bytes verbatim into an assistant message. No artifact tools registered.
        const [tc] = [...ctx.turnToolCalls]
        const body = await (tc.results as SpooledArtifact).asString()
        const id = 'msg-inline'
        helpers.reportMessage(id, body, { isComplete: true })
        const now = DateTime.now()
        await ctx.storeMessage(
          new Message({
            id,
            role: 'assistant',
            content: body,
            createdAt: now,
            updatedAt: now,
          })
        )
        ctx.ack()
        return
      }

      ctx.ack()
    }

    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [fixtureTool],
    })

    await run()

    const messages = events.filter((e) => e.kind === 'message')
    expect(messages).toHaveLength(1)
    const full = (messages[0].payload as { full: string }).full
    expect(full).toBe(PAYLOAD)
  })

  it('asString() over a SpooledArtifact matches the original handler bytes', async () => {
    const store = new InMemorySpoolStore()

    let captured: string | undefined

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        await scriptStep({ toolCalls: [{ tool: 'emit_payload', args: {} }] }, store)(ctx, helpers)
        return
      }
      const [tc] = [...ctx.turnToolCalls]
      captured = await (tc.results as SpooledArtifact).asString()
      ctx.ack()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [fixtureTool],
    })

    await run()
    expect(captured).toBe(PAYLOAD)
  })
})
