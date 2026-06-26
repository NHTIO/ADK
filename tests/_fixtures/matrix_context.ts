/**
 * Shared, ENVIRONMENT-NEUTRAL mock DispatchContext + helpers for the real-model matrix. Lifted out of
 * the per-battery gated specs so the Node runner AND the browser WebGPU harness drive entries through
 * ONE definition (no `vitest`/`vi`, no `node:*` — plain capturing functions so it imports in a browser
 * bundle).
 *
 * - {@link registerTools} compiles a {@link MatrixEntry}'s `tools` into a real {@link ToolRegistry} of
 *   benign echo tools (a fired call lands harmlessly in `stored.toolCalls`).
 * - {@link makeMatrixContext} builds the `_stored`-capturing duck-typed DispatchContext seeded with the
 *   entry's prompt (+ optional decoded media attachments).
 * - {@link makeMatrixHelpers} is the vi-free `DispatchExecutorHelpers`.
 * - {@link assertMatrixOutcome} returns a list of failure strings (NEVER throws) per the entry's
 *   `expect`; on a total tool/parse miss it includes the raw last assistant message — the discovery.
 */

import { DateTime } from 'luxon'
import { isError } from '@nhtio/adk/guards'
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
  Registry,
  Media,
  inMemoryMediaReader,
} from '@nhtio/adk/common'
import type { DispatchContext } from '@nhtio/adk/types'
import type { DispatchExecutorHelpers } from '@nhtio/adk/dispatch_runner'
import type { MatrixEntry, MatrixTool, MatrixScenario } from './model_matrix'

/** Captured side effects from a dispatch turn. */
export interface MatrixStored {
  messages: Message[]
  thoughts: Thought[]
  toolCalls: ToolCall[]
  /** Raw reported message deltas, concatenated per stream id (for the streaming pass). */
  reportedText: string
}

const jsonTypeToSchema = (t: 'string' | 'number' | 'boolean') =>
  t === 'number' ? validator.number() : t === 'boolean' ? validator.boolean() : validator.string()

/** Compile a {@link MatrixTool} into a benign echo {@link Tool} (handler returns `'OK'`). */
export const matrixTool = (t: MatrixTool): Tool => {
  const shape: Record<string, ReturnType<typeof jsonTypeToSchema>> = {}
  for (const [k, ty] of Object.entries(t.params ?? {})) shape[k] = jsonTypeToSchema(ty)
  return new Tool({
    name: t.name,
    description: t.description,
    inputSchema: validator.object(shape),
    handler: () => 'OK',
  })
}

/** Build a {@link ToolRegistry} from an entry's tools (empty registry when it has none). */
export const registerTools = (entry: MatrixEntry): ToolRegistry =>
  new ToolRegistry((entry.tools ?? []).map(matrixTool))

/** Decode an entry's media attachments into ADK {@link Media} (bytes provided by the caller). */
export const buildAttachments = (
  entry: MatrixEntry,
  bytesFor: (fixturePath: string) => Uint8Array
): Media[] =>
  (entry.attachments ?? []).map((a, i) =>
    Media.userAttachment({
      id: `mm-${i}`,
      kind: a.kind,
      mimeType: a.mimeType,
      filename: a.fixturePath.split('/').pop() ?? `attachment-${i}`,
      reader: inMemoryMediaReader(bytesFor(a.fixturePath)),
    })
  )

/**
 * Build the capturing mock DispatchContext for an entry.
 *
 * @param entry - The matrix entry (supplies prompt, system prompt, tools).
 * @param attachments - Pre-decoded media for multimodal entries (use {@link buildAttachments}).
 */
