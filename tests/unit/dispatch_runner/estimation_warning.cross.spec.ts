import { describe, expect, it } from 'vitest'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import {
  currentEstimationWarnEmitter,
  runWithEstimationWarnings,
} from '../../../src/lib/utils/estimation_context'
import type { RawDispatchContext } from '../../../src/lib/contracts/dispatch_context'
import type { DispatchExecutorFn, WarningEvent } from '../../../src/lib/types/dispatch_runner'

const makeRaw = (): Omit<RawDispatchContext, 'hooks'> => ({
  systemPrompt: 'test',
  fetchMemories: async () => [],
  fetchMessages: async () => [],
  fetchThoughts: async () => [],
  fetchToolCalls: async () => [],
  fetchTools: async () => [],
  refreshStandingInstructions: async () => [],
  storeStandingInstruction: async () => {},
  mutateStandingInstruction: async () => {},
  deleteStandingInstruction: async () => {},
  storeMemory: async () => {},
  mutateMemory: async () => {},
  deleteMemory: async () => {},
  fetchRetrievables: async () => [],
  storeRetrievable: async () => {},
  mutateRetrievable: async () => {},
  deleteRetrievable: async () => {},
  storeMessage: async () => {},
  mutateMessage: async () => {},
  deleteMessage: async () => {},
  storeThought: async () => {},
  mutateThought: async () => {},
  deleteThought: async () => {},
  storeToolCall: async () => {},
  mutateToolCall: async () => {},
  deleteToolCall: async () => {},
  storeMediaBytes: () => {
    throw new Error('storeMediaBytes not used in this test')
  },
  storeRetrievableBytes: () => {
    throw new Error('storeRetrievableBytes not used in this test')
  },
})

describe('DispatchRunner — token-estimation warning channel', () => {
  it('establishes an estimation warn-sink for the duration of the dispatch (torn down after)', async () => {
    // Before: no runner active.
    expect(currentEstimationWarnEmitter()).toBeUndefined()

    let sinkInsideDefined = false
    const executor: DispatchExecutorFn = (ctx) => {
      sinkInsideDefined = currentEstimationWarnEmitter() !== undefined
      ctx.ack()
    }
    await DispatchRunner.dispatch({ raw: makeRaw(), executor })

    expect(sinkInsideDefined).toBe(true)
    // After: torn down.
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('forwards an estimator degrade to the `warning` bus (not `error`) and completes the dispatch', async () => {
    const warnings: WarningEvent[] = []
    let errored = false
    // Simulate what Tokenizable's degrade path does: read the ambient sink and emit. (A real encoder throw
    // is exercised end-to-end in the live check; here we assert the WIRING — the sink routes to the bus.)
    const executor: DispatchExecutorFn = (ctx) => {
      const emit = currentEstimationWarnEmitter()
      expect(emit).toBeDefined()
      emit?.({
        encoding: 'cl100k_base',
        error: new Error('The text contains a special token that is not allowed'),
        textPreview: 'docs about <|endoftext|>',
      })
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        warning: (e: WarningEvent) => {
          warnings.push(e)
        },
        error: () => {
          errored = true
        },
      },
    })

    expect(errored).toBe(false)
    expect(warnings).toHaveLength(1)
    const w = warnings[0]
    expect(w.source).toBe('dispatch-runner')
    expect(w.kind).toBe('token-estimation-degraded')
    expect(w.payload?.encoding).toBe('cl100k_base')
    expect(typeof w.dispatchId).toBe('string')
    expect(w.iteration).toBe(0)
    expect(w.emittedAt).toBeDefined()
  })

  it('a real special-token estimation inside a dispatch returns finite and emits NO warning (fix works)', async () => {
    const warnings: WarningEvent[] = []
    let estimate = -1
    const executor: DispatchExecutorFn = (ctx) => {
      // With the disallowedSpecial:[] fix this counts as ordinary text — no throw, no degrade, no warning.
      estimate = new Tokenizable('docs about <|endoftext|> token').estimateTokens('cl100k_base')
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        warning: (e: WarningEvent) => {
          warnings.push(e)
        },
      },
    })
    expect(Number.isFinite(estimate)).toBe(true)
    expect(estimate).toBeGreaterThan(0)
    expect(warnings).toHaveLength(0)
  })

  it('outside any dispatch, the same special-token estimation still does not throw', () => {
    expect(currentEstimationWarnEmitter()).toBeUndefined()
    expect(() =>
      new Tokenizable('docs about <|endoftext|> token').estimateTokens('cl100k_base')
    ).not.toThrow()
  })

  it('nested scope prefers the innermost (dispatch) emitter over an outer (turn-like) one', async () => {
    const outer: WarningEvent[] = []
    // Wrap the dispatch in an outer estimation scope to mimic TurnRunner → DispatchRunner nesting.
    await runWithEstimationWarnings(
      () => {
        outer.push({} as WarningEvent)
      },
      async () => {
        const executor: DispatchExecutorFn = (ctx) => {
          // Inside the dispatch, the innermost (dispatch) sink is active — not the outer one.
          const emit = currentEstimationWarnEmitter()
          emit?.({ encoding: 'cl100k_base', error: new Error('x'), textPreview: 'p' })
          ctx.ack()
        }
        const dispatchWarnings: WarningEvent[] = []
        await DispatchRunner.dispatch({
          raw: makeRaw(),
          executor,
          observers: {
            warning: (e: WarningEvent) => {
              dispatchWarnings.push(e)
            },
          },
        })
        // The warning went to the DISPATCH bus, not the outer turn-level sink.
        expect(dispatchWarnings).toHaveLength(1)
        expect(dispatchWarnings[0].source).toBe('dispatch-runner')
        expect(outer).toHaveLength(0)
      }
    )
  })
})
