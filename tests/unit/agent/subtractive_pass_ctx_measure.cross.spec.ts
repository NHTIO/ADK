import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { ToolRegistry } from '../../../src/lib/classes/tool_registry'
import { initAgentRuntime } from '../../../docs/.vitepress/theme/components/agent/agent_adk'
import {
  subtractToFit,
  type WorkingSet,
} from '../../../docs/.vitepress/theme/components/agent/agent_subtractive_pass'
import {
  subtractToFit as batterySubtractToFit,
  resolveBudget as batteryResolveBudget,
  stripPriorTurnThoughts as batteryStripPriorTurnThoughts,
} from '../../../src/batteries/context/thrift'

// The subtractive-pass wrapper (agent_subtractive_pass.ts) now DELEGATES to the shipped battery via the
// agent_adk shim — the mocked bundle must hand back the real battery functions too, or the shim's
// subtractToFit/resolveBudget/stripPriorTurnThoughts holders stay undefined. ES `import` declarations are
// hoisted by the engine regardless of textual position, and vitest additionally hoists this `vi.mock(...)`
// call above every import in the file — so placing it after the import block (to satisfy this file's
// import-length/type ordering lint rule without an autofixer deleting it) does not change evaluation order.
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
  await initAgentRuntime()
})

// PARITY INVARIANT (browser LiteRT bug, /tmp/browser_t1.jsonl): the pass MUST measure a bucket's
// Tokenizables the SAME way the battery's overflow guard does — CTX-RESOLVED (`estimateTokens(enc, ctx)`),
// not their no-ctx `.toString()` fallback. An EVALUATABLE Tokenizable (the flagship system prompt
// interpolates against ctx) expands to a LARGER string at render than its static form; measuring the static
// form under-counts, so the pass reported "fits" while the battery threw E_LITERT_LM_CONTEXT_OVERFLOW on the
// ctx-resolved prompt. These tests pin that the pass now counts the RESOLVED size.

// A dynamic system prompt: tiny without ctx, large WITH ctx (simulates ctx-interpolated content).
const BIG = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(40)
const dynamicSystemPrompt = (): Tokenizable =>
  new Tokenizable((ctx) => (ctx ? `SYSTEM: ${BIG}` : 'SYSTEM: (static fallback)'))

const emptyTools = (): ToolRegistry => new ToolRegistry([])

const baseWs = (systemPrompt: Tokenizable): WorkingSet => ({
  systemPrompt,
  messages: [],
  memories: [],
  retrievables: [],
  thoughts: [],
  tools: emptyTools(),
})

// A stand-in DispatchContext: the evaluator only checks truthiness of `ctx`, so any object works. The pass
// forwards it as `renderCtx` to estimateTokens(enc, ctx).
const fakeCtx = {} as never

describe('subtractToFit — ctx-resolved bucket measurement (battery parity)', () => {
  it('counts a DYNAMIC system prompt at its ctx-RESOLVED size, not its static .toString()', () => {
    const sys = dynamicSystemPrompt()
    const staticTokens = Tokenizable.estimateTokens(sys.toString(), 'gemma') // no-ctx (small)
    const resolvedTokens = sys.estimateTokens('gemma', fakeCtx) // ctx-resolved (large) — what the battery counts
    expect(resolvedTokens).toBeGreaterThan(staticTokens + 50) // the gap the pass used to miss

    const ws = baseWs(sys)
    // Generous budget so nothing sheds — we only care about the reported total.
    const trace = subtractToFit(
      ws,
      100_000, // window
      [], // no tools
      0, // no output reserve
      undefined,
      undefined,
      undefined,
      fakeCtx // renderCtx — the ctx the evaluator resolves against
    )
    // The pass's total must reflect the RESOLVED system prompt (matches the battery guard), not the static one.
    expect(trace.totalAfter).toBeGreaterThanOrEqual(resolvedTokens)
    // And it must be materially larger than what the OLD static measurement would have reported.
    expect(trace.totalAfter).toBeGreaterThan(staticTokens + 50)
  })

  it('a dynamic system prompt that OVERFLOWS ctx-resolved refuses (would have falsely "fit" statically)', () => {
    const sys = dynamicSystemPrompt()
    const resolvedTokens = sys.estimateTokens('gemma', fakeCtx)
    const staticTokens = Tokenizable.estimateTokens(sys.toString(), 'gemma')
    // Window sits BETWEEN the static (small) and resolved (large) sizes: the old static measure would say
    // "fits", the correct ctx-resolved measure must say it does NOT (the exact browser false-fit).
    const window = Math.floor((staticTokens + resolvedTokens) / 2)
    expect(window).toBeGreaterThan(staticTokens)
    expect(window).toBeLessThan(resolvedTokens)

    const ws = baseWs(sys)
    const trace = subtractToFit(ws, window, [], 0, undefined, undefined, undefined, fakeCtx)
    // Nothing sheddable (no tools/RAG/history) + the resolved system floor exceeds the window → honest refusal.
    expect(trace.fits).toBe(false)
    expect(trace.totalAfter).toBeGreaterThan(window)
  })
})
