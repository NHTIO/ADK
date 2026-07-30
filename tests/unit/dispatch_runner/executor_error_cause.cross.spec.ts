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

// The cause chain being INTACT is not the same as the failure being DIAGNOSABLE. A consumer that logs
// `err.message` — the overwhelmingly common case — saw only the static wrapper text and had no hint
// that validation, or thinking, or anything specific was involved. Work item #2 burned eight CI runs
// on a client-side validation error for exactly this reason. The cause text belongs in the message.
describe('DispatchRunner — E_LLM_EXECUTION_EXECUTOR_ERROR surfaces the cause in its OWN message', () => {
  it('appends a real Error cause message so `err.message` alone identifies the failure', async () => {
    const executor: DispatchExecutorFn = () => {
      throw new TypeError('"content" does not match any of the allowed types')
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    const msg = (caught as Error).message
    // Joined with `: ` and the prefix's own trailing period dropped, so the result reads as ONE
    // sentence rather than two run together.
    expect(msg).toBe(
      'The LLM execution executor callback threw an error: "content" does not match any of the allowed types'
    )
    expect((caught as { name?: string }).name).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
    expect((caught as { code?: string }).code).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
  })

  it('surfaces a non-Error throw in the message too', async () => {
    const executor: DispatchExecutorFn = () => {
      throw 'RET_CHECK failure: model produced no output'
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as Error).message).toContain('RET_CHECK failure')
  })

  it('keeps the message stable when the cause carries no text of its own', async () => {
    const executor: DispatchExecutorFn = () => {
      throw new Error('')
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as Error).message).toBe('The LLM execution executor callback threw an error.')
  })

  it('does not duplicate the cause text when the cause message already equals the wrapper text', async () => {
    const executor: DispatchExecutorFn = () => {
      throw new Error('The LLM execution executor callback threw an error.')
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as Error).message).toBe('The LLM execution executor callback threw an error.')
  })

  // `isError` accepts anything Error-SHAPED via a cross-realm prototype check and never validates
  // `message`'s TYPE, so a duck-typed or cross-realm error can carry a non-string `message`. A bare
  // `.trim()` on that threw a TypeError from inside the error handler — destroying the very executor
  // error this code exists to report, and surfacing as an unrelated crash.
  it('does not throw when an Error-shaped cause carries a NON-STRING message', async () => {
    const weird = new Error('placeholder')
    Object.defineProperty(weird, 'message', { value: { nested: 'obj' }, configurable: true })
    const executor: DispatchExecutorFn = () => {
      throw weird
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    // The wrapper still arrives intact — NOT a TypeError from the enrichment path.
    expect((caught as { name?: string }).name).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
    expect((caught as Error).message).toContain(
      'The LLM execution executor callback threw an error'
    )
    expect((caught as { cause?: unknown }).cause).toBe(weird)
  })

  // Guarding the TYPE of `message` is not enough: coercing a non-string can itself throw. An object
  // `message` with a throwing `toString` propagates out of the enrichment helper, so NO wrapper is
  // returned at all — the observability `runner('error')` hook never fires and both the executor error
  // and its cause chain are lost. Strictly worse than the plain `.trim()` bug it replaced.
  it('does not throw when the cause message has a THROWING toString', async () => {
    const hostile = new Error('placeholder')
    Object.defineProperty(hostile, 'message', {
      value: {
        toString() {
          throw new Error('boom from toString')
        },
      },
      configurable: true,
    })
    const executor: DispatchExecutorFn = () => {
      throw hostile
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as { name?: string }).name).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
    // Falls back to the bare static text rather than dying mid-enrichment.
    expect((caught as Error).message).toBe('The LLM execution executor callback threw an error.')
    expect((caught as { cause?: unknown }).cause).toBe(hostile)
  })

  it('does not throw when the cause message is a Symbol', async () => {
    const symErr = new Error('placeholder')
    Object.defineProperty(symErr, 'message', { value: Symbol('sym'), configurable: true })
    const executor: DispatchExecutorFn = () => {
      throw symErr
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as { name?: string }).name).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
    expect((caught as Error).message).toContain('sym')
  })

  it('does not throw when a duck-typed cross-realm error has a numeric message', async () => {
    const fake = Object.create(Error.prototype) as Error
    ;(fake as unknown as { name: string }).name = 'Error'
    Object.defineProperty(fake, 'message', { value: 42, configurable: true })
    const executor: DispatchExecutorFn = () => {
      throw fake
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as { name?: string }).name).toBe('E_LLM_EXECUTION_EXECUTOR_ERROR')
    expect((caught as Error).message).toContain('42')
  })

  it('still preserves the cause CHAIN alongside the enriched message', async () => {
    const root = new TypeError('the real problem')
    const executor: DispatchExecutorFn = () => {
      throw root
    }
    let caught: unknown
    await DispatchRunner.dispatch({ raw: makeRaw(), executor }).catch((e) => {
      caught = e
    })
    expect((caught as { cause?: unknown }).cause).toBe(root)
    expect(rootCauseMessage(caught)).toContain('the real problem')
  })
})
