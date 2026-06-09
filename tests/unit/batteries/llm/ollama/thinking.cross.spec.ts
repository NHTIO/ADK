import { describe, expect, it, vi } from 'vitest'
import { OllamaAdapter, E_INVALID_OLLAMA_OPTIONS } from '@nhtio/adk/batteries/llm/ollama'
import { Tokenizable, Message, Thought, ToolCall, Registry, ToolRegistry } from '@nhtio/adk/common'
import {
  singleOllamaResponseCassette,
  singleOllamaStreamCassette,
  cassetteFetch,
} from '../../../../_fixtures/cassette'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

// ─── minimal mock ctx + helpers ────────────────────────────────────────────────

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}
interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  return {
    systemPrompt: new Tokenizable('You are a helpful assistant.'),
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
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
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as MockCtx
}

interface RecordingHelpers extends DispatchExecutorHelpers {
  _thoughtDeltas: Array<{ id: string; delta: string }>
}
const makeHelpers = (): RecordingHelpers => {
  const thoughtDeltas: Array<{ id: string; delta: string }> = []
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn((id: string, delta: string) => {
      if (delta.length > 0) thoughtDeltas.push({ id, delta })
    }),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn(),
    _thoughtDeltas: thoughtDeltas,
  } as unknown as RecordingHelpers
}

const getRequestBody = (call: unknown): Record<string, unknown> => {
  const init = (call as [string | URL, RequestInit])[1]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

// ─── tests ──────────────────────────────────────────────────────────────────────

describe('OllamaAdapter — think enable/disable: request body shape', () => {
  it('omitted think → NO `think` key in the body', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    expect(getRequestBody(fetchFn.mock.calls[0])).not.toHaveProperty('think')
  })

  it('think:false → body carries think:false (explicit disable)', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      think: false,
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    expect(getRequestBody(fetchFn.mock.calls[0]).think).toBe(false)
  })

  it('think:true → body carries think:true', async () => {
    const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      think: true,
      fetch: fetchFn as never,
    }).executor()(makeCtx(), makeHelpers())
    expect(getRequestBody(fetchFn.mock.calls[0]).think).toBe(true)
  })

  it.each(['low', 'medium', 'high'] as const)(
    'think:%s effort level passes through verbatim',
    async (level) => {
      const fetchFn = vi.fn(cassetteFetch(singleOllamaResponseCassette('c', { content: 'hi' })))
      await new OllamaAdapter({
        model: 'llama3.2',
        stream: false,
        think: level,
        fetch: fetchFn as never,
      }).executor()(makeCtx(), makeHelpers())
      expect(getRequestBody(fetchFn.mock.calls[0]).think).toBe(level)
    }
  )

  it('rejects an invalid think string at construction', () => {
    expect(() => new OllamaAdapter({ model: 'llama3.2', think: 'maybe' as never })).toThrow(
      E_INVALID_OLLAMA_OPTIONS
    )
  })
})

describe('OllamaAdapter — think disabled: no thoughts persisted', () => {
  it('non-streaming response with no `thinking` → zero Thoughts, no thought stream', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(singleOllamaResponseCassette('c', { content: 'just text' }))
    )
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, helpers)
    expect(ctx._stored.thoughts).toHaveLength(0)
    expect(helpers._thoughtDeltas).toHaveLength(0)
    expect(ctx._stored.messages).toHaveLength(1)
  })

  it('streaming response with no `thinking` deltas → zero Thoughts', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(singleOllamaStreamCassette('c', { contentDeltas: ['just ', 'text'] }))
    )
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, helpers)
    expect(ctx._stored.thoughts).toHaveLength(0)
    expect(helpers._thoughtDeltas).toHaveLength(0)
  })
})

describe('OllamaAdapter — think enabled: thinking surfaces as a Thought', () => {
  it('non-streaming: message.thinking → exactly one persisted Thought (identity = selfIdentity)', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaResponseCassette('c', {
          content: 'The answer is 4.',
          thinking: 'Let me add 2 and 2.',
        })
      )
    )
    const ctx = makeCtx()
    await new OllamaAdapter({
      model: 'llama3.2',
      stream: false,
      think: true,
      selfIdentity: 'assistant',
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content!.toString()).toBe('Let me add 2 and 2.')
    expect(String(ctx._stored.thoughts[0]!.identity?.identifier)).toBe('assistant')
    // content and thinking are separated: the Message holds the answer, NOT the reasoning.
    expect(ctx._stored.messages[0]!.content!.toString()).toBe('The answer is 4.')
    expect(ctx._stored.messages[0]!.content!.toString()).not.toContain('add 2 and 2')
  })

  it('streaming: thinking deltas surface live via reportThought AND persist one Thought', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(
        singleOllamaStreamCassette('c', {
          thinkingDeltas: ['Let me ', 'think...'],
          contentDeltas: ['Answer.'],
        })
      )
    )
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await new OllamaAdapter({
      model: 'llama3.2',
      think: true,
      autoAck: true,
      fetch: fetchFn as never,
    }).executor()(ctx, helpers)
    // Live thought deltas were reported.
    expect(helpers._thoughtDeltas.map((d) => d.delta)).toEqual(['Let me ', 'think...'])
    // Exactly one persisted Thought, content accumulated.
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content!.toString()).toBe('Let me think...')
    // content vs thinking separation in streaming too.
    expect(ctx._stored.messages[0]!.content!.toString()).toBe('Answer.')
  })
})
