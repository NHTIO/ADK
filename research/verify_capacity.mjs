// Headed real-GPU verifier for the capacity_scoped answer_kind (Gemma 4 E2B / LiteRT-web / WebGPU).
// Loads the model ONCE and, per turn, captures plan kind + tool chips + committed answer (bubble + KaTeX) +
// a wiretap dump. Confirms an EXHAUSTIVE ask commits capacity_scoped (honest "I'm a small on-device model
// capped at N tokens" + real cites), a broad-but-answerable ask stays doc_cited/brief (no over-trigger),
// and the standing regressions hold (greeting conversational, math tool_computed+correct).
//
// Usage: node research/verify_capacity.mjs   (preview must be serving on http://localhost:4180)

import { chromium } from 'playwright'

const BASE = 'http://localhost:4180/showcase/token-thrift'
const t0 = Date.now()
const log = (obj) =>
  console.log(JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), ...obj }))
// SwiftShader (headless software WebGPU) is ~10-30x slower than real GPU. A multi-iteration doc-synth turn
// runs 4-6 LLM generations, so give each turn a very generous ceiling and detect completion by the
// utilization meter UPDATING (a dispatch finished) rather than a fixed sleep.
// Real GPU: a turn is ~30-90s (multi-iteration doc-synth). Give generous headroom but not the SwiftShader
// ceiling — a genuine hang should surface in minutes, not 25.
const TURN_DEADLINE_MS = 420_000 // 7 min per turn cap (real GPU)
const LOAD_DEADLINE_MS = 300_000 // 5 min model-load cap (real GPU cold ~2GB)

// The corpus, as ordered threads. Each thread is a fresh conversation (Clear between threads); turns
// within a thread build on each other (coref matters).
// Each prompt is its OWN thread (clearConversation runs before each) so these INDEPENDENT single-turn checks
// don't bleed context into one another (an exhaustive turn's huge context must not derail the next turn).
const THREADS = [
  // over-scope → should commit capacity_scoped (honest decline + real cap + cites)
  {
    name: 'CAP#0 over-scope (expect capacity_scoped)',
    turns: [
      'Give me a truly exhaustive, complete reference of every trust tier and every single battery category in @nhtio/adk, with examples for each — leave nothing out.',
    ],
  },
  // control: broad but ANSWERABLE → should stay doc_cited/brief, NOT over-trigger the decline
  {
    name: 'CAP#1 control broad-answerable (expect doc_cited, NOT capacity_scoped)',
    turns: ['what are the important parts that I need to know upfront?'],
  },
  // regressions
  { name: 'CAP#2 greeting (expect conversational)', turns: ['hey, how are you?'] },
  { name: 'CAP#3 math (expect tool_computed, correct)', turns: ['73291 times 8457'] },
]

