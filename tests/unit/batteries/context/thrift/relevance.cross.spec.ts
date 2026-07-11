import { describe, expect, it } from 'vitest'
import {
  scaledRelevanceFloor,
  contentTokens,
  argText,
  relevanceToQuery,
  groupHistoryIntoTurns,
  selectRelevantTurns,
  selectNaiveTurns,
  RELEVANCE_FLOOR_MIN,
  RELEVANCE_FLOOR_MAX,
  RELEVANCE_FLOOR_CURVE,
  type RelevanceMessage,
  type RelevanceToolCall,
  type EstimateTokensFn,
} from '../../../../../src/batteries/context/thrift'

// Entirely new tests — no production port source exists for `relevance.ts` (it did not exist as a
// standalone module in the flagship reference agent; its logic was inlined in the agent runtime's
// history-assembly step). Deliberately NO core imports, same as the rest of this battery's test
// suite — every exercised function takes only plain strings/objects and an injected estimator.

const estimateTokens: EstimateTokensFn = (value) =>
  value.length === 0 ? 0 : Math.ceil(value.length / 4)

describe('scaledRelevanceFloor', () => {
  it('returns exactly RELEVANCE_FLOOR_MIN at zero utilization', () => {
    expect(scaledRelevanceFloor(0)).toBeCloseTo(RELEVANCE_FLOOR_MIN, 10)
  })

  it('returns exactly RELEVANCE_FLOOR_MAX at full utilization', () => {
    expect(scaledRelevanceFloor(1)).toBeCloseTo(RELEVANCE_FLOOR_MAX, 10)
  })

  it('clamps utilization below 0 to the floor minimum', () => {
    expect(scaledRelevanceFloor(-5)).toBeCloseTo(RELEVANCE_FLOOR_MIN, 10)
  })

  it('clamps utilization above 1 to the floor maximum', () => {
    expect(scaledRelevanceFloor(5)).toBeCloseTo(RELEVANCE_FLOOR_MAX, 10)
  })

  it('follows the documented convex curve: midpoint utilization scores BELOW the linear midpoint', () => {
    // A convex (power > 1) curve stays permissive longer, so at u=0.5 the value should sit below the
    // linear interpolation midpoint between MIN and MAX.
    const linearMid = (RELEVANCE_FLOOR_MIN + RELEVANCE_FLOOR_MAX) / 2
    expect(scaledRelevanceFloor(0.5)).toBeLessThan(linearMid)
    // And it should match the documented formula directly.
    const expected =
      RELEVANCE_FLOOR_MIN +
      (RELEVANCE_FLOOR_MAX - RELEVANCE_FLOOR_MIN) * Math.pow(0.5, RELEVANCE_FLOOR_CURVE)
    expect(scaledRelevanceFloor(0.5)).toBeCloseTo(expected, 10)
  })

  it('is monotonically non-decreasing as utilization rises', () => {
    let prev = scaledRelevanceFloor(0)
    for (let u = 0.1; u <= 1; u += 0.1) {
      const cur = scaledRelevanceFloor(u)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })
})

describe('contentTokens', () => {
  it('extracts lowercased alphanumeric runs of length >= 4', () => {
    const toks = contentTokens('The Quick Brown fox jumps over 123 lazy dogs')
    // "the" (3 chars) and "fox"/"over"/"123"/"dogs" — length-4-floor keeps only >=4 char runs.
    expect(toks.has('quick')).toBe(true)
    expect(toks.has('brown')).toBe(true)
    expect(toks.has('jumps')).toBe(true)
    expect(toks.has('lazy')).toBe(true) // 4 chars exactly satisfies the regex's length >= 4 total (1 + {3,}) minimum
    expect(toks.has('dogs')).toBe(true)
    expect(toks.has('the')).toBe(false) // too short
    expect(toks.has('fox')).toBe(false) // too short
  })

  it('deduplicates repeated words into a single set entry', () => {
    const toks = contentTokens('apple apple APPLE Apple')
    expect(toks.size).toBe(1)
    expect(toks.has('apple')).toBe(true)
  })

  it('returns an empty set for text with no qualifying words', () => {
    expect(contentTokens('a b c 1 2 3 ! ? .').size).toBe(0)
  })
})

describe('argText', () => {
  it('JSON-stringifies plain arguments', () => {
    expect(argText({ q: 'hello', n: 1 })).toBe(JSON.stringify({ q: 'hello', n: 1 }))
  })

  it('returns an empty string for null or undefined', () => {
    expect(argText(null)).toBe('')
    expect(argText(undefined)).toBe('')
  })

  it('truncates to at most 200 characters', () => {
    const big = { text: 'x'.repeat(500) }
    const out = argText(big)
    expect(out.length).toBeLessThanOrEqual(200)
  })

  it('returns an empty string for unserializable (circular) input rather than throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => argText(circular)).not.toThrow()
    expect(argText(circular)).toBe('')
  })
})

