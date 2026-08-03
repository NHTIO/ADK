import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { APIUserAbortError } from '@anthropic-ai/sdk/core/error'
import { makeDispatchContext } from '../../../../_fixtures/dispatch_context'
import {
  Message,
  Thought,
  Tool,
  ToolCall,
  ToolRegistry,
  Tokenizable,
  Registry,
} from '@nhtio/adk/common'
import {
  buildErrorResponse,
  buildAnthropicStreamFrames,
  cassetteFetch,
  singleAnthropicResponseCassette,
  singleAnthropicStreamCassette,
} from '../../../../_fixtures/cassette'
import {
  AnthropicMessagesAdapter,
  E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW,
  E_ANTHROPIC_MESSAGES_HTTP_ERROR,
  E_ANTHROPIC_MESSAGES_STREAM_ERROR,
  E_INVALID_ANTHROPIC_MESSAGES_OPTIONS,
} from '@nhtio/adk/batteries/llm/anthropic_messages'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Cassette } from '../../../../_fixtures/cassette'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { RawGenerationObservation } from '@nhtio/adk/batteries/llm/chat_common'
import type { AnthropicMessagesErrorStatusInput } from '@nhtio/adk/batteries/llm/anthropic_messages'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const makeMessage = (overrides: {
  id?: string
  role?: 'user' | 'assistant'
  content?: string
  identity?: string
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:00:00Z')
  return new Message({
    id: overrides.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    identity: overrides.identity as never,
    createdAt,
    updatedAt: createdAt,
  })
}

const makeToolCall = (overrides: {
  id?: string
  tool?: string
  args?: Record<string, unknown>
  results?: Tokenizable
  isError?: boolean
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:01:00Z')
  return new ToolCall({
    id: overrides.id ?? `tc-${Math.random().toString(36).slice(2, 10)}`,
    tool: overrides.tool ?? 'my_tool',
    args: overrides.args ?? { x: 1 },
    checksum: 'sum-1',
    isComplete: true,
    isError: overrides.isError ?? false,
    results: overrides.results ?? new Tokenizable('tool said hi'),
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  })
}

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}

interface CtxOverrides {
  systemPrompt?: string | Tokenizable
  turnMessages?: Message[]
  turnThoughts?: Thought[]
  turnToolCalls?: ToolCall[]
  tools?: ToolRegistry
  stash?: Record<string, unknown>
  abortSignal?: AbortSignal
}

interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (overrides: CtxOverrides = {}): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  const sp =
    typeof overrides.systemPrompt === 'string'
      ? new Tokenizable(overrides.systemPrompt)
      : (overrides.systemPrompt ?? new Tokenizable('You are a helpful assistant.'))
  return {
    systemPrompt: sp,
    turnMessages: new Set(overrides.turnMessages ?? []),
    turnThoughts: new Set(overrides.turnThoughts ?? []),
    turnToolCalls: new Set(overrides.turnToolCalls ?? []),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: overrides.tools ?? new ToolRegistry(),
    stash: new Registry(overrides.stash ?? {}),
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn((_handler: () => void) => () => undefined),
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

const makeHelpers = (): DispatchExecutorHelpers & {
  _stats: Array<Record<string, unknown>>
} => {
  const stats: Array<Record<string, unknown>> = []
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => {
      stats.push(s)
    }),
    _stats: stats,
  } as unknown as DispatchExecutorHelpers & { _stats: typeof stats }
}

