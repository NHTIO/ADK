import { describe, expect, it } from 'vitest'
import {
  assembleCompactedTurns,
  summariseTurns,
  DEFAULT_KEEP_VERBATIM,
  DEFAULT_SUMMARY_MESSAGE_ID,
  E_CONTEXT_RESOLVER_MISSING,
  type HistoryTurn,
  type SummarizeFn,
  type EstimateTokensFn,
  type CompactionCostEvent,
} from '../../../../../src/batteries/context/compact'

/** A plain-object turn message that also carries an `id` — `HistoryTurn`/`RelevanceMessage` don't
 *  require one, but the synthetic summary message the battery emits always sets one (see
 *  `DEFAULT_SUMMARY_MESSAGE_ID`), so these tests declare their own turn messages with `id` too, for
 *  symmetric structural assertions on both the input and output turns. */
interface TestMessage {
  id: string
  role: string
  content: string
  createdAt: string
}

// STRUCTURAL checks only, per repo testing policy: a scripted SummarizeFn is not a real model, so
// this spec proves the assembly/threshold/rolling MECHANICS (who gets folded, what shape the
// synthetic summary takes, whether the prior summary is threaded through, whether cost is reported
// and no global state leaks) — it makes NO claim about summarization QUALITY. The behavioral quality
// evidence (Compact winning the reasoning-model cell 1.48 vs. thrift's 1.13, and the 128k-window
// control at 1.40 vs. 1.27, at the cost of ~80-89 summarizer calls / ~380-550k extra tokens per
// 94-turn run) comes from the head-to-head evaluation documented in this battery's barrel TSDoc
// (`src/batteries/context/compact/index.ts`), never from a unit test with a scripted executor.
//
// Deliberately NO core imports (no `Tokenizable`, `Message`, `DateTime`) and no dependency on
// thrift's `groupHistoryIntoTurns` — every turn below is a plain object satisfying the shared
// `HistoryTurn` structural shape, and the ONE capability this battery cannot perform itself
// (summarization) is a hand-scripted counting function, not a real model call.

/** A trivial, deterministic estimator standing in for the injected token-counting capability the
 *  battery requires but never bundles itself. */
const estimateTokens: EstimateTokensFn = (value) =>
  value.length === 0 ? 0 : Math.ceil(value.length / 4)

/** Builds a plain-object `HistoryTurn` with no core classes involved. Messages carry an `id` (not
 *  required by `RelevanceMessage`, but present on every real turn and on the synthetic summary
 *  message this battery emits) so tests can assert on message identity symmetrically. */
const makeTurn = (qa: string, createdAt: string): HistoryTurn<TestMessage> => ({
  qa,
  createdAt,
  messages: [{ id: createdAt, role: 'user', content: qa, createdAt }],
  toolCalls: [],
})

/** A scripted summarizer: returns a deterministic, call-counted summary and records every request it
 *  was asked to summarize, so tests can assert on exactly what text it saw (e.g. a rolling prior
 *  summary folded into the next request). */
const makeScriptedSummarizer = (): {
  summarize: SummarizeFn
  calls: Array<{ system: string; text: string }>
} => {
  const calls: Array<{ system: string; text: string }> = []
  let n = 0
  const summarize: SummarizeFn = async (req) => {
    calls.push(req)
    n += 1
    return `SUMMARY(${n})`
  }
  return { summarize, calls }
}

describe('assembleCompactedTurns — below threshold (nothing to compact yet)', () => {
  it('makes no summarize call and passes turns through unchanged when turns.length <= keepVerbatim', async () => {
    const { summarize, calls } = makeScriptedSummarizer()
    const turns = [
      makeTurn('first turn content', '2026-01-01T00:00:00Z'),
      makeTurn('second turn content', '2026-01-01T00:00:01Z'),
    ]

    const result = await assembleCompactedTurns(turns, {
      summarize,
      estimateTokens,
      keepVerbatim: DEFAULT_KEEP_VERBATIM, // 2 — exactly turns.length, so `older` is empty
    })

    expect(calls).toHaveLength(0)
    expect(result.turns).toEqual(turns)
    expect(result.summary).toBeNull()
    expect(result.coveredOlder).toBe(0)
  })
})

