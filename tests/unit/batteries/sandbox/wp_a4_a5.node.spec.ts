import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { createRunShellCommandTool } from '../../../../src/batteries/sandbox/tool'
import { sandboxedExecutor, type BinarySandbox } from '../../../../src/batteries/sandbox/executor'
import {
  isRejectedSandboxPath,
  normalizeSandboxPath,
} from '../../../../src/batteries/sandbox/paths'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { BinaryExecutor } from '../../../../src/batteries/media/contracts'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

const policy: SandboxPolicy = { filesystem: {}, network: {} }
const encoder = new TextEncoder()
const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
const translator: PathTranslator = {
  // Mirrors the REAL path layer rather than hardcoding a verdict per input: a leading `/` NORMALISES
  // to the sandbox root (the model's world is the sandbox, so `/etc` means `etc` within it), while
  // `~`, UNC, device, drive-letter and NUL forms are refused outright, and `../` is caught by the
  // containment re-check. An earlier fixture threw for `/etc`, which encoded the opposite of the
  // specified ergonomics and would have hidden a tool that rejects legal paths.
  toRelative: async (value) => {
    if (isRejectedSandboxPath(value)) throw new Error('rejected')
    const normalised = normalizeSandboxPath(value)
    if (normalised.split('/').includes('..')) throw new Error('escape')
    return normalised
  },
  toBackendPath: (value) => `/workspace/${value}`,
  redact: (value) => value,
  assertNoSymlinkComponents: async () => {},
}
const textOf = async (artifact: { asString(): Promise<string> }) => artifact.asString()

function fakeEnforcer(result: {
  out?: string[]
  err?: string[]
  code?: number
  diagnostics?: string[]
  completed?: Promise<{ exitCode: number; failed: boolean }>
}) {
  const spawned = vi.fn(async () => ({
    stdout: stream(...(result.out ?? [])),
    stderr: stream(...(result.err ?? [])),
    completed:
      result.completed ??
      Promise.resolve({ exitCode: result.code ?? 0, failed: (result.code ?? 0) !== 0 }),
  }))
  const enforcer: SandboxPolicyEnforcer = {
    isSupported: () => true,
    checkDependencies: async () => ({ errors: [], warnings: [] }),
    effectivePolicy: () => undefined,
    diagnosticsFor: () => result.diagnostics ?? [],
    dispose: async () => {},
    run: spawned,
  }
  return { enforcer, spawned }
}
async function run(enforcer: SandboxPolicyEnforcer, args: Record<string, unknown> = {}) {
  const tool = createRunShellCommandTool({
    sandbox: enforcer,
    policy,
    translator,
    gate: async () => {},
  })
  const ctx = makeDispatchContext()
  return tool.executor(ctx)({ command: 'echo test', cwd: 'root', timeout_seconds: 1, ...args })
}