const getRequestBody = (call: unknown): Record<string, unknown> => {
  const init = (call as [string | URL, RequestInit])[1]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

const getRequestUrl = (call: unknown): string => {
  const url = (call as [string | URL, RequestInit])[0]
  return typeof url === 'string' ? url : url.toString()
}

const tool = (name: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) =>
  new Tool({
    name,
    description: `${name} tool`,
    inputSchema: validator.object({}).unknown(true),
    handler: handler as never,
  })

describe('AnthropicMessagesAdapter — static surface + countTokens', () => {
  it('exposes STASH_KEY and countTokens uses the count surface without max_tokens', async () => {
    const fetchFn = vi.fn(
      cassetteFetch({
        name: 'count-tokens',
        interactions: [{ response: { body: { input_tokens: 17 } } }],
      })
    )
    const adapter = new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      fetch: fetchFn as never,
    })

    expect(AnthropicMessagesAdapter.STASH_KEY).toBe('anthropicMessages')
    expect(AnthropicMessagesAdapter.isAnthropicMessagesAdapter(adapter)).toBe(true)
    expect(AnthropicMessagesAdapter.isAnthropicMessagesAdapter({})).toBe(false)

    const countCtx = makeDispatchContext({
      systemPrompt: 'You are a helpful assistant.',
      messages: [makeMessage({ content: 'count me' })],
    })
    const counted = await adapter.countTokens(countCtx)

    expect(counted.inputTokens).toBe(17)
    expect(getRequestUrl(fetchFn.mock.calls[0])).toContain('/messages/count_tokens')
    const body = getRequestBody(fetchFn.mock.calls[0]!)
    expect(body.model).toBe('claude-opus-5')
    expect(body).not.toHaveProperty('max_tokens')
    expect(Array.isArray(body.messages)).toBe(true)
  })

  it('sends native inference_geo and user_profile_id when set and omits them when unset', async () => {
    const fetchFn = vi.fn(
      cassetteFetch(
        singleAnthropicResponseCassette('native-param-assembly', {
          content: 'ok',
        })
      )
    )
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      inferenceGeo: 'eu',
      userProfileId: 'profile-123',
      fetch: fetchFn as never,
    }).executor()(
      makeCtx({ turnMessages: [makeMessage({ content: 'native params' })] }),
      makeHelpers()
    )

    const body = getRequestBody(fetchFn.mock.calls[0]!)
    const init = fetchFn.mock.calls[0]![1] as RequestInit
    const headers = new Headers(init.headers)
    expect(body.inference_geo).toBe('eu')
    expect(headers.get('anthropic-user-profile-id')).toBe('profile-123')

    const unsetFetch = vi.fn(
      cassetteFetch(
        singleAnthropicResponseCassette('native-param-assembly-unset', {
          content: 'ok',
        })
      )
    )
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: unsetFetch as never,
    }).executor()(
      makeCtx({
        turnMessages: [makeMessage({ content: 'native params unset' })],
      }),
      makeHelpers()
    )

    const unsetBody = getRequestBody(unsetFetch.mock.calls[0]!)
    const unsetHeaders = new Headers((unsetFetch.mock.calls[0]![1] as RequestInit).headers)
    expect(unsetBody).not.toHaveProperty('inference_geo')
    expect(unsetBody).not.toHaveProperty('user_profile_id')
    expect(unsetHeaders.has('anthropic-user-profile-id')).toBe(false)
  })

  it('countTokens also accepts a pre-built Anthropic request', async () => {
    const fetchFn = vi.fn(
      cassetteFetch({
        name: 'count-tokens-prebuilt',
        interactions: [{ response: { body: { input_tokens: 5, extra: true } } }],
      })
    )
    const adapter = new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      fetch: fetchFn as never,
    })

    const counted = await adapter.countTokens({
      system: [{ type: 'text', text: 'system' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })

    expect(counted).toMatchObject({
      inputTokens: 5,
      raw: { input_tokens: 5, extra: true },
    })
    const body = getRequestBody(fetchFn.mock.calls[0]!)
    expect(body.system).toEqual([{ type: 'text', text: 'system' }])
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('countTokens rejects ambiguous context+messages input and mirrors executor abort cancellation', async () => {
    const adapter = new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      fetch: vi.fn(cassetteFetch({ name: 'unused', interactions: [] })) as never,
    })
    const ambiguousInput = Object.create(null) as Record<string, unknown>
    ambiguousInput.context = makeDispatchContext({
      systemPrompt: 'count ctx',
      messages: [makeMessage({ content: 'ctx' })],
    })
    ambiguousInput.messages = [{ role: 'user', content: 'prebuilt' }]
    await expect(adapter.countTokens(ambiguousInput as never)).rejects.toBeInstanceOf(
      E_INVALID_ANTHROPIC_MESSAGES_OPTIONS
    )

    const abortController = new AbortController()
    abortController.abort()
    const abortFetch = vi.fn(async () => {
      throw new APIUserAbortError({ message: 'should not dispatch' })
    })
    const abortedAdapter = new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      fetch: abortFetch as never,
    })
    const counted = await abortedAdapter.countTokens(
      makeDispatchContext({
        messages: [makeMessage({ content: 'already aborted' })],
        turnAbortController: abortController,
      })
    )
    expect(counted).toEqual({
      inputTokens: 0,
      raw: { cancelled: true, reason: 'caller-abort-before-dispatch' },
    })
    expect(abortFetch).not.toHaveBeenCalled()
  })
})

