/**
 * A {@link @nhtio/adk/batteries/media/contracts!BinaryExecutor} implementation that runs
 * invocations as local child processes via execa.
 *
 * @module @nhtio/adk/batteries/media/engines/execa_executor
 *
 * @remarks
 * The bundled local-process executor. `execa` is an optional peer dependency acquired through
 * an async resolver (default: a lazy dynamic import) — importing this module pulls nothing;
 * constructing the executor is what resolves the peer, and only on first `exec`.
 *
 * Process execution is a movable seam: anything implementing the `BinaryExecutor` contract —
 * a remote runner, a sandbox, a container shim — composes into binary engines exactly like
 * this one. The paired `ScratchWorkspace` must produce paths this executor can open; for the
 * local-process case, the bundled `fs_workspace` is the natural pair.
 */

import { isError, isObject } from '@nhtio/adk/guards'
import { E_INVALID_MEDIA_PIPELINE_CONFIG } from '../exceptions'
import type { BinaryExecutor, BinaryInvocation, BinaryExecResult } from '../contracts'

/** The slice of execa this executor uses (kept minimal for BYO substitution in tests). */
export interface ExecaLike {
  (
    cmd: string,
    args: readonly string[],
    options: {
      timeout?: number
      cancelSignal?: AbortSignal
      reject: false
      stripFinalNewline?: boolean
    }
  ): Promise<{
    exitCode?: number
    stdout?: unknown
    stderr?: unknown
    failed: boolean
  }>
}

/** Resolver forms accepted for the execa module. */
export type ExecaResolver =
  | ExecaLike
  | (() => ExecaLike | { execa: ExecaLike } | Promise<ExecaLike | { execa: ExecaLike }>)

/** Options for {@link execaExecutor}. */
export interface ExecaExecutorOptions {
  /**
   * The execa function or an async resolver for it. Defaults to a lazy dynamic import of the
   * `execa` package (optional peer).
   */
  execa?: ExecaResolver
  /** Default timeout applied when an invocation does not specify one. */
  defaultTimeoutMs?: number
}

const resolveExeca = async (supplied: ExecaResolver | undefined): Promise<ExecaLike> => {
  let value: unknown = supplied ?? ((): Promise<{ execa: ExecaLike }> => import('execa'))
  if (typeof value === 'function' && !('exec' in (value as object))) {
    try {
      value = await (value as () => unknown)()
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      throw new E_INVALID_MEDIA_PIPELINE_CONFIG([
        `execa resolver failed: ${detail} — install the optional peer dependency "execa" or supply your own`,
      ])
    }
  }
  if (isObject(value) && 'execa' in value) {
    value = (value as { execa: unknown }).execa
  }
  if (typeof value !== 'function') {
    throw new E_INVALID_MEDIA_PIPELINE_CONFIG(['execa resolver did not resolve to a function'])
  }
  return value as ExecaLike
}

/**
 * Construct the bundled local-process {@link BinaryExecutor}.
 *
 * @param options - The execa resolver and defaults.
 * @returns A `BinaryExecutor` running invocations as local child processes.
 */
export const execaExecutor = (options: ExecaExecutorOptions = {}): BinaryExecutor => {
  let execaPromise: Promise<ExecaLike> | undefined
  const getExeca = (): Promise<ExecaLike> => {
    execaPromise ??= resolveExeca(options.execa)
    return execaPromise
  }
  return {
    async exec(invocation: BinaryInvocation): Promise<BinaryExecResult> {
      const execa = await getExeca()
      const result = await execa(invocation.cmd, invocation.args, {
        timeout: invocation.timeoutMs ?? options.defaultTimeoutMs ?? 120_000,
        cancelSignal: invocation.signal,
        reject: false,
        stripFinalNewline: true,
      })
      return {
        exitCode: result.exitCode ?? -1,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        failed: result.failed,
      }
    },
  }
}
