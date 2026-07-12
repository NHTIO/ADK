/// <reference lib="dom" />

import { afterEach, describe, expect, it } from 'vitest'
import { litertShapeSpec } from '../../../_fixtures/isolation/litert_shape_spec'
import { spawnIsolated, type IsolatedService } from '@nhtio/adk/batteries/isolation'

/**
 * Browser twin of WP5 Proof A (`litert_refit.node.spec.ts`): the same LiteRT-LM-shaped fake engine,
 * driven over a real Worker via `spawnIsolated` instead of `child_process.fork()`. Lighter than the
 * node spec (one-shot + stream + progress only — `recycle()`/`deviceLost` escalation is already proved
 * cross-transport by `browser_transport.browser.spec.ts`'s `recycle()` suite and this spec's node twin).
 * The guest is served prebundled at `/@isolation-worker/litert_shape_worker.js` by the
 * `adk:isolation-worker-prebundle` Vite middleware (see `vite.config.mts`).
 */
const workerUrl = new URL('/@isolation-worker/litert_shape_worker.js', import.meta.url)
const services: IsolatedService<typeof litertShapeSpec>[] = []

const spawn = (): IsolatedService<typeof litertShapeSpec> => {
  const svc = spawnIsolated(litertShapeSpec, {
    worker: workerUrl,
    workerOptions: { type: 'module' },
    // The first request to /@isolation-worker/… triggers an esbuild prebundle of the whole guest
    // graph, and under full-suite parallelism (three browsers sharing the dev server) that cold
    // start plus Worker boot can exceed the default 30s ready timeout — seen as a chromium-only
    // flake in the full merge-gate run while the same test passes in ~22s on firefox.
    readyTimeoutMs: 120_000,
    disposeGraceMs: 10,
  })
  services.push(svc)
  return svc
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()))
})

// Whichever of these runs first pays the cold-start prebundle; raise the vitest per-test timeout
// (project default 60s) to match the raised readyTimeoutMs above.
describe('isolated LiteRT-LM-shaped engine refit — browser Worker', () => {
  it('one-shot generate round-trips through a real Worker', { timeout: 180_000 }, async () => {
    const svc = spawn()
    await svc.api.init({ model: 'fake.litertlm' })
    await svc.api.createConversation()
    await expect(svc.api.send('hello there world')).resolves.toBe('fake-reply: 3 words')
  })

  it('fans out ordered stream deltas', { timeout: 180_000 }, async () => {
    const svc = spawn()
    await svc.api.init({ model: 'fake.litertlm' })
    const reader = svc.api.sendStreaming('one two three').getReader()
    const deltas: string[] = []
    for (let r = await reader.read(); !r.done; r = await reader.read()) deltas.push(r.value)
    expect(deltas).toEqual(['one', 'two', 'three'])
  })

  it('fires progress events during init', { timeout: 180_000 }, async () => {
    const svc = spawn()
    const reports: unknown[] = []
    svc.on('progress', (r) => reports.push(r))
    await svc.api.init({ model: 'fake.litertlm' })
    expect(reports.length).toBeGreaterThan(0)
  })
})
