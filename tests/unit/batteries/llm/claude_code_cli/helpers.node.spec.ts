import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY } from '../../../../../src/batteries/llm/claude_code_cli/exceptions'
import {
  Message,
  Thought,
  Tool,
  ToolCall,
  ToolRegistry,
  Tokenizable,
  Media,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import {
  buildClaudeCodeCliPrompt,
  renderClaudeCodeCliTimelineMessage,
  renderClaudeCodeCliToolCallResult,
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
} from '../../../../../src/batteries/llm/claude_code_cli/helpers'

const dt = (iso: string): DateTime => DateTime.fromISO(iso, { zone: 'utc' })

const makeMessage = (overrides: {
  id: string
  role: 'user' | 'assistant'
  content?: string
  identity?: string
  createdAt: DateTime
  attachments?: Media[]
}): Message =>
  new Message({
    id: overrides.id,
    role: overrides.role,
    content: overrides.content ?? 'hello',
    identity: overrides.identity as never,
    attachments: overrides.attachments,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
  })

const makeThought = (overrides: {
  id: string
  content?: string
  payload?: unknown
  replayCompatibility?: string
  identity?: string
  createdAt: DateTime
}): Thought =>
  new Thought({
    id: overrides.id,
    content: overrides.content ?? 'reasoning',
    identity: overrides.identity ?? 'assistant',
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
  createdAt?: DateTime
}): ToolCall => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T00:00:00Z')
  return new ToolCall({
    id: overrides.id,
    tool: overrides.tool ?? 'search_docs',
    args: overrides.args ?? { q: 'x' },
    checksum: overrides.id,
    isComplete: true,
    isError: overrides.isError ?? false,
    results: new Tokenizable(overrides.results ?? 'tool-result'),
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  })
}

const makeTool = (name: string, trusted = false): Tool =>
  new Tool({
    name,
    description: `${name} tool`,
    inputSchema: validator.object({}).unknown(true),
    trusted,
    handler: async () => 'ok',
  })

const buildPrompt = async (input: {
  systemPrompt?: Tokenizable
  messages?: Message[]
  thoughts?: Thought[]
  toolCalls?: ToolCall[]
  tools?: ToolRegistry
  bucketOrder?: Array<'standingInstructions' | 'memories' | 'retrievables' | 'timeline'>
  thoughtSurfacing?: 'all-self' | 'latest-self' | 'all'
  replayCompatibility?: string[]
  renderCtx?: unknown
  warn?: (msg: string) => void
  renderedToolCallResults?: Map<ToolCall, string>
}): Promise<{
  prompt: string
  reasoningPayloads: Array<{ id: string; replayCompatibility: string; payload: unknown }>
}> =>
  buildClaudeCodeCliPrompt({
    systemPrompt: input.systemPrompt ?? new Tokenizable('System prompt'),
    standingInstructions: new Set([new Tokenizable('Stand here')]),
    memories: new Set(),
    retrievables: new Set(),
    messages: new Set(input.messages ?? []),
    thoughts: new Set(input.thoughts ?? []),
    toolCalls: new Set(input.toolCalls ?? []),
    tools: input.tools ?? new ToolRegistry([makeTool('search_docs')]),
    renderedToolCallResults: input.renderedToolCallResults ?? new Map(),
    bucketOrder: input.bucketOrder ?? [
      'standingInstructions',
      'memories',
      'retrievables',
      'timeline',
    ],
    selfIdentity: 'assistant',
    thoughtSurfacing: input.thoughtSurfacing ?? 'all-self',
    replayCompatibility: input.replayCompatibility ?? ['claude-code-cli-thinking-v1'],
    unsupportedMediaPolicy: 'throw',
    renderCtx: input.renderCtx,
    renderChatCompletionsSystemPrompt: defaultRenderChatCompletionsSystemPrompt,
    renderStandingInstructions: defaultRenderStandingInstructions,
    renderMemories: defaultRenderMemories,
    renderRetrievables: defaultRenderRetrievables,
    renderRetrievableSafetyDirective: defaultRenderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: defaultRenderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: defaultRenderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: defaultRenderThirdPartyPrivateRetrievables,
    renderClaudeCodeCliTimelineMessage,
    renderClaudeCodeCliToolCallResult,
    renderThought: defaultRenderThought,
    filterThoughts,
    renderUntrustedContent: defaultRenderUntrustedContent,
    renderTrustedContent: defaultRenderTrustedContent,
    warn: input.warn,
  })

