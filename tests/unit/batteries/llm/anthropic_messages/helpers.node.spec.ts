import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  Message,
  Thought,
  Tool,
  ToolCall,
  ToolRegistry,
  Tokenizable,
  Retrievable,
  SpooledArtifact,
} from '@nhtio/adk/common'
import {
  buildAnthropicMessagesHistory,
  fingerprintAnthropicMessagesPrefix,
  renderAnthropicSegmentedSystemPrompt,
} from '@nhtio/adk/batteries/llm/anthropic_messages'
import {
  defaultRenderAnthropicThinkingBlocks,
  defaultRenderAnthropicTimelineMessage,
  defaultRenderAnthropicToolCallResult,
  defaultRenderChatCompletionsSystemPrompt,
  defaultRenderFirstPartyRetrievables,
  defaultRenderMemories,
  defaultRenderRetrievableSafetyDirective,
  defaultRenderRetrievables,
  defaultRenderStandingInstructions,
  defaultRenderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  defaultRenderThought,
  defaultRenderTrustedContent,
  defaultRenderUntrustedContent,
  filterThoughts,
} from '@nhtio/adk/batteries/llm/anthropic_messages'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const makeMessage = (overrides: {
  id: string
  role: 'user' | 'assistant'
  content?: string
  identity?: string
  createdAt: DateTime
}) =>
  new Message({
    id: overrides.id,
    role: overrides.role,
    content: overrides.content ?? 'hello',
    identity: overrides.identity as never,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  })

const makeThought = (overrides: {
  id: string
  content?: string
  payload?: unknown
  replayCompatibility?: string
  createdAt: DateTime
}) =>
  new Thought({
    id: overrides.id,
    content: overrides.content ?? 'reasoning',
    identity: 'assistant',
    payload: overrides.payload,
    replayCompatibility: overrides.replayCompatibility,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  })

const makeToolCall = (overrides: {
  id: string
  tool?: string
  args?: Record<string, unknown>
  isError?: boolean
  results?: string
  createdAt: DateTime
}) =>
  new ToolCall({
    id: overrides.id,
    tool: overrides.tool ?? 'search_docs',
    args: overrides.args ?? { q: 'x' },
    checksum: overrides.id,
    isComplete: true,
    isError: overrides.isError ?? false,
    results: new Tokenizable(overrides.results ?? 'tool-result'),
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    completedAt: overrides.createdAt,
  })

const makeTool = (name: string) =>
  new Tool({
    name,
    description: `${name} tool`,
    inputSchema: validator.object({}).unknown(true),
    handler: async () => 'ok',
  })

const buildHistory = async (input: {
  messages?: Message[]
  thoughts?: Thought[]
  toolCalls?: ToolCall[]
  retrievables?: Retrievable[]
  cacheBreakpoints?: 'auto' | 'system-only' | 'off'
  cacheTtl?: '5m' | '1h'
  bucketOrder?: Array<'standingInstructions' | 'memories' | 'retrievables' | 'timeline'>
  tools?: ToolRegistry
  warn?: (msg: string) => void
  renderRetrievableHandleBody?: (input: {
    callId: string
    artifact: unknown
    byteLength: number
    lineCount: number
  }) => string
}) =>
  buildAnthropicMessagesHistory({
    model: 'claude-opus-5',
    systemPrompt: new Tokenizable('System prompt'),
    standingInstructions: new Set([new Tokenizable('Stand here')]),
    memories: new Set(),
    retrievables: new Set(input.retrievables ?? []),
    messages: new Set(input.messages ?? []),
    thoughts: new Set(input.thoughts ?? []),
    toolCalls: new Set(input.toolCalls ?? []),
    tools: input.tools ?? new ToolRegistry([makeTool('search_docs'), makeTool('lookup_user')]),
    renderedToolCallResults: new Map(),
    bucketOrder: input.bucketOrder ?? [
      'standingInstructions',
      'memories',
      'retrievables',
      'timeline',
    ],
    selfIdentity: 'assistant',
    thoughtSurfacing: 'all-self',
    replayCompatibility: ['anthropic-messages-thinking-v1'],
    unsupportedMediaPolicy: 'throw',
    cacheBreakpoints: input.cacheBreakpoints ?? 'auto',
    cacheTtl: input.cacheTtl,
    renderAnthropicToolCallResult: defaultRenderAnthropicToolCallResult,
    renderChatCompletionsSystemPrompt: defaultRenderChatCompletionsSystemPrompt,
    renderAnthropicSegmentedSystemPrompt: renderAnthropicSegmentedSystemPrompt,
    renderStandingInstructions: defaultRenderStandingInstructions,
    renderMemories: defaultRenderMemories,
    renderRetrievables: defaultRenderRetrievables,
    renderRetrievableSafetyDirective: defaultRenderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: defaultRenderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: defaultRenderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: defaultRenderThirdPartyPrivateRetrievables,
    renderAnthropicTimelineMessage: defaultRenderAnthropicTimelineMessage,
    renderThought: defaultRenderThought,
    filterThoughts,
    renderAnthropicThinkingBlocks: defaultRenderAnthropicThinkingBlocks,
    renderUntrustedContent: defaultRenderUntrustedContent,
    renderTrustedContent: defaultRenderTrustedContent,
    renderRetrievableHandleBody: input.renderRetrievableHandleBody,
    warn: input.warn,
  })

