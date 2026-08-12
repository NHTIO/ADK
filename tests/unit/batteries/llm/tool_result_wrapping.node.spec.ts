import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { isInstanceOf } from '@nhtio/adk/guards'
import { describe, expect, it, vi } from 'vitest'
import { makeFixtureRunner } from '../../../_fixtures/runner'
import { OllamaAdapter } from '@nhtio/adk/batteries/llm/ollama'
import { LiteRtLmAdapter } from '@nhtio/adk/batteries/llm/litert_lm'
import { scriptedExecutor } from '../../../_fixtures/scripted_executor'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import { AnthropicMessagesAdapter } from '@nhtio/adk/batteries/llm/anthropic_messages'
import { WebLLMChatCompletionsAdapter } from '@nhtio/adk/batteries/llm/webllm_chat_completions'
import { OpenAIChatCompletionsAdapter } from '@nhtio/adk/batteries/llm/openai_chat_completions'
import { renderChatCompletionsToolCallResult } from '@nhtio/adk/batteries/llm/openai_chat_completions'
import {
  looksLikeSpooledArtifact,
  renderArtifactHandleBody,
} from '@nhtio/adk/batteries/llm/chat_common/helpers'
import {
  Media,
  SpooledArtifact,
  SpooledJsonArtifact,
  Tool,
  ToolCall,
  ToolRegistry,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'

const now = DateTime.fromISO('2026-01-01T00:00:00Z', { zone: 'utc' })
const rawCall = (result: unknown, id = 'tc-1'): ToolCall =>
  new ToolCall({
    id,
    tool: 'read_file',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results: result as never,
    inline: false,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  })

const makeTool = (
  handler: () => unknown,
  artifactConstructor?: () => typeof SpooledArtifact | typeof SpooledJsonArtifact
) =>
  new Tool({
    name: 'read_file',
    description: 'read',
    inputSchema: validator.object({}),
    artifactConstructor,
    handler: handler as never,
  })

const runScript = async (
  handler: () => unknown,
  artifactConstructor?: () => typeof SpooledArtifact | typeof SpooledJsonArtifact
) => {
  const source = new InMemorySpoolStore()
  const returned = handler()
  const tool = makeTool(() => returned, artifactConstructor)
  const exec = scriptedExecutor([{ toolCalls: [{ tool: 'read_file', args: {} }] }, { ack: true }])
  const { run, events } = makeFixtureRunner({ executorCallback: exec, tools: [tool] })
  await run()
  const resultEvent = events.find(
    (event) =>
      event.kind === 'toolCall' && (event.payload as { results?: unknown }).results !== undefined
  )
  return { exec, result: (resultEvent?.payload as { results: unknown }).results, source }
}

type CountingSpoolStore = InMemorySpoolStore & { writes: number }

const countingStore = (): CountingSpoolStore => {
  const store = new InMemorySpoolStore() as CountingSpoolStore
  store.writes = 0
  const write = store.write.bind(store)
  store.write = ((...args: Parameters<InMemorySpoolStore['write']>) => {
    store.writes += 1
    return write(...args)
  }) as InMemorySpoolStore['write']
  return store
}

describe('tool result wrapping', () => {
  it('scripted executor passes a pre-built artifact through and does not use the declared constructor', async () => {
    const source = new InMemorySpoolStore()
    const returned = new SpooledJsonArtifact(source.write('source', '{"answer":42}'))
    const { exec, result } = await runScript(
      () => returned,
      () => SpooledArtifact
    )
    expect(result).toBe(returned)
    expect(await (result as SpooledArtifact).asString()).toBe('{"answer":42}')
    expect(exec.store.size).toBe(0)
  })

  it('forges JSON tools through the runner from the returned instance, not Tool.artifactConstructor', async () => {
    const source = new InMemorySpoolStore()
    const returned = new SpooledJsonArtifact(source.write('source', '{"answer":42}'))
    const seen: string[][] = []
    let produced = false
    const tool = makeTool(
      () => {
        produced = true
        return returned
      },
      () => SpooledArtifact
    )
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'read_file', args: {} }] },
      { toolCalls: [{ tool: 'read_file', args: {} }], ack: true },
    ])
    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [tool],
      fetchToolCallsCallback: async () => [rawCall(returned)],
      dispatchInputPipeline: [
        async (ctx, next) => {
          seen.push(ctx.tools.all().map((item) => item.name))
          await next()
        },
      ],
    })
    await run()
    expect(produced, 'the handler must actually have run').toBe(true)
    const forgedNames = seen.flat().filter((name) => name.startsWith('artifact_'))
    expect(forgedNames).toContain('artifact_json_keys')
    expect(forgedNames).not.toContain('artifact_text')
  })

  it('forges only base tools through the runner when the returned instance is plain', async () => {
    const source = new InMemorySpoolStore()
    const returned = new SpooledArtifact(source.write('source', 'plain'))
    const seen: string[][] = []
    let produced = false
    const tool = makeTool(
      () => {
        produced = true
        return returned
      },
      () => SpooledJsonArtifact
    )
    const exec = scriptedExecutor([
      { toolCalls: [{ tool: 'read_file', args: {} }] },
      { toolCalls: [{ tool: 'read_file', args: {} }], ack: true },
    ])
    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [tool],
      fetchToolCallsCallback: async () => [rawCall(returned)],
      dispatchInputPipeline: [
        async (ctx, next) => {
          seen.push(ctx.tools.all().map((item) => item.name))
          await next()
        },
      ],
    })
    await run()
    // Assert the handler RAN before asserting what it did not forge: `not.toContain` passes
    // trivially on a run where the tool was never invoked, so this flag is what makes the
    // negative assertion below discriminating rather than vacuous.
    expect(produced, 'the handler must actually have run').toBe(true)
    const forgedNames = seen.flat().filter((name) => name.startsWith('artifact_'))
    expect(forgedNames).toContain('artifact_head')
    expect(forgedNames).not.toContain('artifact_json_keys')
  })

  it('forges JSON tools from the returned instance, not Tool.artifactConstructor', () => {
    const source = new InMemorySpoolStore()
    const returned = new SpooledJsonArtifact(source.write('source', '{"answer":42}'))
    const names = SpooledJsonArtifact.forgeTools({
      turnToolCalls: new Set([rawCall(returned)]),
      tools: new ToolRegistry(),
    } as never)
      .all()
      .map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['artifact_head', 'artifact_json_keys']))
    expect(names).not.toEqual(expect.arrayContaining(['artifact_text']))
  })

  it('a plain artifact from a JSON-declaring tool gets only base tools', () => {
    const store = new InMemorySpoolStore()
    const returned = new SpooledArtifact(store.write('base', 'plain'))
    const names = SpooledArtifact.forgeTools({
      turnToolCalls: new Set([rawCall(returned)]),
      tools: new ToolRegistry(),
    } as never)
      .all()
      .map((item) => item.name)
    expect(names).toContain('artifact_head')
    expect(names).not.toContain('artifact_json_keys')
  })

  it('a structural look-alike renders through the handle path but forges no tools', async () => {
    const lookalike = {
      asString: async () => 'rendered',
      byteLength: async () => 8,
      lineCount: async () => 1,
      estimateTokens: async () => 1,
    }
    expect(looksLikeSpooledArtifact(lookalike)).toBe(true)
    expect(SpooledArtifact.isSpooledArtifact(lookalike)).toBe(false)
    const rendered = await renderChatCompletionsToolCallResult({
      toolCall: rawCall(new SpooledArtifact(new InMemorySpoolStore().write('valid', 'valid'))),
      results: lookalike as never,
      tool: undefined,
      renderUntrustedContent: (body) => body,
      renderTrustedContent: (body) => body,
      unsupportedMediaPolicy: 'synthetic-description',
    })
    expect(rendered).toContain('callId=tc-1')
    const directRendered = renderArtifactHandleBody({
      callId: 'tc-lookalike',
      artifact: lookalike,
      byteLength: await lookalike.byteLength(),
      lineCount: await lookalike.lineCount(),
    })
    expect(directRendered).toContain('callId=tc-lookalike')
    const forged = SpooledArtifact.forgeTools({
      turnToolCalls: new Set([{ fromArtifactTool: false, results: lookalike }]),
      tools: new ToolRegistry(),
    } as never)
    expect(forged.all()).toHaveLength(0)
  })

  it('passes pre-built artifacts through all six LLM adapters and still spools strings', async () => {
    type AdapterExecutor = (ctx: unknown, helpers: DispatchExecutorHelpers) => Promise<unknown>
    type Case = {
      name: string
      execute: (
        tool: Tool,
        store: CountingSpoolStore,
        capture: (call: ToolCall) => void
      ) => AdapterExecutor
    }
    const cases: Case[] = [
      {
        name: 'openai_chat_completions',
        execute: (_tool, store, _capture) => {
          const fetch = async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call-1',
                          type: 'function',
                          function: { name: 'read_file', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              }),
              { headers: { 'content-type': 'application/json' } }
            )
          const adapter = new OpenAIChatCompletionsAdapter({
            model: 'm',
            stream: false,
            fetch: fetch as never,
            spoolStore: store,
          })
          return async (ctx, helpers) => adapter.executor()(ctx as never, helpers)
        },
      },
      {
        name: 'anthropic_messages',
        execute: (_tool, store, _capture) => {
          const fetch = async () =>
            new Response(
              JSON.stringify({
                id: 'm-1',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }],
                stop_reason: 'tool_use',
              }),
              { headers: { 'content-type': 'application/json' } }
            )
          const adapter = new AnthropicMessagesAdapter({
            apiKey: 'k',
            model: 'm',
            maxTokens: 32,
            stream: false,
            fetch: fetch as never,
            spoolStore: store,
          })
          return async (ctx, helpers) => adapter.executor()(ctx as never, helpers)
        },
      },
      {
        name: 'transformers_js',
        execute: (_tool, store, _capture) => {
          const pipeline = vi.fn(async () => [
            {
              generated_text: [
                {
                  role: 'assistant',
                  content: '<tool_call>{"name":"read_file","arguments":{}}</tool_call>',
                },
              ],
            },
          ])
          ;(pipeline as unknown as { tokenizer: unknown }).tokenizer = { all_special_ids: [] }
          const adapter = new TransformersJsAdapter({
            model: 'm',
            stream: false,
            pipeline: pipeline as never,
            spoolStore: store,
          })
          return async (ctx, helpers) => adapter.executor()(ctx as never, helpers)
        },
      },
      {
        name: 'litert_lm',
        execute: (_tool, store, _capture) => {
          const conversation = {
            sendMessage: vi.fn(async () => ({
              role: 'assistant',
              content: '<tool_call>{"name":"read_file","arguments":{}}</tool_call>',
            })),
            sendMessageStreaming: vi.fn(),
            cancel: vi.fn(),
            delete: vi.fn(),
            getHistory: vi.fn(() => []),
          }
          const engine = { createConversation: vi.fn(async () => conversation) }
          const adapter = new LiteRtLmAdapter({
            model: 'm',
            stream: false,
            engine: engine as never,
            spoolStore: store,
          })
          return async (ctx, helpers) => adapter.executor()(ctx as never, helpers)
        },
      },
      {
        name: 'webllm_chat_completions',
        execute: (_tool, store, _capture) => {
          const engine = {
            chat: {
              completions: {
                create: vi.fn(async () => ({
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                          {
                            id: 'call-1',
                            type: 'function',
                            function: { name: 'read_file', arguments: '{}' },
                          },
                        ],
                      },
                    },
                  ],
                })),
              },
            },
          }
          const adapter = new WebLLMChatCompletionsAdapter({
            model: 'm',
            stream: false,
            engine: engine as never,
            spoolStore: store,
          })
          return async (ctx, helpers) => adapter.executor()(ctx as never, helpers)
        },
      },
      {
        name: 'ollama',
        execute: (_tool, store, _capture) => {
          const fetch = async () =>
            new Response(
              JSON.stringify({
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
                },
                done: true,
              }),
              { headers: { 'content-type': 'application/json' } }
            )
          const adapter = new OllamaAdapter({
            model: 'm',
            stream: false,
            fetch: fetch as never,
            spoolStore: store,
          })
          return async (ctx, helpers) => adapter.executor()(ctx as never, helpers)
        },
      },
    ]

    for (const item of cases) {
      const store = countingStore()
      let held: unknown
      const artifact = new SpooledArtifact(new InMemorySpoolStore().write('held', 'artifact'))
      const tool = makeTool(() => held)
      const captured: ToolCall[] = []
      const execute = item.execute(tool, store, (call) => captured.push(call))
      held = artifact
      const helpers = {
        reportMessage: vi.fn(),
        reportThought: vi.fn(),
        reportToolCall: vi.fn(),
        log: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        reportGenerationStats: vi.fn(),
      } as unknown as DispatchExecutorHelpers
      await execute(
        makeDispatchContext({
          tools: [tool],
          storeToolCall: async (_ctx, call) => {
            captured.push(call)
          },
        }),
        helpers
      )
      expect(captured, item.name).toHaveLength(1)
      expect(captured[0]!.results, item.name).toBe(artifact)
      expect(store.writes, item.name).toBe(0)

      held = 'plain string'
      const stringCaptured: ToolCall[] = []
      await item.execute(tool, store, (call) => stringCaptured.push(call))(
        makeDispatchContext({
          tools: [tool],
          storeToolCall: async (_ctx, call) => {
            stringCaptured.push(call)
          },
        }),
        helpers
      )
      expect(stringCaptured[0]!.results, item.name).not.toBe(held)
      expect(store.writes, item.name).toBe(1)

      const bytes = new Uint8Array([0, 1, 255, 3])
      const bytesStart = store.writes
      held = bytes
      const bytesCaptured: ToolCall[] = []
      await item.execute(tool, store, (call) => bytesCaptured.push(call))(
        makeDispatchContext({
          tools: [tool],
          storeToolCall: async (_ctx, call) => {
            bytesCaptured.push(call)
          },
        }),
        helpers
      )
      expect(
        isInstanceOf(bytesCaptured[0]!.results, 'SpooledArtifact', SpooledArtifact),
        item.name
      ).toBe(true)
      expect(store.writes - bytesStart, item.name).toBe(1)

      const media = new Media({
        kind: 'image',
        mimeType: 'image/png',
        filename: `${item.name}.png`,
        reader: inMemoryMediaReader(new Uint8Array([137, 80, 78, 71])),
        trustTier: 'first-party',
        modalityHazard: 'opaque-perceptual',
      })
      const mediaStart = store.writes
      held = media
      const mediaCaptured: ToolCall[] = []
      await item.execute(tool, store, (call) => mediaCaptured.push(call))(
        makeDispatchContext({
          tools: [tool],
          storeToolCall: async (_ctx, call) => {
            mediaCaptured.push(call)
          },
        }),
        helpers
      )
      expect(mediaCaptured[0]!.results, item.name).toBe(media)
      expect(store.writes - mediaStart, item.name).toBe(0)
    }
  })

  it('keeps string, Uint8Array, and Media results on their existing paths', async () => {
    const stringResult = await runScript(
      () => 'unchanged',
      () => SpooledJsonArtifact
    )
    expect(isInstanceOf(stringResult.result, 'SpooledJsonArtifact', SpooledJsonArtifact)).toBe(true)
    expect(await (stringResult.result as SpooledArtifact).asString()).toBe('unchanged')
    expect(stringResult.exec.store.size).toBe(1)

    const bytes = new Uint8Array([0, 1, 255, 3])
    const bytesResult = await runScript(() => bytes)
    expect(isInstanceOf(bytesResult.result, 'SpooledArtifact', SpooledArtifact)).toBe(true)
    expect(await (bytesResult.result as SpooledArtifact).asString()).toBe(
      new TextDecoder().decode(bytes)
    )
    expect(bytesResult.exec.store.size).toBe(1)

    const media = new Media({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'pixel.png',
      reader: inMemoryMediaReader(new Uint8Array([137, 80, 78, 71])),
      trustTier: 'first-party',
      modalityHazard: 'opaque-perceptual',
    })
    const mediaResult = await runScript(() => media)
    expect(mediaResult.result).toBe(media)
    expect(mediaResult.exec.store.size).toBe(0)
  })
})
