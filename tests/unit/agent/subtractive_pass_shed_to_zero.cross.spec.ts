import { validator } from '@nhtio/validation'
import { Tool } from '../../../src/lib/classes/tool'
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

// The subtractive pass reads ADK symbols (Tokenizable/ToolRegistry) from the docs `agent_adk` barrel, whose
// value holders are populated at runtime from the precompiled repl bundle via initAgentRuntime() — NEVER
// from @nhtio/adk source (see sibling cross specs). In a unit test there is no precompiled bundle, so mock
// the bundle loader to hand back the REAL src classes. The subtractive-pass wrapper now DELEGATES its
// algorithm to the shipped battery, so the mocked bundle must ALSO hand back the real battery functions. ES
// `import` declarations are hoisted regardless of textual position, and vitest additionally hoists this
// `vi.mock(...)` call above every import in the file — so placing it after the import block (to satisfy this
// file's import-length/type ordering lint rule without an autofixer deleting it) does not change evaluation
// order.
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

// INVARIANT (per the user): a dispatch overflows ONLY when the irreducible floor (system prompt + newest
// turn + output reserve) alone exceeds the window — NEVER because a sheddable tool was left in place. The
// last-resort tool shed therefore drives visible tools toward ZERO, and protected plan tools shed LAST
// rather than never. These tests pin that: no artificial "keep the last tool" floor.

const mkTool = (name: string, descWords = 60): Tool =>
  new Tool({
    name,
    description: `${name} — ${'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(descWords)}`,
    inputSchema: validator.object({ q: validator.string().required() }),
    handler: () => 'ok',
  })

const makeWs = (tools: Tool[]): WorkingSet => ({
  systemPrompt: new Tokenizable('You are a helpful assistant.'),
  messages: [],
  memories: [],
  retrievables: [],
  thoughts: [],
  tools: new ToolRegistry(tools),
})

const visibleNames = (ws: WorkingSet): string[] => ws.tools.visible().map((t) => t.name)
const sysTok = (ws: WorkingSet): number =>
  Tokenizable.estimateTokens(ws.systemPrompt.toString(), 'gemma')

describe('subtractToFit — tools shed toward ZERO (no keep-the-last-tool floor)', () => {
  it('sheds EVERY visible tool when only the system-prompt floor fits', () => {
    const tools = ['provide_answer', 'search_docs_semantic', 'tool_catalog', 'artifact_head'].map(
      (n) => mkTool(n)
    )
    const ws = makeWs(tools)
    // Budget = just the system prompt + a sliver: no room for ANY tool. The shed must empty the visible set.
    const budget = sysTok(ws) + 10
    const trace = subtractToFit(
      ws,
      budget,
      tools.map((t) => t.name),
      0
    )
    expect(visibleNames(ws)).toEqual([]) // shed to zero — not one tool left behind
    // fits is true because the floor (sys prompt) is under budget once tools are gone.
    expect(trace.fits).toBe(true)
  })

  it('sheds protected plan tools LAST (kept while anything else can go, dropped when nothing else remains)', () => {
    const tools = ['provide_answer', 'search_docs_semantic', 'tool_catalog'].map((n) => mkTool(n))
    const ws = makeWs(tools)
    const oneToolTok = Tokenizable.estimateTokens(
      `${tools[0].name}: ${tools[0].description}`,
      'gemma'
    )
    // Budget fits sys + ~1 tool. Protect provide_answer: the two non-protected tools shed first; the
    // protected one survives because the dispatch now fits with just it.
    const budget = sysTok(ws) + oneToolTok + Math.floor(oneToolTok / 2)
    subtractToFit(
      ws,
      budget,
      tools.map((t) => t.name),
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['provide_answer'])
    )
    const survivors = visibleNames(ws)
    expect(survivors).toContain('provide_answer') // protected → shed last, survived
    expect(survivors).not.toContain('search_docs_semantic')
    expect(survivors).not.toContain('tool_catalog')
  })

  it('sheds even a PROTECTED tool when the floor leaves no room for any tool at all', () => {
    const tools = ['provide_answer', 'search_docs_semantic'].map((n) => mkTool(n))
    const ws = makeWs(tools)
    const budget = sysTok(ws) + 10 // no room for any tool, protected or not
    const trace = subtractToFit(
      ws,
      budget,
      tools.map((t) => t.name),
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      new Set(['provide_answer'])
    )
    // Protection yields to the hard floor: a degraded-but-delivered (prose auto-capture) dispatch beats a
    // forced overflow. Everything shed.
    expect(visibleNames(ws)).toEqual([])
    expect(trace.fits).toBe(true)
  })
})
