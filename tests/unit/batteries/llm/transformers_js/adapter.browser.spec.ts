// Real-WebGPU regression for the transformers.js LLM battery's context-overflow guard.
//
// Unlike LiteRT (whose ENGINE throws a hard "too long" over-cap error the adapter translates),
// transformers.js/ORT-web has no clean engine-level length error — it would silently truncate or OOM. So
// the battery's PRE-DISPATCH overflow guard IS the mechanism: with `tokenEncoding` + `contextWindow`
// armed, a prompt that exceeds the window must throw the TYPED E_TRANSFORMERS_JS_CONTEXT_OVERFLOW BEFORE
// the pipeline runs — and (the regression that started all this) the tally must include the tool
// DECLARATIONS, not just system+timeline.
//
// This is the honest, no-fakes proof: a REAL TransformersJsAdapter loading a REAL ONNX model over WebGPU.
// The guard trips before generation (so no GPU is strictly needed for the throw), and the companion test
// proves a comfortably-budgeted turn actually GENERATES on the real model (no false overflow).
//
// DOUBLY GATED so it never blocks CI:
//   1. WebGPU must be present (`'gpu' in navigator`) — webkit/firefox and GPU-less chromium skip.
//   2. A model id must be supplied via `TEST_TRANSFORMERS_JS_LLM_MODEL` (a HF ONNX text-generation repo).
//      These are large downloads, so there is no bundled default. Absent → skip.
//
// Run locally (headed chromium with a GPU) via `.env.test`:
//   TEST_TRANSFORMERS_JS_LLM_MODEL=onnx-community/gemma-4-E2B-it-ONNX
//   TEST_TRANSFORMERS_JS_LLM_DTYPE=q4f16
//   pnpm run test:browser

import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  Tool,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import {
  TransformersJsAdapter,
  E_TRANSFORMERS_JS_CONTEXT_OVERFLOW,
  toolsToTransformersJsTools,
} from '@nhtio/adk/batteries/llm/transformers_js'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// `__TEST_ENV__` is inlined by vite.config (browser has no process.env); fall back to process.env when
// this somehow runs under the node project.
const TEST_ENV: Record<string, string> =
  typeof __TEST_ENV__ !== 'undefined'
    ? __TEST_ENV__
    : ((globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {})

const MODEL = TEST_ENV.TEST_TRANSFORMERS_JS_LLM_MODEL
const DTYPE = TEST_ENV.TEST_TRANSFORMERS_JS_LLM_DTYPE ?? 'q4f16'
const HAS_WEBGPU =
  typeof navigator !== 'undefined' && 'gpu' in navigator && typeof navigator.gpu !== 'undefined'
const CAN_RUN = HAS_WEBGPU && typeof MODEL === 'string' && MODEL.length > 0

// ─── minimal mock context (same shape the cross-spec uses) ───────────────────────────────────────────

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

const makeCtx = (
  userText: string,
  tools: ToolRegistry = new ToolRegistry()
): DispatchContext & { _stored: StoredState } => {
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
    tools,
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

const richTool = (name: string) =>
  new Tool({
    name,
    description:
      `A tool named ${name} with a deliberately verbose, multi-field input schema so its ` +
      `serialized JSON declaration weighs many tokens.`,
    inputSchema: validator.object({
      query: validator.string().min(1).max(4096).description('the search query text').required(),
      limit: validator.number().integer().min(1).max(100).description('max results to return'),
      filters: validator
        .object({
          path: validator.string().description('restrict to a documentation path prefix'),
          since: validator.string().description('ISO date lower bound'),
          tags: validator.array().items(validator.string()).description('tag allow-list'),
        })
        .description('optional structured filters'),
      verbose: validator.boolean().description('include full bodies in the result'),
    }),
    handler: () => 'ok',
  })

// ─── the gated real-model overflow proof ───────────────────────────────────────────────────────────────

describe.skipIf(!CAN_RUN)('TransformersJsAdapter — real WebGPU overflow guard (gated)', () => {
  it('trips the pre-dispatch guard (E_TRANSFORMERS_JS_CONTEXT_OVERFLOW) counting tool declarations, before generation', async () => {
    const tools = new ToolRegistry([
      richTool('search_docs_semantic'),
      richTool('search_docs_keyword'),
      richTool('provide_answer'),
      richTool('get_current_time'),
      richTool('calculate'),
    ])
    const enc = 'gemma' as const
    const sysAndMsg =
      Tokenizable.estimateTokens(
        'You are a concise, helpful assistant. Answer in one sentence.',
        enc
      ) + Tokenizable.estimateTokens('hi', enc)
    const toolBlock = Tokenizable.estimateTokens(
      JSON.stringify(toolsToTransformersJsTools(tools.visible())),
      enc
    )
    // The tool declarations are the dominant term — the whole point of the fix.
    expect(toolBlock).toBeGreaterThan(sysAndMsg)
    // Window ABOVE system+message but BELOW system+message+tools → overflows ONLY because tools count.
    const contextWindow = sysAndMsg + Math.floor(toolBlock / 2)
    const adapter = new TransformersJsAdapter({
      model: MODEL as string,
      dtype: DTYPE as never,
      device: 'webgpu',
      stream: false,
      autoAck: true,
      maxNewTokens: 32,
      doSample: false,
      tokenEncoding: enc,
      contextWindow,
    })
    const ctx = makeCtx('hi', tools)
    // Guard is pre-dispatch: it throws BEFORE the (expensive) pipeline load, so this returns fast even
    // though a real model id is configured.
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toBeInstanceOf(
      E_TRANSFORMERS_JS_CONTEXT_OVERFLOW
    )
    expect(ctx.ack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(0)
  }, 600_000)

  it('does NOT falsely overflow a comfortably-budgeted turn — generates on the real model', async () => {
    const adapter = new TransformersJsAdapter({
      model: MODEL as string,
      dtype: DTYPE as never,
      device: 'webgpu',
      stream: false,
      autoAck: true,
      maxNewTokens: 32,
      doSample: false,
      tokenEncoding: 'gemma',
      contextWindow: 4096, // generous — the short prompt is nowhere near this
    })
    const ctx = makeCtx('Reply with a short greeting.')
    await adapter.executor()(ctx, makeHelpers())
    const msg = ctx._stored.messages[0]
    expect(msg).toBeDefined()
    expect(msg?.content?.toString().trim().length).toBeGreaterThan(0)
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(ctx.nack).not.toHaveBeenCalled()
  }, 900_000)
})

// Always-present marker so the file reports a result (passing skip) even when the gate is closed.
describe('TransformersJsAdapter — real WebGPU overflow guard (gate status)', () => {
  it('reports whether the real-model gate is open', () => {
    expect(typeof CAN_RUN).toBe('boolean')
  })
})
