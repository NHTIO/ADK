// `localToolCallParser` — the opt-in fallback that recovers a tool call from assistant `content` when the
// WebLLM engine's `message.tool_calls` came back empty. Native tool-calling stays authoritative; this only
// fires when `tool_calls` is empty AND the option is set. Covers: (a) default OFF (unchanged), (b) opt-in
// recovers a `<call:name{…}` call and executes it, (c) native calls present → fallback NOT consulted —
// across the non-streaming and streaming paths, plus the onRawGeneration reflection.
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { WebLLMChatCompletionsAdapter } from '@nhtio/adk/batteries/llm/webllm_chat_completions'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Tool,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}
interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (tools: ToolRegistry): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
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

const makeHelpers = (): DispatchExecutorHelpers => {
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn(),
  } as unknown as DispatchExecutorHelpers
}

const echoTool = (): Tool =>
  new Tool({
    name: 'echo',
    description: 'echo tool',
    inputSchema: validator.object({ text: validator.string().required() }),
    handler: (args: unknown) => `echoed: ${(args as { text: string }).text}`,
  })

const GEMMA_CALL_TEXT = '<call:echo{"text": "hi"}>'

// A non-streaming fake engine returning a single assistant message (optional native tool_calls).
const makeEngine = (msg: Record<string, unknown>) => ({
  chat: {
    completions: {
      create: vi.fn(async () => ({
        id: 'cmpl-1',
        choices: [{ message: { role: 'assistant', ...msg } }],
      })),
    },
  },
})

// A streaming fake engine that yields content deltas.
const makeStreamingEngine = (parts: string[]) => ({
  chat: {
    completions: {
      create: vi.fn(async () => {
        async function* gen() {
          for (const part of parts) yield { choices: [{ delta: { content: part } }] }
        }
        return gen()
      }),
    },
  },
})

const base = { model: 'fam/model', isWebGPUAvailable: () => true }

describe('WebLLMChatCompletionsAdapter — localToolCallParser (fallback recovery)', () => {
  describe('default OFF (backward-compatible)', () => {
    it('non-streaming: a `<call:…>` in content with empty tool_calls yields NO tool call', async () => {
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        stream: false,
        engine: makeEngine({ content: GEMMA_CALL_TEXT }) as never,
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(0)
    })

    it('streaming: same, no tool call recovered without the option', async () => {
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        engine: makeStreamingEngine([GEMMA_CALL_TEXT]) as never,
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(0)
    })
  })

  describe('opt-in: localToolCallParser recovers the call', () => {
    it('non-streaming: parses `<call:echo{…}>`, executes it (args JSON-stringified), does not ack', async () => {
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        stream: false,
        localToolCallParser: 'gemma',
        engine: makeEngine({ content: GEMMA_CALL_TEXT }) as never,
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(1)
      expect(ctx._stored.toolCalls[0]!.tool).toBe('echo')
      expect(ctx._stored.toolCalls[0]!.args).toEqual({ text: 'hi' })
      expect(ctx._stored.toolCalls[0]!.isError).toBe(false)
      expect(ctx.ack).not.toHaveBeenCalled()
    })

    it('streaming: recovers the call from accumulated content', async () => {
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        localToolCallParser: 'gemma',
        engine: makeStreamingEngine([GEMMA_CALL_TEXT]) as never,
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(1)
      expect(ctx._stored.toolCalls[0]!.args).toEqual({ text: 'hi' })
    })

    it('surfaces the recovered call on onRawGeneration.toolCalls', async () => {
      const seen: Array<{ name: string }> = []
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        stream: false,
        localToolCallParser: 'gemma',
        onRawGeneration: (o: { toolCalls: ReadonlyArray<{ name: string }> }) => {
          seen.push(...o.toolCalls)
        },
        engine: makeEngine({ content: GEMMA_CALL_TEXT }) as never,
      }).executor()(ctx, makeHelpers())
      expect(seen.map((c) => c.name)).toEqual(['echo'])
    })

    it('no match in content → no tool call, terminal answer stands', async () => {
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        stream: false,
        localToolCallParser: 'gemma',
        engine: makeEngine({ content: 'just a plain prose answer' }) as never,
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(0)
    })
  })

  describe('native calls win (fallback not consulted)', () => {
    it('non-streaming: native tool_calls present → parser does not double-execute', async () => {
      const ctx = makeCtx(new ToolRegistry([echoTool()]))
      await new WebLLMChatCompletionsAdapter({
        ...base,
        stream: false,
        localToolCallParser: 'gemma',
        engine: makeEngine({
          content: GEMMA_CALL_TEXT, // decoy also in content
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":"native"}' },
            },
          ],
        }) as never,
      }).executor()(ctx, makeHelpers())
      expect(ctx._stored.toolCalls).toHaveLength(1)
      expect(ctx._stored.toolCalls[0]!.args).toEqual({ text: 'native' })
    })
  })
})
