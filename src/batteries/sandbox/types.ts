import { passesSchema } from './validation'
import { validator } from '@nhtio/validation'
import { isObject } from '../../lib/utils/guards'
import { isRejectedSandboxPath, normalizeSandboxPath } from './paths'

/**
 * Presentation/normalisation brand only; this is NOT a containment guarantee.
 * Every filesystem use must still pass through PathTranslator.toRelative().
 */
export type ModelPath = string & { readonly __sandboxModelPath: unique symbol }
/** Opaque model-facing write root; constructed only by the path layer. */
export type ModelWriteRoot = ModelPath & { readonly __sandboxModelWriteRoot: unique symbol }
/**
 * Create a presentation/normalisation path only; this is NOT a containment guarantee.
 * Every filesystem use must still pass through PathTranslator.toRelative().
 */
export const createModelPath = (value: string): ModelPath => {
  if (isRejectedSandboxPath(value)) throw new TypeError('path is not a model path')
  try {
    return normalizeSandboxPath(value) as ModelPath
  } catch {
    throw new TypeError('path is not a model path')
  }
}
/** Construct the model root representation used in model-facing outcomes. */
export const createModelWriteRoot = (value: string): ModelWriteRoot =>
  createModelPath(value) as ModelWriteRoot
/** Opaque epoch issued by the sandbox manager and consumed by readers. */
export class SandboxEpoch {
  /**
   * Nominal-typing brand. LOAD-BEARING, and `protected` deliberately rather than `#private`:
   * TypeScript derives class nominality from private/protected MEMBERS, not from a protected
   * CONSTRUCTOR, so without a member here the class is structurally `{}` and any bare object
   * satisfies `SandboxEpoch` — which is exactly what an epoch token must not permit. A `#brand`
   * would brand it equally well but reads as an unused local; a protected member does not, since
   * a subclass could legitimately use it.
   */
  protected readonly brand: undefined = undefined
  protected constructor() {}

  /** Issue a fresh epoch token for a sandbox manager. */
  static issue(): SandboxEpoch {
    return new SandboxEpoch()
  }
}
/** Issue a fresh epoch token without requiring a type assertion. */
export const createSandboxEpoch = (): SandboxEpoch => SandboxEpoch.issue()

/** Assembly-facing policy. Reads allow by default; writes and network deny by default. */
export interface SandboxPolicy {
  /** Filesystem rules; `disabled` is a kill switch and deliberately does not unify axis defaults. */
  readonly filesystem: {
    /** When true, no filesystem rules apply. */ readonly disabled?: boolean
    /** Read rules use deny-then-allow precedence. */ readonly allowRead?: readonly string[]
    readonly denyRead?: readonly string[]
    /** Write rules use allow-only semantics; deny wins inside the allow list. */ readonly allowWrite?: readonly string[]
    readonly denyWrite?: readonly string[]
    /** Whether `.git/config` is included in the mandatory deny set. */ readonly allowGitConfig?: boolean
    /** Git safe directories passed to spawned children. */ readonly gitSafeDirectories?: readonly string[]
    /** Linux mandatory-deny scan depth. */ readonly mandatoryDenySearchDepth?: number
  }
  /** Network rules. An absent allow list means deny all unless disabled. */
  readonly network: {
    readonly disabled?: boolean
    readonly allowedDomains?: readonly string[]
    readonly deniedDomains?: readonly string[]
    /** Model-readable reasons for denied domains. */ readonly deniedDomainReasons?: Readonly<
      Record<string, string>
    >
  }
}

/** Backend-derived rules used for admission and drift checks, not a model-facing policy. */
export interface DerivedRules {
  /** Platform matcher; there is intentionally no `win32` arm. */
  readonly matcher: {
    readonly platform: 'darwin' | 'linux'
    /** Linux mandatory-deny files are folded; ordinary policy lists are not. */
    readonly caseInsensitive: boolean
    readonly readGlobs: 'native' | 'expanded'
    readonly writeGlobs: 'native' | 'dropped'
  }
  /** Reads are deny-then-allow; allowWithinDeny wins. */
  readonly read: {
    readonly denyOnly: readonly string[]
    readonly allowWithinDeny: readonly string[]
  }
  /** Writes are allow-only; denyWithinAllow wins. */
  readonly write: {
    readonly allowOnly: readonly string[]
    readonly denyWithinAllow: readonly string[]
  }
  /** Reproduced mandatory denies, with provenance because SRT does not expose this derivation. */
  readonly mandatoryDeny: {
    readonly form: 'glob' | 'expanded-paths'
    readonly entries: readonly string[]
    readonly allowGitConfig: boolean
    readonly searchDepth: number
    readonly dotGitWasDirectory?: boolean
  }
  /**
   * Whether the live sandbox has filesystem policy switched off entirely.
   *
   * @remarks
   * A kill switch, and the drift check treats it asymmetrically: `true → false` is a NARROWING and
   * therefore permitted, while `false → true` is DRIFT — it bypasses every filesystem rule while every
   * set comparison still passes, which is precisely why it is compared on its own rather than inferred
   * from the path lists.
   */
  readonly filesystemDisabled: boolean
  /** `disabled` is an ADK provenance discriminator, not an SRT field. */
  readonly network: {
    readonly disabled: boolean
    readonly allowedDomains: readonly string[]
    readonly deniedDomains: readonly string[]
    readonly strictAllowlist: boolean
  }
  /** Unknown upstream keys are drift signals and fail closed. */
  readonly unknownKeys: readonly string[]
  /** Glob forms this derivation could not compile, distinct from pairwise undecidability. */
  readonly undecidableGlobs: readonly string[]
}

