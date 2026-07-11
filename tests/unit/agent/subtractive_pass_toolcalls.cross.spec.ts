import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { ToolRegistry } from '../../../src/lib/classes/tool_registry'
import { initAgentRuntime } from '../../../docs/.vitepress/theme/components/agent/agent_adk'
import {
  subtractToFit,
  type WorkingSet,
  type WorkingToolCall,
} from '../../../docs/.vitepress/theme/components/agent/agent_subtractive_pass'
import {
  subtractToFit as batterySubtractToFit,
  resolveBudget as batteryResolveBudget,
  stripPriorTurnThoughts as batteryStripPriorTurnThoughts,
} from '../../../src/batteries/context/thrift'

// The subtractive-pass wrapper (agent_subtractive_pass.ts) now DELEGATES to the shipped battery via the
// agent_adk shim — the mocked bundle must hand back the real battery functions too, or the shim's
// subtractToFit/resolveBudget/stripPriorTurnThoughts holders stay undefined. ES `import` declarations are
// hoisted regardless of textual position, and vitest additionally hoists this `vi.mock(...)` call above every
// import in the file — so placing it after the import block (to satisfy this file's import-length/type
// ordering lint rule without an autofixer deleting it) does not change evaluation order.
vi.mock('../../../docs/.vitepress/theme/components/quickstart_demo_runtime', () => ({
  loadAdkRuntimeBundle: async () => ({
    Tokenizable,
    ToolRegistry,
    subtractToFit: batterySubtractToFit,
    resolveBudget: batteryResolveBudget,
    stripPriorTurnThoughts: batteryStripPriorTurnThoughts,
  }),
}))

beforeAll(async () => {
  // Populate agent_adk's runtime holders (Tokenizable) from the mocked bundle.
  await initAgentRuntime()
})

// A minimal WorkingSet: system prompt only, no messages/RAG/memories/thoughts/tools/image. This isolates
// the tool-calls bucket — the historically-UNMEASURED accumulated tool RESULTS (search blobs, artifact
// handles) that pushed the battery's true prompt past the armed overflow guard while the pass meter,
// blind to them, still read "fits" (see memory: executor_error_cause_preservation, fix 2).
const makeWs = (toolCalls: WorkingToolCall[]): WorkingSet => ({
  systemPrompt: new Tokenizable('You are a helpful assistant.'),
  messages: [],
  memories: [],
  retrievables: [],
  thoughts: [],
  tools: new ToolRegistry(),
  toolCalls,
})

// Marker objects so we can assert WHICH calls survived by identity (ref) rather than by index.
const mkCall = (id: string, tokenCost: number, createdAtMs: number): WorkingToolCall => ({
  ref: { id },
  tokenCost,
  createdAtMs,
})
const idsOf = (ws: WorkingSet): string[] =>
  (ws.toolCalls ?? []).map((c) => (c.ref as { id: string }).id)

describe('subtractToFit — the tool-calls bucket (accumulated prior-turn tool results)', () => {
  it('counts rendered tool-result weight toward the total (the undercount fix)', () => {
    // budget = window - reserve = 1000 - 400 = 600. System prompt is a handful of tokens; three 300-token
    // results = 900 > 600, so the total MUST reflect the tool-result weight and the pass must shed.
    const ws = makeWs([mkCall('a', 300, 1), mkCall('b', 300, 2), mkCall('c', 300, 3)])
    const trace = subtractToFit(ws, 1000, [], 400)
    const tcBucket = trace.buckets.find((b) => b.bucket === 'toolCalls')
    expect(tcBucket).toBeDefined()
    // Before the shed the bucket weighed the full 900; after, it is under what it started at.
    expect(tcBucket?.beforeTokens).toBe(900)
    expect(tcBucket?.afterTokens).toBeLessThan(900)
    expect(trace.totalBefore).toBeGreaterThanOrEqual(900)
  })

  it('sheds OLDEST tool results first, keeping the newest', () => {
    // Force shedding: budget 600, three 300-tok results → the oldest go first, newest survives.
    const ws = makeWs([
      mkCall('oldest', 300, 100),
      mkCall('mid', 300, 200),
      mkCall('newest', 300, 300),
    ])
    subtractToFit(ws, 1000, [], 400)
    const survivors = idsOf(ws)
    expect(survivors).not.toContain('oldest')
    expect(survivors[survivors.length - 1]).toBe('newest')
  })

  it('keeps ALL tool results when they fit within budget', () => {
    // budget = 1000 - 200 = 800; three 100-tok results = 300, well under. Nothing shed.
    const ws = makeWs([mkCall('a', 100, 1), mkCall('b', 100, 2), mkCall('c', 100, 3)])
    const trace = subtractToFit(ws, 1000, [], 200)
    expect(idsOf(ws).sort()).toEqual(['a', 'b', 'c'])
    const tcBucket = trace.buckets.find((b) => b.bucket === 'toolCalls')
    expect(tcBucket?.afterCount).toBe(3)
    expect(trace.fits).toBe(true)
  })

  it('treats a missing toolCalls field as zero weight (historical behavior preserved)', () => {
    const ws: WorkingSet = {
      systemPrompt: new Tokenizable('short'),
      messages: [],
      memories: [],
      retrievables: [],
      thoughts: [],
      tools: new ToolRegistry(),
      // toolCalls intentionally omitted
    }
    const trace = subtractToFit(ws, 1000, [], 200)
    expect(trace.fits).toBe(true)
    // No toolCalls bucket is emitted when there are none to weigh.
    expect(trace.buckets.find((b) => b.bucket === 'toolCalls')).toBeUndefined()
  })
})