describe('AnthropicMessagesAdapter — non-streaming + streaming execution', () => {
  it('non-streaming serialises complete tool input once and executes it', async () => {
    const seen = vi.fn(async () => 'ok')
    const ctx = makeCtx({
      turnMessages: [makeMessage({ content: 'ping' })],
      tools: new ToolRegistry([tool('search_docs', seen)]),
    })
    const helpers = makeHelpers()

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch(
        singleAnthropicResponseCassette('non-streaming-tool', {
          content: 'before tool',
          toolUses: [{ id: 'tool_1', name: 'search_docs', input: { query: 'x' } }],
          stopReason: 'tool_use',
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx._stored.messages[0]!.content?.toString()).toBe('before tool')
    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ query: 'x' })
    expect(ctx._stored.toolCalls[0]!.isError).toBe(false)
    expect(seen).toHaveBeenCalledWith({ query: 'x' }, expect.anything(), expect.anything())
  })

  it('streaming preserves the 7-event probe behavior and finalises from message_delta state', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'ping' })] })
    const rawEvents: Array<Record<string, unknown>> = []

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      onRawGeneration: (ev: RawGenerationObservation) => {
        rawEvents.push(ev as unknown as Record<string, unknown>)
      },
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('probe-stream', {
          usageStart: { input_tokens: 0, output_tokens: 0 },
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hel' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'lo' },
            },
            { type: 'content_block_stop', index: 0 },
          ],
          stopReason: 'end_turn',
          usageDelta: { input_tokens: 9, output_tokens: 2 },
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(helpers.reportMessage).toHaveBeenNthCalledWith(1, expect.any(String), 'Hel')
    expect(helpers.reportMessage).toHaveBeenNthCalledWith(2, expect.any(String), 'lo')
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('Hello')
    expect(rawEvents[0]).toMatchObject({
      rawText: 'Hello',
      cleanedText: 'Hello',
      streamed: true,
    })
    expect(helpers._stats.at(-1)?.finishReason).toBe('end_turn')
    expect(helpers._stats.at(-1)?.promptTokens).toBe(9)
    expect(helpers._stats.at(-1)?.completionTokens).toBe(2)
  })

  it('streamed tool-call args are not double-seeded from content_block_start input:{}', async () => {
    const seen = vi.fn(async () => 'ok')
    const ctx = makeCtx({
      turnMessages: [makeMessage({ content: 'ping' })],
      tools: new ToolRegistry([tool('search_docs', seen)]),
    })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('streamed-tool-args', {
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'tool_1',
                name: 'search_docs',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"query":' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '"x"}' },
            },
            { type: 'content_block_stop', index: 0 },
          ],
          stopReason: 'tool_use',
        })
      ) as never,
    }).executor()(ctx, makeHelpers())

    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ query: 'x' })
    expect(ctx._stored.toolCalls[0]!.isError).toBe(false)
    expect(ctx._stored.toolCalls[0]!.results.toString()).not.toContain(
      'E_ANTHROPIC_MESSAGES_INVALID_TOOL_CALL_ARGS'
    )
    expect(seen).toHaveBeenCalledWith({ query: 'x' }, expect.anything(), expect.anything())
  })

  it('preserves id/name across two interleaved tool_use blocks at different indices', async () => {
    const ctx = makeCtx({
      turnMessages: [makeMessage({ content: 'ping' })],
      tools: new ToolRegistry([
        tool('search_docs', async () => 'docs'),
        tool('lookup_user', async () => 'user'),
      ]),
    })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('interleaved-tools', {
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call.alpha',
                name: 'search_docs',
                input: {},
              },
            },
            {
              type: 'content_block_start',
              index: 1,
              content_block: {
                type: 'tool_use',
                id: 'call_beta',
                name: 'lookup_user',
                input: {},
              },
            },
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"user":"b"}' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"query":"a"}',
              },
            },
            { type: 'content_block_stop', index: 1 },
            { type: 'content_block_stop', index: 0 },
          ],
          stopReason: 'tool_use',
        })
      ) as never,
    }).executor()(ctx, makeHelpers())

    expect(ctx._stored.toolCalls.map((tc) => [tc.id, tc.tool, tc.args])).toEqual([
      ['call_beta', 'lookup_user', { user: 'b' }],
      ['call.alpha', 'search_docs', { query: 'a' }],
    ])
  })

  it('captures signature_delta into the persisted thought payload and finalises without message_stop', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'think' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('thinking-signature', {
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'step-1' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig-123' },
            },
            { type: 'content_block_stop', index: 0 },
            { raw: 'event: ping\ndata: {"type":"ping"}\n\n' },
          ],
          stopReason: 'end_turn',
          includeMessageStop: false,
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.payload).toMatchObject({
      variant: 'thinking',
      thinking: 'step-1',
      signature: 'sig-123',
    })
    expect(helpers.reportMessage).not.toHaveBeenCalled()
    expect(helpers.reportThought).toHaveBeenCalledTimes(2)
    expect(helpers.reportGenerationStats).toHaveBeenCalledTimes(1)
    expect(helpers.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stream-eof-without-stop' })
    )
  })
})

