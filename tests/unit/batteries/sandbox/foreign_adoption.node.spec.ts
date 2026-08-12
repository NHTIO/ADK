import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSandbox } from '../../../../src/batteries/sandbox/manager'
import { E_SANDBOX_POLICY_CONFLICT } from '../../../../src/batteries/sandbox/exceptions'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'

/**
 * Mutable fake-manager state, shared with the module mock below.
 *
 * @remarks
 * `srtEnforcer` deep-imports `@anthropic-ai/sandbox-runtime`, so the only way to drive the ADOPTION
 * branch hermetically is to mock that module and let each test set `enabled` before construction.
 * `initializes`/`resets` are COUNTERS rather than booleans: the contract is that adoption calls
 * `initialize()` exactly ZERO times and never resets a manager it did not create, and a counter can
 * distinguish "never called" from "called once" where a boolean cannot.
 */
const state: {
  enabled: boolean
  initializes: number
  resets: number
  config: ReturnType<typeof foreignConfig> | undefined
  read: { denyOnly: string[]; allowWithinDeny: string[] }
  write: { allowOnly: string[]; denyWithinAllow: string[] }
} = {
  enabled: false,
  initializes: 0,
  resets: 0,
  config: undefined,
  read: { denyOnly: [], allowWithinDeny: [] },
  write: { allowOnly: [], denyWithinAllow: [] },
}

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    // The process-global's real behaviour: `initialize` only takes effect when nothing is enabled yet,
    // and a second call is a no-op. The fake records the CALL so a test can prove adoption never made
    // one, which is the property that matters.
    initialize: async (config: unknown) => {
      // A REAL AWAIT POINT. Without one, `async` alone does not yield: both concurrent constructions
      // run start-to-finish before the other resumes, so the interleaving the concurrency guard exists
      // for is unreachable and mutating that guard leaves the suite green. Real SRT does far more work
      // here (proxies, profile generation), so yielding is the faithful shape.
      await Promise.resolve()
      state.initializes += 1
      if (!state.enabled) {
        state.enabled = true
        const next = config as { filesystem?: Record<string, string[] | boolean> }
        state.config = config as ReturnType<typeof foreignConfig>
        // Real SRT DERIVES its read/write lists from the config it was initialised with, so the fake
        // must too — otherwise the owned path would report empty lists and a test asserting the
        // requested policy is visible would be checking the fake rather than the enforcer.
        const fs = next.filesystem ?? {}
        const list = (key: string): string[] =>
          Array.isArray(fs[key]) ? (fs[key] as string[]) : []
        state.read = { denyOnly: list('denyRead'), allowWithinDeny: list('allowRead') }
        state.write = { allowOnly: list('allowWrite'), denyWithinAllow: list('denyWrite') }
      }
    },
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => state.enabled,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async (command: string, shell: string) => ({
      argv: [shell, '-c', command],
      env: {},
    }),
    getFsReadConfig: () => state.read,
    getFsWriteConfig: () => state.write,
    getNetworkRestrictionConfig: () => ({
      allowedHosts: state.config?.network.allowedDomains ?? [],
    }),
    getConfig: () => state.config,
    getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
    reset: async () => {
      state.resets += 1
      // MIRRORS UPSTREAM: `reset()` tears down the context but deliberately does NOT clear `config`,
      // so `isSandboxingEnabled()` remains true afterwards (verified in `sandbox-manager.js`). A fake
      // that cleared it would hide the exact interaction the enforcer's ownership marker exists for.
      state.enabled = true
    },
  },
}))

