import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { Tokenizable, ToolRegistry, Registry } from '@nhtio/adk/common'
import { BedrockConverseAdapter } from '../../../../../src/batteries/llm/bedrock_converse/adapter'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// Node-only: relies on node:events' getEventListeners, which the browser vitest project cannot
// resolve (this battery ships to browser consumers too, but this is a TEST-only import — see
// the equivalent Gemini file's doc comment for why the listener-cleanup assertion for gate
// defect 2 lives in its own .node.spec.ts file rather than the shared .cross.spec.ts file).

const validResponse = (text = 'hello'): Response =>
  new Response(JSON.stringify({ output: { message: { content: [{ text }] } } }), {
    status: 200,
  })

const makeHelpers = (): DispatchExecutorHelpers => {
  const noop = () => {}
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: {
      trace: vi.fn(noop),
      debug: vi.fn(noop),
      info: vi.fn(noop),
      warn: vi.fn(noop),
      error: vi.fn(noop),
    },
  } as unknown as DispatchExecutorHelpers
}

const makeCtx = (overrides: { abortSignal?: AbortSignal } = {}): DispatchContext =>
  ({
    systemPrompt: new Tokenizable(''),
    standingInstructions: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    tools: new ToolRegistry(),
    stash: new Registry({}),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    storeMessage: vi.fn(async () => undefined),
    storeThought: vi.fn(async () => undefined),
    storeToolCall: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
  }) as never

describe('BedrockConverseAdapter — abort-link listener cleanup (gate defect 2)', () => {
  // Force linkAbortSignals' manual fallback path (used when native AbortSignal.any is
  // unavailable) by deleting AbortSignal.any for the duration of each test, restoring it
  // afterward. In the fallback path, every attempt attaches a real 'abort' listener directly to
  // ctx.abortSignal; if the LAST attempt's link is never disposed, that listener leaks for the
  // rest of the turn. node:events' getEventListeners lets us assert the count returns to
  // baseline (0, since these tests use a fresh AbortController per case) after the executor
  // settles.
  const withFallbackForced = async (fn: () => Promise<void>): Promise<void> => {
    const originalAny = AbortSignal.any

    // built-in static to force linkAbortSignals' fallback branch for this test.
    delete (AbortSignal as any).any
    try {
      await fn()
    } finally {
      AbortSignal.any = originalAny
    }
  }

  it('successful single attempt: caller signal listener count returns to baseline', async () => {
    await withFallbackForced(async () => {
      const controller = new AbortController()
      const baseline = getEventListeners(controller.signal, 'abort').length
      const fetchFn = vi.fn(async () => validResponse())
      const adapter = new BedrockConverseAdapter({ model: 'test', fetch: fetchFn as never })
      const ctx = makeCtx({ abortSignal: controller.signal })
      await adapter.executor()(ctx, makeHelpers())
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(getEventListeners(controller.signal, 'abort').length).toBe(baseline)
    })
  })

  it('N retries: caller signal listener count returns to baseline after the final attempt', async () => {
    await withFallbackForced(async () => {
      const controller = new AbortController()
      const baseline = getEventListeners(controller.signal, 'abort').length
      let n = 0
      const fetchFn = vi.fn(async () => {
        n += 1
        if (n < 3) return new Response('busy', { status: 502 })
        return validResponse()
      })
      const adapter = new BedrockConverseAdapter({
        model: 'test',
        fetch: fetchFn as never,
        retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
      })
      const ctx = makeCtx({ abortSignal: controller.signal })
      await adapter.executor()(ctx, makeHelpers())
      expect(fetchFn).toHaveBeenCalledTimes(3)
      expect(ctx.nack).not.toHaveBeenCalled()
      expect(getEventListeners(controller.signal, 'abort').length).toBe(baseline)
    })
  })

  it('terminal nack after exhausting retries: caller signal listener count returns to baseline', async () => {
    await withFallbackForced(async () => {
      const controller = new AbortController()
      const baseline = getEventListeners(controller.signal, 'abort').length
      const fetchFn = vi.fn(async () => new Response('busy', { status: 502 }))
      const adapter = new BedrockConverseAdapter({
        model: 'test',
        fetch: fetchFn as never,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      })
      const ctx = makeCtx({ abortSignal: controller.signal })
      await adapter.executor()(ctx, makeHelpers())
      expect(ctx.nack).toHaveBeenCalledTimes(1)
      expect(getEventListeners(controller.signal, 'abort').length).toBe(baseline)
    })
  })
})
