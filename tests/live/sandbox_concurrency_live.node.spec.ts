// RELEASE-GATING: real SRT sessions, not unit fakes — so it must SKIP without `TEST_SANDBOX_LIVE`.
// Omitting the gate is what broke MR !8: CI ran it with no sandbox available, both constructions
// failed for the wrong reason, and the assertion saw zero winners.
import { RUN } from './sandbox_live_helpers'
import { describe, it, expect } from 'vitest'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../src/batteries/sandbox/node/srt_enforcer'

describe.skipIf(!RUN)('sandbox — live concurrency guard (release)', () => {
  it('concurrent constructions: exactly one wins, and it is not adopted', async () => {
    const srt = (await import('@anthropic-ai/sandbox-runtime')) as any
    await srt.SandboxManager.reset().catch(() => {})
    releaseSrtOwnershipForTests()
    const settled = await Promise.allSettled([
      srtEnforcer({ policy: { filesystem: { denyRead: ['/tmp/AAA'] }, network: {} } as never }),
      srtEnforcer({ policy: { filesystem: { denyRead: ['/tmp/BBB'] }, network: {} } as never }),
    ])
    const ok = settled.filter((r) => r.status === 'fulfilled')
    for (const r of ok) await (r as any).value.dispose()
    expect(ok).toHaveLength(1)
    expect((ok[0] as any).value.adopted).toBe(false)
  }, 60000)
})