// A this-turn tool result (thisTurn:true). These are protected from the ordinary prior-turn shed (evicting
// one the model just fetched → the 25× re-search loop), but a DEEP read-loop accumulates many, and their
// combined body can exceed the whole window. The N-cap backstop keeps only the newest N and sheds the OLDEST
// beyond N; an explicitly RELEASED result arrives as thisTurn:false and sheds normally.
const mkThisTurnCall = (id: string, tokenCost: number, createdAtMs: number): WorkingToolCall => ({
  ref: { id },
  tokenCost,
  createdAtMs,
  thisTurn: true,
})

describe('subtractToFit — this-turn result N-cap backstop (deep read-loop)', () => {
  it('keeps the newest N this-turn results and sheds the OLDEST beyond N when over budget', () => {
    // N=3 (THIS_TURN_RESULT_KEEP). Six 300-tok this-turn results = 1800; budget 900 (window 1000 − reserve
    // 100... use outputReserve to size). Force shedding down toward the 3-newest keep floor.
    const calls = [
      mkThisTurnCall('t1-oldest', 300, 100),
      mkThisTurnCall('t2', 300, 200),
      mkThisTurnCall('t3', 300, 300),
      mkThisTurnCall('t4', 300, 400),
      mkThisTurnCall('t5', 300, 500),
      mkThisTurnCall('t6-newest', 300, 600),
    ]
    const ws = makeWs(calls)
    // budget = 1000 − 0 = 1000 → holds ~3 results (900) + tiny sys. Oldest shed until fits.
    subtractToFit(ws, 1000, [], 0)
    const survivors = idsOf(ws)
    // The newest N (3) are always kept; the oldest are shed first.
    expect(survivors).toContain('t6-newest')
    expect(survivors).toContain('t5')
    expect(survivors).toContain('t4')
    expect(survivors).not.toContain('t1-oldest')
    expect(survivors).not.toContain('t2')
    // Never fewer than the keep floor while it still doesn't fit is bounded by budget; here it lands at 3.
    expect(survivors.length).toBeLessThanOrEqual(3)
  })

  it('never sheds this-turn results when they already fit (normal read→answer turn untouched)', () => {
    // Two this-turn results (a search + a read), well under budget → both kept, no N-cap action.
    const ws = makeWs([mkThisTurnCall('search', 200, 100), mkThisTurnCall('read', 200, 200)])
    const trace = subtractToFit(ws, 2000, [], 200)
    expect(idsOf(ws).sort()).toEqual(['read', 'search'])
    expect(trace.fits).toBe(true)
  })

  it('always keeps the single newest this-turn result even under extreme pressure', () => {
    // Budget fits ~1 result; many this-turn results → shed down to the newest, never zero this-turn.
    const calls = Array.from({ length: 5 }, (_, i) => mkThisTurnCall(`t${i}`, 300, (i + 1) * 100))
    const ws = makeWs(calls)
    subtractToFit(ws, 500, [], 0)
    const survivors = idsOf(ws)
    expect(survivors).toContain('t4') // newest (createdAtMs 500) always kept
    expect(survivors.length).toBeGreaterThanOrEqual(1)
  })
})

// A structural Thought stand-in: the pass touches `id`, `content` (as a Tokenizable — it calls
// `content.estimateTokens(ENCODING, renderCtx)` for the live per-dispatch count, and `content.toString()`),
// and `createdAt.toMillis()`. Use a REAL Tokenizable for content so estimateTokens exists and matches the
// pass's own measurement. Cast through unknown (like WorkingToolCall.ref) so we don't construct a full
// Thought (identity/DateTime) for a token-accounting test.
const mkThought = (id: string, text: string, createdAtMs: number): unknown => ({
  id,
  content: new Tokenizable(text),
  createdAt: { toMillis: () => createdAtMs },
})
// Realistic varied prose (not a repeated char, which BPE collapses to almost nothing). Each ~parasize is
// measured with the SAME estimator the pass uses ('gemma'), so budgets are derived, never guessed.
const para = (n: number): string =>
  `Thought #${n}: the model reasons about the user's request, considers which tool to call, and drafts a plan before answering — a distinct sentence so the tokenizer cannot collapse it. `.repeat(
    3
  )
