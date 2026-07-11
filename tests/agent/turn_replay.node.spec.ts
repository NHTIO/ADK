// Turn snapshot + replay harness — the reliable alternative to hand-slicing the HTTP dump.
//
// Two modes, both via the REAL flagship loop against Ollama:
//
//  CAPTURE (ADK_SNAPSHOT_THREAD=T5 ADK_SNAPSHOT_DIR=/tmp/snaps): run a thread and, BEFORE each turn,
//  write an encoded TurnSnapshot (store state at turn-start + the input text) to
//  <dir>/<thread>#<turn>.snap. These snapshots are replayable turn fixtures.
//
//  REPLAY (ADK_REPLAY_SNAP=/tmp/snaps/T5#0.snap): restore that snapshot into a FRESH store and run the
//  ONE captured turn through the loop. Because the store state + input are byte-identical, the only thing
//  that varies between two replays is the code under test — a true A/B for a single-turn fix (e.g. the
//  doc_cited plan-thought change). Set ADK_REPLAY_N to run it N times and see the thrash spread.
//
// Run: TEST_OLLAMA_AGENT=1 ADK_SNAPSHOT_THREAD=T5 ADK_SNAPSHOT_DIR=/tmp/snaps npx vitest run tests/agent/turn_replay.node.spec.ts
//      TEST_OLLAMA_AGENT=1 ADK_REPLAY_SNAP=/tmp/snaps/T5#0.snap ADK_REPLAY_N=5 npx vitest run tests/agent/turn_replay.node.spec.ts
import { test } from 'vitest'
import { resolve } from 'node:path'
import { isError } from '../../src/lib/utils/guards'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
;(globalThis as unknown as { self?: unknown }).self ??= globalThis

