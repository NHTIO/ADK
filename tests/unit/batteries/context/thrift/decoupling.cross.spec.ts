import { describe, expect, it } from 'vitest'
import {
  subtractToFit,
  stripPriorTurnThoughts,
  resolveBudget,
  selectRelevantTurns,
  selectNaiveTurns,
  groupHistoryIntoTurns,
  E_CONTEXT_RESOLVER_MISSING,
  type WorkingSet,
  type WorkingToolRegistry,
  type EstimateTokensFn,
} from '../../../../../src/batteries/context/thrift'

// This spec is the ZERO-COUPLING PROOF for the Token Thrift battery: it exercises every public entry
// point using ONLY plain JavaScript objects/strings and a hand-rolled estimator function — never a
// core `@nhtio/adk` class (no `Tokenizable`, `ToolRegistry`, `Tool`, `Message`, `Memory`,
// `Retrievable`, `Thought`, or `DateTime`). If this file compiles and passes without ever importing
// anything from `../../../../../src/lib/**` or `@nhtio/adk`, the battery's "surface, don't impose"
// duck-typing contract is proven, not just asserted in TSDoc.
//
// A `grep -rn "from '" tests/unit/batteries/context/thrift/decoupling.cross.spec.ts` against this
// file should show exactly one import statement, resolving only into this battery's own barrel and
// `vitest` — nothing from core.

/** A trivial, deterministic estimator standing in for the injected token-counting capability the
 *  battery requires but never bundles itself. */
const estimateTokens: EstimateTokensFn = (value) =>
  value.length === 0 ? 0 : Math.ceil(value.length / 4)

/** A minimal plain-object tool registry — no core `ToolRegistry` class anywhere in sight. */
const plainToolRegistry = (names: string[]): WorkingToolRegistry => {
  const tools = names.map((n) => ({ name: n, description: `${n} tool description text here` }))
  return {
    all: () => tools,
    setHidden: (..._n: string[]) => {
      // This decoupling proof doesn't assert on tool visibility (see subtractive_pass.cross.spec.ts
      // for that), so this test double only needs to satisfy the WorkingToolRegistry shape.
    },
  }
}

