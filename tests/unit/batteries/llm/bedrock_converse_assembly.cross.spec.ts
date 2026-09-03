/**
 * Covers the Bedrock Converse request assembly — the block protocol, and the alternation policy
 * that a gateway would otherwise apply invisibly.
 */
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Message, ToolCall, Tokenizable } from '@nhtio/adk/common'
import {
  buildConverseRequest,
  enforceConverseAlternation,
  extractConverseGeneration,
  sanitizeToolUseId,
  toolsToConverseTools,
} from '../../../../src/batteries/llm/bedrock_converse/helpers'
import type { ConverseMessage } from '../../../../src/batteries/llm/bedrock_converse/types'

const at = (s: number) => DateTime.fromMillis(s * 1000)
const msg = (id: string, role: 'user' | 'assistant', s: number, c: string) =>
  new Message({ id, role, content: c, createdAt: at(s), updatedAt: at(s) })
const tc = (id: string, s: number) =>
  new ToolCall({
    id,
    tool: 'read_file',
    args: { path: 'config.yml' },
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('42 lines'),
    createdAt: at(s),
    updatedAt: at(s),
    completedAt: at(s),
  } as never)

const emptyReg = { visible: () => [], all: () => [], get: () => undefined } as never
const base = {
  systemPrompt: new Tokenizable('You are a reviewer.'),
  standingInstructions: [],
  memories: [],
  retrievables: [],
  thoughts: [],
  tools: emptyReg,
  bucketOrder: undefined,
  selfIdentity: 'assistant',
  thoughtSurfacing: 'all-self' as const,
  replayCompatibility: [],
  helpers: { toolsToConverseTools } as never,
}

describe('bedrock converse assembly', () => {
  it('renders a ToolCall as assistant.toolUse + user.toolResult, with system out-of-band', async () => {
    const req = await buildConverseRequest({
      ...base,
      messages: [msg('m1', 'user', 1, 'Review the hunks.')],
      toolCalls: [tc('c1', 2)],
      renderedToolCallResults: new Map([['c1', [{ text: '42 lines' }]]]),
    })
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(req.messages[1].content[0].toolUse?.name).toBe('read_file')
    // A tool result rides a USER turn — Converse has no `tool` role.
    expect(req.messages[2].content[0].toolResult?.toolUseId).toBe('c1')
    // System text is top-level, never a turn.
    expect(req.system?.[0].text).toContain('You are a reviewer.')
    expect(JSON.stringify(req.messages)).not.toContain('You are a reviewer.')
  })

  it('backfills a tool declaration for history replay, because an EMPTY tools[] is also rejected', async () => {
    // Two live-verified Converse constraints in tension:
    //   1. tool blocks with NO toolConfig     -> "The toolConfig field must be defined ..."
    //   2. toolConfig with an EMPTY tools[]   -> "The provided request is not valid"
    // So replaying a call for a tool we can no longer enumerate needs a declaration synthesized
    // from the call itself. Getting (1) right while leaving tools[] empty still 400s.
    const req = await buildConverseRequest({
      ...base,
      messages: [msg('m1', 'user', 1, 'go')],
      toolCalls: [tc('c1', 2)],
      renderedToolCallResults: new Map([['c1', [{ text: 'ok' }]]]),
    })
    expect(req.toolConfig).toBeDefined()
    expect(req.toolConfig?.tools).toHaveLength(1)
    expect(req.toolConfig?.tools[0].toolSpec.name).toBe('read_file')
    expect(req.toolConfig?.tools[0].toolSpec.inputSchema.json).toEqual({
      type: 'object',
      properties: {},
    })
  })

  it('omits toolConfig entirely when there are no tools and no tool blocks', async () => {
    const req = await buildConverseRequest({
      ...base,
      messages: [msg('m1', 'user', 1, 'just prose')],
      toolCalls: [],
      renderedToolCallResults: new Map(),
    })
    expect(req.toolConfig).toBeUndefined()
  })

  it('merges consecutive same-role turns losslessly by default', () => {
    const raw: ConverseMessage[] = [
      { role: 'user', content: [{ text: 'a' }] },
      { role: 'user', content: [{ text: 'b' }] },
      { role: 'assistant', content: [{ text: 'c' }] },
    ]
    const merged = enforceConverseAlternation(raw, 'merge')
    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant'])
    // Lossless: both blocks survive, in order.
    expect(merged[0].content).toEqual([{ text: 'a' }, { text: 'b' }])
  })

  it('does not pre-collapse same-role turns during assembly, so reject stays honest', async () => {
    // REGRESSION. The assembler used to coalesce same-role turns as it appended, which applied the
    // merge unconditionally BEFORE alternationPolicy was consulted — so 'reject' had nothing left
    // to preserve, and a live audit cell measured our own repair instead of Converse's verdict.
    // Merging is enforceConverseAlternation's job alone.
    const req = await buildConverseRequest({
      ...base,
      messages: [msg('m1', 'user', 1, 'first'), msg('m2', 'user', 2, 'second')],
      toolCalls: [],
      renderedToolCallResults: new Map(),
      alternationPolicy: 'reject',
    })
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'user'])
  })

  it('leaves history UNTOUCHED under reject, so the vendor error can be observed', () => {
    const raw: ConverseMessage[] = [
      { role: 'user', content: [{ text: 'a' }] },
      { role: 'user', content: [{ text: 'b' }] },
    ]
    // The whole point of the escape hatch: a repair before dispatch is invisible in the response,
    // which makes a client-side fix indistinguishable from vendor tolerance.
    expect(enforceConverseAlternation(raw, 'reject')).toEqual(raw)
    expect(enforceConverseAlternation(raw, 'filler').map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  it('sanitizes a toolUseId to the charset Converse accepts', () => {
    expect(sanitizeToolUseId('call/with:bad chars')).toBe('call_with_bad_chars')
    expect(sanitizeToolUseId('x'.repeat(80))).toHaveLength(64)
    expect(sanitizeToolUseId('')).toBe('tool_use')
  })

  it('separates reasoning from visible text on extraction', () => {
    const out = extractConverseGeneration({
      output: {
        message: {
          content: [
            { reasoningContent: { reasoningText: { text: 'thinking' } } },
            { text: 'the answer' },
            { toolUse: { toolUseId: 't1', name: 'f', input: { a: 1 } } },
          ],
        },
      },
      stopReason: 'tool_use',
    })
    expect(out.reasoning).toBe('thinking')
    expect(out.text).toBe('the answer')
    expect(out.toolUses).toEqual([{ toolUseId: 't1', name: 'f', input: { a: 1 } }])
    expect(out.stopReason).toBe('tool_use')
  })
})
