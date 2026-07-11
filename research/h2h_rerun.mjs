// Token-thrift head-to-head RE-RUN orchestrator (post-scaled-floor).
//
// Runs the 5-cell × 3-arm matrix through the Node harness (tests/agent/stress_corpus.node.spec.ts),
// one cell×arm per vitest invocation, env-injected. Writes per-cell-tagged report + dump JSONLs to
// /tmp/h2h2_<tag>_<arm>_report.jsonl (+ _dump). CANDIDATES ONLY — does NOT judge (judging is a
// separate, user-gated step; see research/judge_committee.mjs).
//
// The matrix (see /Users/jak/.claude/plans/goofy-cuddling-milner.md):
//   e2b   @ 8k  /512  (real 2B, Ollama)            — constrained edge
//   31b   @ 32k /512  (Ollama)                     — window-control LOW
//   31b   @ 128k/512  (Ollama)                     — window-control HIGH (isolates the window effect)
//   kimi  @ 128k/4096 (Ollama-compat LB)           — scaled generalist; reasoning guardrail cap
//   gemini@ 1M  /8192 (OpenAI battery LB)          — frontier extreme; reasoning runway cap
//
// LB base URL: the nht LB serves BOTH an Ollama-native surface (root /api/chat — used by the 'ollama'
// adapter) AND an OpenAI-compatible surface (/v1/chat/completions — used by the 'openai' adapter). Set
// TEST_OLLAMA_BASE_URL per cell accordingly (root for ollama cells, /v1 for the openai/gemini cell).
//
// Credential: read at runtime from ~/.pi/agent/models.json provider 'nht' (NEVER hardcoded). Local
// Ollama (e2b/31b) needs none if a local daemon is up; here all cells go through the LB for consistency
// unless ADK_LOCAL_OLLAMA points e2b/31b at a local daemon.
//
// Run:  node research/h2h_rerun.mjs [--only <tag>] [--arm <thrift|compact|naive>] [--dry]
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 ? (process.argv[i + 1] ?? true) : null
}
const ONLY = arg('only') // run a single cell tag
const ARM_ONLY = arg('arm') // run a single arm
const DRY = !!arg('dry') // print the plan, don't execute

// LB credential (runtime, redacted). Fall back to env if pi config absent.
let LB_BASE = process.env.ADK_LB_BASE || ''
let LB_KEY = process.env.TEST_OLLAMA_API_KEY || ''
try {
  const m = JSON.parse(readFileSync(`${homedir()}/.pi/agent/models.json`, 'utf8'))
  const p = m.providers?.nht
  if (p?.apiKey) LB_KEY = p.apiKey
  if (p?.baseUrl) LB_BASE = p.baseUrl.replace(/\/v1\/?$/, '') // strip /v1 → root; per-cell re-adds it
} catch {
  /* env fallback */
}
if (!LB_KEY) {
  console.error('[h2h] no LB API key (pi nht provider or TEST_OLLAMA_API_KEY). Aborting.')
  process.exit(1)
}
if (!LB_BASE) {
  console.error('[h2h] no LB base URL (pi nht provider or ADK_LB_BASE). Aborting.')
  process.exit(1)
}

