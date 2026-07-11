// FLOOR CALIBRATION — determine the correct RELEVANCE_FLOOR for token-thrift context selection by
// calibrating the cheap lexical relevance score (relevanceToQuery) against a gpt-5.5 relevance ORACLE.
//
// WHY: the floor is the operating point of a weak lexical classifier ("is this prior turn relevant, or
// noise?"). The right way to set a classifier threshold is with labeled data. gpt-5.5 supplies the labels.
// We mine real (current-query, prior-turn) pairs from the corpus, compute the EXACT score the runtime
// gates on, ask gpt-5.5 the binary relevant/noise question, then read FLOOR_MIN (F1-optimal / Youden's J)
// and FLOOR_MAX (high-precision) off the resulting curve. Balanced operating point — no bias (user choice).
//
// PAIR TEXT (user choice: BOTH, compare): score the current query against
//   (A) Q-only  — prior turn's QUESTION only (corpus-intrinsic, model-agnostic)
//   (B) Q+A     — prior turn's Question+Answer, reconstructed from a real arm report = EXACT runtime input
//                 (groupHistoryIntoTurns builds qa = userQ + "\n" + assistantA (+ folded tool-call text)).
// Two curves; if they agree, the floor is answer-insensitive and (A) is the reusable calibration.
//
// SCORE PARITY (must match agent_runtime.ts exactly):
//   contentTokens(s)  = lowercase, /[a-z][a-z0-9]{3,}/g  (no stopword list)
//   relevanceToQuery  = |queryTokens ∩ textTokens| / |queryTokens|   (fraction of QUERY words present)
//
// TRANSPORT: direct fetch to the nht LB (openai-completions), key read AT RUNTIME from
//   ~/.pi/agent/models.json (never hardcoded, never logged). Our own transport, no pi subprocess.
//
// Run:  node research/floor_calibrate.mjs [--n 240] [--concurrency 6] [--arm thrift]
// Out:  /tmp/floor_calibration.json  (raw labeled pairs + both curves + recommended FLOOR_MIN/MAX)

