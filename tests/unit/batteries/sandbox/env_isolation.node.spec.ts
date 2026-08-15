import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E_INVALID_SANDBOX_CONFIG } from '../../../../src/batteries/sandbox/exceptions'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'

/**
 * A sandboxed child must not inherit the host's secrets.
 *
 * @remarks
 * The enforcer spread the entire `process.env` into every spawn, and nothing populated the contract's
 * `env` override — so a model directing `run_shell_command`'s argv could run `env` and read the host's
 * credentials straight back into its own context. No filesystem or network policy prevents that: the
 * value arrives in the tool RESULT, not over the wire.
 *
 * Every assertion here inspects the env handed to `spawn`, never the command's output. Asserting output
 * would pass for the wrong reason the moment a command merely failed for an unrelated cause — the exact
 * shape of invalid test that lets a security regression through.
 */

/** Captures what the enforcer actually asked `child_process.spawn` for. */
const spawns: Array<{ env: Record<string, string | undefined> }> = []

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, _argv: string[], opts: { env: Record<string, string | undefined> }) => {
    spawns.push({ env: opts.env })
    // Minimal duck of the surface `run()` touches: two closable streams and the two lifecycle events.
    const stream = () => ({
      on: () => undefined,
      [Symbol.asyncIterator]: async function* () {
        // no output
      },
    })
    return {
      stdout: stream(),
      stderr: stream(),
      once: (event: string, cb: (code?: number) => void) => {
        if (event === 'close') queueMicrotask(() => cb(0))
      },
    }
  },
}))

