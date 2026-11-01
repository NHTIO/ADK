// RELEASE-GATING: drives REAL SRT-enforced child processes through the media binary executor.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { sandboxedExecutor } from '../../src/batteries/sandbox/executor'
import { srtBinarySandbox } from '../../src/batteries/sandbox/node/srt_enforcer'
import { execaExecutor } from '../../src/batteries/media/engines/execa_executor'
import {
  RUN,
  tempDir,
  disposeDir,
  makeEnforcer,
  sandboxRuntimeGateReason,
} from './sandbox_live_helpers'
import type { SandboxPolicy } from '../../src/batteries/sandbox/types'

/**
 * `sandboxedExecutor({ sandbox: srtBinarySandbox(enforcer), inner: execaExecutor() })` end to end,
 * against REAL OS enforcement (issue #37).
 *
 * @remarks
 * Everything below the adapter is real: a real SRT session, real bubblewrap/seatbelt wrapping, a
 * real execa child process. The unit suites cover the argv/env/admission shape against a mocked
 * backend; this one covers what a mocked backend cannot — that the generated argv actually runs,
 * that the filesystem policy actually holds, that the env allow-list actually stops a host secret
 * from reaching the child, and that aborting the signal actually kills the child.
 *
 * The allow-list assertion deliberately reads the child's OWN output (`env`) rather than inspecting
 * a seam: the security property is "the model cannot read the host's secrets back into context",
 * and only the child can answer that.
 *
 * Host note: SRT's `apply-seccomp` helper needs a nested user namespace, which the kernel refuses
 * when the caller already holds elevated privileges ("nested userns is capability-restricted"), so
 * this suite passes `enableWeakerNestedSandbox: true` — SRT's own opt-in for that situation. On the
 * development host the gate command itself also requires root (`bwrap --unshare-user` fails with
 * `Operation not permitted` under `kernel.apparmor_restrict_unprivileged_userns=1`), so run:
 * `sudo -E env TEST_SANDBOX_LIVE=1 pnpm test:node tests/live`. The weaker mode is visible right
 * here in the source on every `makeEnforcer` call, not hidden in a helper.
 */

const policy = (filesystem: SandboxPolicy['filesystem'] = {}): SandboxPolicy => ({
  filesystem,
  network: {},
})

/**
 * Every live process whose command line contains `marker`.
 *
 * @remarks
 * A `/proc` scan rather than a `pgrep` shell: the polling shell would match its OWN command line
 * (which contains the marker as an argument), so a `pgrep`-based probe reports a survivor that is
 * really the probe itself. Reading `/proc/<pid>/cmdline` from this process cannot match itself.
 * Linux-only, which is fine — this suite already needs bwrap/socat.
 */
const findMarked = async (marker: string): Promise<number[]> => {
  const found: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8')
      if (cmdline.includes(marker)) found.push(Number(entry))
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return found
}

/** Poll until `marker` matches nothing, or the deadline passes; returns what survived. */
const waitGone = async (marker: string, ms = 10_000): Promise<number[]> => {
  const deadline = Date.now() + ms
  let remaining = await findMarked(marker)
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    remaining = await findMarked(marker)
  }
  return remaining
}

