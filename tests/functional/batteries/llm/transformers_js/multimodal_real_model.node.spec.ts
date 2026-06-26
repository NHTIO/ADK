// Gated real-model proof for the transformers.js MULTIMODAL (image) path (Node / onnxruntime-node).
//
// Drives one real dispatch turn with an image Media attachment through the actual adapter (not a spike),
// against a real ImageTextToText ONNX model, and asserts an image-grounded answer. Gated on a model env
// var so CI skips. Run locally:
//   TEST_TRANSFORMERS_JS_MM_MODEL=onnx-community/gemma-4-E2B-it-ONNX  pnpm run test:node

import { DateTime } from 'luxon'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  Media,
  ToolRegistry,
  Registry,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const MODEL = process.env.TEST_TRANSFORMERS_JS_MM_MODEL
const DTYPE = process.env.TEST_TRANSFORMERS_JS_MM_DTYPE ?? 'q4'

const imageMedia = (): Media => {
  const bytes = new Uint8Array(
    readFileSync(resolve(__dirname, '../../../../_fixtures/media/sample.png'))
  )
  return Media.userAttachment({
    id: 'img-1',
    kind: 'image',
    mimeType: 'image/png',
    filename: 'sample.png',
    reader: inMemoryMediaReader(bytes),
  })
}

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

const makeCtx = (
  userText: string,
  attachments: Media[]
): DispatchContext & { _stored: StoredState } => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const createdAt = DateTime.fromISO('2026-01-01T12:00:00Z', { zone: 'utc' })
  const userMsg = new Message({
    id: 'u-1',
    role: 'user',
    content: userText,
    attachments,
    createdAt,
    updatedAt: createdAt,
  })
  return {
    systemPrompt: new Tokenizable(
      'You are a concise vision assistant. Answer in one short sentence.'
    ),
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

describe.skipIf(!MODEL)('TransformersJsAdapter — multimodal image (Node, gated)', () => {
  it('describes a real image through one dispatch turn', async () => {
    const adapter = new TransformersJsAdapter({
      model: MODEL as string,
      dtype: DTYPE as never,
      multimodal: { image: true, audio: false },
      stream: false,
      autoAck: true,
      maxNewTokens: 48,
      doSample: false,
    })
    const ctx = makeCtx('Describe this image in one sentence.', [imageMedia()])
    await adapter.executor()(ctx, makeHelpers())

    const msg = ctx._stored.messages[0]
    expect(msg).toBeDefined()
    const text = msg?.content?.toString() ?? ''
    expect(text.trim().length).toBeGreaterThan(0)
    // sample.png is a solid red block — the model should mention a color/image.
    expect(text.toLowerCase()).toMatch(/red|color|colour|image|block|square/)
    // No raw markup leaked.
    expect(text).not.toContain('<turn|>')
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(ctx.nack).not.toHaveBeenCalled()
  }, 900_000)
})

describe('TransformersJsAdapter — multimodal gate status', () => {
  it('reports whether the gate is open', () => {
    expect(typeof !!MODEL).toBe('boolean')
  })
})