describe('Anthropic helpers — prompt caching + history assembly', () => {
  it('places cache breakpoints on system, latest tool_result turn, and distinct final user turn', async () => {
    const msg1 = makeMessage({
      id: 'm1',
      role: 'user',
      content: 'first user',
      createdAt: dt('2026-01-01T00:00:00Z'),
    })
    const tc1 = makeToolCall({
      id: 'tc1',
      createdAt: dt('2026-01-01T00:00:01Z'),
    })
    const assistant = makeMessage({
      id: 'a1',
      role: 'assistant',
      content: 'assistant separates user turns',
      createdAt: dt('2026-01-01T00:00:02Z'),
    })
    const finalUser = makeMessage({
      id: 'm2',
      role: 'user',
      content: 'final user is distinct',
      createdAt: dt('2026-01-01T00:00:03Z'),
    })
    const built = await buildHistory({
      messages: [msg1, assistant, finalUser],
      toolCalls: [tc1],
    })

    expect(Array.isArray(built.system)).toBe(true)
    expect(
      ((built.system ?? []) as unknown as Array<Record<string, unknown>>).at(-1)?.cache_control
    ).toEqual({
      type: 'ephemeral',
    })

    expect(built.messages).toHaveLength(5)
    const toolResultTurn = built.messages[2] as unknown as {
      role: string
      content: Array<Record<string, unknown>>
    }
    const finalUserTurn = built.messages[4] as unknown as {
      role: string
      content: Array<Record<string, unknown>>
    }
    expect(toolResultTurn.role).toBe('user')
    expect(toolResultTurn.content).toHaveLength(1)
    expect(toolResultTurn.content[0]?.type).toBe('tool_result')
    expect(toolResultTurn.content[0]?.cache_control).toEqual({
      type: 'ephemeral',
    })
    expect(finalUserTurn.role).toBe('user')
    expect(finalUserTurn.content).toHaveLength(1)
    expect(finalUserTurn.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('final user is distinct'),
    })
    expect(finalUserTurn.content[0]?.cache_control).toEqual({
      type: 'ephemeral',
    })
  })

  it('forwards the handle renderer on both segmented and cacheBreakpoints=off paths', async () => {
    const store = new InMemorySpoolStore()
    const artifact = new SpooledArtifact(store.write('ret', 'anthropic secret'))
    const r = new Retrievable({
      id: 'ret',
      content: artifact,
      trustTier: 'first-party',
      inline: false,
      createdAt: dt('2026-01-01T00:00:00Z'),
      updatedAt: dt('2026-01-01T00:00:00Z'),
    })
    const handle = vi.fn(() => 'HANDLE_ONLY')
    for (const cacheBreakpoints of ['auto', 'off'] as const) {
      const built = await buildHistory({
        cacheBreakpoints,
        retrievables: [r],
        renderRetrievableHandleBody: handle,
      })
      expect(JSON.stringify(built.system)).toContain('HANDLE_ONLY')
      expect(JSON.stringify(built.system)).not.toContain('anthropic secret')
    }
    expect(handle).toHaveBeenCalled()
  })

  it('suppresses message-side cache controls for off/system-only and warns instead of emitting a fifth breakpoint', async () => {
    const eligibleMessages = [
      makeMessage({
        id: 'u-off',
        role: 'user',
        content: 'cacheable text',
        createdAt: dt('2026-01-01T00:00:00Z'),
      }),
    ]
    const off = await buildHistory({
      messages: eligibleMessages,
      cacheBreakpoints: 'off',
    })
    expect(typeof off.system === 'string').toBe(true)
    expect(
      off.messages.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, unknown>>) : []
      )
    ).toHaveLength(1)
    expect(
      off.messages.every(
        (m) =>
          !Array.isArray(m.content) ||
          !(m.content as unknown as Array<Record<string, unknown>>).some(
            (b) => 'cache_control' in b
          )
      )
    ).toBe(true)

    const systemOnly = await buildHistory({
      messages: eligibleMessages,
      cacheBreakpoints: 'system-only',
      cacheTtl: '1h',
    })
    expect(
      ((systemOnly.system ?? []) as unknown as Array<Record<string, unknown>>).at(-1)?.cache_control
    ).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(
      systemOnly.messages.every(
        (m) =>
          !Array.isArray(m.content) ||
          !(m.content as unknown as Array<Record<string, unknown>>).some(
            (b) => 'cache_control' in b
          )
      )
    ).toBe(true)

    const warn = vi.fn()
    const cap = await buildAnthropicMessagesHistory({
      model: 'claude-opus-5',
      systemPrompt: new Tokenizable('System prompt'),
      standingInstructions: new Set([new Tokenizable('Stand here')]),
      memories: new Set(),
      retrievables: new Set(),
      messages: new Set([
        makeMessage({
          id: 'u1',
          role: 'user',
          content: 'one',
          createdAt: dt('2026-01-01T00:00:00Z'),
        }),
        makeMessage({
          id: 'a1',
          role: 'assistant',
          content: 'two',
          createdAt: dt('2026-01-01T00:00:01Z'),
        }),
        makeMessage({
          id: 'u2',
          role: 'user',
          content: 'three',
          createdAt: dt('2026-01-01T00:00:03Z'),
        }),
      ]),
      thoughts: new Set(),
      toolCalls: new Set([makeToolCall({ id: 'tc-cap', createdAt: dt('2026-01-01T00:00:02Z') })]),
      tools: new ToolRegistry([makeTool('search_docs'), makeTool('lookup_user')]),
      renderedToolCallResults: new Map(),
      bucketOrder: ['standingInstructions', 'memories', 'retrievables', 'timeline'],
      selfIdentity: 'assistant',
      thoughtSurfacing: 'all-self',
      replayCompatibility: ['anthropic-messages-thinking-v1'],
      unsupportedMediaPolicy: 'throw',
      cacheBreakpoints: 'auto',
      renderAnthropicToolCallResult: defaultRenderAnthropicToolCallResult,
      renderChatCompletionsSystemPrompt: defaultRenderChatCompletionsSystemPrompt,
      renderAnthropicSegmentedSystemPrompt: async (input) => {
        const rendered = await renderAnthropicSegmentedSystemPrompt(input)
        return [
          ...rendered,
          {
            type: 'text' as const,
            text: 'extra system bucket 1',
            cache_control: { type: 'ephemeral' as const },
          },
          {
            type: 'text' as const,
            text: 'extra system bucket 2',
            cache_control: { type: 'ephemeral' as const },
          },
          {
            type: 'text' as const,
            text: 'extra system bucket 3',
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      },
      renderStandingInstructions: defaultRenderStandingInstructions,
      renderMemories: defaultRenderMemories,
      renderRetrievables: defaultRenderRetrievables,
      renderRetrievableSafetyDirective: defaultRenderRetrievableSafetyDirective,
      renderFirstPartyRetrievables: defaultRenderFirstPartyRetrievables,
      renderThirdPartyPublicRetrievables: defaultRenderThirdPartyPublicRetrievables,
      renderThirdPartyPrivateRetrievables: defaultRenderThirdPartyPrivateRetrievables,
      renderAnthropicTimelineMessage: defaultRenderAnthropicTimelineMessage,
      renderThought: defaultRenderThought,
      filterThoughts,
      renderAnthropicThinkingBlocks: defaultRenderAnthropicThinkingBlocks,
      renderUntrustedContent: defaultRenderUntrustedContent,
      renderTrustedContent: defaultRenderTrustedContent,
      warn,
    })
    const cacheControls = [
      ...((Array.isArray(cap.system) ? cap.system : []) as unknown as Array<
        Record<string, unknown>
      >),
      ...cap.messages.flatMap((m) =>
        Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, unknown>>) : []
      ),
    ].filter((b) => 'cache_control' in b)
    expect(cacheControls).toHaveLength(4)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Anthropic prompt-cache breakpoint cap of 4 exceeded')
    )
  })

  it('merges tool-result-bearing user content ahead of later user text, drops a leading assistant turn, and emits no empty messages', async () => {
    const warn = vi.fn()
    const built = await buildHistory({
      messages: [
        makeMessage({
          id: 'a0',
          role: 'assistant',
          content: 'drop me',
          createdAt: dt('2026-01-01T00:00:00Z'),
        }),
        makeMessage({
          id: 'u2',
          role: 'user',
          content: 'later text',
          createdAt: dt('2026-01-01T00:00:02Z'),
        }),
      ],
      toolCalls: [makeToolCall({ id: 'tc-a', createdAt: dt('2026-01-01T00:00:01Z') })],
      warn,
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropped leading Anthropic assistant history')
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Merged consecutive Anthropic user turns')
    )
    expect(built.messages.every((m) => Array.isArray(m.content) && m.content.length > 0)).toBe(true)

    const mergedUserTurn = built.messages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as unknown as Array<Record<string, unknown>>).some(
          (b) => b.type === 'tool_result'
        ) &&
        (m.content as unknown as Array<Record<string, unknown>>).some((b) => b.type === 'text')
    )
    expect(mergedUserTurn).toBeDefined()
    const mergedBlocks = mergedUserTurn?.content as unknown as Array<Record<string, unknown>>
    expect(mergedBlocks[0]?.type).toBe('tool_result')
    expect(mergedBlocks[1]?.type).toBe('text')
  })

  it('sets is_error only on failed tool results', async () => {
    const built = await buildHistory({
      toolCalls: [
        makeToolCall({
          id: 'ok',
          isError: false,
          createdAt: dt('2026-01-01T00:00:01Z'),
        }),
        makeToolCall({
          id: 'bad',
          isError: true,
          createdAt: dt('2026-01-01T00:00:02Z'),
        }),
      ],
    })

    const toolResultBlocks = built.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content as unknown as Array<Record<string, unknown>>)
      .filter((b) => b.type === 'tool_result')
    expect(toolResultBlocks.some((b) => !('is_error' in b))).toBe(true)
    expect(toolResultBlocks.some((b) => b.is_error === true)).toBe(true)
  })
})

