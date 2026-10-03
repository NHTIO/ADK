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

const closedStream = () =>
  new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
const policy: SandboxPolicy = { filesystem: {}, network: {} }

describe('run_shell_command completion on artifact store failure', () => {
  it('emits one failed completion and rethrows the same store error without an unhandled rejection', async () => {
    const storeError = new Error('spool write exploded')
    const completions: unknown[] = []
    const unhandled = vi.fn()
    process.once('unhandledRejection', unhandled)
    const sandbox = {
      diagnosticsFor: () => [],
      run: async () => ({
        stdout: closedStream(),
        stderr: closedStream(),
        completed: Promise.resolve({ exitCode: 0, failed: false }),
      }),
    } as unknown as SandboxPolicyEnforcer
    const tool = createRunShellCommandTool({
      sandbox,
      policy,
      translator,
      gate: async () => {},
      onCompletion: (completion) => {
        completions.push(completion)
      },
    })
    const ctx = makeDispatchContext({
      storeRetrievableBytes: () => Promise.reject(storeError),
    })

    try {
      await expect(
        tool.executor(ctx)({ command: 'git status', cwd: '', timeout_seconds: 30 })
      ).rejects.toHaveProperty('cause', storeError)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      expect(completions).toEqual([
        {
          exitCode: 0,
          failed: true,
          timedOut: false,
          diagnostics: ['spool write exploded'],
        },
      ])
    } finally {
      process.removeListener('unhandledRejection', unhandled)
    }
  })
})
