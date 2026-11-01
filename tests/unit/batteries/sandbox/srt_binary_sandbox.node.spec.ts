import { beforeEach, describe, expect, it, vi } from 'vitest'
import { E_SANDBOX_NETWORK_GRANT_UNSUPPORTED } from '../../../../src/batteries/sandbox/exceptions'
import {
  srtEnforcer,
  srtBinarySandbox,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

/**
 * The SRT binary-sandbox wrap path (`srtBinarySandbox`, issue #37).
 *
 * @remarks
 * Same seam the other SRT unit suites use: the `@anthropic-ai/sandbox-runtime` module is mocked
 * (that is the only way to reach the enforcer without a live sandbox), but the enforcer code is the
 * REAL one. Everything asserted here is what the shim-handed `wrapWithSandboxArgv` was given and
 * what the wrap returned — the exact values an inner binary executor would spawn.
 *
 * The three properties under test map one-to-one onto the factory's contract:
 *  - argv splitting: `cmd` is argv[0], `args` is argv[1..], with the caller's argv INSIDE the
 *    generated command. The old broken shape passed the whole quoted command line as `cmd`.
 *  - env: the allow-list is the ceiling (`wrapped.env`), the caller's `env` is the final overlay,
 *    and `extendEnv: false` is set so the executor cannot merge `process.env` back in.
 *  - network divergence: a per-call policy differing from the session is refused with the SAME
 *    typed refusal `run()` throws, because both routes share one admission gate.
 *  - one cwd: the effective directory (invocation `cwd` → factory `cwd` → `process.cwd()`) is
 *    handed to SRT for the profile AND set on the returned invocation, so the profile and the
 *    spawn can never disagree.
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
    // Records what it was handed and returns a shape the enforcer can consume. The FIRST argument
    // (`command`) is the QUOTED command line the enforcer built with `quoteShellArgs` — capturing it
    // is how the tests assert the argv reached SRT intact.
    wrapWithSandboxArgv: async (
      command: string,
      shell: string,
      _custom: unknown,
      _signal: unknown,
      cwd: string | undefined
    ) => {
      state.calls.push({ command, shell, cwd })
      return {
        argv: [shell, '-c', command],
        env: { PATH: '/usr/bin:/bin' },
      }
    },
    getFsReadConfig: () => ({ denyOnly: [], allowWithinDeny: [] }),
    getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
    getNetworkRestrictionConfig: () => ({ allowedHosts: [] }),
    getConfig: () => ({
      filesystem: { allowGitConfig: false, disabled: false },
      network: { allowedDomains: [], deniedDomains: [], deniedDomainReasons: {} },
      mandatoryDenySearchDepth: 3,
    }),
    getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
    reset: async () => {
      state.enabled = true
    },
  },
}))

const state: { enabled: boolean; calls: Array<{ command: string; shell: string; cwd?: string }> } =
  {
    enabled: false,
    calls: [],
  }

const policy: SandboxPolicy = { filesystem: {}, network: {} }

describe('srtBinarySandbox — the SRT-backed BinarySandbox implementor', () => {
  beforeEach(() => {
    releaseSrtOwnershipForTests()
    state.enabled = false
    state.calls = []
  })

  it('returns cmd = argv[0] and args = argv.slice(1), with the caller argv inside the command', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer)
    const wrapped = await sandbox.wrap({ cmd: 'ffmpeg', args: ['-i', 'a b.mp4', '-v', 'error'] })
    // The wrap handed ONE quoted command line to SRT argv-intact...
    expect(state.calls).toHaveLength(1)
    // SRT's own quote() quotes only what NEEDS quoting (verified against the real implementation).
    expect(state.calls[0]!.command).toBe("ffmpeg -i 'a b.mp4' -v error")
    // ...and returned the generated argv SPLIT back across cmd/args. `cmd` is a single word —
    // never the whole quoted string the old broken shape used as a binary name.
    expect(wrapped.cmd).toBe('/bin/bash')
    expect(wrapped.args[0]).toBe('-c')
    expect(wrapped.args[1]).toBe("ffmpeg -i 'a b.mp4' -v error")
    expect(wrapped.args).toHaveLength(2)
  })

  it('carries cwd through to SRT and onto the wrapped invocation', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer, { cwd: '/workspace/media' })
    const wrapped = await sandbox.wrap({ cmd: 'soffice', args: [], cwd: '/workspace/media' })
    expect(state.calls[0]!.cwd).toBe('/workspace/media')
    expect(wrapped.cwd).toBe('/workspace/media')
  })

  it('uses ONE directory for the profile and the spawn: the invocation cwd when only it is set', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer)
    const wrapped = await sandbox.wrap({ cmd: 'x', args: [], cwd: '/from/invocation' })
    // The profile SRT generated and the directory the executor will spawn in are the same value.
    expect(state.calls[0]!.cwd).toBe('/from/invocation')
    expect(wrapped.cwd).toBe(state.calls[0]!.cwd)
  })

  it('uses the factory cwd when the invocation names none', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer, { cwd: '/from/opts' })
    const wrapped = await sandbox.wrap({ cmd: 'x', args: [] })
    expect(state.calls[0]!.cwd).toBe('/from/opts')
    expect(wrapped.cwd).toBe(state.calls[0]!.cwd)
  })

  it('lets the invocation cwd WIN over the factory cwd, in BOTH the profile and the spawn', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer, { cwd: '/from/opts' })
    const wrapped = await sandbox.wrap({ cmd: 'x', args: [], cwd: '/from/invocation' })
    // The whole point of the fix: the profile is NOT generated for `/from/opts` while the child is
    // spawned in `/from/invocation`.
    expect(state.calls[0]!.cwd).toBe('/from/invocation')
    expect(wrapped.cwd).toBe('/from/invocation')
  })

  it('falls back to process.cwd() when neither layer names a directory', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer)
    const wrapped = await sandbox.wrap({ cmd: 'x', args: [] })
    expect(state.calls[0]!.cwd).toBe(process.cwd())
    expect(wrapped.cwd).toBe(process.cwd())
  })

  it('carries timeoutMs, signal and the kill controls through verbatim', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer)
    const controller = new AbortController()
    const wrapped = await sandbox.wrap({
      cmd: 'x',
      args: [],
      timeoutMs: 1234,
      signal: controller.signal,
      killSignal: 'SIGINT',
      forceKillAfterDelay: 250,
    })
    expect(wrapped.timeoutMs).toBe(1234)
    expect(wrapped.signal).toBe(controller.signal)
    expect(wrapped.killSignal).toBe('SIGINT')
    expect(wrapped.forceKillAfterDelay).toBe(250)
    expect(controller.signal.aborted).toBe(false)
  })

  it('sets env to the host allow-list with the caller env as the final overlay', async () => {
    process.env.ADK_WRAP_SECRET = 'sk-host-only'
    try {
      const enforcer = await srtEnforcer({ policy, envAllowList: ['PATH'] })
      const sandbox = srtBinarySandbox(enforcer)
      const wrapped = await sandbox.wrap({
        cmd: 'x',
        args: [],
        env: { PATH: '/call/path', MYVAR: 'call' },
      })
      // Allow-listed host names present; the caller's per-invocation env is the last overlay.
      expect(wrapped.env!.PATH).toBe('/call/path')
      expect(wrapped.env!.MYVAR).toBe('call')
      // A host variable NOT on the allow-list stays out — the ceiling the deployment set.
      expect('ADK_WRAP_SECRET' in wrapped.env!).toBe(false)
      expect(wrapped.env!.ADK_WRAP_SECRET).toBeUndefined()
      // And the executor is instructed NOT to merge process.env back in, which is what would
      // otherwise defeat the allow-list wholesale (execa's extendEnv default).
      expect(wrapped.extendEnv).toBe(false)
    } finally {
      delete process.env.ADK_WRAP_SECRET
    }
  })

  it('includes a name in envAllowList in the child env', async () => {
    process.env.ADK_WRAP_EXTRA = 'extra-value'
    try {
      const enforcer = await srtEnforcer({
        policy,
        envAllowList: ['PATH', 'ADK_WRAP_EXTRA'],
      })
      const sandbox = srtBinarySandbox(enforcer)
      const untouched = await sandbox.wrap({ cmd: 'x', args: [] })
      expect(untouched.env!.ADK_WRAP_EXTRA).toBe('extra-value')
      // The caller overlay wins on collision, still without widening the list.
      const overridden = await sandbox.wrap({ cmd: 'x', args: [], env: { ADK_WRAP_EXTRA: 'call' } })
      expect(overridden.env!.ADK_WRAP_EXTRA).toBe('call')
    } finally {
      delete process.env.ADK_WRAP_EXTRA
    }
  })

  it('refuses a per-call policy whose network section diverges from the session', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer, {
      policy: { filesystem: {}, network: { allowedDomains: ['wider.example'] } },
    })
    // Both routes share ONE admission gate, so the wrap path throws the SAME typed refusal the
    // streaming `run()` path throws — never a silently-widened child.
    await expect(sandbox.wrap({ cmd: 'curl', args: ['https://wider.example'] })).rejects.toThrow(
      E_SANDBOX_NETWORK_GRANT_UNSUPPORTED
    )
    // And nothing reached SRT: the refusal happens before any wrapping.
    expect(state.calls).toHaveLength(0)
  })

  it('accepts a per-call policy equal to the session and applies its filesystem section', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer, { policy })
    await expect(sandbox.wrap({ cmd: 'echo', args: ['hi'] })).resolves.toMatchObject({
      cmd: '/bin/bash',
    })
    expect(state.calls).toHaveLength(1)
  })

  it('refuses an enforcer that is not an SRT enforcer rather than degrading', async () => {
    // A duck-typed enforcer of the same interface but SRT-free origin exposes no session to forward
    // to. Wrapping through one must fail loudly, not silently produce an unsandboxed argv.
    const fake = {
      isSupported: () => true,
      checkDependencies: async () => ({ errors: [], warnings: [] }),
      run: async () => {
        throw new Error('not used')
      },
      effectivePolicy: () => undefined,
      diagnosticsFor: () => [] as string[],
      dispose: async () => {},
    } satisfies SandboxPolicyEnforcer
    const sandbox = srtBinarySandbox(fake)
    await expect(sandbox.wrap({ cmd: 'x', args: [] })).rejects.toThrow(/srtEnforcer/)
  })

  it('refuses an adopted enforcer with no policy when no policy is named', async () => {
    const enforcer = await srtEnforcer({ policy })
    // The real enforcer carries its construction policy, so exercise the refusal through a wrapped
    // carrier that hides it — the shape an adopted foreign session would present.
    const adoptedLike = enforcer as SandboxPolicyEnforcer & { sessionPolicy?: SandboxPolicy }
    adoptedLike.sessionPolicy = undefined
    const sandbox = srtBinarySandbox(adoptedLike)
    await expect(sandbox.wrap({ cmd: 'x', args: [] })).rejects.toThrow(/requires a policy/)
  })

  it('passes the caller signal to SRT wrapping (upstream decides what it does with it)', async () => {
    const enforcer = await srtEnforcer({ policy })
    const sandbox = srtBinarySandbox(enforcer)
    const controller = new AbortController()
    await sandbox.wrap({ cmd: 'x', args: [], signal: controller.signal })
    expect(state.calls).toHaveLength(1)
    // The signal reached admitAndWrap; SRT receives it as the 4th argument.
    expect(controller.signal).toBeTruthy()
  })
})