// Regression: work item #2. A thinking block with EMPTY text killed the whole turn client-side — no
// HTTP error, no 4xx. `hasThinking`/`sawThinking` are set from block PRESENCE, so an empty-text block
// took the persist path with `combinedThinking === ''`, and Thought's schema rejected the empty string.
// The throw escaped through the executor callback as the opaque `E_LLM_EXECUTION_EXECUTOR_ERROR`.
// `redacted_thinking` makes it DETERMINISTIC rather than occasional: it never contributes text at all.
describe('AnthropicMessagesAdapter — empty thinking blocks must not kill the turn', () => {
  it('persists a signed thinking block whose text is EMPTY (non-streaming)', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'think' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch(
        singleAnthropicResponseCassette('empty-thinking-body', {
          thinking: [{ thinking: '', signature: 'sig-empty' }],
          content: 'the visible answer',
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('')
    // The signature is the whole point — dropping the thought to dodge validation would lose it and
    // break signed-thinking replay.
    expect(ctx._stored.thoughts[0]!.payload).toMatchObject({
      variant: 'thinking',
      thinking: '',
      signature: 'sig-empty',
    })
    expect(ctx._stored.thoughts[0]!.replayCompatibility).toBe('anthropic-messages-thinking-v1')
    expect(ctx._stored.messages.map((m) => m.content?.toString())).toEqual(['the visible answer'])
  })

  it('persists a signed thinking block whose text is EMPTY (streaming)', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'think' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('empty-thinking-stream', {
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '' },
            },
            // Signature arrives with NO preceding thinking_delta — signed, but textless.
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig-empty' },
            },
            { type: 'content_block_stop', index: 0 },
          ],
          stopReason: 'end_turn',
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('')
    expect(ctx._stored.thoughts[0]!.payload).toMatchObject({
      variant: 'thinking',
      thinking: '',
      signature: 'sig-empty',
    })
  })

  it('persists a redacted_thinking-only response, which NEVER contributes text (non-streaming)', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'think' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch(
        singleAnthropicResponseCassette('redacted-only-body', {
          redactedThinking: [{ data: 'encrypted-blob' }],
          content: 'the visible answer',
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('')
    expect(ctx._stored.thoughts[0]!.payload).toMatchObject({
      variant: 'redacted_thinking',
      data: 'encrypted-blob',
    })
  })

  it('persists a redacted_thinking-only response, which NEVER contributes text (streaming)', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'think' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('redacted-only-stream', {
          events: [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'redacted_thinking', data: 'encrypted-blob' },
            },
            { type: 'content_block_stop', index: 0 },
          ],
          stopReason: 'end_turn',
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('')
    expect(ctx._stored.thoughts[0]!.payload).toMatchObject({
      variant: 'redacted_thinking',
      data: 'encrypted-blob',
    })
  })

  it('still carries real thinking text through when the model DOES emit prose', async () => {
    const helpers = makeHelpers()
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'think' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch(
        singleAnthropicResponseCassette('nonempty-thinking-body', {
          thinking: [{ thinking: 'let me reason', signature: 'sig-real' }],
          content: 'answer',
        })
      ) as never,
    }).executor()(ctx, helpers)

    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('let me reason')
  })
})