export const makeMatrixContext = (
  entry: MatrixEntry,
  attachments: Media[] = []
): { ctx: DispatchContext & { _stored: MatrixStored }; stored: MatrixStored } => {
  const stored: MatrixStored = { messages: [], thoughts: [], toolCalls: [], reportedText: '' }
  const createdAt = DateTime.fromISO('2026-01-01T12:00:00Z', { zone: 'utc' })
  const userMsg = new Message({
    id: 'u-1',
    role: 'user',
    content: entry.prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt,
    updatedAt: createdAt,
  })
  const ctx = {
    systemPrompt: new Tokenizable(entry.systemPrompt ?? 'You are a concise, helpful assistant.'),
    turnMessages: new Set([userMsg]),
    turnThoughts: new Set<Thought>(),
    turnToolCalls: new Set<ToolCall>(),
    turnMemories: new Set<Memory>(),
    turnRetrievables: new Set<Retrievable>(),
    standingInstructions: new Set<Tokenizable>(),
    tools: registerTools(entry),
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: () => undefined,
    nack: (err?: unknown) => {
      // Surface the nack reason into a synthetic message so assertMatrixOutcome can report it.
      stored.messages.push(
        new Message({
          id: 'nack',
          role: 'assistant',
          content: `__NACK__: ${isError(err) ? err.message : String(err)}`,
          createdAt,
          updatedAt: createdAt,
        })
      )
    },
    onAck: () => () => undefined,
    emitToolExecutionStart: () => undefined,
    emitToolExecutionEnd: () => undefined,
    emitMessage: () => undefined,
    emitThought: () => undefined,
    emitToolCall: () => undefined,
    storeMessage: async (m: Message) => {
      stored.messages.push(m)
    },
    storeThought: async (t: Thought) => {
      stored.thoughts.push(t)
    },
    storeToolCall: async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
    },
    mutateToolCall: async () => undefined,
    storeMediaBytes: async (_id: string, bytes: Uint8Array) => inMemoryMediaReader(bytes),
    _stored: stored,
  } as unknown as DispatchContext & { _stored: MatrixStored }
  return { ctx, stored }
}

/** Build the vi-free {@link DispatchExecutorHelpers}, capturing reported message text into `stored`. */
export const makeMatrixHelpers = (stored: MatrixStored): DispatchExecutorHelpers => {
  const noop = () => undefined
  return {
    reportMessage: (_id: string, delta: string) => {
      if (typeof delta === 'string') stored.reportedText += delta
    },
    reportThought: noop,
    reportToolCall: noop,
    reportGenerationStats: noop,
    log: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
  } as unknown as DispatchExecutorHelpers
}

const lastAssistantText = (stored: MatrixStored): string => {
  for (let i = stored.messages.length - 1; i >= 0; i--) {
    if (stored.messages[i]?.role === 'assistant')
      return stored.messages[i]?.content?.toString() ?? ''
  }
  return ''
}

/**
 * Check an entry's `expect` against the captured state. Returns a list of failure strings (empty =
 * pass). NEVER throws — on a total miss it appends the raw last assistant message so the matrix run
 * surfaces what the model ACTUALLY emitted (the whole point of the real-model proof).
 *
 * @param entry - The matrix entry whose `expect` to check.
 * @param stored - The captured dispatch state.
 */