const REPO = resolve(__dirname, '../..')
const INDEX_PATH = resolve(REPO, 'docs/public/ask-adk-index.json')
const realFetch = globalThis.fetch.bind(globalThis)
;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  input: unknown,
  init: unknown
) => {
  const url =
    typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input))
  if (url.endsWith('ask-adk-index.json')) {
    return new Response(readFileSync(INDEX_PATH, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(input as never, init as never)
}) as never

const OLLAMA = 'http://localhost:11434'
const RUN = process.env.TEST_OLLAMA_AGENT === '1'

async function ollamaUp(): Promise<boolean> {
  try {
    const res = await realFetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

async function boot() {
  const runtime = await import('../../docs/.vitepress/theme/components/agent/agent_runtime')
  const store = await import('../../docs/.vitepress/theme/components/agent/agent_swarm_store')
  const adk = await import('../../docs/.vitepress/theme/components/agent/agent_adk')
  const rag = await import('../../docs/.vitepress/theme/components/agent/agent_rag')
  const keyword = await import('../../docs/.vitepress/theme/components/agent/agent_keyword_search')
  const { makeNodeSqliteStore } = await import('./_harness/node_sqlite_store')
  const { makeOllamaAdapterFactory } = await import('./_harness/ollama_adapter_factory')
  const { buildNodeAdkBundle } = await import('./_harness/node_adk_bundle')
  const { buildNodeKeywordIndex } = await import('./_harness/node_keyword_index')

  adk._initAgentRuntimeFromBundle(buildNodeAdkBundle())
  const nodeDb = makeNodeSqliteStore()
  store._initAgentStoreWithExec(nodeDb.exec)
  try {
    keyword._setKeywordIndex(await buildNodeKeywordIndex(REPO))
  } catch {
    /* best effort */
  }
  const tf = (await import('@huggingface/transformers')) as unknown as {
    env: { useBrowserCache: boolean; useFSCache: boolean }
  }
  tf.env.useFSCache = true
  Object.defineProperty(tf.env, 'useBrowserCache', {
    get: () => false,
    set: () => {},
    configurable: true,
  })
  await rag.ensureRagIndex()
  return { runtime, store, nodeDb, makeOllamaAdapterFactory }
}

type Booted = Awaited<ReturnType<typeof boot>>

function makeHarness(booted: Booted) {
  let dispatchSeq = 0
  const gates: string[] = []
  const factory = booted.makeOllamaAdapterFactory({ onDispatch: () => dispatchSeq++ })
  const harness = new booted.runtime.AgentHarness(
    'gemma-e2b',
    { onGate: (g: { gate: string }) => gates.push(g.gate) },
    { adapterFactory: factory }
  )
  harness.setContextWindow(Number(process.env.ADK_WINDOW) || 8192)
  harness.setMaxTokens(Number(process.env.ADK_MAX_TOKENS) || 512)
  return { harness, gates, dispatches: () => dispatchSeq }
}

// ─── CAPTURE mode ─────────────────────────────────────────────────────────────
test.runIf(RUN && !!process.env.ADK_SNAPSHOT_THREAD)(
  'capture: snapshot each turn of a thread before it runs',
  async () => {
    if (!(await ollamaUp())) return
    const dir = process.env.ADK_SNAPSHOT_DIR || '/tmp/snaps'
    mkdirSync(dir, { recursive: true })
    const prefix = process.env.ADK_SNAPSHOT_THREAD!
    const booted = await boot()
    const { store, nodeDb } = booted
    const { captureTurnSnapshot } = await import('./_harness/turn_snapshot')
    const { STRESS_THREADS } = (await import(
      // @ts-expect-error untyped fixture
      '../../research/_stress_threads.mjs'
    )) as { STRESS_THREADS: Array<{ name: string; turns: string[] }> }
    const thread = STRESS_THREADS.find((t) => t.name.split(':')[0] === prefix)
    if (!thread) throw new Error(`thread ${prefix} not found`)
    await (store as { clearAllData?: () => Promise<void> }).clearAllData?.().catch(() => {})
    const { harness } = makeHarness(booted)
    for (let i = 0; i < thread.turns.length; i++) {
      const snap = await captureTurnSnapshot(nodeDb.exec, prefix, i, thread.turns[i])
      writeFileSync(resolve(dir, `${prefix}#${i}.snap`), JSON.stringify(snap))
      await harness.run({ text: thread.turns[i] }).catch(() => {})
      console.log(`[capture] ${prefix}#${i} snapshotted`)
    }
    await nodeDb.close()
  },
  6 * 60 * 60_000
)

// ─── REPLAY mode ──────────────────────────────────────────────────────────────
test.runIf(RUN && !!process.env.ADK_REPLAY_SNAP)(
  'replay: restore a turn snapshot and run it N times (thrash A/B)',
  async () => {
    if (!(await ollamaUp())) return
    const snapPath = process.env.ADK_REPLAY_SNAP!
    const N = Number(process.env.ADK_REPLAY_N) || 5
    const report = process.env.ADK_REPLAY_REPORT || '/tmp/replay.jsonl'
    writeFileSync(report, '')
    const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as {
      input: string
      thread: string
      turn: number
      rows: string
    }
    const booted = await boot()
    const { store, nodeDb } = booted
    const { restoreStoreRows } = await import('./_harness/turn_snapshot')
    for (let run = 1; run <= N; run++) {
      // Fresh store each replay, restored to the captured turn-start state.
      await (store as { clearAllData?: () => Promise<void> }).clearAllData?.().catch(() => {})
      await restoreStoreRows(nodeDb.exec, snap.rows)
      const { harness, gates, dispatches } = makeHarness(booted)
      const d0 = dispatches()
      const g0 = gates.length
      let res: { answer?: string; error?: string }
      try {
        res = await harness.run({ text: snap.input })
      } catch (e) {
        res = { answer: '', error: isError(e) ? e.message : String(e) }
      }
      const row = {
        run,
        dispatches: dispatches() - d0,
        gates: [...new Set(gates.slice(g0))],
        error: res.error ?? null,
        answer: (res.answer ?? '').replace(/\n/g, ' ').slice(0, 100),
      }
      appendFileSync(report, JSON.stringify(row) + '\n')
      console.log(
        `[replay ${run}/${N}] ${row.dispatches}d ${row.error ? 'ERR' : 'ok'} gates=[${row.gates.join(',')}]`
      )
    }
    await nodeDb.close()
  },
  6 * 60 * 60_000
)
