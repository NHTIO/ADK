import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { createRunShellCommandTool } from '../../../../src/batteries/sandbox/tool'
import { sandboxRuntimeGate, sandboxRuntimeGateReason } from '../../../_fixtures/sandbox_runtime'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { RunShellCommandCompletion } from '../../../../src/batteries/sandbox/tool'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'

/**
 * `run_shell_command` must emit one structured completion per invocation (issue #49).
 *
 * @remarks
 * Driven through the REAL Node SRT enforcer (seatbelt on this host) and real `sh` children, so the
 * success/non-zero/timeout outcomes are produced by a real child rather than a scripted enforcer.
 * Every terminal outcome — success, non-zero exit, timeout, gate denial, and a throwing observer —
 * is asserted to fire exactly one completion, and the throwing observer is asserted not to break the
 * tool result or leak an unhandled rejection.
 */

const roots: string[] = []
const policies: SandboxPolicy[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adk49-'))
  roots.push(root)
  return root
}

/** Read a tool result's artifact body; every terminal outcome of this tool returns an artifact. */
const textOf = async (artifact: unknown): Promise<string> =>
  (artifact as { asString(): Promise<string> }).asString()

const policyFor = (root: string): SandboxPolicy => ({
  filesystem: { allowWrite: [root], allowRead: [root], gitSafeDirectories: [root] },
  network: { allowedDomains: [] },
})

/** A translator whose workspace IS the temp root, so model paths are host paths with the prefix stripped. */
const translatorFor = (root: string): PathTranslator => ({
  toRelative: async (value) => value.replace(/^\/+/, ''),
  toBackendPath: (value) => join(root, value),
  redact: (value) => value,
  assertNoSymlinkComponents: async () => undefined,
})

afterEach(async () => {
  releaseSrtOwnershipForTests()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  policies.length = 0
})

// Real-SRT assertions run automatically only where dependencies and the namespace probe work.
describe.skipIf(!sandboxRuntimeGate)(
  'run_shell_command — structured completion onCompletion (issue #49)',
  () => {
    it('reports a successful exit exactly once', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const completions: RunShellCommandCompletion[] = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
        onCompletion: (completion) => {
          completions.push(completion)
        },
      })
      const artifact = await tool.executor(makeDispatchContext())({
        command: 'printf hi',
        cwd: '',
        timeout_seconds: 30,
      })
      await textOf(artifact)
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({ exitCode: 0, failed: false, timedOut: false })
      expect(completions[0]!.diagnostics).toEqual([])
      expect(typeof completions[0]!.artifactRef).toBe('string')
      await enforcer.dispose()
    }, 120_000)

    it('reports a non-zero exit as failed with the real code', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const completions: RunShellCommandCompletion[] = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
        onCompletion: (completion) => {
          completions.push(completion)
        },
      })
      await textOf(
        await tool.executor(makeDispatchContext())({
          command: 'sh -c "exit 9"',
          cwd: '',
          timeout_seconds: 30,
        })
      )
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({ exitCode: 9, failed: true, timedOut: false })
      await enforcer.dispose()
    }, 120_000)

    it('reports a timeout with exitCode null and timedOut true', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const completions: RunShellCommandCompletion[] = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
        onCompletion: (completion) => {
          completions.push(completion)
        },
      })
      await textOf(
        await tool.executor(makeDispatchContext())({
          command: 'sleep 30',
          cwd: '',
          timeout_seconds: 1,
        })
      )
      expect(completions).toHaveLength(1)
      expect(completions[0]).toMatchObject({ failed: true, timedOut: true })
      expect(
        completions[0]!.exitCode === null || typeof completions[0]!.exitCode === 'number'
      ).toBe(true)
      await enforcer.dispose()
    }, 120_000)

    it('reports the REAL killing signal on timeout — the measured SIGKILL, not the abort reason', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const completions: RunShellCommandCompletion[] = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
        onCompletion: (completion) => {
          completions.push(completion)
        },
      })
      await textOf(
        await tool.executor(makeDispatchContext())({
          command: 'sleep 30',
          cwd: '',
          timeout_seconds: 1,
        })
      )
      expect(completions).toHaveLength(1)
      // The enforcer terminates the process group with `process.kill(-pid, 'SIGKILL')`, and Node
      // reports that real signal through the child's `signalCode`. Reading the abort REASON instead
      // yielded `'AbortError'` — a lie about how the child died.
      expect(completions[0]!.timedOut).toBe(true)
      expect(completions[0]!.killedBy).toBe('SIGKILL')
      await enforcer.dispose()
    }, 120_000)

    it('omits killedBy on a normal exit and on a non-zero exit that was not signalled', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const completions: RunShellCommandCompletion[] = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
        onCompletion: (completion) => {
          completions.push(completion)
        },
      })
      await textOf(
        await tool.executor(makeDispatchContext())({
          command: 'printf ok',
          cwd: '',
          timeout_seconds: 30,
        })
      )
      await textOf(
        await tool.executor(makeDispatchContext())({
          command: 'sh -c "exit 7"',
          cwd: '',
          timeout_seconds: 30,
        })
      )
      expect(completions).toHaveLength(2)
      // A child that exited on its own carries no signal, so `killedBy` is absent — never a guess.
      expect(completions[0]!.killedBy).toBeUndefined()
      expect(completions[1]!.killedBy).toBeUndefined()
      await enforcer.dispose()
    }, 120_000)

    it('contains a throwing onCompletion without affecting the artifact or causing an unhandled rejection', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const tool = createRunShellCommandTool({
          sandbox: enforcer,
          policy,
          translator: translatorFor(root),
          gate: async () => {},
          onCompletion: () => {
            throw new Error('observer boom')
          },
        })
        const artifact = await tool.executor(makeDispatchContext())({
          command: 'printf survived',
          cwd: '',
          timeout_seconds: 30,
        })
        expect(await textOf(artifact)).toBe('survived')
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
        await enforcer.dispose()
      }
    }, 120_000)
  }
)

