import { describe, expect, it } from 'vitest'
import { isError } from '../../../src/lib/utils/guards'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import type { DispatchExecutorFn } from '../../../src/lib/types/dispatch_runner'
import type { RawDispatchContext } from '../../../src/lib/contracts/dispatch_context'

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
    throw new Error('storeMediaBytes not used')
  },
  storeRetrievableBytes: () => {
    throw new Error('storeRetrievableBytes not used')
  },
})

// Descend the `.cause` chain to the deepest ERROR-shaped link (stop before stepping into a non-Error
// cause — e.g. the raw thrown object toErrorCause preserves under the wrapper Error's own `.cause`; the
// human-readable text lives on that wrapper Error's message).
const rootCauseMessage = (err: unknown): string => {
  let cur: unknown = err
  for (let i = 0; i < 8; i++) {
    const c = (cur as { cause?: unknown }).cause
    if (!isError(c)) break
    cur = c
  }
  return isError(cur) ? cur.message : String(cur)
}

describe('DispatchRunner — E_LLM_EXECUTION_EXECUTOR_ERROR preserves a non-Error throw as its cause', () => {
  it('a STRING thrown by the executor is preserved in the cause chain (not lost to the generic message)', async () => {
    const executor: DispatchExecutorFn = () => {
      // Non-Error throw — the shape that used to yield a cause-less wrapper whose only text was the
      // generic "The LLM execution executor callback threw an error."
      throw 'RET_CHECK failure: model produced no output'
    }
    let caught: unknown
    await expect(
      DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
        caught = e
        throw e
      })
    ).rejects.toBeDefined()
    // The wrapper is still E_LLM_EXECUTION_EXECUTOR_ERROR…
    expect((caught as { name?: string }).name).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
    // …but the ROOT cause now carries the real thrown string, not the generic default.
    const rootMsg = rootCauseMessage(caught)
    expect(rootMsg).toContain('RET_CHECK failure')
    expect(rootMsg).not.toBe('The LLM execution executor callback threw an error.')
  })

  it('a plain OBJECT thrown by the executor is JSON-preserved in the cause', async () => {
    const executor: DispatchExecutorFn = () => {
      throw { code: 'WASM_ABORT', detail: 'engine reset' }
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    const rootMsg = rootCauseMessage(caught)
    expect(rootMsg).toContain('WASM_ABORT')
  })

  it('a real Error thrown by the executor passes through unchanged as the cause', async () => {
    const executor: DispatchExecutorFn = () => {
      throw new TypeError('genuine bug: x is not a function')
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    const rootMsg = rootCauseMessage(caught)
    expect(rootMsg).toContain('genuine bug: x is not a function')
  })
})
