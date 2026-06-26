// Deterministic, offline coverage of the transformers.js MULTIMODAL generate branch.
//
// Unlike `multimodal_real_model.node.spec.ts` (gated, downloads a real Gemma-4), this injects a FAKE
// `multimodalEngine` (model+processor) so it runs in CI with no model download. It DOES decode the real
// `sample.png` fixture through the peer's `RawImage` (offline, cheap) — proving the attachment → decode
// → positional `processor(prompt, image)` → `model.generate` → `batch_decode` path, and that the shared
// tool-call / reasoning parser layer is reused verbatim on multimodal output (multimodality is an INPUT
// concern only). Node-only: the peer import in `defaultMediaToTransformersInput` would hang the browser
// project, so this is never a `*.cross.spec.ts`.

import { DateTime } from 'luxon'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { validator } from '@nhtio/validation'
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
  Tool,
  ToolRegistry,
  Registry,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}
interface MockCtx extends DispatchContext {
  _stored: StoredState
}

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

const makeCtx = (attachments: Media[], tools?: ToolRegistry): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const createdAt = dt('2026-01-01T12:00:00Z')
  const userMsg = new Message({
    id: 'u-1',
    role: 'user',
    content: 'Describe this image.',
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt,
    updatedAt: createdAt,
  })
  return {
    systemPrompt: new Tokenizable('You are a vision assistant.'),
    turnMessages: new Set([userMsg]),
    turnThoughts: new Set<Thought>(),
    turnToolCalls: new Set<ToolCall>(),
    turnMemories: new Set<Memory>(),
    turnRetrievables: new Set<Retrievable>(),
    standingInstructions: new Set<Tokenizable>(),
    tools: tools ?? new ToolRegistry(),
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
  } as unknown as MockCtx
}

const makeHelpers = (): DispatchExecutorHelpers =>
  ({
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportGenerationStats: vi.fn(),
  }) as unknown as DispatchExecutorHelpers

const echoTool = () =>
  new Tool({
    name: 'echo',
    description: 'echo tool',
    inputSchema: validator.object({ text: validator.string().required() }),
    handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
  })

// ─── fake multimodal engine ──────────────────────────────────────────────────────────────────────────
//
// Mirrors the verified Gemma-4 contract exactly (see 0a spike): processor is callable + has
// `apply_chat_template` / `batch_decode` / `.tokenizer`; model has `generate`. The non-stream decode
// path slices the prompt tokens then `batch_decode`s — so `inputs.input_ids.dims = [1, N]` and the
// generate output exposes `.slice`. `cannedText` is what `batch_decode` returns (the "generated" text).

interface FakeEngineRecord {
  procArgs: unknown[]
  applyChatTemplateCalled: boolean
  generateKwargs: Record<string, unknown>
}

const makeFakeEngine = (cannedText: string) => {
  const rec: FakeEngineRecord = { procArgs: [], applyChatTemplateCalled: false, generateKwargs: {} }
  const processor = Object.assign(
    async (...args: unknown[]) => {
      rec.procArgs = args
      return { input_ids: { dims: [1, 7] }, attention_mask: { dims: [1, 7] }, pixel_values: {} }
    },
    {
      tokenizer: { all_special_ids: [] },
      apply_chat_template: (_m: unknown, _o: unknown) => {
        rec.applyChatTemplateCalled = true
        return 'PROMPT<|image|>'
      },
      batch_decode: (_t: unknown, _o: unknown) => [cannedText],
    }
  )
  const model = {
    generate: async (kwargs: Record<string, unknown>) => {
      rec.generateKwargs = kwargs
      return { slice: (..._a: unknown[]) => 'NEW_TOKENS' }
    },
  }
  return { engine: { model, processor } as never, rec }
}

describe('TransformersJsAdapter — multimodal (mocked engine, offline)', () => {
  it('drives an image turn through the multimodal generate branch and persists prose', async () => {
    const { engine, rec } = makeFakeEngine('A solid red square fills the image.')
    const adapter = new TransformersJsAdapter({
      model: 'fake/mm-model',
      multimodal: { image: true, audio: false },
      multimodalEngine: engine,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx([imageMedia()])
    await adapter.executor()(ctx, makeHelpers())

    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]?.content?.toString()).toContain('red square')
    expect(ctx.ack).toHaveBeenCalledOnce()
    expect(ctx.nack).not.toHaveBeenCalled()
    // The decoded RawImage was passed positionally after the prompt string.
    expect(rec.applyChatTemplateCalled).toBe(true)
    expect(rec.procArgs[0]).toBe('PROMPT<|image|>')
    expect(rec.procArgs.length).toBe(2) // [prompt, image] — no audio
    expect(rec.procArgs[1]).toBeDefined()
  })

  it('reuses the shared tool-call parser on multimodal output (input-only concern)', async () => {
    // Hermes-style tool call embedded in the "generated" multimodal text.
    const canned =
      'Looking at it… <tool_call>\n{"name": "echo", "arguments": {"text": "red"}}\n</tool_call>'
    const { engine } = makeFakeEngine(canned)
    const adapter = new TransformersJsAdapter({
      model: 'fake/mm-model',
      multimodal: { image: true },
      multimodalEngine: engine,
      stream: false,
      autoAck: true,
      toolCallParser: 'hermes',
    })
    const ctx = makeCtx([imageMedia()], new ToolRegistry([echoTool()]))
    await adapter.executor()(ctx, makeHelpers())

    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]?.tool).toBe('echo')
    expect(ctx._stored.toolCalls[0]?.args).toEqual({ text: 'red' })
  })

  it('leaves the text-only path on the pipeline (no engine resolved) when multimodal is off', async () => {
    // multimodal off + no attachments → must NOT touch the multimodal engine; a fake pipeline drives it.
    const pipeCalls: unknown[] = []
    const fakePipe = Object.assign(
      vi.fn(async (messages: unknown, _k: unknown) => {
        pipeCalls.push(messages)
        return [{ generated_text: [{ role: 'assistant', content: 'plain text answer' }] }]
      }),
      { tokenizer: { all_special_ids: [] } }
    )
    const adapter = new TransformersJsAdapter({
      model: 'fake/text-model',
      pipeline: fakePipe as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx([]) // no attachments → plain text-only turn
    await adapter.executor()(ctx, makeHelpers())
    expect(pipeCalls).toHaveLength(1)
    expect(ctx._stored.messages[0]?.content?.toString()).toContain('plain text answer')
  })
})
