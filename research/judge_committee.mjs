// Blind committee judge for the token-thrift head-to-head (thrift vs compact vs naive).
//
// Reads the three arms' corpus reports (/tmp/h2h_<arm>_report.jsonl), pairs answers PER TURN, ANONYMISES
// the arm identity (shuffles thrift/compact/naive into A/B/C per turn with a per-turn key), and asks a
// 3-model committee — deepseek-v4-pro, gpt-5.5, glm-5.1 (via `pi`, one call per judge per turn) — to score
// each answer 0-3 for correctness + grounding against the ADK docs. The judge is BLIND: it never sees which
// arm is which, and the A/B/C order is reshuffled every turn so position carries no signal.
//
// Scoring rubric (0-3): 0 = wrong/empty/refused-when-answerable, 1 = partially correct but missing key
// detail, 2 = correct + grounded, 3 = correct + grounded + complete. The judge answers with strict lines
// "SCORE_A: n" / "SCORE_B: n" / "SCORE_C: n" so parsing is deterministic (text mode, no JSON-soup).
//
// Output: /tmp/h2h_judgement.json — per-turn per-judge scores mapped BACK to arms, plus aggregates
// (mean score per arm, per-judge means, win/tie/loss counts, inter-judge agreement). Also prints a summary.
//
// Usage: node research/judge_committee.mjs   (arms must have finished; pi must be authed to the nht provider)

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'

// PAUSE LEVER: while this file exists, the judge loop blocks BETWEEN turns (never mid-turn, so no turn is
// left half-scored). `touch $JUDGE_PAUSE_FILE` to pause after the current turn; `rm` it to resume exactly
// where it stopped. Default /tmp/h2h2/JUDGE_PAUSE; override with JUDGE_PAUSE_FILE. Checked at the top of
// each turn. This is the clean, resumable alternative to SIGSTOP (which would freeze in-flight child pi/
// claude processes and let their 420s timeout corrupt the in-progress turn).
const PAUSE_FILE = process.env.JUDGE_PAUSE_FILE || '/tmp/h2h2/JUDGE_PAUSE'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitIfPaused() {
  let announced = false
  while (existsSync(PAUSE_FILE)) {
    if (!announced) {
      console.log(`[judge] PAUSED (found ${PAUSE_FILE}) — remove it to resume`)
      announced = true
    }
    await sleep(3000)
  }
  if (announced) console.log('[judge] RESUMED')
}

// execFile does NOT resolve via the interactive-shell PATH (pi lives under an nvm bin dir), so a bare
// 'pi' silently fails to spawn. Resolve the absolute path once via the login shell.
const PI_BIN = (() => {
  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v pi'], { encoding: 'utf8' }).trim()
  } catch {
    return 'pi'
  }
})()
// Same resolution for the `claude` CLI (Claude Code headless). Used for the Opus judge seat: instead of
// routing Opus as a model string through pi/the LB, we spawn a FRESH `claude -p` process per judge call.
// The point is arms-length grading — a fresh headless process shares NONE of the orchestrating session's
// context (no knowledge of which arm is thrift, the fix, or the thesis); it sees only the blind A/B/C prompt
// and read-only docs, exactly like the pi judges. Same model family as the operator session, zero shared
// state → it judges the artifact, not the author.
const CLAUDE_BIN = (() => {
  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim()
  } catch {
    return 'claude'
  }
})()
// A judge name is routed to the `claude` CLI (not pi) when it names Opus/Claude via the alias or a full id.
const isClaudeJudge = (m) => /^(opus|sonnet|haiku|fable|claude)/i.test(m)

// Run pi and RESOLVE when it exits. CRITICAL: pi spawned without a TTY waits on stdin — we must CLOSE the
// child's stdin (c.stdin.end()) or it hangs forever. The promisified execFile gives no child handle to do
// that, so we wrap the callback form ourselves.
function runPi(args, timeoutMs) {
  return new Promise((resolve) => {
    const c = execFile(PI_BIN, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err) =>
      resolve({ err })
    )
    if (c.stdin) c.stdin.end()
  })
}