describe('relevanceToQuery', () => {
  it('scores 0 for an empty query token set', () => {
    expect(relevanceToQuery('anything goes here', new Set())).toBe(0)
  })

  it('scores 1 when every query token is present in the text', () => {
    const query = contentTokens('deploy staging database')
    expect(relevanceToQuery('we need to deploy the staging database tonight', query)).toBe(1)
  })

  it('scores a fraction when only some query tokens are present', () => {
    const query = contentTokens('deploy staging database')
    // Only "deploy" appears; 1 of 3 query tokens shared.
    const score = relevanceToQuery('please deploy the frontend', query)
    expect(score).toBeCloseTo(1 / 3, 10)
  })

  it('scores 0 when nothing overlaps', () => {
    const query = contentTokens('deploy staging database')
    expect(relevanceToQuery('completely unrelated sentence about cats', query)).toBe(0)
  })
})

describe('groupHistoryIntoTurns', () => {
  const msg = (role: string, content: string, createdAt: string): RelevanceMessage => ({
    role,
    content,
    createdAt,
  })
  const call = (createdAt: string, tool?: string, args?: unknown): RelevanceToolCall => ({
    createdAt,
    tool,
    args,
  })

  it('groups a user message through the next assistant message into one turn', () => {
    const messages = [
      msg('user', 'what is the weather', '2026-01-01T00:00:00Z'),
      msg('assistant', 'it is sunny', '2026-01-01T00:00:01Z'),
    ]
    const turns = groupHistoryIntoTurns(messages, [])
    expect(turns).toHaveLength(1)
    expect(turns[0].messages).toHaveLength(2)
    expect(turns[0].qa).toContain('what is the weather')
    expect(turns[0].qa).toContain('it is sunny')
    expect(turns[0].createdAt).toBe('2026-01-01T00:00:01Z')
  })

  it('starts a new turn after each assistant message closes the prior one', () => {
    const messages = [
      msg('user', 'first question', '2026-01-01T00:00:00Z'),
      msg('assistant', 'first answer', '2026-01-01T00:00:01Z'),
      msg('user', 'second question', '2026-01-01T00:00:02Z'),
      msg('assistant', 'second answer', '2026-01-01T00:00:03Z'),
    ]
    const turns = groupHistoryIntoTurns(messages, [])
    expect(turns).toHaveLength(2)
    expect(turns[0].qa).toContain('first question')
    expect(turns[1].qa).toContain('second question')
  })

  it('attributes tool calls to the turn whose first message precedes the call timestamp', () => {
    const messages = [
      msg('user', 'search for docs', '2026-01-01T00:00:00Z'),
      msg('assistant', 'here is what I found', '2026-01-01T00:00:05Z'),
      msg('user', 'now search for something else', '2026-01-01T00:00:10Z'),
      msg('assistant', 'found that too', '2026-01-01T00:00:15Z'),
    ]
    const toolCalls = [
      call('2026-01-01T00:00:02Z', 'search_docs', { q: 'docs' }),
      call('2026-01-01T00:00:12Z', 'search_docs', { q: 'else' }),
    ]
    const turns = groupHistoryIntoTurns(messages, toolCalls)
    expect(turns).toHaveLength(2)
    expect(turns[0].toolCalls).toHaveLength(1)
    expect(turns[0].toolCalls[0].args).toEqual({ q: 'docs' })
    expect(turns[1].toolCalls).toHaveLength(1)
    expect(turns[1].toolCalls[0].args).toEqual({ q: 'else' })
    // The tool name + args fold into the turn's qa text.
    expect(turns[0].qa).toContain('search_docs')
  })

  it('handles an empty history', () => {
    expect(groupHistoryIntoTurns([], [])).toEqual([])
  })

  it('a call with no tool name does not pollute qa text but is still attributed', () => {
    const messages = [
      msg('user', 'do a thing', '2026-01-01T00:00:00Z'),
      msg('assistant', 'done', '2026-01-01T00:00:01Z'),
    ]
    const toolCalls = [call('2026-01-01T00:00:00Z', undefined, { x: 1 })]
    const turns = groupHistoryIntoTurns(messages, toolCalls)
    expect(turns[0].toolCalls).toHaveLength(1)
    expect(turns[0].qa).not.toContain('undefined')
  })
})

