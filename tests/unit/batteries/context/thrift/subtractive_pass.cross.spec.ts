import { describe, expect, it } from 'vitest'
import { Retrievable } from '../../../../../src/lib/classes/retrievable'
import { Tokenizable } from '../../../../../src/lib/classes/tokenizable'
import { SpooledArtifact } from '../../../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../../../src/batteries/storage/in_memory'
import { defaultRenderArtifactHandleBody } from '../../../../../src/batteries/llm/chat_common/helpers'
import {
  subtractToFit,
  DEFAULT_ENCODING,
  type WorkingSet,
  type WorkingToolCall,
  type WorkingTool,
  type WorkingToolRegistry,
  type WorkingThought,
  type WorkingRetrievable,
  type EstimateTokensFn,
} from '../../../../../src/batteries/context/thrift'

// This spec is a decoupled port of the flagship reference agent's own
// tests/unit/agent/subtractive_pass_toolcalls.cross.spec.ts,
// tests/unit/agent/subtractive_pass_ctx_measure.cross.spec.ts, and
// tests/unit/agent/subtractive_pass_shed_to_zero.cross.spec.ts specs, adapted to this battery's
// decoupled options-object API (`subtractToFit(ws, contextWindow, relevantToolNames, options)`
// instead of the production agent's positional-argument form) and its local structural contracts.
// Deliberately NO core imports (no `Tokenizable`, no `ToolRegistry`) — every working-set item below
// is a plain structural object satisfying `contracts.ts`'s `Working*` interfaces, and the ONE
// capability the battery cannot perform itself (token estimation) is injected as a plain function.
// This keeps the spec itself proof of the same zero-coupling contract the battery declares.

/**
 * A tiny, deterministic stand-in for a real tokenizer: ~4 chars/token, ceiling-rounded. It is NOT
 * meant to reproduce a real BPE tokenizer's exact counts (that's what `EstimateTokensFn` exists to
 * inject) — only to give every test in this file a stable, monotonic-in-length measurement so
 * "which bucket got shed" assertions are deterministic.
 */
const estimateTokens: EstimateTokensFn = (value) =>
  value.length === 0 ? 0 : Math.ceil(value.length / 4)
const tok = (s: string): number => estimateTokens(s, DEFAULT_ENCODING)

/** A structural tool registry test double: tracks its own hidden set exactly like a real
 *  `ToolRegistry.setHidden` (replaces the whole set on every call), and exposes the currently-visible
 *  tool names for assertions (the battery itself never calls a `visible()` method — it only ever
 *  calls `all()` and `setHidden()`). */
const makeToolRegistry = (
  names: string[]
): { registry: WorkingToolRegistry; visibleNames: () => string[] } => {
  const tools: WorkingTool[] = names.map((n) => ({
    name: n,
    description: `${n} — lorem ipsum dolor sit amet consectetur adipiscing `.repeat(60),
  }))
  let hidden = new Set<string>()
  const registry: WorkingToolRegistry = {
    all: () => tools,
    setHidden: (...hnames: string[]) => {
      hidden = new Set(hnames)
    },
  }
  return {
    registry,
    visibleNames: () => tools.filter((t) => !hidden.has(t.name)).map((t) => t.name),
  }
}

const emptyToolRegistry = (): WorkingToolRegistry => makeToolRegistry([]).registry

