/**
 * Streaming-event-table coverage for the OpenAI Responses battery — every event row from the
 * plan's "Streaming" section (`response.output_item.added/.done`, `response.output_text.delta`,
 * `response.refusal.delta`, `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`,
 * `response.function_call_arguments.delta/.done`, `response.completed/.incomplete/.failed`, bare
 * `error`), plus interleaved multi-`output_index` streams (concurrent tool calls + text +
 * reasoning) and the authoritative-replace semantics of `function_call_arguments.done`.
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { describe, expect, it, vi } from 'vitest'
import { cassetteFetch } from '../../../../_fixtures/cassette'
import { Tokenizable, Message, ToolRegistry, Registry } from '@nhtio/adk/common'
import {
  OpenAIResponsesAdapter,
  E_OPENAI_RESPONSES_STREAM_ERROR,
} from '@nhtio/adk/batteries/llm/openai_responses'
import {
  responsesAddedFrame,
  responsesDoneFrame,
  responsesTextDeltaFrame,
  responsesReasoningSummaryDeltaFrame,
  responsesReasoningTextDeltaFrame,
  responsesFunctionCallArgsDeltaFrame,
  responsesFunctionCallArgsDoneFrame,
  responsesTerminalFrame,
  responsesErrorFrame,
  buildResponsesResponse,
  buildResponsesStreamFrames,
  singleResponsesStreamCassette,
} from '../../../../_fixtures/cassette'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Thought, ToolCall } from '@nhtio/adk/common'
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

const makeCtx = (): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  return {
    systemPrompt: new Tokenizable('sys'),
    turnMessages: new Set([
      new Message({
        id: 'u1',
        role: 'user',
        content: 'hi',
        createdAt: dt('2026-01-01T00:00:00Z'),
        updatedAt: dt('2026-01-01T00:00:00Z'),
      }),
    ]),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: new ToolRegistry([]),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn((_h: () => void) => () => undefined),
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
  _events: Array<{ kind: string; id: string; payload: unknown }>
  _stats: Array<Record<string, unknown>>
  _logs: Array<{ level: string; kind: string; message: string }>
} => {
  const events: Array<{ kind: string; id: string; payload: unknown }> = []
  const stats: Array<Record<string, unknown>> = []
  const logs: Array<{ level: string; kind: string; message: string }> = []
  const captureLog = (level: string) => (entry: { kind: string; message: string }) =>
    logs.push({ level, kind: entry.kind, message: entry.message })
  return {
    reportMessage: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) => {
      events.push({ kind: 'message', id, payload: { delta, ...(opts ?? {}) } })
    }),
    reportThought: vi.fn((id: string, delta: string, opts?: { isComplete?: boolean }) => {
      events.push({ kind: 'thought', id, payload: { delta, ...(opts ?? {}) } })
    }),
    reportToolCall: vi.fn((id: string, partial: unknown) => {
      events.push({ kind: 'toolCall', id, payload: partial })
    }),
    log: {
      trace: vi.fn(captureLog('trace')),
      debug: vi.fn(captureLog('debug')),
      info: vi.fn(captureLog('info')),
      warn: vi.fn(captureLog('warn')),
      error: vi.fn(captureLog('error')),
    },
    reportGenerationStats: vi.fn((s: Record<string, unknown>) => stats.push(s)),
    _events: events,
    _stats: stats,
    _logs: logs,
  } as unknown as DispatchExecutorHelpers & {
    _events: typeof events
    _stats: typeof stats
    _logs: typeof logs
  }
}

describe('OpenAIResponsesAdapter streaming — event-table coverage', () => {
  it('response.output_item.added/.done + output_text.delta → one complete message', async () => {
    const cassette = singleResponsesStreamCassette('text-happy', {
      steps: [{ kind: 'text', deltas: ['Hel', 'lo!'] }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('Hello!')
    const msgEvents = helpers._events.filter((e) => e.kind === 'message')
    expect(msgEvents.length).toBeGreaterThan(0)
    expect(msgEvents.some((e) => (e.payload as { isComplete?: boolean }).isComplete)).toBe(true)
  })

  it('response.refusal.delta → surfaced as message text (HTTP-200 terminal answer, never an error)', async () => {
    const cassette = singleResponsesStreamCassette('refusal', {
      steps: [{ kind: 'refusal', deltas: ["I can't help with that."] }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe("I can't help with that.")
  })

  it('reasoning_summary_text.delta + reasoning_text.delta → one persisted Thought', async () => {
    const cassette = singleResponsesStreamCassette('reasoning', {
      steps: [
        {
          kind: 'reasoning',
          summaryDeltas: ['sum', 'mary'],
          reasoningDeltas: ['full ', 'reasoning'],
        },
      ],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx._stored.thoughts).toHaveLength(1)
    // reasoningText takes precedence over summaryText when both are present (persistThought).
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('full reasoning')
    const thoughtEvents = helpers._events.filter((e) => e.kind === 'thought')
    expect(thoughtEvents.length).toBeGreaterThan(0)
  })

  it('function_call_arguments.delta accumulates; .done is an AUTHORITATIVE REPLACE, not a merge', async () => {
    const cassette = singleResponsesStreamCassette('toolcall-authoritative', {
      steps: [
        {
          kind: 'toolCall',
          name: 'search',
          argumentDeltas: ['{"q":', '"partial'],
          argumentsDone: '{"q":"final value"}',
        },
      ],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx._stored.toolCalls).toHaveLength(1)
    // If .done merely appended, args would contain the stale partial delta text too.
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ q: 'final value' })
  })

  it('response.incomplete + max_output_tokens truncation → finishReason "length"', async () => {
    const frames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['partial output'] }],
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    })
    const cassette = {
      name: 'incomplete',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats).toHaveLength(1)
    expect(helpers._stats[0]!.finishReason).toBe('length')
  })

  it('response.incomplete + content_filter reason → finishReason "content_filter"', async () => {
    const frames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['flagged'] }],
      status: 'incomplete',
      incompleteReason: 'content_filter',
    })
    const cassette = {
      name: 'incomplete-cf',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._stats[0]!.finishReason).toBe('content_filter')
  })

  it('response.failed → nacks E_OPENAI_RESPONSES_STREAM_ERROR with the upstream message', async () => {
    const cassette = singleResponsesStreamCassette('failed', {
      steps: [],
      status: 'failed',
      error: { message: 'upstream generation failed' },
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_STREAM_ERROR))
    const err = vi.mocked(ctx.nack).mock.calls[0]![0] as Error
    expect(err.message).toContain('upstream generation failed')
  })

  it('bare `error` stream event → nacks E_OPENAI_RESPONSES_STREAM_ERROR with the message', async () => {
    const frames = [responsesErrorFrame('boom, something broke')]
    const cassette = {
      name: 'error-event',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_STREAM_ERROR))
    const err = vi.mocked(ctx.nack).mock.calls[0]![0] as Error
    expect(err.message).toContain('boom, something broke')
  })

  it('unrecognized/hosted output-item type opens NO slot and is not replayed', async () => {
    const frames = buildResponsesStreamFrames({
      steps: [{ kind: 'opaque', itemType: 'web_search_call', outputIndex: 0 }],
      status: 'completed',
    })
    const cassette = {
      name: 'hosted-tool',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(0)
    expect(ctx._stored.toolCalls).toHaveLength(0)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    const debugLogs = helpers._logs.filter(
      (l) => l.level === 'debug' && l.kind === 'unhandled-output-item'
    )
    expect(debugLogs.length).toBeGreaterThan(0)
  })

  it('EOF without a terminal event drains accumulated state and warns, without a STREAM_ERROR nack', async () => {
    const frames = buildResponsesStreamFrames({
      steps: [{ kind: 'text', deltas: ['partial before drop'] }],
      omitTerminal: true,
    })
    const cassette = {
      name: 'eof-no-terminal',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('partial before drop')
    const warnLogs = helpers._logs.filter(
      (l) => l.level === 'warn' && l.kind === 'sse-eof-without-terminal-event'
    )
    expect(warnLogs.length).toBe(1)
  })

  it('CRLF-delimited SSE frames (\\r\\n\\r\\n separators) still parse and dispatch every event', async () => {
    const itemId = 'msg-crlf'
    const addedEvent = JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: itemId, status: 'in_progress', content: [] },
    })
    const deltaEvent = JSON.stringify({
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: 'CRLF works',
    })
    const doneEvent = JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: itemId,
        status: 'completed',
        content: [{ type: 'output_text', text: 'CRLF works', annotations: [] }],
      },
    })
    const terminalEvent = JSON.stringify({
      type: 'response.completed',
      response: buildResponsesResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: itemId,
            status: 'completed',
            content: [{ type: 'output_text', text: 'CRLF works', annotations: [] }],
          },
        ],
      }),
    })
    // Every frame separator here is \r\n\r\n, not \n\n — simulating a gateway/proxy that
    // normalises line endings to CRLF (Known finding: a bare `\n\n` search never matches this).
    const raw =
      `data: ${addedEvent}\r\n\r\n` +
      `data: ${deltaEvent}\r\n\r\n` +
      `data: ${doneEvent}\r\n\r\n` +
      `data: ${terminalEvent}\r\n\r\n`
    const cassette = {
      name: 'crlf-sse',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: [{ raw }] } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('CRLF works')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })

  it('a terminal event arriving as the LAST bytes of the stream, with no trailing blank-line separator, still gets processed (not silently dropped at EOF)', async () => {
    const itemId = 'msg-eof-no-sep'
    const doneEvent = JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: itemId,
        status: 'completed',
        content: [{ type: 'output_text', text: 'final bytes', annotations: [] }],
      },
    })
    const terminalEvent = JSON.stringify({
      type: 'response.completed',
      response: buildResponsesResponse({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: itemId,
            status: 'completed',
            content: [{ type: 'output_text', text: 'final bytes', annotations: [] }],
          },
        ],
      }),
    })
    // The terminal frame's own trailing `\n\n` is deliberately OMITTED — the stream just ends right
    // after `data: <event>` with a single `\n`, simulating a server that closes the connection
    // immediately after its last write rather than sending one final blank line first. Known
    // finding: the parser only ever drained `buffer` when a frame separator was found DURING the
    // read loop, so a frame with no separator preceding EOF sat in `buffer` and was lost when the
    // loop's `if (done) break` fired.
    const raw =
      `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: itemId, status: 'in_progress', content: [] } })}\n\n` +
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: 'final bytes' })}\n\n` +
      `data: ${doneEvent}\n\n` +
      `data: ${terminalEvent}\n`
    const cassette = {
      name: 'eof-no-final-separator',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: [{ raw }] } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('final bytes')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    // The EOF-without-terminal-event warn must NOT fire — the terminal event WAS present, just
    // without its own trailing separator; treating this as "no terminal event" would be wrong.
    const eofWarnLogs = helpers._logs.filter(
      (l) => l.level === 'warn' && l.kind === 'sse-eof-without-terminal-event'
    )
    expect(eofWarnLogs.length).toBe(0)
  })

  it('interleaved multi-output_index stream: concurrent text + tool call + reasoning deltas resolve to independent slots', async () => {
    const textItemId = 'msg-int-1'
    const toolItemId = 'fc-int-1'
    const toolCallId = 'call-int-1'
    const reasoningItemId = 'rs-int-1'
    const frames = [
      responsesAddedFrame(0, {
        type: 'message',
        id: textItemId,
        role: 'assistant',
        status: 'in_progress',
        content: [],
      }),
      responsesAddedFrame(1, {
        type: 'function_call',
        id: toolItemId,
        call_id: toolCallId,
        name: 'lookup',
        arguments: '',
      }),
      responsesAddedFrame(2, { type: 'reasoning', id: reasoningItemId, summary: [] }),
      // interleave deltas across indices out of "natural" order
      responsesTextDeltaFrame(0, textItemId, 'Hel'),
      responsesFunctionCallArgsDeltaFrame(1, toolItemId, '{"q":'),
      responsesReasoningSummaryDeltaFrame(2, reasoningItemId, 'think'),
      responsesTextDeltaFrame(0, textItemId, 'lo'),
      responsesFunctionCallArgsDeltaFrame(1, toolItemId, '"x"}'),
      responsesReasoningSummaryDeltaFrame(2, reasoningItemId, 'ing'),
      responsesDoneFrame(0, {
        type: 'message',
        id: textItemId,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
      }),
      responsesFunctionCallArgsDoneFrame(1, toolItemId, '{"q":"x"}'),
      responsesDoneFrame(1, {
        type: 'function_call',
        id: toolItemId,
        call_id: toolCallId,
        name: 'lookup',
        arguments: '{"q":"x"}',
      }),
      responsesDoneFrame(2, {
        type: 'reasoning',
        id: reasoningItemId,
        summary: [{ type: 'summary_text', text: 'thinking' }],
      }),
      responsesTerminalFrame(
        'completed',
        buildResponsesResponse({
          status: 'completed',
          output: [
            {
              type: 'message',
              id: textItemId,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
            },
            {
              type: 'function_call',
              id: toolItemId,
              call_id: toolCallId,
              name: 'lookup',
              arguments: '{"q":"x"}',
            },
            {
              type: 'reasoning',
              id: reasoningItemId,
              summary: [{ type: 'summary_text', text: 'thinking' }],
            },
          ],
        })
      ),
    ]
    const cassette = {
      name: 'interleaved',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)

    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('Hello')
    expect(ctx._stored.thoughts).toHaveLength(1)
    expect(ctx._stored.thoughts[0]!.content.toString()).toBe('thinking')
    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.tool).toBe('lookup')
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ q: 'x' })
  })

  it("encrypted_content backfill: a `.done` event that omits it is filled in from the terminal event's response.output", async () => {
    const reasoningItemId = 'rs-backfill'
    const frames = [
      responsesAddedFrame(0, { type: 'reasoning', id: reasoningItemId, summary: [] }),
      responsesReasoningTextDeltaFrame(0, reasoningItemId, 'chain of thought'),
      // .done OMITS encrypted_content — a documented gap.
      responsesDoneFrame(0, {
        type: 'reasoning',
        id: reasoningItemId,
        summary: [],
        content: [{ type: 'reasoning_text', text: 'chain of thought' }],
      }),
      responsesTerminalFrame(
        'completed',
        buildResponsesResponse({
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: reasoningItemId,
              summary: [],
              content: [{ type: 'reasoning_text', text: 'chain of thought' }],
              encrypted_content: 'opaque-signed-blob',
            },
          ],
        })
      ),
    ]
    const cassette = {
      name: 'backfill',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
      reasoningReplay: 'encrypted',
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.thoughts).toHaveLength(1)
    const payload = ctx._stored.thoughts[0]!.payload as { item?: { encrypted_content?: string } }
    expect(payload.item?.encrypted_content).toBe('opaque-signed-blob')
  })
})

describe('OpenAIResponsesAdapter — non-streaming path event-table equivalents', () => {
  it('non-streaming happy path persists message + acks', async () => {
    const cassette = {
      name: 'ns-happy',
      interactions: [
        {
          request: { method: 'POST' as const },
          response: { body: buildResponsesResponse({ content: 'plain answer' }) },
        },
      ],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('plain answer')
    expect(ctx.ack).toHaveBeenCalledTimes(1)
  })

  it('non-streaming response.failed → nacks STREAM_ERROR', async () => {
    const cassette = {
      name: 'ns-failed',
      interactions: [
        {
          request: { method: 'POST' as const },
          response: {
            body: buildResponsesResponse({ status: 'failed', error: { message: 'nope' } }),
          },
        },
      ],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx.nack).toHaveBeenCalledWith(expect.any(E_OPENAI_RESPONSES_STREAM_ERROR))
  })

  it('non-streaming hosted/unrecognized output item type is never replayed and logs at debug', async () => {
    const cassette = {
      name: 'ns-hosted',
      interactions: [
        {
          request: { method: 'POST' as const },
          response: {
            body: buildResponsesResponse({
              output: [{ type: 'web_search_call', id: 'ws-1' }],
            }),
          },
        },
      ],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const ctx = makeCtx()
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(ctx._stored.messages).toHaveLength(0)
    expect(ctx.ack).toHaveBeenCalledTimes(1)
    expect(helpers._logs.some((l) => l.kind === 'unhandled-output-item')).toBe(true)
  })
})
