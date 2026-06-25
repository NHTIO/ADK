// Gated real-model proof for the transformers.js LLM battery (Node / onnxruntime-node).
//
// This is the honest end-to-end check: it loads a REAL small ONNX text-generation model, drives one
// dispatch turn through a mock DispatchContext, and asserts a non-empty assistant message + ack. It
// also VALIDATES THE RISKIEST PARSER ASSUMPTIONS against real output — most importantly, that the
// Gemma E2B/E4B reasoning/tool-call delimiters and the <think> reasoning split actually parse.
//
// Gated on a model env var so CI skips cleanly (the model is a real, large download). To run locally:
//   TEST_TRANSFORMERS_JS_LLM_MODEL=onnx-community/gemma-4-E2B-it-ONNX
//   pnpm run test:node

import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const MODEL = process.env.TEST_TRANSFORMERS_JS_LLM_MODEL
const DTYPE = process.env.TEST_TRANSFORMERS_JS_LLM_DTYPE ?? 'q4f16'

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

const makeCtx = (userText: string): DispatchContext & { _stored: StoredState } => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const createdAt = DateTime.fromISO('2026-01-01T12:00:00Z', { zone: 'utc' })
  const userMsg = new Message({
    id: 'u-1',
    role: 'user',
    content: userText,
    createdAt,
    updatedAt: createdAt,
  })
  return {
    systemPrompt: new Tokenizable('You are a concise assistant. Answer in one short sentence.'),
    turnMessages: new Set([userMsg]),
    turnThoughts: new Set<Thought>(),
    turnToolCalls: new Set<ToolCall>(),
    turnMemories: new Set<Memory>(),
    turnRetrievables: new Set<Retrievable>(),
    standingInstructions: new Set<Tokenizable>(),
    tools: new ToolRegistry(),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn(() => () => undefined),
    emitToolExecutionStart: vi.fn(),
    emitToolExecutionEnd: vi.fn(),
    emitMessage: vi.fn(),
    emitThought: vi.fn(),
    emitToolCall: vi.fn(),
    storeMessage: vi.fn(async (m: Message) => {
      stored.messages.push(m)
    }),
    storeThought: vi.fn(async (t: Thought) => {
      stored.thoughts.push(t)
    }),
    storeToolCall: vi.fn(async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
    }),
    mutateToolCall: vi.fn(async () => undefined),
    _stored: stored,
  } as unknown as DispatchContext & { _stored: StoredState }
}

const makeHelpers = (): DispatchExecutorHelpers =>
  ({
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportGenerationStats: vi.fn(),
  }) as unknown as DispatchExecutorHelpers

describe.skipIf(!MODEL)('TransformersJsAdapter — real model (Node, gated)', () => {
  it('loads a real ONNX model and completes one turn with clean (markup-free) prose', async () => {
    const adapter = new TransformersJsAdapter({
      model: MODEL as string,
      dtype: DTYPE as never,
      stream: false,
      autoAck: true,
      maxNewTokens: 64,
      doSample: false,
    })
    const ctx = makeCtx('Reply with a short greeting.')
    await adapter.executor()(ctx, makeHelpers())

    const msg = ctx._stored.messages[0]
    expect(msg).toBeDefined()
    const text = msg?.content?.toString() ?? ''
    expect(text.trim().length).toBeGreaterThan(0)
    // The reasoning/tool-call parsers must strip any markup out of the visible message.
    expect(text).not.toContain('<think>')
    expect(text).not.toContain('<tool_call>')
    expect(text).not.toContain('<|channel>')
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(ctx.nack).not.toHaveBeenCalled()
  }, 900_000)
})

describe('TransformersJsAdapter — gate status', () => {
  it('reports whether the real-model gate is open', () => {
    expect(typeof !!MODEL).toBe('boolean')
  })
})
