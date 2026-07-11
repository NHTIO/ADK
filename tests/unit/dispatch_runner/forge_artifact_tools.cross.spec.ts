import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ToolCall } from '../../../src/lib/classes/tool_call'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolStore } from '../../../src/batteries/storage/in_memory'
import type { RawDispatchContext } from '../../../src/lib/contracts/dispatch_context'
import type {
  DispatchExecutorFn,
  DispatchPipelineMiddlewareFn,
} from '../../../src/lib/types/dispatch_runner'

// The DispatchRunner CORE forges artifact-reader tools from prior-turn SpooledArtifact results into
// `ctx.tools` BEFORE the input pipeline runs — so every input middleware (budget passes, gates, taps) sees
// the forged readers as first-class members of the tool set, not a battery-local set invisible to the
// dispatch-input plane. Generation is core; batteries own only representation. These tests pin that contract.

const makeRaw = (
  overrides: Partial<Omit<RawDispatchContext, 'hooks'>> = {}
): Omit<RawDispatchContext, 'hooks'> => ({
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
  ...overrides,
})

const makeSpooledToolCall = (id: string, text: string): ToolCall => {
  const store = new InMemorySpoolStore()
  const reader = store.write(id, text)
  const at = DateTime.fromISO('2026-01-01T00:00:00Z', { zone: 'utc' })
  return new ToolCall({
    id,
    tool: 'read_file',
    args: { path: '/x' },
    checksum: `sum-${id}`,
    isComplete: true,
    isError: false,
    results: new SpooledArtifact(reader),
    inline: false,
    createdAt: at,
    updatedAt: at,
    completedAt: at,
  })
}

// Capture the tool names visible on ctx.tools during the input pipeline (i.e. AFTER the core forge, BEFORE
// the executor). This is the whole point: the input plane sees the forged readers.
const captureToolNamesInInputPipeline = (sink: string[][]): DispatchPipelineMiddlewareFn => {
  return async (ctx, next) => {
    sink.push(ctx.tools.all().map((t) => (t as { name?: string }).name ?? ''))
    if (ctx.iteration >= 0) ctx.ack() // one iteration is enough for these assertions
    await next()
  }
}

const noopExecutor: DispatchExecutorFn = () => {}

describe('DispatchRunner — core forges artifact-reader tools into ctx.tools before the input pipeline', () => {
  it('forges the readers when a prior-turn result is a SpooledArtifact', async () => {
    const seen: string[][] = []
    await DispatchRunner.dispatch({
      raw: makeRaw({ toolCalls: [makeSpooledToolCall('tc-1', 'a\nb\nc')] }),
      executor: noopExecutor,
      turnInputPipeline: [captureToolNamesInInputPipeline(seen)],
    })
    // The input pipeline saw the forged base readers on ctx.tools — proof the core forged BEFORE it ran.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('artifact_head')
    expect(seen[0]).toContain('artifact_grep')
  })

  it('forges NOTHING when there is no prior SpooledArtifact result', async () => {
    const seen: string[][] = []
    await DispatchRunner.dispatch({
      raw: makeRaw(), // no toolCalls
      executor: noopExecutor,
      turnInputPipeline: [captureToolNamesInInputPipeline(seen)],
    })
    expect(seen[0]!.filter((n) => n.startsWith('artifact_'))).toEqual([])
  })

  it('does not accumulate forged readers across iterations (prune-then-reforge is idempotent)', async () => {
    const counts: number[] = []
    const capture: DispatchPipelineMiddlewareFn = async (ctx, next) => {
      counts.push(ctx.tools.all().filter((t) => (t.name ?? '').startsWith('artifact_')).length)
      if (ctx.iteration >= 2) ctx.ack() // run three iterations (0,1,2)
      await next()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw({ toolCalls: [makeSpooledToolCall('tc-1', 'a\nb\nc')] }),
      executor: noopExecutor,
      turnInputPipeline: [capture],
    })
    // Same forged-reader count every iteration — no doubling from re-forging into the long-lived ctx.tools.
    expect(counts).toHaveLength(3)
    expect(new Set(counts).size).toBe(1)
    expect(counts[0]).toBeGreaterThan(0)
  })
})
