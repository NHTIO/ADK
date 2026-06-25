// Real-WebGPU end-to-end proof for the LiteRT-LM battery.
//
// This is the honest end-to-end check the mocked cross-spec cannot be: it loads a REAL `.litertlm`
// model through the adapter's default `createEngine` (which self-bootstraps the `@litert-lm/core`
// wasm from jsdelivr and sets up the WebGPU device), drives one real dispatch turn through the same
// mock DispatchContext the cross-spec uses, and asserts a non-empty assistant message.
//
// It is DOUBLY GATED so it never blocks CI:
//   1. WebGPU must be present (`'gpu' in navigator`) — webkit/firefox and GPU-less chromium skip.
//   2. A model URL must be supplied via `TEST_LITERT_LM_MODEL_URL` (a `.litertlm` over HTTP) —
//      these models are hundreds of MB, so there is no bundled default. Absent → skip.
//
// Run it locally (headed chromium with a GPU) by putting the URL in `.env.test`:
//   TEST_LITERT_LM_MODEL_URL=https://.../gemma3-1b-it-int4.litertlm
//   pnpm run test:browser

import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { LiteRtLmAdapter } from '@nhtio/adk/batteries/llm/litert_lm'
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

// `__TEST_ENV__` is inlined by vite.config (browser has no process.env); fall back to process.env
// when this somehow runs under the node project.
const TEST_ENV: Record<string, string> =
  typeof __TEST_ENV__ !== 'undefined'
    ? __TEST_ENV__
    : ((globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {})

const MODEL_URL = TEST_ENV.TEST_LITERT_LM_MODEL_URL
const HAS_WEBGPU =
  typeof navigator !== 'undefined' && 'gpu' in navigator && typeof navigator.gpu !== 'undefined'
const CAN_RUN = HAS_WEBGPU && typeof MODEL_URL === 'string' && MODEL_URL.length > 0

// ─── minimal mock context (same shape the cross-spec uses) ───────────────────────────────────────────

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

const makeCtx = (userText: string): DispatchContext & { _stored: StoredState } => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const createdAt = dt('2026-01-01T12:00:00Z')
  const userMsg = new Message({
    id: 'u-1',
    role: 'user',
    content: userText,
    createdAt,
    updatedAt: createdAt,
  })
  return {
    systemPrompt: new Tokenizable('You are a concise, helpful assistant. Answer in one sentence.'),
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
    log: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    reportGenerationStats: vi.fn(),
  }) as unknown as DispatchExecutorHelpers

// ─── the gated real-model turn ───────────────────────────────────────────────────────────────────────

describe.skipIf(!CAN_RUN)('LiteRtLmAdapter — real WebGPU model (gated)', () => {
  it('loads a real .litertlm model and completes one streaming turn', async () => {
    const adapter = new LiteRtLmAdapter({
      model: MODEL_URL,
      stream: true,
      autoAck: true,
      // Keep the turn tiny; first run also downloads the model + wasm.
      maxOutputTokens: 64,
      samplerParams: { type: 3 /* GREEDY — deterministic */ },
    })

    const ctx = makeCtx('Reply with exactly the word: pong')
    await adapter.executor()(ctx, makeHelpers())

    const stored = ctx._stored.messages[0]
    expect(stored).toBeDefined()
    expect(stored?.content?.toString().trim().length).toBeGreaterThan(0)
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(ctx.nack).not.toHaveBeenCalled()
  }, 600_000) // Model + wasm download on first run; allow generous headroom.
})

// Always-present marker so the file reports a result (passing skip) even when the gate is closed —
// makes "did this file even run?" answerable in CI logs.
describe('LiteRtLmAdapter — real WebGPU model (gate status)', () => {
  it('reports whether the real-model gate is open', () => {
    expect(typeof CAN_RUN).toBe('boolean')
  })
})