import { homedir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'

// ── args ────────────────────────────────────────────────────────────────────────────────────────────
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const N_TARGET = Number(arg('n', '240')) // total pairs to label (per pair-text mode)
const CONCURRENCY = Number(arg('concurrency', '6'))
const ARM = arg('arm', 'thrift') // which arm report to reconstruct Q+A answers from
const MODEL = arg('model', process.env.FLOOR_ORACLE_MODEL || 'gpt-5.5') // oracle model (any nht-provider id)
const OUT_PATH = `/tmp/floor_calibration_${MODEL.replace(/[^a-z0-9.-]+/gi, '_')}.json`

// ── LB credential (runtime, redacted) ────────────────────────────────────────────────────────────────
const prov = (() => {
  const m = JSON.parse(readFileSync(`${homedir()}/.pi/agent/models.json`, 'utf8'))
  const p = m.providers?.nht
  if (!p?.baseUrl || !p?.apiKey)
    throw new Error('nht provider (baseUrl+apiKey) not found in ~/.pi/agent/models.json')
  // The cached model list can be stale — the LB is the real authority. Warn but don't block a model
  // that isn't listed (e.g. claude-haiku-4.5 is served but absent from the local cache).
  if (!p.models.some((x) => x.id === MODEL)) {
    console.warn(`[floor] note: '${MODEL}' not in cached nht list — trusting the LB to serve it`)
  }
  return { baseUrl: p.baseUrl, apiKey: p.apiKey }
})()

// ── SCORE PARITY with agent_runtime.ts ───────────────────────────────────────────────────────────────
function contentTokens(s) {
  const out = new Set()
  for (const m of s.toLowerCase().matchAll(/[a-z][a-z0-9]{3,}/g)) out.add(m[0])
  return out
}
function relevanceToQuery(text, queryTokens) {
  if (queryTokens.size === 0) return 0
  const tt = contentTokens(text)
  let shared = 0
  for (const q of queryTokens) if (tt.has(q)) shared++
  return shared / queryTokens.size
}

// ── load corpus (14 threads) + real answers (from an arm report) ────────────────────────────────────
const { STRESS_THREADS } = await import('./_stress_threads.mjs')

// answersByThreadTurn: reconstruct the real assistant answer per (threadName, withinThreadIndex)
function loadAnswers(arm) {
  const map = new Map() // key `${threadName}::${turnIdx}` → answer text
  try {
    for (const line of readFileSync(`/tmp/h2h_${arm}_report.jsonl`, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      // report row: {thread:"T1: the loop …", turn:<idx within thread>, prompt, answer}
      const threadName = o.thread
      if (threadName == null || o.turn == null) continue
      map.set(`${threadName}::${o.turn}`, o.answer || '')
    }
  } catch {
    /* no report → Q+A mode falls back to Q-only for missing answers */
  }
  return map
}
const answers = loadAnswers(ARM)

// ── mine candidate pairs: (query_i, prior_turn_j<i) within each thread ──────────────────────────────
// Emit BOTH pair-text variants per candidate: qOnly (prior Q) and qa (prior Q+"\n"+A).
const pairs = []
for (const thread of STRESS_THREADS) {
  const name = thread.name
  const turns = thread.turns
  for (let i = 1; i < turns.length; i++) {
    const qTokens = contentTokens(turns[i])
    for (let j = 0; j < i; j++) {
      const priorQ = turns[j]
      const priorA = answers.get(`${name}::${j}`) || ''
      const qaText = priorA ? `${priorQ}\n${priorA}` : priorQ
      pairs.push({
        thread: name,
        i,
        j,
        query: turns[i],
        priorQ,
        priorA,
        qaText,
        scoreQonly: relevanceToQuery(priorQ, qTokens),
        scoreQA: relevanceToQuery(qaText, qTokens),
      })
    }
  }
}

// ── stratified sample by score so labels span the full 0→1 range (not just the dense low end) ────────
// Stratify on the Q+A score (the runtime's real input); the same pairs carry their Q-only score too.
function stratifiedSample(all, key, n) {
  const buckets = new Map()
  for (const p of all) {
    const b = Math.min(9, Math.floor(p[key] / 0.05)) // 0.05-wide buckets, cap the tail
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(p)
  }
  const perBucket = Math.max(1, Math.ceil(n / buckets.size))
  const out = []
  // deterministic pseudo-shuffle per bucket (index-mixed; no Date/Math.random dependence for repeatability)
  for (const [b, arr] of [...buckets.entries()].sort((a, z) => a[0] - z[0])) {
    const shuffled = [...arr].sort(
      (x, y) => ((x.thread + x.i + x.j).length % 7) - ((y.thread + y.i + y.j).length % 7)
    )
    for (const p of shuffled.slice(0, perBucket)) out.push({ ...p, bucket: b })
  }
  return out
}
const sample = stratifiedSample(pairs, 'scoreQA', N_TARGET)

console.log(`[floor] mined ${pairs.length} candidate pairs across ${STRESS_THREADS.length} threads`)
console.log(`[floor] answers loaded from arm '${ARM}': ${answers.size} turns`)
console.log(
  `[floor] stratified sample: ${sample.length} pairs to label (both Q-only + Q+A) via ${MODEL}`
)

// ── gpt-5.5 relevance oracle (binary: is prior turn relevant to answering the query?) ────────────────
const SYS =
  "You are a strict relevance judge for a conversational AI assistant's context-management system. " +
  'Given a CURRENT user question and a PRIOR conversation turn, decide whether including that prior turn ' +
  "in the model's context would genuinely HELP answer the current question — i.e. it is topically relevant, " +
  'provides needed background, or is referenced (coreference/follow-up). If the prior turn is off-topic, ' +
  'redundant, or would only dilute attention (noise), it is NOT relevant. Judge relevance of CONTENT, not ' +
  'mere shared common words. Reply with EXACTLY one token: RELEVANT or NOISE.'

function labelPrompt(query, priorText) {
  return `CURRENT question:\n"""${query}"""\n\nPRIOR turn:\n"""${priorText}"""\n\nIs the PRIOR turn relevant to answering the CURRENT question? Reply exactly RELEVANT or NOISE.`
}

async function oracle(query, priorText) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${prov.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${prov.apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYS },
            { role: 'user', content: labelPrompt(query, priorText) },
          ],
          // 256 not 8: reasoning models (e.g. gemini-3.5-flash) spend hidden reasoning tokens BEFORE
          // emitting answer text — an 8-token cap truncates to empty (finish_reason:length, content:null).
          // Non-reasoning models (gpt-5.5) stop after the single RELEVANT/NOISE token regardless.
          max_tokens: 256,
          temperature: 0,
          stream: false,
        }),
      })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        // transport flake (502/429/503) → retry; other → record error
        if ([502, 429, 503, 500].includes(r.status)) {
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)))
          continue
        }
        return { label: null, err: `HTTP ${r.status} ${body.slice(0, 80)}` }
      }
      const j = await r.json()
      const txt = (j.choices?.[0]?.message?.content ?? '').trim().toUpperCase()
      if (txt.includes('RELEVANT')) return { label: 1 }
      if (txt.includes('NOISE')) return { label: 0 }
      return { label: null, err: `unparsed: ${txt.slice(0, 40)}` }
    } catch (e) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)))
      if (attempt === 2) return { label: null, err: String(e.message).slice(0, 80) }
    }
  }
  return { label: null, err: 'exhausted retries' }
}