const requested = (network: SandboxPolicy['network'] = {}): SandboxPolicy => ({
  filesystem: { denyRead: ['/tmp/ours'], allowWrite: ['/tmp/ours'], allowGitConfig: false },
  network,
})
const foreignConfig = (allowedDomains: string[], allowGitConfig = false) => ({
  filesystem: { allowGitConfig, disabled: false },
  network: { allowedDomains, deniedDomains: [] },
  mandatoryDenySearchDepth: 3,
})
const foreignPolicy = (network: SandboxPolicy['network'] = {}): SandboxPolicy => ({
  filesystem: { denyRead: ['/tmp/foreign'], allowWrite: ['/tmp/foreign-write'] },
  network,
})
const foreign = async (allowedDomains = ['*'], allowGitConfig = false) => {
  // A genuinely FOREIGN session: somebody else's. The enforcer's ownership marker survives `reset()`
  // by design, so a test file that has already built an owned enforcer must relinquish it or every
  // later construction would take the owned branch and the adoption path would be unreachable.
  releaseSrtOwnershipForTests()
  state.enabled = true
  state.initializes = 0
  state.resets = 0
  state.config = foreignConfig(allowedDomains, allowGitConfig)
  state.read = { denyOnly: ['/tmp/foreign'], allowWithinDeny: [] }
  state.write = { allowOnly: ['/tmp/foreign-write'], denyWithinAllow: [] }
  const enforcer = await srtEnforcer({ policy: requested() })
  // Counters are zeroed AFTER construction so each assertion measures only the operation under test.
  // A previous test may have left this module owning the process, and the enforcer legitimately resets
  // before re-initialising its own session — that bookkeeping is not what these tests are about.
  state.resets = 0
  return enforcer
}
const owned = async () => {
  state.enabled = false
  state.initializes = 0
  state.resets = 0
  state.config = undefined
  state.read = { denyOnly: [], allowWithinDeny: [] }
  state.write = { allowOnly: [], denyWithinAllow: [] }
  const enforcer = await srtEnforcer({ policy: requested() })
  state.resets = 0
  return enforcer
}
const setup = async (enforcer: Awaited<ReturnType<typeof srtEnforcer>>, policy?: SandboxPolicy) =>
  createSandbox({ enforcer, policy: policy ?? foreignPolicy() })