// Run `claude -p` (Claude Code headless) and RESOLVE with its stdout. Unlike pi, `claude -p --output-format
// text` prints the final answer straight to stdout, so we capture it directly (no session-file dance).
// stdin is closed immediately — a TTY-less claude warns and waits ~3s for stdin otherwise (harmless but slow
// at 94×cells calls). The judge runs from the repo root, so its read-only Read/Grep/Glob tools reach ./docs/
// natively (no --add-dir needed). Bypasses permission prompts headlessly with the read-only tool allowlist.
function runClaude(args, timeoutMs) {
  return new Promise((resolve) => {
    const c = execFile(
      CLAUDE_BIN,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ err, stdout: stdout || '' })
    )
    if (c.stdin) c.stdin.end()
  })
}

const ARMS = ['thrift', 'compact', 'naive']
// JUDGE_MODELS overrides the committee (comma-separated) — e.g. JUDGE_MODELS=gpt-5.5 for a single-grader
// run that pushes one consistent judge to full depth without the coverage imbalance of a partial committee.
const JUDGES = process.env.JUDGE_MODELS
  ? process.env.JUDGE_MODELS.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : ['deepseek-v4-pro', 'gpt-5.5', 'glm-5.1']
// H2H_TAG selects the contestant model's run set: '' → 31b (/tmp/h2h_<arm>_...), else 'kimi'/'gptoss'/'qwen'
// → /tmp/h2h_<tag>_<arm>_... . Lets one script judge any contestant.
// H2H_DIR + H2H_CELL support the RE-RUN layout (/tmp/h2h2/<cell>_<arm>_report.jsonl): set H2H_DIR=/tmp/h2h2
// and H2H_CELL=e2b_8k to judge that cell. Falls back to the original /tmp/h2h_<TAG><arm> scheme when unset,
// so the old invocation still works untouched.
const TAG = process.env.H2H_TAG ? `${process.env.H2H_TAG}_` : ''
const H2H_DIR = process.env.H2H_DIR || '/tmp'
const CELL = process.env.H2H_CELL || null // e.g. 'e2b_8k' — the re-run cell tag
const REPORT = (arm) =>
  CELL ? `${H2H_DIR}/${CELL}_${arm}_report.jsonl` : `${H2H_DIR}/h2h_${TAG}${arm}_report.jsonl`
const DUMP = (arm) =>
  CELL ? `${H2H_DIR}/${CELL}_${arm}_dump.jsonl` : `${H2H_DIR}/h2h_${TAG}${arm}_dump.jsonl`
const OUT = CELL
  ? `${H2H_DIR}/judgement_${CELL}.json`
  : `/tmp/h2h_judgement${TAG ? '_' + process.env.H2H_TAG : '_31b'}.json`
// pi doesn't like having its stdout redirected/captured — instead let it SAVE a session and read the
// assistant's final answer back from the session JSONL. Dedicated session dir so we can find the file.
const JUDGE_SESSION_DIR = '/tmp/h2h_judge_sessions'
mkdirSync(JUDGE_SESSION_DIR, { recursive: true })
let judgeCallSeq = 0

/** Read the final assistant text block out of a pi session JSONL (the robust alternative to stdout capture). */
function readSessionFinalText(sessionId) {
  // pi nests session files under <dir>/--<slugged-cwd>--/<timestamp>_<sessionId>.jsonl. Find the newest
  // file whose name contains the sessionId.
  const stack = [JUDGE_SESSION_DIR]
  let best = null
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) stack.push(p)
      else if (e.name.includes(sessionId) && e.name.endsWith('.jsonl')) best = p
    }
  }
  if (!best) return ''
  let finalText = ''
  for (const line of readFileSync(best, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const m = o.message || o
    if (m.role === 'assistant') {
      const c = m.content
      if (Array.isArray(c)) {
        for (const b of c) if (b.type === 'text' && b.text) finalText = b.text
      } else if (typeof c === 'string' && c.trim()) finalText = c
    }
  }
  return finalText
}

