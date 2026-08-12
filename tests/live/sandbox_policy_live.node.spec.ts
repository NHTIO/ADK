// RELEASE-GATING: these are real SRT child processes, not unit fakes.
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  RUN,
  platform,
  tempDir,
  disposeDir,
  makeFile,
  makeEnforcer,
  run,
  nodeFor,
  mandatoryFor,
  mandatoryNames,
  hasEffectivePolicy,
} from './sandbox_live_helpers'
import type { SandboxPolicy } from '../../src/batteries/sandbox/types'

const policy = (filesystem: SandboxPolicy['filesystem'] = {}): SandboxPolicy => ({
  filesystem,
  network: {},
})

describe.skipIf(!RUN)('sandbox — live policy evaluator agreement (release)', () => {
  it('agrees on asymmetric defaults, precedence, disabled axes, and defaults', async () => {
    const dir = await tempDir()
    const p = policy({ gitSafeDirectories: [dir] })
    const e = await makeEnforcer(p)
    try {
      await makeFile(join(dir, 'read'))
      if (!hasEffectivePolicy(e)) {
        console.warn('sandbox live: skipping case rules; effectivePolicy snapshot unavailable')
        return
      }
      if (!hasEffectivePolicy(e)) {
        console.warn(
          'sandbox live: skipping policy agreement; effectivePolicy snapshot unavailable'
        )
        return
      }
      const n = await nodeFor(e, p, mandatoryFor(dir, p))
      for (const [path, expected] of [
        [join(dir, 'read'), true],
        [join(dir, 'write'), false],
      ] as const) {
        const child = await run(
          e,
          p,
          ['sh', '-c', expected ? 'cat "$1" >/dev/null' : 'printf x > "$1"', 'sh', path],
          dir
        )
        expect(child.exitCode === 0).toBe(expected)
        expect(expected ? n.canRead(path) : n.canWrite(path)).toBe(expected)
      }
      const outside = join(dir, 'outside')
      const nested = join(dir, 'me')
      const q = policy({
        denyRead: [dir],
        allowRead: [nested],
        allowWrite: [dir],
        denyWrite: [nested],
      })
      // `SandboxManager` is a PROCESS-GLOBAL singleton and its second `initialize()` is a NO-OP —
      // verified directly: initialise with denyRead ['/tmp/AAA'], then again with ['/tmp/BBB'], and
      // the derived rules still report ['/tmp/AAA']. Only `dispose()` (which calls `reset()`) lets a
      // new policy take. So the FIRST enforcer must be released before building the next one, or
      // every nested case below silently evaluates the OUTER policy and the agreement it claims to
      // prove is vacuous. This mirrors the first-writer-wins constraint the plan documents.
      await e.dispose()
      const eq = await makeEnforcer(q)
      try {
        const nq = await nodeFor(eq, q, mandatoryFor(dir, q))
        // DENY-THEN-ALLOW, verified against the live derivation:
        //   read.denyOnly = [dir], read.allowWithinDeny = [nested]
        // `outside` is INSIDE the denied `dir` and is NOT re-permitted, so it is refused. The
        // plan's worked example ("everything outside /Users is readable") is about paths outside
        // the DENY ENTRY — not about a path merely named "outside" within it. Asserting `true`
        // here would demand the evaluator ignore its own deny list.
        expect(nq.canRead(outside)).toBe(false)
        // A sibling genuinely outside the deny entry IS readable — reads default to ALLOW, and
        // this is the assertion that actually pins the asymmetry.
        expect(nq.canRead('/etc/hosts')).toBe(true)
        // `allowRead` WINS inside `denyRead` …
        expect(nq.canRead(nested)).toBe(true)
        // … while on the write axis the precedence is INVERTED: `denyWrite` wins inside
        // `allowWrite`, so the same path is writable-denied.
        expect(nq.canWrite(nested)).toBe(false)
        expect(nq.canWrite(join(dir, 'elsewhere'))).toBe(true)
      } finally {
        await eq.dispose()
      }
      const disabled = policy({ disabled: true })
      const ed = await makeEnforcer(disabled)
      try {
        const nd = await nodeFor(ed, disabled)
        expect(nd.canRead('/anything')).toBe(true)
        expect(nd.canWrite('/anything')).toBe(true)
      } finally {
        await ed.dispose()
      }
      await makeFile(join(dir, 'read'))
      // A FRESH enforcer: `e` was disposed above so the nested policies could take effect on the
      // process-global singleton. Re-initialising `p` is what makes this assertion about `p`.
      const ep = await makeEnforcer(p)
      try {
        // WRITES DEFAULT TO DENY, and this is the asymmetry that matters: with no `allowWrite` the
        // child cannot write an ordinary temp directory (verified: `test -w` exits 1). SRT DOES union
        // `getDefaultWritePaths()` into `allowOnly`, but those defaults are specific device/system
        // paths (`/dev/null`, `/dev/stdout`, …) — NOT an arbitrary workspace path. An earlier
        // revision asserted exit 0 here on the strength of that union, which mistook "defaults are
        // unioned" for "any path is writable".
        const refused = await run(ep, p, ['sh', '-c', 'test -w "$1"', 'sh', dir], dir)
        expect(refused.exitCode).not.toBe(0)
        // And the union IS real — one of the default write paths is writable without the ADK policy
        // ever naming it, which is the property `writeRoot` validation has to account for.
        const defaulted = await run(ep, p, ['sh', '-c', 'test -w /dev/null'], dir)
        expect(defaulted.exitCode).toBe(0)
      } finally {
        await ep.dispose()
      }
    } finally {
      await e.dispose()
      await disposeDir(dir)
    }
  })

  it('denies every mandatory dangerous file, directory, and subtree in both mechanisms', async () => {
    // THE MANDATORY-DENY SET IS RESOLVED AGAINST `process.cwd()`, NOT AGAINST `allowWrite`.
    // Upstream emits each dangerous name twice — once resolved against the parent's cwd and once as
    // a `**/<name>` subtree glob — so a `.bashrc` inside a fresh TEMP dir is genuinely PERMITTED
    // (verified: exit 0), while the same name under the real cwd is DENIED (verified: exit 1, and
    // likewise `.mcp.json` and `.git/hooks/pre-commit`, with an ordinary file still writable).
    //
    // An earlier revision concluded from the temp-dir result that "darwin SRT permits these paths"
    // and skipped the whole test on darwin — retiring the single most valuable assertion in the
    // suite (the one that stops `save_media` out-permitting the shell) on a false premise. The fix
    // is to test where the profile actually places the rules.
    const cwd = process.cwd()
    const p = policy({ allowWrite: [cwd], gitSafeDirectories: [cwd] })
    const e = await makeEnforcer(p)
    const scratch = join(cwd, 'tmp')
    try {
      const n = await nodeFor(e, p, mandatoryFor(cwd, p))
      // A control FIRST: an ordinary path under the same root must be writable by both mechanisms,
      // otherwise a blanket-deny bug would make every assertion below pass for the wrong reason.
      const control = join(scratch, 'live-mandatory-control.txt')
      await makeFile(control)
      expect(n.canWrite(control), 'control').toBe(true)
      const controlChild = await run(e, p, ['sh', '-c', 'printf x > "$1"', 'sh', control], cwd)
      expect(controlChild.exitCode, 'control').toBe(0)
      await rm(control, { force: true })
      // Now the boundary. These files are NOT created — the profile denies the PATH, and creating a
      // real `.bashrc` in the repo root would be a destructive side effect of a test.
      for (const name of mandatoryNames()) {
        const path = join(cwd, name)
        expect(n.canWrite(path), name).toBe(false)
        const result = await run(e, p, ['sh', '-c', 'printf x > "$1"', 'sh', path], cwd)
        expect(result.exitCode, name).not.toBe(0)
      }
      // And the SUBTREE form, which is the `**/<name>` glob rather than the cwd-resolved entry.
      const sub = join(scratch, 'sub/dir/.bashrc')
      expect(n.canWrite(sub)).toBe(false)
      const subResult = await run(e, p, ['sh', '-c', 'printf x > "$1"', 'sh', sub], cwd)
      expect(subResult.exitCode).not.toBe(0)
    } finally {
      await e.dispose()
    }
  })

  it('pins the four case rules and ordinary-list case sensitivity', async () => {
    const dir = await tempDir()
    const p = policy({
      allowWrite: [dir],
      denyRead: [join(dir, '*.secret'), join(dir, 'literal')],
      denyWrite: [join(dir, 'deny')],
      gitSafeDirectories: [dir],
    })
    const e = await makeEnforcer(p)
    try {
      if (!hasEffectivePolicy(e)) {
        console.warn('sandbox live: skipping case rules; effectivePolicy snapshot unavailable')
        return
      }
      const n = await nodeFor(e, p, mandatoryFor(dir, p))
      if (platform === 'darwin') expect(n.canWrite(join(dir, '.BASHRC'))).toBe(true)
      if (platform === 'linux') {
        expect(n.canWrite(join(dir, '.BASHRC'))).toBe(false)
        expect(n.canWrite(join(dir, 'sub/repo/.GIT/hooks/pre-commit'))).toBe(true)
      }
      // CASE SENSITIVITY IS ABOUT THE LITERAL SEGMENTS, NOT THE WILDCARD. `*.secret` translates to
      // `[^/]*\.secret`, and `[^/]*` matches `FOO` as readily as `foo` — so `FOO.secret` IS denied,
      // and asserting otherwise would demand a matcher that ignores its own wildcard. Verified
      // against upstream's own `globToRegex`, which produces the identical pattern.
      expect(n.canRead(join(dir, 'FOO.secret'))).toBe(false)
      expect(n.canRead(join(dir, 'foo.secret'))).toBe(false)
      // The LITERAL entry is where case sensitivity is observable: `literal` is denied, `LITERAL`
      // is not, because the derived lists are compared unfolded on macOS AND Linux.
      expect(n.canRead(join(dir, 'LITERAL'))).toBe(true)
      expect(n.canRead(join(dir, 'literal'))).toBe(false)
      expect(n.canWrite(join(dir, 'DENY'))).toBe(true)
      // `ALLOW` sits inside `allowWrite: [dir]` and is not re-denied — writes are allow-only, and
      // only the literal `deny` entry carves an exception out of it, so this IS writable. Expecting
      // `false` here would be asserting that an allow-list denies its own contents.
      expect(n.canWrite(join(dir, 'ALLOW'))).toBe(true)
      expect(n.canWrite(join(dir, 'deny'))).toBe(false)
    } finally {
      await e.dispose()
      await disposeDir(dir)
    }
  })

  it('handles Linux git states, nested repositories, and bounded depth', async () => {
    if (platform !== 'linux') return
    const dir = await tempDir()
    const p = policy({
      allowWrite: [dir],
      gitSafeDirectories: [dir],
      mandatoryDenySearchDepth: 1,
    })
    const e = await makeEnforcer(p)
    try {
      for (const state of ['directory', 'file', 'absent']) {
        const git = join(dir, '.git')
        if (state === 'directory') await makeFile(join(git, 'config'))
        else if (state === 'file') await makeFile(git, 'gitdir: x')
        const n = await nodeFor(e, p, mandatoryFor(dir, p))
        expect(n.canWrite(join(git, 'config')), state).toBe(state === 'directory' ? false : true)
        await rm(git, { recursive: true, force: true })
      }
      const nested = join(dir, 'sub/repo/.git/hooks/pre-commit')
      await makeFile(nested)
      const nestedNode = await nodeFor(e, p, mandatoryFor(dir, p))
      expect(nestedNode.canWrite(nested)).toBe(false)
      const deep = join(dir, 'a/b/c/d/.bashrc')
      await makeFile(deep)
      const deepNode = await nodeFor(e, p, mandatoryFor(dir, p))
      expect(deepNode.canWrite(deep)).toBe(true)
    } finally {
      await e.dispose()
      await disposeDir(dir)
    }
  })
})