/** Terminal traversal protocol. Done is mandatory so end-of-stream cannot masquerade as completion. */
export type Done =
  | { kind: 'done'; complete: true }
  | { kind: 'done'; complete: false; omitted: 'unexplored'; bound: 'maxDepth'; atDepth: number }
/** List item frames followed by exactly one {@link Done}. */
export type ListFrame = { kind: 'item'; path: string; entryKind: 'file' | 'dir' } | Done
/** Path-search item frames followed by exactly one {@link Done}. */
export type PathFrame = { kind: 'item'; path: string } | Done
/** Content-hit frames contain the whole matched line, followed by exactly one {@link Done}. */
export type HitFrame = { kind: 'item'; path: string; line: number; text: string } | Done

/** Limits for a hostile guest: exactly seven fields, resolved before spawning and passed to both realms. */
export interface GuestLimits {
  /** Per-event UTF-8 cap. Default 8192; floor 32 leaves room for the cut marker. */ maxLogEventBytes: number
  /** Retained event count. Default 1000; floor 1 because framing consumes an event. */ maxLogEvents: number
  /** Post-settlement sequence drain. Default 250ms; floor 0, where zero means do not wait. */ logDrainMs: number
  /** Codec traversal depth. Default 32; floor 4. */ codecMaxDepth: number
  /** Codec node count. Default 10_000; floor 16. */ codecMaxNodes: number
  /** Producer-side hostcall/hostresult envelope cap. Default 1_000_000; floor 4096. */ maxHostcallBytes: number
  /** Guest terminal envelope cap. Default 10_000_000; floor 4096. */ maxTerminalPayloadBytes: number
}

/** Per-evaluation host RPC quotas, separate from the seven guest limits. */
export interface HostcallQuotas {
  /** Per-call deadline in milliseconds; default 10_000, floor 1. */ hostcallTimeoutMs: number
  /** Accepted calls per evaluation; default 1000, floor 1. */ maxHostcallsPerEvaluation: number
  /** Simultaneous accepted calls; default 8, floor 1. */ maxConcurrentHostcalls: number
}

/** A thrown guest value, preserving whether encoder representation was complete. */
export type GuestThrown =
  | {
      kind: 'error'
      message?: string
      messageTruncated?: boolean
      stack?: string
      stackTruncated?: boolean
    }
  | { kind: 'value'; encoded: unknown; encoding: 'encoder' | 'partial' }
  | { kind: 'opaque' }
/** One bounded, sequence-stamped guest log event. */
/**
 * One log event exactly as the trusted guest bootstrap's logger posts it.
 *
 * @remarks
 * The logger — our code inside the guest, never the snippet — stamps each event with a monotonic
 * per-call sequence and UTF-8-truncates it to `maxLogEventBytes` BEFORE posting. Bounding in the
 * guest is the load-bearing half: a host-side byte count is applied after structured clone has
 * already materialised the string, so a single oversized `console.log` would be in host memory
 * before any accounting could react.
 */
export type GuestLogEvent = {
  /** Monotonic per-call sequence, authored by the bootstrap logger — never by the snippet. It is what lets the host prove delivery completeness against the declared `logCount`. */
  seq: number
  /** The logged text, already UTF-8-truncated in the guest when it exceeded `maxLogEventBytes`. */
  text: string
  /** `true` when this event was cut to fit `maxLogEventBytes`; the host renders it with the pinned sentinel suffix so a clipped line is never read as a complete one. */
  truncated: boolean
}
/** Delivery and emission framing for guest logs. */
export type GuestLogFraming = (
  | { logsComplete: true }
  | { logsComplete: false; logsThrough: number }
) & {
  logs: GuestLogEvent[]
  logsCapped: boolean
}
/** Settled guest evaluation; partial encoding is still successful execution. */
export type GuestOutcome = (
  | { ok: true; result: unknown; encoding: 'encoder' | 'partial'; durationMs: number }
  | { ok: false; thrown: GuestThrown; durationMs: number }
) &
  GuestLogFraming