describe('Anthropic helpers — thinking replay round-trip', () => {
  it('drops stale thinking blocks during history assembly rather than mutating the stored thought payload', async () => {
    const baselineMessages = [
      makeMessage({
        id: 'u1',
        role: 'user',
        content: 'hello',
        createdAt: dt('2026-01-01T00:00:00Z'),
      }),
    ]
    const baselineBuilt = await buildHistory({ messages: baselineMessages })
    const thought = makeThought({
      id: 'th1',
      content: 'concise thought',
      payload: {
        variant: 'thinking',
        thinking: 'opaque-thinking',
        signature: 'sig-1',
        prefixFingerprint: await fingerprintAnthropicMessagesPrefix({
          model: 'claude-opus-5',
          system: baselineBuilt.system,
          tools: baselineBuilt.tools,
          messages: baselineBuilt.messages,
        }),
      },
      replayCompatibility: 'anthropic-messages-thinking-v1',
      createdAt: dt('2026-01-01T00:00:01Z'),
    })

    const warn = vi.fn()
    const mutated = await buildHistory({
      messages: [
        makeMessage({
          id: 'u1',
          role: 'user',
          content: 'hello but changed',
          createdAt: dt('2026-01-01T00:00:00Z'),
        }),
      ],
      thoughts: [thought],
      warn,
    })
    expect(
      mutated.messages.some(
        (m) =>
          Array.isArray(m.content) &&
          (m.content as unknown as Array<Record<string, unknown>>).some(
            (b) => b.type === 'thinking'
          )
      )
    ).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Dropping stale Anthropic thinking signature')
    )
    expect(thought.payload).toMatchObject({ signature: 'sig-1' })
  })
})
