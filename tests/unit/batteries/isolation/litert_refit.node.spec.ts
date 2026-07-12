import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prebundleChild, type PrebundledChild } from '../../../_fixtures/isolation/prebundle_child'
import {
  services,
  makeCreateLiteRtLmEngineIsolated,
} from '../../../_fixtures/isolation/litert_refit_host_factory'
import type { LiteRtLmEngine } from '@nhtio/adk/batteries/llm/litert_lm'

/**
 * WP5 Proof A: the isolation battery satisfies `CreateLiteRtLmEngine` structurally, replacing the
 * 313-line hand-rolled `docs/.vitepress/theme/components/agent/litert_lm_worker_proxy.ts`. The
 * `makeCreateLiteRtLmEngineIsolated` factory under test lives entirely in test fixtures — no `src/`
 * change — and is typed `CreateLiteRtLmEngine` at its own declaration site (see
 * `litert_refit_host_factory.ts`), so a type error there would mean the refit does NOT structurally fit
 * the real adapter contract.
 *
 * @remarks
 * Co-located under `tests/unit/batteries/isolation/` with the rest of the battery's node specs. It
 * must NOT live under `tests/functional/`: the CI package smoke check ships `tests/functional` into a
 * published-package sandbox that carries only an allow-listed subset of `tests/_fixtures/`, so a
 * functional spec importing `_fixtures/isolation/*` fails there with "Cannot find module" (this file
 * was originally placed there and broke the smoke check on master).
 */
let child: PrebundledChild

beforeAll(async () => {
  child = await prebundleChild(
    new URL('../../../_fixtures/isolation/litert_shape_child.ts', import.meta.url).pathname
  )
}, 120_000)

afterAll(async () => {
  await child?.dispose()
})

const boot = (): Promise<LiteRtLmEngine> =>
  makeCreateLiteRtLmEngineIsolated(child.modulePath)({ engineSettings: { model: 'fake.litertlm' } })

describe('isolated LiteRT-LM-shaped engine refit', () => {
  it('one-shot generate round-trips through a real forked child', async () => {
    const engine = await boot()
    const conversation = await engine.createConversation()
    const reply = await conversation.sendMessage('hello there world')
    expect(reply.content).toBe('fake-reply: 3 words')
    await engine.delete()
  })

  it('streams ordered deltas', async () => {
    const engine = await boot()
    const conversation = await engine.createConversation()
    const reader = conversation.sendMessageStreaming('one two three').getReader()
    const deltas: string[] = []
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      deltas.push(r.value.content as string)
    }
    expect(deltas).toEqual(['one', 'two', 'three'])
    await engine.delete()
  })

  it('fires onInitProgress during init', async () => {
    const reports: unknown[] = []
    const engine = await makeCreateLiteRtLmEngineIsolated(child.modulePath)({
      engineSettings: { model: 'fake.litertlm' },
      onInitProgress: (r) => reports.push(r),
    })
    expect(reports.length).toBeGreaterThan(0)
    await engine.delete()
  })

  it('deviceLost -> recycle() -> engine still works', async () => {
    const engine = await boot()
    const svc = services.get(engine)!
    const lost = new Promise<{ reason: string }>((resolve) => svc.on('deviceLost', resolve))
    await svc.api.loseDevice()
    await lost
    await svc.recycle()
    const conversation = await engine.createConversation()
    const reply = await conversation.sendMessage('back online now')
    expect(reply.content).toBe('fake-reply: 3 words')
    await engine.delete()
  })
})

describe('receipts — fixture line-count budget', () => {
  const countLines = async (name: string): Promise<number> => {
    const url = new URL(`../../../_fixtures/isolation/${name}`, import.meta.url)
    const contents = await readFile(url, 'utf8')
    // A trailing newline (every file here has one) produces one trailing empty element from
    // `split('\n')` that is not a real line — drop it so this matches `wc -l`.
    return contents.replace(/\n$/, '').split('\n').length
  }

  it('litert_shape_spec.ts stays under 40 lines', async () => {
    expect(await countLines('litert_shape_spec.ts')).toBeLessThan(40)
  })

  it('litert_shape_child.ts stays under 45 lines', async () => {
    expect(await countLines('litert_shape_child.ts')).toBeLessThan(45)
  })

  it('litert_refit_host_factory.ts (the DX proof itself) stays under 45 lines', async () => {
    expect(await countLines('litert_refit_host_factory.ts')).toBeLessThan(45)
  })
})
