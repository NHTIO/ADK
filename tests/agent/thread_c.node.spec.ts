// Portable REAL-LOOP harness: runs the actual flagship AgentHarness loop in Node against the ADK Ollama
// battery (gemma4:e2b-it-qat). This exercises the genuine planner book-end, subtractive pass, and ALL the
// behavioural gates — unlike the earlier lossy fixture-replay. Purpose: measure the tool_computed loop
// ("what day is it?") and A/B any candidate fix by flipping code and re-running.
//
// Requires a local Ollama with gemma4:e2b-it-qat pulled. Skips (does not fail) if Ollama is unreachable.
// Run: TEST_OLLAMA_AGENT=1 npx vitest run tests/agent/thread_c.node.spec.ts
import { test, expect } from 'vitest'

// web-serialization (via @nhtio/swarm, pulled transitively by agent_rag) touches `self` at module load.
;(globalThis as unknown as { self?: unknown }).self ??= globalThis

const OLLAMA = 'http://localhost:11434'
const RUN = process.env.TEST_OLLAMA_AGENT === '1'

async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

test.runIf(RUN)(
  'thread C: tool_computed loop, real loop via Ollama',
  async () => {
    if (!(await ollamaUp())) {
      console.log('[skip] Ollama not reachable at ' + OLLAMA)
      return
    }
    const runtime = await import('../../docs/.vitepress/theme/components/agent/agent_runtime')
    const store = await import('../../docs/.vitepress/theme/components/agent/agent_swarm_store')
    const adk = await import('../../docs/.vitepress/theme/components/agent/agent_adk')
    const { makeNodeSqliteStore } = await import('./_harness/node_sqlite_store')
    const { makeOllamaAdapterFactory } = await import('./_harness/ollama_adapter_factory')
    const { buildNodeAdkBundle } = await import('./_harness/node_adk_bundle')

    // Populate the flagship's ADK runtime holders from @nhtio/adk src (the browser uses a precompiled bundle
    // via initAgentRuntime; that loader is browser-only, so inject the src-assembled bundle instead).
    adk._initAgentRuntimeFromBundle(buildNodeAdkBundle())

    const nodeDb = makeNodeSqliteStore()
    store._initAgentStoreWithExec(nodeDb.exec)

    const { writeFileSync, mkdirSync, appendFileSync } = await import('node:fs')
    const dumpPath = process.env.ADK_DISPATCH_DUMP || '/tmp/agent_dispatch_dump.jsonl'
    mkdirSync(dumpPath.replace(/\/[^/]+$/, ''), { recursive: true })
    writeFileSync(dumpPath, '') // truncate at run start

    const rawGens: Array<{ raw: string; tools: string[] }> = []
    const sentBodies: Array<Record<string, unknown>> = []
    const factory = makeOllamaAdapterFactory({
      onRawGeneration: (o) =>
        rawGens.push({ raw: o.rawText, tools: o.toolCalls.map((c) => c.name) }),
      onRequestBody: (b) => sentBodies.push(b),
      // FULL dispatch dump — the complete request + response for every /api/chat round-trip, appended to a
      // JSONL file. This is the diagnostics ground truth; read it, don't infer from a truncated answer.
      onDispatch: (d) => {
        appendFileSync(dumpPath, JSON.stringify(d) + '\n')
      },
    })

    const gates: Array<{ gate: string; detail: string }> = []
    const thoughts: Array<{ kind: string; text: string }> = []
    const harness = new runtime.AgentHarness(
      'gemma-e2b',
      {
        onGate: (g) => gates.push(g),
        onThought: (t) => t.isComplete && thoughts.push({ kind: t.kind, text: t.text }),
      },
      { adapterFactory: factory, spoolStoreFactory: undefined }
    )

    const turns = ['hey, how are you?', 'what day of the week is it?', '73291 times 8457']
    const results: Array<{
      prompt: string
      answer: string
      refused: boolean
      gates: number
      error?: string
    }> = []
    for (const text of turns) {
      const gatesBefore = gates.length
      const res = await harness.run({ text })
      results.push({
        prompt: text,
        answer: (res.answer || '').slice(0, 200),
        refused: res.refused,
        gates: gates.length - gatesBefore,
        error: res.error,
      })
      console.log(
        `\n>>> "${text}"\n  answer: ${JSON.stringify((res.answer || '').slice(0, 160))}\n  refused=${res.refused} gatesThisTurn=${gates.length - gatesBefore} error=${res.error ?? ''}`
      )
    }
    console.log('\n=== gate firings ===')
    for (const g of gates) console.log(`  [${g.gate}] ${g.detail.slice(0, 80)}`)

    // Tool-calling fidelity: did the QAT model ever get tools advertised, and did it ever emit a tool call?
    // (If it never calls tools, turns needing get_current_time/calculate can't be judged on this model.)
    const bodiesWithTools = sentBodies.filter(
      (b) => Array.isArray(b.tools) && (b.tools as unknown[]).length > 0
    ).length
    const toolCallsEmitted = rawGens.filter((g) => g.tools.length > 0)
    console.log(
      `\n=== tool fidelity === bodies advertising tools: ${bodiesWithTools}/${sentBodies.length}; generations that emitted a tool call: ${toolCallsEmitted.length} (${JSON.stringify(toolCallsEmitted.flatMap((g) => g.tools))})`
    )

    // PROVE the thinking policy on the wire (matches the flagship default the head-to-head matrix was
    // built around): the PLANNER book-end deliberately thinks (enableThinking:true — see agent_planner.ts,
    // the answer_kind classification is the one decision worth paying reasoning tokens for), while every
    // WORKER dispatch keeps thinking OFF. A planner body is identifiable on the wire by its tool
    // advertisement: it shows the model exactly one tool, make_plan.
    const isPlannerBody = (b: Record<string, unknown>): boolean => {
      const tools = b.tools as Array<{ function?: { name?: string } }> | undefined
      return Array.isArray(tools) && tools.length === 1 && tools[0]?.function?.name === 'make_plan'
    }
    const plannerBodies = sentBodies.filter(isPlannerBody)
    const workerBodies = sentBodies.filter((b) => !isPlannerBody(b))
    console.log(
      `\n=== wire proof === bodies=${sentBodies.length} (planner=${plannerBodies.length}, worker=${workerBodies.length}) think values: ${JSON.stringify([...new Set(sentBodies.map((b) => b.think))])}`
    )
    expect(sentBodies.length).toBeGreaterThan(0)
    expect(workerBodies.every((b) => b.think === false)).toBe(true)
    expect(plannerBodies.every((b) => b.think === true)).toBe(true)

    nodeDb.close()
    // The "what day" turn must produce a non-empty committed answer (the loop-under-test).
    const dayTurn = results[1]
    expect(dayTurn.answer.length).toBeGreaterThan(0)
  },
  300_000
)
