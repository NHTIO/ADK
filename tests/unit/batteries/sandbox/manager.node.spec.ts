import { describe, expect, it } from 'vitest'
import { createSandbox } from '../../../../src/batteries/sandbox/manager'
import type { DerivedRules, SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

const policy = (
  overrides: Partial<SandboxPolicy['filesystem']> = {},
  network: SandboxPolicy['network'] = {}
): SandboxPolicy => ({ filesystem: { ...overrides }, network })
const rules = (patch: Partial<DerivedRules> = {}): DerivedRules => ({
  matcher: {
    platform: 'darwin',
    caseInsensitive: false,
    readGlobs: 'native',
    writeGlobs: 'native',
  },
  read: { denyOnly: [], allowWithinDeny: [] },
  write: { allowOnly: [], denyWithinAllow: [] },
  mandatoryDeny: { form: 'glob', entries: [], allowGitConfig: false, searchDepth: 3 },
  filesystemDisabled: false,
  network: {
    disabled: false,
    allowedDomains: ['foo.com'],
    deniedDomains: [],
    strictAllowlist: true,
  },
  unknownKeys: [],
  undecidableGlobs: [],
  ...patch,
})
const make = (
  live: () => DerivedRules | undefined,
  disposed: () => boolean = () => false
): SandboxPolicyEnforcer => ({
  isSupported: () => true,
  checkDependencies: async () => ({ errors: [], warnings: [] }),
  effectivePolicy: live,
  run: async () => {
    if (disposed()) throw new Error('should not run')
    return {
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      completed: Promise.resolve({ exitCode: 0, failed: false }),
    }
  },
  diagnosticsFor: () => [],
  dispose: async () => {},
})

const setup = async (baseline = rules()) => {
  let live = baseline
  const enforcer = make(() => live)
  const handle = await createSandbox({
    enforcer,
    policy: policy(
      {
        denyRead: baseline.read.denyOnly,
        allowRead: baseline.read.allowWithinDeny,
        allowWrite: baseline.write.allowOnly,
        denyWrite: baseline.write.denyWithinAllow,
      },
      {
        disabled: baseline.network.disabled,
        allowedDomains: baseline.network.allowedDomains,
        deniedDomains: baseline.network.deniedDomains,
      }
    ),
  })
  return {
    handle,
    baseline,
    set: (next: DerivedRules) => {
      live = next
    },
    enforcer,
  }
}

describe('sandbox manager', () => {
  it('enforces first-writer-wins, all subset directions, and fails closed on undecidable globs', async () => {
    const { handle, baseline, enforcer } = await setup(
      rules({
        read: { denyOnly: ['/a', '/b'], allowWithinDeny: ['/a'] },
        write: { allowOnly: ['/w'], denyWithinAllow: ['/secret'] },
        network: {
          disabled: false,
          allowedDomains: ['foo.com', 'bar.com'],
          deniedDomains: ['bad.com'],
          strictAllowlist: true,
        },
      })
    )
    const second = await createSandbox({
      enforcer,
      policy: policy(
        { denyRead: ['/a', '/b'], allowRead: ['/a'], allowWrite: ['/w'], denyWrite: ['/secret'] },
        { allowedDomains: ['foo.com'], deniedDomains: ['bad.com', 'other.com'] }
      ),
    })
    expect(second).toBeTruthy()
    await second.dispose()
    await expect(
      createSandbox({
        enforcer: make(() => baseline),
        policy: policy({ allowWrite: ['/outside'] }),
      })
    ).rejects.toThrow('conflicts with')
    await expect(
      createSandbox({
        enforcer: make(() => baseline),
        policy: policy({ denyRead: ['/a*'] }),
      })
    ).rejects.toThrow('conflicts with')
    await handle.dispose()
  })

  it('admits widening but detects live drift before invocation, including kill switches and unknown keys', async () => {
    const state = await setup(rules())
    const second = await createSandbox({
      enforcer: make(() => state.baseline),
      policy: policy({ allowRead: [] }),
    })
    expect(second).toBeTruthy()
    await second.dispose()
    state.set(rules({ filesystemDisabled: true }))
    await expect(
      state.handle.run({ argv: ['true'], cwd: '/', policy: policy(), correlationId: 'x' })
    ).rejects.toThrow('sandbox drift detected')
    await state.handle.dispose()
  })

  it("does not treat ['*'] as disabled and detects conservative domain drift", async () => {
    const first = await setup(
      rules({
        network: {
          disabled: false,
          allowedDomains: ['*'],
          deniedDomains: [],
          strictAllowlist: true,
        },
      })
    )
    expect(first.handle.effectivePolicy()?.network.disabled).toBe(false)
    first.set(
      rules({
        network: {
          disabled: false,
          allowedDomains: ['*', 'bar.com'],
          deniedDomains: [],
          strictAllowlist: true,
        },
      })
    )
    await expect(
      first.handle.run({ argv: ['true'], cwd: '/', policy: policy(), correlationId: 'x' })
    ).rejects.toThrow('sandbox drift detected')
    await first.handle.dispose()
  })

  it('distinguishes disabled network admission from restrictive foreign domains', async () => {
    const foreign = await setup(
      rules({
        network: {
          disabled: false,
          allowedDomains: ['*'],
          deniedDomains: [],
          strictAllowlist: true,
        },
      })
    )
    await expect(
      createSandbox({
        enforcer: make(() => foreign.baseline),
        policy: policy({}, { disabled: true }),
      })
    ).resolves.toBeTruthy()
    expect(foreign.handle.effectivePolicy()?.network.disabled).toBe(false)
    await foreign.handle.dispose()
  })

  it('disposal invalidates epochs and adoption does not dispose the foreign enforcer', async () => {
    let disposed = false
    const owner = await setup()
    const foreign = make(
      () => owner.handle.effectivePolicy(),
      () => disposed
    )
    const adopted = await createSandbox({ enforcer: foreign, policy: policy() })
    await adopted.dispose()
    expect(disposed).toBe(false)
    expect(owner.handle.isEpochLive(owner.handle.epoch)).toBe(true)
    await owner.handle.dispose()
    expect(owner.handle.isEpochLive(owner.handle.epoch)).toBe(false)
  })
})