// ── run the oracle over the sample, BOTH pair-text modes, bounded concurrency ────────────────────────
let done = 0
const total = sample.length * 2 // Q-only + Q+A per pair
async function labelOne(p) {
  const [qOnly, qa] = await Promise.all([oracle(p.query, p.priorQ), oracle(p.query, p.qaText)])
  p.labelQonly = qOnly.label
  p.labelQA = qa.label
  if (qOnly.err) p.errQonly = qOnly.err
  if (qa.err) p.errQA = qa.err
  done += 2
  if (done % 20 === 0 || done >= total) console.log(`[floor] labeled ${done}/${total}`)
}
async function runPool(items, worker, concurrency) {
  const q = [...items]
  const workers = Array.from({ length: concurrency }, async () => {
    while (q.length) await worker(q.shift())
  })
  await Promise.all(workers)
}
await runPool(sample, labelOne, CONCURRENCY)

// ── build the ROC/PR curve for each mode + read the operating points ─────────────────────────────────
function curve(labeled, scoreKey, labelKey) {
  const pts = labeled
    .filter((p) => p[labelKey] != null)
    .map((p) => ({ s: p[scoreKey], y: p[labelKey] }))
  const P = pts.filter((p) => p.y === 1).length
  const Nn = pts.filter((p) => p.y === 0).length
  // sweep candidate thresholds across the observed score range
  const thresholds = [...new Set([0, ...pts.map((p) => +p.s.toFixed(4)), 1])].sort((a, b) => a - b)
  let bestF1 = { thr: 0, f1: -1, prec: 0, rec: 0 }
  let bestJ = { thr: 0, j: -1, tpr: 0, fpr: 0 }
  let highPrec = null // lowest threshold reaching precision >= 0.9
  const rows = []
  for (const thr of thresholds) {
    // KEEP a turn iff score >= thr → prediction "relevant". TP = kept & truly relevant.
    let tp = 0,
      fp = 0,
      fn = 0,
      tn = 0
    for (const p of pts) {
      const keep = p.s >= thr
      if (keep && p.y === 1) tp++
      else if (keep && p.y === 0) fp++
      else if (!keep && p.y === 1) fn++
      else tn++
    }
    const prec = tp + fp ? tp / (tp + fp) : 1
    const rec = tp + fn ? tp / (tp + fn) : 0
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0
    const tpr = P ? tp / P : 0
    const fpr = Nn ? fp / Nn : 0
    const jstat = tpr - fpr
    rows.push({
      thr: +thr.toFixed(4),
      prec: +prec.toFixed(3),
      rec: +rec.toFixed(3),
      f1: +f1.toFixed(3),
      tpr: +tpr.toFixed(3),
      fpr: +fpr.toFixed(3),
    })
    if (f1 > bestF1.f1)
      bestF1 = {
        thr: +thr.toFixed(4),
        f1: +f1.toFixed(3),
        prec: +prec.toFixed(3),
        rec: +rec.toFixed(3),
      }
    if (jstat > bestJ.j)
      bestJ = {
        thr: +thr.toFixed(4),
        j: +jstat.toFixed(3),
        tpr: +tpr.toFixed(3),
        fpr: +fpr.toFixed(3),
      }
    if (highPrec == null && prec >= 0.9 && tp > 0) highPrec = +thr.toFixed(4)
  }
  return { P, N: Nn, bestF1, bestJ, highPrecThreshold: highPrec, rows }
}

