// Head-to-head PEEK table — the canonical status view for the token-thrift comparison.
// thrift vs compact vs naive, across contestant models. `*` = arm/quality incomplete (<94), `—` = no data.
// Reads the live /tmp/h2h2/<tag>_<arm>_report.jsonl + _dump.jsonl + judge logs. Run: node research/h2h_peek.mjs
import { createInterface } from 'node:readline'
import { readFileSync, existsSync, createReadStream } from 'node:fs'

// Post-scaled-floor RE-RUN matrix (see research/h2h_rerun.mjs). Reads /tmp/h2h2/<tag>_<arm>_*.jsonl.
const MODELS = [
  { tag: 'e2b_8k', label: 'gemma e2b', cfg: '8k/512' },
  { tag: '31b_32k', label: 'gemma 31b', cfg: '32k/512 (win-ctrl LO)' },
  { tag: '31b_128k', label: 'gemma 31b', cfg: '128k/512 (win-ctrl HI)' },
  { tag: 'kimi_128k', label: 'kimi-k2.5', cfg: '128k/4k' },
  { tag: 'gemini_1m', label: 'gemini-flash', cfg: '1M/8k' },
  // glm52_do dropped — DO route has only 1 credential, no failover; both thrift and compact arms hit
  // sustained "No available credential" 503 cascades. See research/h2h_rerun.mjs for the full note.
]
const ARMS = ['thrift', 'compact', 'naive']

// Dump files can exceed Node's ~536MB max-string length (gemini_1m/naive is 912MB) — a whole-file
// readFileSync throws ERR_STRING_TOO_LONG, and a bare try/catch around it silently zeroes the stats
// instead of surfacing the failure. Stream line-by-line so size is never a ceiling.
async function readDumpStats(path) {
  let inT = 0,
    outT = 0,
    disp = 0,
    sN = 0
  if (!existsSync(path)) return { inT, outT, disp, sN }
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
  for await (const l of rl) {
    if (!l) continue
    let o
    try {
      o = JSON.parse(l)
    } catch {
      continue
    }
    // Token stats differ by transport. Ollama: raw is one JSON object with prompt_eval_count/eval_count.
    // OpenAI (gemini): raw is SSE text; the usage block ({prompt_tokens, completion_tokens}) rides the
    // final chunk. Handle both — try Ollama's flat parse first, else scrape the SSE usage object.
    const rawStr = typeof o.raw === 'string' ? o.raw : ''
    let din = 0
    let dout = 0
    let parsed = null
    try {
      parsed = JSON.parse(rawStr)
    } catch {
      /* not a single JSON object → SSE */
    }
    if (parsed && (parsed.prompt_eval_count != null || parsed.eval_count != null)) {
      din = parsed.prompt_eval_count || 0
      dout = parsed.eval_count || 0
    } else {
      // OpenAI SSE / non-stream: take the LAST usage object in the raw (final chunk carries the totals).
      const matches = [...rawStr.matchAll(/"usage":\s*(\{[^}]*\})/g)]
      if (matches.length) {
        try {
          const u = JSON.parse(matches[matches.length - 1][1])
          din = u.prompt_tokens || 0
          dout = u.completion_tokens || 0
        } catch {
          /* leave 0 */
        }
      }
    }
    if (din === 0 && dout === 0) continue // no usable stats on this dispatch
    inT += din
    outT += dout
    disp++
    const sy = o.request?.messages?.[0]?.content ?? ''
    if (/create a detailed summary/i.test(sy)) sN++
  }
  return { inT, outT, disp, sN }
}

async function armStats(tag, arm) {
  const rp = `/tmp/h2h2/${tag}_${arm}_report.jsonl`
  if (!existsSync(rp)) return null
  const R = readFileSync(rp, 'utf8')
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
  if (!R.length) return { done: 0 }
  let set = 0,
    err = 0
  for (const o of R) {
    if (o.error) err++
    // Real `settled` boolean now on the row (committed clean answer: non-empty, not refused, no failure
    // flags). Falls back to the old !error inference for legacy reports lacking the field.
    if (o.settled === true || (o.settled === undefined && !o.error)) set++
  }
  const { inT, outT, disp, sN } = await readDumpStats(`/tmp/h2h2/${tag}_${arm}_dump.jsonl`)
  return {
    done: R.length,
    set,
    err,
    disp,
    tot: inT + outT,
    tokAns: set ? Math.round((inT + outT) / set) : 0,
    summ: sN,
  }
}

