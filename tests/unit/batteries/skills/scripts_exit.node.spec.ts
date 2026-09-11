import { describe, expect, it, vi } from 'vitest'
import { createSkillManager } from '@nhtio/adk/batteries/skills'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemorySkillSource } from '@nhtio/adk/batteries/skills/in_memory'
import type { SkillDescriptor, SkillWorkspace } from '@nhtio/adk/batteries/skills'
import type { SandboxHandle, SandboxPolicy } from '../../../../src/batteries/sandbox'

const gate = async () => {}

// A handle whose child completes with a caller-chosen exit code, producing no output.
const handleExiting = (exitCode: number, failed = exitCode !== 0) =>
  ({
    run: vi.fn(async () => {
      const empty = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        })
      return { stdout: empty(), stderr: empty(), completed: Promise.resolve({ exitCode, failed }) }
    }),
  }) as unknown as SandboxHandle

// A handle whose child rejects mid-run, as an enclosing turn/dispatch abort surfaces it: the
// run/completed promise rejects with a plain (non-E_SKILL_) error rather than exiting cleanly.
const handleRejecting = (reason: unknown) =>
  ({
    run: vi.fn(async () => {
      const empty = () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        })
      return { stdout: empty(), stderr: empty(), completed: Promise.reject(reason) }
    }),
  }) as unknown as SandboxHandle

const scriptDescriptor: SkillDescriptor = {
  id: 'demo',
  name: 'Demo',
  description: 'A test skill',
  version: '1.0.0',
  scripts: [{ name: 'check', path: 'check.sh', description: 'Check', interpreter: 'sh' }],
}

const managerWith = async (handle: SandboxHandle, failOnNonzeroExit?: boolean) => {
  const workspace = {
    materialize: vi.fn(async () => '/workspace/demo'),
    dispose: vi.fn(async () => {}),
    fileSystem: {
      stat: async () => ({ kind: 'file' as const }),
    } as unknown as SkillWorkspace['fileSystem'],
    root: '/workspace',
  } satisfies SkillWorkspace
  return createSkillManager({
    sources: [
      new InMemorySkillSource('memory', [
        {
          id: 'demo',
          version: '1.0.0',
          manifest: '---\nname: Demo\ndescription: A test skill\n---\n\nBody\n',
          descriptor: scriptDescriptor,
          files: { 'check.sh': '#!/bin/sh\nexit 2' },
        },
      ]),
    ],
    gate,
    scripts: {
      handle,
      workspace,
      policy: {
        filesystem: { denyRead: ['/'], allowRead: ['/'], allowWrite: ['/workspace/demo/tmp'] },
        network: {},
      } as SandboxPolicy,
      translator: {} as never,
      interpreters: { sh: ['/bin/sh'] },
      interpreterReadPaths: [],
      maxTimeoutSeconds: 5,
      defaultTimeoutSeconds: 2,
      maxOutputBytes: 1000,
      hostEnvIsolated: true,
      ...(failOnNonzeroExit === undefined ? {} : { failOnNonzeroExit }),
    },
  })
}

describe('skills tier-3 nonzero exit handling', () => {
  it('throws E_SKILL_SCRIPT_FAILED on a nonzero exit by default', async () => {
    const manager = await managerWith(handleExiting(2))
    const ctx = makeDispatchContext()
    const load = await manager.load('demo', ctx)
    const runTool = load.tools.find((t) => t.name === 'run_demo_check')!
    // The tool executor wraps a handler throw as E_TOOL_DOWNSTREAM_ERROR with the real error as
    // its cause; assert the cause chain carries the script failure and its acknowledgement detail.
    const err = await runTool
      .executor(ctx)({ timeout_seconds: 2 })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeDefined()
    const cause = (err as { cause?: { name?: string; message?: string } }).cause
    expect(cause?.name).toBe('E_SKILL_SCRIPT_FAILED')
    expect(cause?.message).toContain('exited 2')
    await manager.dispose()
  })

  it('returns the acknowledgement on a nonzero exit when failOnNonzeroExit is false', async () => {
    const manager = await managerWith(handleExiting(2), false)
    const ctx = makeDispatchContext()
    const load = await manager.load('demo', ctx)
    const runTool = load.tools.find((t) => t.name === 'run_demo_check')!
    const result = await runTool.executor(ctx)({ timeout_seconds: 2 })
    expect(String(result)).toContain('exited 2')
    await manager.dispose()
  })

  it('returns the acknowledgement on a zero exit under the default', async () => {
    const manager = await managerWith(handleExiting(0))
    const ctx = makeDispatchContext()
    const load = await manager.load('demo', ctx)
    const runTool = load.tools.find((t) => t.name === 'run_demo_check')!
    const result = await runTool.executor(ctx)({ timeout_seconds: 2 })
    expect(String(result)).toContain('exited 0')
    await manager.dispose()
  })

  it('propagates an enclosing-context abort instead of E_SKILL_WORKSPACE_FAILED', async () => {
    const manager = await managerWith(handleRejecting(new Error('aborted')))
    const controller = new AbortController()
    const ctx = makeDispatchContext({ turnAbortController: controller })
    const load = await manager.load('demo', ctx)
    const runTool = load.tools.find((t) => t.name === 'run_demo_check')!
    // The enclosing context is cancelled while the script is in flight.
    controller.abort()
    const err = await runTool
      .executor(ctx)({ timeout_seconds: 2 })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeDefined()
    // The abort must surface as-is; before the fix it was mislabelled E_SKILL_WORKSPACE_FAILED.
    const cause = (err as { cause?: { name?: string } }).cause
    expect(cause?.name).not.toBe('E_SKILL_WORKSPACE_FAILED')
    await manager.dispose()
  })
})