describe.skipIf(!RUN)('sandbox — live SRT binary executor (issue #37, release)', () => {
  if (!RUN) {
    // Recorded so a green default run is never mistaken for evidence the boundary works.
    it.skip(`skipped: ${sandboxRuntimeGateReason}`, () => {})
  }

  it('runs a real command through the wrapped invocation and returns its output', async () => {
    const dir = await tempDir()
    const p = policy({ allowWrite: [dir], gitSafeDirectories: [dir] })
    // SRT's apply-seccomp needs its own nested user namespace; hosts where the outer caller
    // already holds elevated privileges refuse it (see the suite file doc block). This suite
    // explicitly opts into SRT's weaker nested sandbox so it can exercise the REAL wrap-and-run
    // path on such hosts; without `enableWeakerNestedSandbox` every test here would be
    // constructible but un-runnable under `sudo`, which is worse than skipping loudly.
    const enforcer = await makeEnforcer(p, { enableWeakerNestedSandbox: true })
    try {
      const executor = sandboxedExecutor({
        sandbox: srtBinarySandbox(enforcer, { policy: p, cwd: dir }),
        inner: execaExecutor(),
      })
      const result = await executor.exec({ cmd: 'sh', args: ['-c', 'printf hello'], cwd: dir })
      expect(result.failed).toBe(false)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello')
    } finally {
      await enforcer.dispose()
      await disposeDir(dir)
    }
  }, 120_000)

  it('honours the filesystem policy: an allow-listed write lands, a denied one fails', async () => {
    const dir = await tempDir()
    const writable = join(dir, 'ok')
    const p = policy({ allowWrite: [dir], gitSafeDirectories: [dir] })
    // SRT's apply-seccomp needs its own nested user namespace; hosts where the outer caller
    // already holds elevated privileges refuse it (see the suite file doc block). This suite
    // explicitly opts into SRT's weaker nested sandbox so it can exercise the REAL wrap-and-run
    // path on such hosts; without `enableWeakerNestedSandbox` every test here would be
    // constructible but un-runnable under `sudo`, which is worse than skipping loudly.
    const enforcer = await makeEnforcer(p, { enableWeakerNestedSandbox: true })
    try {
      const executor = sandboxedExecutor({
        sandbox: srtBinarySandbox(enforcer, { policy: p, cwd: dir }),
        inner: execaExecutor(),
      })
      const allowed = await executor.exec({
        cmd: 'sh',
        args: ['-c', `printf written > ${writable}`],
        cwd: dir,
      })
      expect(allowed.exitCode).toBe(0)
      expect(await readFile(writable, 'utf8')).toBe('written')

      const denied = await executor.exec({
        cmd: 'sh',
        args: ['-c', 'printf x > /etc/nhtio-issue37-denied'],
        cwd: dir,
      })
      expect(denied.exitCode).not.toBe(0)
    } finally {
      await enforcer.dispose()
      await disposeDir(dir)
    }
  }, 120_000)

  it('does not leak a host secret through the child environment', async () => {
    const dir = await tempDir()
    const p = policy({ allowWrite: [dir], gitSafeDirectories: [dir] })
    // SRT's apply-seccomp needs its own nested user namespace; hosts where the outer caller
    // already holds elevated privileges refuse it (see the suite file doc block). This suite
    // explicitly opts into SRT's weaker nested sandbox so it can exercise the REAL wrap-and-run
    // path on such hosts; without `enableWeakerNestedSandbox` every test here would be
    // constructible but un-runnable under `sudo`, which is worse than skipping loudly.
    const enforcer = await makeEnforcer(p, { enableWeakerNestedSandbox: true })
    process.env.ADK_ISSUE37_SECRET = 'sk-do-not-leak'
    try {
      const executor = sandboxedExecutor({
        sandbox: srtBinarySandbox(enforcer, { policy: p, cwd: dir }),
        inner: execaExecutor(),
      })
      const result = await executor.exec({ cmd: 'env', args: [], cwd: dir })
      expect(result.exitCode).toBe(0)
      // The allow-list defaults to PATH only; `extendEnv: false` on the wrapped invocation is what
      // keeps execa from merging the host environment back in.
      expect(result.stdout).not.toContain('ADK_ISSUE37_SECRET')
      expect(result.stdout).not.toContain('sk-do-not-leak')
      // PATH still arrives, so bare-name binaries keep resolving inside the sandbox.
      expect(result.stdout).toMatch(/^PATH=/m)
    } finally {
      delete process.env.ADK_ISSUE37_SECRET
      await enforcer.dispose()
      await disposeDir(dir)
    }
  }, 120_000)

  it('kills the child and its grandchildren when the invocation signal aborts', async () => {
    const dir = await tempDir()
    const p = policy({ allowWrite: [dir], gitSafeDirectories: [dir] })
    // SRT's apply-seccomp needs its own nested user namespace; hosts where the outer caller
    // already holds elevated privileges refuse it (see the suite file doc block). This suite
    // explicitly opts into SRT's weaker nested sandbox so it can exercise the REAL wrap-and-run
    // path on such hosts; without `enableWeakerNestedSandbox` every test here would be
    // constructible but un-runnable under `sudo`, which is worse than skipping loudly.
    const enforcer = await makeEnforcer(p, { enableWeakerNestedSandbox: true })
    // A marker unique to THIS run, so concurrently-running suites cannot be confused with ours.
    const marker = `adk-issue37-${Math.random().toString(36).slice(2)}`
    try {
      const executor = sandboxedExecutor({
        sandbox: srtBinarySandbox(enforcer, { policy: p, cwd: dir }),
        inner: execaExecutor(),
      })
      const controller = new AbortController()
      // The wrapper shells out to a grandchild and waits. Killing only the direct child leaves the
      // grandchild running — the exact leak the executor's process-group kill exists to close.
      const pending = executor.exec({
        cmd: 'sh',
        args: ['-c', `sleep 47 & sleep 47 # ${marker}; wait`],
        cwd: dir,
        signal: controller.signal,
        forceKillAfterDelay: 1500,
      })

      // Wait until the child has actually spawned (the marker is live), then abort.
      const spawnDeadline = Date.now() + 30_000
      let before: number[] = []
      while (Date.now() < spawnDeadline && before.length === 0) {
        before = await findMarked(marker)
        if (before.length === 0) await new Promise((r) => setTimeout(r, 50))
      }
      expect(before.length, 'the child never started').toBeGreaterThan(0)

      controller.abort()
      const result = await pending
      expect(result.failed).toBe(true)

      // Every member of the group is gone: the group kill reached the grandchild a direct-child
      // kill would have left behind.
      expect(await waitGone(marker), 'a marked process survived the abort').toEqual([])
    } finally {
      await enforcer.dispose()
      await disposeDir(dir)
    }
  }, 120_000)
})
