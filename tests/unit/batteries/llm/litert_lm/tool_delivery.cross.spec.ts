// Unit coverage for LiteRT-LM tool DELIVERY (env-neutral, no engine/WASM, node + browser). Drives
// `buildLiteRtConversationInput` to prove the two tool-delivery modes:
//   - 'prompt' (default): tool defs render as a system-prompt text block; preface.tools is UNSET. This
//     is the portable path — the Gemma-4 .litertlm chat template throws `template:80` on native tools
//     (known Gemma-4 bug; WebLLM/MLC use prompt injection too). The `auto` parser extracts the call.
//   - 'native': tool defs go in preface.tools (the chat-template path), no system-prompt block.
//
// The REAL-GPU end-to-end proof that prompt injection drives a tool call on a live model is the gated
// browser matrix entry `litert-gemma-web`; this spec pins the deterministic build-side contract.

import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  Tool,
  ToolRegistry,
  SpooledArtifact,
} from '@nhtio/adk/common'
import {
  renderLiteRtToolResult,
  buildLiteRtConversationInput,
  renderToolsAsPromptText,
  defaultToolsToLiteRtTools,
  defaultRenderToolsAsPromptText,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
  defaultRenderStandingInstructions,
  defaultRenderMemories,
  defaultRenderRetrievables,
  defaultRenderRetrievableSafetyDirective,
  defaultRenderFirstPartyRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  defaultRenderThought,
  defaultFilterThoughts,
  defaultRenderChatCompletionsSystemPrompt,
} from '@nhtio/adk/batteries/llm/litert_lm'
import type { LiteRtMessage } from '@nhtio/adk/batteries/llm/litert_lm'

const dt = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' })

const weatherTool = (): Tool =>
  new Tool({
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: validator.object({ city: validator.string() }),
    handler: async () => 'OK',
  })

const baseInput = (overrides: Record<string, unknown>) => ({
  systemPrompt: new Tokenizable('You are a helpful assistant.'),
  standingInstructions: new Set<Tokenizable>(),
  memories: new Set<Memory>(),
  retrievables: new Set<Retrievable>(),
  messages: new Set([
    new Message({
      id: 'u-1',
      role: 'user',
      content: 'What is the weather in Rome?',
      createdAt: dt('2026-01-01T12:00:00Z'),
      updatedAt: dt('2026-01-01T12:00:00Z'),
    }),
  ]),
  thoughts: new Set<Thought>(),
  toolCalls: new Set<ToolCall>(),
  tools: new ToolRegistry([weatherTool()]),
  renderedToolCallResults: new Map(),
  bucketOrder: ['standingInstructions', 'memories', 'retrievables', 'timeline'] as never,
  selfIdentity: 'assistant',
  thoughtSurfacing: 'all-self' as const,
  replayCompatibility: [] as string[],
  toolsToLiteRtTools: defaultToolsToLiteRtTools,
  renderToolsAsPromptText: defaultRenderToolsAsPromptText,
  renderThought: defaultRenderThought,
  filterThoughts: defaultFilterThoughts,
  renderUntrustedContent: defaultRenderUntrustedContent,
  renderTrustedContent: defaultRenderTrustedContent,
  renderChatCompletionsSystemPrompt: defaultRenderChatCompletionsSystemPrompt,
  renderStandingInstructions: defaultRenderStandingInstructions,
  renderMemories: defaultRenderMemories,
  renderRetrievables: defaultRenderRetrievables,
  renderRetrievableSafetyDirective: defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables: defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables: defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables: defaultRenderThirdPartyPrivateRetrievables,
  ...overrides,
})

const systemContent = (out: { preface: { messages?: LiteRtMessage[] } }): string =>
  (out.preface.messages ?? []).find((m) => m.role === 'system')?.content?.toString() ?? ''

