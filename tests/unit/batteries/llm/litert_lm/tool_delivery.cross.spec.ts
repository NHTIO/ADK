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
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Memory,
  Retrievable,
  Tool,
  ToolRegistry,
} from '@nhtio/adk/common'
import {
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
  })

  it('returns empty string when there are no tools', () => {
    expect(renderToolsAsPromptText([])).toBe('')
  })
})

describe('LiteRT-LM tool delivery — buildLiteRtConversationInput', () => {
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