describe('selectRelevantTurns', () => {
  const msg = (role: string, content: string, createdAt: string): RelevanceMessage => ({
    role,
    content,
    createdAt,
  })
  const makeTurn = (qa: string, createdAt: string) => ({
    qa,
    createdAt,
    messages: [msg('user', qa, createdAt)],
    toolCalls: [],
  })

  it('always keeps the most recent `keepRecent` turns regardless of relevance', () => {
    const turns = [
      makeTurn('completely irrelevant chatter about the weather', '2026-01-01T00:00:00Z'),
      makeTurn('another irrelevant aside about lunch', '2026-01-01T00:00:01Z'),
      makeTurn('most recent turn also irrelevant to the query', '2026-01-01T00:00:02Z'),
    ]
    const selected = selectRelevantTurns(turns, 'deploy staging database', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1000,
    })
    // Only the last turn is guaranteed kept by keepRecent; the other two share no overlap with the
    // query and a nonzero floor, so they should be dropped.
    expect(selected).toHaveLength(1)
    expect(selected[0].createdAt).toBe('2026-01-01T00:00:02Z')
  })

  it('keeps an older turn that is lexically relevant to the query, beyond keepRecent', () => {
    const turns = [
      makeTurn('we discussed deploying the staging database last week', '2026-01-01T00:00:00Z'),
      makeTurn('completely unrelated chat about lunch plans', '2026-01-01T00:00:01Z'),
      makeTurn('most recent turn, also unrelated', '2026-01-01T00:00:02Z'),
    ]
    const selected = selectRelevantTurns(turns, 'deploy staging database', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1000,
    })
    const createdAts = selected.map((t) => t.createdAt)
    expect(createdAts).toContain('2026-01-01T00:00:00Z') // relevant, survives despite being old
    expect(createdAts).toContain('2026-01-01T00:00:02Z') // kept via keepRecent
    expect(createdAts).not.toContain('2026-01-01T00:00:01Z') // irrelevant, dropped
  })

  it('preserves original chronological order among survivors', () => {
    const turns = [
      makeTurn('deploy staging database turn A', '2026-01-01T00:00:00Z'),
      makeTurn('deploy staging database turn B', '2026-01-01T00:00:01Z'),
      makeTurn(
        'deploy staging database turn C (newest, kept via keepRecent)',
        '2026-01-01T00:00:02Z'
      ),
    ]
    const selected = selectRelevantTurns(turns, 'deploy staging database', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1000,
    })
    const createdAts = selected.map((t) => t.createdAt)
    const sorted = [...createdAts].sort()
    expect(createdAts).toEqual(sorted)
  })

  it('applies a stricter floor as utilization rises (fewer weakly-relevant turns survive)', () => {
    const turns = [
      makeTurn(
        'deploy mentioned once among other words entirely off topic here',
        '2026-01-01T00:00:00Z'
      ),
      makeTurn('newest turn, always kept', '2026-01-01T00:00:01Z'),
    ]
    // Weak overlap: only "deploy" from the query appears. At near-zero utilization (huge budget) the
    // permissive floor should keep it; at near-total utilization (tiny budget) the strict floor should
    // drop it.
    const permissive = selectRelevantTurns(turns, 'deploy staging database rollback plan', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1_000_000,
    })
    const strict = selectRelevantTurns(turns, 'deploy staging database rollback plan', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1, // tiny budget -> utilization saturates toward 1 immediately
    })
    expect(permissive.map((t) => t.createdAt)).toContain('2026-01-01T00:00:00Z')
    expect(strict.map((t) => t.createdAt)).not.toContain('2026-01-01T00:00:00Z')
  })

  it('accepts explicit floorMin/floorMax/floorCurve overrides', () => {
    const turns = [
      makeTurn('barely overlaps with the query at all here', '2026-01-01T00:00:00Z'),
      makeTurn('newest turn', '2026-01-01T00:00:01Z'),
    ]
    // floorMin: 0 makes even a zero-overlap turn survive at zero utilization.
    const selected = selectRelevantTurns(turns, 'something entirely different', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1000,
      floorMin: 0,
      floorMax: 0,
      floorCurve: 1,
    })
    expect(selected).toHaveLength(2)
  })

  it('walks the ENTIRE history with no turn-count cap', () => {
    const turns = Array.from({ length: 50 }, (_, i) =>
      i === 0
        ? makeTurn(
            'deploy staging database — the one relevant turn, far in the past',
            '2026-01-01T00:00:00Z'
          )
        : makeTurn(
            `irrelevant filler turn number ${i}`,
            `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`
          )
    )
    const selected = selectRelevantTurns(turns, 'deploy staging database', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 100_000,
    })
    expect(selected.map((t) => t.createdAt)).toContain('2026-01-01T00:00:00Z')
  })
})