describe('run_shell_command streaming seam', () => {
  it('merges stdout and stderr in arrival order and returns zero output without a status line', async () => {
    const { enforcer } = fakeEnforcer({ out: ['out-1\n', 'out-2\n'], err: ['err-1\n'] })
    const artifact = await run(enforcer)
    const text = await textOf(artifact as never)
    expect(text).toContain('out-1\n')
    expect(text).toContain('err-1\n')
    expect(text).toContain('out-2\n')
    expect(text).not.toContain('Exit code:')
  })
  it('returns a non-zero exit as the final line, never as an exception', async () => {
    const { enforcer } = fakeEnforcer({ out: ['hello\n'], code: 7 })
    const artifact = await run(enforcer)
    const output = await textOf(artifact as never)
    const lines = output.trimEnd().split('\n')
    expect(lines.at(-1)).toBe('Exit code: 7')
  })
  it('returns observed violations, including with exit zero', async () => {
    const { enforcer } = fakeEnforcer({ out: ['before\n'], diagnostics: ['network denied'] })
    const text = await textOf((await run(enforcer)) as never)
    expect(text.split('\n')).toContain('[sandbox] denied: network denied (observed after)')
  })
  it('returns a timed-out partial artifact with the timeout line', async () => {
    let resolve!: (value: { exitCode: number; failed: boolean }) => void
    const completed = new Promise<{ exitCode: number; failed: boolean }>((r) => {
      resolve = r
    })
    const { enforcer } = fakeEnforcer({ out: ['partial\n'], completed })
    const pending = run(enforcer)
    setTimeout(() => resolve({ exitCode: 1, failed: true }), 1100)
    const text = await textOf((await pending) as never)
    expect(text).toContain('[timed out after 1s]')
    expect(text).not.toContain('Exit code:')
  })
  it('rejects model cwd paths without spawning and accepts an ordinary cwd', async () => {
    const { enforcer, spawned } = fakeEnforcer({})
    // Genuinely unacceptable forms: refused, with NOTHING spawned.
    for (const cwd of ['../..', '~', '//server/share', 'C:/Windows', 'a\u0000b']) {
      await expect(run(enforcer, { cwd }), cwd).rejects.toThrow()
    }
    expect(spawned).not.toHaveBeenCalled()
    await expect(run(enforcer, { cwd: 'src/lib' })).resolves.toBeTruthy()
    // A LEADING SLASH IS NOT AN ESCAPE. `/src/lib` is the model saying "top of what I can see", so it
    // normalises to the root and the command runs. Rejecting it punishes the model for a distinction
    // the sandbox deliberately hides, which is how a mangle-retry loop starts.
    await expect(run(enforcer, { cwd: '/src/lib' })).resolves.toBeTruthy()
  })
  it('throws narrated refusals and failures before spawn', async () => {
    for (const outcome of [
      { kind: 'gate-declined' as const },
      { kind: 'gate-unavailable' as const, reason: 'timeout' as const },
    ]) {
      const { enforcer, spawned } = fakeEnforcer({})
      const gate = async () => {
        throw { outcome }
      }
      const tool = createRunShellCommandTool({
        sandbox: enforcer,
        policy,
        translator,
        gate,
        narrate: () => 'NARRATED',
      })
      await expect(
        tool.executor(makeDispatchContext())({ command: 'x', cwd: 'root', timeout_seconds: 1 })
      ).rejects.toMatchObject({ cause: { message: 'NARRATED' } })
      expect(spawned).not.toHaveBeenCalled()
    }
    const { enforcer, spawned } = fakeEnforcer({})
    enforcer.run = vi.fn(async () => {
      throw { outcome: { kind: 'denied-by-policy', path: 'root', axis: 'read' } }
    })
    const tool = createRunShellCommandTool({
      sandbox: enforcer,
      policy,
      translator,
      gate: async () => {},
      narrate: () => 'POLICY',
    })
    await expect(
      tool.executor(makeDispatchContext())({ command: 'x', cwd: 'root', timeout_seconds: 1 })
    ).rejects.toMatchObject({ cause: { message: 'POLICY' } })
    expect(spawned).not.toHaveBeenCalled()
  })

  it('uses the narrator for pre-spawn failures', async () => {
    const { enforcer, spawned } = fakeEnforcer({})
    const narrate = vi.fn(() => 'CUSTOM NARRATION')
    const tool = createRunShellCommandTool({
      sandbox: enforcer,
      policy,
      translator,
      gate: async () => {
        throw new Error('declined')
      },
      narrate,
    })
    await expect(
      tool.executor(makeDispatchContext())({ command: 'x', cwd: 'root', timeout_seconds: 1 })
    ).rejects.toMatchObject({ cause: { message: 'CUSTOM NARRATION' } })
    expect(spawned).not.toHaveBeenCalled()
    expect(narrate).toHaveBeenCalled()
  })
})

describe('sandboxedExecutor', () => {
  it('bypasses to inner and emits a loud event', async () => {
    const inner: BinaryExecutor = {
      exec: vi.fn(async () => ({ exitCode: 9, stdout: '', stderr: '', failed: true })),
    }
    const sandbox: BinarySandbox = { wrap: vi.fn(async (x) => x) }
    const onSandbox = vi.fn()
    const result = await sandboxedExecutor({ sandbox, inner, bypass: () => true, onSandbox }).exec({
      cmd: 'safe',
      args: ['x'],
    })
    expect(result.exitCode).toBe(9)
    expect(inner.exec).toHaveBeenCalledOnce()
    expect(sandbox.wrap).not.toHaveBeenCalled()
    expect(onSandbox).toHaveBeenCalledWith({ kind: 'bypass', command: 'safe', loud: true })
  })
  it('passes non-zero results through the wrapped inner executor', async () => {
    const inner: BinaryExecutor = {
      exec: vi.fn(async () => ({ exitCode: 3, stdout: 'o', stderr: 'e', failed: true })),
    }
    const sandbox: BinarySandbox = { wrap: vi.fn(async (x) => ({ ...x, command: 'wrapped' })) }
    await expect(
      sandboxedExecutor({ sandbox, inner }).exec({ cmd: 'echo', args: [] })
    ).resolves.toMatchObject({ exitCode: 3 })
    expect(sandbox.wrap).toHaveBeenCalledOnce()
  })
})
