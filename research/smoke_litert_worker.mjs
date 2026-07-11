// SMOKE TEST (throwaway) for the disposable-Worker LiteRT engine migration.
//
// Proves, against the REAL built worker bundle (docs/public/repl/litert-lm-worker.js) + its co-located,
// SELF-HOSTED wasm assets (NO CDN), that:
//   1. the CLASSIC worker (new Worker(url) without {type:'module'}) boots — the LiteRT Emscripten glue's
//      importScripts() is legal;
//   2. loadLiteRtLm() resolves the 4 wasm files RELATIVE to the worker's own URL (no hardcoded host);
//   3. Engine.create boots WebGPU + createConversation + sendMessageStreaming yields a token — the exact
//      envelope the host proxy (litert_lm_worker_proxy.ts) drives;
//   4. the device-loss escalation ladder fires: __forceDeviceLost destroys the sentinel device → an
//      unsolicited ev:deviceLost event arrives (the signal the harness escalates on: respawn → reload).
//
// It replicates the proxy's envelope protocol inline (the proxy module needs the docs bundler's
// import.meta.env; the worker bundle is the real artifact and the protocol is faithfully mirrored here).
//
// Prereq: pnpm build:litert-lm-worker (already produces docs/public/repl/litert-lm-worker.js + 4 wasm).
// Run:    node research/smoke_litert_worker.mjs
//
// Serves docs/public/repl on a FRESH ephemeral port (a running vitepress preview caches its file list at
// boot and 404s newly-emitted files — see the probe). Real-GPU gate mirrors corpus_run/the probe.

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

const REPL_DIR = resolve(process.cwd(), 'docs', 'public', 'repl')
const WEBGPU_FLAGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist']
const WORKER_PATH = '/litert-lm-worker.js' // served from REPL_DIR by the fresh server
const E2B_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm'
const TIMEOUT_MS = 300_000 // ~2GB cold model load can be slow

const log = (o) => console.log(JSON.stringify(o))

const MIME = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.html': 'text/html',
  '.json': 'application/json',
}

// Minimal static server: serves REPL_DIR files by path, and a tiny HTML shell at '/'. Same-origin so the
// worker + wasm resolve relative to the page/worker URL.
const server = createServer(async (reqMsg, res) => {
  try {
    const url = new URL(reqMsg.url, 'http://localhost')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>smoke</title></head><body>ok</body></html>'
      )
      return
    }
    const filePath = resolve(REPL_DIR, '.' + url.pathname)
    if (!filePath.startsWith(REPL_DIR)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const ORIGIN = `http://127.0.0.1:${port}`
log({ ev: 'server', origin: ORIGIN, serving: REPL_DIR })

const browser = await chromium.launch({ headless: false, args: [...WEBGPU_FLAGS] })
const page = await browser.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') log({ ev: 'console-error', text: m.text() })
})
page.on('pageerror', (e) => log({ ev: 'pageerror', text: e.message }))

await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' })

// Real-GPU gate (same as corpus_run/probe) — a software renderer makes the boot meaningless.
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
  server.close()
  process.exit(2)
}