export const assertMatrixOutcome = (entry: MatrixEntry, stored: MatrixStored): string[] => {
  const failures: string[] = []
  const exp = entry.expect
  const prose = lastAssistantText(stored)

  // Probe entries (expectBrowserLoadProbe) record a RUNTIME failure as DATA, not a hard fail. A model
  // whose graph throws DURING generation surfaces a `__NACK__: …` message (caught in dispatch) rather
  // than a thrown loadError, so the runner's load-probe escape never sees it — handle it here too: a
  // NACK-only outcome on a probe entry is informational (e.g. the upstream Qwen2.5-VL q4f16 tensor bug).
  if (entry.expectBrowserLoadProbe && /^__NACK__:/.test(prose.trim())) {
    return []
  }

  if (exp.nonEmptyProse) {
    const proseEmpty = prose.replace(/^__NACK__:.*/, '').trim().length === 0
    // A turn that fired a tool call legitimately leaves prose empty (the call IS the output). For a
    // tool-capable entry, a fired call satisfies "the turn produced something" — only a true empty/NACK
    // outcome with no tool call fails. (A `__NACK__` is an error and never has tool calls.)
    if (proseEmpty && stored.toolCalls.length === 0) {
      failures.push(
        `expected non-empty prose or a tool call; got: ${JSON.stringify(prose).slice(0, 200)}`
      )
    }
  }

  if (exp.nonEmptyReasoning) {
    const reasoningLen = stored.thoughts.reduce((n, t) => n + t.content.toString().trim().length, 0)
    if (reasoningLen === 0) {
      failures.push(
        `expected non-empty reasoning; got ${stored.thoughts.length} thoughts, last message: ${JSON.stringify(prose).slice(0, 200)}`
      )
    }
  }

  if (exp.proseMatchesAny && exp.proseMatchesAny.length > 0) {
    const low = prose.toLowerCase()
    if (!exp.proseMatchesAny.some((s) => low.includes(s.toLowerCase()))) {
      failures.push(
        `prose matched none of [${exp.proseMatchesAny.join(', ')}]; got: ${JSON.stringify(prose).slice(0, 200)}`
      )
    }
  }

  if (exp.reasoningContains && exp.reasoningContains.length > 0) {
    const allReasoning = stored.thoughts.map((t) => t.content.toString().toLowerCase()).join('\n')
    for (const needle of exp.reasoningContains) {
      if (!allReasoning.includes(needle.toLowerCase())) {
        failures.push(`reasoning missing "${needle}" (${stored.thoughts.length} thoughts captured)`)
      }
    }
  }

  if (exp.toolCall) {
    const match = stored.toolCalls.find((tc) => tc.tool === exp.toolCall?.name)
    if (!match) {
      const names = stored.toolCalls.map((tc) => tc.tool)
      failures.push(
        `expected tool call "${exp.toolCall.name}"; got calls [${names.join(', ')}]; last message: ${JSON.stringify(prose).slice(0, 200)}`
      )
    } else if (exp.toolCall.argKeys) {
      const have = Object.keys((match.args ?? {}) as Record<string, unknown>)
      const missing = exp.toolCall.argKeys.filter((k) => !have.includes(k))
      if (missing.length > 0) failures.push(`tool call missing arg keys [${missing.join(', ')}]`)
    }
  }

  return failures
}

// ─── Scenario cross-product context + assertions (the DEEP matrix) ──────────────────────────────────
//
// The single-prompt `makeMatrixContext`/`assertMatrixOutcome` above remain for the smoke pass. The
// helpers below drive one {@link MatrixScenario} (multi-turn, scenario-owned tools, optional seeded
// prior tool round) and assert the scenario's behaviour. The runner pairs these with the per-scenario
// generation overrides it spreads onto the adapter options.

