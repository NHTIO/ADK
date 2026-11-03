import { emitBypass, type SandboxEventSink } from './observability'
import type { BinaryExecutor, BinaryInvocation } from '@nhtio/adk/batteries/media'

/**
 * A command wrapper that REWRITES an invocation into the one the inner executor should run.
 *
 * @remarks
 * The wrapper's job is to own quoting: it returns the argv that actually gets spawned, which for a
 * sandbox is the wrapper binary (bwrap, sandbox-exec, …) followed by everything that binary needs.
 * That is why {@link sandboxedExecutor} does NOT quote for it — quoting is a property of the
 * wrapper being used (a shell `-c` string, an argv vector, a container `exec` line), so an adapter
 * that quoted first would hand every implementor the wrong representation.
 *
 * A `wrap` implementation must NOT execute anything: it only computes and returns the invocation.
 */
export interface BinarySandbox {
  /**
   * Return the invocation the inner executor should run instead. Its `cmd` and `args` ARE the
   * wrapped argv, so the caller's original `args` are never appended.
   *
   * @param invocation - The command, args, working directory, environment, and limits to wrap.
   * @returns The replacement invocation, carrying through whatever the caller asked for that the
   * wrapper does not itself decide (`cwd`, `timeoutMs`, `signal`, the kill controls).
   */
  wrap(invocation: BinaryInvocation): Promise<BinaryInvocation>
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
 * The adapter hands the invocation to {@link BinarySandbox.wrap} verbatim and runs what comes
 * back: `inner.exec(await sandbox.wrap(invocation))`. The returned `cmd`/`args` are the complete
 * wrapped argv, so the original `args` are not re-appended — a wrapper that wants them in the
 * wrapped command puts them there itself. Quoting is therefore the wrapper's job, not this
 * adapter's.
 *
 * Bypass is an audit-only opt-out. Its predicate receives `cmd` only, never argv: callers must
 * allow only binaries safe with hostile arguments and must never allow an interpreter. Non-zero
 * exits remain data and are never thrown. Removing this wrapper call restores the inner executor.
 *
 * @param options - The wrapper, the inner executor, and the optional audit hooks.
 * @returns A `BinaryExecutor` whose non-bypassed invocations go through `options.sandbox.wrap`.
 */
export const sandboxedExecutor = (options: SandboxedExecutorOptions): BinaryExecutor => ({
  async exec(invocation) {
    if (options.bypass?.(invocation.cmd)) {
      options.onSandbox?.({ kind: 'bypass', command: invocation.cmd, loud: true })
      return options.inner.exec(invocation)
    }
    return options.inner.exec(await options.sandbox.wrap(invocation))
  },
})

/** Emit a bypass through the canonical sink for consumers that do not retain the adapter. */
export const reportSandboxBypass = (sink: SandboxEventSink, command: string): void =>
  emitBypass(sink, command)
