import { describe, expect, it, vi } from 'vitest'
import { makeDispatchContext } from '../../../_fixtures/dispatch_context'
import { InMemorySpoolStore } from '../../../../src/batteries/storage/in_memory'
import { createRunShellCommandTool } from '../../../../src/batteries/sandbox/tool'
import {
  isRejectedSandboxPath,
  normalizeSandboxPath,
} from '../../../../src/batteries/sandbox/paths'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'
import type { PathTranslator } from '../../../../src/batteries/sandbox/contracts/path_translator'
import type { SandboxPolicyEnforcer } from '../../../../src/batteries/sandbox/contracts/policy_enforcer'

/**
 * A mid-drain stream failure must not leak the invocation's machinery.
 *
 * @remarks
 * `run_shell_command` starts three things before draining: a `timeout_seconds` timer, a 10 ms
 * diagnostics poller, and a `storeRetrievableBytes` write over a stream it owns the writable end of.
 * All three are torn down after `await Promise.all([drain(stdout), drain(stderr)])` — so a REJECTION
 * there skipped every one of them, leaving a repeating timer and an unclosed store write behind for the
 * life of the process while the tool call itself failed.
 *
 * These tests assert the teardown, not just the throw: a spec that only checked `rejects.toThrow()`
 * passes with the leak fully intact, which is why the cleared timer and the settled store write are the
 * actual assertions.
 */
const policy: SandboxPolicy = { filesystem: {}, network: {} }
const encoder = new TextEncoder()

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })

/** A stream that yields one chunk and then fails, so the failure lands mid-drain rather than at open. */
const failingStream = (message: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('partial output\n'))
      controller.error(new Error(message))
    },
  })

// Mirrors the translator the neighbouring shell specs use, including `assertNoSymlinkComponents` —
// omitting it made the tool throw a path rejection before it ever spawned, which silently satisfied a
// `rejects.toThrow()` assertion for entirely the wrong reason.
const translator: PathTranslator = {
  toRelative: async (value: string) => {
    if (isRejectedSandboxPath(value)) throw new Error('rejected')
    const normalised = normalizeSandboxPath(value)
    if (normalised.split('/').includes('..')) throw new Error('escape')
    return normalised
  },
  toBackendPath: (value: string) => `/workspace/${value}`,
  redact: (value: string) => value,
  assertNoSymlinkComponents: async () => {},
} as unknown as PathTranslator

const enforcerWith = (
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>
): SandboxPolicyEnforcer =>
  ({
    isSupported: () => true,
    checkDependencies: async () => ({ errors: [], warnings: [] }),
    effectivePolicy: () => undefined,
    diagnosticsFor: () => [],
    dispose: async () => {},
    run: async () => ({
      stdout,
      stderr,
      completed: Promise.resolve({ exitCode: 0, failed: false }),
    }),
  }) as unknown as SandboxPolicyEnforcer

const invoke = (enforcer: SandboxPolicyEnforcer, ctx = makeDispatchContext()) => {
  const tool = createRunShellCommandTool({
    sandbox: enforcer,
    policy,
    translator,
    gate: async () => {},
  })
  return tool.executor(ctx)({ command: 'echo test', cwd: 'root', timeout_seconds: 30 })
}

describe('shell tool mid-drain stream failure', () => {
  it('clears the pending timeout timer when a stream rejects', async () => {
    // REAL timers, deliberately. Fake timers deadlock this path rather than measuring it: teardown does
    // `await poller`, and the poller is parked on its own 10 ms `setTimeout`, which fake timers never
    // advance while the test is blocked awaiting the tool. So the timer COUNT is observed by spying on
    // `clearTimeout` instead — the question is whether teardown ran at all, not what the clock did.
    const cleared: unknown[] = []
    const realClear = globalThis.clearTimeout
    const spy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      handle: Parameters<typeof realClear>[0]
    ) => {
      cleared.push(handle)
      return realClear(handle)
    }) as typeof realClear)
    try {
      const enforcer = enforcerWith(failingStream('stdout exploded'), stream('ok\n'))

      await expect(invoke(enforcer)).rejects.toThrow()

      // THE ACTUAL ASSERTION. `rejects.toThrow()` alone passes with the leak fully intact — the tool
      // threw either way. What distinguishes fixed from broken is that the `timeout_seconds` timer was
      // cleared on the failure path; without the `finally` it is left armed for 30 s.
      expect(cleared.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('closes the artifact stream so the pending store write settles', async () => {
    // `InMemorySpoolStore.write` DRAINS a stream input, so its promise resolves only once that stream
    // ENDS. Capture it here: skipping `close()` leaves it pending forever against a stream nobody will
    // close. Racing it against a timer distinguishes "settled" from "hung" without hanging the suite.
    let storeWrite: Promise<unknown> | undefined
    const ctx = makeDispatchContext({
      storeRetrievableBytes: (_ctx, id, bytes) => {
        const written = new InMemorySpoolStore().write(
          id as string,
          bytes as ReadableStream<Uint8Array>
        )
        storeWrite = Promise.resolve(written)
        return written
      },
    })
    const enforcer = enforcerWith(failingStream('stdout exploded'), stream('ok\n'))

    await expect(invoke(enforcer, ctx)).rejects.toThrow()
    expect(storeWrite).toBeDefined()

    const outcome = await Promise.race([
      storeWrite!.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ])
    expect(outcome).toBe('settled')
  })

  it('still returns the artifact normally when both streams drain cleanly', async () => {
    // The regression guard for the fix itself: moving teardown into `finally` must not change the happy
    // path, and `completed` must still be read for the exit-code line.
    const enforcer = enforcerWith(stream('hello\n'), stream(''))
    const result = await invoke(enforcer)
    expect(result).toBeDefined()
  })
})
