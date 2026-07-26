import { DateTime } from 'luxon'
import { Thought } from '@nhtio/adk/common'
import { describe, expect, it } from 'vitest'
import {
  fingerprintAnthropicMessagesPrefix,
  renderAnthropicThinkingBlocks,
} from '@nhtio/adk/batteries/llm/anthropic_messages'

const dt = DateTime.fromISO('2026-01-01T00:00:00Z', { zone: 'utc' })

const makeThought = (payload: unknown, replayCompatibility = 'anthropic-messages-thinking-v1') =>
  new Thought({
    id: 'th-1',
    content: 'human-visible thought',
    identity: 'assistant',
    payload,
    replayCompatibility,
    createdAt: dt,
    updatedAt: dt,
  })

describe('Anthropic thinking helpers', () => {
  it('replays signed thinking byte-exact when prefixFingerprint matches', async () => {
    const prefixFingerprint = await fingerprintAnthropicMessagesPrefix({
      model: 'claude-opus-5',
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 'search_docs', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    const thought = makeThought({
      variant: 'thinking',
      thinking: 'opaque bytes',
      signature: 'sig-xyz',
      prefixFingerprint,
    })

    expect(
      renderAnthropicThinkingBlocks({
        thought,
        model: 'claude-opus-5',
        prefixFingerprint,
        replayCompatibility: ['anthropic-messages-thinking-v1'],
      })
    ).toEqual([{ type: 'thinking', thinking: 'opaque bytes', signature: 'sig-xyz' }])
  })

  it('drops the whole block on fingerprint mismatch and supports redacted_thinking', () => {
    const signed = makeThought({
      variant: 'thinking',
      thinking: 'opaque bytes',
      signature: 'sig-xyz',
      prefixFingerprint: 'match-me',
    })
    expect(
      renderAnthropicThinkingBlocks({
        thought: signed,
        model: 'claude-opus-5',
        prefixFingerprint: 'different',
        replayCompatibility: ['anthropic-messages-thinking-v1'],
      })
    ).toEqual([])

    const redacted = makeThought({
      variant: 'redacted_thinking',
      data: 'encrypted-redacted-block',
      prefixFingerprint: 'same',
    })
    expect(
      renderAnthropicThinkingBlocks({
        thought: redacted,
        model: 'claude-opus-5',
        prefixFingerprint: 'same',
        replayCompatibility: ['anthropic-messages-thinking-v1'],
      })
    ).toEqual([{ type: 'redacted_thinking', data: 'encrypted-redacted-block' }])
  })
})
