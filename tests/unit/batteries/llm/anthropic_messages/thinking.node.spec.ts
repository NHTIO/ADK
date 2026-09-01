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

  // Regression coverage for the `chat_common` fingerprint-extraction refactor: `canonical()` /
  // `fingerprint()` used to live module-private in this file's own `helpers.ts`; they were pulled
  // out into the shared, exported `canonicalFingerprint()` in `chat_common/helpers.ts`, and this
  // function was reimplemented as a thin wrapper that assembles the Anthropic-shaped prefix object
  // and delegates to it. These hashes were computed against the PRE-refactor `canonical()`/
  // `fingerprint()` implementation and pinned here so any future change to either the canonicalisation
  // rules or the hash algorithm is caught, regardless of which module the logic lives in.
  it('pins fingerprintAnthropicMessagesPrefix hash output across representative inputs (hash-stability regression)', async () => {
    await expect(
      fingerprintAnthropicMessagesPrefix({
        model: 'claude-opus-5',
        system: [{ type: 'text', text: 'sys' }],
        tools: [{ name: 'search_docs', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      })
    ).resolves.toBe('1566013c7929149620dd29e3bb84716c39a358da49357cef5e71800677d0c952')

    await expect(
      fingerprintAnthropicMessagesPrefix({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
    ).resolves.toBe('a1ed558555f6bc6c8dfa5b412fdbede0fef3857e83117fd777fe528903644910')

    await expect(
      fingerprintAnthropicMessagesPrefix({
        model: 'claude-opus-5',
        system: 'you are a helpful assistant',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
    ).resolves.toBe('5a0e73033e8dd58e0a823369a3c800ff79f16c2a20d8a5aa85e3c672272bd363')

    // throughBlock slicing: the thinking block itself and anything after it must be excluded.
    await expect(
      fingerprintAnthropicMessagesPrefix({
        model: 'claude-opus-5',
        system: [{ type: 'text', text: 'sys' }],
        tools: [],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'kept-before-thinking' },
              { type: 'thinking', thinking: 'excluded', signature: 'x' },
            ],
          },
        ],
        throughBlock: { messageIndex: 1, contentIndex: 1 },
      })
    ).resolves.toBe('72e68d70243738678ea53547cac6e69e99314b49556779a533002340449acc6a')
  })
})
