// Ask ADK real end-to-end eval. Drives the ACTUAL built docs site (the same
// bundle that ships) through Playwright headed Chrome on real WebGPU: opens the
// Ask ADK dialog, asks each question against the live 3B WebLLM model, and
// asserts on the rendered answer text + citation anchors.
//
// This is a standalone runner (NOT a vitest browser spec) on purpose. The demo's
// AskAdkHarness loads @nhtio/adk from a precompiled bundle served at
// `<origin>/repl/adk-repl.es.js`, spawns a WebGPU Web Worker, and uses OPFS —
// none of which the vitest browser server provides. Faithful verification needs
// the real site served, which is exactly what `vitepress preview` gives us.
//
// Prereqs (run these first):
//   npm run document        # build dist + REPL bundle + docs site into docs/.vitepress/dist
// Then:
//   npx jiti bin/ask_adk_eval.ts
//
// Requires: macOS Chrome/Chromium >= 113 (native WebGPU). First run downloads
// ~1.6GB of model weights into the browser profile (cached afterwards). Headed,
// because headless Chromium exposes navigator.gpu but has no real GPU adapter.
//
// Pass criterion (from the original spec skeleton): at least 10 of 12 questions
// satisfy their assertions, AND both multi-turn questions (Q11 + Q12) pass.

import { resolve } from 'node:path'
import { isError } from '../src/lib/utils/guards'
import { spawn, type ChildProcess } from 'node:child_process'
import { chromium, type Browser, type Page } from 'playwright'

const BASE_DIR = resolve(__dirname, '..')
const PORT = 4317
const BASE_URL = `http://localhost:${PORT}`
const DIST_DIR = resolve(BASE_DIR, 'docs/.vitepress/dist')

// Per-question timeout. The 3B model on WebLLM is slow; multi-step turns
// (rewrite + HyDE + retrieve + rerank + generate + citation-gate retries) can run
// well over a minute.
const PER_QUESTION_MS = 240_000
const MODEL_LOAD_MS = 600_000

interface EvalCase {
  q: string
  mustCite?: string[]
  mustNotSay?: string[]
}

// Single-turn cases (mirrors the original spec's `cases`).
const SINGLE: EvalCase[] = [
  { q: 'How do I write my own LLM backend?', mustCite: ['/assembly/byo-llm'] },
  { q: 'What does the TurnRunner do?', mustCite: ['turn-runner'] },
  { q: 'How do tools get registered?', mustCite: ['tool'] },
  {
    q: 'Is there a way to make a tool only available for one turn?',
    mustCite: ['/the-loop/artifacts'],
  },
  {
    q: 'Does this run in the browser?',
    mustNotSay: ['no, it', 'cannot run in the browser', 'node-only', 'node only'],
  },
  {
    q: "What's the difference between Memory and Retrievable?",
    mustCite: ['memory', 'retrievable'],
  },
  { q: 'How do I add prompt caching?', mustNotSay: ['anthropic prompt caching'] },
  {
    q: "What's a Standing Instruction?",
    mustCite: ['/assembly/byo-storage', '/how-agents-work', '/glossary'],
  },
  { q: 'How is this different from LangChain?', mustNotSay: ['langchain is'] },
  { q: 'Show me a simple Hello World.', mustCite: ['/quickstart', '/assembly/minimal-assembly'] },
]

// Multi-turn cases: each is a sequence of questions in ONE conversation. The
// assertion applies to the LAST answer (the follow-up that needs prior context).
interface MultiCase {
  name: string
  turns: string[]
  mustCite?: string[]
  mustNotSay?: string[]
}
const MULTI: MultiCase[] = [
  {
    name: 'multi-turn pronoun resolution',
    turns: ["How does the executor signal it's done?", 'What if I call it twice?'],
    // Q2 must resolve "it" to ack/nack and stay grounded (cite something real).
    mustCite: ['/'],
  },
  {
    name: 'multi-turn corpus continuity',
    turns: ["What's a Retrievable?", 'And how do I render its content?'],
    mustCite: ['/'],
  },
]