// Quality source, in priority order:
//  1. FINAL judgement JSON for the cell (/tmp/h2h2/judgement_<tag>.json) — written once ALL turns are
//     scored, agg.perArm already computed by judge_committee.mjs regardless of committee size (1 judge
//     solo, e.g. the gpt-5.5-only pass, or the full 3-judge committee). Authoritative when present.
//  2. LIVE in-progress log — judge_committee.mjs prints "[judge] i/94 key :: <judge>[tX/cX/nX] ..." per
//     turn as it runs; one bracket group per judge on the line. The bracket regex below matches EVERY
//     group regardless of how many judges precede it, so a live 1-judge or 3-judge run parses identically.
//     Filename varies by how the run was launched — try the gpt-5.5-solo naming, an exact-tag name, and the
//     short-name fallback used by the original e2b/kimi runs (judge_e2b.log / judge_kimi.log).
function qual(tag) {
  const jsonPath = `/tmp/h2h2/judgement_${tag}.json`
  if (existsSync(jsonPath)) {
    try {
      const j = JSON.parse(readFileSync(jsonPath, 'utf8'))
      const perArm = j.agg?.perArm || {}
      const fmt = (v) => (v == null ? '-' : v.toFixed(2))
      return {
        n: j.perTurn?.length || 0,
        thrift: fmt(perArm.thrift),
        compact: fmt(perArm.compact),
        naive: fmt(perArm.naive),
        judges: j.judges || [],
        final: true,
      }
    } catch {
      /* corrupt/partial JSON — fall through to live log */
    }
  }
  const candidates = [
    `/tmp/h2h2/judge_gpt55_${tag}.log`,
    `/tmp/h2h2/judge_${tag}.log`,
    `/tmp/h2h2/judge_${tag.split('_')[0]}.log`,
  ]
  const lf = candidates.find(existsSync)
  if (!lf) return null
  const L = readFileSync(lf, 'utf8')
    .split('\n')
    .filter((l) => /\[judge\] \d+\/94/.test(l))
  if (!L.length) return { n: 0 }
  const a = { thrift: [], compact: [], naive: [] }
  // Judge names are the 4-char prefix before each bracket group (e.g. "gpt-[t2/c2/n1]" → "gpt-",
  // "deep[...]" → "deep", "opus[...]" → "opus") — read them off the first scored line so the coverage
  // footer names who actually ran, whether this was a 1-judge solo pass or the full 3-judge committee.
  const judgeNames = new Set()
  for (const l of L)
    for (const m of l.matchAll(/(\S{1,4})\[t(\d|\?)\/c(\d|\?)\/n(\d|\?)\]/g)) {
      judgeNames.add(m[1])
      if (m[2] !== '?') a.thrift.push(+m[2])
      if (m[3] !== '?') a.compact.push(+m[3])
      if (m[4] !== '?') a.naive.push(+m[4])
    }
  const mn = (x) => (x.length ? (x.reduce((p, c) => p + c, 0) / x.length).toFixed(2) : '-')
  return {
    n: L.length,
    thrift: mn(a.thrift),
    compact: mn(a.compact),
    naive: mn(a.naive),
    final: false,
    judges: [...judgeNames],
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log('')
console.log(
  'TOKEN-THRIFT HEAD-TO-HEAD  (thrift vs compact vs naive; * = incomplete <94; — = no data)'
)
console.log('='.repeat(109))
console.log(
  pad('model / config', 26) +
    pad('arm', 9) +
    pad('turns', 8) +
    pad('ok/err', 9) +
    pad('disp', 7) +
    pad('totalTok', 11) +
    pad('tok/ans', 10) +
    pad('quality*', 9)
)
console.log('-'.repeat(109))
for (const m of MODELS) {
  const q = qual(m.tag)
  for (const [i, arm] of ARMS.entries()) {
    const s = await armStats(m.tag, arm)
    const head = i === 0 ? pad(m.label, 17) + pad(m.cfg, 9) : pad('', 26)
    if (!s) {
      console.log(head + pad(arm, 9) + '  — (not launched)')
      continue
    }
    if (!s.done) {
      console.log(head + pad(arm, 9) + '  — (booting)')
      continue
    }
    const inc = s.done < 94 ? '*' : ' '
    const qv =
      q && q.n
        ? { thrift: q.thrift, compact: q.compact, naive: q.naive }[arm] + (q.n < 94 ? '*' : '')
        : '—'
    const tokAns = s.set ? (s.tokAns / 1000).toFixed(0) + 'k' : '—'
    console.log(
      head +
        pad(arm, 9) +
        pad(s.done + '/94' + inc, 8) +
        pad(s.set + '/' + s.err, 9) +
        pad(s.disp, 7) +
        pad((s.tot / 1e6).toFixed(2) + 'M', 11) +
        pad(tokAns, 10) +
        pad(qv, 9)
    )
  }
  console.log('-'.repeat(109))
}
console.log(
  '* quality = blind doc-verifying committee mean 0-3; trailing * = partial (n<94). Committee size/members vary per cell (see coverage lines).'
)
for (const m of MODELS) {
  const q = qual(m.tag)
  if (q && q.n) {
    const status = q.final ? 'FINAL' : 'live/partial'
    const who = q.judges?.length
      ? ` [${q.judges.join(', ')}${q.final ? '' : ' — abbrev. from log'}]`
      : ''
    console.log(`  judge coverage ${m.tag}: ${q.n}/94 turns (${status})${who}`)
  }
}
