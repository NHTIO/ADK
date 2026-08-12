import { createSandboxEpoch } from './types'
import { runSandboxPreflight } from './preflight'
import { createSandboxObservability, emitDriftCheck, emitFallback } from './observability'
import {
  E_SANDBOX_NOT_INITIALIZED,
  E_SANDBOX_POLICY_CONFLICT,
  E_SANDBOX_NARROWING_UNSUPPORTED,
} from './exceptions'
import type { PathTranslator } from './contracts/path_translator'
import type { SandboxPolicy, DerivedRules, SandboxEpoch } from './types'
import type { SandboxPolicyEnforcer } from './contracts/policy_enforcer'

type RunOptions = Parameters<SandboxPolicyEnforcer['run']>[0]
/**
 * A live sandbox session: the object every sandbox tool is built against.
 *
 * @remarks
 * THIS IS A PROCESS-GLOBAL CAPABILITY WEARING A PER-HANDLE API, and the shape is a promise narrowed
 * rather than a promise kept. `SandboxManager` is a singleton, so the first `createSandbox()` in a
 * process establishes the policy and a later one may only NARROW it — a request that is not a subset
 * throws `E_SANDBOX_POLICY_CONFLICT` naming both. One policy per process is the safe deployment;
 * multi-tenant agents with different policies want separate processes.
 *
 * Every `run()` re-validates against the admission baseline before spawning, so a widening of the live
 * policy is DETECTED. Detection is not prevention: SRT's proxies consult policy per request, so a
 * widening already affects an in-flight child for its whole lifetime.
 */
export interface SandboxHandle {
  /**
   * Opaque token issued at construction and invalidated by {@link SandboxHandle.dispose}.
   *
   * @remarks
   * File-backed readers hold this rather than a filesystem reference, which is what makes disposal
   * deterministic: a staged reader outliving its TURN is legitimate, outliving its HANDLE is not.
   */
  readonly epoch: SandboxEpoch
  /**
   * The live DERIVED rules — not the `SandboxPolicy` that was requested.
   *
   * @remarks
   * A policy cannot express what the drift check has to compare (`denyOnly`/`allowWithinDeny`, the
   * unioned default write paths, Linux-expanded read globs, the profile-only mandatory denies), so
   * returning one here would compare the wrong thing and pass while the live sandbox had widened.
   * Under ADOPTION this re-derives from the live manager on every call; an owned session is cached.
   */
  readonly effectivePolicy: () => DerivedRules | undefined
  /**
   * Spawn under this session's policy, optionally narrowed for the single invocation.
   *
   * @remarks
   * Resolves as soon as the child is SPAWNED, handing back live `stdout`/`stderr` streams plus a
   * separate `completed` promise. Drain BOTH concurrently: pipe buffers are per-fd, so draining one to
   * completion first can block the other and hang the child. A non-zero exit is data on `completed`,
   * never a rejection.
   */
  run(options: RunOptions): ReturnType<SandboxPolicyEnforcer['run']>
  /**
   * Narrow the session policy for subsequent operations.
   *
   * @param policy - Must be a subset per the per-axis rules; reads are deny-then-allow while writes
   * are allow-only, so "narrower" is not symmetric. Throws
   * `E_SANDBOX_NARROWING_UNSUPPORTED` naming the axis where the platform cannot narrow it.
   */
  narrow(policy: SandboxPolicy): Promise<void>
  /** Predicate consumed by file-backed readers; disposal makes the epoch unusable. */
  isEpochLive(epoch: SandboxEpoch): boolean
  /**
   * Quiesce the session: it does not abandon in-flight work.
   *
   * @remarks
   * Rejects new work with `E_SANDBOX_NOT_INITIALIZED`, aborts in-flight invocations through their
   * signals, kills spawned children, then releases the enforcer. On an ADOPTED session this is a
   * reported NO-OP — resetting a manager we did not create would strip ACEs a host application
   * depends on.
   */
  dispose(): Promise<void>
}