describe('LiteRT-LM renderToolsAsPromptText', () => {
  it('renders tool name, description, and JSON-Schema parameters as a text block', () => {
    const text = renderToolsAsPromptText([weatherTool()])
    expect(text).toContain('get_weather')
    expect(text).toContain('Get the current weather for a city.')
    expect(text).toContain('"city"')
    expect(text).toContain('<tool_definitions>')
    expect(text).toContain('</tool_definitions>')
    // Instructs Gemma's OWN trained call format (`call:NAME{…}`), not pythonic `[func(arg=value)]` —
    // teaching the model the format it already emits is what makes the auto-parser catch its output.
    expect(text).toContain('call:tool_name{')
    expect(text).not.toContain('[func_name(')
  })

  it('returns empty string when there are no tools', () => {
    expect(renderToolsAsPromptText([])).toBe('')
  })
})

describe('LiteRT-LM tool delivery — buildLiteRtConversationInput', () => {
  it('pairs each colliding-id ToolCall with its own pre-rendered result', async () => {
    const first = new ToolCall({
      id: 'call_0',
      tool: 'get_weather',
      args: { city: 'Paris' },
      checksum: 'first',
      isComplete: true,
      isError: false,
      results: new Tokenizable('Paris: 12C'),
      createdAt: dt('2026-01-01T12:01:00Z'),
      updatedAt: dt('2026-01-01T12:01:00Z'),
      completedAt: dt('2026-01-01T12:01:00Z'),
    })
    const second = new ToolCall({
      id: 'call_0',
      tool: 'get_weather',
      args: { city: 'Tokyo' },
      checksum: 'second',
      isComplete: true,
      isError: false,
      results: new Tokenizable('Tokyo: 25C'),
      createdAt: dt('2026-01-01T12:02:00Z'),
      updatedAt: dt('2026-01-01T12:02:00Z'),
      completedAt: dt('2026-01-01T12:02:00Z'),
    })
    const out = await buildLiteRtConversationInput(
      baseInput({
        toolCalls: new Set([first, second]),
        renderedToolCallResults: new Map([
          [
            first,
            { type: 'tool_response', tool_response: { response: { content: 'Paris: 12C' } } },
          ],
          [
            second,
            { type: 'tool_response', tool_response: { response: { content: 'Tokyo: 25C' } } },
          ],
        ]),
      }) as never
    )
    const toolResults = out.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.stringify(message.content))
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]).toContain('Paris: 12C')
    expect(toolResults[1]).toContain('Tokyo: 25C')
  })

  it("DEFAULT ('prompt'): tool defs land in the system prompt, preface.tools is UNSET", async () => {
    const out = await buildLiteRtConversationInput(baseInput({}) as never)
    // The Gemma-4 template throws on native tools → they must NOT be passed via preface.tools.
    expect((out.preface as { tools?: unknown }).tools).toBeUndefined()
    // …and instead appear as a system-prompt text block the model + auto-parser can use.
    const sys = systemContent(out)
    expect(sys).toContain('get_weather')
    expect(sys).toContain('<tool_definitions>')
    // The base system prompt is preserved alongside the tool block.
    expect(sys).toContain('You are a helpful assistant.')
  })

  it("'native': tool defs go in preface.tools, NOT the system prompt", async () => {
    const out = await buildLiteRtConversationInput(baseInput({ toolDelivery: 'native' }) as never)
    const tools = (out.preface as { tools?: Array<{ name: string }> }).tools
    expect(Array.isArray(tools)).toBe(true)
    expect(tools?.[0]?.name).toBe('get_weather')
    // No injected text block in native mode.
    expect(systemContent(out)).not.toContain('<tool_definitions>')
  })

  it('no tools → neither a preface.tools field nor an injected block, in either mode', async () => {
    for (const toolDelivery of ['prompt', 'native'] as const) {
      const out = await buildLiteRtConversationInput(
        baseInput({ toolDelivery, tools: new ToolRegistry() }) as never
      )
      expect((out.preface as { tools?: unknown }).tools).toBeUndefined()
      expect(systemContent(out)).not.toContain('<tool_definitions>')
    }
  })
})

