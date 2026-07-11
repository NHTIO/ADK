// STEP-0 FEASIBILITY DRIVER (throwaway) — the GO/NO-GO gate for the engine-in-Worker migration.
// Launches the SAME real-GPU headed Chromium corpus_run uses, loads a served page, spawns the probe
// worker(s) by URL from docs/public/repl, and asserts each engine boots WebGPU + generates ONE token
// INSIDE the worker. Reports GO / NO-GO per engine.
//
// Prereq: build the probe bundle first —
//   npx vite build -c research/_probe/litert-probe.vite.config.mts
// and a preview server serving docs on :4180 (already running for corpus_run).
//
// Run: node research/probe_worker_engine.mjs

import { chromium } from 'playwright'

// Origin is configurable (env), never hard-coded into paths. The worker + wasm URLs are built
// RELATIVE to this origin, mirroring how the app resolves everything from import.meta.env.BASE_URL +
// window.location.origin — so nothing breaks under a different port or a Pages subpath.
const ORIGIN = process.env.PROBE_ORIGIN || 'http://localhost:4188'
const BASE = `${ORIGIN}/showcase/token-thrift.html`
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist']
// CLASSIC worker (IIFE bundle) — NOT {type:'module'} — so the LiteRT Emscripten glue's importScripts() is legal.
// Path only; the page resolves it against its own origin at spawn time.
const WORKER_PATH = '/repl/litert-probe-worker-iife.js'
const TIMEOUT_MS = 240_000 // model cold-load can be slow

const log = (o) => console.log(JSON.stringify(o))

const browser = await chromium.launch({ headless: false, args: [...WEBGPU_FLAGS] })
const page = await browser.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') log({ ev: 'console-error', text: m.text() })
})
page.on('pageerror', (e) => log({ ev: 'pageerror', text: e.message }))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })

// Real-GPU gate (same as corpus_run) — a software renderer would make the timing meaningless.
const gpu = await page.evaluate(async () => {
  if (!('gpu' in navigator)) return { ok: false, why: 'navigator.gpu missing' }
  try {
    const a = await navigator.gpu.requestAdapter()
    if (!a) return { ok: false, why: 'requestAdapter null' }
    return {
      ok: true,
      info: (a.info && { vendor: a.info.vendor, arch: a.info.architecture }) || 'ok',
    }
  } catch (e) {
    return { ok: false, why: String(e) }
  }
})
log({ ev: 'main-webgpu-probe', gpu })
if (!gpu.ok || /swiftshader|llvmpipe/i.test(JSON.stringify(gpu.info || ''))) {
  log({ ev: 'ABORT', reason: 'no real GPU on main thread', gpu })
  await browser.close()
  process.exit(2)
}

// Spawn the probe worker, resolving its path against the PAGE's own origin (relative), and await the
// single result message. No absolute host crosses into the page — it uses its own location.
const result = await page.evaluate(
  async ({ workerPath, timeoutMs }) => {
    const workerUrl = new URL(workerPath, self.location.origin).href
    return await new Promise((resolve) => {
      let done = false
      let w
      const finish = (r) => {
        if (done) return
        done = true
        try {
          w?.terminate()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
      const t = setTimeout(
        () => finish({ ok: false, stage: 'timeout', error: `no result in ${timeoutMs}ms` }),
        timeoutMs
      )
      try {
        w = new Worker(workerUrl) // classic worker — importScripts() allowed (LiteRT glue needs it)
      } catch (e) {
        clearTimeout(t)
        return finish({ ok: false, stage: 'spawn', error: String(e?.message ?? e) })
      }
      w.onmessage = (ev) => {
        clearTimeout(t)
        finish(ev.data)
      }
      w.onerror = (e) => {
        clearTimeout(t)
        finish({ ok: false, stage: 'worker-onerror', error: e.message || String(e) })
      }
      w.postMessage({ op: 'go' })
    })
  },
  { workerPath: WORKER_PATH, timeoutMs: TIMEOUT_MS }
)

log({ ev: 'PROBE-RESULT', engine: 'litert', result })
log({
  ev: 'VERDICT',
  engine: 'litert',
  verdict: result?.ok ? 'GO' : 'NO-GO',
  detail: result?.ok
    ? `booted WebGPU (adapter=${result.gpuAdapter} device=${result.gpuDevice}) + generated in worker: "${result.sample}"`
    : `failed at stage '${result?.stage}': ${result?.error}`,
})

await browser.close()
process.exit(result?.ok ? 0 : 1)