describe('subtractToFit — size-unknown retrievable safety', () => {
  const makeRetrievable = (body: string, inline = false, hinted = false, score = 0.99) => {
    const artifact = new SpooledArtifact(new InMemorySpoolReader(body))
    if (hinted)
      artifact._setSizeHints({ byteLength: body.length, lineCount: body.split('\\n').length })
    return new Retrievable({
      id: `ret-${hinted ? 'hinted' : 'unknown'}`,
      content: artifact,
      inline,
      score,
      trustTier: 'first-party',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
  }
  const makeWs = (retrievables: WorkingSet['retrievables']): WorkingSet => ({
    systemPrompt: 'sys',
    messages: [],
    memories: [],
    retrievables,
    thoughts: [],
    tools: emptyToolRegistry(),
  })

  it('excludes a high-score unhinted handle even with a generous budget', () => {
    const unknown = makeRetrievable('large body '.repeat(1000))
    expect(unknown.sizeUnknown).toBe(true)
    const ws = makeWs([unknown])
    const trace = subtractToFit(ws, 1_000_000, [], { estimateTokens })
    expect(ws.retrievables).toEqual([])
    expect(trace.buckets.find((b) => b.bucket === 'retrievables-size-unknown')).toMatchObject({
      beforeCount: 1,
      afterCount: 0,
    })
  })

  it('keeps an equivalently high-score hinted handle and counts its handle estimate exactly', () => {
    const body = 'large body '.repeat(1000)
    const hinted = makeRetrievable(body, false, true)
    expect(hinted.sizeUnknown).toBe(false)
    // Cross-check the pass against the actual handle renderer and the lowest-level tokenizer.
    // Deliberately do not call hinted.estimateTokens() / estimateHandleTokens(): those aggregate
    // methods are the production path whose cached-hint accounting this test verifies.
    const callId = 'ret-hinted'
    const expectedHandleBody = defaultRenderArtifactHandleBody({
      callId,
      artifact: hinted.content,
      byteLength: body.length,
      lineCount: body.split('\\n').length,
    })
    const expectedHandleTokens = Tokenizable.estimateTokens(expectedHandleBody, DEFAULT_ENCODING)
    const baseline = subtractToFit(makeWs([]), 1_000_000, [], { estimateTokens })
    const ws = makeWs([hinted])
    const trace = subtractToFit(ws, 1_000_000, [], { estimateTokens })
    expect(ws.retrievables).toHaveLength(1)
    expect(trace.totalBefore - baseline.totalBefore).toBe(expectedHandleTokens)
    expect(trace.totalBefore).toBeLessThan(estimateTokens(body, DEFAULT_ENCODING))
  })

  it('excludes before the first RAG measurement or total call', () => {
    const events: string[] = []
    const unknown = {
      ...makeRetrievable('unmeasurable '.repeat(100)),
      get sizeUnknown() {
        events.push('sizeUnknown')
        return true
      },
      estimateTokens: () => {
        events.push('estimateTokens')
        return Promise.resolve(999999)
      },
    }
    const ws = makeWs([unknown])
    subtractToFit(ws, 1_000_000, [], {
      estimateTokens: (value, encoding) => {
        events.push('estimate')
        return estimateTokens(value, encoding)
      },
    })
    expect(events).not.toContain('estimateTokens')
    expect(events.indexOf('sizeUnknown')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('sizeUnknown')).toBeLessThan(events.indexOf('estimate'))
  })

  it('distinguishes unknown-size exclusion from ordinary score shedding', () => {
    const ws = makeWs([
      makeRetrievable('unknown', false, false, 0.99),
      makeRetrievable('known', false, true, 0.1),
    ])
    const trace = subtractToFit(ws, 1, [], { estimateTokens, outputReserve: 0 })
    const unknownBucket = trace.buckets.find((b) => b.bucket === 'retrievables-size-unknown')
    const shedBucket = trace.buckets.find((b) => b.bucket === 'retrievables')

    expect(unknownBucket).toMatchObject({ beforeCount: 1, afterCount: 0, ids: ['ret-unknown'] })
    expect(shedBucket).toMatchObject({ beforeCount: 1, afterCount: 0, ids: ['ret-hinted'] })
    expect(unknownBucket?.ids).not.toContain('ret-hinted')
    expect(shedBucket?.ids).not.toContain('ret-unknown')
  })
})

describe('subtractToFit — defensive ContentLike rendering', () => {
  const ragWs = (content: WorkingRetrievable['content']): WorkingSet => ({
    systemPrompt: 'sys',
    messages: [],
    memories: [],
    retrievables: [{ id: 'render-test', content }],
    thoughts: [],
    tools: emptyToolRegistry(),
  })

  it('rejects default Object.prototype tag coercion, including non-Object tags', () => {
    expect(() =>
      subtractToFit(ragWs(new Map() as unknown as WorkingRetrievable['content']), 1000, [], {
        estimateTokens,
      })
    ).toThrow(TypeError)
  })

  it('accepts intentional custom renderers even when their text resembles an object tag', () => {
    expect(() =>
      subtractToFit(ragWs({ toString: () => '[object Map]' }), 1000, [], { estimateTokens })
    ).not.toThrow()
  })

  it('requires a renderer to return a genuine string', () => {
    const invalid = { toString: () => 42 } as unknown as WorkingRetrievable['content']
    expect(() => subtractToFit(ragWs(invalid), 1000, [], { estimateTokens })).toThrow(TypeError)
  })
})

describe('subtractToFit — the tool-calls bucket (accumulated prior-turn tool results)', () => {
  const makeWs = (toolCalls: WorkingToolCall[]): WorkingSet => ({
    systemPrompt: 'You are a helpful assistant.',
    messages: [],
    memories: [],
    retrievables: [],
    thoughts: [],
    tools: emptyToolRegistry(),
    toolCalls,
  })
  const mkCall = (id: string, tokenCost: number, createdAtMs: number): WorkingToolCall => ({
    ref: { id },
    tokenCost,
    createdAtMs,
  })
  const idsOf = (ws: WorkingSet): string[] =>
    (ws.toolCalls ?? []).map((c) => (c.ref as { id: string }).id)

  it('counts rendered tool-result weight toward the total (the undercount fix)', () => {
    const ws = makeWs([mkCall('a', 300, 1), mkCall('b', 300, 2), mkCall('c', 300, 3)])
    const trace = subtractToFit(ws, 1000, [], { estimateTokens, outputReserve: 400 })
    const tcBucket = trace.buckets.find((b) => b.bucket === 'toolCalls')
    expect(tcBucket).toBeDefined()
    expect(tcBucket?.beforeTokens).toBe(900)
    expect(tcBucket?.afterTokens).toBeLessThan(900)
    expect(trace.totalBefore).toBeGreaterThanOrEqual(900)
  })

  it('sheds OLDEST tool results first, keeping the newest', () => {
    const ws = makeWs([
      mkCall('oldest', 300, 100),
      mkCall('mid', 300, 200),
      mkCall('newest', 300, 300),
    ])
    subtractToFit(ws, 1000, [], { estimateTokens, outputReserve: 400 })
    const survivors = idsOf(ws)
    expect(survivors).not.toContain('oldest')
    expect(survivors[survivors.length - 1]).toBe('newest')
  })

  it('keeps ALL tool results when they fit within budget', () => {
    const ws = makeWs([mkCall('a', 100, 1), mkCall('b', 100, 2), mkCall('c', 100, 3)])
    const trace = subtractToFit(ws, 1000, [], { estimateTokens, outputReserve: 200 })
    expect(idsOf(ws).sort()).toEqual(['a', 'b', 'c'])
    const tcBucket = trace.buckets.find((b) => b.bucket === 'toolCalls')
    expect(tcBucket?.afterCount).toBe(3)
    expect(trace.fits).toBe(true)
  })

  it('treats a missing toolCalls field as zero weight (historical behavior preserved)', () => {
    const ws: WorkingSet = {
      systemPrompt: 'short',
      messages: [],
      memories: [],
      retrievables: [],
      thoughts: [],
      tools: emptyToolRegistry(),
      // toolCalls intentionally omitted
    }
    const trace = subtractToFit(ws, 1000, [], { estimateTokens, outputReserve: 200 })
    expect(trace.fits).toBe(true)
    expect(trace.buckets.find((b) => b.bucket === 'toolCalls')).toBeUndefined()
  })
})

describe('subtractToFit — this-turn result N-cap backstop (deep read-loop)', () => {
  const makeWs = (toolCalls: WorkingToolCall[]): WorkingSet => ({
    systemPrompt: 'You are a helpful assistant.',
    messages: [],
    memories: [],
    retrievables: [],
    thoughts: [],
    tools: emptyToolRegistry(),
    toolCalls,
  })
  const idsOf = (ws: WorkingSet): string[] =>
    (ws.toolCalls ?? []).map((c) => (c.ref as { id: string }).id)
  const mkThisTurnCall = (id: string, tokenCost: number, createdAtMs: number): WorkingToolCall => ({
    ref: { id },
    tokenCost,
    createdAtMs,
    thisTurn: true,
  })

  it('keeps the newest N this-turn results and sheds the OLDEST beyond N when over budget', () => {
    const calls = [
      mkThisTurnCall('t1-oldest', 300, 100),
      mkThisTurnCall('t2', 300, 200),
      mkThisTurnCall('t3', 300, 300),
      mkThisTurnCall('t4', 300, 400),
      mkThisTurnCall('t5', 300, 500),
      mkThisTurnCall('t6-newest', 300, 600),
    ]
    const ws = makeWs(calls)
    subtractToFit(ws, 1000, [], { estimateTokens, outputReserve: 0 })
    const survivors = idsOf(ws)
    expect(survivors).toContain('t6-newest')
    expect(survivors).toContain('t5')
    expect(survivors).toContain('t4')
    expect(survivors).not.toContain('t1-oldest')
    expect(survivors).not.toContain('t2')
    expect(survivors.length).toBeLessThanOrEqual(3)
  })

  it('never sheds this-turn results when they already fit (normal read->answer turn untouched)', () => {
    const ws = makeWs([mkThisTurnCall('search', 200, 100), mkThisTurnCall('read', 200, 200)])
    const trace = subtractToFit(ws, 2000, [], { estimateTokens, outputReserve: 200 })
    expect(idsOf(ws).sort()).toEqual(['read', 'search'])
    expect(trace.fits).toBe(true)
  })

  it('always keeps the single newest this-turn result even under extreme pressure', () => {
    const calls = Array.from({ length: 5 }, (_, i) => mkThisTurnCall(`t${i}`, 300, (i + 1) * 100))
    const ws = makeWs(calls)
    subtractToFit(ws, 500, [], { estimateTokens, outputReserve: 0 })
    const survivors = idsOf(ws)
    expect(survivors).toContain('t4') // newest (createdAtMs 500) always kept
    expect(survivors.length).toBeGreaterThanOrEqual(1)
  })
})

describe('subtractToFit — the thoughts bucket (the guidance keep-set the guard counts)', () => {
  const mkThought = (id: string, text: string, createdAtMs: number): WorkingThought => ({
    id,
    content: text,
    createdAt: { toMillis: () => createdAtMs },
  })
  // Realistic varied prose (not a repeated char, which a real BPE tokenizer would collapse to almost
  // nothing) — each is measured with the SAME estimator the pass uses, so budgets are derived, never
  // guessed.
  const para = (n: number): string =>
    `Thought #${n}: the model reasons about the user's request, considers which tool to call, and drafts a plan before answering — a distinct sentence so the tokenizer cannot collapse it. `.repeat(
      3
    )
  const oneThoughtTok = tok(para(0))
  const makeWsThoughts = (thoughts: WorkingThought[]): WorkingSet => ({
    systemPrompt: 'You are a helpful assistant.',
    messages: [],
    memories: [],
    retrievables: [],
    thoughts,
    tools: emptyToolRegistry(),
  })
  const thoughtIds = (ws: WorkingSet): string[] => ws.thoughts.map((t) => t.id)
  // budget must sit between surviveCount and surviveCount+1 thoughts (+ the tiny sys prompt slack).
  const windowForNThoughts = (surviveCount: number): number =>
    oneThoughtTok * surviveCount + Math.floor(oneThoughtTok / 2)

  it('counts surviving thoughts toward the total (the bucket thrift was blind to)', () => {
    const t = [mkThought('a', para(1), 1), mkThought('b', para(2), 2), mkThought('c', para(3), 3)]
    const ws = makeWsThoughts(t)
    const trace = subtractToFit(ws, windowForNThoughts(1), [], {
      estimateTokens,
      outputReserve: 0,
      keepThoughtIds: new Set(['a', 'b', 'c']),
    })
    const bucket = trace.buckets.find((b) => b.bucket === 'thoughts-shed')
    expect(bucket).toBeDefined()
    expect(bucket!.beforeCount).toBe(3)
    expect(bucket!.afterCount).toBeLessThan(3)
    expect(bucket!.afterTokens).toBeLessThan(bucket!.beforeTokens)
  })

  it('sheds the OLDEST sheddable thought first, always keeping the newest', () => {
    const t = [
      mkThought('oldest', para(1), 100),
      mkThought('mid', para(2), 200),
      mkThought('newest', para(3), 300),
    ]
    const ws = makeWsThoughts(t)
    subtractToFit(ws, windowForNThoughts(1), [], {
      estimateTokens,
      outputReserve: 0,
      keepThoughtIds: new Set(['oldest', 'mid', 'newest']),
    })
    const survivors = thoughtIds(ws)
    expect(survivors).not.toContain('oldest')
    expect(survivors[survivors.length - 1]).toBe('newest')
  })

  it('NEVER sheds a protected thought, even when that means staying over budget', () => {
    const t = [mkThought('__plan-thought', para(1), 1), mkThought('__cite-thought', para(2), 2)]
    const ws = makeWsThoughts(t)
    const keep = new Set(['__plan-thought', '__cite-thought'])
    const trace = subtractToFit(ws, windowForNThoughts(1), [], {
      estimateTokens,
      outputReserve: 0,
      keepThoughtIds: keep,
      protectThoughtIds: keep,
    })
    const survivors = thoughtIds(ws)
    expect(survivors).toContain('__plan-thought')
    expect(survivors).toContain('__cite-thought')
    expect(trace.refused).toBe(true) // couldn't fit, but didn't sacrifice the protected scaffolding
  })

  it('sheds stale nudge thoughts but keeps the protected plan + the newest nudge', () => {
    const t = [
      mkThought('__plan-thought', para(0), 1),
      mkThought('__nudge:a', para(1), 100),
      mkThought('__nudge:b', para(2), 200),
      mkThought('__nudge:c', para(3), 300),
    ]
    const ws = makeWsThoughts(t)
    subtractToFit(ws, windowForNThoughts(2), [], {
      estimateTokens,
      outputReserve: 0,
      keepThoughtIds: new Set(['__plan-thought', '__nudge:a', '__nudge:b', '__nudge:c']),
      protectThoughtIds: new Set(['__plan-thought']),
    })
    const survivors = thoughtIds(ws)
    expect(survivors).toContain('__plan-thought')
    expect(survivors).toContain('__nudge:c')
    expect(survivors).not.toContain('__nudge:a')
  })
})

describe('subtractToFit — standing instructions are a counted fixed cost', () => {
  it('adds standing instructions to the total (a bucket the guard counts, never shed)', () => {
    const si =
      'Standing instruction: always cite your sources when answering a factual question. '.repeat(3)
    const siTok = tok(si)
    const ws: WorkingSet = {
      systemPrompt: 'sys',
      standingInstructions: [si, si],
      messages: [],
      memories: [],
      retrievables: [],
      thoughts: [],
      tools: emptyToolRegistry(),
    }
    const trace = subtractToFit(ws, 100_000, [], { estimateTokens, outputReserve: 0 })
    expect(trace.totalBefore).toBeGreaterThanOrEqual(siTok * 2)
    expect(ws.standingInstructions).toHaveLength(2)
  })
})

// PARITY INVARIANT (ported from subtractive_pass_ctx_measure.cross.spec.ts): the pass MUST measure a
// bucket's `ContentLike` values the SAME way a caller's own overflow guard does — CTX-RESOLVED
// (`estimateTokens(enc, ctx)`), not their no-ctx `.toString()` fallback. A structural DYNAMIC
// `ContentLike` (one whose `estimateTokens` renders differently depending on whether `ctx` is
// present) expands to a LARGER string at render than its static form; measuring the static form
// under-counts, so the pass could report "fits" while a caller's own battery throws downstream on the
// ctx-resolved prompt. These tests pin that the pass counts the RESOLVED size.
describe('subtractToFit — ctx-resolved bucket measurement (battery parity)', () => {
  const BIG = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40)
  // A structural ContentLike test double whose `estimateTokens` resolves a LARGER string when handed
  // a truthy `ctx`, and whose `toString()` (no-ctx fallback) stays tiny — the exact shape the pass
  // must NOT be fooled by.
  const dynamicSystemPrompt = () => ({
    toString: () => 'SYSTEM: (static fallback)',
    estimateTokens: (_encoding: string, ctx?: unknown) =>
      tok(ctx ? `SYSTEM: ${BIG}` : 'SYSTEM: (static fallback)'),
  })
  const baseWs = (systemPrompt: ReturnType<typeof dynamicSystemPrompt>): WorkingSet => ({
    systemPrompt,
    messages: [],
    memories: [],
    retrievables: [],
    thoughts: [],
    tools: emptyToolRegistry(),
  })
  // A stand-in dispatch context: the pass only forwards it (truthiness is all that matters to this
  // test double's `estimateTokens`).
  const fakeCtx = { turn: 1 }

  it('counts a DYNAMIC system prompt at its ctx-RESOLVED size, not its static .toString()', () => {
    const sys = dynamicSystemPrompt()
    const staticTokens = tok(sys.toString())
    const resolvedTokens = sys.estimateTokens(DEFAULT_ENCODING, fakeCtx)
    expect(resolvedTokens).toBeGreaterThan(staticTokens + 50)

    const ws = baseWs(sys)
    const trace = subtractToFit(ws, 100_000, [], {
      estimateTokens,
      outputReserve: 0,
      renderCtx: fakeCtx,
    })
    expect(trace.totalAfter).toBeGreaterThanOrEqual(resolvedTokens)
    expect(trace.totalAfter).toBeGreaterThan(staticTokens + 50)
  })

  it('a dynamic system prompt that OVERFLOWS ctx-resolved refuses (would have falsely "fit" statically)', () => {
    const sys = dynamicSystemPrompt()
    const resolvedTokens = sys.estimateTokens(DEFAULT_ENCODING, fakeCtx)
    const staticTokens = tok(sys.toString())
    const window = Math.floor((staticTokens + resolvedTokens) / 2)
    expect(window).toBeGreaterThan(staticTokens)
    expect(window).toBeLessThan(resolvedTokens)

    const ws = baseWs(sys)
    const trace = subtractToFit(ws, window, [], {
      estimateTokens,
      outputReserve: 0,
      renderCtx: fakeCtx,
    })
    expect(trace.fits).toBe(false)
    expect(trace.totalAfter).toBeGreaterThan(window)
  })
})

// INVARIANT (ported from subtractive_pass_shed_to_zero.cross.spec.ts): a dispatch overflows ONLY when
// the irreducible floor (system prompt + newest turn + output reserve) alone exceeds the window —
// NEVER because a sheddable tool was left in place. The last-resort tool shed therefore drives visible
// tools toward ZERO, and protected plan tools shed LAST rather than never.
describe('subtractToFit — tools shed toward ZERO (no keep-the-last-tool floor)', () => {
  const makeWs = (toolNames: string[]): { ws: WorkingSet; visibleNames: () => string[] } => {
    const { registry, visibleNames } = makeToolRegistry(toolNames)
    const ws: WorkingSet = {
      systemPrompt: 'You are a helpful assistant.',
      messages: [],
      memories: [],
      retrievables: [],
      thoughts: [],
      tools: registry,
    }
    return { ws, visibleNames }
  }
  const sysTok = (ws: WorkingSet): number => tok(ws.systemPrompt as string)

  it('sheds EVERY visible tool when only the system-prompt floor fits', () => {
    const names = ['provide_answer', 'search_docs_semantic', 'tool_catalog', 'artifact_head']
    const { ws, visibleNames } = makeWs(names)
    const budget = sysTok(ws) + 10
    const trace = subtractToFit(ws, budget, names, { estimateTokens, outputReserve: 0 })
    expect(visibleNames()).toEqual([]) // shed to zero — not one tool left behind
    expect(trace.fits).toBe(true)
  })

  it('sheds protected plan tools LAST (kept while anything else can go, dropped when nothing else remains)', () => {
    const names = ['provide_answer', 'search_docs_semantic', 'tool_catalog']
    const { ws, visibleNames } = makeWs(names)
    const oneToolTok = tok(`${names[0]}: ${ws.tools.all()[0].description ?? ''}`)
    const budget = sysTok(ws) + oneToolTok + Math.floor(oneToolTok / 2)
    subtractToFit(ws, budget, names, {
      estimateTokens,
      outputReserve: 0,
      protectedToolNames: new Set(['provide_answer']),
    })
    const survivors = visibleNames()
    expect(survivors).toContain('provide_answer') // protected -> shed last, survived
    expect(survivors).not.toContain('search_docs_semantic')
    expect(survivors).not.toContain('tool_catalog')
  })

  it('sheds even a PROTECTED tool when the floor leaves no room for any tool at all', () => {
    const names = ['provide_answer', 'search_docs_semantic']
    const { ws, visibleNames } = makeWs(names)
    const budget = sysTok(ws) + 10 // no room for any tool, protected or not
    const trace = subtractToFit(ws, budget, names, {
      estimateTokens,
      outputReserve: 0,
      protectedToolNames: new Set(['provide_answer']),
    })
    // Protection yields to the hard floor: a degraded-but-delivered dispatch beats a forced overflow.
    expect(visibleNames()).toEqual([])
    expect(trace.fits).toBe(true)
  })
})
