import { describe, expect, it } from 'vitest'
import { preflightSandbox } from '../../../../src/batteries/sandbox/preflight'
import {
  createSandboxObservability,
  emitBypass,
  emitFsNodeVersion,
} from '../../../../src/batteries/sandbox/observability'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

const enforcer = (overrides: Partial<SandboxPolicyEnforcer> = {}): SandboxPolicyEnforcer => ({
  isSupported: () => true,
  checkDependencies: async () => ({ errors: [], warnings: [] }),
  run: async () => ({
    stdout: new ReadableStream(),
    stderr: new ReadableStream(),
    completed: Promise.resolve({ exitCode: 0, failed: false }),
  }),
  effectivePolicy: () => ({
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
    network: { disabled: false, allowedDomains: [], deniedDomains: [], strictAllowlist: true },
    unknownKeys: [],
    undecidableGlobs: [],
  }),
  diagnosticsFor: () => [],
  dispose: async () => {},
  ...overrides,
})

describe('sandbox preflight and observability', () => {
  it.each([
    ['win32', 'WSL2'],
    ['browser', 'browser'],
  ] as const)('refuses %s before fallback or a handle exists', async (platform, wording) => {
    await expect(
      preflightSandbox({
        platform,
        enforcer: enforcer({ isSupported: () => platform !== 'browser' }),
        allowUnsandboxedFallback: true,
      })
    ).rejects.toThrow(new RegExp(`E_SANDBOX_UNSUPPORTED_ENV|${wording}`, 'i'))
  })

  it('fails dependencies, but surfaces warnings without failing', async () => {
    const events: unknown[] = []
    await expect(
      preflightSandbox({
        enforcer: enforcer({
          checkDependencies: async () => ({ errors: ['missing rg'], warnings: ['old SRT'] }),
        }),
        onSandbox: (e) => events.push(e),
      })
    ).rejects.toThrow('Sandbox dependencies are unavailable')
    const result = await preflightSandbox({
      enforcer: enforcer({
        checkDependencies: async () => ({ errors: [], warnings: ['old SRT'] }),
      }),
      onSandbox: (e) => events.push(e),
    })
    expect(result.dependencyWarnings).toEqual(['old SRT'])
    expect(events).toContainEqual({ kind: 'dependency-warnings', warnings: ['old SRT'] })
  })

  it('fires fallback only for the three pre-execution predicates', async () => {
    const cases = [
      enforcer({ effectivePolicy: () => undefined }),
      enforcer({ checkDependencies: async () => ({ errors: ['missing'], warnings: [] }) }),
      enforcer(),
    ]
    await expect(
      preflightSandbox({ enforcer: cases[0], allowUnsandboxedFallback: true })
    ).resolves.toMatchObject({ fallbackFired: true })
    await expect(
      preflightSandbox({ enforcer: cases[1], allowUnsandboxedFallback: true })
    ).resolves.toMatchObject({ fallbackFired: true })
    await expect(
      preflightSandbox({
        enforcer: cases[2],
        allowUnsandboxedFallback: true,
        optionalPeerPresent: false,
      })
    ).resolves.toMatchObject({ fallbackFired: true })
    for (const extra of [false, true]) {
      await expect(
        preflightSandbox({
          enforcer: enforcer(),
          allowUnsandboxedFallback: extra,
          optionalPeerPresent: true,
        })
      ).resolves.toMatchObject({ fallbackFired: false })
    }
    await expect(
      preflightSandbox({ enforcer: enforcer(), allowUnsandboxedFallback: true, strictMode: true })
    ).resolves.toMatchObject({ strictMode: true, fallbackFired: false })
  })

  it('redacts every path-bearing event and records bypass, drift skip, and SRT version', () => {
    const root = '/Users/alice/deep/absolute/host/root'
    const events: any[] = []
    const sink = createSandboxObservability({
      pathTranslator: { redact: (value: string) => value.replaceAll(root, '<root>') } as any,
      sink: (e) => events.push(e),
    })
    emitBypass(sink, `${root}/command`, `${root}/file`)
    sink({
      kind: 'drift-check',
      outcome: 'skipped',
      comparison: 'network-domains',
      path: `${root}/x`,
    })
    emitFsNodeVersion(sink, '71.0.0')
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'bypass', command: '<root>/command', path: '<root>/file' })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'drift-check', comparison: 'network-domains' })
    )
    expect(events).toContainEqual({ kind: 'fs-node-version', version: '71.0.0' })
    expect(JSON.stringify(events)).not.toContain(root)
  })
})