describe('selectNaiveTurns', () => {
  const makeTurn = (qa: string, createdAt: string) => ({
    qa,
    createdAt,
    messages: [],
    toolCalls: [],
  })

  it('keeps the newest turns and drops the oldest once the budget is exhausted', () => {
    const turns = [
      makeTurn('x'.repeat(40), '2026-01-01T00:00:00Z'), // oldest
      makeTurn('x'.repeat(40), '2026-01-01T00:00:01Z'),
      makeTurn('x'.repeat(40), '2026-01-01T00:00:02Z'), // newest
    ]
    // Each turn costs ceil(40/4) = 10 tokens. Budget for ~2 turns.
    const kept = selectNaiveTurns(turns, 20, { estimateTokens })
    const createdAts = kept.map((t) => t.createdAt)
    expect(createdAts).toContain('2026-01-01T00:00:02Z')
    expect(createdAts).not.toContain('2026-01-01T00:00:00Z')
  })

  it('always keeps the single newest turn even if it alone exceeds the budget', () => {
    const turns = [makeTurn('x'.repeat(4000), '2026-01-01T00:00:00Z')]
    const kept = selectNaiveTurns(turns, 1, { estimateTokens })
    expect(kept).toHaveLength(1)
  })

  it('preserves chronological order among survivors', () => {
    const turns = [
      makeTurn('x'.repeat(20), '2026-01-01T00:00:00Z'),
      makeTurn('x'.repeat(20), '2026-01-01T00:00:01Z'),
      makeTurn('x'.repeat(20), '2026-01-01T00:00:02Z'),
    ]
    const kept = selectNaiveTurns(turns, 1000, { estimateTokens })
    const createdAts = kept.map((t) => t.createdAt)
    expect(createdAts).toEqual([...createdAts].sort())
  })

  it('returns an empty array for an empty history', () => {
    expect(selectNaiveTurns([], 1000, { estimateTokens })).toEqual([])
  })
})
