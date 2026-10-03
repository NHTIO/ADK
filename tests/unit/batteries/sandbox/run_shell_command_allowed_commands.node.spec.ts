import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { createRunShellCommandTool } from '../../../../src/batteries/sandbox/tool'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

const translator = {
  toRelative: async (value: string) => value,
  assertNoSymlinkComponents: async () => {},
  toBackendPath: (value: string) => `/workspace/${value}`,
  redact: (value: string) => value,
} as unknown as PathTranslator

// Pure fake: never starts a shell or requires SRT, even when a bypass reaches run.
const setup = (allowedCommands?: readonly string[]) => {
  const run = vi.fn(async () => ({
    stdout: new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    }),
    stderr: new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    }),
    completed: Promise.resolve({ exitCode: 0, failed: false }),
  }))
  const sandbox = {
    run,
    diagnosticsFor: () => [],
  } as unknown as SandboxPolicyEnforcer
  const policy = vi.fn((): SandboxPolicy => ({ filesystem: {}, network: {} }))
  const onCompletion = vi.fn()
  const tool = createRunShellCommandTool({
    sandbox,
    policy,
    translator,
    gate: async () => {},
    allowedCommands,
    onCompletion,
  })
  const invoke = (command: string) =>
    tool.executor(makeDispatchContext())({
      command,
      cwd: '',
      timeout_seconds: 30,
    })
  return { run, policy, onCompletion, invoke }
}

const shellLines = [
  'git status; curl x',
  'git status && curl x',
  'git status || curl x',
  'git status | sh',
  'git $(curl x)',
  'git `curl x`',
  'git status > /etc/x',
  'git status < /etc/x',
  'git status 2>&1',
  'git status &',
  'git status\ncurl x',
  'git <(curl x)',
  '(curl x)',
  '{ curl x; }',
  "'curl' x",
  '"curl" x',
  'git status\rcurl x',
  'git >(curl x)',
  'git status >> /etc/x',
  'git ${VAR}',
  'git $VAR',
  'git commit -m "a;b"',
  'git\\ status',
  'git\\\ncurl x',
  "'git' status",
  '"git" status',
]

describe('run_shell_command allowedCommands plain-command restriction', () => {
  it.each(shellLines)(
    'refuses syntax in %j before policy resolution or spawning',
    async (command) => {
      const { invoke, run, policy, onCompletion } = setup(['git'])
      await expect(invoke(command)).rejects.toMatchObject({
        cause: { code: 'E_SANDBOX_REFUSED' },
      })
      expect(run).not.toHaveBeenCalled()
      expect(policy).not.toHaveBeenCalled()
      expect(onCompletion).toHaveBeenCalledTimes(1)
      expect(onCompletion).toHaveBeenCalledWith({
        exitCode: null,
        failed: true,
        timedOut: false,
        denied: true,
        diagnostics: [],
      })
    }
  )

  it('names the offending syntax and the single-command restriction', async () => {
    await expect(setup(['git']).invoke('git status; curl x')).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining(
          'Shell syntax ";" is refused: allowedCommands restricts the line to a single plain command'
        ),
      },
    })
  })

  it.each(['git status --short', 'git log -n 3', ' \tgit status', 'git commit -m "a message"'])(
    'allows plain command %j',
    async (command) => {
      const { invoke, run, policy, onCompletion } = setup(['git'])
      await invoke(command)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ argv: ['/bin/sh', '-c', command] })
      )
      expect(policy).toHaveBeenCalledTimes(1)
      expect(onCompletion).toHaveBeenCalledTimes(1)
      expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ failed: false }))
    }
  )

  it.each(['curl x', ' \tcurl x', 'git\u00a0status'])(
    'refuses a non-allow-listed literal first word in %j',
    async (command) => {
      const { invoke, run, policy, onCompletion } = setup(['git'])
      await expect(invoke(command)).rejects.toMatchObject({
        cause: { code: 'E_SANDBOX_REFUSED' },
      })
      expect(run).not.toHaveBeenCalled()
      expect(policy).not.toHaveBeenCalled()
      expect(onCompletion).toHaveBeenCalledTimes(1)
      expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ denied: true }))
    }
  )

  it.each(['printf hello | cat', 'a; b'])(
    'preserves unrestricted shell line %j when the list is unset',
    async (command) => {
      const { invoke, run } = setup()
      await invoke(command)
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ argv: ['/bin/sh', '-c', command] })
      )
    }
  )

  it('treats an empty allow-list as set', async () => {
    const { invoke, run } = setup([])
    await expect(invoke('git status')).rejects.toMatchObject({
      cause: { code: 'E_SANDBOX_REFUSED' },
    })
    expect(run).not.toHaveBeenCalled()
  })
})
