import { describe, expect, it } from 'vitest'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'
import { orderingGuardDispatchMiddleware } from '@nhtio/adk/batteries/validation'

/**
 * Regression pin for issue #13: `orderingGuardDispatchMiddleware` in `action: 'mutate'` mode
 * unconditionally stashed the live timeline (carrying real Message/Thought/ToolCall instances)
 * under `EFFECTIVE_TIMELINE` on its first dispatch-input pass. `ctx.stash` (a Registry)
 * klona-clones its ENTIRE store on every `.get()`/`.set()`-adjacent read regardless of which key
 * is requested, and klona's generic-object clone strategy calls `new x.constructor()` with zero
 * args before copying properties — which throws for Message/Thought/ToolCall (their constructors
 * destructure a required `raw` param immediately). So the guard's own SNAPSHOT read on the next
 * dispatch iteration walked the whole store, hit the poisoned EFFECTIVE_TIMELINE entry, and
 * killed the turn — even with zero ordering rules in play (`permissive` profile), since the bug
 * is in the unconditional stash write itself, not in any repair path.
 *
 * @remarks
 * Three dispatch iterations are required to actually exercise the bug: iteration 0's guard pass
 * sees an empty turn-state timeline, so its stash write is harmless. Iteration 1's guard pass
 * sees the thought stored by iteration 0's executor step and is the one that poisons
 * `EFFECTIVE_TIMELINE` with a live instance. Only iteration 2's guard pass — via its own
 * unrelated `SNAPSHOT` read, which klona-clones the whole store — actually walks into the
 * poisoned entry and throws. A 2-iteration script never reaches the read that trips the bug.
 */
describe('TurnRunner: ordering_guard mutate-mode stash regression (issue #13)', () => {
  it('completes a third dispatch iteration without corrupting ctx.stash', async () => {
    const exec = scriptedExecutor([
      { thought: 'thinking about it' },
      { thought: 'still thinking' },
      { message: 'done', ack: true },
    ])
    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      dispatchInputPipeline: [
        orderingGuardDispatchMiddleware({ profiles: ['permissive'], action: 'mutate' }),
      ],
    })

    await expect(run()).resolves.not.toThrow()

    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)
    const dispatchEnd = events.find((e) => e.kind === 'dispatchEnd')
    expect(dispatchEnd).toBeDefined()
    expect((dispatchEnd!.payload as { status: string }).status).toBe('ack')
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'iterationStart')).toHaveLength(3)
  })
})
