import { validator } from '@nhtio/validation'
import { Tool } from '../../../src/lib/classes/tool'
import { isError } from '../../../src/lib/utils/guards'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as batteriesTools from '../../../src/batteries/tools'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { ToolRegistry } from '../../../src/lib/classes/tool_registry'
import { SpooledJsonArtifact } from '../../../src/lib/classes/spooled_json_artifact'
import { looksLikeSpooledArtifact } from '../../../src/batteries/llm/chat_common/helpers'
import type { buildToolRegistry as BuildToolRegistryFn } from '../../../docs/.vitepress/theme/components/agent/agent_tools'

// web-serialization (via @nhtio/swarm, pulled transitively when agent_tools loads the battery/store surface)
// touches `self` at module load. Shim it BEFORE the agent modules resolve. The agent modules are therefore
// DYNAMICALLY imported in beforeAll (after this runs) — a static import would hoist above the shim. Mirrors
// the stress-corpus node spec.
;(globalThis as unknown as { self?: unknown }).self ??= globalThis

// buildToolRegistry pulls validator / batteriesTools / looksLikeSpooledArtifact / isError from agent_adk,
// which the app hydrates from the precompiled bundle. Provide the REAL symbols so the registry builds.
vi.mock('../../../docs/.vitepress/theme/components/quickstart_demo_runtime', () => ({
  loadAdkRuntimeBundle: async () => ({
    Tokenizable,
    ToolRegistry,
    Tool,
    SpooledJsonArtifact,
    looksLikeSpooledArtifact,
    isError,
    validator,
    batteriesTools,
  }),
}))

// The real doc routes navigate_to_page validates against — knownDocPaths() reads `_documentIds` off the
// injected MiniSearch stub. Ids carry a "#anchor"; the path is everything before it.
const KNOWN = [
  '/the-loop/tools',
  '/the-loop/state-management',
  '/assembly/byo-llm',
  '/showcase/token-thrift',
]

// Populated in beforeAll from the dynamically-imported module (post-shim).
let buildToolRegistry: typeof BuildToolRegistryFn

beforeAll(async () => {
  const adk = await import('../../../docs/.vitepress/theme/components/agent/agent_adk')
  await adk.initAgentRuntime()
  const kw = await import('../../../docs/.vitepress/theme/components/agent/agent_keyword_search')
  // Inject a stub index: search() unused here, _documentIds is what knownDocPaths() enumerates.
  kw._setKeywordIndex({
    search: () => [],
    // @ts-expect-error — test stub exposing the MiniSearch internal knownDocPaths reads
    _documentIds: new Map(KNOWN.map((p, i) => [i, `${p}#top`])),
  })
  const tools = await import('../../../docs/.vitepress/theme/components/agent/agent_tools')
  buildToolRegistry = tools.buildToolRegistry
})

const deps = () => ({
  currentPath: () => '/',
  navigateInternal: async (path: string) => ({ ok: true, resolved: path }),
  onAnswer: () => undefined,
  groundSources: () => [],
})

const getNav = (): Tool => {
  const { registry } = buildToolRegistry(deps())
  const nav = registry.get('navigate_to_page')
  if (!nav) throw new Error('navigate_to_page not registered')
  return nav
}

// A DispatchContext stub exposing what Tool.executor() + the navigate handler touch: id, the tool-execution
// event emitters (no-ops), and ctx.waitFor. `waitForImpl` lets each test decide whether the gate resolves
// (allow/deny) or rejects (timeout).
const ctxWith = (waitForImpl: (raw: unknown) => Promise<{ allow: boolean }>): never =>
  ({
    id: 'test-turn',
    emitToolExecutionStart: () => undefined,
    emitToolExecutionEnd: () => undefined,
    waitFor: waitForImpl,
  }) as never

const TIMEOUT_ERR = (): Error & { code: string; name: string } => {
  const e = new Error('The turn gate timed out before being resolved.') as Error & {
    code: string
    name: string
  }
  e.code = 'E_TURN_GATE_TIMEOUT'
  e.name = 'E_TURN_GATE_TIMEOUT'
  return e
}

describe('navigate_to_page — path validation, gating, and feedback', () => {
  it('rejects an UNKNOWN (hallucinated) path WITHOUT opening a gate, and suggests real pages', async () => {
    let gateOpened = false
    const ctx = ctxWith(async () => {
      gateOpened = true
      return { allow: true }
    })
    // /middleware/state-management does not exist; /the-loop/state-management does (shared leaf slug).
    const out = (await getNav().executor(ctx)({ path: '/middleware/state-management' })) as string
    expect(gateOpened).toBe(false) // never prompt the user to approve a navigation to nowhere
    expect(out).toMatch(/No page at/i)
    expect(out).toContain('/the-loop/state-management') // did-you-mean suggestion (same leaf)
  })

  it('opens the gate for a KNOWN path and navigates when allowed', async () => {
    let gateOpened = false
    const ctx = ctxWith(async () => {
      gateOpened = true
      return { allow: true }
    })
    const out = (await getNav().executor(ctx)({ path: '/the-loop/tools' })) as string
    expect(gateOpened).toBe(true)
    expect(out).toMatch(/Navigated the user to/i)
  })

  it('returns an explicit-DENY feedback string (not a throw) when the user denies', async () => {
    const ctx = ctxWith(async () => ({ allow: false }))
    const out = (await getNav().executor(ctx)({ path: '/the-loop/tools' })) as string
    expect(out).toMatch(/declined navigation/i)
    expect(out).toMatch(/answer from what you/i) // actionable: keep working
  })

  it('returns a TIMEOUT feedback string (not a throw) when the gate self-rejects', async () => {
    const ctx = ctxWith(async () => {
      throw TIMEOUT_ERR()
    })
    const out = (await getNav().executor(ctx)({ path: '/the-loop/tools' })) as string
    expect(out).toMatch(/timed out/i)
    expect(out).toMatch(/without navigating/i) // distinct from an explicit deny; still actionable
  })
})