const initConfigs: Array<Record<string, unknown>> = []

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: async (config: unknown) => {
      await Promise.resolve()
      initConfigs.push(config as Record<string, unknown>)
      state.enabled = true
    },
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => state.enabled,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    // Returns SRT's own plumbing so a test can prove it still outranks the host half.
    wrapWithSandboxArgv: async (command: string, shell: string) => ({
      argv: [shell, '-c', command],
      env: {
        HTTP_PROXY: 'http://localhost:9999',
        NODE_EXTRA_CA_CERTS: '/srt/ca.pem',
      },
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

const SECRET = 'FAKE_ADK_TEST_SECRET'
const EXTRA = 'FAKE_ADK_TEST_EXTRA'

/** Construct an enforcer and run one command, returning the env `spawn` was given. */
const envForRun = async (
  options: Partial<Parameters<typeof srtEnforcer>[0]> = {},
  op: { env?: Record<string, string> } = {}
): Promise<Record<string, string | undefined>> => {
  releaseSrtOwnershipForTests()
  state.enabled = false
  const enforcer = await srtEnforcer({ policy, ...options })
  spawns.length = 0
  await enforcer.run({
    argv: ['echo', 'hi'],
    policy,
    correlationId: `env-${spawns.length}`,
    cwd: process.cwd(),
    ...op,
  })
  return spawns[0]!.env
}

beforeEach(() => {
  process.env[SECRET] = 'sk-do-not-leak'
  process.env[EXTRA] = 'extra-value'
  spawns.length = 0
  initConfigs.length = 0
})

afterEach(() => {
  delete process.env[SECRET]
  delete process.env[EXTRA]
  releaseSrtOwnershipForTests()
})

describe('sandbox child environment isolation', () => {
  it('does not hand a host secret to the child', async () => {
    const env = await envForRun()
    expect(env[SECRET]).toBeUndefined()
    expect(Object.values(env)).not.toContain('sk-do-not-leak')
  })

  it("keeps SRT's own proxy and CA variables, which the boundary depends on", async () => {
    // The property that makes deny-by-default SAFE rather than merely strict: SRT's plumbing is spread
    // after the host half, so restricting the host half cannot break the network boundary.
    const env = await envForRun()
    expect(env.HTTP_PROXY).toBe('http://localhost:9999')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/srt/ca.pem')
  })

  it("lets SRT's plumbing OUTRANK an allow-listed host variable of the same name", async () => {
    // Pins the spread ORDER, which the two assertions above cannot: they only pass because the default
    // allow-list and SRT's keys do not overlap, so swapping the order leaves them green. Here the host
    // exports a stale HTTP_PROXY and the caller allow-lists it — SRT's value must still win, or an
    // ambient proxy would silently redirect traffic around the network boundary.
    process.env.HTTP_PROXY = 'http://stale-host-proxy'
    try {
      const env = await envForRun({ envAllowList: ['PATH', 'HTTP_PROXY'] })
      expect(env.HTTP_PROXY).toBe('http://localhost:9999')
    } finally {
      delete process.env.HTTP_PROXY
    }
  })

  it('passes PATH by default, so bare-name binaries still resolve', async () => {
    // Guards the `search_files` regression: the ripgrep searcher spawns `rg` by bare name, and on a
    // Homebrew or Nix host it is not on the PATH a shell synthesises from an empty environment.
    const env = await envForRun()
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('REPLACES the default allow-list rather than extending it', async () => {
    // The semantics a caller is most likely to assume backwards. Naming only EXTRA must drop PATH.
    const env = await envForRun({ envAllowList: [EXTRA] })
    expect(env[EXTRA]).toBe('extra-value')
    expect(env.PATH).toBeUndefined()
    expect(env[SECRET]).toBeUndefined()
  })

  it('passes exactly the names the allow-list gives, and nothing adjacent', async () => {
    const env = await envForRun({ envAllowList: ['PATH', EXTRA] })
    expect(env.PATH).toBe(process.env.PATH)
    expect(env[EXTRA]).toBe('extra-value')
    expect(env[SECRET]).toBeUndefined()
  })

  it('restores full inheritance under inheritHostEnv, the documented escape hatch', async () => {
    const env = await envForRun({ inheritHostEnv: true })
    expect(env[SECRET]).toBe('sk-do-not-leak')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('applies the per-call env last, over both the host half and SRT plumbing', async () => {
    const env = await envForRun(
      { envAllowList: ['PATH'] },
      { env: { PATH: '/call/path', HTTP_PROXY: 'http://call-proxy' } }
    )
    expect(env.PATH).toBe('/call/path')
    expect(env.HTTP_PROXY).toBe('http://call-proxy')
  })

  it('refuses an allow-list entry that is not a valid variable name', async () => {
    releaseSrtOwnershipForTests()
    state.enabled = false
    await expect(srtEnforcer({ policy, envAllowList: ['NOT A NAME'] })).rejects.toThrow(
      E_INVALID_SANDBOX_CONFIG
    )
    // Naming the offending value is what makes the failure actionable at startup.
    await expect(srtEnforcer({ policy, envAllowList: ['NOT A NAME'] })).rejects.toThrow(
      /NOT A NAME/
    )
  })

  it('omits an allow-listed name the host does not define, rather than defining it empty', async () => {
    const env = await envForRun({
      envAllowList: ['DEFINITELY_NOT_SET_ANYWHERE'],
    })
    expect('DEFINITELY_NOT_SET_ANYWHERE' in env).toBe(false)
  })
})

describe('nested sandbox pass-through', () => {
  it('reaches the initialize() config, which is the only place SRT reads it', async () => {
    // SRT resolves this from the module-level config `initialize()` stored, NOT from the per-call
    // config given to `wrapWithSandboxArgv` — so a fix threaded only through the per-call site would
    // compile, ship, and do nothing.
    releaseSrtOwnershipForTests()
    state.enabled = false
    await srtEnforcer({ policy, enableWeakerNestedSandbox: true })
    expect(initConfigs).toHaveLength(1)
    expect(initConfigs[0]!.enableWeakerNestedSandbox).toBe(true)
  })

  it('emits no key at all when unset, so an untouched config is unchanged', async () => {
    releaseSrtOwnershipForTests()
    state.enabled = false
    await srtEnforcer({ policy })
    expect(initConfigs).toHaveLength(1)
    expect('enableWeakerNestedSandbox' in initConfigs[0]!).toBe(false)
  })
})