/** Options for {@link createSandbox}. */
export interface CreateSandboxOptions {
  /**
   * ADK-owned policy vocabulary, mapped to the backend's config inside the enforcer.
   *
   * @remarks
   * The per-axis defaults DIFFER and are not a symmetry worth "fixing": reads default to ALLOW
   * (absent `denyRead` means everything is readable, and `allowRead` re-permits WITHIN a deny), while
   * writes default to DENY and network is an allow-list. A checker that unified them would disagree
   * with the OS by construction.
   */
  readonly policy: SandboxPolicy
  /** The boundary itself. Node's SRT-backed enforcer lives on the `sandbox/node` subpath. */
  readonly enforcer: SandboxPolicyEnforcer
  /**
   * Model-path translation, and the redaction used on every observability event.
   *
   * @remarks
   * Supply it if you want host identifiers scrubbed from the event stream — no battery-generated
   * surface should carry the sandbox root, home directory, or user name.
   */
  readonly translator?: PathTranslator
  /** Observability firehose: bypasses, fallbacks, drift outcomes, and the SRT version rules came from. */
  readonly onSandbox?: (event: Parameters<ReturnType<typeof createSandboxObservability>>[0]) => void
  /**
   * Permit running WITHOUT OS containment when the environment cannot provide it.
   *
   * @remarks
   * Fires only for pre-execution conditions resolved once at construction — a platform the backend
   * cannot sandbox that we still run on, dependency errors, or an absent optional peer. It NEVER fires
   * for a violation (a violation means the sandbox worked), and native Windows is refused outright
   * rather than degraded. When it fires the handle is permanently marked, every invocation emits a loud
   * event, and the tool descriptions tell the model it has no OS containment.
   */
  readonly allowUnsandboxedFallback?: boolean
  /** Ignore the per-call escape entirely, matching the reference consumer's strict mode. */
  readonly strictMode?: boolean
  /** Whether the optional peer resolved; feeds the preflight decision above. */
  readonly optionalPeerPresent?: boolean
  /** Recorded on observability events so a rules-versus-backend mismatch is diagnosable without a bisect. */
  readonly fsNodeVersion?: string
}

let owner: { baseline: DerivedRules; enforcer: SandboxPolicyEnforcer; owned: boolean } | undefined

const list = (value: readonly string[] | undefined): readonly string[] => value ?? []
const json = (value: unknown): string => JSON.stringify(value)

/**
 * Conservative list inclusion. Globs which are not lexically identical are deliberately
 * undecidable and therefore fail closed. This is a sufficient test, not a complete relation.
 */
const subset = (small: readonly string[], large: readonly string[]): boolean =>
  small.every((item) => large.includes(item))
const same = (a: unknown, b: unknown): boolean => json(a) === json(b)

/** Compare a requested (admission) derived policy with the live one: requested ⊆ live. */
const admission = (ours: DerivedRules, live: DerivedRules): boolean => {
  if (!same(ours.matcher, live.matcher) || !same(ours.mandatoryDeny, live.mandatoryDeny))
    return false
  if (ours.filesystemDisabled && !live.filesystemDisabled) return false
  if (!ours.filesystemDisabled && live.filesystemDisabled) {
    // A kill switch is widening, and is consequently safe for admission.
  }
  return (
    subset(live.read.denyOnly, ours.read.denyOnly) &&
    subset(ours.read.allowWithinDeny, live.read.allowWithinDeny) &&
    subset(ours.write.allowOnly, live.write.allowOnly) &&
    subset(live.write.denyWithinAllow, ours.write.denyWithinAllow) &&
    subset(ours.network.allowedDomains, live.network.allowedDomains) &&
    subset(live.network.deniedDomains, ours.network.deniedDomains)
  )
}

/** Compare a live snapshot with the admission baseline: widening is drift. */
const drift = (baseline: DerivedRules, live: DerivedRules): string | undefined => {
  if (!same(baseline.matcher, live.matcher)) return 'matcher changed'
  if (!same(baseline.mandatoryDeny, live.mandatoryDeny)) return 'mandatory deny inputs changed'
  if (!baseline.filesystemDisabled && live.filesystemDisabled) return 'filesystem.disabled widened'
  if (baseline.filesystemDisabled && !live.filesystemDisabled) {
    // Narrowing is explicitly allowed.
  }
  if (live.unknownKeys.length > 0) return `unknown live config keys: ${live.unknownKeys.join(', ')}`
  if (live.undecidableGlobs.length > 0)
    return `uncompilable live globs: ${live.undecidableGlobs.join(', ')}`
  if (!subset(live.read.denyOnly, baseline.read.denyOnly)) return 'read deny rules widened'
  if (!subset(live.read.allowWithinDeny, baseline.read.allowWithinDeny))
    return 'read allow rules widened'
  if (!subset(live.write.allowOnly, baseline.write.allowOnly)) return 'write allow rules widened'
  if (!subset(live.write.denyWithinAllow, baseline.write.denyWithinAllow))
    return 'write deny rules widened'
  if (baseline.network.disabled) {
    // Disabled means unrestricted, which cannot be represented by a domain list.
  } else {
    if (live.network.disabled) return 'network.disabled widened'
    if (!subset(live.network.allowedDomains, baseline.network.allowedDomains))
      return 'allowed domains widened'
    if (!subset(baseline.network.deniedDomains, live.network.deniedDomains))
      return 'denied domains widened'
  }
  if (baseline.network.strictAllowlist !== live.network.strictAllowlist)
    return 'strictAllowlist changed'
  return undefined
}

