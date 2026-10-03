import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { createRunShellCommandTool } from '../../../../src/batteries/sandbox/tool'
import { sandboxRuntimeGate, sandboxRuntimeGateReason } from '../../../_fixtures/sandbox_runtime'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'

/**
 * `run_shell_command` must run a real shell command LINE (issue #47).
 *
 * @remarks
 * Driven through the REAL Node SRT enforcer (seatbelt on this host) and real `sh` children — no
 * scripted enforcer stands in. The bug lived in the quoting layer: the tool handed the enforcer
 * `argv: [command]` and the enforcer quoted the whole line as one word, so `printf hello` looked for an
 * executable named `printf hello` and exited 127. A fake enforcer does not carry that quoting.
 */

const roots: string[] = []
const policies: SandboxPolicy[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adk47-'))
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
  'run_shell_command — a real command string runs through the real SRT enforcer (issue #47)',
  () => {
    it('runs `printf hello`, a pipe, quoted arguments, and a failing command with real exit codes', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      policies.push(policy)
      const enforcer = await srtEnforcer({ policy })
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
      })
      const exec = (command: string) =>
        tool.executor(makeDispatchContext())({ command, cwd: '', timeout_seconds: 30 })

      const printf = await exec('printf hello')
      expect(await textOf(printf)).toBe('hello')

      const pipe = await exec("printf 'a b' | tr a-z A-Z")
      expect(await textOf(pipe)).toBe('A B')

      const quoted = await exec("printf '%s\\n' 'has space'")
      expect(await textOf(quoted)).toBe('has space\n')

      // Redirect + `&&` chain: the shell, not the tool, parses this.
      const redirect = await exec(`printf one > out.txt && cat out.txt`)
      expect(await textOf(redirect)).toBe('one')

      const failing = await exec('sh -c "exit 7"')
      const failingText = await textOf(failing)
      expect(failingText.split('\n').at(-2)).toBe('Exit code: 7')

      await enforcer.dispose()
    }, 120_000)
  }
)

describe.skipIf(!sandboxRuntimeGate)(
  'run_shell_command — per-call policy callback (issue #47)',
  () => {
    it('calls the policy function once per call with the right args, and the static object path is unchanged', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      policies.push(policy)
      const enforcer = await srtEnforcer({ policy })
      const calls: Array<{ args: unknown; relativeCwd: string }> = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy: (context) => {
          calls.push({ args: context.args, relativeCwd: context.relativeCwd })
          return policy
        },
        translator: translatorFor(root),
        gate: async () => {},
      })
      const exec = (command: string) =>
        tool.executor(makeDispatchContext())({ command, cwd: 'sub', timeout_seconds: 30 })

      const first = await exec('printf one')
      await textOf(first)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toEqual({ command: 'printf one', cwd: 'sub', timeout_seconds: 30 })
      expect(calls[0]!.relativeCwd).toBe('sub')

      const second = await exec('printf two')
      await textOf(second)
      expect(calls).toHaveLength(2)
      expect(calls[1]!.args).toEqual({ command: 'printf two', cwd: 'sub', timeout_seconds: 30 })

      // A STATIC object policy still works exactly as before: no callback, one run, output intact.
      const staticTool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator: translatorFor(root),
        gate: async () => {},
      })
      const staticResult = await staticTool.executor(makeDispatchContext())({
        command: 'printf static',
        cwd: '',
        timeout_seconds: 30,
      })
      expect(await textOf(staticResult)).toBe('static')

      await enforcer.dispose()
    }, 120_000)

    it('resolves a REVOKED grant on the very next call, and isolates concurrent calls', async () => {
      const root = await makeRoot()
      const policy = policyFor(root)
      policies.push(policy)
      const enforcer = await srtEnforcer({ policy })
      // Capture the policy the enforcer actually received, to prove the per-call value REACHED it
      // rather than only being computed.
      const received: SandboxPolicy[] = []
      const originalRun = enforcer.run.bind(enforcer)
      enforcer.run = async (op) => {
        received.push(op.policy)
        return originalRun(op)
      }
      // Two DIFFERENT policy objects, one per call: a shared mutable object would collapse concurrent
      // runs back into one policy, so each callback invocation returns a fresh object.
      let nextWriteRoot = join(root, 'grant-a')
      const seen: string[] = []
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy: () => {
          seen.push(nextWriteRoot)
          return {
            filesystem: { allowWrite: [nextWriteRoot], gitSafeDirectories: [root] },
            network: { allowedDomains: [] },
          }
        },
        translator: translatorFor(root),
        gate: async () => {},
      })
      const exec = (command: string) =>
        tool.executor(makeDispatchContext())({ command, cwd: '', timeout_seconds: 30 })

      const first = await exec('printf first')
      expect(await textOf(first)).toBe('first')
      nextWriteRoot = join(root, 'grant-b')
      const second = await exec('printf second')
      expect(await textOf(second)).toBe('second')
      expect(seen).toEqual([join(root, 'grant-a'), join(root, 'grant-b')])
      expect(received[0]).not.toBe(received[1])
      expect(received[0]!.filesystem.allowWrite).toEqual([join(root, 'grant-a')])
      expect(received[1]!.filesystem.allowWrite).toEqual([join(root, 'grant-b')])

      // Two concurrent calls each get their own resolution, never one shared result.
      nextWriteRoot = join(root, 'grant-c')
      const beforeConcurrent = received.length
      const concurrent = await Promise.all([
        exec('printf concurrent-a'),
        exec('printf concurrent-b'),
      ])
      const texts = await Promise.all(
        concurrent.map((artifact) => (artifact as { asString(): Promise<string> }).asString())
      )
      expect(texts.sort()).toEqual(['concurrent-a', 'concurrent-b'])
      expect(received).toHaveLength(beforeConcurrent + 2)
      expect(received[beforeConcurrent]).not.toBe(received[beforeConcurrent + 1])

      await enforcer.dispose()
    }, 120_000)
  }
)

describe('run_shell_command — gate denial before policy (issue #47)', () => {
  it('is not consulted when the gate denies, and denial denies before policy resolution', async () => {
    const root = await makeRoot()
    const policy = policyFor(root)
    const enforcer = {
      run: async () => {
        throw new Error('the denied gate must not run')
      },
    } as any
    const policyCalls = vi.fn(() => policy)
    const tool = createRunShellCommandTool({
      sandbox: enforcer,
      policy: policyCalls,
      translator: translatorFor(root),
      gate: async () => {
        throw { outcome: { kind: 'gate-declined', note: 'no' } }
      },
    })
    await expect(
      tool.executor(makeDispatchContext())({ command: 'printf x', cwd: '', timeout_seconds: 30 })
    ).rejects.toThrow()
    // The refusal happens BEFORE policy resolution — a call the gate denied never needs a policy.
    expect(policyCalls).not.toHaveBeenCalled()
  }, 120_000)
})

describe('run_shell_command runtime availability', () => {
  it('reports whether real-SRT assertions ran', () => {
    console.info(`sandbox runtime gate: ${sandboxRuntimeGateReason}`)
    expect(['darwin', 'linux']).toContain(process.platform)
  })
})