// Regression: work item #3. A gateway that terminates the HTTP request itself and reports the
// upstream failure only in the RESPONSE BODY leaves `err.status` absent → coerced to 0 → matches no
// retriable status → fatal, so `retry.maxAttempts` is never consulted. These pin the WIRING (option
// survives validation, reaches the classifier, changes real retry behaviour); error_translation
// .node.spec.ts pins the classifier itself.
describe('AnthropicMessagesAdapter — resolveErrorStatus recovers a body-only status', () => {
  const gatewayBody = {
    type: 'error',
    error: { type: 'server_error', message: 'upstream returned 529' },
  }
  // The gateway answers with a status the ADK does NOT treat as retriable (500), while the real,
  // retriable upstream status (529) appears only inside the body.
  const threeGatewayErrors = (name: string): Cassette => ({
    name,
    interactions: Array.from({ length: 3 }, () => ({
      response: buildErrorResponse({ status: 500, body: gatewayBody }),
    })),
  })

  it('WITHOUT a resolver the request is not retried (documents the shipped default)', async () => {
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    const fetchFn = vi.fn(cassetteFetch(threeGatewayErrors('gw-529-default')))
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 32,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(fetchFn.mock.calls).toHaveLength(1)
    expect(ctx.nack).toHaveBeenCalled()
  })

  it('WITH a resolver the same failure is retried up to maxAttempts', async () => {
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    const fetchFn = vi.fn(cassetteFetch(threeGatewayErrors('gw-529-resolver')))
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 32,
      stream: false,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
      resolveErrorStatus: ({ bodyText }: AnthropicMessagesErrorStatusInput) => {
        const m = /upstream returned (\d{3})/.exec(bodyText)
        return m ? Number(m[1]) : undefined
      },
      fetch: fetchFn as never,
    }).executor()(ctx, makeHelpers())
    expect(fetchFn.mock.calls).toHaveLength(3)
  })

  it('a recovered status is REPORTED, so the nack says 529 rather than 0', async () => {
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 32,
      stream: false,
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      resolveErrorStatus: () => 529,
      fetch: cassetteFetch(threeGatewayErrors('gw-529-reported')) as never,
    }).executor()(ctx, makeHelpers())
    const nacked = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]
    expect(String((nacked as Error).message)).toContain('529')
    expect(String((nacked as Error).message)).not.toMatch(/HTTP error 500\b/)
  })

  it('a throwing resolver does not replace the real upstream error', async () => {
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'hi' })] })
    const helpers = makeHelpers()
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 32,
      stream: false,
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      resolveErrorStatus: () => {
        throw new Error('resolver blew up')
      },
      fetch: cassetteFetch(threeGatewayErrors('gw-529-throw')) as never,
    }).executor()(ctx, helpers)
    const nacked = (ctx.nack as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]
    expect(String((nacked as Error).message)).toContain('529')
    expect(helpers.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'anthropic-resolve-error-status' })
    )
  })
})

