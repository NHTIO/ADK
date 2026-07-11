// Re-run specific contaminated THREADS of an h2h cell into an ISOLATED report, then splice the clean
// thread-blocks over the contaminated ones in the main cell report (+ dump). Threads clear history between
// them, so re-running a whole thread from turn 0 reconstructs its correct in-thread context — you cannot
// resume mid-thread. Usage:
//   node research/h2h_scrub_threads.mjs <cellTag> <arm> <threadPrefix[,threadPrefix...]>
// e.g. node research/h2h_scrub_threads.mjs gemini_1m naive T1,T5,T6,T7
// The cell's model/window/adapter/enc are looked up from the same CELLS table h2h_rerun uses.
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs'

const [, , CELL_TAG, ARM, THREADS_CSV] = process.argv
if (!CELL_TAG || !ARM || !THREADS_CSV) {
  console.error('usage: h2h_scrub_threads.mjs <cellTag> <arm> <T1,T5,...>')
  process.exit(1)
}
const THREAD_PREFIXES = THREADS_CSV.split(',').map((s) => s.trim())

const SESS = '/tmp/h2h2'
// Resolve LB creds the same way h2h_rerun does (pi nht provider), never hardcoded.
let LB_KEY = process.env.TEST_OLLAMA_API_KEY || ''
let LB_BASE = process.env.ADK_LB_BASE || ''
try {
  const home = process.env.HOME
  const m = JSON.parse(readFileSync(`${home}/.pi/agent/models.json`, 'utf8'))
  const provs = m.providers || m
  const nht = provs.nht || Object.values(provs).find((x) => /nht/i.test(JSON.stringify(x)))
  if (nht) {
    LB_KEY = LB_KEY || nht.apiKey || nht.api_key || ''
    if (nht.baseUrl) LB_BASE = nht.baseUrl.replace(/\/v1\/?$/, '')
  }
} catch {
  /* env fallback */
}

// Same CELLS shape as h2h_rerun (only the fields we need).
const CELLS = {
  'e2b_8k': {
    model: 'gemma4:e2b-it-qat',
    window: 8192,
    maxTok: 512,
    adapter: 'ollama',
    enc: 'gemma',
    localDaemon: true,
    retry: 1,
  },
  '31b_32k': {
    model: 'gemma4:31b',
    window: 32768,
    maxTok: 512,
    adapter: 'ollama',
    enc: 'gemma',
    retry: 15,
  },
  '31b_128k': {
    model: 'gemma4:31b',
    window: 131072,
    maxTok: 512,
    adapter: 'ollama',
    enc: 'gemma',
    retry: 15,
  },
  'kimi_128k': {
    model: 'kimi-k2.5',
    window: 131072,
    maxTok: 4096,
    adapter: 'ollama',
    enc: 'o200k_base',
    retry: 15,
  },
  'gemini_1m': {
    model: 'gemini-flash-latest',
    window: 1000000,
    maxTok: 8192,
    adapter: 'openai',
    enc: 'gemini',
    retry: 15,
  },
}
const cell = CELLS[CELL_TAG]
if (!cell) {
  console.error(`unknown cell ${CELL_TAG}`)
  process.exit(1)
}
if (!cell.localDaemon && !LB_BASE) {
  console.error('[scrub] no LB base URL (pi nht provider or ADK_LB_BASE). Aborting.')
  process.exit(1)
}

const base = cell.localDaemon
  ? 'http://localhost:11434'
  : cell.adapter === 'openai'
    ? `${LB_BASE}/v1`
    : LB_BASE

// Isolated re-run log (per-thread report/dump paths are computed in threadReport/threadDump below).
const reLog = `${SESS}/${CELL_TAG}_${ARM}_scrub.log`

// Base env shared by every per-thread run. NB: ADK_CORPUS_REPORT / ADK_DISPATCH_DUMP are set PER-THREAD in
// runThread — NOT here — because the spec TRUNCATES its report at startup (writeFileSync(REPORT,'')). If all
// threads wrote the same path, each run would wipe the previous thread's rows and only the LAST thread would
// survive (the bug that made a 4-thread scrub splice only 5 rows). Per-thread paths keep them all.
const envBase = {
  ...process.env,
  TEST_OLLAMA_AGENT: '1',
  TEST_OLLAMA_BASE_URL: base,
  TEST_OLLAMA_MODEL: cell.model,
  TEST_OLLAMA_API_KEY: cell.localDaemon ? '' : LB_KEY,
  TEST_OLLAMA_ENCODING: cell.enc,
  ADK_ADAPTER: cell.adapter,
  ADK_CORPUS: 'stress',
  ADK_CONTEXT_STRATEGY: ARM,
  ADK_WINDOW: String(cell.window),
  ADK_MAX_TOKENS: String(cell.maxTok),
  ADK_RETRY_ATTEMPTS: String(cell.retry),
  ADK_OLLAMA_REQUEST_TIMEOUT_MS: cell.localDaemon ? '' : '180000',
  // ADK_THREAD matches by substring; we run the prefixes one at a time so a single filter value is exact.
}