describe('foreign SRT sandbox adoption', () => {
  beforeEach(async () => {
    // The enforcer keeps a module-scope ownership marker that survives `reset()` by design (upstream's
    // `config` is sticky, so clearing ours would make the next construction adopt a dead session).
    // Counters are therefore zeroed per test and the FAKE is the single source of truth about what is
    // live; assertions below read `state.resets`/`state.initializes` as deltas within one test.
    state.enabled = false
    state.initializes = 0
    state.resets = 0
    state.config = undefined
    state.read = { denyOnly: [], allowWithinDeny: [] }
    state.write = { allowOnly: [], denyWithinAllow: [] }
  })

  it('detects adoption without initializing and uses foreign filesystem lists', async () => {
    const enforcer = await foreign()
    expect(enforcer.adopted).toBe(true)
    expect(state.initializes).toBe(0)
    const snapshot = enforcer.effectivePolicy()!
    expect(snapshot.read.denyOnly).toContain('/tmp/foreign')
    expect(snapshot.read.denyOnly).not.toContain('/tmp/ours')
    expect(snapshot.write.allowOnly).toContain('/tmp/foreign-write')
    expect(snapshot.write.allowOnly).not.toContain('/tmp/ours')
    await enforcer.dispose()
  })

  it('initializes the owned path and reflects the requested policy', async () => {
    const enforcer = await owned()
    expect(enforcer.adopted).toBe(false)
    expect(state.initializes).toBe(1)
    const snapshot = enforcer.effectivePolicy()!
    expect(snapshot.read.denyOnly).toContain('/tmp/ours')
    expect(snapshot.read.denyOnly).not.toContain('/tmp/foreign')
    expect(snapshot.write.allowOnly).toContain('/tmp/ours')
    await enforcer.dispose()
  })

  it('does not reset an adopted manager, but resets an owned manager', async () => {
    // TWO GUARDS, and this asserts BOTH — otherwise mutating either one leaves the suite green.
    // The manager skips `enforcer.dispose()` entirely under adoption, so going through the handle
    // alone never reaches the enforcer's own `!adopted` check and cannot prove it exists.
    const adopted = await foreign()
    const adoptedHandle = await setup(adopted)
    await adoptedHandle.dispose()
    expect(state.resets, 'the handle must not reset a foreign manager').toBe(0)
    expect(state.enabled, 'the foreign sandbox must still be in force').toBe(true)
    // Now call the ENFORCER's dispose DIRECTLY. This is the guard that protects a host application
    // whose sandbox we adopted: resetting here would strip ACEs it depends on.
    await adopted.dispose()
    expect(state.resets, 'the enforcer itself must not reset a foreign manager').toBe(0)
    expect(state.enabled, 'the foreign sandbox survives a direct enforcer dispose').toBe(true)

    const owner = await owned()
    const ownedHandle = await setup(owner, requested())
    await ownedHandle.dispose()
    expect(state.resets, 'an owned manager IS reset').toBe(1)
    // NOT `expect(state.enabled).toBe(false)`: upstream's `reset()` deliberately leaves `config` set,
    // so `isSandboxingEnabled()` stays true afterwards and the fake mirrors that. Asserting `false`
    // here would encode a behaviour SRT does not have — and it is precisely the sticky flag that the
    // enforcer's ownership marker exists to work around. The observable contract is the RESET COUNT.
  })

  it('keeps network.disabled false and records foreign domains literally', async () => {
    const enforcer = await foreign(['*', 'foreign.example'])
    const snapshot = enforcer.effectivePolicy()!
    expect(snapshot.network.disabled).toBe(false)
    expect(snapshot.network.allowedDomains).toEqual(['*', 'foreign.example'])
    await enforcer.dispose()
  })

  it("uses the mandatory exact ['*'] fixture to detect domain drift after a live widening", async () => {
    const enforcer = await foreign(['*'])
    const handle = await setup(enforcer)
    expect(state.config, 'the foreign fixture must have armed a config').toBeDefined()
    state.config!.network.allowedDomains = ['*', 'bar.com']
    expect(enforcer.effectivePolicy()!.network.allowedDomains).toEqual(['*', 'bar.com'])
    await expect(
      handle.run({
        argv: [process.execPath],
        cwd: process.cwd(),
        policy: { filesystem: {}, network: {} },
        correlationId: 'drift',
      })
    ).rejects.toThrow('sandbox drift detected')
    await handle.dispose()
  })

  it('admits disabled-network requests only against unrestricted foreign domains', async () => {
    const unrestricted = await foreign(['*'])
    const admitted = await setup(unrestricted, { ...foreignPolicy(), network: { disabled: true } })
    expect(admitted.effectivePolicy()!.network.disabled).toBe(false)
    await admitted.dispose()

    const restrictive = await foreign(['foo.com'])
    await expect(
      setup(restrictive, { ...foreignPolicy(), network: { disabled: true } })
    ).rejects.toThrow(E_SANDBOX_POLICY_CONFLICT)
  })

  it('re-derives each invocation and refuses the second run after foreign widening', async () => {
    const enforcer = await foreign(['*'])
    const handle = await setup(enforcer)
    const op = {
      argv: [process.execPath],
      cwd: process.cwd(),
      policy: { filesystem: {}, network: {} },
      correlationId: 'invoke',
    }
    await expect(handle.run(op)).resolves.toBeTruthy()
    expect(state.config, 'the foreign fixture must have armed a config').toBeDefined()
    state.config!.network.allowedDomains = ['*', 'bar.com']
    await expect(handle.run({ ...op, correlationId: 'invoke-2' })).rejects.toThrow(
      'sandbox drift detected'
    )
    await handle.dispose()
  })

  it('takes allowGitConfig from foreign config when reproducing mandatory denies', async () => {
    const denied = await foreign(['*'], false)
    const deniedEntries = denied.effectivePolicy()!.mandatoryDeny.entries
    expect(deniedEntries).toContain(`${process.cwd()}/.git/config`)

    const allowed = await foreign(['*'], true)
    const allowedEntries = allowed.effectivePolicy()!.mandatoryDeny.entries
    expect(allowedEntries).not.toContain(`${process.cwd()}/.git/config`)
    expect(deniedEntries.length).toBeGreaterThan(allowedEntries.length)
    await denied.dispose()
    await allowed.dispose()
  })

  it('refuses to replace a LIVE session established by this process, before touching it', async () => {
    // FIRST-WRITER-WINS MUST HOLD IN THE CONSTRUCTOR, not only in the manager's admission check.
    // `createSandbox()` compares policies AFTER `srtEnforcer()` has already run, and construction is
    // what touches the process-global — so a reset-and-reinitialise here would widen the real sandbox
    // and only THEN be refused, leaving the first caller on a baseline no longer in force.
    const first = await owned()
    expect(first.adopted).toBe(false)
    const firstLists = first.effectivePolicy()!.read.denyOnly
    state.initializes = 0
    state.resets = 0
    await expect(
      srtEnforcer({ policy: { filesystem: { denyRead: ['/tmp/second'] }, network: {} } }),
      'a second enforcer must be refused while the first session is live'
    ).rejects.toThrow(/still live/)
    // NOTHING was touched: no reset, no re-initialise, and the first policy is intact. Asserting the
    // throw alone would not distinguish "refused safely" from "refused after the damage".
    expect(state.resets, 'the live session must not have been reset').toBe(0)
    expect(state.initializes, 'the live session must not have been re-initialised').toBe(0)
    expect(first.effectivePolicy()!.read.denyOnly).toEqual(firstLists)
    // And after disposing, a new session CAN be established — otherwise the guard would be a deadlock.
    await first.dispose()
    const third = await srtEnforcer({
      policy: { filesystem: { denyRead: ['/tmp/third'] }, network: {} },
    })
    expect(third.adopted).toBe(false)
    await third.dispose()
  })

  it("refuses a CONCURRENT second construction instead of adopting the first caller's session", async () => {
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE — corrected, because an earlier version of this
    // comment gave the wrong reason. The fake DOES yield (`initialize()` awaits), so that is not the
    // limitation. The real reason a claim-after-initialize mutation still passes here is that the
    // fake's `initialize` sets `enabled` synchronously on the first call, so the second construction
    // resumes, sees `enabled === true`, and takes the ADOPTION branch — where the missing claim is
    // irrelevant. It is refused for a different reason than the one under test, and the counter still
    // reads one initialise. Measured: with the mutation applied, statuses are `fulfilled,rejected`
    // and `initializes === 1`.
    //
    // So this case pins the OUTCOME contract (exactly one winner; it is not adopted) and
    // `tests/live/sandbox_concurrency_live.node.spec.ts` is what actually fails when the guard is
    // broken — verified by mutation there against the real manager.
    //
    // The check and the claim must be ONE synchronous step. Two windows existed when they were not:
    //   · both constructions read `claimed === false` and the second re-initialised over the first;
    //   · the second saw sandboxing already enabled with our marker not yet set, classified a session
    //     WE established as FOREIGN, and adopted it — silently reporting the other caller's policy.
    // Asserting only "one rejected" would miss the second window, so this also asserts the survivor is
    // OWNED and that the loser did not come back adopted.
    releaseSrtOwnershipForTests()
    state.enabled = false
    state.initializes = 0
    state.resets = 0
    const settled = await Promise.allSettled([
      srtEnforcer({ policy: { filesystem: { denyRead: ['/tmp/first'] }, network: {} } }),
      srtEnforcer({ policy: { filesystem: { denyRead: ['/tmp/second'] }, network: {} } }),
    ])
    const winners = settled.filter((r) => r.status === 'fulfilled')
    expect(winners, 'exactly one construction may establish the session').toHaveLength(1)
    const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof srtEnforcer>>>)
      .value
    expect(winner.adopted, 'the survivor established its own session, so it is NOT adopted').toBe(
      false
    )
    expect(state.initializes, 'only one initialise may reach the process-global').toBe(1)
    await winner.dispose()
  })
})
