import { describe, expect, it, vi } from 'vitest'
import * as guestService from '../../../../src/batteries/sandbox/js/service'
import { createGuestRunner } from '../../../../src/batteries/sandbox/js/runner'
import { resolveGuestLimits } from '../../../../src/batteries/sandbox/js/validation'

// Node-only: this spies on an ESM export, which Vitest cannot do in a browser
// ("Module namespace is not configurable in ESM"). The behaviour under test is
// runtime-agnostic, so a node-only run covers it; keeping it in js.cross.spec.ts
// only ever produced a chromium failure.
describe('SES guest runner argument forwarding', () => {
  it('forwards declared globals when spawning the guest runtime', async () => {
    // This pins intent rather than catching a live bug: the stock runtime currently ignores these arguments.
    const guestRuntimeSpawn = vi.fn().mockResolvedValue({ evaluate: vi.fn(), kill: vi.fn() })
    const createGuestRuntime = vi.spyOn(guestService, 'createGuestRuntime').mockResolvedValue({
      spawn: guestRuntimeSpawn,
    })
    const runner = await createGuestRunner(
      {
        declared: {
          cancellation: 'cooperative',
          fn: () => 1,
        },
      },
      resolveGuestLimits(),
      { 'declared-module': {} }
    )
    const options = {
      modules: ['declared-module'],
      globals: [{ name: 'declared', kind: 'async-fn' as const }],
      limits: resolveGuestLimits(),
    }

    await runner.spawn(options)

    expect(guestRuntimeSpawn).toHaveBeenCalledWith(options)
    createGuestRuntime.mockRestore()
  })
})