// Per-thread output paths (safe filename slug for the prefix).
const slug = (p) => p.replace(/[^A-Za-z0-9]+/g, '_')
const threadReport = (p) => `${SESS}/${CELL_TAG}_${ARM}_scrub_${slug(p)}_report.jsonl`
const threadDump = (p) => `${SESS}/${CELL_TAG}_${ARM}_scrub_${slug(p)}_dump.jsonl`

function runThread(prefix) {
  // ANCHOR the ADK_THREAD filter with a trailing colon. The spec matches by `name.includes(ADK_THREAD)`,
  // and thread names are "T1: the loop…", "T10: vector…" — so a bare "T1" ALSO matches "T10","T11",…"T13"
  // (substring), which made a T1 scrub re-run 5 threads and waste calls / hit other backends. Every thread
  // name has exactly "<prefix>: " so "<prefix>:" is an exact, collision-free anchor ("T1:" ∌ "T10:").
  const filter = `${prefix}:`
  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['vitest', 'run', 'tests/agent/stress_corpus.node.spec.ts', '--testTimeout=0'],
      {
        env: {
          ...envBase,
          ADK_THREAD: filter,
          ADK_CORPUS_REPORT: threadReport(prefix),
          ADK_DISPATCH_DUMP: threadDump(prefix),
        },
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
      },
      (err) => resolve({ err })
    )
    if (child.stdin) child.stdin.end()
  })
}

// Splice: replace all rows whose thread-prefix ∈ THREAD_PREFIXES in the MAIN report with the freshly
// re-run rows, preserving original thread order. Same for the dump is NOT spliced (dumps are per-run and
// only used for token/timing sums — we recompute those from the spliced set of report rows' dispatch
// counts; the scrub dump is kept alongside for the timing deep-dive). Report is the source of truth for
// the table.
async function main() {
  const mainReport = `${SESS}/${CELL_TAG}_${ARM}_report.jsonl`
  if (!existsSync(mainReport)) {
    console.error(`main report missing: ${mainReport}`)
    process.exit(1)
  }
  writeFileSync(reLog, '')

  console.log(
    `[scrub] ${CELL_TAG}/${ARM} threads=${THREAD_PREFIXES.join(',')} model=${cell.model} base=${base}`
  )
  const readThreadRows = (p) => {
    const rp = threadReport(p)
    if (!existsSync(rp)) return []
    return readFileSync(rp, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
  for (const p of THREAD_PREFIXES) {
    console.log(`[scrub] re-running thread ${p} ...`)
    const t0 = Date.now()
    await runThread(p)
    const rows = readThreadRows(p).filter((r) => r.thread.split(':')[0] === p)
    const err = rows.filter((r) => r.error).length
    console.log(
      `[scrub]   thread ${p}: ${rows.length} rows (${err} err) in ${((Date.now() - t0) / 1000).toFixed(0)}s`
    )
  }

  // Accumulate fresh rows from ALL per-thread report files (each thread has its OWN path — the spec's
  // startup truncation only wipes that one thread's file, not the others). Keyed by thread#turn, keep-last.
  const freshByKey = new Map()
  for (const p of THREAD_PREFIXES) {
    for (const r of readThreadRows(p)) freshByKey.set(`${r.thread}::${r.turn}`, r)
  }
  console.log(
    `[scrub] accumulated ${freshByKey.size} fresh rows across ${THREAD_PREFIXES.length} threads`
  )

  // Splice into the main report: for any row whose thread-prefix is being scrubbed, replace with the fresh
  // row (matched by thread::turn); keep all other rows untouched and in original order.
  const mainRows = readFileSync(mainReport, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const scrubSet = new Set(THREAD_PREFIXES)
  let replaced = 0
  let missing = 0
  const out = []
  const seen = new Set()
  for (const r of mainRows) {
    const key = `${r.thread}::${r.turn}`
    if (seen.has(key)) continue // drop any pre-existing dup
    seen.add(key)
    const pref = r.thread.split(':')[0]
    if (scrubSet.has(pref)) {
      const fresh = freshByKey.get(key)
      if (fresh) {
        out.push(JSON.stringify(fresh))
        replaced++
      } else {
        // fresh run didn't produce this turn (e.g. thread got fewer turns) — keep original, flag it
        out.push(JSON.stringify(r))
        missing++
      }
    } else {
      out.push(JSON.stringify(r))
    }
  }
  // backup + write spliced main report
  copyFileSync(mainReport, `${mainReport}.pre-scrub`)
  writeFileSync(mainReport, out.join('\n') + '\n')

  // report residual contamination in the spliced result
  const TRANSPORT =
    /HTTP error (429|500|502|503|504)|No available credential|upstream returned|failed to convert|digitalocean/i
  const after = out.map((l) => JSON.parse(l))
  const stillBad = after.filter(
    (r) => scrubSet.has(r.thread.split(':')[0]) && r.error && TRANSPORT.test(r.error)
  )
  console.log(
    `[scrub] spliced ${replaced} rows, ${missing} kept-original(no-fresh), ${after.length} total rows`
  )
  console.log(
    `[scrub] residual contaminated rows in scrubbed threads: ${stillBad.length}${stillBad.length ? ' ⚠ (re-run again?)' : ' ✅'}`
  )
  console.log(
    `[scrub] backup: ${mainReport}.pre-scrub ; per-thread scrub dumps: ${SESS}/${CELL_TAG}_${ARM}_scrub_*_dump.jsonl`
  )
}

main()
