import { describe, expect, it, vi } from 'vitest'
import { Tokenizable, ToolRegistry, Registry } from '@nhtio/adk/common'
import { BedrockConverseAdapter } from '../../../../../src/batteries/llm/bedrock_converse/adapter'
import {
  E_BEDROCK_CONVERSE_CONTEXT_OVERFLOW,
  E_INVALID_BEDROCK_CONVERSE_OPTIONS,
} from '../../../../../src/batteries/llm/bedrock_converse/exceptions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { BedrockConverseAdapterOptions } from '../../../../../src/batteries/llm/bedrock_converse/types'

const response = (): Response =>
  new Response(JSON.stringify({ output: { message: { content: [{ text: 'hello' }] } } }), {
    status: 200,
  })
const helpers = (): DispatchExecutorHelpers =>
  ({
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as never
const context = (systemPrompt: Tokenizable | { estimateTokens: () => number }): DispatchContext =>
  ({
    systemPrompt,
    standingInstructions: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    tools: new ToolRegistry(),
    stash: new Registry(),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    storeMessage: vi.fn(async () => undefined),
    storeThought: vi.fn(async () => undefined),
    storeToolCall: vi.fn(async () => undefined),
    mutateToolCall: vi.fn(async () => undefined),
  }) as never
const run = async (options: Record<string, unknown>, ctx = context(new Tokenizable(''))) => {
  const fetch = vi.fn(async () => response())
  const adapter = new BedrockConverseAdapter({ model: 'test', fetch, ...options })
  await adapter.executor()(ctx, helpers())
  return { fetch, ctx }
}

describe('Bedrock Converse autoAck and contextWindow', () => {
  it('accepts null tokenEncoding in the public options type', () => {
    const options: BedrockConverseAdapterOptions = { model: 'test', tokenEncoding: null }
    expect(options.tokenEncoding).toBeNull()
  })
  it.each([
    ['default', undefined],
    ['explicit true', true],
  ])('acks tool-call-free responses (%s)', async (_label, autoAck) => {
    const { ctx } = await run(autoAck === undefined ? {} : { autoAck })
    expect((ctx.ack as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
  it('does not ack when autoAck is false', async () => {
    const { ctx } = await run({ autoAck: false })
    expect((ctx.ack as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })
  it('throws its typed overflow exception before fetching', async () => {
    const fetch = vi.fn(async () => response())
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      tokenEncoding: 'cl100k_base',
      contextWindow: 1,
      fetch,
    })
    await expect(
      adapter.executor()(context({ estimateTokens: () => 2 }), helpers())
    ).rejects.toBeInstanceOf(E_BEDROCK_CONVERSE_CONTEXT_OVERFLOW)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('proceeds when the resolved context is under the window', async () => {
    const { fetch } = await run({ tokenEncoding: 'cl100k_base', contextWindow: 100 })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects a tokenEncoding without contextWindow', async () => {
    const fetch = vi.fn(async () => response())
    const adapter = new BedrockConverseAdapter({
      model: 'test',
      tokenEncoding: 'cl100k_base',
      fetch,
    })
    await expect(
      adapter.executor()(context(new Tokenizable('')), helpers())
    ).rejects.toBeInstanceOf(E_INVALID_BEDROCK_CONVERSE_OPTIONS)
    expect(fetch).not.toHaveBeenCalled()
  })
})