/** Build the capturing mock DispatchContext for ONE scenario (multi-turn + scenario tools + media). */
export const makeScenarioContext = (
  entry: MatrixEntry,
  scenario: MatrixScenario,
  attachments: Media[] = []
): { ctx: DispatchContext & { _stored: MatrixStored }; stored: MatrixStored } => {
  const stored: MatrixStored = { messages: [], thoughts: [], toolCalls: [], reportedText: '' }
  const createdAt = DateTime.fromISO('2026-01-01T12:00:00Z', { zone: 'utc' })

  // Scenario tools win over the entry's own (so a scenario can register get_time for multi-tool); fall
  // back to the entry tools when the scenario declares none.
  const toolList = scenario.tools ?? entry.tools ?? []
  const tools = new ToolRegistry(toolList.map(matrixTool))

  // The LAST turn is the live user message (carries any media). Earlier turns + a seeded prior tool
  // round become prior timeline state the adapter renders as history.
  const turnMessages = new Set<Message>()
  const turnToolCalls = new Set<ToolCall>()
  let clock = createdAt
  const tick = (): DateTime => (clock = clock.plus({ seconds: 1 }))

  scenario.turns.forEach((turn, i) => {
    const isLast = i === scenario.turns.length - 1
    // A turn carrying `priorToolResult` seeds: a user ask + a COMPLETED tool call (with its result) so
    // the model sees a finished tool round and must follow up. The tool call is added to turnToolCalls.
    if (turn.priorToolResult) {
      const at = tick()
      turnToolCalls.add(
        new ToolCall({
          id: `seed-tc-${i}`,
          tool: turn.priorToolResult.tool,
          args: turn.priorToolResult.args as Record<string, unknown>,
          checksum: `seed-nonce-${i}`,
          isComplete: true,
          isError: false,
          results: new Tokenizable(turn.priorToolResult.result),
          fromArtifactTool: false,
          createdAt: at,
          updatedAt: at,
          completedAt: at,
        })
      )
    }
    const at = tick()
    turnMessages.add(
      new Message({
        id: `u-${i}`,
        role: 'user',
        content: turn.prompt,
        ...(isLast && attachments.length > 0 ? { attachments } : {}),
        createdAt: at,
        updatedAt: at,
      })
    )
  })

  const ctx = {
    systemPrompt: new Tokenizable(
      scenario.systemPrompt ?? entry.systemPrompt ?? 'You are a concise, helpful assistant.'
    ),
    turnMessages,
    turnThoughts: new Set<Thought>(),
    turnToolCalls,
    turnMemories: new Set<Memory>(),
    turnRetrievables: new Set<Retrievable>(),
    standingInstructions: new Set<Tokenizable>(),
    tools,
    stash: new Registry({}),
    abortSignal: new AbortController().signal,
    ack: () => undefined,
    nack: (err?: unknown) => {
      stored.messages.push(
        new Message({
          id: 'nack',
          role: 'assistant',
          content: `__NACK__: ${isError(err) ? err.message : String(err)}`,
          createdAt,
          updatedAt: createdAt,
        })
      )
    },
    onAck: () => () => undefined,
    emitToolExecutionStart: () => undefined,
    emitToolExecutionEnd: () => undefined,
    emitMessage: () => undefined,
    emitThought: () => undefined,
    emitToolCall: () => undefined,
    storeMessage: async (m: Message) => {
      stored.messages.push(m)
    },
    storeThought: async (t: Thought) => {
      stored.thoughts.push(t)
    },
    storeToolCall: async (tc: ToolCall) => {
      stored.toolCalls.push(tc)
    },
    mutateToolCall: async () => undefined,
    storeMediaBytes: async (_id: string, bytes: Uint8Array) => inMemoryMediaReader(bytes),
    _stored: stored,
  } as unknown as DispatchContext & { _stored: MatrixStored }
  return { ctx, stored }
}

/** The newest STORED assistant message (the model's own output, not a seeded prior turn). */
const finalAssistantText = (stored: MatrixStored): string => {
  for (let i = stored.messages.length - 1; i >= 0; i--) {
    if (stored.messages[i]?.role === 'assistant')
      return stored.messages[i]?.content?.toString() ?? ''
  }
  return ''
}

/**
 * Check a scenario's `expect` against the captured state. Returns failure strings (empty = pass); never
 * throws. Probe entries whose run NACKs are informational (same rule as the smoke assert).
 */
