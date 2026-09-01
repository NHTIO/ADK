/**
 * Reasoning-replay coverage for the OpenAI Responses battery: the adjacency-sweep pass, id-stripping
 * on a dropped pairing, `encrypted_content` backfill, fingerprint-mismatch drop-with-warn (via the
 * shared `canonicalFingerprint` from `chat_common/helpers.ts`), and the pairing-violation 400 →
 * `E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED` translation.
 *
 * Cross-platform (no node imports) — runs in every vitest project.
 */
import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { describe, expect, it, vi } from 'vitest'
import { buildResponsesStreamFrames } from '../../../../_fixtures/cassette'
import { canonicalFingerprint } from '@nhtio/adk/batteries/llm/openai_responses'
import {
  Tokenizable,
  Message,
  Thought,
  ToolCall,
  Tool,
  ToolRegistry,
  Registry,
} from '@nhtio/adk/common'
import {
  buildOpenAIResponsesInput,
  renderOpenAIResponsesReasoningItem,
  renderOpenAIResponsesToolCallResult,
  renderOpenAIResponsesMediaBlocks,
  renderOpenAIResponsesTimelineMessage,
  fingerprintOpenAIResponsesPrefix,
  toolsToOpenAIResponsesTools,
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
  OpenAIResponsesAdapter,
  E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED,
} from '@nhtio/adk/batteries/llm/openai_responses'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { ChatCompletionsBucketOrder } from '@nhtio/adk/batteries/llm/anthropic_messages'
import type {
  OpenAIResponsesReasoningItem,
  OpenAIResponsesOutputMessageItem,
  OpenAIResponsesReasoningReplayPayload,
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
  const createdAt = overrides.createdAt ?? dt('2026-01-01T12:00:30Z')
  return new Thought({
    id: overrides.id ?? 'th1',
    content: overrides.content ?? 'reasoning trace',
    identity: overrides.identity ?? 'assistant',
    createdAt,
    updatedAt: createdAt,
    payload: overrides.payload,
    replayCompatibility: overrides.replayCompatibility,
  })
}

// A non-empty tool registry, reused by every adjacency-sweep test below.
//
// FIXED (was: every reasoning item dropped as stale whenever NO tools were registered).
// `buildOpenAIResponsesInput` returns `{ tools: undefined }` when the registry is empty (its
// `tools: tools.length > 0 ? tools : undefined` return shape), but the adjacency-sweep pass used
// to re-fingerprint against its LOCAL `tools` array — which is always `[]`, never `undefined`,
// since `toolsToOpenAIResponsesTools` on an empty registry returns `[]`. Meanwhile `persistThought`
// hashed `assembled.tools ?? []`. `canonicalFingerprint`'s `canonical()` walk emits `undefined` and
// `[]` as different bytes, so the two hashes could never match and replay was unconditionally dead
// for tool-less agents. Both sides now agree on the `undefined`-when-empty shape; the
// `tools: undefined` case is pinned by its own regression test at the bottom of this file.
const makeToolForFingerprint = () =>
  new Tool({
    name: 'noop_tool',
    description: 'no-op',
    inputSchema: validator.object({}),
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
  tools: new ToolRegistry([makeToolForFingerprint()]),
  renderedToolCallResults: new Map(),
  bucketOrder: ['timeline'],
  selfIdentity: 'assistant',
  thoughtSurfacing: 'all-self',
  replayCompatibility: ['openai-responses-reasoning-v1'],
  reasoningReplay: 'encrypted',
  systemPromptChannel: 'instructions',
  unsupportedMediaPolicy: 'throw',
  ...baseDeps,
  ...overrides,
})

// ─── renderOpenAIResponsesReasoningItem — signature/fingerprint eligibility ────