// The 5 cells. `adapter` picks the factory; `base` is the LB surface (root for ollama, /v1 for openai).
const CELLS = [
  {
    // The real on-device 2B QAT variant is NOT served on the LB ("No available credential") — it runs on
    // the LOCAL Ollama daemon (localhost:11434, no key). That's HIGHER fidelity than an LB stand-in: the
    // exact QAT weights the browser ships. Probe-confirmed: settled clean, 1155-char grounded answer.
    tag: 'e2b_8k',
    model: 'gemma4:e2b-it-qat',
    window: 8192,
    maxTok: 512,
    adapter: 'ollama',
    enc: 'gemma',
    retry: 1,
    localDaemon: true,
  },
  {
    tag: '31b_32k',
    model: 'gemma4:31b',
    window: 32768,
    maxTok: 512,
    adapter: 'ollama',
    enc: 'gemma',
    retry: 15, // raised 4→15: a 503 from the capacity ROUTER means the request never ran — retry generously (backoff 800ms→30s ceiling, ~15 attempts ≈ several min) to ride out a capacity blip rather than count it as a strategy error (the qwen/gemini lesson).
  },
  {
    tag: '31b_128k',
    model: 'gemma4:31b',
    window: 131072,
    maxTok: 512,
    adapter: 'ollama',
    enc: 'gemma',
    retry: 15, // raised 4→15: a 503 from the capacity ROUTER means the request never ran — retry generously (backoff 800ms→30s ceiling, ~15 attempts ≈ several min) to ride out a capacity blip rather than count it as a strategy error (the qwen/gemini lesson).
  },
  {
    tag: 'kimi_128k',
    model: 'kimi-k2.5',
    window: 131072,
    maxTok: 4096,
    adapter: 'ollama',
    enc: 'o200k_base',
    retry: 15, // raised 4→15: a 503 from the capacity ROUTER means the request never ran — retry generously (backoff 800ms→30s ceiling, ~15 attempts ≈ several min) to ride out a capacity blip rather than count it as a strategy error (the qwen/gemini lesson).
  },
  {
    // gemini's differentiator in this matrix is the 1M WINDOW, not its reasoning — so run it THINKING-OFF
    // with a lean 2048 output. This (a) removes the hidden-reasoning token spend that inflated its cost vs
    // the non-reasoning cells and strained the LB, and (b) makes lighter/faster turns that schedule more
    // readily on the capacity router. Still a valid "1M-window generalist" comparison point (user's call).
    tag: 'gemini_1m',
    model: 'gemini-flash-latest',
    window: 1048576,
    maxTok: 2048,
    thinking: false,
    adapter: 'openai',
    enc: 'gemini',
    retry: 15, // raised 4→15: a 503 from the capacity ROUTER means the request never ran — retry generously (backoff 800ms→30s ceiling, ~15 attempts ≈ several min) to ride out a capacity blip rather than count it as a strategy error (the qwen/gemini lesson).
  },
  // glm52_do (@do/glm-5.2) DROPPED: the DigitalOcean route backing this model has only ONE credential
  // (no failover pool). Live run: thrift arm finished 94/94 rows but only 66 settled (28 errored) —
  // 429s then a sustained "No available credential for model @do/glm-5.2" 503 cascade from T11 onward
  // that outlasted the 15x retry budget. compact arm immediately hit the same wall (6 straight 503s,
  // then 403/429) even after a manual health-check briefly marked the credential healthy again. Not
  // salvageable without a second DO credential or a different provider route for this model — dropped
  // rather than reporting on a data set that's ~30%+ error on every arm.
]
const ARMS = ['thrift', 'compact', 'naive']

const SESS = '/tmp/h2h2'
mkdirSync(SESS, { recursive: true })

// ASYNC (promise-wrapped execFile) so two lanes' vitest children run CONCURRENTLY — execFileSync would
// block the whole event loop and defeat the point. Child stdout/stderr → a per-cell log file (two
// concurrent children interleaving on the shared stdout would be unreadable); the orchestrator's own
// stdout carries only the ▶/✔ milestone lines.
function runCellArm(cell, arm) {
  const base = cell.localDaemon
    ? 'http://localhost:11434'
    : cell.adapter === 'openai'
      ? `${LB_BASE}/v1`
      : LB_BASE
  const report = `${SESS}/${cell.tag}_${arm}_report.jsonl`
  const dump = `${SESS}/${cell.tag}_${arm}_dump.jsonl`
  const cellLog = `${SESS}/${cell.tag}_${arm}.log`
  const env = {
    ...process.env,
    TEST_OLLAMA_AGENT: '1',
    TEST_OLLAMA_BASE_URL: base,
    TEST_OLLAMA_MODEL: cell.model,
    TEST_OLLAMA_API_KEY: cell.localDaemon ? '' : LB_KEY,
    TEST_OLLAMA_ENCODING: cell.enc,
    ADK_ADAPTER: cell.adapter,
    ADK_CORPUS: 'stress',
    ADK_CONTEXT_STRATEGY: arm,
    ADK_WINDOW: String(cell.window),
    ADK_MAX_TOKENS: String(cell.maxTok),
    ADK_RETRY_ATTEMPTS: String(cell.retry),
    // Per-dispatch REQUEST TIMEOUT (ms). Without this, a HALF-OPEN LB stream (connection accepted, then
    // stalls mid-generation) hangs the vitest child FOREVER at 0% CPU — and the orchestrator's runLane
    // awaits that child's callback, so the whole LB lane DEADLOCKS behind one stalled turn (observed:
    // 31b_32k/naive wedged 36min at T11#6 with the LB reachable). The battery arms an abort timer; on
    // timeout that ONE turn errors cleanly and the run continues. Local daemon (e2b) is fast + reliable,
    // so only the LB cells really need it, but it's harmless on local. 180s is generous for a slow
    // reasoning turn (kimi/gemini) yet bounded so a dead stream can't wedge the lane.
    ADK_OLLAMA_REQUEST_TIMEOUT_MS: cell.localDaemon ? '' : '180000',
    ADK_CORPUS_REPORT: report,
    ADK_DISPATCH_DUMP: dump,
    ...(cell.reasoningEffort ? { ADK_REASONING_EFFORT: cell.reasoningEffort } : {}),
  }
  const label = `${cell.tag} / ${arm} (${cell.model} @ ${cell.window}/${cell.maxTok}, ${cell.adapter}, retry=${cell.retry})`
  if (DRY) {
    console.log(`[h2h] DRY would run: ${label}  base=${base}`)
    return Promise.resolve()
  }
  console.log(`[h2h] ▶ ${label}  (log → ${cellLog})`)
  const t0 = Date.now()
  writeFileSync(cellLog, '') // truncate this cell's log
  return new Promise((resolveRun) => {
    const child = execFile(
      'npx',
      ['vitest', 'run', 'tests/agent/stress_corpus.node.spec.ts', '--testTimeout=0'],
      { env, cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 },
      () => {
        // Completeness read (the haiku lesson: check settle/rows, not just "process exited").
        let rows = 0
        let settled = 0
        if (existsSync(report)) {
          for (const line of readFileSync(report, 'utf8').split('\n')) {
            if (!line.trim()) continue
            rows++
            try {
              if (JSON.parse(line).settled) settled++
            } catch {
              /* skip */
            }
          }
        }
        console.log(
          `[h2h] ✔ done ${label}: ${rows} rows, ${settled} settled, ${Math.round((Date.now() - t0) / 1000)}s`
        )
        resolveRun()
      }
    )
    child.stdout?.on('data', (d) => appendFileSync(cellLog, d))
    child.stderr?.on('data', (d) => appendFileSync(cellLog, d))
  })
}

