import { describe, expect, it } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { createRunShellCommandTool } from '../../../../src/batteries/sandbox/tool'
import { E_SANDBOX_NETWORK_GRANT_UNSUPPORTED } from '../../../../src/batteries/sandbox/exceptions'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

const translator = {
  toRelative: async (value: string) => value,
  assertNoSymlinkComponents: async () => {},
  toBackendPath: (value: string) => `/workspace/${value}`,
  redact: (value: string) => value,
} as unknown as PathTranslator
const policy: SandboxPolicy = { filesystem: {}, network: {} }

describe('run_shell_command per-call network policy refusal', () => {
  it('preserves the typed pre-spawn network refusal and emits one denied completion', async () => {
    const refusal = new E_SANDBOX_NETWORK_GRANT_UNSUPPORTED([
      'network differs: allowedDomains differs',
    ])
    const completions: unknown[] = []
    const sandbox = {
      diagnosticsFor: () => [],
      run: async () => {
        throw refusal
      },
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

    await expect(
      tool
        .executor(makeDispatchContext())({ command: 'git status', cwd: '', timeout_seconds: 30 })
        // Tool.executor uses the standard downstream wrapper; the handler's original error
        // must survive by identity as its cause.
        .catch((error: { cause: unknown }) => {
          throw error.cause
        })
    ).rejects.toBe(refusal)
    expect(completions).toEqual([
      {
        exitCode: null,
        failed: true,
        timedOut: false,
        denied: true,
        diagnostics: ['network differs: allowedDomains differs'],
        artifactRef: expect.any(String),
      },
    ])
  })

  it('still narrates untyped enforcer errors as operational failures', async () => {
    const sandbox = {
      diagnosticsFor: () => [],
      run: async () => {
        throw new Error('backend exploded')
      },
    } as unknown as SandboxPolicyEnforcer
    const tool = createRunShellCommandTool({ sandbox, policy, translator, gate: async () => {} })
    await expect(
      tool.executor(makeDispatchContext())({ command: 'git status', cwd: '', timeout_seconds: 30 })
    ).rejects.toMatchObject({
      cause: {
        code: 'E_SANDBOX_FAILED',
        message: expect.stringContaining('I/O failure: backend exploded'),
      },
    })
  })
})