describe('renderOpenAIResponsesReasoningItem', () => {
  const item: OpenAIResponsesReasoningItem = {
    type: 'reasoning',
    id: 'rs-1',
    summary: [{ type: 'summary_text', text: 'summary' }],
  }

  it('returns undefined when replayCompatibility tag is not in the allowed set', () => {
    const thought = makeThought({
      payload: { variant: 'responses-reasoning', item, prefixFingerprint: 'fp' },
      replayCompatibility: 'some-other-tag',
    })
    const out = renderOpenAIResponsesReasoningItem({
      thought,
      prefixFingerprint: 'fp',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      reasoningReplay: 'encrypted',
    })
    expect(out).toBeUndefined()
  })

  it('returns undefined when payload is missing, wrong variant, or has no item', () => {
    const noPayload = makeThought({ replayCompatibility: 'openai-responses-reasoning-v1' })
    expect(
      renderOpenAIResponsesReasoningItem({
        thought: noPayload,
        prefixFingerprint: 'fp',
        replayCompatibility: ['openai-responses-reasoning-v1'],
        reasoningReplay: 'encrypted',
      })
    ).toBeUndefined()

    const wrongVariant = makeThought({
      payload: { variant: 'thinking', item },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    expect(
      renderOpenAIResponsesReasoningItem({
        thought: wrongVariant,
        prefixFingerprint: 'fp',
        replayCompatibility: ['openai-responses-reasoning-v1'],
        reasoningReplay: 'encrypted',
      })
    ).toBeUndefined()

    const noItem = makeThought({
      payload: { variant: 'responses-reasoning', prefixFingerprint: 'fp' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    expect(
      renderOpenAIResponsesReasoningItem({
        thought: noItem,
        prefixFingerprint: 'fp',
        replayCompatibility: ['openai-responses-reasoning-v1'],
        reasoningReplay: 'encrypted',
      })
    ).toBeUndefined()
  })

  it('drops with a warn on fingerprint mismatch', () => {
    const thought = makeThought({
      payload: { variant: 'responses-reasoning', item, prefixFingerprint: 'stale-fp' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const warn = vi.fn()
    const out = renderOpenAIResponsesReasoningItem({
      thought,
      prefixFingerprint: 'current-fp',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      reasoningReplay: 'encrypted',
      warn,
    })
    expect(out).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('stale')
    expect(warn.mock.calls[0]![0]).toContain(thought.id)
  })

  it('returns the item verbatim when fingerprint matches', () => {
    const thought = makeThought({
      payload: { variant: 'responses-reasoning', item, prefixFingerprint: 'match-fp' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const out = renderOpenAIResponsesReasoningItem({
      thought,
      prefixFingerprint: 'match-fp',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      reasoningReplay: 'encrypted',
    })
    expect(out).toEqual(item)
  })

  it("under reasoningReplay:'summary-only', strips content and encrypted_content, keeping only summary", () => {
    const fullItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-2',
      summary: [{ type: 'summary_text', text: 'summary only' }],
      content: [{ type: 'reasoning_text', text: 'the full private reasoning trace' }],
      encrypted_content: 'opaque-signed-blob',
      status: 'completed',
    }
    const thought = makeThought({
      payload: { variant: 'responses-reasoning', item: fullItem, prefixFingerprint: 'match-fp' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const out = renderOpenAIResponsesReasoningItem({
      thought,
      prefixFingerprint: 'match-fp',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      reasoningReplay: 'summary-only',
    })
    expect(out).toEqual({
      type: 'reasoning',
      id: 'rs-2',
      summary: [{ type: 'summary_text', text: 'summary only' }],
      status: 'completed',
    })
    expect(out).not.toHaveProperty('content')
    expect(out).not.toHaveProperty('encrypted_content')
  })

  it("under reasoningReplay:'encrypted', content and encrypted_content pass through verbatim", () => {
    const fullItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-3',
      summary: [{ type: 'summary_text', text: 'summary' }],
      content: [{ type: 'reasoning_text', text: 'the full private reasoning trace' }],
      encrypted_content: 'opaque-signed-blob',
    }
    const thought = makeThought({
      payload: { variant: 'responses-reasoning', item: fullItem, prefixFingerprint: 'match-fp' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const out = renderOpenAIResponsesReasoningItem({
      thought,
      prefixFingerprint: 'match-fp',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      reasoningReplay: 'encrypted',
    })
    expect(out).toEqual(fullItem)
  })
})

// ─── canonicalFingerprint / fingerprintOpenAIResponsesPrefix ──────────────────

describe('fingerprintOpenAIResponsesPrefix', () => {
  it('delegates to the shared canonicalFingerprint primitive (same hash for same canonical shape)', async () => {
    const args = {
      model: 'gpt-x-responses',
      instructions: 'sys',
      tools: [{ type: 'function' as const, name: 't', parameters: null }],
      input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'hi' }] }],
    }
    const viaWrapper = await fingerprintOpenAIResponsesPrefix(args)
    const viaShared = await canonicalFingerprint({
      model: args.model,
      instructions: args.instructions,
      tools: args.tools,
      input: args.input,
    })
    expect(viaWrapper).toBe(viaShared)
  })

  it('slices `input` through (not including) `throughItem`', async () => {
    const full = {
      model: 'm',
      input: [
        { role: 'user' as const, content: [{ type: 'input_text' as const, text: 'a' }] },
        { role: 'assistant' as const, content: [{ type: 'input_text' as const, text: 'b' }] },
      ],
    }
    const throughFirst = await fingerprintOpenAIResponsesPrefix({ ...full, throughItem: 1 })
    const onlyFirst = await fingerprintOpenAIResponsesPrefix({
      ...full,
      input: full.input.slice(0, 1),
    })
    expect(throughFirst).toBe(onlyFirst)

    const full2 = await fingerprintOpenAIResponsesPrefix(full)
    expect(full2).not.toBe(throughFirst)
  })

  // Regression guard for a fixed bug: `buildOpenAIResponsesInput` returns `tools: undefined` when
  // the registry is empty (`{ ...(tools.length > 0 ? { tools } : {}) }` in its own return
  // statement), while its INTERNAL adjacency-sweep pass used to fingerprint against the local
  // `tools` array, which is `[]` (never `undefined`) for an empty registry. `canonicalFingerprint`
  // emits `undefined` and `[]` as different bytes, so the two sides could never agree and every
  // replayed reasoning item was dropped as stale for any tool-less agent.
  //
  // Both sides now use the `undefined`-when-empty shape: the sweep passes
  // `tools.length > 0 ? tools : undefined`, and `persistThought` passes `assembled.tools` through
  // with NO `?? []` coercion. This test mirrors the REAL call shapes — an earlier version coerced
  // both sides to `[]` and therefore passed vacuously without testing anything.
  it('an empty tool registry does not diverge the persisted fingerprint from the adjacency sweep (both use tools:undefined)', async () => {
    const dry = await buildOpenAIResponsesInput(
      baseBuildArgs({ tools: new ToolRegistry([]), reasoningReplay: 'off' })
    )
    expect(dry.tools).toBeUndefined()
    const fpAsPersisted = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: dry.tools, // exactly what persistThought passes — no `?? []`
      input: dry.input,
      throughItem: dry.fingerprintableLength,
    })
    const fpAsSweepRecomputes = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: undefined, // what the sweep now uses for an empty registry
      input: dry.input,
      throughItem: dry.fingerprintableLength,
    })
    expect(fpAsPersisted).toBe(fpAsSweepRecomputes)
    // And the coercion that USED to be here is genuinely a different hash — proving this test
    // would fail if either side reintroduced `?? []`.
    const fpIfCoerced = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: [],
      input: dry.input,
      throughItem: dry.fingerprintableLength,
    })
    expect(fpIfCoerced).not.toBe(fpAsPersisted)
  })

  // Regression guard: a trailing bucket is appended at step 4, AFTER the step-3 adjacency sweep
  // has already run — so it is invisible to every prefix the sweep hashes on the next turn.
  // Fingerprinting the whole `assembled.input` therefore guaranteed a mismatch whenever
  // `bucketOrder` placed a non-empty bucket after `'timeline'`, dropping every replayed reasoning
  // item as stale. `fingerprintableLength` marks the end of the sweep-visible region.
  it('excludes a trailing bucket from the fingerprintable region so persist and sweep agree', async () => {
    const withTrailing = await buildOpenAIResponsesInput(
      baseBuildArgs({
        bucketOrder: ['timeline', 'standingInstructions'],
        standingInstructions: [new Tokenizable('ALWAYS BE CLOSING')],
        messages: [makeMessage({ content: 'hi' })],
        reasoningReplay: 'off',
      })
    )
    // The trailing bucket really was emitted, and it is excluded from the fingerprintable region.
    expect(withTrailing.input.length).toBeGreaterThan(withTrailing.fingerprintableLength)
    const last = withTrailing.input[withTrailing.input.length - 1] as { role?: string }
    expect(last.role).toBe('system')

    // Hashing the full input (the old behavior) differs from hashing the sweep-visible region.
    const fpWholeInput = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: withTrailing.instructions,
      tools: withTrailing.tools,
      input: withTrailing.input,
    })
    const fpSweepRegion = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: withTrailing.instructions,
      tools: withTrailing.tools,
      input: withTrailing.input,
      throughItem: withTrailing.fingerprintableLength,
    })
    expect(fpWholeInput).not.toBe(fpSweepRegion)
  })

  // Under the default bucketOrder (ending in 'timeline') nothing is appended after the sweep, so
  // the fingerprintable region is the whole input — the fix must be a no-op there.
  it('fingerprintableLength equals input.length under the default bucket order', async () => {
    const dry = await buildOpenAIResponsesInput(
      baseBuildArgs({
        messages: [makeMessage({ content: 'hi' })],
        reasoningReplay: 'off',
      })
    )
    expect(dry.fingerprintableLength).toBe(dry.input.length)
  })
})

// ─── buildOpenAIResponsesInput — adjacency-sweep pass ─────────────────────────

describe('buildOpenAIResponsesInput — reasoning/output-item adjacency sweep', () => {
  it('replays a reasoning item verbatim when its stored prefixFingerprint matches the ACTUAL prefix at its position', async () => {
    // Compute the fingerprint the builder would derive: instructions + tools (none) + input up to
    // (not including) the reasoning item's own position. Only a user message precedes it here.
    const priorUser = makeMessage({
      id: 'u1',
      role: 'user',
      content: 'hi',
      createdAt: dt('2026-01-01T11:59:00Z'),
    })
    // The user message renders through renderOpenAIResponsesTimelineMessage; predict its item shape
    // by calling the builder once to discover the actual item, then compute the fingerprint against
    // that exact item, and re-run with the thought included — mirrors the adapter's own two-step
    // process (assemble once, drop reasoning; the adjacency pass re-derives the real position).
    const dry = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [priorUser], thoughts: [], reasoningReplay: 'off' })
    )
    const prefixFingerprint = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: dry.tools,
      input: dry.input,
    })

    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-good',
      summary: [{ type: 'summary_text', text: 'thinking' }],
    }
    const thought = makeThought({
      id: 'th-good',
      createdAt: dt('2026-01-01T12:00:00Z'),
      payload: { variant: 'responses-reasoning', item: reasoningItem, prefixFingerprint },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const trailingAssistant = makeMessage({
      id: 'a1',
      role: 'assistant',
      identity: 'assistant',
      content: 'final answer',
      createdAt: dt('2026-01-01T12:01:00Z'),
    })

    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [priorUser, trailingAssistant], thoughts: [thought] })
    )
    const idx = out.input.findIndex((i) => i.type === 'reasoning')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(out.input[idx]).toEqual(reasoningItem)
    // Followed immediately by the paired output item (own-assistant output-message shape).
    expect(out.input[idx + 1]!.type).toBe('message')
  })

  it('drops a reasoning item when the following item is not its recorded pairedItemId, even with a matching fingerprint', async () => {
    // Regression guard: the adjacency sweep must check `nextItem.id === payload.pairedItemId`, not
    // just "some item follows" + a fingerprint match — a reasoning item stored as paired with one
    // specific output item id must not silently adopt a DIFFERENT following item as its partner,
    // even when the prefix fingerprint (which does not encode item identity) happens to match.
    const priorUser = makeMessage({
      id: 'u1-pair',
      role: 'user',
      content: 'hi',
      createdAt: dt('2026-01-01T11:59:00Z'),
    })
    const dry = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [priorUser], thoughts: [], reasoningReplay: 'off' })
    )
    const prefixFingerprint = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: dry.tools,
      input: dry.input,
    })
    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-mispaired',
      summary: [{ type: 'summary_text', text: 'thinking' }],
    }
    const thought = makeThought({
      id: 'th-mispaired',
      createdAt: dt('2026-01-01T12:00:00Z'),
      payload: {
        variant: 'responses-reasoning',
        item: reasoningItem,
        prefixFingerprint,
        pairedItemId: 'some-other-item-id-not-what-actually-follows',
      },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const trailingAssistant = makeMessage({
      id: 'a-mispaired',
      role: 'assistant',
      identity: 'assistant',
      content: 'final answer',
      createdAt: dt('2026-01-01T12:01:00Z'),
    })
    const warn = vi.fn()
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [priorUser, trailingAssistant], thoughts: [thought], warn })
    )
    expect(out.input.find((i) => i.type === 'reasoning')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    const msg = warn.mock.calls.map((c) => String(c[0])).join(' ')
    expect(msg).toContain('th-mispaired')
    expect(msg).toContain('recorded pairing partner')
  })

  it('drops a reasoning item with no paired output item following it (nothing after it in input)', async () => {
    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-orphan',
      summary: [{ type: 'summary_text', text: 'orphaned' }],
    }
    const thought = makeThought({
      id: 'th-orphan',
      payload: {
        variant: 'responses-reasoning',
        item: reasoningItem,
        prefixFingerprint: 'whatever',
      },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const out = await buildOpenAIResponsesInput(baseBuildArgs({ thoughts: [thought] }))
    expect(out.input.find((i) => i.type === 'reasoning')).toBeUndefined()
  })

  it('drops on a stale/mismatched fingerprint, with a warn, even when something follows', async () => {
    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-stale',
      summary: [{ type: 'summary_text', text: 'stale' }],
    }
    const thought = makeThought({
      id: 'th-stale',
      createdAt: dt('2026-01-01T12:00:00Z'),
      payload: {
        variant: 'responses-reasoning',
        item: reasoningItem,
        prefixFingerprint: 'definitely-wrong',
      },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const trailingAssistant = makeMessage({
      id: 'a-after-stale',
      role: 'assistant',
      identity: 'assistant',
      content: 'answer',
      createdAt: dt('2026-01-01T12:01:00Z'),
    })
    const warn = vi.fn()
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [trailingAssistant], thoughts: [thought], warn })
    )
    expect(out.input.find((i) => i.type === 'reasoning')).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    const msg = warn.mock.calls.map((c) => String(c[0])).join(' ')
    expect(msg).toContain('th-stale')
  })

  it('strips the `id` from the paired output item when its reasoning partner is dropped', async () => {
    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-orphan-2',
      summary: [{ type: 'summary_text', text: 'x' }],
    }
    const thought = makeThought({
      id: 'th-orphan-2',
      createdAt: dt('2026-01-01T11:59:00Z'),
      payload: { variant: 'responses-reasoning', item: reasoningItem, prefixFingerprint: 'wrong' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const own = makeMessage({
      id: 'own-after-orphan',
      role: 'assistant',
      identity: 'assistant',
      content: 'answer text',
      createdAt: dt('2026-01-01T12:00:00Z'),
    })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [own], thoughts: [thought] })
    )
    expect(out.input.find((i) => i.type === 'reasoning')).toBeUndefined()
    const msgItem = out.input.find((i) => i.type === 'message') as OpenAIResponsesOutputMessageItem
    expect(msgItem).toBeDefined()
    expect(msgItem.id).toBeUndefined()
  })

  it('multiple reasoning items: an adjacency-valid one survives while an invalid one is dropped independently', async () => {
    const goodItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-multi-good',
      summary: [{ type: 'summary_text', text: 'good' }],
    }
    const badItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-multi-bad',
      summary: [{ type: 'summary_text', text: 'bad' }],
    }
    // Compute the good thought's real fingerprint against the dry-run prefix.
    const priorUser = makeMessage({
      id: 'u-multi',
      content: 'q',
      createdAt: dt('2026-01-01T11:00:00Z'),
    })
    const dry = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [priorUser], reasoningReplay: 'off' })
    )
    const goodFp = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: dry.tools,
      input: dry.input,
    })
    const goodThought = makeThought({
      id: 'th-multi-good',
      createdAt: dt('2026-01-01T11:30:00Z'),
      payload: { variant: 'responses-reasoning', item: goodItem, prefixFingerprint: goodFp },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const badThought = makeThought({
      id: 'th-multi-bad',
      createdAt: dt('2026-01-01T12:30:00Z'),
      payload: { variant: 'responses-reasoning', item: badItem, prefixFingerprint: 'stale' },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const firstAssistant = makeMessage({
      id: 'a-mid',
      role: 'assistant',
      identity: 'assistant',
      content: 'first reply',
      createdAt: dt('2026-01-01T12:00:00Z'),
    })
    const secondAssistant = makeMessage({
      id: 'a-final',
      role: 'assistant',
      identity: 'assistant',
      content: 'final reply',
      createdAt: dt('2026-01-01T13:00:00Z'),
    })
    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        messages: [priorUser, firstAssistant, secondAssistant],
        thoughts: [goodThought, badThought],
      })
    )
    const reasoningIds = out.input
      .filter((i) => i.type === 'reasoning')
      .map((i) => (i as OpenAIResponsesReasoningItem).id)
    expect(reasoningIds).toContain('rs-multi-good')
    expect(reasoningIds).not.toContain('rs-multi-bad')
  })

  // Regression: with an EMPTY tool registry the builder returns `tools: undefined`, but the
  // adjacency sweep used to re-fingerprint against its local `[]`, while `persistThought` hashed
  // `assembled.tools ?? []`. `canonical()` emits `undefined` and `[]` as different bytes, so the
  // hashes could never agree and replay was unconditionally dead for every tool-less agent — even
  // with a byte-identical prefix. Both sides now use the `undefined`-when-empty shape.
  it('replays a reasoning item when NO tools are registered (tools: undefined vs [] must not diverge)', async () => {
    const noTools = { tools: new ToolRegistry([]) }
    const priorUser = makeMessage({
      id: 'u1-notools',
      role: 'user',
      content: 'hi',
      createdAt: dt('2026-01-01T11:59:00Z'),
    })
    const dry = await buildOpenAIResponsesInput(
      baseBuildArgs({ ...noTools, messages: [priorUser], thoughts: [], reasoningReplay: 'off' })
    )
    // Precondition: this is the empty-registry shape the bug depended on.
    expect(dry.tools).toBeUndefined()

    // Fingerprint exactly as the adapter's `persistThought` does — passing `assembled.tools`
    // straight through, with NO `?? []` coercion.
    const prefixFingerprint = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      instructions: dry.instructions,
      tools: dry.tools,
      input: dry.input,
    })

    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-notools',
      summary: [{ type: 'summary_text', text: 'thinking' }],
    }
    const thought = makeThought({
      id: 'th-notools',
      createdAt: dt('2026-01-01T12:00:00Z'),
      payload: { variant: 'responses-reasoning', item: reasoningItem, prefixFingerprint },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const trailingAssistant = makeMessage({
      id: 'a1-notools',
      role: 'assistant',
      identity: 'assistant',
      content: 'final answer',
      createdAt: dt('2026-01-01T12:01:00Z'),
    })

    const out = await buildOpenAIResponsesInput(
      baseBuildArgs({
        ...noTools,
        messages: [priorUser, trailingAssistant],
        thoughts: [thought],
      })
    )
    const idx = out.input.findIndex((i) => i.type === 'reasoning')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(out.input[idx]).toEqual(reasoningItem)
  })
})

