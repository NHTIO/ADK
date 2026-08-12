import { quoteShellArgs } from './escape'
import { emitBypass, type SandboxEventSink } from './observability'
import type { BinaryExecutor, BinaryInvocation } from '../media/contracts'

/**
 * A small command-wrapper seam used by {@link sandboxedExecutor}.  The wrapper returns the
 * invocation that the inner executor should receive; it must not execute the command itself.
 */
/** Command wrapping contract used by the executor adapter. */
export interface BinarySandbox {
  /** Wrap an invocation without executing it. */
  wrap(
    invocation: BinaryInvocation & { command: string }
  ): Promise<BinaryInvocation & { command: string }>
}

/** Configuration for the sandboxed binary executor. */
export interface SandboxedExecutorOptions {
  /** Command wrapper used for non-bypassed invocations. */
  readonly sandbox: BinarySandbox
  /** Underlying executor receiving the wrapped invocation. */
  readonly inner: BinaryExecutor
  /** Command-only opt-out. This is deliberately never passed argv to the predicate. */
  readonly bypass?: (cmd: string) => boolean
  /** Loud audit sink; bypass is observability, not enforcement. */
  readonly onSandbox?: SandboxEventSink
}

/**
 * Adapt a {@link BinaryExecutor} to a command sandbox. This WRAPS `inner.exec()` and DOES NOT
 * STREAM: the shipped BinaryExecutor contract returns settled strings. Consequently an execa
 * inner executor retains its output and inherits execa's bounded `maxBuffer` behaviour; this
 * adapter does not raise that bound (and never sets `maxBuffer: Infinity`). The streaming path is
 * {@link createRunShellCommandTool}, which uses the policy-enforcer stream contract instead.
 *
 * Bypass is an audit-only opt-out. Its predicate receives `cmd` only, never argv: callers must
 * allow only binaries safe with hostile arguments and must never allow an interpreter. Non-zero
 * exits remain data and are never thrown. Removing this wrapper call restores the inner executor.
 */
/** Create a BinaryExecutor that wraps invocations unless an explicitly audited bypass applies. */
export const sandboxedExecutor = (options: SandboxedExecutorOptions): BinaryExecutor => ({
  async exec(invocation) {
    if (options.bypass?.(invocation.cmd)) {
      options.onSandbox?.({ kind: 'bypass', command: invocation.cmd, loud: true })
      return options.inner.exec(invocation)
    }
    const command = await quoteShellArgs([invocation.cmd, ...invocation.args])
    const wrapped = await options.sandbox.wrap({ ...invocation, command })
    return options.inner.exec({ ...wrapped, cmd: wrapped.command })
  },
})

/** Emit a bypass through the canonical sink for consumers that do not retain the adapter. */
export const reportSandboxBypass = (sink: SandboxEventSink, command: string): void =>
  emitBypass(sink, command)
