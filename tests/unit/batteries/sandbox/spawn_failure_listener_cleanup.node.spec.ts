import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

class ControlledChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 1234
  closeEmitted = false

  kill(): boolean {
    return true
  }

  emitClose(): void {
    this.closeEmitted = true
    this.emit('close', null)
    this.stdout.end()
    this.stderr.end()
  }
}

const state = vi.hoisted(() => ({ child: undefined as ControlledChild | undefined }))

vi.mock('node:child_process', () => ({
  spawn: () => {
    if (!state.child) throw new Error('controlled child was not installed')
    return state.child
  },
}))

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: {
    initialize: async () => undefined,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => false,
    checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
    wrapWithSandboxArgv: async () => ({ argv: ['/bin/ignored'], env: {} }),
    getFsReadConfig: () => ({ denyOnly: [], allowWithinDeny: [] }),
    getFsWriteConfig: () => ({ allowOnly: [], denyWithinAllow: [] }),
    getNetworkRestrictionConfig: () => ({ allowedHosts: [] }),
    getConfig: () => ({
      filesystem: { allowGitConfig: false, disabled: false },
      network: { allowedDomains: [], deniedDomains: [] },
      mandatoryDenySearchDepth: 3,
    }),
    getSandboxViolationStore: () => ({ getViolationsForCommand: () => [] }),
    reset: async () => undefined,
  },
}))

import {
  releaseSrtOwnershipForTests,
  srtEnforcer,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'

const policy: SandboxPolicy = { filesystem: {}, network: {} }

describe('sandbox enforcer spawn-error listener cleanup', () => {
  it('removes the exact abort listener after error settlement but before close', async () => {
    releaseSrtOwnershipForTests()
    const child = new ControlledChild()
    state.child = child
    const enforcer = await srtEnforcer({ policy, binShell: '/bin/bash' })
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const started = await enforcer.run({
      argv: ['echo', 'hi'],
      policy,
      correlationId: 'controlled-spawn-failure-listener-cleanup',
      cwd: process.cwd(),
      signal: controller.signal,
    })
    const registered = addListener.mock.calls.find(([type]) => type === 'abort')?.[1]
    expect(registered).toBeDefined()

    child.emit('error', new Error('controlled spawn failure'))
    const result = await started.completed
    expect(result).toEqual({ exitCode: 1, failed: true })
    expect(child.closeEmitted).toBe(false)
    expect(removeListener).toHaveBeenCalledWith('abort', registered)

    child.emitClose()
    await expect(started.completed).resolves.toEqual(result)
  })
})