describe('assembleCompactedTurns — above threshold (older turns folded into a summary)', () => {
  it('folds older turns into a synthetic __compact-summary message and keeps the newest keepVerbatim turns verbatim', async () => {
    const { summarize, calls } = makeScriptedSummarizer()
    const turns = [
      makeTurn('oldest turn about deploying staging', '2026-01-01T00:00:00Z'),
      makeTurn('a middle turn about the database migration', '2026-01-01T00:00:01Z'),
      makeTurn('recent turn number one', '2026-01-01T00:00:02Z'),
      makeTurn('recent turn number two', '2026-01-01T00:00:03Z'),
    ]

    const result = await assembleCompactedTurns(turns, {
      summarize,
      estimateTokens,
      keepVerbatim: 2,
    })

    // Bootstrap summarize call (summary starts null) — fires exactly once regardless of the older
    // region's size, matching the ported `summary === null || olderTokens > threshold` condition.
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('oldest turn about deploying staging')
    expect(calls[0].text).toContain('a middle turn about the database migration')

    expect(result.turns).toHaveLength(3) // [summaryTurn, ...2 recent]
    const summaryTurn = result.turns[0]
    expect(summaryTurn.messages).toHaveLength(1)
    expect(summaryTurn.messages[0].id).toBe(DEFAULT_SUMMARY_MESSAGE_ID)
    expect(summaryTurn.messages[0].content).toContain('[Earlier conversation, compacted summary]')
    expect(summaryTurn.messages[0].content).toContain('SUMMARY(1)')
    expect(summaryTurn.qa).toBe('SUMMARY(1)')

    expect(result.turns[1]).toEqual(turns[2])
    expect(result.turns[2]).toEqual(turns[3])
    expect(result.summary).toBe('SUMMARY(1)')
    expect(result.coveredOlder).toBe(2)
  })
})

describe('assembleCompactedTurns — rolling summary', () => {
  it('folds the prior summary into the next summarize request once the older region grows past the threshold', async () => {
    const { summarize, calls } = makeScriptedSummarizer()
    const initialTurns = [
      makeTurn('oldest turn one', '2026-01-01T00:00:00Z'),
      makeTurn('recent turn one', '2026-01-01T00:00:01Z'),
      makeTurn('recent turn two', '2026-01-01T00:00:02Z'),
    ]

    const first = await assembleCompactedTurns(initialTurns, {
      summarize,
      estimateTokens,
      keepVerbatim: 2,
      summariseAtTokens: 10,
    })
    expect(calls).toHaveLength(1)
    expect(first.summary).toBe('SUMMARY(1)')
    expect(first.coveredOlder).toBe(1)

    // A new turn ages into the older region, and its text pushes the older region well past the
    // (deliberately tiny) 10-token threshold — this should trigger a SECOND summarize call, with the
    // prior summary folded into the new request text (the rolling behaviour).
    const extendedTurns = [
      ...initialTurns,
      makeTurn(
        'a brand new turn with plenty of fresh content to summarise',
        '2026-01-01T00:00:03Z'
      ),
      makeTurn('yet another recent turn', '2026-01-01T00:00:04Z'),
    ]

    const second = await assembleCompactedTurns(extendedTurns, {
      summarize,
      estimateTokens,
      keepVerbatim: 2,
      summariseAtTokens: 10,
      priorState: { summary: first.summary, coveredOlder: first.coveredOlder },
    })

    expect(calls).toHaveLength(2)
    expect(calls[1].text).toContain('PREVIOUS SUMMARY')
    expect(calls[1].text).toContain('SUMMARY(1)') // the prior summary text, folded into the new request
    expect(second.summary).toBe('SUMMARY(2)')
    // 5 turns total, keepVerbatim 2 → older.length is 3 (up from 1 in the first call).
    expect(second.coveredOlder).toBe(3)
  })
})

describe('assembleCompactedTurns / summariseTurns — onCost reporting, no globalThis pollution', () => {
  it('fires onCost with plausible estimator-measured numbers and never touches globalThis', async () => {
    const { summarize } = makeScriptedSummarizer()
    const turns = [
      makeTurn('oldest turn with some real content in it', '2026-01-01T00:00:00Z'),
      makeTurn('recent turn one', '2026-01-01T00:00:01Z'),
      makeTurn('recent turn two', '2026-01-01T00:00:02Z'),
    ]

    const events: CompactionCostEvent[] = []
    await assembleCompactedTurns(turns, {
      summarize,
      estimateTokens,
      keepVerbatim: 2,
      onCost: (event) => events.push(event),
    })

    expect(events).toHaveLength(1)
    expect(events[0].calls).toBe(1)
    expect(events[0].inTok).toBeGreaterThan(0)
    expect(events[0].outTok).toBeGreaterThan(0)

    expect(
      (globalThis as unknown as { __agentCompactionCost?: unknown }).__agentCompactionCost
    ).toBeUndefined()
  })

  it('does not fire onCost when nothing needs summarizing (below threshold)', async () => {
    const { summarize } = makeScriptedSummarizer()
    const turns = [makeTurn('only turn', '2026-01-01T00:00:00Z')]
    const events: CompactionCostEvent[] = []

    await assembleCompactedTurns(turns, {
      summarize,
      estimateTokens,
      keepVerbatim: 2,
      onCost: (event) => events.push(event),
    })

    expect(events).toHaveLength(0)
  })
})

