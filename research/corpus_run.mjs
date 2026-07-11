// Headless corpus runner for the flagship agent (Gemma 4 E2B / LiteRT-web / WebGPU).
// Launches headless Chromium with WebGPU enabled, loads the model ONCE, runs the full regression corpus
// as ordered conversations, and prints each turn's COMPLETE rendered answer + rails + utilization + any
// errors as JSON lines so the harness can relay them verbatim.
//
// Usage: node research/corpus_run.mjs   (preview must be serving on http://localhost:4180)

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

import { STRESS_THREADS } from './_stress_threads.mjs'

// The corpus, as ordered threads. Each thread is a fresh conversation (Clear between threads); turns
// within a thread build on each other (coref matters). ADK_CORPUS=stress swaps in the full ~112-turn
// breadth+multi-turn regression battery (T1–T14) instead of these smoke threads.
const SMOKE_THREADS = [
  {
    name: 'A: core-thesis thread (multi-turn, coref)',
    turns: [
      'what is the core thesis of ADK?',
      "so it's not very much of a kit, is it?",
      'what are the important parts that I need to know upfront?',
    ],
  },
  {
    name: 'B: broad-synthesis / overflow litmus (multi-turn)',
    turns: [
      'Give me a comprehensive overview of everything @nhtio/adk offers: the core loop, trust tiers, every battery category, the assembly story, token thrift, and how they all fit together.',
      'Now go deeper on every trust tier and every single battery category with examples — be exhaustive.',
    ],
  },
  {
    name: 'C: standing single-turn checks',
    turns: ['hey, how are you?', 'what day of the week is it?', '73291 times 8457'],
  },
  {
    // TEST-ONLY (run with ADK_BIGREAD=1 + ADK_THREAD="BIGREAD:" + a tight window e.g. ADK_WINDOW=4096).
    // A focused factual doc question forces search_docs_semantic → the model reads the whole result array
    // (over-cap under bigread) → the result-too-large invariant retracts it + steers narrower → the model
    // re-reads a single record that fits → grounded answer. Proves the retract + clear path end-to-end.
    name: 'BIGREAD: result-too-large retract path',
    turns: ['What exactly are the three trust tiers in @nhtio/adk and when do I use each?'],
  },
]

const THREADS = process.env.ADK_CORPUS === 'stress' ? STRESS_THREADS : SMOKE_THREADS

