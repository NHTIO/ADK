/**
 * The four MEASURED rules — added from observed vendor behaviour rather than vendor documentation.
 *
 * Two of them catch the SILENT failure class this audit spent the longest chasing: a provider
 * answering HTTP 200 with no generation, or with a field quietly missing. Neither produces a status
 * code or an error body, so a rule is the only place they can be caught.
 */
import { describe, expect, it } from 'vitest'
import { evaluateOrderingProfile } from '../../../../../src/batteries/validation/helpers'
import { toolIdentity } from '../../../../../src/batteries/validation/profiles/tool_identity'
import { nonEmptyTurn } from '../../../../../src/batteries/validation/profiles/non_empty_turn'
import { schemaIntegrity } from '../../../../../src/batteries/validation/profiles/schema_integrity'
import { toolCallIdFormat } from '../../../../../src/batteries/validation/profiles/tool_call_id_format'
import type { OrderingTimelineEntry } from '../../../../../src/batteries/validation/types'

const call = (id: string, tool: string, at = 0): OrderingTimelineEntry =>
  ({ kind: 'toolCall', at, seq: at, value: { id, tool } }) as never
const msg = (
  id: string,
  role: 'user' | 'assistant',
  at: number,
  content?: string
): OrderingTimelineEntry =>
  ({ kind: 'message', at, seq: at, role, value: { id, content } }) as never

describe('tool-identity (Gemini empty-candidate root cause)', () => {
  it('reports a tool result naming a tool the request does not declare', () => {
    const result = evaluateOrderingProfile([call('c1', 'get_file_diff')], toolIdentity, {
      tools: [{ name: 'read_file' }],
    })
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].ruleId).toBe('tool-result-names-a-declared-tool')
    // The detail must explain the SILENCE — that is why this rule exists.
    expect(result.advisories[0].detail).toContain('empty generation')
  })

  it('accepts a tool result whose name is declared', () => {
    const result = evaluateOrderingProfile([call('c1', 'read_file')], toolIdentity, {
      tools: [{ name: 'read_file' }],
    })
    expect(result.advisories).toHaveLength(0)
  })

  it('skips silently when no tool registry is supplied', () => {
    // The offline evaluator has no registry; the rule must not fire on absence of evidence.
    const result = evaluateOrderingProfile([call('c1', 'anything')], toolIdentity)
    expect(result.advisories).toHaveLength(0)
    expect(result.blocking).toHaveLength(0)
  })
})

describe('schema-integrity (Nova silent-omission root cause)', () => {
  it('reports a required key absent from properties', () => {
    const result = evaluateOrderingProfile([call('c1', 'read_file')], schemaIntegrity, {
      tools: [
        {
          name: 'read_file',
          // `title` was stripped from properties by a sanitising pass but left in `required` —
          // the exact shape that made Nova answer 200 with the field missing.
          inputSchema: { type: 'object', properties: { path: {} }, required: ['path', 'title'] },
        },
      ],
    })
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].detail).toContain('title')
    expect(result.advisories[0].detail).toContain('unsatisfiable')
  })

  it('accepts a satisfiable schema', () => {
    const result = evaluateOrderingProfile([call('c1', 'read_file')], schemaIntegrity, {
      tools: [
        {
          name: 'read_file',
          inputSchema: { type: 'object', properties: { path: {} }, required: ['path'] },
        },
      ],
    })
    expect(result.advisories).toHaveLength(0)
  })

  it('ignores a schema with no required list', () => {
    const result = evaluateOrderingProfile([call('c1', 'read_file')], schemaIntegrity, {
      tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: { path: {} } } }],
    })
    expect(result.advisories).toHaveLength(0)
  })
})

describe('tool-call-id-format', () => {
  it('reports an id longer than the provider cap', () => {
    const result = evaluateOrderingProfile([call('x'.repeat(80), 'read_file')], toolCallIdFormat())
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].detail).toContain('80 characters')
  })

  it('reports an id containing characters outside the allowed class', () => {
    const result = evaluateOrderingProfile(
      [call('call/with:colons', 'read_file')],
      toolCallIdFormat()
    )
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].detail).toContain('outside')
  })

  it("accepts the ADK's own uuidv6-shaped ids", () => {
    const result = evaluateOrderingProfile(
      [call('1efb5c40-9c1a-6e30-8f21-4b0d2c9a77e5', 'read_file')],
      toolCallIdFormat()
    )
    expect(result.advisories).toHaveLength(0)
  })
})

describe('non-empty-turn (mistral 400 + gemini MALFORMED_RESPONSE)', () => {
  it('reports an assistant turn carrying neither content nor an adjacent call', () => {
    const result = evaluateOrderingProfile(
      [msg('m1', 'user', 1, 'go'), msg('m2', 'assistant', 2, '')],
      nonEmptyTurn()
    )
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].primitiveIds).toEqual(['m2'])
  })

  it('accepts an empty assistant turn that is adjacent to a tool call', () => {
    // The ordinary shape of a tool-calling turn: no prose, but a call carries the intent.
    const result = evaluateOrderingProfile(
      [msg('m1', 'user', 1, 'go'), msg('m2', 'assistant', 2, ''), call('c1', 'read_file', 3)],
      nonEmptyTurn()
    )
    expect(result.advisories).toHaveLength(0)
  })

  it('onlyTerminal checks the final turn and ignores earlier ones', () => {
    const timeline = [
      msg('m1', 'assistant', 1, ''),
      msg('m2', 'user', 2, 'go'),
      msg('m3', 'assistant', 3, 'done'),
    ]
    // m1 is empty but not terminal, and m3 is terminal but non-empty.
    expect(evaluateOrderingProfile(timeline, nonEmptyTurn(true)).advisories).toHaveLength(0)
    // Without the terminal restriction the earlier empty turn is reported.
    expect(evaluateOrderingProfile(timeline, nonEmptyTurn(false)).advisories).toHaveLength(1)
  })

  it('reports a terminal empty assistant turn — the Gemini thought-only shape', () => {
    const result = evaluateOrderingProfile(
      [msg('m1', 'user', 1, 'go'), msg('m2', 'assistant', 2, '')],
      nonEmptyTurn(true)
    )
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0].primitiveIds).toEqual(['m2'])
  })
})