const tokOf = (s: string): number => Tokenizable.estimateTokens(s, 'gemma')
const oneThoughtTok = tokOf(para(0)) // measured cost of one thought body

const makeWsThoughts = (thoughts: unknown[]): WorkingSet => ({
  systemPrompt: new Tokenizable('You are a helpful assistant.'),
  messages: [],
  memories: [],
  retrievables: [],
  thoughts: thoughts as never,
  tools: new ToolRegistry(),
})
const thoughtIds = (ws: WorkingSet): string[] =>
  (ws.thoughts as unknown as Array<{ id: string }>).map((t) => t.id)

// Window big enough that ONLY the thoughts bucket can push it over — budget = window (no reserve) minus a
// hair, so a working set of N thoughts is over by ~(N-1) thoughts and the shed must fire. Derived from the
// measured per-thought cost, never a guessed constant.
const windowForNThoughts = (surviveCount: number): number => {
  // budget must sit between surviveCount and surviveCount+1 thoughts (+ the tiny sys prompt slack).
  const budget = oneThoughtTok * surviveCount + Math.floor(oneThoughtTok / 2)
  return budget // outputReserve=0 → budget === window
}

describe('subtractToFit — the thoughts bucket (the guidance keep-set the guard counts)', () => {
  it('counts surviving thoughts toward the total (the bucket thrift was blind to)', () => {
    // WITH keepThoughtIds the thoughts survive the §3 strip and MUST show up in the total. A budget sized
    // to hold ~1 thought, given 3, forces a shed — which can only happen if they are counted.
    const t = [mkThought('a', para(1), 1), mkThought('b', para(2), 2), mkThought('c', para(3), 3)]
    const ws = makeWsThoughts(t)
    const trace = subtractToFit(ws, windowForNThoughts(1), [], 0, new Set(['a', 'b', 'c']))
    const bucket = trace.buckets.find((b) => b.bucket === 'thoughts-shed')
    expect(bucket).toBeDefined()
    expect(bucket!.beforeCount).toBe(3)
    // Over budget on thoughts alone → the pass sheds down toward the ~1-thought budget.
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
    subtractToFit(ws, windowForNThoughts(1), [], 0, new Set(['oldest', 'mid', 'newest'])) // all sheddable
    const survivors = thoughtIds(ws)
    expect(survivors).not.toContain('oldest')
    expect(survivors[survivors.length - 1]).toBe('newest')
  })

  it('NEVER sheds a protected thought, even when that means staying over budget', () => {
    // Two protected plan/cite thoughts against a budget that fits ~1 — the shed must leave BOTH in place
    // (thrift declines to trade away the scaffolding the worker needs; a bounded over-budget beats
    // dropping the plan). Result stays over budget → refused, but the protected thoughts survive.
    const t = [mkThought('__plan-thought', para(1), 1), mkThought('__cite-thought', para(2), 2)]
    const ws = makeWsThoughts(t)
    const keep = new Set(['__plan-thought', '__cite-thought'])
    const protect = new Set(['__plan-thought', '__cite-thought'])
    const trace = subtractToFit(ws, windowForNThoughts(1), [], 0, keep, undefined, protect)
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
    const keep = new Set(['__plan-thought', '__nudge:a', '__nudge:b', '__nudge:c'])
    const protect = new Set(['__plan-thought'])
    // Budget fits the plan + ~1 nudge → the oldest nudge(s) shed, newest nudge + plan stay.
    subtractToFit(ws, windowForNThoughts(2), [], 0, keep, undefined, protect)
    const survivors = thoughtIds(ws)
    expect(survivors).toContain('__plan-thought')
    expect(survivors).toContain('__nudge:c')
    expect(survivors).not.toContain('__nudge:a')
  })
})

describe('subtractToFit — standing instructions are a counted fixed cost', () => {
  it('adds standing instructions to the total (a bucket the guard counts, never shed)', () => {
    const si = para(1)
    const siTok = tokOf(si)
    const ws: WorkingSet = {
      systemPrompt: new Tokenizable('sys'),
      standingInstructions: [new Tokenizable(si), new Tokenizable(si)],
      messages: [],
      memories: [],
      retrievables: [],
      thoughts: [],
      tools: new ToolRegistry(),
    }
    const trace = subtractToFit(ws, 100_000, [], 0)
    // Both standing instructions must be reflected in totalBefore (not silently dropped).
    expect(trace.totalBefore).toBeGreaterThanOrEqual(siTok * 2)
    // Standing instructions are never shed — they remain on the working set.
    expect(ws.standingInstructions).toHaveLength(2)
  })
})