describe('claude_code_cli helpers — buildClaudeCodeCliPrompt', () => {
  it('pairs pre-rendered results by ToolCall instance when ids collide', async () => {
    const first = makeToolCall({ id: 'call_0', results: 'original-first' })
    const second = makeToolCall({
      id: 'call_0',
      results: 'original-second',
      createdAt: dt('2026-01-01T00:00:01Z'),
    })
    const result = await buildPrompt({
      toolCalls: [first, second],
      renderedToolCallResults: new Map([
        [first, 'PRE-RENDERED-FIRST'],
        [second, 'PRE-RENDERED-SECOND'],
      ]),
    })
    expect(result.prompt).toContain('PRE-RENDERED-FIRST')
    expect(result.prompt).toContain('PRE-RENDERED-SECOND')
  })

  it('returns a single joined string, not an array', async () => {
    const result = await buildPrompt({})
    expect(typeof result.prompt).toBe('string')
  })

  it('renders the leading system-prompt block first', async () => {
    const result = await buildPrompt({
      messages: [
        makeMessage({
          id: 'm1',
          role: 'user',
          content: 'hi',
          createdAt: dt('2026-01-01T00:00:00Z'),
        }),
      ],
    })
    expect(result.prompt.startsWith('System prompt')).toBe(true)
  })

  it('orders a message/thought/tool-call timeline by createdAt, regardless of insertion order', async () => {
    const msg1 = makeMessage({
      id: 'm1',
      role: 'user',
      content: 'FIRST',
      createdAt: dt('2026-01-01T00:00:00Z'),
    })
    const thought1 = makeThought({
      id: 't1',
      content: 'SECOND',
      createdAt: dt('2026-01-01T00:00:01Z'),
    })
    const tc1 = makeToolCall({ id: 'tc1', createdAt: dt('2026-01-01T00:00:02Z'), results: 'THIRD' })
    const msg2 = makeMessage({
      id: 'm2',
      role: 'assistant',
      content: 'FOURTH',
      createdAt: dt('2026-01-01T00:00:03Z'),
    })
    // Insert deliberately out of chronological order.
    const result = await buildPrompt({
      messages: [msg2, msg1],
      thoughts: [thought1],
      toolCalls: [tc1],
    })
    const idxFirst = result.prompt.indexOf('FIRST')
    const idxSecond = result.prompt.indexOf('SECOND')
    const idxThird = result.prompt.indexOf('THIRD')
    const idxFourth = result.prompt.indexOf('FOURTH')
    expect(idxFirst).toBeGreaterThanOrEqual(0)
    expect(idxSecond).toBeGreaterThan(idxFirst)
    expect(idxThird).toBeGreaterThan(idxSecond)
    expect(idxFourth).toBeGreaterThan(idxThird)
  })

  it('appends trailing buckets (standingInstructions/memories/retrievables) after timeline, in bucketOrder', async () => {
    const result = await buildPrompt({
      bucketOrder: ['timeline', 'standingInstructions'],
      messages: [
        makeMessage({
          id: 'm1',
          role: 'user',
          content: 'TIMELINE_ITEM',
          createdAt: dt('2026-01-01T00:00:00Z'),
        }),
      ],
    })
    const idxTimeline = result.prompt.indexOf('TIMELINE_ITEM')
    const idxStanding = result.prompt.indexOf('Stand here')
    expect(idxTimeline).toBeGreaterThanOrEqual(0)
    expect(idxStanding).toBeGreaterThan(idxTimeline)
  })

  it('omits the timeline section entirely when bucketOrder does not include it', async () => {
    const result = await buildPrompt({
      bucketOrder: ['standingInstructions'],
      messages: [
        makeMessage({
          id: 'm1',
          role: 'user',
          content: 'SHOULD_NOT_APPEAR',
          createdAt: dt('2026-01-01T00:00:00Z'),
        }),
      ],
    })
    expect(result.prompt).not.toContain('SHOULD_NOT_APPEAR')
    expect(result.prompt).toContain('Stand here')
  })

  describe('thoughtSurfacing modes', () => {
    const selfThought = (): Thought =>
      makeThought({
        id: 'ts',
        content: 'SELF_THOUGHT',
        identity: 'assistant',
        createdAt: dt('2026-01-01T00:00:01Z'),
      })
    const peerThought = (): Thought =>
      makeThought({
        id: 'tp',
        content: 'PEER_THOUGHT',
        identity: 'other_agent',
        createdAt: dt('2026-01-01T00:00:02Z'),
      })

    it('all-self: surfaces only the assistant/self identity thoughts', async () => {
      const result = await buildPrompt({
        thoughts: [selfThought(), peerThought()],
        thoughtSurfacing: 'all-self',
      })
      expect(result.prompt).toContain('SELF_THOUGHT')
      expect(result.prompt).not.toContain('PEER_THOUGHT')
    })

    it('all: surfaces both self and peer thoughts', async () => {
      const result = await buildPrompt({
        thoughts: [selfThought(), peerThought()],
        thoughtSurfacing: 'all',
      })
      expect(result.prompt).toContain('SELF_THOUGHT')
      expect(result.prompt).toContain('PEER_THOUGHT')
    })
  })

  it('records a replay-compatible payload-carrying thought into reasoningPayloads', async () => {
    const thought = makeThought({
      id: 'replay-1',
      content: 'opaque reasoning',
      payload: { raw: 'signature-bytes' },
      replayCompatibility: 'claude-code-cli-thinking-v1',
      createdAt: dt('2026-01-01T00:00:01Z'),
    })
    const result = await buildPrompt({ thoughts: [thought] })
    expect(result.reasoningPayloads).toEqual([
      {
        id: 'replay-1',
        replayCompatibility: 'claude-code-cli-thinking-v1',
        payload: { raw: 'signature-bytes' },
      },
    ])
  })

  it('elides an opaque payload-carrying thought whose replayCompatibility tag is not in the accepted set', async () => {
    const thought = makeThought({
      id: 'replay-2',
      content: 'INCOMPATIBLE_PAYLOAD_THOUGHT',
      payload: { raw: 'x' },
      replayCompatibility: 'some-other-format-v1',
      createdAt: dt('2026-01-01T00:00:01Z'),
    })
    const result = await buildPrompt({
      thoughts: [thought],
      replayCompatibility: ['claude-code-cli-thinking-v1'],
    })
    expect(result.prompt).not.toContain('INCOMPATIBLE_PAYLOAD_THOUGHT')
    expect(result.reasoningPayloads).toEqual([])
  })

  it('renders a completed ToolCall via renderClaudeCodeCliToolCallResult, both call and result appearing', async () => {
    const tc = makeToolCall({
      id: 'tc-1',
      tool: 'search_docs',
      args: { q: 'hello' },
      results: 'RESULT_TEXT',
    })
    const result = await buildPrompt({ toolCalls: [tc] })
    expect(result.prompt).toContain('search_docs')
    expect(result.prompt).toContain('RESULT_TEXT')
  })

  it('routes an image Media attachment through unsupportedMediaPolicy=throw (text-only inbound limitation)', async () => {
    const media = new Media({
      kind: 'image',
      filename: 'photo.png',
      mimeType: 'image/png',
      modalityHazard: 'inert',
      trustTier: 'first-party',
      reader: inMemoryMediaReader(new Uint8Array([1, 2, 3])),
    })
    const msg = makeMessage({
      id: 'm-img',
      role: 'user',
      content: 'see attached',
      attachments: [media],
      createdAt: dt('2026-01-01T00:00:00Z'),
    })
    await expect(buildPrompt({ messages: [msg] })).rejects.toThrow(
      E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY
    )
  })

  it('resolves a dynamic Tokenizable systemPrompt via a supplied renderCtx', async () => {
    const dynamicPrompt = new Tokenizable((ctx?: unknown) => {
      const typed = ctx as { label?: string } | undefined
      return `Dynamic:${typed?.label ?? 'none'}`
    })
    const result = await buildPrompt({
      systemPrompt: dynamicPrompt,
      renderCtx: { label: 'live-ctx' },
    })
    expect(result.prompt.startsWith('Dynamic:live-ctx')).toBe(true)
  })

  it('a dynamic systemPrompt without a renderCtx falls back to the evaluator default, not undefined-as-never garbage', async () => {
    const dynamicPrompt = new Tokenizable((ctx?: unknown) => {
      const typed = ctx as { label?: string } | undefined
      return `Dynamic:${typed?.label ?? 'none'}`
    })
    const result = await buildPrompt({ systemPrompt: dynamicPrompt })
    expect(result.prompt.startsWith('Dynamic:none')).toBe(true)
  })

  it('invokes warn() when a stray tool-call references a tool absent from the registry', async () => {
    const warn = vi.fn()
    const tc = makeToolCall({ id: 'tc-missing', tool: 'ghost_tool', results: 'x' })
    await buildPrompt({ toolCalls: [tc], tools: new ToolRegistry([]), warn })
    expect(warn).toHaveBeenCalled()
  })
})

