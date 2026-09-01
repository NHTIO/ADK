/**
 * Tool-call coverage for the OpenAI Responses battery: round-trip; parallel calls; composite-id
 * handling; invalid-args error persistence; tool-not-found; `tool_choice` forged-artifact warn.
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { cassetteFetch } from '../../../../_fixtures/cassette'
import { Tokenizable, Message, Tool, ToolRegistry, Registry } from '@nhtio/adk/common'
import {
  OpenAIResponsesAdapter,
  E_INVALID_OPENAI_RESPONSES_OPTIONS,
} from '@nhtio/adk/batteries/llm/openai_responses'
import {
  buildResponsesResponse,
  singleResponsesResponseCassette,
  responsesAddedFrame,
  responsesDoneFrame,
  responsesFunctionCallArgsDeltaFrame,
  responsesFunctionCallArgsDoneFrame,
  responsesTerminalFrame,
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

const makeCtx = (overrides: { tools?: ToolRegistry } = {}): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  return {
    systemPrompt: new Tokenizable('sys'),
    turnMessages: new Set([
      new Message({
        id: 'u1',
        role: 'user',
        content: 'call the tool',
        createdAt: dt('2026-01-01T00:00:00Z'),
        updatedAt: dt('2026-01-01T00:00:00Z'),
      }),
    ]),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools: overrides.tools ?? new ToolRegistry([]),
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
  _logs: Array<{ level: string; kind: string; payload?: unknown }>
} => {
  const logs: Array<{ level: string; kind: string; payload?: unknown }> = []
  const captureLog = (level: string) => (entry: { kind: string; payload?: unknown }) =>
    logs.push({ level, kind: entry.kind, payload: entry.payload })
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: {
      trace: vi.fn(captureLog('trace')),
      debug: vi.fn(captureLog('debug')),
      info: vi.fn(captureLog('info')),
      warn: vi.fn(captureLog('warn')),
      error: vi.fn(captureLog('error')),
    },
    reportGenerationStats: vi.fn(),
    _logs: logs,
  } as unknown as DispatchExecutorHelpers & { _logs: typeof logs }
}

const makeTool = (name: string, handler?: () => string | Promise<string>) =>
  new Tool({
    name,
    description: `tool ${name}`,
    inputSchema: validator.object({ q: validator.string().optional() }).unknown(true),
    handler: handler ?? (async (args: unknown) => `result for ${JSON.stringify(args)}`),
  })

describe('OpenAIResponsesAdapter — tool-call round-trip (non-streaming)', () => {
  it('single tool call executes and persists one ToolCall record', async () => {
    const tools = new ToolRegistry([makeTool('search', async () => 'search result')])
    const cassette = singleResponsesResponseCassette('single-call', {
      toolCalls: [{ callId: 'call-1', itemId: 'fc_1', name: 'search', arguments: { q: 'hi' } }],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls).toHaveLength(1)
    const tc = ctx._stored.toolCalls[0]!
    expect(tc.tool).toBe('search')
    expect(tc.args).toEqual({ q: 'hi' })
    expect(tc.isError).toBe(false)
    // Composite id: call_id|item_id, since the provider returned both.
    expect(tc.id).toBe('call-1|fc_1')
  })

  it('parallel tool calls: each independently persisted with correct args', async () => {
    const tools = new ToolRegistry([makeTool('alpha'), makeTool('beta')])
    const cassette = singleResponsesResponseCassette('parallel-calls', {
      toolCalls: [
        { callId: 'call-a', itemId: 'fc_a', name: 'alpha', arguments: { q: 'first' } },
        { callId: 'call-b', itemId: 'fc_b', name: 'beta', arguments: { q: 'second' } },
      ],
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls).toHaveLength(2)
    const byTool = Object.fromEntries(ctx._stored.toolCalls.map((tc) => [tc.tool, tc]))
    expect(byTool.alpha!.args).toEqual({ q: 'first' })
    expect(byTool.beta!.args).toEqual({ q: 'second' })
    expect(byTool.alpha!.isError).toBe(false)
    expect(byTool.beta!.isError).toBe(false)
  })

  it('a call with no item id (call_id only) persists a plain (non-composite) ToolCall.id', async () => {
    const tools = new ToolRegistry([makeTool('search')])
    const body = buildResponsesResponse({
      output: [{ type: 'function_call', call_id: 'call-plain', name: 'search', arguments: '{}' }],
    })
    const cassette = {
      name: 'no-item-id',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls[0]!.id).toBe('call-plain')
  })

  it('invalid JSON arguments persist an error ToolCall with E_OPENAI_RESPONSES_INVALID_TOOL_CALL_ARGS message', async () => {
    const tools = new ToolRegistry([makeTool('search')])
    const body = buildResponsesResponse({
      output: [
        {
          type: 'function_call',
          call_id: 'call-bad',
          id: 'fc_bad',
          name: 'search',
          arguments: 'not json{',
        },
      ],
    })
    const cassette = {
      name: 'bad-json',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls).toHaveLength(1)
    const tc = ctx._stored.toolCalls[0]!
    expect(tc.isError).toBe(true)
    expect(tc.results.toString()).toContain('are not valid JSON')
  })

  it('non-object JSON arguments (array root) persist an error ToolCall naming the received kind', async () => {
    const tools = new ToolRegistry([makeTool('search')])
    const body = buildResponsesResponse({
      output: [
        { type: 'function_call', call_id: 'call-arr', name: 'search', arguments: '[1,2,3]' },
      ],
    })
    const cassette = {
      name: 'array-args',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    const tc = ctx._stored.toolCalls[0]!
    expect(tc.isError).toBe(true)
    expect(tc.results.toString()).toContain('received array')
  })

  it('tool-not-found: error ToolCall lists available tool names', async () => {
    const tools = new ToolRegistry([makeTool('real_tool')])
    const body = buildResponsesResponse({
      output: [
        { type: 'function_call', call_id: 'call-missing', name: 'ghost_tool', arguments: '{}' },
      ],
    })
    const cassette = {
      name: 'not-found',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    const tc = ctx._stored.toolCalls[0]!
    expect(tc.isError).toBe(true)
    expect(tc.results.toString()).toContain('Tool not found: ghost_tool')
    expect(tc.results.toString()).toContain('real_tool')
  })

  it('tool-not-found with an empty registry reports "no tools are available"', async () => {
    const body = buildResponsesResponse({
      output: [
        { type: 'function_call', call_id: 'call-missing2', name: 'ghost_tool', arguments: '{}' },
      ],
    })
    const cassette = {
      name: 'not-found-empty',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx()
    await adapter.executor()(ctx, makeHelpers())
    const tc = ctx._stored.toolCalls[0]!
    expect(tc.results.toString()).toContain('No tools are available this turn.')
  })

  it('a handler throwing an Error persists an error ToolCall with the thrown message', async () => {
    const tools = new ToolRegistry([
      makeTool('bad_handler', () => {
        throw new Error('handler exploded')
      }),
    ])
    const body = buildResponsesResponse({
      output: [
        { type: 'function_call', call_id: 'call-throw', name: 'bad_handler', arguments: '{}' },
      ],
    })
    const cassette = {
      name: 'handler-throws',
      interactions: [{ request: { method: 'POST' as const }, response: { body } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    const tc = ctx._stored.toolCalls[0]!
    expect(tc.isError).toBe(true)
    expect(tc.results.toString()).toContain('handler exploded')
  })
})

describe('OpenAIResponsesAdapter — tool-call round-trip (streaming)', () => {
  it('streamed tool call accumulates args via delta then authoritative .done, persists successfully', async () => {
    const tools = new ToolRegistry([makeTool('search')])
    const frames = [
      responsesAddedFrame(0, {
        type: 'function_call',
        id: 'fc_s1',
        call_id: 'call-s1',
        name: 'search',
        arguments: '',
      }),
      responsesFunctionCallArgsDeltaFrame(0, 'fc_s1', '{"q":'),
      responsesFunctionCallArgsDeltaFrame(0, 'fc_s1', '"partial'),
      responsesFunctionCallArgsDoneFrame(0, 'fc_s1', '{"q":"final"}'),
      responsesDoneFrame(0, {
        type: 'function_call',
        id: 'fc_s1',
        call_id: 'call-s1',
        name: 'search',
        arguments: '{"q":"final"}',
      }),
      responsesTerminalFrame(
        'completed',
        buildResponsesResponse({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_s1',
              call_id: 'call-s1',
              name: 'search',
              arguments: '{"q":"final"}',
            },
          ],
        })
      ),
    ]
    const cassette = {
      name: 'stream-toolcall',
      interactions: [{ request: { method: 'POST' as const }, response: { sse: frames } }],
    }
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: true,
    })
    const ctx = makeCtx({ tools })
    await adapter.executor()(ctx, makeHelpers())
    expect(ctx._stored.toolCalls).toHaveLength(1)
    expect(ctx._stored.toolCalls[0]!.args).toEqual({ q: 'final' })
    expect(ctx._stored.toolCalls[0]!.isError).toBe(false)
    expect(ctx._stored.toolCalls[0]!.id).toBe('call-s1|fc_s1')
  })
})

describe('OpenAIResponsesAdapter — tool_choice forged-artifact guard', () => {
  const makeEphemeralTool = (name: string) =>
    new Tool({
      name,
      description: `ephemeral ${name}`,
      inputSchema: validator.object({}),
      handler: () => 'ok',
      ephemeral: true,
    })

  const makeRegularTool = (name: string) =>
    new Tool({
      name,
      description: `regular ${name}`,
      inputSchema: validator.object({}),
      handler: () => 'ok',
    })

  it('warns when tool_choice forces an ephemeral forged tool (default, non-strict)', async () => {
    const cassette = singleResponsesResponseCassette('forced-forged', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
      tool_choice: { type: 'function', name: 'artifact_head' },
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_head')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    const hits = helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.level).toBe('warn')
    expect((hits[0]!.payload as { toolNames: string[] }).toolNames).toEqual(['artifact_head'])
  })

  it('throws E_INVALID_OPENAI_RESPONSES_OPTIONS under strictToolChoice:true', async () => {
    const cassette = singleResponsesResponseCassette('forced-forged-strict', { content: 'ok' })
    const fetchFn = vi.fn(cassetteFetch(cassette))
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: fetchFn as never,
      stream: false,
      strictToolChoice: true,
      tool_choice: { type: 'function', name: 'artifact_grep' },
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_grep')])
    const ctx = makeCtx({ tools })
    await expect(adapter.executor()(ctx, makeHelpers())).rejects.toBeInstanceOf(
      E_INVALID_OPENAI_RESPONSES_OPTIONS
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not warn when tool_choice targets a non-ephemeral (regular) tool', async () => {
    const cassette = singleResponsesResponseCassette('regular-choice', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
      tool_choice: { type: 'function', name: 'normal_tool' },
    })
    const tools = new ToolRegistry([makeRegularTool('normal_tool')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')).toHaveLength(0)
  })

  it('does not warn when tool_choice is "auto"/"required" (no specific name)', async () => {
    const cassette = singleResponsesResponseCassette('auto-choice', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
      tool_choice: 'required',
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_head')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')).toHaveLength(0)
  })

  it('does not warn when tool_choice is unset', async () => {
    const cassette = singleResponsesResponseCassette('unset-choice', { content: 'ok' })
    const adapter = new OpenAIResponsesAdapter({
      model: 'm',
      fetch: cassetteFetch(cassette) as never,
      stream: false,
      autoAck: true,
    })
    const tools = new ToolRegistry([makeEphemeralTool('artifact_head')])
    const ctx = makeCtx({ tools })
    const helpers = makeHelpers()
    await adapter.executor()(ctx, helpers)
    expect(helpers._logs.filter((l) => l.kind === 'tool-choice-forged-artifact')).toHaveLength(0)
  })
})
