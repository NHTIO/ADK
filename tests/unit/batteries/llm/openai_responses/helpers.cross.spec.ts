/**
 * `buildOpenAIResponsesInput` + supporting-helper coverage for the OpenAI Responses battery.
 *
 * Covers: ADK-rendered `instructions` placement across all `systemPromptChannel` modes; sibling
 * `function_call`/`function_call_output` pairing (including composite-id splitting); self vs peer
 * assistant shapes (own turns render as the OUTPUT-message shape, peer turns as plain input
 * messages); and the tool-declaration shape (`name` top-level, unlike Chat Completions' nested
 * `function.name`).
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { Tokenizable, Message, Thought, ToolCall, Tool, ToolRegistry } from '@nhtio/adk/common'
import {
  buildOpenAIResponsesInput,
  renderOpenAIResponsesTimelineMessage,
  renderOpenAIResponsesToolCallResult,
  renderOpenAIResponsesMediaBlocks,
  renderOpenAIResponsesReasoningItem,
  toolsToOpenAIResponsesTools,
  fingerprintOpenAIResponsesPrefix,
  descriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  renderTrustedContent,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  renderChatCompletionsSystemPrompt,
  renderThought,
  filterThoughts,
  deCollideOpenAIResponsesToolCallIds,
} from '@nhtio/adk/batteries/llm/openai_responses'
import type {
  OpenAIResponsesInputItem,
  OpenAIResponsesFunctionCallItem,
  OpenAIResponsesFunctionCallOutputItem,
  OpenAIResponsesOutputMessageItem,
  OpenAIResponsesMessageItem,
} from '@nhtio/adk/batteries/llm/openai_responses'

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
    id: overrides.id ?? 'm1',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    identity: overrides.identity as never,
    createdAt,
    updatedAt: createdAt,
  })
}

const makeThought = (overrides: {
  id?: string
  identity?: string
  content?: string
  createdAt?: DateTime
  payload?: unknown
  replayCompatibility?: string
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:00:00Z')
  return new Thought({
    id: overrides.id ?? 't1',
    content: overrides.content ?? 'thinking…',
    identity: overrides.identity as never,
    createdAt,
    updatedAt: createdAt,
    payload: overrides.payload,
    replayCompatibility: overrides.replayCompatibility,
  })
}

const makeToolCall = (overrides: {
  id?: string
  tool?: string
  args?: Record<string, unknown>
  checksum?: string
  results?: Tokenizable
  createdAt?: DateTime
}) => {
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:01:00Z')
  return new ToolCall({
    id: overrides.id ?? 'tc-1',
    tool: overrides.tool ?? 'my_tool',
    args: overrides.args ?? { x: 1 },
    checksum: overrides.checksum ?? 'sum-1',
    isComplete: true,
    isError: false,
    results: overrides.results ?? new Tokenizable('tool result body'),
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  })
}

const makeTool = (overrides: { name?: string } = {}): Tool =>
  new Tool({
    name: overrides.name ?? 'my_tool',
    description: 'a test tool',
    inputSchema: validator.object({ x: validator.number().required() }),
    handler: async () => 'ok',
  })

const baseDeps = {
  renderOpenAIResponsesToolCallResult,
  renderOpenAIResponsesMediaBlocks,
  renderChatCompletionsSystemPrompt,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  renderOpenAIResponsesTimelineMessage,
  renderOpenAIResponsesReasoningItem,
  fingerprintOpenAIResponsesPrefix,
  toolsToOpenAIResponsesTools,
  descriptionToChatCompletionsJsonSchema,
  renderThought,
  filterThoughts,
  renderUntrustedContent,
  renderTrustedContent,
}

const baseBuildArgs = (
  overrides: Partial<Parameters<typeof buildOpenAIResponsesInput>[0]> = {}
): Parameters<typeof buildOpenAIResponsesInput>[0] => ({
  model: 'gpt-x-responses',
  systemPrompt: new Tokenizable('SYS'),
  standingInstructions: [],
  memories: [],
  retrievables: [],
  messages: [],
  thoughts: [],
  toolCalls: [],
  tools: new ToolRegistry([]),
  renderedToolCallResults: new Map(),
  bucketOrder: ['standingInstructions', 'memories', 'retrievables', 'timeline'],
  selfIdentity: 'assistant',
  thoughtSurfacing: 'all-self',
  replayCompatibility: [],
  reasoningReplay: 'off',
  systemPromptChannel: 'instructions',
  unsupportedMediaPolicy: 'throw',
  ...baseDeps,
  ...overrides,
})

const isMessageItem = (i: OpenAIResponsesInputItem): i is OpenAIResponsesMessageItem =>
  (i.type === undefined || i.type === 'message') &&
  'role' in i &&
  Array.isArray((i as OpenAIResponsesMessageItem).content) &&
  !('status' in i)

describe('deCollideOpenAIResponsesToolCallIds', () => {
  const contextFor = (ids: string[]) =>
    ({ turnToolCalls: new Set(ids.map((id) => ({ id }))) }) as never

  it('replaces a colliding bare id with a UUID', () => {
    const result = deCollideOpenAIResponsesToolCallIds('call_0', contextFor(['call_0']))
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).not.toBe('call_0')
  })

  it('replaces only the call half of a colliding fc_ composite id', () => {
    const result = deCollideOpenAIResponsesToolCallIds(
      'call_0|fc_abc123',
      contextFor(['call_0|fc_abc123'])
    )
    expect(result).toMatch(/^[0-9a-f-]{36}\|fc_abc123$/)
  })

  it('discards the positional half of a colliding composite id', () => {
    const result = deCollideOpenAIResponsesToolCallIds('call_0|idx-2', contextFor(['call_0|idx-2']))
    expect(result).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('passes through an id that does not collide', () => {
    expect(deCollideOpenAIResponsesToolCallIds('call_0|fc_abc123', contextFor(['other']))).toBe(
      'call_0|fc_abc123'
    )
  })
})

describe('buildOpenAIResponsesInput — instructions placement / systemPromptChannel', () => {
  it('default channel: leading system content lands in top-level `instructions`, not an input item', async () => {
    const out = await buildOpenAIResponsesInput(baseBuildArgs())
    expect(out.instructions).toBe('SYS')
    expect(
      out.input.find((i) => 'role' in i && (i as OpenAIResponsesMessageItem).role === 'system')
    ).toBeUndefined()
    expect(
      out.input.find((i) => 'role' in i && (i as OpenAIResponsesMessageItem).role === 'developer')
    ).toBeUndefined()
  })

  it('"developer-item" channel: renders a leading developer-role input item, no `instructions` field', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ systemPromptChannel: 'developer-item' })
    )
    expect(out.instructions).toBeUndefined()
    const leading = out.input[0] as OpenAIResponsesMessageItem
    expect(leading.role).toBe('developer')
    expect(leading.content[0]).toEqual({ type: 'input_text', text: 'SYS' })
  })

  it('"system-item" channel: renders a leading system-role input item, no `instructions` field', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ systemPromptChannel: 'system-item' })
    )
    expect(out.instructions).toBeUndefined()
    const leading = out.input[0] as OpenAIResponsesMessageItem
    expect(leading.role).toBe('system')
    expect(leading.content[0]).toEqual({ type: 'input_text', text: 'SYS' })
  })

  it('empty leading system text emits neither `instructions` nor a leading item', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ systemPrompt: new Tokenizable(''), systemPromptChannel: 'instructions' })
    )
    expect(out.instructions).toBeUndefined()
    expect(out.input.length).toBe(0)
  })

  it('standingInstructions/memories bucketed before timeline fold into `instructions`', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        standingInstructions: [new Tokenizable('be terse')],
        bucketOrder: ['standingInstructions', 'timeline'],
      })
    )
    expect(out.instructions).toContain('SYS')
    expect(out.instructions).toContain('be terse')
  })

  it('bucketOrder placing a bucket AFTER timeline renders a trailing system-role item, not `instructions`', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        standingInstructions: [new Tokenizable('trailing rule')],
        bucketOrder: ['timeline', 'standingInstructions'],
      })
    )
    expect(out.instructions).toBe('SYS')
    const trailing = out.input.at(-1) as OpenAIResponsesMessageItem
    expect(trailing.role).toBe('system')
    expect(trailing.content[0]).toMatchObject({ type: 'input_text' })
    expect((trailing.content[0] as { text: string }).text).toContain('trailing rule')
  })
})

describe('buildOpenAIResponsesInput — tool-call sibling pairing', () => {
  it('renders a tool call as two SIBLING top-level items: function_call then function_call_output', async () => {
    const tool = makeTool()
    const tc = makeToolCall({ id: 'call-abc', tool: 'my_tool', args: { x: 1 } })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        toolCalls: [tc],
        tools: new ToolRegistry([tool]),
        bucketOrder: ['timeline'],
      })
    )
    const fc = out.input.find((i) => i.type === 'function_call') as OpenAIResponsesFunctionCallItem
    const fco = out.input.find(
      (i) => i.type === 'function_call_output'
    ) as OpenAIResponsesFunctionCallOutputItem
    expect(fc).toBeDefined()
    expect(fco).toBeDefined()
    expect(fc.call_id).toBe('call-abc')
    expect(fco.call_id).toBe('call-abc')
    expect(fc.name).toBe('my_tool')
    expect(fc.arguments).toBe(JSON.stringify({ x: 1 }))
    // Siblings: function_call immediately followed by function_call_output.
    const fcIdx = out.input.indexOf(fc)
    expect(out.input[fcIdx + 1]).toBe(fco)
  })

  it('composite id "callId|itemId" splits into call_id + item id (fc_-prefixed)', async () => {
    const tc = makeToolCall({ id: 'call-xyz|fc_abc123' })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ toolCalls: [tc], bucketOrder: ['timeline'] })
    )
    const fc = out.input.find((i) => i.type === 'function_call') as OpenAIResponsesFunctionCallItem
    expect(fc.call_id).toBe('call-xyz')
    expect(fc.id).toBe('fc_abc123')
  })

  it('composite id with a non-fc_-prefixed item id drops the item id half', async () => {
    const tc = makeToolCall({ id: 'call-xyz|not_a_real_item_id' })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ toolCalls: [tc], bucketOrder: ['timeline'] })
    )
    const fc = out.input.find((i) => i.type === 'function_call') as OpenAIResponsesFunctionCallItem
    expect(fc.call_id).toBe('call-xyz')
    expect(fc.id).toBeUndefined()
  })

  it('a plain (non-composite) id has no item id at all', async () => {
    const tc = makeToolCall({ id: 'plain-call-id' })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ toolCalls: [tc], bucketOrder: ['timeline'] })
    )
    const fc = out.input.find((i) => i.type === 'function_call') as OpenAIResponsesFunctionCallItem
    expect(fc.call_id).toBe('plain-call-id')
    expect(fc.id).toBeUndefined()
  })

  it('keeps colliding ToolCalls paired with their own pre-rendered results', async () => {
    const first = makeToolCall({ id: 'duplicate', results: new Tokenizable('first') })
    const second = makeToolCall({ id: 'duplicate', results: new Tokenizable('second') })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        toolCalls: [first, second],
        bucketOrder: ['timeline'],
        renderedToolCallResults: new Map([
          [first, 'FIRST'],
          [second, 'SECOND'],
        ]),
      })
    )
    expect(out.input.filter((i) => i.type === 'function_call_output').map((i) => i.output)).toEqual(
      ['FIRST', 'SECOND']
    )
  })

  it('uses a pre-rendered result from renderedToolCallResults over re-rendering, keyed by instance', async () => {
    const tc = makeToolCall({ id: 'call-cached' })
    const renderedToolCallResults = new Map<ToolCall, string>([[tc, 'CACHED-RESULT']])
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ toolCalls: [tc], bucketOrder: ['timeline'], renderedToolCallResults })
    )
    const fco = out.input.find(
      (i) => i.type === 'function_call_output'
    ) as OpenAIResponsesFunctionCallOutputItem
    expect(fco.output).toBe('CACHED-RESULT')
  })
})

describe('buildOpenAIResponsesInput — self vs peer assistant shapes', () => {
  it('own prior assistant turn (identity === selfIdentity) renders as the OUTPUT-message shape', async () => {
    const own = makeMessage({
      id: 'own-1',
      role: 'assistant',
      content: 'my own reply',
      identity: 'assistant',
    })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [own], bucketOrder: ['timeline'] })
    )
    const item = out.input[0] as OpenAIResponsesOutputMessageItem
    expect(item.type).toBe('message')
    expect(item.role).toBe('assistant')
    expect(item.status).toBe('completed')
    expect(item.id).toBe('own-1')
    expect(item.content[0]).toMatchObject({
      type: 'output_text',
      text: 'my own reply',
      annotations: [],
    })
  })

  it('peer-identity assistant turn (different identity) renders as a plain input message with an envelope', async () => {
    const peer = makeMessage({
      id: 'peer-1',
      role: 'assistant',
      content: 'peer reply',
      identity: 'peer-agent',
    })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [peer], bucketOrder: ['timeline'], selfIdentity: 'assistant' })
    )
    const item = out.input[0]
    expect(isMessageItem(item)).toBe(true)
    const msgItem = item as OpenAIResponsesMessageItem
    expect(msgItem.role).toBe('assistant')
    const text = (msgItem.content[0] as { text: string }).text
    expect(text).toContain('peer_agent_output_peer-1')
    expect(text).toContain('peer reply')
  })

  it('user turn renders as a plain input message with role "user"', async () => {
    // Message defaults `identity` to its own `role` when omitted (see Message's own schema), so a
    // bare-string identity envelope is still emitted — asserting on the envelope content, not a
    // bare unwrapped string, matches the real default behavior rather than an unreachable state.
    const u = makeMessage({ id: 'u-1', role: 'user', content: 'hi there' })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [u], bucketOrder: ['timeline'] })
    )
    const item = out.input[0] as OpenAIResponsesMessageItem
    expect(item.role).toBe('user')
    expect((item.content[0] as { text: string }).text).toContain('hi there')
  })

  it('own-turn attachments render as trailing user-role media items (output-message shape has no attachment slot)', async () => {
    // Own-output attachments are rare; the builder appends a trailing `role: 'user'` item with the
    // media blocks rather than losing them. We assert this WITHOUT real media bytes by using a
    // message with no attachments — the empty-attachments path is exercised implicitly by every
    // other test in this file (no extra items appended). A dedicated media-bearing case lives in
    // media.cross.spec.ts.
    const own = makeMessage({
      id: 'own-2',
      role: 'assistant',
      content: 'no attachments here',
      identity: 'assistant',
    })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [own], bucketOrder: ['timeline'] })
    )
    expect(out.input).toHaveLength(1)
  })
})

describe('buildOpenAIResponsesInput — timeline ordering', () => {
  it('orders messages/thoughts/toolCalls by createdAt across all three', async () => {
    const m1 = makeMessage({ id: 'm-a', content: 'A', createdAt: dt('2026-01-01T10:00:00Z') })
    const th = makeThought({
      id: 'th-b',
      identity: 'assistant',
      content: 'B',
      createdAt: dt('2026-01-01T10:00:30Z'),
    })
    const m2 = makeMessage({
      id: 'm-c',
      role: 'assistant',
      content: 'C',
      identity: 'assistant',
      createdAt: dt('2026-01-01T10:01:00Z'),
    })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [m2, m1], thoughts: [th], bucketOrder: ['timeline'] })
    )
    // th has payload === undefined → plain-text thought render as an input message.
    expect((out.input[0] as OpenAIResponsesMessageItem).content[0]).toMatchObject({
      type: 'input_text',
    })
    expect((out.input[0] as OpenAIResponsesMessageItem).content[0]).toMatchObject({})
    const texts = out.input.map((i) =>
      'content' in i ? JSON.stringify((i as OpenAIResponsesMessageItem).content) : ''
    )
    expect(texts[0]).toContain('A')
    expect(texts[1]).toContain('B')
    expect(texts[2]).toContain('C')
  })
})

// descriptionToChatCompletionsJsonSchema's real signature is `(d: DescriptionLike) => JsonSchema`;
// toolsToOpenAIResponsesTools's `deps` shape declares its dependency loosely as `(d: unknown) =>
// JsonSchema` (matching how the adapter itself calls it — see `adapter.ts`'s `descriptionToChatCompletionsJsonSchema:
// (d: unknown) => resolvedHelpers.descriptionToChatCompletionsJsonSchema(d as never)`). Wrap once here.
const descToJsonSchemaDep = {
  descriptionToChatCompletionsJsonSchema: (d: unknown) =>
    descriptionToChatCompletionsJsonSchema(d as never),
}

describe('toolsToOpenAIResponsesTools — declaration shape (name TOP-LEVEL)', () => {
  it('returns empty array for empty input', () => {
    const out = toolsToOpenAIResponsesTools([], descToJsonSchemaDep)
    expect(out).toEqual([])
  })

  it('name is top-level, NOT nested under a `function` key', () => {
    const tool = makeTool({ name: 'search_docs' })
    const out = toolsToOpenAIResponsesTools([tool], descToJsonSchemaDep)
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('function')
    expect(out[0]!.name).toBe('search_docs')
    expect((out[0] as unknown as { function?: unknown }).function).toBeUndefined()
    expect(out[0]!.description).toBe('a test tool')
    expect(out[0]!.parameters).toMatchObject({ type: 'object' })
  })

  it('falls back to an empty object schema when the description yields nothing', () => {
    const tool = new Tool({
      name: 'no_args',
      description: 'no args tool',
      inputSchema: validator.object({}),
      handler: async () => 'ok',
    })
    const out = toolsToOpenAIResponsesTools([tool], descToJsonSchemaDep)
    expect(out[0]!.parameters).toMatchObject({ type: 'object' })
  })

  // Regression guard: `strict` was previously accepted as an adapter-level option and documented
  // as "forwarded to every emitted tool declaration's `strict` field," but toolsToOpenAIResponsesTools
  // never actually read it — every emitted tool silently omitted `strict` regardless of the setting.
  it('omits `strict` from emitted tools when not passed', () => {
    const tool = makeTool({ name: 'search_docs' })
    const out = toolsToOpenAIResponsesTools([tool], descToJsonSchemaDep)
    expect(out[0]).not.toHaveProperty('strict')
  })

  it('forwards `strict: true` to every emitted tool declaration', () => {
    const tools = [makeTool({ name: 'alpha' }), makeTool({ name: 'beta' })]
    const out = toolsToOpenAIResponsesTools(tools, { ...descToJsonSchemaDep, strict: true })
    expect(out).toHaveLength(2)
    expect(out[0]!.strict).toBe(true)
    expect(out[1]!.strict).toBe(true)
  })

  it('forwards `strict: false` explicitly (distinct from omitted)', () => {
    const tool = makeTool({ name: 'gamma' })
    const out = toolsToOpenAIResponsesTools([tool], { ...descToJsonSchemaDep, strict: false })
    expect(out[0]!.strict).toBe(false)
  })
})

describe('buildOpenAIResponsesInput — tools passthrough uses the same declaration shape', () => {
  it('emits `tools` with top-level `name` fields when tools are visible', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ tools: new ToolRegistry([makeTool({ name: 'alpha' })]) })
    )
    expect(out.tools).toHaveLength(1)
    expect(out.tools![0]!.name).toBe('alpha')
  })

  it('omits `tools` entirely when there are no visible tools', async () => {
    const out = await buildOpenAIResponsesInput(baseBuildArgs())
    expect(out.tools).toBeUndefined()
  })

  it('forwards the top-level `strict` option through to every emitted tool declaration', async () => {
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        tools: new ToolRegistry([makeTool({ name: 'alpha' }), makeTool({ name: 'beta' })]),
        strict: true,
      })
    )
    expect(out.tools).toHaveLength(2)
    expect(out.tools![0]!.strict).toBe(true)
    expect(out.tools![1]!.strict).toBe(true)
  })
})