describe('claude_code_cli helpers — renderClaudeCodeCliToolCallResult (inbound direction)', () => {
  it('renders a plain Tokenizable result wrapped in an untrusted envelope for an untrusted tool', async () => {
    const tc = makeToolCall({ id: 'tc-1', tool: 'search_docs', results: 'plain text result' })
    const tool = makeTool('search_docs', false)
    const rendered = await renderClaudeCodeCliToolCallResult({
      toolCall: tc,
      results: new Tokenizable('plain text result'),
      tool,
      renderUntrustedContent: defaultRenderUntrustedContent,
      renderTrustedContent: defaultRenderTrustedContent,
      unsupportedMediaPolicy: 'throw',
    })
    expect(rendered).toContain('plain text result')
  })

  it('renders a plain Tokenizable result wrapped in a trusted envelope for a trusted tool', async () => {
    const tc = makeToolCall({ id: 'tc-2', tool: 'trusted_tool', results: 'trusted result' })
    const tool = makeTool('trusted_tool', true)
    const rendered = await renderClaudeCodeCliToolCallResult({
      toolCall: tc,
      results: new Tokenizable('trusted result'),
      tool,
      renderUntrustedContent: defaultRenderUntrustedContent,
      renderTrustedContent: defaultRenderTrustedContent,
      unsupportedMediaPolicy: 'throw',
    })
    expect(rendered).toContain('trusted result')
  })

  it('routes an unsupported image Media result through unsupportedMediaPolicy=throw', async () => {
    const tc = makeToolCall({ id: 'tc-3', tool: 'image_tool' })
    const media = new Media({
      kind: 'image',
      filename: 'out.png',
      mimeType: 'image/png',
      modalityHazard: 'inert',
      trustTier: 'first-party',
      reader: inMemoryMediaReader(new Uint8Array([1, 2, 3])),
    })
    await expect(
      renderClaudeCodeCliToolCallResult({
        toolCall: tc,
        results: media,
        tool: makeTool('image_tool'),
        renderUntrustedContent: defaultRenderUntrustedContent,
        renderTrustedContent: defaultRenderTrustedContent,
        unsupportedMediaPolicy: 'throw',
      })
    ).rejects.toThrow(E_CLAUDE_CODE_CLI_UNSUPPORTED_MEDIA_MODALITY)
  })

  it('warns when the tool is absent from the registry and defaults to an untrusted envelope', async () => {
    const warn = vi.fn()
    const tc = makeToolCall({ id: 'tc-4', tool: 'ghost_tool', results: 'x' })
    await renderClaudeCodeCliToolCallResult({
      toolCall: tc,
      results: new Tokenizable('x'),
      tool: undefined,
      renderUntrustedContent: defaultRenderUntrustedContent,
      renderTrustedContent: defaultRenderTrustedContent,
      unsupportedMediaPolicy: 'throw',
      warn,
    })
    expect(warn).toHaveBeenCalled()
  })
})