// Deterministic per-turn shuffle so the anonymised A/B/C order is stable + reproducible but position-neutral.
function shuffleForKey(arr, key) {
  const out = [...arr]
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) >>> 0
    const j = h % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function loadArm(arm) {
  const rows = readFileSync(REPORT(arm), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const byKey = new Map()
  for (const r of rows) byKey.set(`${r.thread}::${r.turn}`, r)
  return byKey
}

async function askJudge(model, prompt) {
  // ASYNC (execFile promise) so the 3 committee judges score EACH turn CONCURRENTLY (they are independent
  // models — no reason to serialise them). Read-only doc access so the judge open/grep/finds the authored
  // ADK docs to VERIFY grounding itself. Response read from the SAVED SESSION file, not stdout (pi dislikes
  // stdout redirection). Retry once. Contestant MODELS are still processed serially (one model's judging at
  // a time); only the 3 judges WITHIN a turn run in parallel.
  //
  // CLAUDE-CLI SEAT: a judge named opus/sonnet/haiku/claude* runs via a fresh `claude -p` headless process
  // instead of pi. It captures stdout directly (claude prints the final answer there in text mode). Same
  // blind prompt, same read-only doc access (Read/Grep/Glob reach ./docs/ from cwd), same SCORE_A/B/C
  // contract → the parse + aggregate path below is identical regardless of which CLI produced the text.
  if (isClaudeJudge(model)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { err, stdout } = await runClaude(
        [
          '-p',
          '--model',
          model,
          '--allowed-tools',
          'Read,Grep,Glob',
          '--permission-mode',
          'plan', // read-only: never edits/writes/executes, just reads docs to verify grounding
          '--output-format',
          'text',
          prompt,
        ],
        420_000
      )
      if (stdout.trim()) return stdout
      if (attempt === 1)
        return `__JUDGE_ERROR__ ${err ? String(err.message).slice(0, 100) : 'empty stdout'}`
    }
    return '__JUDGE_ERROR__ unreachable'
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionId = `judge-${Date.now()}-${judgeCallSeq++}-${Math.random().toString(36).slice(2, 7)}`
    const { err } = await runPi(
      [
        '-p',
        '--tools',
        'read,grep,find,ls',
        '--session-dir',
        JUDGE_SESSION_DIR,
        '--session-id',
        sessionId,
        '--mode',
        'text',
        '--provider',
        'nht',
        '--model',
        model,
        prompt,
      ],
      420_000
    )
    // pi may have written the session even on a non-zero exit — always try to read it.
    const text = readSessionFinalText(sessionId)
    if (text.trim()) return text
    if (attempt === 1)
      return `__JUDGE_ERROR__ ${err ? String(err.message).slice(0, 100) : 'empty session'}`
  }
  return '__JUDGE_ERROR__ unreachable'
}

function parseScores(text) {
  // Extract SCORE_A/B/C: n. Tolerant of surrounding prose; takes the LAST occurrence of each (in case the
  // model restates). Capture ANY integer (not just 0-3) so an out-of-range score is DETECTED, not silently
  // dropped to null — a judge that emits "8" is misbehaving and we want to see it. Clamp valid 0-3; anything
  // else → null (unparseable/out-of-range, excluded from aggregates).
  const grab = (letter) => {
    const m = [...text.matchAll(new RegExp(`SCORE_${letter}\\s*[:=]\\s*(\\d+)`, 'gi'))]
    if (!m.length) return null
    const n = Number(m[m.length - 1][1])
    return n >= 0 && n <= 3 ? n : null
  }
  return { A: grab('A'), B: grab('B'), C: grab('C') }
}

const RUBRIC =
  'You are grading answers from a documentation assistant for the "@nhtio/adk" TypeScript agent framework. ' +
  'For the SAME user question you are given three candidate answers labelled A, B, and C (from different ' +
  'context-management strategies — you are NOT told which).\n\n' +
  'VERIFY, do not guess: the authored ADK documentation is available to you on disk under ./docs/ — ' +
  'specifically ./docs/the-loop/, ./docs/assembly/, ./docs/batteries/, and ./docs/developer-tools/ (Markdown ' +
  'files). USE your read/grep/find tools to check each answer against the real docs before scoring — find the ' +
  'relevant page(s) for the question and confirm whether each answer is actually correct, not merely ' +
  'plausible. An answer that SOUNDS grounded but contradicts the docs must score low; a terse answer that is ' +
  'CORRECT per the docs must not be penalised for brevity.\n\n' +
  'Score EACH answer 0-3 on correctness + grounding against what the docs actually say:\n' +
  '0 = wrong, empty, or refuses a question the docs do answer.\n' +
  '1 = partially correct but misses a key detail the docs cover, or is vague.\n' +
  '2 = correct and grounded in what the docs actually say.\n' +
  '3 = correct, grounded, AND complete (covers what the question asked, per the docs).\n' +
  'Do not reward length. If the docs genuinely do not cover the question, an honest "I do not know" is ' +
  'CORRECT (score it 2-3), and a confident fabricated answer is wrong (score 0).\n' +
  'After verifying, output EXACTLY three lines and nothing else:\n' +
  'SCORE_A: <0-3>\nSCORE_B: <0-3>\nSCORE_C: <0-3>'