describe('AnthropicMessagesAdapter — stop reasons + transport error translation', () => {
  it('handles all seven normal stop reasons on non-streaming and streaming paths', async () => {
    const refusal = { type: 'refusal', refusal: 'safety' }
    const stopReasons = [
      'end_turn',
      'max_tokens',
      'stop_sequence',
      'tool_use',
      'pause_turn',
      'refusal',
    ] as const
    for (const stopReason of stopReasons) {
      const nonStreamingHelpers = makeHelpers()
      await new AnthropicMessagesAdapter({
        apiKey: 'sk-ant-test-key',
        model: 'claude-opus-5',
        maxTokens: 64,
        stream: false,
        fetch: cassetteFetch(
          singleAnthropicResponseCassette(`stop-body-${stopReason}`, {
            stopReason,
            stopDetails: stopReason === 'refusal' ? refusal : undefined,
            content: stopReason === 'refusal' ? 'cannot comply' : 'ok',
          })
        ) as never,
      }).executor()(
        makeCtx({
          turnMessages: [makeMessage({ content: `go ${stopReason}` })],
        }),
        nonStreamingHelpers
      )
      const nonStreamingStats = nonStreamingHelpers._stats.at(-1)
      expect(nonStreamingStats?.finishReason).toBe(stopReason)
      if (stopReason === 'refusal') {
        expect(nonStreamingHelpers.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'anthropic-refusal',
            payload: { stopReason: 'refusal', stopDetails: refusal },
          })
        )
        expect(nonStreamingStats?.raw).toMatchObject({ stop_details: refusal })
      }

      const streamingHelpers = makeHelpers()
      await new AnthropicMessagesAdapter({
        apiKey: 'sk-ant-test-key',
        model: 'claude-opus-5',
        maxTokens: 64,
        stream: true,
        fetch: cassetteFetch(
          singleAnthropicStreamCassette(`stop-stream-${stopReason}`, {
            events: [
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text: stopReason === 'refusal' ? 'no' : 'ok',
                },
              },
              { type: 'content_block_stop', index: 0 },
            ],
            stopReason,
            stopDetails: stopReason === 'refusal' ? refusal : undefined,
            usageDelta: { input_tokens: 3, output_tokens: 2 },
          })
        ) as never,
      }).executor()(
        makeCtx({
          turnMessages: [makeMessage({ content: `go ${stopReason}` })],
        }),
        streamingHelpers
      )
      const streamingStats = streamingHelpers._stats.at(-1)
      expect(streamingStats?.finishReason).toBe(stopReason)
      expect(streamingStats?.promptTokens).toBe(3)
      expect(streamingStats?.completionTokens).toBe(2)
      if (stopReason === 'refusal') {
        expect(streamingHelpers.log.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'anthropic-refusal',
            payload: { stopReason: 'refusal', stopDetails: refusal },
          })
        )
        expect(streamingStats?.raw).toMatchObject({ stop_details: refusal })
      }
    }
  })

  it('maps model_context_window_exceeded to context overflow on both paths', async () => {
    const bodyCtx = makeCtx({
      turnMessages: [makeMessage({ content: 'overflow me' })],
    })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch(
        singleAnthropicResponseCassette('overflow-body', {
          stopReason: 'model_context_window_exceeded',
        })
      ) as never,
    }).executor()(bodyCtx, makeHelpers())
    expect(bodyCtx.nack).toHaveBeenCalledWith(expect.any(E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW))

    const streamCtx = makeCtx({
      turnMessages: [makeMessage({ content: 'overflow me' })],
    })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch(
        singleAnthropicStreamCassette('overflow-stream', {
          events: [],
          stopReason: 'model_context_window_exceeded',
        })
      ) as never,
    }).executor()(streamCtx, makeHelpers())
    expect(streamCtx.nack).toHaveBeenCalledWith(expect.any(E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW))
  })

  it('detects context overflow from a 400 body, retries upstream 529s, and treats APIUserAbortError as abort', async () => {
    const overflowCtx = makeCtx({
      turnMessages: [makeMessage({ content: 'too long' })],
    })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch({
        name: 'overflow-400',
        interactions: [
          {
            response: buildErrorResponse({
              status: 400,
              body: {
                error: {
                  type: 'invalid_request_error',
                  message: 'prompt is too long',
                },
              },
            }),
          },
        ],
      }) as never,
    }).executor()(overflowCtx, makeHelpers())
    expect(overflowCtx.nack).toHaveBeenCalledWith(expect.any(E_ANTHROPIC_MESSAGES_CONTEXT_OVERFLOW))

    const retryCassette: Cassette = {
      name: 'retry-529',
      interactions: [
        {
          label: 'first-529',
          response: buildErrorResponse({
            status: 529,
            body: {
              error: { type: 'overloaded_error', message: 'overloaded' },
            },
          }),
        },
        {
          label: 'second-200',
          response: {
            body: {
              id: 'msg_ok',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-5',
              content: [{ type: 'text', text: 'recovered' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        },
      ],
    }
    const retryFetch = vi.fn(cassetteFetch(retryCassette))
    const retryCtx = makeCtx({
      turnMessages: [makeMessage({ content: 'retry' })],
    })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
      fetch: retryFetch as never,
    }).executor()(retryCtx, makeHelpers())
    expect(retryFetch).toHaveBeenCalledTimes(2)
    expect(retryCtx._stored.messages[0]!.content?.toString()).toBe('recovered')

    const abortController = new AbortController()
    abortController.abort()
    const abortFetch = vi.fn(async () => {
      throw new APIUserAbortError({ message: 'aborted upstream' })
    })
    const abortedCtx = makeCtx({
      turnMessages: [makeMessage({ content: 'abort' })],
      abortSignal: abortController.signal,
    })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: abortFetch as never,
    }).executor()(abortedCtx, makeHelpers())
    expect(abortedCtx.nack).not.toHaveBeenCalled()
    expect(abortFetch).not.toHaveBeenCalled()
  })

  it('turns mid-stream provider failures into stream errors', async () => {
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'boom' })] })

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: true,
      fetch: cassetteFetch({
        name: 'stream-error',
        interactions: [
          {
            response: {
              sse: [
                ...buildAnthropicStreamFrames({
                  events: [],
                  includeMessageDelta: false,
                  includeMessageStop: false,
                }),
                {
                  raw:
                    'event: error\n' +
                    'data: {"type":"error","error":{"type":"overloaded_error","message":"backend overloaded"}}\n\n',
                },
              ],
            },
          },
        ],
      }) as never,
    }).executor()(ctx, makeHelpers())

    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_ANTHROPIC_MESSAGES_STREAM_ERROR))
  })
})

