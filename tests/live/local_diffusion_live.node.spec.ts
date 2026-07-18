// LIVE transport verification (opt-in): drives the REAL committed adapter against a REAL spawned Node
// backend subprocess over actual child_process pipes — proving the transport the hermetic unit fake
// cannot (spawn, stdin/stdout byte framing across the OS boundary, rid fencing, real-PNG handling).
// Gated behind LD_LIVE=1 so it never runs in the normal/CI unit sweep. Run:
//   LD_LIVE=1 pnpm exec vitest run tests/live/local_diffusion_live.node.spec.ts
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LocalDiffusionGenerationAdapter } from '../../src/batteries/generation/local_diffusion/adapter'

const BACKEND = new URL('./local_diffusion_backend.mjs', import.meta.url).pathname
const RUN = process.env.LD_LIVE === '1'

const isPng = (b: Uint8Array): boolean =>
  b.length >= 8 &&
  b[0] === 0x89 &&
  b[1] === 0x50 &&
  b[2] === 0x4e &&
  b[3] === 0x47 &&
  b[4] === 0x0d &&
  b[5] === 0x0a &&
  b[6] === 0x1a &&
  b[7] === 0x0a

describe.skipIf(!RUN)('local diffusion — live subprocess transport', () => {
  it('drives a real backend: preload, streamed progress, real PNG, edit round-trip, dispose', async () => {
    const progress: number[] = []
    const phases: string[] = []
    const adapter = new LocalDiffusionGenerationAdapter({
      command: process.execPath,
      args: [BACKEND],
      model: 'fake-checkpoint.safetensors',
      spawn: (ctx: { command: string; args: string[]; model: string }) =>
        spawn(ctx.command, ctx.args, { stdio: ['pipe', 'pipe', 'pipe'] }),
      onGenerating: (r: { progress?: number }) => {
        if (typeof r.progress === 'number') progress.push(r.progress)
      },
      onLifecycle: (r: { phase: string }) => phases.push(r.phase),
    })

    try {
      await adapter.preload()
      expect(phases).toContain('ready')

      const gen = await adapter.generate('a red bicycle', { steps: 4, cfgScale: 7 })
      expect(gen).toHaveLength(1)
      expect(gen[0].kind).toBe('image')
      expect(gen[0].mimeType).toBe('image/png')
      expect(isPng(gen[0].bytes)).toBe(true) // real PNG magic bytes over the wire
      expect(progress.at(-1)).toBe(1) // streamed dnpr progress reached 1

      const edited = await adapter.edit(gen[0].bytes, 'make it blue', { steps: 2 })
      expect(edited).toHaveLength(1)
      expect(isPng(edited[0].bytes)).toBe(true) // input bytes b64-encoded out, real PNG back

      const gen2 = await adapter.generate('a green tree') // slot freed + rid advanced across real turns
      expect(gen2).toHaveLength(1)
      expect(isPng(gen2[0].bytes)).toBe(true)
    } finally {
      await adapter.dispose()
    }
  })
})