/** A guest evaluation handle; timeout kills and rejects rather than fabricating a result. */
export interface GuestHandle {
  /** Evaluate source with the model-visible deadline. */
  evaluate(source: string, o: { timeoutMs: number }): Promise<GuestOutcome>
  /** Terminate the guest process or worker. */
  kill(): Promise<void>
}

/** Defaults visible as model-facing tool arguments; guest limits are intentionally separate. */
export interface SandboxCallDefaults {
  /** Default traversal depth: 20. */ maxDepth: number
  /** Default shell timeout: 300 seconds. */ shellTimeoutSeconds: number
  /** Default JavaScript timeout: 30 seconds. */ evaluateTimeoutSeconds: number
}

/** Default guest values, each paired with its own floor. */
export const guestLimitsDefaults: GuestLimits = {
  maxLogEventBytes: 8192,
  maxLogEvents: 1000,
  logDrainMs: 250,
  codecMaxDepth: 32,
  codecMaxNodes: 10_000,
  maxHostcallBytes: 1_000_000,
  maxTerminalPayloadBytes: 10_000_000,
}
/** Minimum representable guest values. */
export const guestLimitFloors: GuestLimits = {
  maxLogEventBytes: 32,
  maxLogEvents: 1,
  logDrainMs: 0,
  codecMaxDepth: 4,
  codecMaxNodes: 16,
  maxHostcallBytes: 4096,
  maxTerminalPayloadBytes: 4096,
}
/** Default host quotas. */
export const hostcallQuotasDefaults: HostcallQuotas = {
  hostcallTimeoutMs: 10_000,
  maxHostcallsPerEvaluation: 1000,
  maxConcurrentHostcalls: 8,
}
/** Closed structural schema for {@link SandboxPolicy}. */
export const sandboxPolicySchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (value === null || typeof value !== 'object') return helpers.error('any.invalid')
    const v = value as Record<string, unknown>
    if (Object.keys(v).some((key) => !['filesystem', 'network'].includes(key)))
      return helpers.error('any.invalid')
    const isStrings = (item: unknown): item is readonly string[] =>
      Array.isArray(item) && item.every((entry) => typeof entry === 'string')
    const isReasons = (item: unknown): boolean =>
      isObject(item) && Object.values(item).every((entry) => typeof entry === 'string')
    const definitions: Record<string, Record<string, (item: unknown) => boolean>> = {
      filesystem: {
        disabled: (item) => typeof item === 'boolean',
        allowRead: isStrings,
        denyRead: isStrings,
        allowWrite: isStrings,
        denyWrite: isStrings,
        allowGitConfig: (item) => typeof item === 'boolean',
        gitSafeDirectories: isStrings,
        mandatoryDenySearchDepth: (item) =>
          typeof item === 'number' && Number.isInteger(item) && item >= 0,
      },
      network: {
        disabled: (item) => typeof item === 'boolean',
        allowedDomains: isStrings,
        deniedDomains: isStrings,
        deniedDomainReasons: isReasons,
      },
    }
    for (const [section, members] of Object.entries(definitions)) {
      const part = v[section]
      if (part === null || typeof part !== 'object' || Array.isArray(part))
        return helpers.error('any.invalid')
      const record = part as Record<string, unknown>
      if (Object.keys(record).some((key) => !members[key] || !members[key](record[key])))
        return helpers.error('any.invalid')
    }
    return value
  })
/** Duck-type guard for {@link SandboxPolicy}. */
export const implementsSandboxPolicy = (value: unknown): value is SandboxPolicy =>
  passesSchema(sandboxPolicySchema, value)
const limitSchema = (floors: GuestLimits | HostcallQuotas) =>
  validator
    .any()
    .required()
    .custom((value, helpers) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return helpers.error('any.invalid')
      if (
        Object.keys(value).length !== Object.keys(floors).length ||
        Object.keys(value).some((key) => !Object.hasOwn(floors, key))
      )
        return helpers.error('any.invalid')
      for (const key of Object.keys(floors)) {
        const n = (value as Record<string, unknown>)[key]
        if (
          typeof n !== 'number' ||
          !Number.isFinite(n) ||
          !Number.isInteger(n) ||
          n < (floors as unknown as Record<string, number>)[key]
        )
          return helpers.error('any.invalid')
      }
      return value
    })
/** Schema enforcing every guest field's own floor. */
export const guestLimitsSchema = limitSchema(guestLimitFloors)
/** Guard for resolved guest limits. */
export const implementsGuestLimits = (value: unknown): value is GuestLimits =>
  passesSchema(guestLimitsSchema, value)
/** Schema enforcing every host quota floor. */
export const hostcallQuotasSchema = limitSchema({
  hostcallTimeoutMs: 1,
  maxHostcallsPerEvaluation: 1,
  maxConcurrentHostcalls: 1,
})
/** Guard for resolved host quotas. */
export const implementsHostcallQuotas = (value: unknown): value is HostcallQuotas =>
  passesSchema(hostcallQuotasSchema, value)