const policyEffect = (policy: SandboxPolicy, template: DerivedRules): DerivedRules => ({
  ...template,
  filesystemDisabled: Boolean(policy.filesystem.disabled),
  read: {
    denyOnly: [...list(policy.filesystem.denyRead)],
    allowWithinDeny: [...list(policy.filesystem.allowRead)],
  },
  write: {
    allowOnly: [...list(policy.filesystem.allowWrite)],
    denyWithinAllow: [...list(policy.filesystem.denyWrite)],
  },
  network: {
    ...template.network,
    disabled: Boolean(policy.network.disabled),
    allowedDomains: policy.network.disabled ? ['*'] : [...list(policy.network.allowedDomains)],
    deniedDomains: policy.network.disabled ? [] : [...list(policy.network.deniedDomains)],
  },
})

/**
 * Admit one process-global sandbox. Drift is detection, not prevention: SRT consults its
 * proxies per request, so a widening can affect an already-spawned child for its lifetime.
 */
export const createSandbox = async (options: CreateSandboxOptions): Promise<SandboxHandle> => {
  const sink =
    options.onSandbox && options.translator
      ? createSandboxObservability({ pathTranslator: options.translator, sink: options.onSandbox })
      : (options.onSandbox ?? (() => undefined))
  const preflight = await runSandboxPreflight({
    enforcer: options.enforcer,
    allowUnsandboxedFallback: options.allowUnsandboxedFallback,
    strictMode: options.strictMode,
    optionalPeerPresent: options.optionalPeerPresent,
    fsNodeVersion: options.fsNodeVersion,
    onSandbox: sink,
  })
  const live = options.enforcer.effectivePolicy()
  if (!live) throw new E_SANDBOX_POLICY_CONFLICT(['Sandbox has no derived policy'])
  // An adopted enforcer has no ADK policy provenance, so admission must compare the requested
  // effect against its genuinely live foreign baseline. Owned sessions retain the established
  // first-writer baseline for subsequent handles.
  const adopted = options.enforcer.adopted === true
  const firstHandle = owner === undefined
  if (owner !== undefined) {
    const admissionBaseline = adopted ? live : owner.baseline
    const requested = policyEffect(options.policy, admissionBaseline)
    if (!admission(requested, admissionBaseline)) {
      throw new E_SANDBOX_POLICY_CONFLICT([
        `requested policy ${json(options.policy)} conflicts with ${json(admissionBaseline)}`,
      ])
    }
  } else {
    // Adoption has no caller policy to compare against until this point; rule 3b compares the
    // requested effect with the foreign live baseline before admitting the first handle.
    if (adopted && !admission(policyEffect(options.policy, live), live))
      throw new E_SANDBOX_POLICY_CONFLICT([
        `requested policy ${json(options.policy)} conflicts with ${json(live)}`,
      ])
    owner = { baseline: live, enforcer: options.enforcer, owned: !adopted }
  }
  const baseline = owner.baseline
  const epoch = createSandboxEpoch()
  let disposed = false
  const controllers = new Set<AbortController>()
  const check = (): void => {
    if (disposed) throw new E_SANDBOX_NOT_INITIALIZED(['Sandbox handle has been disposed'])
    const current = owner?.enforcer.effectivePolicy()
    if (!current) throw new E_SANDBOX_NOT_INITIALIZED(['Sandbox policy is unavailable'])
    const reason = drift(baseline, current)
    if (reason) {
      emitDriftCheck(sink, 'failed', { reason })
      throw new E_SANDBOX_POLICY_CONFLICT([`sandbox drift detected: ${reason}`])
    }
    if (baseline.network.disabled) emitDriftCheck(sink, 'skipped', { networkDomainsSkipped: true })
    else emitDriftCheck(sink, 'passed')
  }
  const handle: SandboxHandle = {
    epoch,
    effectivePolicy: () => owner?.enforcer.effectivePolicy(),
    run: async (runOptions) => {
      check()
      const controller = new AbortController()
      controllers.add(controller)
      const signal = runOptions.signal
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason)
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      const result = owner!.enforcer.run({ ...runOptions, signal: controller.signal })
      void result.then(
        () => controllers.delete(controller),
        () => controllers.delete(controller)
      )
      if (preflight.fallbackFired) emitFallback(sink, 'sandbox', 'unsandboxed fallback')
      return result
    },
    narrow: async (policy) => {
      check()
      const candidate = options.enforcer as SandboxPolicyEnforcer & {
        narrow?: (requested: SandboxPolicy) => Promise<void>
      }
      if (typeof candidate.narrow !== 'function')
        throw new E_SANDBOX_NARROWING_UNSUPPORTED(['filesystem/network'])
      await candidate.narrow(policy)
    },
    isEpochLive: (candidate) => !disposed && candidate === epoch,
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const controller of controllers) controller.abort()
      controllers.clear()
      if (firstHandle) {
        if (!adopted) await options.enforcer.dispose()
        if (owner?.enforcer === options.enforcer) owner = undefined
      }
    },
  }
  return handle
}
