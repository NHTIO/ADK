/**
 * Construction-time admission for the sandbox.
 *
 * This is the seam consumed by WP-A1: `createSandbox()` must call this function once and
 * retain the returned, frozen decision.  In particular, WP-A1 must not reproduce the three
 * fallback predicates here; doing so would make the handle's security posture depend on two
 * subtly different implementations.
 */
import { E_SANDBOX_DEPENDENCY_MISSING, E_SANDBOX_UNSUPPORTED_ENV } from './exceptions'
import type { SandboxEventSink } from './observability'
import type { SandboxPolicyEnforcer } from './contracts/policy_enforcer'

/** Platform identity supplied by the construction site. */
export type SandboxPlatform = 'darwin' | 'linux' | 'win32' | string

/** Inputs to the construction-time environment admission check. */
export interface PreflightOptions {
  /** Policy backend to admit. */
  readonly enforcer: SandboxPolicyEnforcer
  /** Platform override, primarily for hermetic tests. */
  readonly platform?: SandboxPlatform
  /** Explicit opt-in to run without OS containment when a pre-execution condition applies. */
  readonly allowUnsandboxedFallback?: boolean
  /** Claude Code's strict mode: per-call escape/bypass is ignored by the consumer. */
  readonly strictMode?: boolean
  /** Whether the optional SRT peer was resolved. Defaults to true for injected test enforcers. */
  readonly optionalPeerPresent?: boolean
  /** Receives dependency warnings; warnings never make admission fail. */
  readonly onSandbox?: SandboxEventSink
  /** Path redaction is performed by the observability sink, not by this admission check. */
  readonly fsNodeVersion?: string
}

/** Immutable decision retained by a sandbox handle for its entire lifetime. */
export interface SandboxPreflight {
  /** Whether the construction opted into fallback. */
  readonly allowUnsandboxedFallback: boolean
  /** Whether one of the permitted pre-execution conditions fired. */
  readonly fallbackFired: boolean
  /** Whether per-call bypasses must be ignored. */
  readonly strictMode: boolean
  /** Non-fatal dependency diagnostics. */
  readonly dependencyWarnings: readonly string[]
  /** Version provenance for fs_node, when supplied by the backend. */
  readonly fsNodeVersion?: string
}

const currentPlatform = (): SandboxPlatform =>
  typeof process !== 'undefined' && typeof process.platform === 'string'
    ? process.platform
    : 'browser'

/** Run the once-only, fail-closed environment gauntlet used by `createSandbox()`. */
export const preflightSandbox = async (options: PreflightOptions): Promise<SandboxPreflight> => {
  const platform = options.platform ?? currentPlatform()
  if (platform === 'win32') {
    throw new E_SANDBOX_UNSUPPORTED_ENV([
      'Native Windows is not supported; run the sandbox inside a WSL2 distribution.',
    ])
  }

  if (!options.enforcer.isSupported()) {
    throw new E_SANDBOX_UNSUPPORTED_ENV([
      'The browser environment has no SRT boundary; use Part B (SES) as the cross-environment layer.',
    ])
  }

  const dependencies = await options.enforcer.checkDependencies()
  const warnings = Object.freeze([...dependencies.warnings])
  if (dependencies.warnings.length > 0) {
    options.onSandbox?.({ kind: 'dependency-warnings', warnings })
  }
  const optionalPeerPresent = options.optionalPeerPresent ?? true
  const platformCannotSandbox = options.enforcer.effectivePolicy() === undefined
  const fallbackCondition =
    platformCannotSandbox || dependencies.errors.length > 0 || !optionalPeerPresent
  if (dependencies.errors.length > 0 && !options.allowUnsandboxedFallback) {
    throw new E_SANDBOX_DEPENDENCY_MISSING([
      `Sandbox dependencies are unavailable: ${dependencies.errors.join('; ')}`,
    ])
  }
  const fallbackFired = Boolean(options.allowUnsandboxedFallback && fallbackCondition)
  const result: SandboxPreflight = {
    allowUnsandboxedFallback: fallbackFired,
    fallbackFired,
    strictMode: Boolean(options.strictMode),
    dependencyWarnings: warnings,
    ...(options.fsNodeVersion === undefined ? {} : { fsNodeVersion: options.fsNodeVersion }),
  }
  return Object.freeze(result)
}

/** Compatibility alias for the construction-site call in WP-A1. */
export const runSandboxPreflight = preflightSandbox