export const assertScenarioOutcome = (
  entry: MatrixEntry,
  scenario: MatrixScenario,
  stored: MatrixStored
): string[] => {
  const failures: string[] = []
  const exp = scenario.expect
  const prose = finalAssistantText(stored)
  const cleanProse = prose.replace(/^__NACK__:.*/, '').trim()
  const isNack = /^__NACK__:/.test(prose.trim())

  if (entry.expectBrowserLoadProbe && isNack) return []

  if (exp.toolCall) {
    const match = stored.toolCalls.find((tc) => tc.tool === exp.toolCall?.name)
    if (!match) {
      failures.push(
        `expected tool call "${exp.toolCall.name}"; got [${stored.toolCalls.map((t) => t.tool).join(', ')}]; msg: ${JSON.stringify(prose).slice(0, 160)}`
      )
    } else if (exp.toolCall.argKeys) {
      const have = Object.keys((match.args ?? {}) as Record<string, unknown>)
      const missing = exp.toolCall.argKeys.filter((k) => !have.includes(k))
      if (missing.length > 0) failures.push(`tool call missing arg keys [${missing.join(', ')}]`)
    }
  }

  if (exp.minToolCalls !== undefined && stored.toolCalls.length < exp.minToolCalls) {
    // Always surface the raw model output on a miss — "got 0" alone hides WHETHER the model emitted
    // nothing, prose, or a malformed/unparsed call. The raw message is the finding.
    failures.push(
      `expected >= ${exp.minToolCalls} tool calls; got ${stored.toolCalls.length} [${stored.toolCalls.map((t) => t.tool).join(', ')}]; raw msg: ${JSON.stringify(prose).slice(0, 400)}`
    )
  }

  if (exp.noToolCalls && stored.toolCalls.length > 0) {
    failures.push(
      `expected NO tool calls; got [${stored.toolCalls.map((t) => t.tool).join(', ')}] (spurious call)`
    )
  }

  if (exp.nonEmptyProse && cleanProse.length === 0 && stored.toolCalls.length === 0) {
    failures.push(`expected non-empty prose; got: ${JSON.stringify(prose).slice(0, 160)}`)
  }

  if (exp.proseMatchesAny && exp.proseMatchesAny.length > 0) {
    const low = cleanProse.toLowerCase()
    if (!exp.proseMatchesAny.some((s) => low.includes(s.toLowerCase()))) {
      failures.push(
        `prose matched none of [${exp.proseMatchesAny.join(', ')}]; got: ${JSON.stringify(prose).slice(0, 160)}`
      )
    }
  }

  if (exp.nonEmptyReasoning) {
    const len = stored.thoughts.reduce((n, t) => n + t.content.toString().trim().length, 0)
    if (len === 0)
      failures.push(`expected non-empty reasoning; got ${stored.thoughts.length} thoughts`)
  }

  if (exp.noReasoningLeak) {
    // The honest thinking-off contract: we DON'T require the model to have produced zero reasoning
    // (some think regardless; that Thought is surfaced faithfully). We require only that raw
    // reasoning MARKUP never bleeds into the visible answer text.
    if (/<\/?think(?:ing)?>/i.test(cleanProse) || /<\|channel|<\|message\|>/.test(cleanProse)) {
      failures.push(
        `reasoning markup leaked into visible prose: ${JSON.stringify(prose).slice(0, 160)}`
      )
    }
  }

  if (exp.producedOutput) {
    const produced =
      stored.toolCalls.length > 0 ||
      stored.thoughts.length > 0 ||
      (!isNack && cleanProse.length > 0)
    if (!produced)
      failures.push(
        `expected SOME output (call/thought/prose); got: ${JSON.stringify(prose).slice(0, 160)}`
      )
  }

  if (exp.streamedDeltasMatchFinal) {
    const streamed = stored.reportedText.trim()
    if (streamed.length === 0) {
      failures.push('expected streamed deltas; none were reported')
    } else if (
      cleanProse.length > 0 &&
      !streamed.includes(cleanProse.slice(0, 24)) &&
      !cleanProse.includes(streamed.slice(0, 24))
    ) {
      // Lenient: streamed prose may be pre-parser (still carries markup) while final is cleaned, so we
      // assert overlap on a leading window rather than strict equality.
      failures.push(
        `streamed deltas diverge from final prose; streamed: ${JSON.stringify(streamed).slice(0, 120)} final: ${JSON.stringify(cleanProse).slice(0, 120)}`
      )
    }
  }

  return failures
}
