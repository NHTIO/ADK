/**
 * Invalid-tool-args end-to-end coverage for the OpenAI Chat Completions adapter.
 *
 * When the LLM emits a tool call whose arguments fail the tool's `inputSchema`,
 * the harness contract is:
 *
 *   1. `Tool.executor()` rejects with `E_INVALID_TOOL_ARGS` BEFORE the handler runs.
 *   2. The adapter catches the rejection inside `executeAndPersistToolCall` and
 *      wraps `err.message` in a `Tokenizable` as the tool result.
 *   3. The resulting `ToolCall` record is persisted with `isError: true` so the
 *      model sees the validation failure in the next iteration's history and
 *      can retry with corrected arguments.
 *
 * These tests assert all three pieces against a mocked `fetch` so we can script
 * an LLM that emits exactly the bad arguments we want, without a live model in
 * the loop. Cross-platform (no node imports) — runs in every vitest project.
 */
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { Tool, ToolRegistry, Registry, Tokenizable, SpooledArtifact } from '@nhtio/adk/common'
import {
  OpenAIChatCompletionsAdapter,
  E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'
import type { DispatchContext } from '@nhtio/adk/types'
import type { Message, Thought, ToolCall } from '@nhtio/adk/common'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

interface StoredState {
  toolCalls: ToolCall[]
  messages: Message[]
  thoughts: Thought[]
}

interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (tools: ToolRegistry): MockCtx => {
  const stored: StoredState = { toolCalls: [], messages: [], thoughts: [] }
  return {
    systemPrompt: new Tokenizable('You are a helpful assistant.'),
    turnMessages: new Set(),
    turnThoughts: new Set(),
    turnToolCalls: new Set(),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(),
    tools,
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
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
    mutateToolCall: vi.fn(),
    _stored: stored,
  } as unknown as MockCtx
}

const makeHelpers = (): DispatchExecutorHelpers & {
  _events: Array<{ kind: string; id: string; payload: unknown }>
} => {
  const events: Array<{ kind: string; id: string; payload: unknown }> = []
  const noopLog = vi.fn()
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
      trace: noopLog,
      debug: noopLog,
      info: noopLog,
      warn: noopLog,
      error: noopLog,
    },
    reportGenerationStats: noopLog,
    _events: events,
  } as unknown as DispatchExecutorHelpers & { _events: typeof events }
}

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const toolCallResponse = (calls: Array<{ id: string; name: string; arguments: string }>) =>
  jsonResponse({
    id: 'resp-tc',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-x',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
  })

const echoTool = () =>
  new Tool({
    name: 'echo',
    description: 'Echoes the input text.',
    inputSchema: validator.object({
      text: validator.string().required().description('Text to echo'),
    }),
    handler: async (args: unknown) => `echoed: ${(args as { text: string }).text}`,
  })

const calculatorTool = (handler?: (args: unknown) => string | Promise<string>) =>
  new Tool({
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: validator.object({
      a: validator.number().required().description('First addend'),
      b: validator.number().required().description('Second addend'),
    }),
    handler:
      handler ??
      (async (args: unknown) =>
        String((args as { a: number; b: number }).a + (args as { a: number; b: number }).b)),
  })

