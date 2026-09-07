import { describe, expect, it } from 'vitest'
import { createSandbox } from '../../../../src/batteries/sandbox/manager'
import { preflightSandbox } from '../../../../src/batteries/sandbox/preflight'
import {
  E_SANDBOX_FAILED,
  E_SANDBOX_POLICY_CONFLICT,
} from '../../../../src/batteries/sandbox/exceptions'
import {
  createSandboxObservability,
  emitBypass,
  emitFsNodeVersion,
} from '../../../../src/batteries/sandbox/observability'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
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

const policy: SandboxPolicy = {
  filesystem: {},
  network: {},
}

const conflictingPolicy: SandboxPolicy = {
  filesystem: { allowWrite: ['/tmp/only'] },
  network: {},
}

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const closedStream = (value?: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      if (value) controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })

describe('sandbox preflight and observability', () => {
  it('runs the opt-in spawn probe after admission and keeps it off by default', async () => {
    let calls = 0
    const backend = enforcer({
      run: async () => {
        calls += 1
        return {
          stdout: new ReadableStream({ start: (controller) => controller.close() }),
          stderr: new ReadableStream({ start: (controller) => controller.close() }),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      },
    })
    const first = await createSandbox({ enforcer: backend, policy })
    expect(calls).toBe(0)
    await first.dispose()
    const probed = await createSandbox({ enforcer: backend, policy, probeSpawn: true })
    expect(calls).toBe(1)
    await probed.dispose()
  })

  it('rejects a conflicting policy before probing it', async () => {
    let calls = 0
    const backend = enforcer({
      run: async () => {
        calls += 1
        return {
          stdout: closedStream(),
          stderr: closedStream(),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      },
    })
    const first = await createSandbox({ enforcer: backend, policy })
    await expect(
      createSandbox({ enforcer: backend, policy: conflictingPolicy, probeSpawn: true })
    ).rejects.toThrow('requested policy')
    expect(calls).toBe(0)
    await first.dispose()
  })

  it('probes the established owner enforcer rather than a later option enforcer', async () => {
    let ownerCalls = 0
    let optionCalls = 0
    const ownerEnforcer = enforcer({
      run: async () => {
        ownerCalls += 1
        return {
          stdout: closedStream(),
          stderr: closedStream(),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      },
    })
    const optionEnforcer = enforcer({
      run: async () => {
        optionCalls += 1
        return {
          stdout: closedStream(),
          stderr: closedStream(),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      },
    })
    const first = await createSandbox({ enforcer: ownerEnforcer, policy })
    const second = await createSandbox({ enforcer: optionEnforcer, policy, probeSpawn: true })
    expect(ownerCalls).toBe(1)
    expect(optionCalls).toBe(0)
    await second.dispose()
    await first.dispose()
  })

  it('serializes an owner probe failure and does not invalidate a concurrent construction', async () => {
    const probeStarted = deferred()
    const failProbe = deferred<never>()
    const ownerEnforcer = enforcer({
      run: async () => {
        probeStarted.resolve()
        return failProbe.promise
      },
    })
    const constructionA = createSandbox({ enforcer: ownerEnforcer, policy, probeSpawn: true })
    await probeStarted.promise
    const constructionB = createSandbox({ enforcer: enforcer(), policy })
    let bSettled = false
    void constructionB.then(
      () => {
        bSettled = true
      },
      () => {
        bSettled = true
      }
    )
    await Promise.resolve()
    // B must remain unsettled while A owns the establishment transaction and its probe is pending.
    expect(bSettled).toBe(false)
    failProbe.reject(new Error('probe failed'))
    await expect(constructionA).rejects.toThrow('Sandbox spawn probe failed')
    const handleB = await constructionB
    await expect(
      handleB.run({ argv: ['true'], policy, correlationId: 'race', cwd: '/' })
    ).resolves.toBeDefined()
    await handleB.dispose()
  })

  it('releases the establishment queue and rolls back after conflicts and probe failures', async () => {
    const first = await createSandbox({ enforcer: enforcer(), policy })
    await expect(
      createSandbox({ enforcer: enforcer(), policy: conflictingPolicy })
    ).rejects.toThrow('requested policy')
    await first.dispose()
    const failing = enforcer({
      run: async () => ({
        stdout: closedStream(),
        stderr: closedStream(),
        completed: Promise.resolve({ exitCode: 1, failed: true }),
      }),
    })
    await expect(createSandbox({ enforcer: failing, policy, probeSpawn: true })).rejects.toThrow(
      'Sandbox spawn probe failed'
    )
    // This policy conflicts with the failed call's baseline. It succeeds only if that failed
    // construction's owner was rolled back and this is admitted as a fresh first construction.
    const later = await createSandbox({ enforcer: enforcer(), policy: conflictingPolicy })
    await later.dispose()
  })

  it('ignores secondary disposal while a later probe is pending', async () => {
    const started = deferred()
    const releaseProbe = deferred<void>()
    const ownerEnforcer = enforcer({
      run: async () => {
        started.resolve()
        await releaseProbe.promise
        return {
          stdout: closedStream(),
          stderr: closedStream(),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      },
    })
    const first = await createSandbox({ enforcer: ownerEnforcer, policy })
    const second = await createSandbox({ enforcer: enforcer(), policy })
    const probing = createSandbox({ enforcer: enforcer(), policy, probeSpawn: true })
    await started.promise
    const secondaryDisposal = second.dispose()
    releaseProbe.resolve()
    const third = await probing
    await secondaryDisposal
    await third.dispose()
    await first.dispose()
  })

  it('keeps disposal behind a pending probe and remains safe to dispose twice', async () => {
    const probeStarted = deferred()
    const releaseProbe = deferred<void>()
    const probeEnforcer = enforcer({
      run: async () => {
        probeStarted.resolve()
        await releaseProbe.promise
        return {
          stdout: closedStream(),
          stderr: closedStream(),
          completed: Promise.resolve({ exitCode: 0, failed: false }),
        }
      },
    })
    const first = await createSandbox({ enforcer: probeEnforcer, policy })
    const pending = createSandbox({ enforcer: enforcer(), policy, probeSpawn: true })
    await probeStarted.promise
    const disposing = Promise.all([first.dispose(), first.dispose()])
    releaseProbe.resolve()
    await expect(pending).rejects.toThrow('Sandbox disposal was requested during construction')
    await expect(disposing).resolves.toBeDefined()
  })

  it('passes the requested policy to the probe and drains both streams before completion', async () => {
    const stdoutDrained = deferred()
    const stderrDrained = deferred()
    const completed = Promise.all([stdoutDrained.promise, stderrDrained.promise]).then(() => ({
      exitCode: 0,
      failed: false,
    }))
    let received: SandboxPolicy | undefined
    const stream = (done: { resolve: () => void }) =>
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new TextEncoder().encode('data')),
        pull: (controller) => {
          controller.close()
          done.resolve()
        },
      })
    const backend = enforcer({
      run: async (options) => {
        received = options.policy
        return { stdout: stream(stdoutDrained), stderr: stream(stderrDrained), completed }
      },
    })
    const handle = await createSandbox({
      enforcer: backend,
      policy: conflictingPolicy,
      probeSpawn: true,
    })
    expect(received).toBe(conflictingPolicy)
    await handle.dispose()
  })

  it('preserves typed probe errors and wraps untyped failures', async () => {
    const typed = enforcer({
      run: async () => {
        throw new E_SANDBOX_POLICY_CONFLICT(['probe policy rejected'])
      },
    })
    await expect(
      createSandbox({ enforcer: typed, policy, probeSpawn: true })
    ).rejects.toBeInstanceOf(E_SANDBOX_POLICY_CONFLICT)

    const untyped = enforcer({
      run: async () => {
        throw new Error('runtime spawn failed')
      },
    })
    await expect(createSandbox({ enforcer: untyped, policy, probeSpawn: true })).rejects.toThrow(
      'Sandbox spawn probe failed: Error: runtime spawn failed'
    )
  })

  it('rolls back an owned failed probe without deadlocking or wedging later construction', async () => {
    let disposed = 0
    const failed = enforcer({
      dispose: async () => {
        disposed += 1
      },
      run: async () => {
        throw new Error('probe failed')
      },
    })
    await expect(createSandbox({ enforcer: failed, policy, probeSpawn: true })).rejects.toThrow(
      'Sandbox spawn probe failed'
    )
    expect(disposed).toBe(1)
    const later = await createSandbox({ enforcer: enforcer(), policy: conflictingPolicy })
    await later.dispose()
  })

  it('does not dispose an adopted session when its probe fails', async () => {
    let disposed = 0
    const adopted = enforcer({
      adopted: true,
      dispose: async () => {
        disposed += 1
      },
      run: async () => {
        throw new Error('adopted probe failed')
      },
    })
    await expect(createSandbox({ enforcer: adopted, policy, probeSpawn: true })).rejects.toThrow(
      'Sandbox spawn probe failed'
    )
    expect(disposed).toBe(0)
  })

  it('classifies stdout and stderr drain failures and preserves typed stream errors', async () => {
    const errored = (error: unknown) =>
      new ReadableStream<Uint8Array>({ start: (controller) => controller.error(error) })
    const stdoutFailure = enforcer({
      run: async () => ({
        stdout: errored(new Error('stdout blew up')),
        stderr: closedStream(),
        completed: Promise.resolve({ exitCode: 0, failed: false }),
      }),
    })
    await expect(
      createSandbox({ enforcer: stdoutFailure, policy, probeSpawn: true })
    ).rejects.toThrow('while draining output: Error: stdout blew up')

    const stderrFailure = enforcer({
      run: async () => ({
        stdout: closedStream(),
        stderr: errored(new Error('stderr blew up')),
        completed: Promise.resolve({ exitCode: 0, failed: false }),
      }),
    })
    await expect(
      createSandbox({ enforcer: stderrFailure, policy, probeSpawn: true })
    ).rejects.toThrow('while draining output: Error: stderr blew up')

    const typedFailure = new E_SANDBOX_POLICY_CONFLICT(['stream policy rejected'])
    const typedStreamFailure = enforcer({
      run: async () => ({
        stdout: errored(typedFailure),
        stderr: closedStream(),
        completed: Promise.resolve({ exitCode: 0, failed: false }),
      }),
    })
    await expect(
      createSandbox({ enforcer: typedStreamFailure, policy, probeSpawn: true })
    ).rejects.toBeInstanceOf(E_SANDBOX_POLICY_CONFLICT)
  })

  it('fails closed when an opted-in probe reports a failed child and preserves stderr', async () => {
    const backend = enforcer({
      run: async () => ({
        stdout: closedStream(),
        stderr: closedStream('RTM_NEWADDR: Operation not permitted'),
        completed: Promise.resolve({ exitCode: 1, failed: true }),
      }),
    })
    await expect(
      createSandbox({ enforcer: backend, policy, probeSpawn: true, allowUnsandboxedFallback: true })
    ).rejects.toBeInstanceOf(E_SANDBOX_FAILED)
    await expect(
      createSandbox({ enforcer: backend, policy, probeSpawn: true, allowUnsandboxedFallback: true })
    ).rejects.toThrow('RTM_NEWADDR: Operation not permitted')
    const later = await createSandbox({ enforcer: enforcer(), policy: conflictingPolicy })
    await later.dispose()

    const rejected = enforcer({
      run: async () => {
        throw new Error('RTM_NEWADDR: rejected')
      },
    })
    await expect(
      createSandbox({
        enforcer: rejected,
        policy: conflictingPolicy,
        probeSpawn: true,
        allowUnsandboxedFallback: true,
      })
    ).rejects.toThrow('RTM_NEWADDR: rejected')
  })
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