// Drive the REAL worker through the exact envelope the proxy uses: init → createConversation →
// sendStreaming (collect one delta) → __forceDeviceLost (assert ev:deviceLost).
const result = await page.evaluate(
  async ({ workerPath, model, timeoutMs }) => {
    const workerUrl = new URL(workerPath, self.location.origin).href
    return await new Promise((resolveP) => {
      const out = { stages: {}, deltas: 0, sample: '', deviceLost: null }
      let done = false
      let seq = 0
      const pending = new Map()
      let streamDeltaResolve = null
      let deviceLostResolve = null
      let w

      const finish = (r) => {
        if (done) return
        done = true
        try {
          w?.terminate()
        } catch {
          /* ignore */
        }
        resolveP(r)
      }
      const t = setTimeout(
        () => finish({ ...out, ok: false, error: `timeout ${timeoutMs}ms` }),
        timeoutMs
      )

      const nextId = () => `w${(seq += 1)}`
      const call = (op, extra = {}) =>
        new Promise((res, rej) => {
          const id = nextId()
          pending.set(id, { res, rej })
          w.postMessage({ id, op, ...extra })
        })

      try {
        // CLASSIC worker — importScripts() must be legal (LiteRT glue needs it). No {type:'module'}.
        w = new Worker(workerUrl)
      } catch (e) {
        clearTimeout(t)
        return finish({ ...out, ok: false, stage: 'spawn', error: String(e?.message ?? e) })
      }

      w.onerror = (e) => {
        clearTimeout(t)
        finish({ ...out, ok: false, stage: 'worker-onerror', error: e.message || String(e) })
      }

      w.onmessage = (ev) => {
        const msg = ev.data
        if (!msg || typeof msg.kind !== 'string') return
        // Correlated replies carry id.
        if (typeof msg.id === 'string' && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.kind === 'error') p.rej(new Error(msg.error || 'worker error'))
          else p.res(msg)
          return
        }
        // Unsolicited events.
        if (msg.kind === 'ev:delta') {
          out.deltas += 1
          const c = msg.content
          const text =
            typeof c === 'string' ? c : Array.isArray(c) ? c.map((i) => i?.text ?? '').join('') : ''
          out.sample += text
          if (streamDeltaResolve && out.sample.length > 0) {
            const r = streamDeltaResolve
            streamDeltaResolve = null
            r()
          }
        } else if (msg.kind === 'ev:streamError') {
          if (streamDeltaResolve) {
            const r = streamDeltaResolve
            streamDeltaResolve = null
            r(new Error('streamError: ' + msg.error))
          }
        } else if (msg.kind === 'ev:deviceLost') {
          out.deviceLost = { reason: msg.reason }
          if (deviceLostResolve) {
            const r = deviceLostResolve
            deviceLostResolve = null
            r()
          }
        }
      }
      ;(async () => {
        try {
          await call('init', { engineSettings: { model } })
          out.stages.init = true

          await call('createConversation', { convId: 'c1', config: { preface: { messages: [] } } })
          out.stages.createConversation = true

          // sendStreaming: the ok reply confirms the stream STARTED; a delta arrives as an event.
          const gotDelta = new Promise((res) => (streamDeltaResolve = res))
          await call('sendStreaming', {
            convId: 'c1',
            streamId: 's1',
            messages: [{ role: 'user', content: 'Say hi.' }],
          })
          out.stages.sendStreaming = true
          const deltaTimeout = new Promise((res) => setTimeout(() => res('delta-timeout'), 120_000))
          const dr = await Promise.race([gotDelta, deltaTimeout])
          if (dr instanceof Error) throw dr
          out.stages.generated = out.sample.length > 0

          // Cancel the stream so it stops generating, then exercise the device-loss ladder.
          await call('cancel', { convId: 'c1' }).catch(() => {})

          // __forceDeviceLost → the sentinel device is destroyed → ev:deviceLost must arrive.
          const gotLost = new Promise((res) => (deviceLostResolve = res))
          await call('__forceDeviceLost')
          const lostTimeout = new Promise((res) => setTimeout(() => res('lost-timeout'), 15_000))
          const lr = await Promise.race([gotLost, lostTimeout])
          out.stages.deviceLostFired = out.deviceLost !== null
          if (lr === 'lost-timeout' && !out.deviceLost) {
            clearTimeout(t)
            return finish({
              ...out,
              ok: false,
              stage: 'device-lost',
              error: 'no ev:deviceLost in 15s',
            })
          }

          clearTimeout(t)
          finish({ ...out, ok: true })
        } catch (e) {
          clearTimeout(t)
          finish({ ...out, ok: false, stage: 'drive', error: String(e?.message ?? e) })
        }
      })()
    })
  },
  { workerPath: WORKER_PATH, model: E2B_URL, timeoutMs: TIMEOUT_MS }
)

log({ ev: 'SMOKE-RESULT', result })
log({
  ev: 'VERDICT',
  verdict: result?.ok ? 'PASS' : 'FAIL',
  detail: result?.ok
    ? `worker booted + generated ("${(result.sample || '').slice(0, 40)}"), deviceLost fired (reason=${result.deviceLost?.reason})`
    : `failed at stage '${result?.stage}': ${result?.error}`,
})

await browser.close()
server.close()
process.exit(result?.ok ? 0 : 1)