describe('OpenAIChatCompletionsAdapter — invalid tool args (validation failure)', () => {
  describe('missing required field', () => {
    it('persists the ToolCall with isError: true when a required field is omitted', async () => {
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-bad-1', name: 'echo', arguments: JSON.stringify({}) }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      expect(stored.tool).toBe('echo')
      expect(stored.isComplete).toBe(true)
    })

    it('captures field-level validation detail in the persisted tool result', async () => {
      // The adapter unwraps the `ValidationException` on `err.cause` so the
      // joined joi field-level message ("\"text\" is required") reaches the
      // model alongside the generic headline. Without the field name a model
      // would have to re-derive the schema on every retry.
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-bad-2', name: 'echo', arguments: JSON.stringify({}) }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      const errMsg = stored.results.toString().toLowerCase()
      // The generic headline AND the field-level detail are both present.
      expect(errMsg).toContain('input schema validation')
      expect(errMsg).toMatch(/text/)
      expect(errMsg).toMatch(/required/)
    })

    it('reports isError: true through the helpers.reportToolCall event', async () => {
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-bad-3', name: 'echo', arguments: JSON.stringify({}) }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      const completionEvents = helpers._events.filter(
        (e) =>
          e.kind === 'toolCall' &&
          (e.payload as { isComplete?: boolean; isError?: boolean }).isComplete === true
      )
      expect(completionEvents).toHaveLength(1)
      expect((completionEvents[0].payload as { isError?: boolean }).isError).toBe(true)
    })

    it('does NOT run the handler when validation fails', async () => {
      const handler = vi.fn(async () => 'should not be called')
      const tool = new Tool({
        name: 'echo',
        description: 'Echoes the input text.',
        inputSchema: validator.object({
          text: validator.string().required().description('Text to echo'),
        }),
        handler,
      })
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-no-handler', name: 'echo', arguments: JSON.stringify({}) }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      expect(handler).not.toHaveBeenCalled()
    })

    it('does NOT emit toolExecutionStart / toolExecutionEnd on validation failure', async () => {
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-no-events', name: 'echo', arguments: JSON.stringify({}) }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      expect(ctx.emitToolExecutionStart).not.toHaveBeenCalled()
      expect(ctx.emitToolExecutionEnd).not.toHaveBeenCalled()
    })
  })

  describe('wrong type for required field', () => {
    it('flags isError: true when a number field is given a string', async () => {
      const tool = calculatorTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          {
            id: 'call-wrong-type',
            name: 'add',
            arguments: JSON.stringify({ a: 'not-a-number', b: 2 }),
          },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      // Error message references the offending field
      expect(stored.results.toString().toLowerCase()).toContain('a')
    })

    it('still persists the args the model emitted, so the model can see what it sent', async () => {
      const tool = calculatorTool()
      const badArgs = { a: 'not-a-number', b: 2 }
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          { id: 'call-persist-args', name: 'add', arguments: JSON.stringify(badArgs) },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      expect(stored.args).toEqual(badArgs)
    })
  })

  describe('malformed JSON arguments', () => {
    it('does NOT crash the dispatch when the model emits non-JSON arguments', async () => {
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          { id: 'call-malformed', name: 'echo', arguments: '{this is not valid json' },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      // The adapter detects the parse failure, short-circuits to a persisted
      // error ToolCall, and surfaces a recoverable result to the model.
      await expect(adapter.executor()(ctx, makeHelpers())).resolves.toBeUndefined()
      expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      expect(stored.results.toString().toLowerCase()).toContain('not valid json')
    })

    it('preserves the raw malformed-args string in the persisted error message', async () => {
      const tool = echoTool()
      const malformed = '{this is not valid json'
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-malformed-2', name: 'echo', arguments: malformed }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      // The error message shows the model exactly what it sent, so the model
      // can see where its emission went wrong on the next iteration.
      expect(stored.results.toString()).toContain(malformed)
      // The persisted args fall back to an empty object since the raw string
      // could not be parsed into a `Record<string, unknown>` — that's the
      // RawToolCall.args schema contract.
      expect(stored.args).toEqual({})
    })

    it('rejects a JSON value that is not an object (e.g. a bare string)', async () => {
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          { id: 'call-nonobj', name: 'echo', arguments: JSON.stringify('just a string') },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      expect(stored.results.toString().toLowerCase()).toContain('must be a json object')
    })

    it('formats the persisted error via the structured E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS exception', async () => {
      // Consumers introspecting persisted tool-call error results need a stable
      // marker to match on. The adapter formats the message via the structured
      // exception, so the canonical headline is identical regardless of which
      // parse path triggered it.
      const tool = echoTool()
      const raw = '{this is not valid json'
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-structured', name: 'echo', arguments: raw }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const expected = new E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS([
        'are not valid JSON',
        raw,
      ])
      const stored = ctx._stored.toolCalls[0]
      expect(stored.results.toString()).toBe(expected.message)
    })

    it('the structured exception class has the expected static metadata', () => {
      const inst = new E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS([
        'are not valid JSON',
        '{oops',
      ])
      expect(inst.code).toBe('E_OPENAI_CHAT_COMPLETIONS_INVALID_TOOL_CALL_ARGS')
      expect(inst.status).toBe(422)
      expect(inst.fatal).toBe(false)
      expect(inst.message).toContain('are not valid JSON')
      expect(inst.message).toContain('{oops')
    })
  })

  describe('extra unknown fields', () => {
    it('rejects unknown fields if the schema disallows them', async () => {
      // Schema with strict `unknown(false)` semantics — default joi behaviour
      // is strict, so extra keys reject.
      const tool = new Tool({
        name: 'echo',
        description: 'Echoes only the text field.',
        inputSchema: validator.object({
          text: validator.string().required().description('Text to echo'),
        }),
        handler: async (args: unknown) => `echoed: ${(args as { text: string }).text}`,
      })
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          {
            id: 'call-extra-field',
            name: 'echo',
            arguments: JSON.stringify({ text: 'hi', surprise: 'extra' }),
          },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      // Field-level detail from the joi cause chain reaches the model — it
      // names `surprise` and says "not allowed" so the model can drop the key.
      expect(stored.results.toString().toLowerCase()).toMatch(/surprise|not allowed|unknown/)
    })
  })

  describe('unknown tool name', () => {
    it('persists an isError: true tool result when the model invokes a non-registered tool', async () => {
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          {
            id: 'call-unknown',
            name: 'mystery_tool',
            arguments: JSON.stringify({ x: 1 }),
          },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry())

      await adapter.executor()(ctx, makeHelpers())

      expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      expect(stored.tool).toBe('mystery_tool')
      expect(stored.results.toString()).toContain('mystery_tool')
    })
  })

  describe('mixed valid + invalid in one response', () => {
    it('flags each tool call independently — invalid one isError: true, valid one isError: false', async () => {
      const echo = echoTool()
      const add = calculatorTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          // Valid call
          { id: 'call-good', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
          // Invalid call — `a` is a string, schema requires number
          { id: 'call-bad', name: 'add', arguments: JSON.stringify({ a: 'oops', b: 2 }) },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([echo, add]))

      await adapter.executor()(ctx, makeHelpers())

      expect(ctx.storeToolCall).toHaveBeenCalledTimes(2)
      const byId = new Map(ctx._stored.toolCalls.map((tc) => [tc.id, tc]))
      expect(byId.get('call-good')?.isError).toBe(false)
      const goodResults = byId.get('call-good')?.results as SpooledArtifact
      expect(await goodResults.asString()).toContain('echoed: hi')
      expect(byId.get('call-bad')?.isError).toBe(true)
    })

    it('emits one isComplete tool-call event per call with the correct isError flag', async () => {
      const echo = echoTool()
      const add = calculatorTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          { id: 'call-ev-good', name: 'echo', arguments: JSON.stringify({ text: 'hi' }) },
          { id: 'call-ev-bad', name: 'add', arguments: JSON.stringify({ a: 'oops', b: 2 }) },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([echo, add]))
      const helpers = makeHelpers()

      await adapter.executor()(ctx, helpers)

      const completions = helpers._events.filter(
        (e) => e.kind === 'toolCall' && (e.payload as { isComplete?: boolean }).isComplete === true
      )
      expect(completions).toHaveLength(2)
      const goodEv = completions.find((e) => e.id === 'call-ev-good')!
      const badEv = completions.find((e) => e.id === 'call-ev-bad')!
      expect((goodEv.payload as { isError?: boolean }).isError).toBe(false)
      expect((badEv.payload as { isError?: boolean }).isError).toBe(true)
    })
  })

  describe('two-iteration recovery (model corrects itself after seeing error)', () => {
    it('first iteration bad args → second iteration good args: both ToolCalls persisted with correct isError flags', async () => {
      let callIdx = 0
      const tool = echoTool()
      const fetchFn = vi.fn(async () => {
        callIdx += 1
        if (callIdx === 1) {
          // Iteration 1: bad args (missing required `text`)
          return toolCallResponse([
            { id: 'call-iter1', name: 'echo', arguments: JSON.stringify({}) },
          ])
        }
        // Iteration 2: good args
        return toolCallResponse([
          { id: 'call-iter2', name: 'echo', arguments: JSON.stringify({ text: 'now correct' }) },
        ])
      })
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      // First dispatch (iteration 1) — bad args
      const ctx1 = makeCtx(new ToolRegistry([tool]))
      await adapter.executor()(ctx1, makeHelpers())
      expect(ctx1._stored.toolCalls[0].isError).toBe(true)

      // Second dispatch (iteration 2) — corrected args
      const ctx2 = makeCtx(new ToolRegistry([tool]))
      await adapter.executor()(ctx2, makeHelpers())
      expect(ctx2._stored.toolCalls[0].isError).toBe(false)
      const okResults = ctx2._stored.toolCalls[0].results as SpooledArtifact
      expect(await okResults.asString()).toContain('echoed: now correct')
    })

    it('the validation error message that travels with the failed ToolCall references the offending field', async () => {
      // Load-bearing for self-correction: the model sees this string in the
      // next iteration's history, so it must reference the offending field
      // name OR the word "required" for the model to act on it.
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-msg', name: 'echo', arguments: JSON.stringify({}) }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const errStr = ctx._stored.toolCalls[0].results.toString()
      expect(errStr.length).toBeGreaterThan(0)
      expect(errStr.toLowerCase()).toMatch(/text|required|missing/)
    })
  })

  describe('happy-path control (regression guard)', () => {
    it('valid args still flow through normally with isError: false', async () => {
      const tool = echoTool()
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          { id: 'call-ok', name: 'echo', arguments: JSON.stringify({ text: 'works' }) },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([tool]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(false)
      const okResults = stored.results as SpooledArtifact
      expect(await okResults.asString()).toContain('echoed: works')
    })
  })

  describe('unknown tool (not in registry)', () => {
    it('persists isError: true and lists the available tool names so the model can self-correct', async () => {
      // Two real tools registered; the model calls a third that does not exist.
      const fetchFn = vi.fn(async () =>
        toolCallResponse([
          { id: 'call-missing', name: 'web_search', arguments: JSON.stringify({ q: 'x' }) },
        ])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([echoTool(), calculatorTool()]))

      await adapter.executor()(ctx, makeHelpers())

      expect(ctx.storeToolCall).toHaveBeenCalledTimes(1)
      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      expect(stored.tool).toBe('web_search')
      const text = stored.results.toString()
      expect(text).toContain('Tool not found: web_search')
      // The remediation: the names of the tools that DO exist, sorted.
      expect(text).toContain('Available tools:')
      expect(text).toContain('add')
      expect(text).toContain('echo')
    })

    it('states no tools are available when the registry is empty', async () => {
      const fetchFn = vi.fn(async () =>
        toolCallResponse([{ id: 'call-missing-2', name: 'ghost', arguments: '{}' }])
      )
      const adapter = new OpenAIChatCompletionsAdapter({
        model: 'm',
        fetch: fetchFn as never,
        stream: false,
      })
      const ctx = makeCtx(new ToolRegistry([]))

      await adapter.executor()(ctx, makeHelpers())

      const stored = ctx._stored.toolCalls[0]
      expect(stored.isError).toBe(true)
      const text = stored.results.toString()
      expect(text).toContain('Tool not found: ghost')
      expect(text).toContain('No tools are available this turn.')
    })
  })
})