// Order: local-ish (e2b) first, then the window-control 31b pair, then the LB reasoning cells last
// (serial — Anthropic/frontier rate caps). Within a cell, arms run serially too (share the endpoint).
const cells = ONLY ? CELLS.filter((c) => c.tag === ONLY) : CELLS
const arms = ARM_ONLY ? ARMS.filter((a) => a === ARM_ONLY) : ARMS

// TWO PARALLEL LANES. The e2b cell runs on the LOCAL daemon (local GPU); the other four run on the LB
// (network). They share NO resource, so serialising them wastes wall-clock (the LB idles through e2b's
// passes, and vice versa). Split into a LOCAL lane and an LB lane, run the lanes CONCURRENTLY. Within a
// lane, cells stay SERIAL: the local lane shares one GPU; the LB lane must respect the Anthropic/frontier
// rate caps (the reason serial mattered in the first place — it only ever applied AMONG LB cells).
// ADK_SKIP_DONE=1 skips a cell×arm whose report already has 94 rows (resume without re-running e2b/thrift).
const laneOf = (c) => (c.localDaemon ? 'local' : 'lb')
const lanes = { local: [], lb: [] }
for (const cell of cells) for (const arm of arms) lanes[laneOf(cell)].push({ cell, arm })

const isDone = (cell, arm) => {
  if (process.env.ADK_SKIP_DONE !== '1') return false
  const rep = `${SESS}/${cell.tag}_${arm}_report.jsonl`
  if (!existsSync(rep)) return false
  return readFileSync(rep, 'utf8').split('\n').filter(Boolean).length >= 94
}

async function runLane(name, jobs) {
  for (const { cell, arm } of jobs) {
    if (isDone(cell, arm)) {
      console.log(`[h2h:${name}] skip (already 94 rows): ${cell.tag}/${arm}`)
      continue
    }
    // runCellArm is async (promise-wrapped execFile) — await it so the lane stays SERIAL internally,
    // while the two lanes' awaits interleave (both children run concurrently).
    await runCellArm(cell, arm)
  }
  console.log(`[h2h:${name}] lane complete (${jobs.length} runs).`)
}

console.log(
  `[h2h] plan: LOCAL lane ${lanes.local.length} runs (e2b, local GPU) ‖ LB lane ${lanes.lb.length} runs (31b/kimi/gemini, serial for rate caps). Lanes run CONCURRENTLY. Candidates only, NO judging.`
)
await Promise.all([runLane('local', lanes.local), runLane('lb', lanes.lb)])
console.log(
  '\n[h2h] all candidate runs dispatched. STOP — confirm completeness, then judge separately.'
)