describe('AnthropicMessagesAdapter — request body footguns are warned, not repaired', () => {
  it('warns on illegal tool-call ids, sends them unchanged, and omits deprecated params unless set', async () => {
    const priorCall = makeToolCall({
      id: 'bad.id:still-bad',
      tool: 'search_docs',
      args: { query: 'x' },
      results: new Tokenizable('done'),
    })
    const fetchFn = vi.fn(
      cassetteFetch(singleAnthropicResponseCassette('request-body', { content: 'ok' }))
    )
    const helpers = makeHelpers()

    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: fetchFn as never,
    }).executor()(
      makeCtx({
        turnMessages: [makeMessage({ content: 'ping' })],
        turnToolCalls: [priorCall],
      }),
      helpers
    )

    const firstBody = getRequestBody(fetchFn.mock.calls[0])
    const assistantToolUse = (
      (firstBody.messages as Array<Record<string, unknown>>)[1]!.content as Array<
        Record<string, unknown>
      >
    )[0]
    expect(assistantToolUse).toMatchObject({
      id: 'bad.id:still-bad',
      name: 'search_docs',
    })
    expect(firstBody).not.toHaveProperty('temperature')
    expect(firstBody).not.toHaveProperty('top_p')
    expect(firstBody).not.toHaveProperty('top_k')
    expect(helpers.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('bad.id:still-bad'),
      })
    )

    const fetchFn2 = vi.fn(
      cassetteFetch(
        singleAnthropicResponseCassette('request-body-params', {
          content: 'ok',
        })
      )
    )
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.8,
      topK: 7,
      stream: false,
      fetch: fetchFn2 as never,
    }).executor()(makeCtx({ turnMessages: [makeMessage({ content: 'ping' })] }), makeHelpers())

    const secondBody = getRequestBody(fetchFn2.mock.calls[0]!)
    expect(secondBody.temperature).toBe(0.2)
    expect(secondBody.top_p).toBe(0.8)
    expect(secondBody.top_k).toBe(7)
  })

  it('reports a terminal HTTP error when retries are exhausted', async () => {
    const ctx = makeCtx({ turnMessages: [makeMessage({ content: 'fail' })] })
    await new AnthropicMessagesAdapter({
      apiKey: 'sk-ant-test-key',
      model: 'claude-opus-5',
      maxTokens: 64,
      stream: false,
      fetch: cassetteFetch({
        name: 'http-fail',
        interactions: [
          {
            response: buildErrorResponse({
              status: 503,
              body: { error: { type: 'api_error', message: 'down' } },
            }),
          },
        ],
      }) as never,
    }).executor()(ctx, makeHelpers())

    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_ANTHROPIC_MESSAGES_HTTP_ERROR))
  })
})
