import { passesSchema } from '../validation'
import { validator } from '@nhtio/validation'
import type { SandboxPolicy, DerivedRules } from '../types'

/** Policy boundary. `run` resolves on spawn and exposes live streams plus a later completion promise. */
export interface SandboxPolicyEnforcer {
  /** Whether this enforcer can enforce on the current platform. `false` (a browser tab, where SRT does not exist) raises `E_SANDBOX_UNSUPPORTED_ENV` at construction rather than degrading — a shim that enforces nothing reads as sandboxed. */
  isSupported(): boolean
  /** Whether this adapter adopted an already-enabled process-global sandbox rather than initializing it. */
  readonly adopted?: boolean
  /** Probe external prerequisites. A non-empty `errors` throws `E_SANDBOX_DEPENDENCY_MISSING`; `warnings` are surfaced through observability and are NOT fatal. */
  checkDependencies(): Promise<{ errors: string[]; warnings: string[] }>
  /** Spawn under a narrowing policy; a non-zero exit is data, not a rejected promise. */
  run(op: {
    argv: string[]
    policy: SandboxPolicy
    correlationId: string
    cwd: string
    env?: Record<string, string>
    signal?: AbortSignal
  }): Promise<{
    stdout: ReadableStream<Uint8Array>
    stderr: ReadableStream<Uint8Array>
    completed: Promise<{ exitCode: number; failed: boolean }>
  }>
  /** Return the opaque derived snapshot used for drift validation. */
  effectivePolicy(): DerivedRules | undefined
  /** Retrieve diagnostics by correlation id, never by command text. */
  diagnosticsFor(correlationId: string): string[]
  /** Release what this enforcer OWNS. A no-op when it adopted a foreign sandbox — tearing down a manager we did not initialize would strip ACEs a host app depends on. */
  dispose(): Promise<void>
}

/** Duck-type schema. */
export const sandboxPolicyEnforcerSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (
      value !== null &&
      value !== undefined &&
      typeof (value as any).isSupported === 'function' &&
      typeof (value as any).checkDependencies === 'function' &&
      typeof (value as any).run === 'function' &&
      typeof (value as any).effectivePolicy === 'function' &&
      typeof (value as any).diagnosticsFor === 'function' &&
      typeof (value as any).dispose === 'function'
    )
      return value
    return helpers.error('any.invalid')
  })

/** Structural guard. */
export const implementsSandboxPolicyEnforcer = (value: unknown): value is SandboxPolicyEnforcer =>
  passesSchema(sandboxPolicyEnforcerSchema, value)