const qaCurve = curve(sample, 'scoreQA', 'labelQA')
const qOnlyCurve = curve(sample, 'scoreQonly', 'labelQonly')

const out = {
  model: MODEL,
  arm: ARM,
  minedPairs: pairs.length,
  sampled: sample.length,
  operatingPoint: 'balanced (F1 / Youden J) — user choice',
  recommend: {
    // FLOOR_MIN = the F1-optimal separation (balanced). FLOOR_MAX = high-precision (strict, tight-window).
    Q_plus_A: {
      FLOOR_MIN_f1: qaCurve.bestF1.thr,
      FLOOR_MIN_youdenJ: qaCurve.bestJ.thr,
      FLOOR_MAX_highPrecision: qaCurve.highPrecThreshold,
    },
    Q_only: {
      FLOOR_MIN_f1: qOnlyCurve.bestF1.thr,
      FLOOR_MIN_youdenJ: qOnlyCurve.bestJ.thr,
      FLOOR_MAX_highPrecision: qOnlyCurve.highPrecThreshold,
    },
    todays_floor: 0.08,
  },
  qaCurve,
  qOnlyCurve,
  labeledSample: sample.map((p) => ({
    thread: p.thread,
    i: p.i,
    j: p.j,
    scoreQonly: +p.scoreQonly.toFixed(4),
    scoreQA: +p.scoreQA.toFixed(4),
    labelQonly: p.labelQonly,
    labelQA: p.labelQA,
    query: p.query.slice(0, 80),
    prior: p.priorQ.slice(0, 60),
  })),
}
writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

// ── report ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\n=== FLOOR CALIBRATION (gpt-5.5 relevance oracle, balanced/F1) ===')
console.log(
  `labeled: Q+A ${qaCurve.P + qaCurve.N} usable, Q-only ${qOnlyCurve.P + qOnlyCurve.N} usable`
)
console.log(`\nQ+A  (exact runtime input):`)
console.log(
  `  FLOOR_MIN (F1-opt) = ${qaCurve.bestF1.thr}  [prec ${qaCurve.bestF1.prec} rec ${qaCurve.bestF1.rec} f1 ${qaCurve.bestF1.f1}]`
)
console.log(`  FLOOR_MIN (YoudenJ)= ${qaCurve.bestJ.thr}`)
console.log(`  FLOOR_MAX (prec≥.9)= ${qaCurve.highPrecThreshold}`)
console.log(`\nQ-only (model-agnostic):`)
console.log(
  `  FLOOR_MIN (F1-opt) = ${qOnlyCurve.bestF1.thr}  [prec ${qOnlyCurve.bestF1.prec} rec ${qOnlyCurve.bestF1.rec} f1 ${qOnlyCurve.bestF1.f1}]`
)
console.log(`  FLOOR_MIN (YoudenJ)= ${qOnlyCurve.bestJ.thr}`)
console.log(`  FLOOR_MAX (prec≥.9)= ${qOnlyCurve.highPrecThreshold}`)
console.log(`\ntoday's fixed floor = 0.08`)
console.log(`\nfull curves + labeled sample → ${OUT_PATH}`)