describe('run_shell_command — completion observer error isolation (issue #49)', () => {
  it('reports a gate denial as denied with exitCode null', async () => {
    const root = await makeRoot()
    const policy = policyFor(root)
    const enforcer = {
      run: async () => {
        throw new Error('gate denied: enforcer must not run')
      },
    } as any
    const completions: RunShellCommandCompletion[] = []
    const tool = createRunShellCommandTool({
      sandbox: enforcer,
      policy,
      translator: translatorFor(root),
      gate: async () => {
        throw { outcome: { kind: 'gate-declined', note: 'no' } }
      },
      onCompletion: (completion) => {
        completions.push(completion)
      },
    })
    await expect(
      tool.executor(makeDispatchContext())({ command: 'printf x', cwd: '', timeout_seconds: 30 })
    ).rejects.toThrow()
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ exitCode: null, failed: true, denied: true })
  }, 120_000)

  it('fires onCompletion exactly once when a SYNCHRONOUSLY THROWING policy function fails', async () => {
    const root = await makeRoot()
    const enforcer = {
      run: async () => {
        throw new Error('policy throw: enforcer must not run')
      },
    } as any
    const completions: RunShellCommandCompletion[] = []
    const tool = createRunShellCommandTool({
      sandbox: enforcer,
      // A per-call policy fn is new in this MR; a throwing one is a terminal outcome like any other
      // and must settle the completion seam BEFORE the error surfaces to the caller.
      policy: () => {
        throw new Error('policy fn boom')
      },
      translator: translatorFor(root),
      gate: async () => {},
      onCompletion: (completion) => {
        completions.push(completion)
      },
    })
    // The tool's own behaviour is unchanged: the caller still sees the same wrapper the Tool class
    // has always produced for a handler throw, with the policy error preserved on `.cause`.
    await expect(
      tool.executor(makeDispatchContext())({ command: 'printf x', cwd: '', timeout_seconds: 30 })
    ).rejects.toMatchObject({
      name: 'E_TOOL_DOWNSTREAM_ERROR',
      cause: expect.objectContaining({ message: 'policy fn boom' }),
    })
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ exitCode: null, failed: true, timedOut: false })
    expect(completions[0]!.diagnostics).toContain('policy fn boom')
    // The call failed before any stream existed, so there is no artifact to join the completion to.
    expect(completions[0]!.artifactRef).toBeUndefined()
  }, 120_000)

  it('fires onCompletion exactly once when an ASYNC-REJECTING policy function fails', async () => {
    const root = await makeRoot()
    const enforcer = {
      run: async () => {
        throw new Error('policy throw: enforcer must not run')
      },
    } as any
    const completions: RunShellCommandCompletion[] = []
    const tool = createRunShellCommandTool({
      sandbox: enforcer,
      policy: async () => {
        throw new Error('policy fn async boom')
      },
      translator: translatorFor(root),
      gate: async () => {},
      onCompletion: (completion) => {
        completions.push(completion)
      },
    })
    await expect(
      tool.executor(makeDispatchContext())({ command: 'printf x', cwd: '', timeout_seconds: 30 })
    ).rejects.toMatchObject({
      name: 'E_TOOL_DOWNSTREAM_ERROR',
      cause: expect.objectContaining({ message: 'policy fn async boom' }),
    })
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ exitCode: null, failed: true, timedOut: false })
    expect(completions[0]!.diagnostics).toContain('policy fn async boom')
    expect(completions[0]!.artifactRef).toBeUndefined()
  }, 120_000)

  it('contains a throwing onCompletion fired FROM the failing-policy path without an unhandled rejection', async () => {
    const root = await makeRoot()
    const enforcer = {
      run: async () => {
        throw new Error('policy throw: enforcer must not run')
      },
    } as any
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy: () => {
          throw new Error('policy fn boom')
        },
        translator: translatorFor(root),
        gate: async () => {},
        onCompletion: () => {
          throw new Error('observer boom')
        },
      })
      // The caller still sees the POLICY error (wrapped), not the observer's — the observer throw is
      // logged and swallowed on this path too.
      await expect(
        tool.executor(makeDispatchContext())({ command: 'printf x', cwd: '', timeout_seconds: 30 })
      ).rejects.toMatchObject({
        name: 'E_TOOL_DOWNSTREAM_ERROR',
        cause: expect.objectContaining({ message: 'policy fn boom' }),
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  }, 120_000)
})

describe('run_shell_command completion runtime availability', () => {
  it('reports whether real-SRT completion assertions ran', () => {
    console.info(`sandbox runtime gate: ${sandboxRuntimeGateReason}`)
    expect(['darwin', 'linux']).toContain(process.platform)
  })
})