// ─── E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED (adapter-level 400 translation) ──

interface StoredState {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
}
interface MockCtx extends DispatchContext {
  _stored: StoredState
}

const makeCtx = (
  overrides: {
    thoughts?: Thought[]
    messages?: Message[]
    standingInstructions?: Tokenizable[]
    toolCalls?: ToolCall[]
    tools?: ToolRegistry
  } = {}
): MockCtx => {
  const stored: StoredState = { messages: [], thoughts: [], toolCalls: [] }
  return {
    systemPrompt: new Tokenizable('sys'),
    turnMessages: new Set(overrides.messages ?? []),
    turnThoughts: new Set(overrides.thoughts ?? []),
    turnToolCalls: new Set(overrides.toolCalls ?? []),
    turnMemories: new Set(),
    turnRetrievables: new Set(),
    standingInstructions: new Set(overrides.standingInstructions ?? []),
    tools: overrides.tools ?? new ToolRegistry([]),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: vi.fn(),
    nack: vi.fn(),
    onAck: vi.fn((_h: () => void) => () => undefined),
    emitToolExecutionStart: vi.fn(),
    emitToolExecutionEnd: vi.fn(),
    emitMessage: vi.fn(),
    emitThought: vi.fn(),
    emitToolCall: vi.fn(),
    storeMessage: vi.fn(async (m: Message) => {
      stored.messages.push(m)
    }),
    storeThought: vi.fn(async (t: Thought) => {
      stored.thoughts.push(t)
    }),
    storeToolCall: vi.fn(async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
    }),
    mutateToolCall: vi.fn(async () => {}),
    _stored: stored,
  } as unknown as MockCtx
}