describe('required options throw clear errors rather than silently guessing', () => {
  it('assembleCompactedTurns rejects with a typed E_CONTEXT_RESOLVER_MISSING when options.summarize is missing', async () => {
    const turns = [
      makeTurn('a', '2026-01-01T00:00:00Z'),
      makeTurn('b', '2026-01-01T00:00:01Z'),
      makeTurn('c', '2026-01-01T00:00:02Z'),
    ]
    await expect(
      assembleCompactedTurns(
        turns,
        // @ts-expect-error deliberately omitting the required summarize option to prove the guard
        { estimateTokens }
      )
    ).rejects.toThrow(E_CONTEXT_RESOLVER_MISSING)
    await expect(
      assembleCompactedTurns(
        turns,
        // @ts-expect-error deliberately omitting the required summarize option to prove the guard
        { estimateTokens }
      )
    ).rejects.toThrow(/summarize/)
  })

  it('assembleCompactedTurns rejects with a typed E_CONTEXT_RESOLVER_MISSING when options.estimateTokens is missing', async () => {
    const { summarize } = makeScriptedSummarizer()
    const turns = [
      makeTurn('a', '2026-01-01T00:00:00Z'),
      makeTurn('b', '2026-01-01T00:00:01Z'),
      makeTurn('c', '2026-01-01T00:00:02Z'),
    ]
    await expect(
      assembleCompactedTurns(
        turns,
        // @ts-expect-error deliberately omitting the required estimateTokens option to prove the guard
        { summarize }
      )
    ).rejects.toThrow(E_CONTEXT_RESOLVER_MISSING)
    await expect(
      assembleCompactedTurns(
        turns,
        // @ts-expect-error deliberately omitting the required estimateTokens option to prove the guard
        { summarize }
      )
    ).rejects.toThrow(/estimateTokens/)
  })

  it('summariseTurns rejects with a typed E_CONTEXT_RESOLVER_MISSING when options.summarize is missing', async () => {
    await expect(
      summariseTurns(
        'some history text',
        null,
        // @ts-expect-error deliberately omitting the required summarize option to prove the guard
        { estimateTokens }
      )
    ).rejects.toThrow(E_CONTEXT_RESOLVER_MISSING)
    await expect(
      summariseTurns(
        'some history text',
        null,
        // @ts-expect-error deliberately omitting the required summarize option to prove the guard
        { estimateTokens }
      )
    ).rejects.toThrow(/summarize/)
  })

  it('summariseTurns rejects with a typed E_CONTEXT_RESOLVER_MISSING when options.estimateTokens is missing', async () => {
    const { summarize } = makeScriptedSummarizer()
    await expect(
      summariseTurns(
        'some history text',
        null,
        // @ts-expect-error deliberately omitting the required estimateTokens option to prove the guard
        { summarize }
      )
    ).rejects.toThrow(E_CONTEXT_RESOLVER_MISSING)
    await expect(
      summariseTurns(
        'some history text',
        null,
        // @ts-expect-error deliberately omitting the required estimateTokens option to prove the guard
        { summarize }
      )
    ).rejects.toThrow(/estimateTokens/)
  })
})

describe('decoupling proof — compact runs against pure plain objects with a chars/4 estimator', () => {
  it('accepts plain-object turns, a scripted SummarizeFn, and a hand-rolled estimator with no core coupling', async () => {
    const { summarize } = makeScriptedSummarizer()
    const turns = [
      makeTurn('plain object turn zero', '2026-01-01T00:00:00Z'),
      makeTurn('plain object turn one', '2026-01-01T00:00:01Z'),
      makeTurn('plain object turn two', '2026-01-01T00:00:02Z'),
    ]
    const result = await assembleCompactedTurns(turns, {
      summarize,
      estimateTokens: (value) => (value.length === 0 ? 0 : Math.ceil(value.length / 4)),
      keepVerbatim: 2,
    })
    expect(result.turns.length).toBeGreaterThan(0)
    expect(result.summary).toBe('SUMMARY(1)')
  })
})