// HEADED, real-GPU WebGPU. On macOS, headed Chromium backs WebGPU with Metal (via ANGLE) — the actual GPU,
// not SwiftShader. We deliberately DO NOT force Vulkan/SwiftShader flags here (those pinned the software
// rasterizer in headless and tripped LiteRT's 5-min engine timeout on the deep turns). Just unblock WebGPU
// and let Chromium pick the native (Metal) backend.
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Config (env-driven so one runner covers 8K/512, 4K/512, and a single-thread shakedown without editing):
//   ADK_WINDOW  — context-window slider value to set before Load (default: leave the widget default 8192).
//   ADK_MAXTOK  — max-output slider value to set before Load (default: leave the widget default 512).
//   ADK_THREAD  — substring to select a single thread by name (e.g. "B:"); default runs all threads.
//   ADK_MODEL   — model id to select in the picker before Load ('gemma-e2b' | 'gemma-e4b'); default: the
//                 widget default (gemma-e2b). E4B is larger/slower but higher-quality — use for a ship check.
const CFG_WINDOW = process.env.ADK_WINDOW ? Number(process.env.ADK_WINDOW) : null
const CFG_MAXTOK = process.env.ADK_MAXTOK ? Number(process.env.ADK_MAXTOK) : null
const CFG_THREAD = process.env.ADK_THREAD || null
const CFG_MODEL = process.env.ADK_MODEL || null
// ADK_RECYCLE_EVERY=N → flush the WebGPU buffer cache (harness.recycle = dispose+reload) every N turns, to
// stave off the device-queue fault a long continuous session hits (observed: E4B WebGPU crash ~turn 45).
// 0/unset = never (default; fine for the fast E2B run). Recommended ~15 for E4B. Conversation survives (SQLite).
const CFG_RECYCLE_EVERY = process.env.ADK_RECYCLE_EVERY ? Number(process.env.ADK_RECYCLE_EVERY) : 0
// ADK_BIGREAD=1 → set localStorage['adk:bigread'] so search_docs_semantic uncaps its excerpts + bumps
// topK, making a whole-array read DETERMINISTICALLY exceed the result-too-large cap (dev/preview-only,
// gated on __ADK_WIRETAP__). Used to exercise the retraction path against a real search read.
const CFG_BIGREAD = process.env.ADK_BIGREAD === '1'

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

  // TEST-ONLY: after the cold-start wipe + reload, arm the big-read trigger so search_docs_semantic
  // returns an over-cap artifact (dev/preview only; the handler reads this flag under __ADK_WIRETAP__).
  if (CFG_BIGREAD) {
    await page.evaluate(() => localStorage.setItem('adk:bigread', '1'))
    log({ event: 'bigread-armed' })
  }

  // Open the widget. `reload({domcontentloaded})` returns BEFORE Vue hydrates, so the button may not be
  // clickable for a beat — wait for it explicitly (a transient 30s-default miss FATAL'd a full run otherwise).
  const askBtn = page.locator('button:has-text("Ask ADK")')
  await askBtn.waitFor({ state: 'visible', timeout: 90_000 })
  await askBtn.click()

  // Select the model BEFORE Load (the picker is disabled once a model is loaded). The <select> is a Vue
  // :value binding with an @change handler, so set .value + dispatch a tracked 'change' event. Default =
  // leave the widget default (gemma-e2b).
  if (CFG_MODEL) {
    // The picker options come from `modelList`, populated only AFTER the ADK bundle + store finish loading
    // (async). Right when the widget opens the <select> is empty — wait for the target option to appear.
    await page
      .locator(`select.agent-model option[value="${CFG_MODEL}"]`)
      .waitFor({ state: 'attached', timeout: 60_000 })
      .catch(() => undefined)
    const applied = await page.evaluate((modelId) => {
      const sel = document.querySelector('select.agent-model')
      if (!sel) return { ok: false, why: 'select.agent-model not found' }
      const opt = [...sel.options].find((o) => o.value === modelId)
      if (!opt)
        return {
          ok: false,
          why: 'no option ' + modelId,
          have: [...sel.options].map((o) => o.value),
        }
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value'
      ).set
      setter.call(sel, modelId)
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: sel.value }
    }, CFG_MODEL)
    log({ event: 'set-model', model: CFG_MODEL, applied })
    if (!applied.ok) {
      log({ event: 'ABORT', reason: 'could not select model ' + CFG_MODEL, applied })
      await browser.close()
      process.exit(5)
    }
  }

  // Set the context-window / max-output sliders BEFORE Load (maxTokens takes effect on the next Load; the
  // window applies per turn). Both are Vue v-model.number range inputs, so set .value + dispatch a tracked
  // 'input' event. Only touch a slider when its env override is present — otherwise keep the widget default
  // (window 8192, maxTokens 512).
  // Index into the sliders container's range inputs by position: 0 = context window, 1 = max output.
  const setSlider = async (index, value) => {
    await page.evaluate(
      ({ index, value }) => {
        const inputs = [...document.querySelectorAll('.agent-sliders input[type="range"]')]
        const el = inputs[index]
        if (!el) throw new Error('slider not found at index ' + index)
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        ).set
        setter.call(el, String(value))
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      },
      { index, value }
    )
  }
  if (CFG_WINDOW !== null) {
    await setSlider(0, CFG_WINDOW) // first slider = context window
    log({ event: 'set-window', window: CFG_WINDOW })
  }
  if (CFG_MAXTOK !== null) {
    await setSlider(1, CFG_MAXTOK) // second slider = max output
    log({ event: 'set-maxtok', maxTokens: CFG_MAXTOK })
  }
  // Read back the applied slider values so the log records the ACTUAL config the run used.
  const sliderState = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.agent-slider__head strong')].map((s) =>
      s.textContent.trim()
    )
    return heads
  })
  log({ event: 'slider-config', sliders: sliderState })

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
          /^(System prompt|Tools|Tool results|Retrieved docs|Conversation|Thoughts|Reserved)/.test(
            t
          )
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
  // Drain the raw-wire tap (globalThis.__agentWire, mirrored from localStorage['adk:wiretap']). This is the
  // GROUND TRUTH: the literal bytes crossing the LLM boundary (dir:'from' = raw model output, before any
  // markdown/DOM rendering), so we never analyse the rendered bubble again. Returns the FROM entries with
  // their raw payload + which tool names the parser actually extracted — the exact signal for "did the
  // parser drop a real tool call" (non-empty raw + empty tools + call-text-in-raw). Bounded ring (50), so
  // this must be drained PER TURN, not once at the end.
  const readWire = () =>
    page.evaluate(() => {
      const w = globalThis.__agentWire
      if (!Array.isArray(w)) return { wire: null }
      // Summarise a TO (assembled-prompt) payload to the ACTUAL context content — the ordered list of
      // messages/thoughts the model saw — so we can inspect for contradictory directives, stale nudges, or
      // irrelevant accumulation. Each message → {role/kind, len, head} (first ~200 chars). preface + tools
      // → length only (large + static). This is the diagnostic that matters: what's IN the context window.
      const summariseTo = (p) => {
        if (!p || typeof p !== 'object') return p
        const msgs = Array.isArray(p.messages) ? p.messages : []
        const prefaceStr =
          typeof p.preface === 'string' ? p.preface : p.preface ? JSON.stringify(p.preface) : ''
        // DIAGNOSTIC: prompt-delivery folds the <tool_definitions> block into the preface text. Extract the
        // tool names actually rendered TO the model from that block (this is the authoritative list — NOT
        // ctx.tools.visible(), which never holds the adapter-forged artifact_* readers). Answers "did the
        // artifact_* readers reach the model's prompt?" directly.
        const toolNamesInPreface = Array.from(
          new Set((prefaceStr.match(/"?name"?\s*[:=]\s*"?([a-z_]+)"?/gi) || []).map((m) => m))
        )
        const artifactToolsInPreface = (prefaceStr.match(/artifact_[a-z_]+/gi) || []).filter(
          (v, i, a) => a.indexOf(v) === i
        )
        return {
          prefaceLen: prefaceStr.length,
          artifactToolsInPreface,
          prefaceHasGetCurrentTime: /get_current_time/.test(prefaceStr),
          prefaceHasToolDefs: /tool_definitions|Available tools|artifact_/.test(prefaceStr),
          toolsLen: p.tools ? JSON.stringify(p.tools).length : 0,
          msgCount: msgs.length,
          messages: msgs.map((m) => {
            const c =
              typeof m?.content === 'string'
                ? m.content
                : m?.content != null
                  ? JSON.stringify(m.content)
                  : JSON.stringify(m)
            // Keep tool-role messages (the search/artifact_json_get RESULTS carrying the excerpt text) in
            // FULL up to 4000c so we can read what the model actually received; other roles stay short.
            const role = m?.role ?? m?.kind ?? m?.from ?? '?'
            const cap =
              role === 'tool' || /tool_response|artifact_json_get|excerpt/.test(c) ? 4000 : 220
            return {
              role,
              len: c.length,
              head: c.length > cap ? c.slice(0, cap) + '…' : c,
            }
          }),
        }
      }
      return {
        wire: w.map((e) => ({
          seq: e.seq,
          dir: e.dir,
          kind: e.kind,
          streamId: e.streamId,
          payload: e.dir === 'from' ? e.payload : summariseTo(e.payload),
        })),
      }
    })

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
            !/^(System prompt|Tools|Tool results|Retrieved docs|Conversation|Thoughts|Reserved|Last turn packed|Model:|context|Wire log|Generate model|What (is|does)|ADK documentation|Clear conversation|Minimize|Send|Unload|Load|Model \(|Ask about|Open the)/.test(
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
      // RELIABLE committed-answer read: the LAST assistant BUBBLE (.agent-msg--assistant). A calculate
      // answer renders as a KaTeX display-math block (MathML, NOT a <p>), so the <p> scrape above is BLIND
      // to it and would report the prior turn's <p> as "last". Read the bubble's own text (KaTeX renders
      // the number into DOM text) — this is the ground-truth committed answer for THIS turn.
      const bubbles = [...region.querySelectorAll('.agent-msg--assistant')].filter(
        (b) => !inChrome(b)
      )
      const lastBubble = bubbles.length ? bubbles[bubbles.length - 1] : null
      const clone = lastBubble ? lastBubble.cloneNode(true) : null
      if (clone) {
        // Strip everything that is NOT the answer prose: role label, gate/thought/tool panels, buttons, AND
        // the citation-chips block (.agent-msg__sources) — otherwise the chips' "Sources" label + page paths
        // get glued onto the prose in textContent and read as a fake inline-path in the answer body.
        clone
          .querySelectorAll(
            '.agent-role, .agent-gates, .agent-thoughts, .agent-tools, .agent-msg__sources, button'
          )
          .forEach((n) => n.remove())
      }
      const bubbleText = clone ? clone.textContent.replace(/\s+/g, ' ').trim() : ''
      const katex = lastBubble
        ? [...lastBubble.querySelectorAll('.katex')]
            .map((k) => k.textContent.trim())
            .filter(Boolean)
        : []
      return { paras, lastPara, bubbleText, katex, rails, toolChips, sources }
    })

  const isGenerating = () =>
    page.evaluate(() => {
      const region = [...document.querySelectorAll('*')].find(
        (el) => el.getAttribute && el.getAttribute('aria-label') === 'ADK documentation agent'
      )
      if (!region) return false
      // The transient status shows as a standalone node with EXACTLY one of these phrases (+ ellipsis). The
      // persistent "Thinking (N)" thoughts-panel label has parens/a number, so it won't match `…$`.
      // MUST include "Checking the answer…" — that's the post-generation phase where the answer-checker and
      // the inline-path specialist run; without it the scraper reads the bubble mid-check and captures the
      // transient status string as the "answer". Also cover the error-recovery phases for completeness.
      const nodes = [...region.querySelectorAll('*')].filter((el) => el.children.length === 0)
      return nodes.some((n) =>
        /^(Planning…|Working…|Thinking…|Reading…|Searching…|Generating…|Checking the answer…|Context too long — shedding and retrying…|Freeing GPU memory…)$/.test(
          (n.textContent || '').trim()
        )
      )
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

  const threadsToRun = CFG_THREAD ? THREADS.filter((t) => t.name.includes(CFG_THREAD)) : THREADS
  log({ event: 'threads-selected', names: threadsToRun.map((t) => t.name) })
  let globalTurnCount = 0
  for (const thread of threadsToRun) {
    log({ event: 'thread-start', thread: thread.name })
    await clearConversation()
    for (let i = 0; i < thread.turns.length; i++) {
      // Periodic WebGPU buffer-cache flush (dev hook window.__agentRecycle → harness.recycle). Fire BEFORE
      // the turn so a fresh engine handles it. Skips turn 0 (nothing accumulated yet). Guarded on the hook
      // existing (wiretap build only) so a non-wiretap run just no-ops.
      if (
        CFG_RECYCLE_EVERY > 0 &&
        globalTurnCount > 0 &&
        globalTurnCount % CFG_RECYCLE_EVERY === 0
      ) {
        const ok = await page.evaluate(async () => {
          const fn = globalThis.__agentRecycle
          return typeof fn === 'function' ? await fn() : false
        })
        log({ event: 'recycle', atTurn: globalTurnCount, ok })
      }
      globalTurnCount++
      const prompt = thread.turns[i]
      const errBefore = consoleErrors.length
      const gatesSeqBefore = await page.evaluate(() => {
        const r = globalThis.__agentGates
        return Array.isArray(r) && r.length ? r[r.length - 1].seq : -1
      })
      const wireBefore = await readWire()
      const wireSeqBefore =
        wireBefore.wire && wireBefore.wire.length
          ? wireBefore.wire[wireBefore.wire.length - 1].seq
          : -1
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
      let wedged = false
      let lastHb = 0
      let prevBody = ''
      let prevUtil = null
      // FROZEN-PAGE WATCHDOG. A long real-GPU run can silently wedge the tab (observed: a ~3h continuous
      // WebGPU session hung at ~turn 78 — the meter froze at one value and every later "turn" was the runner
      // timing out 420s against a dead page, 16× = ~1h of wasted wall-clock + garbage rows). Detect it: when
      // the page is NOT generating, the meter is UNCHANGED from the previous poll, and there is no answer, for
      // WEDGE_STALL_POLLS consecutive polls (~90s), the page is stuck — break early and mark the turn wedged so
      // the outer loop can ABORT the whole run instead of grinding through the remaining turns.
      const WEDGE_STALL_POLLS = 18 // 18 × 5s ≈ 90s of a frozen, non-generating, answerless page
      let stallPolls = 0
      while (Date.now() < deadline) {
        const gen = await isGenerating()
        const st = await readState()
        const meterMoved = st.util && st.util !== utilBefore
        // A turn can end in an ERROR BANNER (.agent-err) rather than an answer — e.g. window-too-small,
        // OOM, context-overflow, or a dispatch-pipeline throw. That IS a terminal turn state: run() has
        // returned. Without detecting it the settle loop (which requires meterMoved + hasRealAnswer)
        // polls until the deadline, making a legitimately-errored turn look like a hang. Record it + break.
        const errBanner = await page.evaluate(() => {
          const el = document.querySelector('.agent-err')
          if (!el) return null
          const p = el.querySelector('p')
          const text = (p && p.textContent ? p.textContent : el.textContent || '').trim()
          return text || null
        })
        if (!gen && errBanner) {
          log({
            event: 'turn-error-banner',
            thread: thread.name,
            idx: i,
            banner: errBanner.slice(0, 400),
          })
          break
        }
        const a = await readLastAnswer()
        // Use the LAST-ASSISTANT-BUBBLE text as the settle signal — a calc answer is a KaTeX block (no <p>),
        // so lastPara would never change and the turn would never settle. bubbleText captures the rendered
        // answer regardless of form.
        const body = (a && a.bubbleText) || ''
        const hasRealAnswer = body.length > 0
        // Settle when not generating, the meter has advanced this turn, and the newest answer body is
        // present + STABLE across two reads (so we don't grab a half-streamed answer).
        //
        // ALSO require the utilization meter to be UNCHANGED since the previous poll. The meter counts the
        // assembled-prompt tokens for a dispatch, so a rising meter means ANOTHER dispatch was just assembled
        // and is running — even if `isGenerating` momentarily shows no status phrase in the gap between two
        // dispatches (plan → synthesis). Without this, a slow inter-dispatch pause let the still-streaming
        // body sit unchanged across two 5s reads and the scraper committed a mid-word fragment (observed
        // B#0: 98-char "…plugging in pre-built" while the meter then climbed 4,612 → 5,776). Meter-stable
        // closes that race.
        const meterStable = st.util === prevUtil
        if (!gen && meterMoved && meterStable && hasRealAnswer && body === prevBody) {
          settled = true
          break
        }
        // Frozen-page watchdog: not generating, meter identical to last poll, and no answer → the page may be
        // wedged. Count consecutive such polls; a real inter-dispatch pause clears within a few (the meter
        // moves or generation resumes), a dead page never does. `prevUtil !== null` skips the first poll.
        if (!gen && !hasRealAnswer && st.util === prevUtil && prevUtil !== null) {
          if (++stallPolls >= WEDGE_STALL_POLLS) {
            wedged = true
            log({
              event: 'turn-wedged',
              thread: thread.name,
              idx: i,
              meter: st.util,
              polls: stallPolls,
            })
            break
          }
        } else {
          stallPolls = 0
        }
        prevBody = body
        prevUtil = st.util
        const elapsed = Math.round((Date.now() - t0) / 1000)
        if (elapsed - lastHb >= 30) {
          lastHb = elapsed
          // TEST-ONLY diagnostic: flush any console errors seen since this turn began, so a hang
          // that never reaches turn-end still surfaces the underlying worker throw in the JSONL.
          const errsSoFar = consoleErrors.slice(errBefore)
          log({
            event: 'turn-heartbeat',
            thread: thread.name,
            idx: i,
            gen,
            meter: st.util,
            hasRealAnswer,
            paraCount: a && a.paras ? a.paras.length : 0,
            errCount: errsSoFar.length,
            lastErr: errsSoFar.length ? errsSoFar[errsSoFar.length - 1].slice(0, 400) : null,
          })
        }
        await sleep(5000)
      }
      const answer = await readLastAnswer()
      const state = await readState()
      const newErrors = consoleErrors.slice(errBefore)
      // GROUND TRUTH: the raw model output (dir:'from') recorded THIS turn — the literal bytes, not the
      // rendered bubble. Only entries after wireSeqBefore. Each 'from' payload is the raw string; we also
      // note whether it carries an unparsed tool-call shape (`call:NAME{` / bare `NAME{callId:` / `<…>`).
      const wireAfter = await readWire()
      const thisTurnWire = (wireAfter.wire || []).filter((e) => e.seq > wireSeqBefore)
      const turnWire = thisTurnWire
        .filter((e) => e.dir === 'from')
        .map((e) => {
          const raw = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)
          return {
            seq: e.seq,
            streamId: e.streamId,
            rawLen: raw.length,
            raw: raw.length > 600 ? raw.slice(0, 600) + '…[+' + (raw.length - 600) + ']' : raw,
            looksToolCall:
              /(?:^|\s)call:\s*[A-Za-z_]\w*\s*\{|(?:^|\s)[A-Za-z_]\w*\{\s*callId:/.test(raw),
            looksXml: /<\/?[A-Za-z][^>]*>/.test(raw),
          }
        })
      // The ASSEMBLED PROMPTS (TO the model) this turn — the actual context window content, for spotting
      // contradictory directives / stale nudges / irrelevant accumulation. Keep every 'to' this turn.
      const promptsTo = thisTurnWire
        .filter((e) => e.dir === 'to')
        .map((e) => ({ seq: e.seq, ...e.payload }))
      // PROOF DUMP (dev/test only): the FULL raw wire for this turn — each to/from crossing in seq order
      // with untruncated preface text — so we can pair a generation (from) with the EXACT prompt (to) it
      // was produced from and prove causal ordering (e.g. did the prompt that generated msg-N contain the
      // tool result from msg-(N-1)?). Written to a per-turn file; never summarised, no ring eviction.
      if (process.env.ADK_WIREDUMP) {
        const fullWire = await page.evaluate((seqBefore) => {
          const w = globalThis.__agentWire
          if (!Array.isArray(w)) return []
          return w
            .filter((e) => e.seq > seqBefore)
            .map((e) => {
              if (e.dir === 'from') {
                const raw = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)
                return { seq: e.seq, dir: 'from', raw }
              }
              // to: keep the FULL preface text (the assembled prompt the model received) + message list
              const p = e.payload || {}
              const preface =
                typeof p.preface === 'string'
                  ? p.preface
                  : p.preface
                    ? JSON.stringify(p.preface)
                    : ''
              const messages = (Array.isArray(p.messages) ? p.messages : []).map((m) => ({
                role: m?.role ?? m?.kind ?? m?.from ?? '?',
                content:
                  typeof m?.content === 'string'
                    ? m.content
                    : m?.content != null
                      ? JSON.stringify(m.content)
                      : JSON.stringify(m),
              }))
              return { seq: e.seq, dir: 'to', prefaceLen: preface.length, preface, messages }
            })
        }, wireSeqBefore)
        const { writeFileSync } = await import('node:fs')
        const fn = `/tmp/wiredump_${(thread.name || 'x').replace(/[^A-Za-z0-9]/g, '_').slice(0, 20)}_${i}.json`
        writeFileSync(fn, JSON.stringify(fullWire, null, 1))
        log({ event: 'wiredump', idx: i, file: fn, crossings: fullWire.length })
      }
      // Duplicate-call diagnostic ring ({tool, checksum, dupCount, argsPreview} per call) — read-only, to
      // confirm whether identical repeated calls get a STABLE checksum and whether the count accumulates.
      const dupDiag = await page.evaluate(() => {
        const r = globalThis.__agentDupDiag
        return Array.isArray(r) ? r.slice(-40) : null
      })
      // The RAILS that fired THIS turn (dev-only __agentGates ring, gated on __ADK_WIRETAP__). Only entries
      // after gatesSeqBefore — so we can assert e.g. `result-too-large` fired (or, on the shakedown, DID NOT).
      const gates = await page.evaluate((seqBefore) => {
        const r = globalThis.__agentGates
        return Array.isArray(r) ? r.filter((g) => g.seq > seqBefore) : null
      }, gatesSeqBefore)
      // What the model ACTUALLY received per dispatch this turn — the tool calls (by tool/callId) that
      // survived relevance + the subtractive pass. Lets us confirm whether a searched handle was still in
      // ctx.turnToolCalls at answer time (i.e. whether the unread-handle gate could even see it).
      // NOTE: __agentContextDispatches is a SHARED ~20-entry ring across turns (not per-turn), so its
      // length is NOT this turn's worker-iteration count — it saturates and bleeds prior turns. Use it to
      // INSPECT recent surviving tool-call contents, not to COUNT iterations. The count-of-record for a
      // turn is `promptsTo.length` (seq-filtered to this turn below). Capture the whole ring, not slice(-12)
      // (that made every turn look like "12 iterations" — a measurement artifact, not a real signal).
      const ctxDispatches = await page.evaluate(() => {
        const r = globalThis.__agentContextDispatches
        return Array.isArray(r) ? r.slice(-20) : null
      })
      // Per-iteration dispatchInput timing (dev tap) — {iter, tcCount, previewMs}. Pinpoints a stall in the
      // per-tool-call readModelFacingPreview loop (a slow/blocking OPFS artifact read every iteration).
      const iterTiming = await page.evaluate(() => {
        const r = globalThis.__agentIterTiming
        return Array.isArray(r) ? r.slice(-40) : null
      })
      log({
        event: 'turn-result',
        thread: thread.name,
        idx: i,
        prompt,
        settled,
        wedged,
        util: state.util,
        buckets: state.titles,
        rails: answer.rails,
        toolChips: answer.toolChips,
        sources: answer.sources,
        committedAnswer: answer.bubbleText,
        katex: answer.katex,
        answerLastPara: answer.lastPara,
        answerParas: answer.paras,
        newConsoleErrors: newErrors,
        wire: turnWire,
        promptsTo,
        dupDiag,
        gates,
        ctxDispatches,
        iterTiming,
      })
      // A wedged (frozen-page) turn means the tab is dead — every subsequent turn would just time out against
      // the same stale DOM (observed: ~16 dead-page turns after a ~3h session hung). ABORT the whole run so we
      // don't record garbage rows; the valid data is everything up to here. ABORTED (not DONE) marks it.
      if (wedged) {
        log({
          event: 'ABORTED',
          reason: 'page wedged (frozen meter) — aborting to avoid dead-page turns',
        })
        await browser.close()
        return
      }
    }
    log({ event: 'thread-end', thread: thread.name })
  }

  await browser.close()
  log({ event: 'DONE' })
}

main().catch((e) => {
  log({ event: 'FATAL', error: String(e), stack: e.stack })
  process.exit(1)
})