const makeHelpers = (): DispatchExecutorHelpers => {
  const noop = vi.fn()
  return {
    reportMessage: vi.fn(),
    reportThought: vi.fn(),
    reportToolCall: vi.fn(),
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
    reportGenerationStats: vi.fn(),
  } as unknown as DispatchExecutorHelpers
}

describe('OpenAIResponsesAdapter — reasoning-pairing 400 translation', () => {
  it('nacks E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED only after the reasoning-free retry ALSO 400s', async () => {
    // A pairing-violation 400 is recoverable, so the adapter first retries once with every
    // reasoning item stripped. Here the retry fails identically, which proves the rejection is not
    // attributable to reasoning replay — only then is the self-explaining error the honest answer.
    // The offending id is looked up from the adapter's OWN assembled `input`, so a dispatch with no
    // reasoning at all exercises the id-lookup fallback ('unknown').
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Item of type 'reasoning' was provided without its required following item.",
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
    )
    const adapter = new OpenAIResponsesAdapter({
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
    })
    const ctx = makeCtx({ messages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())
    // Two POSTs: the original, then the one-shot reasoning-free retry.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).toHaveBeenCalledTimes(1)
    const err = vi.mocked(ctx.nack).mock.calls[0]![0]
    expect(err).toBeInstanceOf(E_OPENAI_RESPONSES_REASONING_REPLAY_REJECTED)
    expect((err as Error).message).toContain('unknown')
  })

  it('one-time reasoning-drop retry: a PAIRING-violation 400 recovers instead of failing the turn', async () => {
    // The behavior change this test pins: a pairing 400 used to nack immediately, killing the turn.
    // Because the constraint is undocumented — and OpenAI's own docs contradict it (openai-node
    // #1791 vs. the reasoning guide's "we smartly ignore irrelevant reasoning items") — a rejection
    // must degrade to no-replay rather than fail, in case the adjacency sweep is the thing that is
    // wrong. Mirrors the invalid_encrypted_content case immediately below.
    let call = 0
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      call += 1
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      if (call === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Item 'msg_abc' of type 'message' was provided without its required preceding item of type 'reasoning'.",
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          id: 'resp-pairing-recovered',
          object: 'response',
          status: 'completed',
          model: 'gpt-x-responses',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg-ok',
              status: 'completed',
              content: [{ type: 'output_text', text: 'recovered', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-pairing',
      summary: [{ type: 'summary_text', text: 'thinking' }],
      encrypted_content: 'enc-blob',
    }
    const thought = makeThought({
      id: 'th-pairing',
      createdAt: dt('2026-01-01T11:00:00Z'),
      payload: {
        variant: 'responses-reasoning',
        item: reasoningItem,
        pairedItemId: 'prior-assistant',
        prefixFingerprint: 'irrelevant-for-this-test',
      },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    })
    const ctx = makeCtx({ thoughts: [thought], messages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('recovered')
    // The retried request must carry no reasoning items at all.
    const retriedInput = bodies[1]!.input as Array<{ type: string }>
    expect(retriedInput.some((i) => i.type === 'reasoning')).toBe(false)
  })

  it('one-time reasoning-drop retry: invalid_encrypted_content triggers a single retry with reasoning stripped', async () => {
    let call = 0
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      call += 1
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      if (call === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'invalid_encrypted_content: signature expired' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          id: 'resp-retry-ok',
          object: 'response',
          status: 'completed',
          model: 'gpt-x-responses',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              id: 'msg-ok',
              content: [{ type: 'output_text', text: 'recovered', annotations: [] }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-retry',
      summary: [{ type: 'summary_text', text: 'x' }],
    }
    const payload: OpenAIResponsesReasoningReplayPayload = {
      variant: 'responses-reasoning',
      item: reasoningItem,
      pairedItemId: 'prior-assistant',
      prefixFingerprint: 'irrelevant-for-this-test',
    }
    const thought = makeThought({
      id: 'th-retry',
      createdAt: dt('2026-01-01T11:00:00Z'),
      payload,
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    })
    const ctx = makeCtx({ thoughts: [thought], messages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages).toHaveLength(1)
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('recovered')
    // The retried request must have every reasoning item stripped.
    const retriedInput = bodies[1]!.input as Array<{ type: string }>
    expect(retriedInput.some((i) => i.type === 'reasoning')).toBe(false)
  })

  // Regression guard for a reported-and-rejected review finding: the claim was that the
  // reasoning-drop path's `continue requestLoop` "exits the bounded loop before sending the
  // rebuilt reasoning-free body", specifically once the normal retry budget is exhausted.
  //
  // It does not. `continue` re-enters the loop body WITHOUT incrementing `attempt`, so the
  // `attempt <= maxAttempts` guard still holds and the rebuilt body is always POSTed. The
  // suggested fix (`attempt = 1` before the continue) would RESET the budget, letting a 400 that
  // keeps reproducing after the reasoning drop retry without bound — strictly worse.
  //
  // This test pins the exact scenario the finding named: `maxAttempts` fully consumed by prior
  // retriable failures, THEN the reasoning-rejection 400. The rebuilt body must still go out.
  it('sends the rebuilt reasoning-free body even when the retry budget is already exhausted', async () => {
    let call = 0
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      call += 1
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      // Calls 1 and 2: retriable 503s that consume the entire maxAttempts=3 budget... almost.
      if (call <= 2) {
        return new Response(JSON.stringify({ error: { message: 'upstream unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }
      // Call 3 (attempt === maxAttempts, budget now exhausted): the reasoning rejection.
      if (call === 3) {
        return new Response(
          JSON.stringify({ error: { message: 'invalid_encrypted_content: signature expired' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }
      // Call 4: the rebuilt, reasoning-free request the finding claimed is never sent.
      return new Response(
        JSON.stringify({
          id: 'resp-budget-exhausted-ok',
          object: 'response',
          status: 'completed',
          model: 'gpt-x-responses',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg-ok',
              status: 'completed',
              content: [{ type: 'output_text', text: 'sent anyway', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const reasoningItem: OpenAIResponsesReasoningItem = {
      type: 'reasoning',
      id: 'rs-budget',
      summary: [{ type: 'summary_text', text: 'thinking' }],
      encrypted_content: 'enc-blob',
    }
    const thought = makeThought({
      id: 'th-budget',
      createdAt: dt('2026-01-01T11:00:00Z'),
      payload: {
        variant: 'responses-reasoning',
        item: reasoningItem,
        pairedItemId: 'prior-assistant',
        prefixFingerprint: 'irrelevant-for-this-test',
      },
      replayCompatibility: 'openai-responses-reasoning-v1',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
      // Minimum permitted delays (the schema requires >= 1) so the backoff sleeps are negligible.
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const ctx = makeCtx({ thoughts: [thought], messages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())

    // FOUR POSTs: 3 consumed the retry budget, the 4th is the reasoning-drop rebuild.
    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('sent anyway')
    // The 4th request is the rebuilt one, and it carries no reasoning items.
    const rebuilt = bodies[3]!.input as Array<{ type: string }>
    expect(rebuilt.some((i) => i.type === 'reasoning')).toBe(false)
    // The rebuild is a genuinely re-assembled body, not the same object resent: `buildInput(true)`
    // runs the whole assembly again with thoughts suppressed. (This fixture's stub fingerprint
    // never matches the real prefix, so the adjacency sweep already dropped the item on the way
    // out — which is why the earlier bodies carry no reasoning item either. The point being
    // pinned here is the POST COUNT: the 4th request happens at all, with an exhausted budget.)
    expect(bodies).toHaveLength(4)
  })
})

// ─── End-to-end replay through the real adapter ───────────────────────────────
//
// The helper-level tests above pin the fingerprint CONTRACT; these run two real turns through
// `OpenAIResponsesAdapter` so they also pin that the adapter actually USES it. Without the
// adapter's `throughItem: assembled.fingerprintableLength`, the trailing-bucket case below fails.

describe('OpenAIResponsesAdapter — reasoning replay survives a real two-turn round-trip', () => {
  const responseWithReasoning = (rsId: string, msgId: string) => ({
    id: `resp-${rsId}`,
    object: 'response',
    status: 'completed',
    model: 'gpt-x-responses',
    output: [
      {
        type: 'reasoning',
        id: rsId,
        summary: [{ type: 'summary_text', text: 'thinking' }],
        encrypted_content: `enc-${rsId}`,
      },
      {
        type: 'message',
        role: 'assistant',
        id: msgId,
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })

  const runTwoTurns = async (opts: {
    bucketOrder?: ChatCompletionsBucketOrder
    standingInstructions?: Tokenizable[]
  }) => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify(responseWithReasoning('rs_E2E', 'msg_E2E')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const adapterOpts = {
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted' as const,
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
      ...(opts.bucketOrder ? { bucketOrder: opts.bucketOrder } : {}),
    }
    const userMsg = makeMessage({ content: 'hi' })

    // Turn 1 — the adapter persists a Thought carrying the replay payload.
    const ctx1 = makeCtx({
      messages: [userMsg],
      ...(opts.standingInstructions ? { standingInstructions: opts.standingInstructions } : {}),
    })
    await new OpenAIResponsesAdapter(adapterOpts).executor()(ctx1, makeHelpers())
    const persisted = ctx1._stored.thoughts.find((t) => t.payload !== undefined)

    // Turn 2 — feed that Thought back; it must survive the adjacency sweep and reach the wire.
    const ctx2 = makeCtx({
      messages: [userMsg, ...ctx1._stored.messages],
      thoughts: persisted ? [persisted] : [],
      ...(opts.standingInstructions ? { standingInstructions: opts.standingInstructions } : {}),
    })
    await new OpenAIResponsesAdapter(adapterOpts).executor()(ctx2, makeHelpers())

    const turn2Input = (bodies[1]?.input ?? []) as Array<{ type?: string }>
    return { persisted, turn2Input, ctx2 }
  }

  it('replays under the DEFAULT bucket order', async () => {
    const { persisted, turn2Input, ctx2 } = await runTwoTurns({})
    expect(persisted).toBeDefined()
    expect(ctx2.nack).not.toHaveBeenCalled()
    expect(turn2Input.some((i) => i.type === 'reasoning')).toBe(true)
  })

  it('replays when a TRAILING BUCKET follows the timeline (regression: fingerprintableLength)', async () => {
    const { persisted, turn2Input, ctx2 } = await runTwoTurns({
      bucketOrder: ['timeline', 'standingInstructions'],
      standingInstructions: [new Tokenizable('ALWAYS BE CLOSING')],
    })
    expect(persisted).toBeDefined()
    expect(ctx2.nack).not.toHaveBeenCalled()
    // Without the adapter passing `throughItem: assembled.fingerprintableLength`, the persisted
    // fingerprint covers the trailing bucket, can never match the sweep's prefix, and the item is
    // dropped as stale — this assertion is what fails.
    expect(turn2Input.some((i) => i.type === 'reasoning')).toBe(true)
    // ...and the trailing bucket is genuinely present, so the scenario is real.
    const last = turn2Input[turn2Input.length - 1] as { role?: string }
    expect(last.role).toBe('system')
  })
})

// ─── Assembly invariants ───────────────────────────────────────────────────────
//
// The three load-bearing invariants documented on `buildOpenAIResponsesInput`. Each is a
// consequence of the step ORDER inside that function, each was unwritten at some point, and each
// was violated in a way that silently disabled reasoning replay. These tests assert the invariant
// DIRECTLY — independent of any one bug's reproduction — so the contract is reviewable on its own
// terms and cannot regress quietly.

describe('buildOpenAIResponsesInput — documented assembly invariants', () => {
  // INVARIANT 1: the adjacency sweep (step 3) runs BEFORE trailing buckets are appended (step 4),
  // so `fingerprintableLength` marks the sweep-visible prefix and never includes a trailing bucket.
  it('INVARIANT 1: fingerprintableLength excludes anything appended after the sweep', async () => {
    const withoutTrailing = await buildOpenAIResponsesInput(
      baseBuildArgs({ messages: [makeMessage({ content: 'hi' })], reasoningReplay: 'off' })
    )
    // No trailing bucket under the default order → the whole input is fingerprintable.
    expect(withoutTrailing.fingerprintableLength).toBe(withoutTrailing.input.length)

    const withTrailing = await buildOpenAIResponsesInput(
      baseBuildArgs({
        bucketOrder: ['timeline', 'standingInstructions'],
        standingInstructions: [new Tokenizable('TRAILING')],
        messages: [makeMessage({ content: 'hi' })],
        reasoningReplay: 'off',
      })
    )
    // A trailing bucket is appended past the fingerprintable region, never inside it.
    expect(withTrailing.fingerprintableLength).toBe(withTrailing.input.length - 1)
    const beyond = withTrailing.input[withTrailing.fingerprintableLength] as { role?: string }
    expect(beyond.role).toBe('system')
    // And it is always a SUFFIX: every item within the region is untouched by step 4.
    expect(withTrailing.input.slice(0, withTrailing.fingerprintableLength)).toEqual(
      withoutTrailing.input
    )
  })

  // INVARIANT 2: a reasoning item must sort STRICTLY BEFORE its paired output item. Messages are
  // pushed into the timeline before thoughts and stable-sorted, so an equal `createdAt` puts the
  // message first and orphans the reasoning item.
  it('INVARIANT 2: an equal createdAt orphans the reasoning item; a strictly-earlier one does not', async () => {
    const at = (iso: string) => dt(iso)
    const build = async (thoughtAt: string, messageAt: string) => {
      const reasoningItem: OpenAIResponsesReasoningItem = {
        type: 'reasoning',
        id: 'rs-tie',
        summary: [{ type: 'summary_text', text: 't' }],
      }
      const user = makeMessage({
        id: 'u',
        role: 'user',
        content: 'hi',
        createdAt: at('2026-01-01T11:00:00Z'),
      })
      const dry = await buildOpenAIResponsesInput(
        baseBuildArgs({ messages: [user], thoughts: [], reasoningReplay: 'off' })
      )
      const prefixFingerprint = await fingerprintOpenAIResponsesPrefix({
        model: 'gpt-x-responses',
        instructions: dry.instructions,
        tools: dry.tools,
        input: dry.input,
        throughItem: dry.fingerprintableLength,
      })
      const thought = makeThought({
        id: 'th-tie',
        createdAt: at(thoughtAt),
        payload: { variant: 'responses-reasoning', item: reasoningItem, prefixFingerprint },
        replayCompatibility: 'openai-responses-reasoning-v1',
      })
      const assistant = makeMessage({
        id: 'a',
        role: 'assistant',
        identity: 'assistant',
        content: 'answer',
        createdAt: at(messageAt),
      })
      const out = await buildOpenAIResponsesInput(
        baseBuildArgs({ messages: [user, assistant], thoughts: [thought] })
      )
      return out.input.map((i) => i.type ?? 'message')
    }

    // Strictly earlier → reasoning survives, immediately followed by its paired message.
    const ordered = await build('2026-01-01T12:00:00Z', '2026-01-01T12:00:01Z')
    expect(ordered).toContain('reasoning')
    expect(ordered.indexOf('reasoning')).toBeLessThan(ordered.lastIndexOf('message'))

    // Identical timestamps → the stable sort puts the message first, the item is unpaired, dropped.
    const tied = await build('2026-01-01T12:00:00Z', '2026-01-01T12:00:00Z')
    expect(tied).not.toContain('reasoning')
  })

  // INVARIANT 3: `tools` is `undefined` (never `[]`) when the registry is empty, and both the
  // persist and validate sides must fingerprint against that same shape.
  it('INVARIANT 3: an empty registry yields tools:undefined, and `[]` hashes differently', async () => {
    const empty = await buildOpenAIResponsesInput(
      baseBuildArgs({ tools: new ToolRegistry([]), reasoningReplay: 'off' })
    )
    expect(empty.tools).toBeUndefined()

    const nonEmpty = await buildOpenAIResponsesInput(baseBuildArgs({ reasoningReplay: 'off' }))
    expect(Array.isArray(nonEmpty.tools)).toBe(true)

    // The two shapes are NOT interchangeable to the fingerprint primitive — which is precisely why
    // one side coercing `?? []` broke replay for every tool-less agent.
    const asUndefined = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      tools: undefined,
      input: empty.input,
      throughItem: empty.fingerprintableLength,
    })
    const asEmptyArray = await fingerprintOpenAIResponsesPrefix({
      model: 'gpt-x-responses',
      tools: [],
      input: empty.input,
      throughItem: empty.fingerprintableLength,
    })
    expect(asUndefined).not.toBe(asEmptyArray)
  })
})

// The rebuilt request gets its OWN transport-retry budget. Plain `continue` left `attempt` where
// the failed original left it, so a reasoning rejection arriving on the LAST attempt handed the
// replacement a fully-spent budget: one transient 503 on the rebuilt request ended the turn even
// though the recovery itself had worked.
describe('OpenAIResponsesAdapter — reasoning-drop retry budget', () => {
  it('gives the rebuilt request a fresh retry budget when the 400 lands on the last attempt', async () => {
    let call = 0
    const fetchFn = vi.fn(async () => {
      call += 1
      // 1,2 consume the budget; 3 is the reasoning rejection on the LAST attempt; 4 is a transient
      // 503 on the REBUILT request; 5 succeeds — reachable only with a fresh budget.
      if (call <= 2) return new Response('busy', { status: 503 })
      if (call === 3) {
        return new Response(
          JSON.stringify({ error: { message: 'invalid_encrypted_content: expired' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }
      if (call === 4) return new Response('busy', { status: 503 })
      return new Response(
        JSON.stringify({
          id: 'resp-budget',
          object: 'response',
          status: 'completed',
          model: 'gpt-x-responses',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg-ok',
              status: 'completed',
              content: [{ type: 'output_text', text: 'recovered', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      autoAck: true,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    })
    const ctx = makeCtx({ messages: [makeMessage({ content: 'hi' })] })
    await adapter.executor()(ctx, makeHelpers())

    expect(fetchFn).toHaveBeenCalledTimes(5)
    expect(ctx.nack).not.toHaveBeenCalled()
    expect(ctx._stored.messages[0]!.content?.toString()).toBe('recovered')
  })
})

// A response can carry MORE THAN ONE reasoning item. Each item's persisted fingerprint must cover
// the prefix the next turn's adjacency sweep will actually see at that item's position — which, for
// every item after the first, includes the earlier reasoning items and their paired messages from
// the SAME response. Fingerprinting them all against the bare request prefix meant only the first
// item ever replayed; the rest were dropped as stale.
describe('OpenAIResponsesAdapter — multi-reasoning replay', () => {
  it('replays EVERY reasoning item from a response carrying two of them', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const twoReasoning = {
      id: 'r',
      object: 'response',
      status: 'completed',
      model: 'gpt-x-responses',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'a' }],
          encrypted_content: 'e1',
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          status: 'completed',
          content: [{ type: 'output_text', text: 'one', annotations: [] }],
        },
        {
          type: 'reasoning',
          id: 'rs_2',
          summary: [{ type: 'summary_text', text: 'b' }],
          encrypted_content: 'e2',
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_2',
          status: 'completed',
          content: [{ type: 'output_text', text: 'two', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify(twoReasoning), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const opts = {
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted' as const,
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    }
    const user = makeMessage({ id: 'u', content: 'hi', createdAt: dt('2026-01-01T10:00:00Z') })

    // Turn 1 — both reasoning items persist with replay payloads.
    const ctx1 = makeCtx({ messages: [user] })
    await new OpenAIResponsesAdapter(opts).executor()(ctx1, makeHelpers())
    expect(ctx1._stored.thoughts).toHaveLength(2)

    // Turn 2 — feed them back; BOTH must survive the adjacency sweep.
    const ctx2 = makeCtx({
      thoughts: ctx1._stored.thoughts,
      messages: [user, ...ctx1._stored.messages],
    })
    await new OpenAIResponsesAdapter(opts).executor()(ctx2, makeHelpers())
    const replayed = ((bodies[1]?.input ?? []) as Array<{ type?: string; id?: string }>).filter(
      (i) => i.type === 'reasoning'
    )
    expect(replayed.map((r) => r.id)).toEqual(['rs_1', 'rs_2'])
  })

  it('replays EVERY reasoning item from a STREAMED response carrying two of them', async () => {
    // Same invariant on the streaming drain, which accumulates from output-index-ordered slots
    // rather than from a response `output` array. Without the accumulator this path fingerprints
    // both items against the bare request prefix and the second is dropped as stale.
    const bodies: Array<Record<string, unknown>> = []
    const frames = buildResponsesStreamFrames({
      steps: [
        {
          kind: 'reasoning',
          outputIndex: 0,
          itemId: 'rs_1',
          summaryDeltas: ['a'],
          encryptedContent: 'e1',
        },
        { kind: 'text', outputIndex: 1, itemId: 'msg_1', deltas: ['one'] },
        {
          kind: 'reasoning',
          outputIndex: 2,
          itemId: 'rs_2',
          summaryDeltas: ['b'],
          encryptedContent: 'e2',
        },
        { kind: 'text', outputIndex: 3, itemId: 'msg_2', deltas: ['two'] },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
    const body = frames
      .map((f) => {
        const json = (f as { json?: unknown }).json
        return json === undefined ? (f as { raw: string }).raw : `data: ${JSON.stringify(json)}\n\n`
      })
      .join('')
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const opts = {
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: true,
      reasoningReplay: 'encrypted' as const,
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    }
    const user = makeMessage({ id: 'u', content: 'hi', createdAt: dt('2026-01-01T10:00:00Z') })
    const ctx1 = makeCtx({ messages: [user] })
    await new OpenAIResponsesAdapter(opts).executor()(ctx1, makeHelpers())
    expect(ctx1._stored.thoughts.length).toBeGreaterThanOrEqual(2)

    const ctx2 = makeCtx({
      thoughts: ctx1._stored.thoughts,
      messages: [user, ...ctx1._stored.messages],
    })
    await new OpenAIResponsesAdapter(opts).executor()(ctx2, makeHelpers())
    const replayed = ((bodies[1]?.input ?? []) as Array<{ type?: string }>).filter(
      (i) => i.type === 'reasoning'
    )
    expect(replayed).toHaveLength(2)
  })

  // Deliberately NOT asserting a wire ORDER for an in-response tool call. The order is decided by
  // `createdAt` stamps — the ToolCall is stamped at EXECUTION time, the response items at
  // assembly time — so under parallel suite load the sequence genuinely varies (observed both
  // `user | reasoning | message | function_call | function_call_output` and
  // `user | function_call | function_call_output | message`). An exact-sequence assertion here
  // flaked 2 runs in 3.
  //
  // What matters for the accumulator is the INVARIANT, which is timing-independent: a `ToolCall`
  // carries `createdAt === completedAt`, set when the tool ran, which is strictly after the
  // response items that requested it. That is why `function_call` items are NOT added to the
  // fingerprint prefix — they never precede the reasoning item they accompany.
  it('stamps an in-response ToolCall at execution time, strictly after the response items', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'r',
            object: 'response',
            status: 'completed',
            model: 'gpt-x-responses',
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                id: 'fc_1',
                name: 'noop_tool',
                arguments: '{}',
              },
              {
                type: 'reasoning',
                id: 'rs_after',
                summary: [{ type: 'summary_text', text: 'after the call' }],
                encrypted_content: 'e-after',
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const tool = new Tool({
      name: 'noop_tool',
      description: 'no-op',
      inputSchema: validator.object({}),
      handler: async () => 'tool-result',
    })
    const adapter = new OpenAIResponsesAdapter({
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'encrypted',
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    })
    const user = makeMessage({ id: 'u', content: 'hi', createdAt: dt('2026-01-01T10:00:00Z') })
    const ctx = makeCtx({ messages: [user], tools: new ToolRegistry([tool]) })
    await adapter.executor()(ctx, makeHelpers())

    const thought = ctx._stored.thoughts.find((t) => t.payload !== undefined)
    const call = ctx._stored.toolCalls[0]
    expect(thought).toBeDefined()
    expect(call).toBeDefined()
    // The tool call is stamped at execution time — at or after the reasoning item's stamp, never
    // before it. So it cannot belong to that item's fingerprint prefix.
    expect(call!.createdAt.toMillis()).toBeGreaterThanOrEqual(thought!.createdAt.toMillis())
    expect(call!.createdAt.toMillis()).toBe(call!.completedAt!.toMillis())
  })

  it('replays every reasoning item under summary-only, where the renderer strips fields', async () => {
    // `summary-only` strips `content`/`encrypted_content` at render time, so an accumulator that
    // recorded the FULL item hashed a prefix the sweep never reproduces and later items dropped.
    const bodies: Array<Record<string, unknown>> = []
    const two = {
      id: 'r',
      object: 'response',
      status: 'completed',
      model: 'gpt-x-responses',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'a' }],
          content: [{ type: 'reasoning_text', text: 'long-reasoning-body' }],
          encrypted_content: 'e1',
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          status: 'completed',
          content: [{ type: 'output_text', text: 'one', annotations: [] }],
        },
        {
          type: 'reasoning',
          id: 'rs_2',
          summary: [{ type: 'summary_text', text: 'b' }],
          content: [{ type: 'reasoning_text', text: 'more-reasoning' }],
          encrypted_content: 'e2',
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_2',
          status: 'completed',
          content: [{ type: 'output_text', text: 'two', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify(two), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const opts = {
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: 'summary-only' as const,
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    }
    const user = makeMessage({ id: 'u', content: 'hi', createdAt: dt('2026-01-01T10:00:00Z') })
    const ctx1 = makeCtx({ messages: [user] })
    await new OpenAIResponsesAdapter(opts).executor()(ctx1, makeHelpers())
    const ctx2 = makeCtx({
      thoughts: ctx1._stored.thoughts,
      messages: [user, ...ctx1._stored.messages],
    })
    await new OpenAIResponsesAdapter(opts).executor()(ctx2, makeHelpers())
    const replayed = ((bodies[1]?.input ?? []) as Array<{ type?: string; id?: string }>).filter(
      (i) => i.type === 'reasoning'
    )
    expect(replayed.map((r) => r.id)).toEqual(['rs_1', 'rs_2'])
    // ...and the replayed items really are summary-only (no leaked fields).
    for (const r of replayed as Array<Record<string, unknown>>) {
      expect(r.content).toBeUndefined()
      expect(r.encrypted_content).toBeUndefined()
    }
  })
})

// The invariant the review asked to see confirmed: "the persistence and replay paths must hash the
// same summary-only shape for each preceding reasoning item."
//
// Asserted end-to-end rather than by reaching into the adapter's internals, because what matters is
// the observable consequence — a later item's fingerprint is computed over the SHAPE its
// predecessor will actually replay as. Under `summary-only` the renderer strips
// `content`/`encrypted_content`, so recording the full item would make the hashes disagree and the
// later item would silently vanish.
describe('OpenAIResponsesAdapter — persist and replay hash the same summary-only shape', () => {
  const twoReasoningWithFullFields = {
    id: 'r',
    object: 'response',
    status: 'completed',
    model: 'gpt-x-responses',
    output: [
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'first-summary' }],
        // Deliberately present: these are exactly the fields summary-only strips, so if the
        // accumulator recorded them the two paths would diverge.
        content: [{ type: 'reasoning_text', text: 'FULL-REASONING-BODY-ONE' }],
        encrypted_content: 'ENCRYPTED-ONE',
      },
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_1',
        status: 'completed',
        content: [{ type: 'output_text', text: 'one', annotations: [] }],
      },
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [{ type: 'summary_text', text: 'second-summary' }],
        content: [{ type: 'reasoning_text', text: 'FULL-REASONING-BODY-TWO' }],
        encrypted_content: 'ENCRYPTED-TWO',
      },
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_2',
        status: 'completed',
        content: [{ type: 'output_text', text: 'two', annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }

  const runTwoTurns = async (mode: 'encrypted' | 'summary-only') => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify(twoReasoningWithFullFields), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const opts = {
      model: 'gpt-x-responses',
      fetch: fetchFn as never,
      stream: false,
      reasoningReplay: mode,
      replayCompatibility: ['openai-responses-reasoning-v1'],
      autoAck: true,
    }
    const user = makeMessage({ id: 'u', content: 'hi', createdAt: dt('2026-01-01T10:00:00Z') })
    const ctx1 = makeCtx({ messages: [user] })
    await new OpenAIResponsesAdapter(opts).executor()(ctx1, makeHelpers())
    const ctx2 = makeCtx({
      thoughts: ctx1._stored.thoughts,
      messages: [user, ...ctx1._stored.messages],
    })
    await new OpenAIResponsesAdapter(opts).executor()(ctx2, makeHelpers())
    return (bodies[1]?.input ?? []) as Array<Record<string, unknown>>
  }

  it('replays BOTH items under summary-only, stripped, proving the shapes agree', async () => {
    const input = await runTwoTurns('summary-only')
    const reasoning = input.filter((i) => i.type === 'reasoning')
    // Item 2 only survives if its fingerprint was taken over item 1's STRIPPED shape.
    expect(reasoning.map((r) => r.id)).toEqual(['rs_1', 'rs_2'])
    // ...and the replayed items really are stripped, i.e. the shape the sweep hashes.
    for (const r of reasoning) {
      expect(r.content).toBeUndefined()
      expect(r.encrypted_content).toBeUndefined()
      expect(r.summary).toBeDefined()
    }
  })

  it('replays BOTH items under encrypted, unstripped, proving the shape is mode-aware', async () => {
    // The mirror case: the same accumulator must record the FULL shape here, or item 2 would
    // break in the opposite direction. Pins that `replayShapeOf` tracks the mode rather than
    // being hardcoded either way.
    const input = await runTwoTurns('encrypted')
    const reasoning = input.filter((i) => i.type === 'reasoning')
    expect(reasoning.map((r) => r.id)).toEqual(['rs_1', 'rs_2'])
    expect(reasoning[0]!.encrypted_content).toBe('ENCRYPTED-ONE')
    expect(reasoning[0]!.content).toBeDefined()
  })
})