describe('decoupling proof — subtractToFit runs against pure plain objects', () => {
  it('accepts a WorkingSet built entirely from plain strings/objects with no core classes involved', () => {
    const ws: WorkingSet = {
      systemPrompt: 'You are a plain-object assistant.',
      standingInstructions: ['Always be concise.'],
      messages: [
        { id: 'm1', content: 'hello there', createdAt: { toMillis: () => 1 } },
        { id: 'm2', content: 'how can I help', createdAt: { toMillis: () => 2 } },
      ],
      memories: [{ content: 'user prefers metric units', importance: 0.5 }],
      retrievables: [{ content: 'a retrieved passage of text', score: 0.9 }],
      thoughts: [
        {
          id: '__plan-thought',
          content: 'plan: answer directly',
          createdAt: { toMillis: () => 3 },
        },
      ],
      tools: plainToolRegistry(['provide_answer', 'search_docs']),
      toolCalls: [{ ref: { id: 'call-1' }, tokenCost: 12, createdAtMs: 4 }],
      image: { label: 'screenshot.png', tokenCost: 500 },
    }

    const trace = subtractToFit(ws, 10_000, ['provide_answer', 'search_docs'], {
      estimateTokens,
      keepThoughtIds: new Set(['__plan-thought']),
      protectThoughtIds: new Set(['__plan-thought']),
    })

    expect(trace.fits).toBe(true)
    expect(trace.totalAfter).toBeGreaterThan(0)
    expect(trace.buckets.length).toBeGreaterThan(0)
    // The plain-object working set was mutated in place, exactly as the contract documents.
    expect(ws.messages).toHaveLength(2)
    expect(ws.thoughts.map((t) => t.id)).toContain('__plan-thought')
  })

  it('throws a typed E_CONTEXT_RESOLVER_MISSING when estimateTokens is omitted rather than silently guessing', () => {
    const ws: WorkingSet = {
      systemPrompt: 'sys',
      messages: [],
      memories: [],
      retrievables: [],
      thoughts: [],
      tools: plainToolRegistry([]),
    }
    expect(() =>
      // @ts-expect-error deliberately omitting the required estimateTokens option to prove the guard
      subtractToFit(ws, 1000, [], {})
    ).toThrow(E_CONTEXT_RESOLVER_MISSING)
    try {
      // @ts-expect-error deliberately omitting the required estimateTokens option to prove the guard
      subtractToFit(ws, 1000, [], {})
    } catch (err) {
      expect(err).toBeInstanceOf(E_CONTEXT_RESOLVER_MISSING)
      expect((err as InstanceType<typeof E_CONTEXT_RESOLVER_MISSING>).message).toMatch(
        /estimateTokens/
      )
    }
  })

  it('stripPriorTurnThoughts operates on a plain { thoughts } object with no core Thought class', () => {
    const ws = {
      thoughts: [
        { id: 'a', content: 'prior turn reasoning', createdAt: { toMillis: () => 1 } },
        { id: '__plan-thought', content: 'this turn plan', createdAt: { toMillis: () => 2 } },
      ],
    }
    const result = stripPriorTurnThoughts(ws, { estimateTokens }, new Set(['__plan-thought']))
    expect(result.dropped).toBe(1)
    expect(ws.thoughts.map((t) => t.id)).toEqual(['__plan-thought'])
  })

  it('resolveBudget is a pure numeric function with no object dependencies at all', () => {
    expect(resolveBudget(4096, 1024)).toBe(3072)
    expect(resolveBudget(1_000_000)).toBe(Math.floor(1_000_000 * 0.65))
    expect(resolveBudget(100, 1000)).toBe(0) // reserve clamped to the window; nothing left
  })
})

describe('decoupling proof — relevance selection runs against pure plain objects', () => {
  it('groups and selects turns from plain { role, content, createdAt } messages only', () => {
    const messages = [
      {
        role: 'user',
        content: 'please deploy the staging database',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        role: 'assistant',
        content: 'deployed staging database successfully',
        createdAt: '2026-01-01T00:00:01Z',
      },
      {
        role: 'user',
        content: 'totally unrelated request about lunch',
        createdAt: '2026-01-01T00:00:02Z',
      },
      { role: 'assistant', content: 'sure, lunch it is', createdAt: '2026-01-01T00:00:03Z' },
      { role: 'user', content: 'newest turn kept regardless', createdAt: '2026-01-01T00:00:04Z' },
      { role: 'assistant', content: 'ok', createdAt: '2026-01-01T00:00:05Z' },
    ]
    const turns = groupHistoryIntoTurns(messages, [])
    expect(turns).toHaveLength(3)

    const selected = selectRelevantTurns(turns, 'deploy staging database', {
      estimateTokens,
      keepRecent: 1,
      historyBudget: 1000,
    })
    const contents = selected.flatMap((t) => t.messages.map((m) => m.content))
    expect(contents.join(' ')).toContain('deploy the staging database')
    expect(selected.map((t) => t.createdAt)).toContain('2026-01-01T00:00:05Z')
  })

  it('selectNaiveTurns also runs against the same plain grouped turns with no core coupling', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(40), createdAt: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'b'.repeat(40), createdAt: '2026-01-01T00:00:01Z' },
      { role: 'user', content: 'c'.repeat(40), createdAt: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: 'd'.repeat(40), createdAt: '2026-01-01T00:00:03Z' },
    ]
    const turns = groupHistoryIntoTurns(messages, [])
    const kept = selectNaiveTurns(turns, 25, { estimateTokens })
    expect(kept.length).toBeGreaterThan(0)
    expect(kept[kept.length - 1].createdAt).toBe('2026-01-01T00:00:03Z')
  })
})