async function main() {
  const arms = Object.fromEntries(ARMS.map((a) => [a, loadArm(a)]))
  // Turn keys present in ALL arms (a fair head-to-head needs all three to have answered the turn).
  let allKeys = [...arms.thrift.keys()].filter((k) => ARMS.every((a) => arms[a].has(k)))
  // JUDGE_LIMIT caps the number of turns judged — for a cheap preflight of the wiring before the full run.
  const LIMIT = process.env.JUDGE_LIMIT ? parseInt(process.env.JUDGE_LIMIT, 10) : null
  if (LIMIT && LIMIT > 0) allKeys = allKeys.slice(0, LIMIT)
  console.log(
    `[judge] ${allKeys.length} turns present in all ${ARMS.length} arms${LIMIT ? ` (LIMIT=${LIMIT})` : ''}`
  )

  const perTurn = []
  let idx = 0
  for (const key of allKeys) {
    await waitIfPaused() // block between turns while the pause file exists (never mid-turn)
    idx++
    const rows = Object.fromEntries(ARMS.map((a) => [a, arms[a].get(key)]))
    const prompt = rows.thrift.prompt
    // Anonymise: map A/B/C → arm for THIS turn.
    const order = shuffleForKey(ARMS, key) // e.g. ['naive','thrift','compact']
    const labelToArm = { A: order[0], B: order[1], C: order[2] }
    const ans = (arm) => (rows[arm].answer || rows[arm].error || '(no answer)').slice(0, 2500)
    const block =
      `USER QUESTION:\n${prompt}\n\n` +
      `ANSWER A:\n${ans(labelToArm.A)}\n\n` +
      `ANSWER B:\n${ans(labelToArm.B)}\n\n` +
      `ANSWER C:\n${ans(labelToArm.C)}\n\n${RUBRIC}`
    const turnResult = { key, prompt, labelToArm, judges: {} }
    const armOf = (parsed, arm) =>
      parsed[Object.keys(labelToArm).find((L) => labelToArm[L] === arm)] ?? null
    // The 3 committee judges are independent models — score this turn CONCURRENTLY (parallel judges),
    // then move to the next turn. Contestant models are still processed one script-run at a time.
    const parsedByJudge = await Promise.all(JUDGES.map((j) => askJudge(j, block).then(parseScores)))
    JUDGES.forEach((judge, ji) => {
      const parsed = parsedByJudge[ji]
      turnResult.judges[judge] = {
        thrift: armOf(parsed, 'thrift'),
        compact: armOf(parsed, 'compact'),
        naive: armOf(parsed, 'naive'),
      }
    })
    perTurn.push(turnResult)
    const s = JUDGES.map(
      (j) =>
        `${j.slice(0, 4)}[t${turnResult.judges[j].thrift ?? '?'}/c${turnResult.judges[j].compact ?? '?'}/n${turnResult.judges[j].naive ?? '?'}]`
    ).join(' ')
    console.log(`[judge] ${idx}/${allKeys.length} ${key} :: ${s}`)
  }

  // Aggregate: mean per arm (across all judges + turns), per-judge mean per arm.
  const agg = { perArm: {}, perJudgeArm: {} }
  for (const arm of ARMS) {
    const vals = []
    for (const t of perTurn)
      for (const j of JUDGES) if (t.judges[j][arm] != null) vals.push(t.judges[j][arm])
    agg.perArm[arm] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  for (const j of JUDGES) {
    agg.perJudgeArm[j] = {}
    for (const arm of ARMS) {
      const vals = perTurn.map((t) => t.judges[j][arm]).filter((v) => v != null)
      agg.perJudgeArm[j][arm] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    }
  }
  // Per-turn win/tie/loss for thrift vs the best baseline (median-of-judges per arm).
  const median = (xs) => {
    const s = xs.filter((v) => v != null).sort((a, b) => a - b)
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null
  }
  let tWin = 0,
    tTie = 0,
    tLoss = 0
  for (const t of perTurn) {
    const m = Object.fromEntries(ARMS.map((a) => [a, median(JUDGES.map((j) => t.judges[j][a]))]))
    const bestBaseline = Math.max(m.compact ?? -1, m.naive ?? -1)
    if (m.thrift == null) continue
    if (m.thrift > bestBaseline) tWin++
    else if (m.thrift === bestBaseline) tTie++
    else tLoss++
  }
  agg.thriftVsBestBaseline = { win: tWin, tie: tTie, loss: tLoss }

  // REAL token cost — ground truth from the engine (prompt_eval_count + eval_count on every dispatch's raw
  // Ollama response), summed per arm from the dispatch dump. This is the ACTUAL bill, not an estimate. The
  // summariser dispatches (compact arm) are isolable by their compaction system prompt, so we split them out.
  const tokenCost = {}
  const settledCount = {}
  for (const arm of ARMS) {
    let inTok = 0,
      outTok = 0,
      disp = 0,
      summIn = 0,
      summOut = 0,
      summN = 0
    try {
      const lines = readFileSync(DUMP(arm), 'utf8').split('\n').filter(Boolean)
      for (const l of lines) {
        let o
        try {
          o = JSON.parse(l)
        } catch {
          continue
        }
        let r = o.raw
        if (typeof r === 'string') {
          try {
            r = JSON.parse(r)
          } catch {
            r = null
          }
        }
        if (!r) continue
        const pin = r.prompt_eval_count || 0
        const pout = r.eval_count || 0
        inTok += pin
        outTok += pout
        disp++
        const sys = o.request?.messages?.[0]?.content ?? ''
        if (/create a detailed summary of the conversation/i.test(sys)) {
          summIn += pin
          summOut += pout
          summN++
        }
      }
    } catch {
      /* dump missing */
    }
    // Settled answers for the tokens-per-answer normalization.
    const settled = [...arms[arm].values()].filter((r) => !r.error && r.settled !== false).length
    settledCount[arm] = settled
    tokenCost[arm] = {
      dispatches: disp,
      inputTok: inTok,
      outputTok: outTok,
      totalTok: inTok + outTok,
      summariserCalls: summN,
      summariserTok: summIn + summOut,
      tokPerSettled: settled ? Math.round((inTok + outTok) / settled) : null,
    }
  }

  const out = {
    model: CELL || 'gemma4:31b @8k/512',
    judges: JUDGES,
    arms: ARMS,
    agg,
    tokenCost,
    perTurn,
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log('\n=== QUALITY (blind committee mean 0-3, higher = better) ===')
  for (const arm of ARMS) console.log(`  ${arm.padEnd(8)} ${agg.perArm[arm]?.toFixed(3) ?? 'n/a'}`)
  console.log('\n=== thrift vs best baseline (per-turn, median-of-judges) ===')
  console.log(`  win ${tWin} / tie ${tTie} / loss ${tLoss}`)
  console.log('\n=== REAL TOKEN COST (engine ground-truth: prompt_eval + eval per dispatch) ===')
  console.log('  arm       dispatches   totalTok   tok/settled   summariser')
  for (const arm of ARMS) {
    const c = tokenCost[arm]
    console.log(
      `  ${arm.padEnd(8)} ${String(c.dispatches).padStart(9)} ${String(c.totalTok).padStart(11)} ${String(c.tokPerSettled ?? '?').padStart(12)}   ${c.summariserCalls} calls / ${c.summariserTok} tok`
    )
  }
  console.log(`\nfull judgement: ${OUT}`)
}

main().catch((e) => {
  console.error('judge failed:', e)
  process.exit(1)
})