describe('LiteRT-LM explicit thinking flag — preface.extra_context.enable_thinking', () => {
  it('defaults to enable_thinking:false (never let the template decide)', async () => {
    const out = await buildLiteRtConversationInput(baseInput({}) as never)
    const ctx = (out.preface as { extra_context?: { enable_thinking?: boolean } }).extra_context
    expect(ctx).toBeDefined()
    expect(ctx?.enable_thinking).toBe(false)
  })

  it('passes enable_thinking:true when explicitly enabled', async () => {
    const out = await buildLiteRtConversationInput(baseInput({ enableThinking: true }) as never)
    const ctx = (out.preface as { extra_context?: { enable_thinking?: boolean } }).extra_context
    expect(ctx?.enable_thinking).toBe(true)
  })
})

// ─── tool-result rendering: handle-by-default ───────────────────────────────────────────────────────

describe('LiteRT-LM renderLiteRtToolResult — handle-by-default', () => {
  const spooled = (text: string, callId: string): SpooledArtifact => {
    const store = new InMemorySpoolStore()
    return new SpooledArtifact(store.write(callId, text))
  }
  const toolCall = (overrides: Record<string, unknown>): ToolCall =>
    new ToolCall({
      id: 'tc-1',
      tool: 'search',
      args: {},
      checksum: 'sum-1',
      isComplete: true,
      isError: false,
      results: new Tokenizable(''),
      createdAt: dt('2026-01-01T12:00:00Z'),
      updatedAt: dt('2026-01-01T12:00:00Z'),
      completedAt: dt('2026-01-01T12:00:00Z'),
      ...overrides,
    })
  const bodyOf = (item: { tool_response?: { response?: { content?: string } } }): string =>
    item.tool_response?.response?.content ?? ''
  const render = (tc: ToolCall, results: SpooledArtifact) =>
    renderLiteRtToolResult({
      toolCall: tc,
      results,
      tool: undefined,
      unsupportedMediaPolicy: 'synthetic-description',
      renderUntrustedContent: defaultRenderUntrustedContent,
      renderTrustedContent: defaultRenderTrustedContent,
    } as never)

  it('a SpooledArtifact result with the DEFAULT ToolCall (inline:false) renders as a HANDLE, not the body', async () => {
    const huge = 'secret-log-line '.repeat(500)
    const results = spooled(huge, 'tc-1')
    const out = await render(toolCall({ results }), results)
    const body = bodyOf(out as never)
    // The body is NOT inlined — the model gets a directions-bearing handle instead.
    expect(body).not.toContain('secret-log-line secret-log-line')
    expect(body).toContain('was not inlined to preserve context budget')
    expect(body).toContain('callId: tc-1')
    // …and the artifact's own query tools are advertised.
    expect(body).toContain('artifact_grep')
  })

  it('inline:true opts INTO the body (the producer override)', async () => {
    const results = spooled('the full body text', 'tc-1')
    const out = await render(toolCall({ results, inline: true }), results)
    const body = bodyOf(out as never)
    expect(body).toContain('the full body text')
    expect(body).not.toContain('was not inlined')
  })

  it('honors a consumer-supplied helpers.renderArtifactHandleBody override (not the static default)', async () => {
    // Regression: the handle renderer was documented as overridable on the barrel but the call site
    // used the static import, so a consumer override was silently ignored. Here we pass a custom
    // renderer and prove its output — not the default note — is what reaches the model.
    const results = spooled('x'.repeat(500), 'tc-1')
    const out = await renderLiteRtToolResult({
      toolCall: toolCall({ results }),
      results,
      tool: undefined,
      unsupportedMediaPolicy: 'synthetic-description',
      renderUntrustedContent: defaultRenderUntrustedContent,
      renderTrustedContent: defaultRenderTrustedContent,
      renderArtifactHandleBody: (input: { callId: string }) => `CUSTOM-HANDLE for ${input.callId}`,
    } as never)
    const body = bodyOf(out as never)
    expect(body).toContain('CUSTOM-HANDLE for tc-1')
    expect(body).not.toContain('was not inlined to preserve context budget')
  })
})