// ── DOM helpers (run in the real built page) ────────────────────────────────────

const openDialog = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Ask ADK' }).first().click()
  // The dialog opens on a "Bring your own compute" consent screen — the model
  // (and the question input) only appear after the user accepts. Click through it.
  // It shows once per fresh conversation/profile; on a warm state it may be
  // skipped, so don't hard-fail if the button isn't there.
  const ready = page.getByRole('button', { name: "I'm ready" })
  await ready.click({ timeout: 30_000 }).catch(() => {
    /* consent already accepted / not shown — input should be present */
  })
  await page.locator('.ask-adk-input input').waitFor({ state: 'visible', timeout: 30_000 })
}

// Wait for the WebLLM engine to finish loading.
//
// The `.ask-adk-init-progress` banner reads "Loading model: N% — <text>" and is
// NEVER cleared back to null by the dialog — it sticks at 100% once loaded. So we
// wait for it to reach "100%" rather than for it to detach. (On a fully warm
// state the banner may show 100% almost immediately; that's fine.) The Send
// button is gated purely on the input having text, not on load state, so once the
// engine is at 100% we're free to ask.
const waitForModelReady = async (page: Page): Promise<void> => {
  const banner = page.locator('.ask-adk-init-progress')
  // If a load banner appears at all, wait until it reports 100%.
  const appeared = await banner
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    await page
      .locator('.ask-adk-init-progress', { hasText: '100%' })
      .waitFor({ state: 'visible', timeout: MODEL_LOAD_MS })
  }
  // Input must be interactable (only disabled while a turn is generating).
  await page.locator('.ask-adk-input input:not([disabled])').waitFor({ timeout: MODEL_LOAD_MS })
}

// Submit a question and wait until a NEW completed assistant answer appears
// (source chips render only on `m.complete`, so they mark turn completion).
const askAndWait = async (page: Page, question: string): Promise<void> => {
  const before = await page.locator('.ask-adk-refchips').count()
  await page.locator('.ask-adk-input input').fill(question)
  await page.locator('.ask-adk-input button[type="submit"]').click()
  // A completed, gate-accepted turn renders its Sources chip row. Wait for one
  // more than we had before.
  await page
    .locator('.ask-adk-refchips')
    .nth(before)
    .waitFor({ state: 'attached', timeout: PER_QUESTION_MS })
}

// The last assistant answer's rendered text + citation hrefs.
const lastAnswer = async (page: Page): Promise<{ text: string; citeHrefs: string[] }> => {
  const bubble = page.locator('.ask-adk-msg .ask-adk-bubble').last()
  const rawText = await bubble.locator('.ask-adk-markdown').innerText()
  const text = rawText.toLowerCase()
  const citeHrefs = await bubble
    .locator('a.ask-adk-cite, a.ask-adk-refchip')
    .evaluateAll((els) =>
      els
        .map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? '')
        .map((h) => h.toLowerCase())
    )
  return { text, citeHrefs }
}

const assertCase = (
  label: string,
  answer: { text: string; citeHrefs: string[] },
  c: { mustCite?: string[]; mustNotSay?: string[] }
): string[] => {
  const failures: string[] = []
  if (c.mustCite && c.mustCite.length) {
    const hay = answer.citeHrefs.join(' ') + ' ' + answer.text
    const hit = c.mustCite.some((needle) => hay.includes(needle.toLowerCase()))
    if (!hit) {
      failures.push(
        `${label}: expected a citation/mention matching one of [${c.mustCite.join(', ')}]; ` +
          `got hrefs=[${answer.citeHrefs.join(', ')}]`
      )
    }
  }
  if (c.mustNotSay && c.mustNotSay.length) {
    for (const bad of c.mustNotSay) {
      if (answer.text.includes(bad.toLowerCase())) {
        failures.push(`${label}: answer must not say "${bad}"`)
      }
    }
  }
  return failures
}

// ── Server lifecycle ─────────────────────────────────────────────────────────────

