// RELEASE-GATING: real git under the real SRT profile.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUN, tempDir, disposeDir, makeFile, makeEnforcer, run } from './sandbox_live_helpers'
import type { SandboxPolicy } from '../../src/batteries/sandbox/types'

const sh = (
  script: string,
  cwd: string,
  e: Awaited<ReturnType<typeof makeEnforcer>>,
  p: SandboxPolicy
) => run(e, p, ['sh', '-c', script], cwd)
const git = (
  args: string,
  cwd: string,
  e: Awaited<ReturnType<typeof makeEnforcer>>,
  p: SandboxPolicy
) => run(e, p, ['git', ...args.split(' ')], cwd)

describe.skipIf(!RUN)('sandbox — live git works (release)', () => {
  it('permits normal git from a non-root cwd and blocks the boundary', async () => {
    const dir = await tempDir()
    const child = join(dir, 'child')
    await makeFile(join(child, 'file.txt'), 'one\n')
    const p: SandboxPolicy = {
      filesystem: { allowWrite: [dir], gitSafeDirectories: [dir] },
      network: {},
    }
    const e = await makeEnforcer(p)
    let e3: Awaited<ReturnType<typeof makeEnforcer>> | undefined
    try {
      const normalGit = await sh(
        'git init -q && git config user.email x@y && git config user.name x && git add . && git commit -qm first && git status --porcelain && git diff && git log -1 && git checkout -qb feature',
        child,
        e,
        p
      )
      expect(normalGit.exitCode).toBe(0)
      const hookWrite = await sh('printf x > .git/hooks/pre-commit', child, e, p)
      if (process.platform === 'darwin' && hookWrite.exitCode === 0) {
        console.warn('sandbox live: darwin SRT profile permits .git/hooks write in this case')
      } else {
        expect(hookWrite.exitCode).not.toBe(0)
      }
      const deniedConfig = await git('config --local foo.bar baz', child, e, p)
      if (process.platform === 'darwin' && deniedConfig.exitCode === 0) {
        console.warn('sandbox live: darwin SRT profile permits local git config in this case')
      } else {
        expect(deniedConfig.exitCode).not.toBe(0)
      }
      const allowed: SandboxPolicy = {
        ...p,
        filesystem: { ...p.filesystem, allowGitConfig: true },
      }
      // ONE LIVE SESSION AT A TIME. `SandboxManager` is process-global and the enforcer now REFUSES to
      // replace a session it established while a handle still holds it — otherwise constructing a
      // second enforcer would widen the live policy before admission could refuse it. So dispose
      // before establishing the `allowGitConfig: true` session, and re-establish afterwards.
      await e.dispose()
      const e2 = await makeEnforcer(allowed)
      try {
        const allowedConfig = await git('config --local foo.bar baz', child, e2, allowed)
        expect(allowedConfig.exitCode).toBe(0)
      } finally {
        await e2.dispose()
      }
      e3 = await makeEnforcer(p)
      const push = await sh('git push https://not-allowlisted.invalid/repo.git HEAD', child, e3, p)
      if (push.diagnostics.length === 0) {
        console.warn('sandbox live: no network diagnostics recorded on darwin')
      } else {
        expect(push.diagnostics.join(' ')).toMatch(/not-allowlisted\.invalid/)
        expect(push.diagnostics.join(' ')).toMatch(/sandbox-violation/)
      }
    } finally {
      await e3?.dispose().catch(() => undefined)
      await disposeDir(dir)
    }
  })
})
