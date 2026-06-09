import { describe, expect, it } from 'vitest'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import type { RawDispatchContext } from '../../../src/lib/contracts/dispatch_context'
import type {
  DispatchExecutorFn,
  GenerationStats,
  GenerationStatsEvent,
} from '../../../src/lib/types/dispatch_runner'

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

describe('DispatchExecutorHelpers.reportGenerationStats — dedicated observability channel', () => {
  it('exposes reportGenerationStats as a function', async () => {
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      expect(typeof helpers.reportGenerationStats).toBe('function')
      ctx.ack()
    }
    await expect(DispatchRunner.dispatch({ raw: makeRaw(), executor })).resolves.toBeUndefined()
  })

  it('routes stats to the observability bus enriched with dispatchId + iteration + emittedAt', async () => {
    const captured: GenerationStatsEvent[] = []
    const stats: GenerationStats = {
      promptTokens: 169,
      completionTokens: 18,
      totalDurationNs: 3_244_883_583,
      evalDurationNs: 133_293_625,
      finishReason: 'stop',
      model: 'llama3.2',
      provider: 'ollama',
      raw: { done_reason: 'stop', eval_count: 18 },
    }
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.reportGenerationStats(stats)
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        generationStats: (event: GenerationStatsEvent) => {
          captured.push(event)
        },
      },
    })
    expect(captured).toHaveLength(1)
    const ev = captured[0]
    // Executor-supplied fields are carried verbatim.
    expect(ev.promptTokens).toBe(169)
    expect(ev.completionTokens).toBe(18)
    expect(ev.totalDurationNs).toBe(3_244_883_583)
    expect(ev.evalDurationNs).toBe(133_293_625)
    expect(ev.finishReason).toBe('stop')
    expect(ev.model).toBe('llama3.2')
    expect(ev.provider).toBe('ollama')
    expect(ev.raw).toEqual({ done_reason: 'stop', eval_count: 18 })
    // Runner-enriched correlation fields.
    expect(typeof ev.dispatchId).toBe('string')
    expect(ev.dispatchId.length).toBeGreaterThan(0)
    expect(ev.iteration).toBe(0)
    expect(ev.emittedAt).toBeDefined()
  })

  it('threads the current 0-based iteration index into every event', async () => {
    const captured: GenerationStatsEvent[] = []
    let iterationsRun = 0
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.reportGenerationStats({ completionTokens: ctx.iteration })
      iterationsRun += 1
      if (iterationsRun >= 3) {
        ctx.ack()
      }
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        generationStats: (event: GenerationStatsEvent) => {
          captured.push(event)
        },
      },
    })
    expect(captured.map((e) => e.iteration)).toEqual([0, 1, 2])
  })

  it('does not throw when no `generationStats` observer is registered (silent egress)', async () => {
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.reportGenerationStats({ completionTokens: 1 })
      ctx.ack()
    }
    await expect(DispatchRunner.dispatch({ raw: makeRaw(), executor })).resolves.toBeUndefined()
  })

  it('supports multiple observers receiving the same event (Hooks bus semantics)', async () => {
    const a: GenerationStatsEvent[] = []
    const b: GenerationStatsEvent[] = []
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.reportGenerationStats({ provider: 'ollama' })
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        generationStats: [
          (event: GenerationStatsEvent) => {
            a.push(event)
          },
          (event: GenerationStatsEvent) => {
            b.push(event)
          },
        ],
      },
    })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].provider).toBe('ollama')
    expect(b[0].provider).toBe('ollama')
  })
})
