import { describe, expect, it, vi } from 'vitest'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'

/**
 * A spawn that FAILS must settle `completed`, not kill the host process.
 *
 * @remarks
 * `SandboxPolicyEnforcer.run` resolves on spawn and hands back a separate `completed` promise, so the
 * only listener the shape obviously needs is `'close'`. That is the trap: an unhandled `'error'` on a
 * `ChildProcess` is an **uncaught exception**, which terminates the whole Node process. A missing
 * wrapper binary or an unusable `cwd` would therefore take the agent down instead of failing one
 * command — the opposite of a sandbox's job.
 *
 * These tests drive the REAL `spawn` through the public `run()` API. The SRT module is mocked (that is
 * the only way to reach `run()` without a live sandbox), but nothing about the child process is: the
 * fake's `wrapWithSandboxArgv` returns a genuine argv, so a real process really is spawned and a real
 * `'error'` event is really emitted.
 */
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: async () => {
      await Promise.resolve()
      state.enabled = true
    },
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => state.enabled,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    // Returns a REAL argv so `run()` spawns a real child. `binShell` is substituted verbatim, which is
    // what lets a test point the spawn at a path that cannot be executed.
    wrapWithSandboxArgv: async (command: string, shell: string) => ({
      argv: [shell, '-c', command],
      env: {},
    }),
    getFsReadConfig: () => ({ denyOnly: [], allowWithinDeny: [] }),
    getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
    getNetworkRestrictionConfig: () => ({ allowedHosts: [] }),
    getConfig: () => ({
      filesystem: { allowGitConfig: false, disabled: false },
      network: { allowedDomains: [], deniedDomains: [] },
      mandatoryDenySearchDepth: 3,
    }),
    getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
    reset: async () => {
      state.enabled = true
    },
  },
}))

const state: { enabled: boolean } = { enabled: false }

const policy: SandboxPolicy = { filesystem: {}, network: {} }

const drain = async (stream: ReadableStream<Uint8Array>): Promise<number> => {
  const reader = stream.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value?.byteLength ?? 0
  }
  return total
}

describe('sandbox enforcer spawn failure', () => {
  it('settles `completed` as failed when the child cannot be spawned at all', async () => {
    releaseSrtOwnershipForTests()
    state.enabled = false
    const enforcer = await srtEnforcer({ policy, binShell: '/bin/bash' })

    // An unusable `cwd` makes the spawn fail asynchronously with ENOENT — the same `'error'` event a
    // missing wrapper binary produces, reached entirely through the public API.
    const started = await enforcer.run({
      argv: ['echo', 'hi'],
      policy,
      correlationId: 'spawn-failure-cwd',
      cwd: '/nonexistent-directory-for-spawn-failure-test/nested',
    })

    // Both streams must still be drainable — the tool drains them concurrently before awaiting
    // `completed`, so a spawn failure that left a stream hanging would deadlock the shell tool.
    const [out, err, settled] = await Promise.all([
      drain(started.stdout),
      drain(started.stderr),
      started.completed,
    ])

    expect(settled.failed).toBe(true)
    expect(settled.exitCode).not.toBe(0)
    expect(out).toBe(0)
    expect(err).toBe(0)
  })

  it('still reports a real command`s own exit code, so the error listener does not mask it', async () => {
    releaseSrtOwnershipForTests()
    state.enabled = false
    const enforcer = await srtEnforcer({ policy, binShell: '/bin/bash' })

    // The regression guard for the fix: `'error'` and `'close'` both settle the same promise, so a
    // first-write-wins mistake would make every command report exit 1. A deliberate exit 3 proves the
    // real code survives, and a clean exit 0 proves success is not reported as failure.
    //
    // `argv` elements are quoted INDIVIDUALLY before the shell sees them, so `exit` and `3` must be
    // separate entries — `['exit 3']` would become one quoted word and the shell would answer 127
    // ("command not found") rather than exiting 3.
    const failing = await enforcer.run({
      argv: ['exit', '3'],
      policy,
      correlationId: 'spawn-failure-exit-3',
      cwd: process.cwd(),
    })
    await Promise.all([drain(failing.stdout), drain(failing.stderr)])
    expect(await failing.completed).toEqual({ exitCode: 3, failed: true })

    const ok = await enforcer.run({
      argv: ['exit', '0'],
      policy,
      correlationId: 'spawn-failure-exit-0',
      cwd: process.cwd(),
    })
    await Promise.all([drain(ok.stdout), drain(ok.stderr)])
    expect(await ok.completed).toEqual({ exitCode: 0, failed: false })
  })
})