const startPreview = async (): Promise<ChildProcess> => {
  const child = spawn('npx', ['vitepress', 'preview', 'docs', '--port', String(PORT)], {
    cwd: BASE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Wait until the server answers.
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const res = await fetch(BASE_URL)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('vitepress preview did not start within 60s')
    await new Promise((r) => setTimeout(r, 500))
  }
  return child
}

// ── Main ───────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  // Fail fast if the site hasn't been built.
  await import('node:fs').then(({ existsSync }) => {
    if (!existsSync(resolve(DIST_DIR, 'index.html'))) {
      throw new Error(
        `Built site not found at ${DIST_DIR}. Run \`npm run document\` (or \`docs:build\`) first.`
      )
    }
    if (!existsSync(resolve(DIST_DIR, 'repl/adk-repl.es.js'))) {
      throw new Error('REPL bundle missing from dist. Run `npm run build:repl` (or `document`).')
    }
  })

  const server = await startPreview()
  let browser: Browser | undefined
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined
  const allFailures: string[] = []
  const results: Array<{ label: string; ok: boolean; detail?: string }> = []

  try {
    // Persistent profile, NOT an ephemeral context: ephemeral profiles get a
    // constrained storage quota, and Cache.add can abort mid-download on
    // multi-GB model weights ("UnknownError: Failed to execute 'add' on
    // 'Cache'"). A persistent profile gets normal quota AND keeps the weights
    // cached across runs (the header's "cached afterwards" promise).
    const profileDir = resolve(BASE_DIR, '.cache/ask-adk-eval-profile')
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
    })
    browser = context.browser() ?? undefined
    const page = context.pages()[0] ?? (await context.newPage())
    page.on('console', (m) => {
      const t = m.text()
      if (/error|fail|webgpu|exception/i.test(t)) console.log(`  [page] ${t}`)
    })

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

    // ── Single-turn cases: fresh conversation each (reload to reset OPFS state). ──
    for (const c of SINGLE) {
      const label = `single: ${c.q}`
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
        await openDialog(page)
        await waitForModelReady(page)
        await askAndWait(page, c.q)
        const ans = await lastAnswer(page)
        const fails = assertCase(label, ans, c)
        if (fails.length) {
          allFailures.push(...fails)
          results.push({ label, ok: false, detail: fails.join('; ') })
        } else {
          results.push({ label, ok: true })
        }
        console.log(`${fails.length ? '✗' : '✓'} ${label}`)
      } catch (err) {
        const detail = isError(err) ? err.message : String(err)
        allFailures.push(`${label}: threw ${detail}`)
        results.push({ label, ok: false, detail })
        console.log(`✗ ${label} (threw: ${detail})`)
      }
    }

    // ── Multi-turn cases: all turns in one conversation (no reload between). ──
    for (const c of MULTI) {
      const label = c.name
      try {
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
        await openDialog(page)
        await waitForModelReady(page)
        for (const turn of c.turns) await askAndWait(page, turn)
        const ans = await lastAnswer(page)
        const fails = assertCase(label, ans, c)
        if (fails.length) {
          allFailures.push(...fails)
          results.push({ label, ok: false, detail: fails.join('; ') })
        } else {
          results.push({ label, ok: true })
        }
        console.log(`${fails.length ? '✗' : '✓'} ${label}`)
      } catch (err) {
        const detail = isError(err) ? err.message : String(err)
        allFailures.push(`${label}: threw ${detail}`)
        results.push({ label, ok: false, detail })
        console.log(`✗ ${label} (threw: ${detail})`)
      }
    }
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    server.kill('SIGTERM')
  }

  // ── Verdict ──
  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const multiPassed = MULTI.every((m) => results.find((r) => r.label === m.name)?.ok)
  console.log(`\n── Ask ADK eval: ${passed}/${total} passed; both multi-turn=${multiPassed} ──`)
  if (allFailures.length) console.log(allFailures.map((f) => `  - ${f}`).join('\n'))

  const ok = passed >= 10 && multiPassed
  if (!ok) {
    console.error(`\nFAILED pass criterion (need >=10/12 and both multi-turn).`)
    process.exit(1)
  }
  console.log('\nPASSED.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