// HEADED, real-GPU WebGPU. On macOS, headed Chromium backs WebGPU with Metal (via ANGLE) — the actual GPU,
// not SwiftShader. We deliberately DO NOT force Vulkan/SwiftShader flags here (those pinned the software
// rasterizer in headless and tripped LiteRT's 5-min engine timeout on the deep turns). Just unblock WebGPU
// and let Chromium pick the native (Metal) backend.
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await chromium.launch({
    headless: false, // real headed window → real GPU → no software-renderer engine timeout
    args: [...WEBGPU_FLAGS],
  })
  const context = await browser.newContext()
  const page = await context.newPage()

  // Collect console errors (LiteRT WASM logs everything to console.error; we filter benign ones on report).
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Probe WebGPU BEFORE committing to a 2GB load.
  const gpu = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return { ok: false, why: 'navigator.gpu missing' }
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return { ok: false, why: 'requestAdapter returned null' }
      return {
        ok: true,
        info:
          (adapter.info && { vendor: adapter.info.vendor, arch: adapter.info.architecture }) ||
          'ok',
      }
    } catch (e) {
      return { ok: false, why: String(e) }
    }
  })
  log({ event: 'webgpu-probe', gpu })
  if (!gpu.ok) {
    log({ event: 'ABORT', reason: 'WebGPU unavailable — cannot run the on-device model', gpu })
    await browser.close()
    process.exit(2)
  }
  // Real-GPU assertion: if Chromium still fell back to SwiftShader (software), the deep turns will hit
  // LiteRT's 5-min engine timeout — abort now rather than waste ~13 min per turn discovering it.
  const archStr = JSON.stringify(gpu.info || '').toLowerCase()
  if (archStr.includes('swiftshader') || archStr.includes('llvmpipe')) {
    log({
      event: 'ABORT',
      reason: 'GPU is a SOFTWARE renderer (SwiftShader/llvmpipe) — need real GPU',
      gpu,
    })
    await browser.close()
    process.exit(4)
  }

  // Cold start: wipe OPFS + wiretap ring.
  await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      const names = []
      for await (const [n] of root.entries()) names.push(n)
      for (const n of names) {
        try {
          await root.removeEntry(n, { recursive: true })
        } catch {}
      }
    } catch {}
    try {
      localStorage.removeItem('adk:wiretap')
    } catch {}
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  // Open the widget.
  await page.locator('button:has-text("Ask ADK")').click()
  await page.locator('button.agent-load').click()
  log({ event: 'model-load-started' })

  // Wait for Ready (Unload button appears). SwiftShader load is slow.
  const readyDeadline = Date.now() + LOAD_DEADLINE_MS
  let ready = false
  while (Date.now() < readyDeadline) {
    ready = await page
      .locator('button:has-text("Unload")')
      .count()
      .then((c) => c > 0)
    if (ready) break
    if ((Date.now() - t0) % 30000 < 3000) log({ event: 'loading-heartbeat' })
    await sleep(3000)
  }
  if (!ready) {
    log({ event: 'ABORT', reason: 'model did not reach Ready within 5 min' })
    await browser.close()
    process.exit(3)
  }
  log({ event: 'model-ready' })

  // Helpers to read the current transcript + utilization.
  const readState = () =>
    page.evaluate(() => {
      const region = [...document.querySelectorAll('*')].find(
        (el) => el.getAttribute && el.getAttribute('aria-label') === 'ADK documentation agent'
      )
      if (!region) return { err: 'no region' }
      // Utilization summary
      const strongs = [...region.querySelectorAll('strong')].map((s) => s.textContent.trim())
      const util = strongs.find((t) => /\/ [\d,]+ tok/.test(t)) || null
      const titles = [...region.querySelectorAll('*')]
        .map((e) => e.getAttribute && e.getAttribute('title'))
        .filter(Boolean)
        .filter((t) =>
          /^(System prompt|Tools|Retrieved docs|Conversation|Thoughts|Reserved)/.test(t)
        )
      // Assistant bubbles: role label 'assistant' then the answer paragraph(s). Grab all message groups.
      const msgs = []
      for (const el of region.querySelectorAll('*')) {
        const label = el.getAttribute && el.getAttribute('aria-label')
        void label
      }
      // Simpler: collect user + assistant text in document order via the known class structure.
      const rows = [...region.querySelectorAll('*')].filter((el) => {
        const t = (el.textContent || '').trim()
        return el.children.length === 0 && (t === 'user' || t === 'assistant')
      })
      return { util, titles, roleMarkers: rows.length }
    })

  // Robust, structure-agnostic capture: read the WHOLE transcript region (paragraphs, sources, rails, tool
  // chips, and the raw text) so nothing is lost regardless of the exact DOM nesting. We parse the answer
  // offline. `answerParas` = every <p> in the transcript in order (the last is the newest answer);
  // `sources`/`rails`/`toolChips` are collected region-wide.
  const readLastAnswer = () =>
    page.evaluate(() => {
      const region = [...document.querySelectorAll('*')].find(
        (el) => el.getAttribute && el.getAttribute('aria-label') === 'ADK documentation agent'
      )
      if (!region) return { err: 'no region' }
      // EXCLUDE the non-transcript chrome: the dev-only wiretap panel, the composer, and the
      // controls/utilization bars all contain their own <p>/<a>/<button> that must NOT be mistaken for the
      // answer (the wiretap's empty-state <p> is literally the last <p> in the region otherwise).
      const inChrome = (el) =>
        !!el.closest('.agent-wiretap, .agent-composer, .agent-controls, .agent-util')
      const transcriptParas = [...region.querySelectorAll('p')]
        .filter((p) => !inChrome(p))
        .map((p) => p.textContent.trim())
        .filter(Boolean)
      const rails = [...region.querySelectorAll('[aria-label]')]
        .filter((e) => !inChrome(e))
        .map((e) => e.getAttribute('aria-label'))
        .filter(
          (l) =>
            l &&
            l.length < 220 &&
            !/^(System prompt|Tools|Retrieved docs|Conversation|Thoughts|Reserved|Last turn packed|Model:|context|Wire log|Generate model|What (is|does)|ADK documentation|Clear conversation|Minimize|Send|Unload|Load|Model \(|Ask about|Open the)/.test(
              l
            )
        )
      const toolChips = [...region.querySelectorAll('button')]
        .filter((b) => !inChrome(b))
        .map((b) => b.textContent.replace(/\s+/g, ' ').trim())
        .filter((t) => /🛠|⚠/.test(t))
      const sources = [...region.querySelectorAll('a[href]')]
        .filter((a) => !inChrome(a))
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && (h.startsWith('/') || h.startsWith('http')))
      const paras = transcriptParas
      const lastPara = paras.length ? paras[paras.length - 1] : ''
      // RELIABLE committed-answer read: the LAST assistant message BUBBLE (.agent-msg--assistant). A
      // calculate answer renders as a KaTeX display-math block (MathML, NOT a <p>), so the <p> scrape above
      // is BLIND to it — it would report the prior turn's time <p> as "last". Read the bubble's full text
      // (KaTeX renders "619,921,187" into the DOM text) and, separately, any .katex block's text. This is
      // the ground-truth committed answer for THIS turn, per the "read the render, not the <p> guess" rule.
      const bubbles = [...region.querySelectorAll('.agent-msg--assistant')].filter(
        (b) => !inChrome(b)
      )
      const lastBubble = bubbles.length ? bubbles[bubbles.length - 1] : null
      const clone = lastBubble ? lastBubble.cloneNode(true) : null
      // Strip the role label + thoughts panel + tool chips so bubbleText is just the ANSWER body.
      if (clone) {
        clone
          .querySelectorAll('.agent-role, .agent-gates, .agent-thoughts, .agent-tools, button')
          .forEach((n) => n.remove())
      }
      const bubbleText = clone ? clone.textContent.replace(/\s+/g, ' ').trim() : ''
      const katex = lastBubble
        ? [...lastBubble.querySelectorAll('.katex')]
            .map((k) => k.textContent.trim())
            .filter(Boolean)
        : []
      // Capture the plan-thought's committed answer kind ("- answer kind: rhetorical") from anywhere in the
      // region text — the Thinking panel renders it. Reports the LAST match (this turn's plan).
      const kindMatches = [
        ...(region.textContent || '').matchAll(/answer kind:\s*([a-z_]+)/gi),
      ].map((m) => m[1])
      const plannedKind = kindMatches.length ? kindMatches[kindMatches.length - 1] : null
      return {
        paras,
        lastPara,
        bubbleText,
        katex,
        rails,
        toolChips,
        sources,
        plannedKind,
        allKinds: kindMatches,
      }
    })

  const isGenerating = () =>
    page.evaluate(() => {
      const region = [...document.querySelectorAll('*')].find(
        (el) => el.getAttribute && el.getAttribute('aria-label') === 'ADK documentation agent'
      )
      if (!region) return false
      // The transient status shows as a standalone node with EXACTLY one of these words (+ ellipsis). The
      // persistent "Thinking (N)" thoughts-panel label has parens/a number, so it won't match `…$`.
      const nodes = [...region.querySelectorAll('*')].filter((el) => el.children.length === 0)
      return nodes.some((n) =>
        /^(Planning…|Working…|Thinking…|Reading…|Searching…|Generating…)$/.test(
          (n.textContent || '').trim()
        )
      )
    })

  // GROUND TRUTH for what the planner committed this turn: read the raw wiretap for the LAST make_plan
  // FROM generation and pull answer_kind out of its payload. The DOM "answer kind:" regex proved unreliable
  // (plannedKind came back null even when a plan surely rendered), so we read the wire, not the render.
  const readCommittedKind = () =>
    page.evaluate(() => {
      let wire = []
      try {
        wire = JSON.parse(localStorage.getItem('adk:wiretap') || '[]')
      } catch {
        return { kind: null, raw: null }
      }
      // Newest make_plan FROM entry wins (this turn's planner output).
      for (let i = wire.length - 1; i >= 0; i--) {
        const e = wire[i]
        if (e.dir !== 'from') continue
        const p = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)
        if (!/make_plan/.test(p)) continue
        // The value may be wrapped in Gemma's <|"|> string delimiters and/or plain quotes — skip any
        // leading delimiter/quote/colon/equals/space before the actual [a-z_] kind token.
        const m = /answer_kind["':=\s]*(?:<\|"\|>)?\s*"?([a-z_]+)/i.exec(p)
        return { kind: m ? m[1] : null, raw: p.slice(0, 400) }
      }
      return { kind: null, raw: null }
    })

  const clearConversation = async () => {
    const btn = page
      .locator('button[aria-label="Clear conversation"], button:has-text("Clear conversation")')
      .first()
    if (await btn.count()) {
      await btn.click().catch(() => {})
      await sleep(500)
    }
  }

  for (const thread of THREADS) {
    log({ event: 'thread-start', thread: thread.name })
    await clearConversation()
    for (let i = 0; i < thread.turns.length; i++) {
      const prompt = thread.turns[i]
      const errBefore = consoleErrors.length
      const stateBefore = await readState()
      const utilBefore = stateBefore.util // e.g. "5,725 / 8,192 tok · 75%" or null on a fresh convo
      await page.locator('input.agent-input').fill(prompt)
      await page.locator('button.agent-send').click()
      log({ event: 'turn-sent', thread: thread.name, idx: i, prompt })

      // Settle = not generating AND the meter has updated (a dispatch completed this turn) AND the last
      // assistant answer is a real, non-placeholder body that is STABLE across two reads (so we don't catch
      // a transient). On SwiftShader a turn runs many minutes across several generations.
      const deadline = Date.now() + TURN_DEADLINE_MS
      await sleep(3000)
      let settled = false
      let lastHb = 0
      let prevBody = ''
      while (Date.now() < deadline) {
        const gen = await isGenerating()
        const st = await readState()
        const meterMoved = st.util && st.util !== utilBefore
        const a = await readLastAnswer()
        // Use the LAST-ASSISTANT-BUBBLE text as the settle signal — a calc answer is a KaTeX block (no <p>),
        // so lastPara would never change and the turn would never settle. bubbleText captures the rendered
        // answer regardless of form.
        const body = (a && a.bubbleText) || ''
        const hasRealAnswer = body.length > 0
        // Settle when not generating, the meter has advanced this turn, and the newest answer body is
        // present + STABLE across two reads (so we don't grab a half-streamed answer).
        if (!gen && meterMoved && hasRealAnswer && body === prevBody) {
          settled = true
          break
        }
        prevBody = body
        const elapsed = Math.round((Date.now() - t0) / 1000)
        if (elapsed - lastHb >= 30) {
          lastHb = elapsed
          log({
            event: 'turn-heartbeat',
            thread: thread.name,
            idx: i,
            gen,
            meter: st.util,
            hasRealAnswer,
            paraCount: a && a.paras ? a.paras.length : 0,
          })
        }
        await sleep(5000)
      }
      const answer = await readLastAnswer()
      const state = await readState()
      const committed = await readCommittedKind()
      const newErrors = consoleErrors.slice(errBefore)
      log({
        event: 'turn-result',
        thread: thread.name,
        idx: i,
        prompt,
        settled,
        util: state.util,
        buckets: state.titles,
        committedKind: committed.kind,
        planRaw: committed.raw,
        plannedKind: answer.plannedKind,
        allKinds: answer.allKinds,
        rails: answer.rails,
        toolChips: answer.toolChips,
        sources: answer.sources,
        committedAnswer: answer.bubbleText,
        katex: answer.katex,
        answerLastPara: answer.lastPara,
        answerParas: answer.paras,
        newConsoleErrors: newErrors,
      })
    }
    log({ event: 'thread-end', thread: thread.name })
  }

  // Dump the raw-wire tap so we can SEE what the planner actually received (TO — incl. our seeded synthetic
  // thought) and produced (FROM — its make_plan reasoning + call). This is the only way to stop iterating
  // blind on the classification.
  try {
    const wire = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('adk:wiretap') || '[]')
      } catch {
        return []
      }
    })
    // Dump EVERY entry (both dirs) so we can see the turn-2 WORKER generations too, not just the planner.
    // Tag each with coarse signals: is it a planner call, does it mention the turn-2 prompt/answer, does it
    // carry a nudge/gate directive (the "contrary direction" suspects).
    for (const e of wire) {
      const payloadStr = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)
      log({
        event: 'wire',
        dir: e.dir,
        kind: e.kind,
        isPlanner: /make_plan|answer_kind/i.test(payloadStr),
        mentionsCalc: /calculate|73291|8457|619,?921,?187/i.test(payloadStr),
        mentionsTime: /get_current_time|UTC:|day of the week/i.test(payloadStr),
        hasNudgeOrGate:
          /provide_answer|duplicate|re-issued|SYSTEM-DIRECTIVE|__nudge|artifact_/i.test(payloadStr),
        payload: payloadStr.slice(0, 3000),
      })
    }
    log({ event: 'wire-total', count: wire.length })
  } catch (err) {
    log({ event: 'wire-dump-error', error: String(err) })
  }

  await browser.close()
  log({ event: 'DONE' })
}

main().catch((e) => {
  log({ event: 'FATAL', error: String(e), stack: e.stack })
  process.exit(1)
})
