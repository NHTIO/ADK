import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Message, ToolCall, Tokenizable } from '@nhtio/adk/common'
import {
  buildGeminiRequest,
  toolsToGeminiTools,
  extractGeminiGeneration,
} from '../../../../src/batteries/llm/gemini_generate_content/helpers'

const at = (s: number) => DateTime.fromMillis(s * 1000)
const msg = (id: string, role: 'user' | 'assistant', s: number, c: string) =>
  new Message({ id, role, content: c, createdAt: at(s), updatedAt: at(s) })
const tc = (id: string, s: number, payload?: Record<string, unknown>) =>
  new ToolCall({
    id,
    tool: 'get_file_diff',
    args: { path: 'src/retry.ts' },
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('@@ -12,7 +12,9 @@'),
    createdAt: at(s),
    updatedAt: at(s),
    completedAt: at(s),
    ...(payload ? { payload, replayCompatibility: 'test' } : {}),
  } as never)

const emptyReg = { visible: () => [], all: () => [], get: () => undefined } as never
const toolCall = tc('c1', 2)
const firstCall = tc('c1', 2)
const secondCall = tc('c2', 3)
const signedCall = tc('c1', 2, { thoughtSignature: 'REAL-SIG' })
const unsignedCall = tc('c1', 2)

describe('gemini request assembly', () => {
  it('renders a ToolCall as model.functionCall + user.functionResponse', async () => {
    const req = await buildGeminiRequest({
      systemPrompt: new Tokenizable('You are a reviewer.'),
      standingInstructions: [],
      memories: [],
      retrievables: [],
      messages: [msg('m1', 'user', 1, 'Review the hunks.')],
      thoughts: [],
      toolCalls: [toolCall],
      tools: emptyReg,
      renderedToolCallResults: new Map([[toolCall, { result: '@@ -12,7 +12,9 @@' }]]),
      bucketOrder: undefined as never,
      selfIdentity: 'assistant',
      thoughtSurfacing: 'all-self',
      replayCompatibility: [],
      thoughtSignatureSentinel: 'skip_thought_signature_validator',
      helpers: { toolsToGeminiTools } as never,
    })
    const roles = req.contents.map((c) => c.role)
    expect(roles).toEqual(['user', 'model', 'user'])
    // assistant -> model; tool result lands on a USER turn as functionResponse
    expect(req.contents[1].parts[0].functionCall?.name).toBe('get_file_diff')
    expect(req.contents[2].parts[0].functionResponse?.name).toBe('get_file_diff')
    // system text goes OUT-OF-BAND, never into contents[]
    expect(req.systemInstruction?.parts[0].text).toContain('You are a reviewer.')
    expect(JSON.stringify(req.contents)).not.toContain('You are a reviewer.')
  })

  it('stamps the sentinel on the first call only, and never over a real signature', async () => {
    const base = {
      systemPrompt: new Tokenizable('sys'),
      standingInstructions: [],
      memories: [],
      retrievables: [],
      messages: [msg('m1', 'user', 1, 'go')],
      thoughts: [],
      tools: emptyReg,
      bucketOrder: undefined as never,
      selfIdentity: 'assistant',
      thoughtSurfacing: 'all-self' as const,
      replayCompatibility: [],
      helpers: { toolsToGeminiTools } as never,
    }
    const two = await buildGeminiRequest({
      ...base,
      toolCalls: [firstCall, secondCall],
      renderedToolCallResults: new Map([
        [firstCall, { result: 'a' }],
        [secondCall, { result: 'b' }],
      ]),
      thoughtSignatureSentinel: 'skip_thought_signature_validator',
    })
    const sigs = two.contents
      .flatMap((c) => c.parts)
      .filter((p) => p.functionCall)
      .map((p) => p.thoughtSignature)
    expect(sigs).toEqual(['skip_thought_signature_validator', undefined])

    const real = await buildGeminiRequest({
      ...base,
      toolCalls: [signedCall],
      renderedToolCallResults: new Map([[signedCall, { result: 'a' }]]),
      thoughtSignatureSentinel: 'skip_thought_signature_validator',
    })
    expect(
      real.contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.thoughtSignature
    ).toBe('REAL-SIG')

    const off = await buildGeminiRequest({
      ...base,
      toolCalls: [unsignedCall],
      renderedToolCallResults: new Map([[unsignedCall, { result: 'a' }]]),
      thoughtSignatureSentinel: false,
    })
    expect(
      off.contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.thoughtSignature
    ).toBeUndefined()
  })

  it('keeps each duplicate-id call paired with its own result', async () => {
    const first = tc('same-id', 2)
    const second = tc('same-id', 3)
    const req = await buildGeminiRequest({
      systemPrompt: new Tokenizable('sys'),
      standingInstructions: [],
      memories: [],
      retrievables: [],
      messages: [],
      thoughts: [],
      toolCalls: [first, second],
      tools: emptyReg,
      renderedToolCallResults: new Map([
        [first, { result: 'first result' }],
        [second, { result: 'second result' }],
      ]),
      selfIdentity: 'assistant',
      thoughtSurfacing: 'all-self',
      replayCompatibility: [],
      thoughtSignatureSentinel: false,
      helpers: { toolsToGeminiTools } as never,
    })
    const responses = req.contents
      .filter((content) => content.role === 'user')
      .map((content) => content.parts[0].functionResponse?.response.result)
    expect(responses).toEqual(['first result', 'second result'])
  })

  it('separates reasoning from visible text on extraction', () => {
    const out = extractGeminiGeneration({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'thinking hard', thought: true },
              { text: 'the answer' },
              { functionCall: { name: 'f', args: { a: 1 } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    })
    expect(out.reasoning).toBe('thinking hard')
    expect(out.text).toBe('the answer')
    expect(out.functionCalls).toEqual([{ name: 'f', args: { a: 1 } }])
  })
})
