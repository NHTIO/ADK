import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { isObject } from '@nhtio/adk/guards'
import { quoteShellArgs, validateAbsoluteBinaryPath, validateBinShell } from '../escape'
import { derivedRulesFromSrt, primeGlobMatcher, reproduceMandatoryDeny } from './fs_node'
import {
  E_INVALID_SANDBOX_CONFIG,
  E_SANDBOX_UNSUPPORTED_ENV,
  E_SANDBOX_POLICY_CONFLICT,
  E_SANDBOX_NETWORK_GRANT_UNSUPPORTED,
} from '../exceptions'
import type { BinarySandbox } from '../executor'
import type { SandboxPolicy, DerivedRules } from '../types'
import type { SandboxPolicyEnforcer } from '../contracts/policy_enforcer'

/**
 * The internal SRT bridge both execution routes share: admit a per-call policy, quote the argv,
 * and ask SRT for the wrapped argv.
 *
 * @remarks
 * Deliberately NOT part of `SandboxPolicyEnforcer` — the contract stays backend-neutral, so an
 * SRT-shaped internal field would make the "ADK-owned types" firewall nominal. It is exported only
 * as a type so the factory that consumes it can be typed; the value lives on the enforcer object
 * as a hidden carrier field.
 */
type SrtWrapFn = (
  argv: readonly string[],
  policy: SandboxPolicy,
  signal: AbortSignal | undefined,
  cwd: string | undefined,
  correlationId?: string
) => Promise<{ argv: string[]; env: Record<string, string> }>

/** What {@link srtBinarySandbox} probes for on the enforcer: the internal SRT carrier fields. */
type SrtCarrier = SandboxPolicyEnforcer & {
  wrapInvocation?: SrtWrapFn
  sessionPolicy?: SandboxPolicy
  hostEnv?: Record<string, string>
}

type SrtManager = {
  initialize(config: SrtConfig): Promise<void>
  isSupportedPlatform(): boolean
  isSandboxingEnabled(): boolean
  checkDependenciesAsync(): Promise<{ errors: string[]; warnings: string[] }>
  wrapWithSandboxArgv(
    command: string,
    shell?: string,
    custom?: unknown,
    signal?: AbortSignal,
    cwd?: string,
    options?: { commandId?: string }
  ): Promise<{ argv: string[]; env: Record<string, string> }>
  getFsReadConfig(): { denyOnly: string[]; allowWithinDeny?: string[] }
  getFsWriteConfig(): { allowOnly: string[]; denyWithinAllow: string[] }
  getNetworkRestrictionConfig(): {
    allowedHosts?: string[]
    deniedHosts?: string[]
  }
  getConfig(): SrtConfig | undefined
  getSandboxViolationStore(): {
    getViolationsForCommand(command: string): unknown[]
  }
  reset(): Promise<void>
}
type SrtConfig = {
  filesystem: Record<string, unknown>
  network?: Record<string, unknown>
  /** SRT's Linux mandatory-deny scan depth is session-level. */
  mandatoryDenySearchDepth?: number
  git?: { safeDirectories: string[] }
  /** Top-level and session-level: SRT reads this from the config `initialize()` stored, not per call. */
  enableWeakerNestedSandbox?: boolean
  bwrapPath?: string
  socatPath?: string
}

const unsupported = (): never => {
  throw new E_SANDBOX_UNSUPPORTED_ENV([
    `SRT sandbox is unavailable on ${process.platform}; use WSL2 or the SES browser path`,
  ])
}

const json = (value: unknown): string => JSON.stringify(value)

/**
 * Why a per-call policy's network section is not the session baseline, or an empty list when it
 * EQUALS the baseline.
 *
 * @remarks
 * SRT enforces network allow/deny per REQUEST against the process-global SESSION config, never the
 * per-call `customConfig`: its mux proxy is started once at `initialize()` and `filterNetworkRequest`
 * reads `config.network.*` on every request (see the docs page for the source receipts). An
 * embedder hook exists — `network.filterRequest` and the `initialize()` ask callback — but neither
 * can scope enforcement to one child: the ask callback is handed only `{host, port}`, is suppressed
 * entirely while `strictAllowlist` is set (which this battery always sets), and its identity input
 * (the proxy username) is client-controlled and forgeable; `filterRequest` runs only AFTER the
 * session list has allowed a host, so it can deny within the list but never grant beyond it. A
 * per-call network section that differs from the session one — WIDER or NARROWER — would therefore be
 * silently ignored at enforcement time.
 *
 * Refusing every divergence turns that silent ignore into a typed, immediate error. Equality is
 * exact: the same `disabled` flag, and — compared as SETS, so order does not matter — the same
 * allowed and denied domain patterns and the same denial reasons. `deniedDomainReasons` is read from
 * the LIVE session config (`manager.getConfig()`), which is what SRT's filter actually consults.
 */
const networkDivergence = (
  baseline: DerivedRules,
  policy: SandboxPolicy,
  sessionReasons: Readonly<Record<string, string>>
): readonly string[] => {
  // A disabled policy may not carry domains (`mapPolicy` throws for that combination), so its
  // canonical section is just the flag. A disabled BASELINE is unrestricted by definition, so it has
  // no domain lists or reasons to compare against.
  const policyDisabled = Boolean(policy.network.disabled)
  const policyAllowed = policyDisabled ? [] : nonEmpty(policy.network.allowedDomains)
  const policyDenied = policyDisabled ? [] : nonEmpty(policy.network.deniedDomains)
  const policyReasons = policyDisabled ? {} : { ...(policy.network.deniedDomainReasons ?? {}) }
  const baselineDisabled = baseline.network.disabled
  const baselineAllowed = baselineDisabled ? [] : baseline.network.allowedDomains
  const baselineDenied = baselineDisabled ? [] : baseline.network.deniedDomains
  const baselineReasons = baselineDisabled ? {} : sessionReasons

  const differences: string[] = []
  if (policyDisabled !== baselineDisabled)
    differences.push(`disabled ${baselineDisabled} → ${policyDisabled}`)
  if (!sameSet(asSet(policyAllowed), asSet(baselineAllowed)))
    differences.push(`allowedDomains ${json(baselineAllowed)} → ${json(policyAllowed)}`)
  if (!sameSet(asSet(policyDenied), asSet(baselineDenied)))
    differences.push(`deniedDomains ${json(baselineDenied)} → ${json(policyDenied)}`)
  if (!sameReasons(policyReasons, baselineReasons))
    differences.push(`deniedDomainReasons ${json(baselineReasons)} → ${json(policyReasons)}`)
  return differences
}
const nonEmpty = (v: readonly string[] | undefined): string[] => [...(v ?? [])]
const asSet = (v: readonly string[]): ReadonlySet<string> => new Set(v)
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((item) => b.has(item))
const sameReasons = (
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean => {
  const aKeys = Object.keys(a)
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => b[key] === a[key])
}
/** Coerce an arbitrary upstream value into the string→string denial-reason map SRT expects. */
const reasonMap = (value: unknown): Record<string, string> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {}

/**
 * Host variables a sandboxed child inherits when the caller names no allow-list.
 *
 * @remarks
 * `PATH` ONLY, and it is the minimum rather than a convenience. The ripgrep searcher spawns `rg` by
 * BARE NAME, so with no `PATH` the child sees only the one a shell synthesises
 * (`/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:.`) — which does not contain `/opt/homebrew/bin` or a Nix
 * profile, so `search_files` would fail as `io-failure` on any such host and present as *"the search
 * tool is broken"* rather than as a configuration error.
 *
 * `PATH` is not a credential: a model that runs `env` learns where binaries live, not a secret. Every
 * genuinely sensitive variable — and `HOME`, `USER`, `TMPDIR`, which leak host layout — stays out.
 */
const DEFAULT_ENV_ALLOW_LIST: readonly string[] = ['PATH']

/** POSIX environment-variable names. Anything else could not be exported by a shell anyway. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Resolve the host half of a sandboxed child's environment ONCE, at construction.
 *
 * @remarks
 * DENY BY DEFAULT. Before this existed the enforcer spread the entire `process.env` into every child,
 * so a model directing the shell's argv could run `env` and read the host's credentials straight back
 * into its own context — which no filesystem or network policy prevents, because the secret arrives in
 * the tool result rather than over the wire.
 *
 * The allow-list REPLACES this default rather than extending it; that is stated on the option, because
 * the opposite assumption is the natural one and would silently drop `PATH`.
 *
 * @param options - The enforcer's construction options.
 * @returns The host variables to seed the child's environment with.
 */
const resolveHostEnv = (options: SrtEnforcerOptions): Record<string, string> => {
  if (options.inheritHostEnv === true) {
    const all: Record<string, string> = {}
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined) all[name] = value
    return all
  }
  const names = options.envAllowList ?? DEFAULT_ENV_ALLOW_LIST
  const picked: Record<string, string> = {}
  for (const name of names) {
    if (!ENV_NAME.test(name))
      throw new E_INVALID_SANDBOX_CONFIG([
        `envAllowList entry ${JSON.stringify(name)} is not a valid environment variable name`,
      ])
    const value = process.env[name]
    if (value !== undefined) picked[name] = value
  }
  return picked
}

/**
 * Whether `<cwd>/.git` is a real DIRECTORY.
 *
 * @remarks
 * Load-bearing on Linux only: upstream pushes the workspace-root `.git/hooks` and `.git/config` deny
 * entries just when `.git` is a directory, because in a worktree it is a FILE and denying it would
 * make bubblewrap fail. Treating a worktree as a directory would deny what the profile permits.
 */
const dotGitIsDirectory = (cwd: string): boolean => {
  try {
    return statSync(resolve(cwd, '.git')).isDirectory()
  } catch {
    return false
  }
}

/**
 * The sole ADK-to-SRT translation point. Keep the upstream type behind this local firewall.
 *
 * @remarks
 * `runtime` carries ADAPTER-level settings that are deliberately absent from `SandboxPolicy`. That
 * type is ADK-owned, SRT-neutral vocabulary — naming an SRT feature in it would make the firewall
 * nominal and leave a non-SRT enforcer unable to implement the contract — so an SRT-specific switch
 * belongs on the adapter's own options, exactly as `binShell` already does.
 */
const mapPolicy = (
  policy: SandboxPolicy,
  runtime: {
    enableWeakerNestedSandbox?: boolean
    bwrapPath?: string
    socatPath?: string
  } = {}
): SrtConfig => {
  const fs = policy.filesystem
  const net = policy.network
  if (
    net.disabled &&
    (net.deniedDomains?.length ||
      Object.keys(net.deniedDomainReasons ?? {}).length ||
      (net.allowedDomains && !(net.allowedDomains.length === 1 && net.allowedDomains[0] === '*')))
  )
    throw new E_INVALID_SANDBOX_CONFIG(['network.disabled contradicts network domain restrictions'])
  const allowedDomains = net.disabled ? ['*'] : nonEmpty(net.allowedDomains)
  const deniedDomains = net.disabled ? [] : nonEmpty(net.deniedDomains)
  const deniedDomainReasons = net.disabled ? {} : { ...(net.deniedDomainReasons ?? {}) }
  return {
    ...(fs.mandatoryDenySearchDepth !== undefined
      ? { mandatoryDenySearchDepth: fs.mandatoryDenySearchDepth }
      : {}),
    // Emitted only when enabled, so an untouched configuration is byte-identical to before this
    // option existed — a drift snapshot taken either side of the upgrade compares equal.
    ...(runtime.enableWeakerNestedSandbox === true ? { enableWeakerNestedSandbox: true } : {}),
    ...(runtime.bwrapPath !== undefined ? { bwrapPath: runtime.bwrapPath } : {}),
    ...(runtime.socatPath !== undefined ? { socatPath: runtime.socatPath } : {}),
    filesystem: {
      ...(fs.disabled ? { disabled: true } : {}),
      denyRead: nonEmpty(fs.denyRead),
      allowRead: nonEmpty(fs.allowRead),
      allowWrite: nonEmpty(fs.allowWrite),
      denyWrite: nonEmpty(fs.denyWrite),
      allowGitConfig: fs.allowGitConfig ?? false,
    },
    // SRT keys network restriction by presence of this object. There is no schema-valid allow-all
    // domain pattern, so disabled deliberately omits the key instead of emitting the rejected '*'.
    ...(!net.disabled
      ? {
          network: {
            allowedDomains,
            deniedDomains,
            deniedDomainReasons,
            strictAllowlist: true,
            allowLocalBinding: false,
            allowUnixSockets: [],
            allowMachLookup: [],
          },
        }
      : {}),
    git: {
      safeDirectories: nonEmpty(fs.gitSafeDirectories ?? [process.cwd()]),
    },
  }
}

const toWeb = (stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> =>
  (
    ReadableStream as unknown as {
      from?: (x: unknown) => ReadableStream<Uint8Array>
    }
  ).from
    ? (
        ReadableStream as unknown as {
          from: (x: unknown) => ReadableStream<Uint8Array>
        }
      ).from(stream)
    : new ReadableStream({
        start(controller) {
          stream.on('data', (x: Buffer) => controller.enqueue(new Uint8Array(x)))
          stream.on('end', () => controller.close())
          stream.on('error', (e) => controller.error(e))
        },
      })

/** Options for {@link srtEnforcer}. */
/**
 * Whether an enforcer in THIS process performed the `initialize()` that is currently in force.
 *
 * @remarks
 * UPSTREAM'S OWN FLAG CANNOT ANSWER THIS. `isSandboxingEnabled()` is literally `config !== undefined`
 * (`sandbox-manager.js:672-675`) and `reset()` clears `managerContext`, the proxies, the registries —
 * **but never `config`**. So after any reset the flag stays `true` forever, and an enforcer that
 * trusted it would "adopt" a sandbox that is no longer in force, silently reporting a stale policy
 * and refusing to re-initialise. Verified: initialize, reset, and `isSandboxingEnabled()` is still
 * `true`.
 *
 * We therefore track what WE established. `true` here means this module owns the live session, so a
 * subsequent construction must re-initialise rather than adopt. `false` with upstream reporting
 * enabled means somebody else got there first — the genuine adoption case.
 */
let selfInitialized = false

/**
 * Whether the session THIS module established is still claimed by a live enforcer.
 *
 * @remarks
 * FIRST-WRITER-WINS IS ENFORCED HERE, not only in the manager. `manager.ts` admits or refuses a
 * second handle by comparing policies — but that check runs AFTER `srtEnforcer()` has already
 * constructed, and construction is what touches the process-global. So a reset-and-reinitialise in the
 * constructor would tear down a live policy before anything could refuse it: caller 2 widens the real
 * sandbox, the manager then throws, and caller 1 carries on against a baseline that is no longer in
 * force. The refusal would arrive after the damage.
 *
 * `claimed` is therefore set when we initialise and cleared only by `dispose()`. While it is `true`,
 * re-initialising is refused outright; once cleared, the next construction may re-establish a session,
 * which is what makes sequential owned handles work.
 */
let selfSessionClaimed = false

/**
 * Relinquish this module's ownership marker.
 *
 * @remarks
 * TEST SEAM, and a narrow one. The marker exists because upstream's `isSandboxingEnabled()` is
 * `config !== undefined` and `reset()` never clears `config` — so after the first `initialize()` the
 * flag is permanently `true` and cannot by itself distinguish *"a session we established"* from
 * *"somebody else's"*. Ownership therefore persists for the life of the module, which is correct in
 * production (a process that initialised once keeps re-initialising its own session) but makes the
 * ADOPTION branch unreachable in a test file that has already constructed an owned enforcer.
 *
 * Production code has no reason to call this: relinquishing ownership while a session we established
 * is still live would make the next construction adopt it and refuse to re-initialise.
 */
export const releaseSrtOwnershipForTests = (): void => {
  selfInitialized = false
  selfSessionClaimed = false
}

/** Construction options for {@link srtEnforcer}. */
export type SrtEnforcerOptions = {
  /**
   * Absolute path to the POSIX shell used to invoke wrapped commands. Defaults to `/bin/bash`.
   *
   * @remarks
   * Validated at construction in TWO checks, both required: it must be ABSOLUTE (a bare `bash` passes
   * any basename test while remaining `PATH`-dependent — the exact hazard the absolute default
   * avoids), and its basename must be on the allow-list (`sh`, `bash`, `dash`, `zsh`, `ksh`) — the
   * shells whose quoting the single escaper is correct for. An allow-list rather than a deny-list is
   * deliberate: `fish` and `nu` are POSIX-ish enough to look safe and different enough to break
   * single-quote escaping, so an unverified shell must fail closed.
   */
  binShell?: string
  /**
   * The ADK-owned policy to enforce.
   *
   * @remarks
   * Mapped to SRT's config inside this module and nowhere else. The derived baseline is captured
   * immediately after `initialize()`, because `SandboxManager` is a process-global singleton whose
   * SECOND `initialize()` is a no-op — a later call with a different policy silently keeps the first.
   */
  policy: SandboxPolicy
  /**
   * Host environment variable NAMES a sandboxed child may inherit. Defaults to `['PATH']`.
   *
   * @remarks
   * The child inherits NOTHING from the host beyond these names. That default is deliberate: a model
   * that can direct the shell's argv can run `env`, so anything inherited is readable back into its
   * context — and no filesystem or network policy stops it, because the value arrives in the tool
   * result rather than over the wire.
   *
   * **This REPLACES the default, it does not extend it.** A caller who needs `CARGO_HOME` and still
   * wants binaries to resolve must pass BOTH: `['PATH', 'CARGO_HOME']`. Passing `['CARGO_HOME']` alone
   * drops `PATH`, which breaks `search_files` on any host where `rg` lives outside `/usr/bin`.
   *
   * An entry that is not a valid POSIX environment-variable name throws `E_INVALID_SANDBOX_CONFIG` at
   * construction rather than being skipped, so a typo surfaces as a startup error instead of a
   * variable that silently never arrives.
   */
  envAllowList?: readonly string[]
  /**
   * Pass the ENTIRE host environment to sandboxed children. Defaults to `false`.
   *
   * @remarks
   * The escape hatch for a deployment that genuinely needs ambient configuration, and it is worth
   * being blunt about what it re-opens: **every secret in the host process becomes readable by the
   * model**, because `run_shell_command` exists precisely to run commands the model chose and `env` is
   * one of them. Prefer naming what you need in `envAllowList`.
   */
  inheritHostEnv?: boolean
  /**
   * Absolute path to a Linux bubblewrap wrapper or binary. SRT reads it from the config passed to
   * `initialize()`; on the Linux launch path it becomes argv[0] of the bwrap command
   * (`linux-sandbox-utils.js:1539`). A wrapper script placed at this path therefore receives every
   * bwrap argument and can strip or rewrite options such as `--unshare-net`. On Linux a nonexistent
   * path fails in SRT's `initialize()`; on macOS it is neither validated nor used.
   */
  bwrapPath?: string
  /**
   * Absolute path to a Linux socat binary or wrapper. SRT passes it to `initializeLinuxNetworkBridge`
   * on Linux. A nonexistent path fails in SRT's `initialize()`; on macOS it is neither validated nor
   * used.
   */
  socatPath?: string
  /**
   * Enable SRT's weaker nested-sandbox mode, for running inside an unprivileged container.
   *
   * @remarks
   * Bubblewrap cannot mount a fresh `/proc` inside an unprivileged container, so the sandbox fails to
   * start at all — the symptom is `apply-seccomp: write /proc/self/uid_map: Operation not permitted`
   * with exit 1, an empty stdout and NO diagnostics, which is indistinguishable from a policy denial.
   * This flag makes the inner sandbox bind-mount the container's EXISTING `/proc` instead.
   *
   * **It considerably weakens the boundary**, in upstream's own words: the bind-mounted `/proc`
   * exposes process information a fresh mount would hide. Only enable it when the OUTER container
   * already provides the isolation you need — it trades inner isolation for the sandbox running at all.
   *
   * Session-level: SRT reads it from the config given to `initialize()`, never per call.
   */
  enableWeakerNestedSandbox?: boolean
}

/**
 * Construct the SRT-backed policy enforcer — the OS boundary.
 *
 * @remarks
 * REFUSES rather than degrades on an unsupported platform: native `win32` throws
 * `E_SANDBOX_UNSUPPORTED_ENV` naming WSL2, because Windows folds all four filesystem-policy lists
 * case-insensitively and throws on per-exec allows. A half-built branch there would be a DIVERGENT
 * boundary rather than a limited one, so there is deliberately no native-Windows evaluator.
 *
 * `run()` resolves on SPAWN with live streams plus a separate `completed` promise, never a settled
 * exit code. That split is not stylistic: one promise cannot both hand over unread child streams AND
 * carry an exit code, because settling requires the streams to have ended and they cannot end before
 * someone drains them. A caller MUST drain both concurrently — pipe buffers are per-fd, so draining
 * one to completion first can block the other and hang the child.
 *
 * @param options - Shell and policy configuration.
 * @returns An enforcer whose derived baseline is already captured.
 */
export const srtEnforcer = async (options: SrtEnforcerOptions): Promise<SandboxPolicyEnforcer> => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return unsupported()
  const binShell = validateBinShell(options.binShell)
  const bwrapPath = validateAbsoluteBinaryPath(options.bwrapPath, 'bwrapPath')
  const socatPath = validateAbsoluteBinaryPath(options.socatPath, 'socatPath')
  // Resolved ONCE: the allow-list is fixed for the enforcer's life, so re-picking per spawn would only
  // add a chance for the two to disagree. Validation throws here, at construction, so a typo'd variable
  // name is a startup error rather than a variable that silently never arrives.
  const hostEnv = resolveHostEnv(options)
  const srt = (await import('@anthropic-ai/sandbox-runtime')) as unknown as {
    SandboxManager: SrtManager
  }
  const manager = srt.SandboxManager
  // SandboxManager is process-global and first-writer-wins. Detect before initialize: an already
  // enabled manager belongs to somebody else, and initializing it (even with a different policy)
  // would leave this handle describing a sandbox that is not in force.
  // ADOPT only when the live session is somebody ELSE'S. See `selfInitialized`: upstream's flag is
  // sticky across `reset()`, so it alone would make every enforcer after the first one adopt.
  // CLAIM FIRST, CLASSIFY SECOND — and both synchronously, because the boundary is a process-global
  // with no lock to take. An earlier revision computed `adopted` from `isSandboxingEnabled()` and only
  // claimed after `initialize()` resolved, which left TWO windows for concurrent constructions:
  //   · both read `claimed === false`, both proceeded, and the second re-initialised over the first;
  //   · worse, the second saw `enabled === true` (the first had just initialised) with our marker not
  //     yet set, so it classified a session WE established as FOREIGN and adopted it — reporting the
  //     other caller's policy as though it were an adopted third-party sandbox.
  // Verified both: `Promise.all` of two enforcers resolved BOTH, the second with `adopted: true` and
  // the first's derived lists. Claiming before any await closes them together.
  const claimedByUs = selfSessionClaimed
  const alreadyLive = manager.isSandboxingEnabled()
  const adopted = alreadyLive && !selfInitialized && !claimedByUs
  if (!adopted) {
    // RESET BEFORE RE-INITIALISING OUR OWN SESSION. Upstream's `initialize()` assigns `config`
    // unconditionally, but the DERIVED getters are computed from the managerContext built during
    // initialisation — so calling it twice without a reset leaves the FIRST policy's derived lists in
    // force. Verified: init A, then init B, and `getFsReadConfig()` still reports A; reset then init C
    // reports C. Without this, a second `srtEnforcer()` in one process silently enforces the previous
    // policy while reporting the new one.
    //
    // Only ever our OWN session: `adopted` is false here, and `selfInitialized` proves we established
    // what is currently live rather than inheriting somebody else's.
    //
    // AND ONLY A RELEASED ONE. Resetting a session a live handle still holds would silently replace
    // that handle's policy with this one — first-writer-wins broken in the constructor, before the
    // manager's admission check can refuse anything. Refuse here instead, where nothing has changed
    // yet: the caller must dispose the existing handle before establishing a different policy.
    if (selfSessionClaimed) {
      throw new E_SANDBOX_POLICY_CONFLICT([
        'a sandbox session established by this process is still live; dispose that handle before ' +
          'constructing another enforcer, or reuse it — replacing it here would widen the live ' +
          'policy before admission could refuse it',
      ])
    }
    // CLAIM SYNCHRONOUSLY, BEFORE THE FIRST AWAIT. Setting this after `initialize()` leaves a window
    // in which two concurrent constructions both read `false`, both proceed, and the second silently
    // re-initialises over the first — verified: `Promise.all` of two enforcers with different policies
    // resolved BOTH, and the second reported the first's derived lists. The check and the claim must be
    // one synchronous step, because there is no lock to take: the boundary is a process-global.
    selfSessionClaimed = true
    try {
      if (selfInitialized && manager.isSandboxingEnabled()) await manager.reset()
      // THE nested-sandbox flag MUST ride this call and only this one. SRT resolves it from the
      // module-level config `initialize()` stored (`getEnableWeakerNestedSandbox()` reads
      // `config?.enableWeakerNestedSandbox`), NOT from the per-call config handed to
      // `wrapWithSandboxArgv` — so passing it only at the `run()` site below would compile, ship, and
      // silently do nothing.
      await manager.initialize(
        mapPolicy(options.policy, {
          enableWeakerNestedSandbox: options.enableWeakerNestedSandbox,
          bwrapPath,
          socatPath,
        })
      )
      selfInitialized = true
    } catch (error) {
      // A failed establishment must not leave the claim held, or the process is permanently wedged
      // with no live session to dispose.
      selfSessionClaimed = false
      throw error
    }
  }

  const platform = process.platform === 'linux' ? 'linux' : 'darwin'
  const cwd = process.cwd()
  const derive = (): DerivedRules => {
    const config = manager.getConfig()
    const filesystem = config?.filesystem ?? {}
    const network = config?.network ?? {}
    const allowGitConfig = adopted
      ? Boolean(filesystem.allowGitConfig)
      : (options.policy.filesystem.allowGitConfig ?? false)
    const searchDepth = adopted
      ? (config?.mandatoryDenySearchDepth ?? 3)
      : (options.policy.filesystem.mandatoryDenySearchDepth ?? 3)
    const dotGit = dotGitIsDirectory(cwd)
    return derivedRulesFromSrt({
      platform,
      read: manager.getFsReadConfig(),
      write: manager.getFsWriteConfig(),
      filesystemDisabled: adopted
        ? Boolean(filesystem.disabled)
        : options.policy.filesystem.disabled,
      // In adoption mode these are literal foreign lists. In particular, ['*'] is not evidence
      // that the foreign consumer used ADK's disabled mode.
      network: {
        // ADOPTION ⇒ always `false`: we did not construct this session, so "we were constructed in
        // disabled mode" cannot be true of it. OWNED ⇒ the ADK policy's own value, which is what makes
        // the drift SKIP branch and the `false → true` widening check implementable.
        disabled: adopted ? false : (options.policy.network.disabled ?? false),
        allowedDomains: adopted
          ? Array.isArray(network.allowedDomains)
            ? network.allowedDomains
            : []
          : options.policy.network.disabled
            ? undefined
            : nonEmpty(options.policy.network.allowedDomains),
        deniedDomains: adopted
          ? Array.isArray(network.deniedDomains)
            ? network.deniedDomains
            : []
          : options.policy.network.disabled
            ? []
            : nonEmpty(options.policy.network.deniedDomains),
      },
      mandatoryDeny: {
        form: platform === 'linux' ? 'expanded-paths' : 'glob',
        entries: reproduceMandatoryDeny({
          cwd,
          allowGitConfig,
          platform,
          dotGitIsDirectory: dotGit,
        }),
        allowGitConfig,
        searchDepth,
        ...(platform === 'linux' ? { dotGitWasDirectory: dotGit } : {}),
      },
    })
  }
  // CAPTURE the derived baseline immediately after our initialize, or the live foreign baseline
  // when adopting. It is deliberately derived from SRT's getters, not from the requested policy.
  const derived: DerivedRules = derive()
  // PRIME THE GLOB MATCHER with upstream's own `globToRegex` for every rule in the derived lists.
  // This is the whole reason `srtEnforcer` is async at the right moment: the evaluator is synchronous
  // (it is consulted per path) while the upstream import is not, so unless priming happens HERE the
  // synchronous fallback becomes the only path that ever runs in production — making the plan's
  // "deep-import the matcher, never port it" rule true on paper and false in fact.
  await primeGlobMatcher([
    ...derived.read.denyOnly,
    ...derived.read.allowWithinDeny,
    ...derived.write.allowOnly,
    ...derived.write.denyWithinAllow,
    ...derived.mandatoryDeny.entries,
  ])
  /**
   * PER-CALL ADMISSION plus the SRT argv wrap — the one path BOTH execution routes take.
   *
   * @remarks
   * `run()` spawns the result itself; {@link srtBinarySandbox} hands it to a `BinaryExecutor`
   * instead. Factoring it out is what keeps those two routes from drifting apart: the network
   * admission gate, the single `mapPolicy` translation, the single shell quoting step and the
   * `wrapWithSandboxArgv` call are shared, so a change to any of them lands on both.
   *
   * The network axis is refused rather than degraded: SRT's mux proxy is started once at
   * `initialize()` and filters every request against the SESSION config, so a per-call section that
   * differs from the session one — whether WIDER (a new domain) or NARROWER (a shorter allow-list,
   * an added deny) — is silently ignored at enforcement time. Both directions are refused: a
   * narrowing would also be a lie (the child runs under the session list, not the narrower one the
   * caller asked for). The per-call FILESYSTEM axis needs no such gate — its policy is baked into
   * that child's profile/argv, a real per-child grant.
   *
   * The comparison reads the LIVE session state (re-derived per call, never the cached `derived`):
   * an adopted session can be widened by a foreign `updateConfig()`, and reading the stale snapshot
   * would reject sections the session already matches.
   */
  const admitAndWrap = async (
    argv: readonly string[],
    policy: SandboxPolicy,
    signal: AbortSignal | undefined,
    workingDir: string | undefined,
    correlationId?: string
  ): Promise<{ argv: string[]; env: Record<string, string> }> => {
    const liveBaseline = derive()
    const divergence = networkDivergence(
      liveBaseline,
      policy,
      reasonMap(manager.getConfig()?.network?.deniedDomainReasons)
    )
    if (divergence.length > 0)
      throw new E_SANDBOX_NETWORK_GRANT_UNSUPPORTED([
        `the per-call policy's network section differs from the sandbox session's, which SRT ` +
          `cannot enforce for a single child (its proxy filters every request against the SESSION ` +
          `config, not the per-call one), so the child would run under the session policy while ` +
          `you believed it ran under yours. Differences: ${divergence.join('; ')}. A network ` +
          `policy is per SESSION under SRT: repeat the session's network section for per-call ` +
          `filesystem policies, or establish a new srtEnforcer + createSandbox pair with the ` +
          `network policy you need.`,
      ])
    const mapped = mapPolicy(policy)
    const command = await quoteShellArgs(argv)
    const wrapped = await manager.wrapWithSandboxArgv(
      command,
      binShell,
      mapped,
      signal,
      workingDir,
      {
        commandId: correlationId,
      }
    )
    // `env` is the HOST half only, deliberately NOT `wrapped.env`: SRT returns the unchanged host
    // environment there, so using it would defeat the allow-list wholesale (the `run()` spawn
    // documents the same trap). Callers overlay THEIR values on top of this, never beneath it.
    return { argv: wrapped.argv, env: hostEnv }
  }
  const enforcer: SandboxPolicyEnforcer & {
    /** Internal SRT bridge consumed by {@link srtBinarySandbox} — see `SrtWrapFn`. */
    wrapInvocation: SrtWrapFn
    /** The SESSION policy this enforcer established or adopted (for the wrap path's default). */
    sessionPolicy: SandboxPolicy | undefined
    /** The host-env allow-list resolved at construction (see `resolveHostEnv`). */
    hostEnv: Record<string, string>
  } = {
    isSupported: () => manager.isSupportedPlatform(),
    adopted,
    checkDependencies: async () => manager.checkDependenciesAsync(),
    run: async (op) => {
      const wrapped = await admitAndWrap(op.argv, op.policy, op.signal, op.cwd, op.correlationId)
      const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: op.cwd,
        // SRT's `wrapped.env` is the unchanged process environment, not sandbox plumbing. Merging it
        // here would defeat the allow-list by reintroducing every host variable. SRT's proxy, CA
        // bundle, and git safe-directory plumbing are encoded in `wrapped.argv` instead. The caller's
        // per-call environment remains the final overlay, by contract.
        env: { ...hostEnv, ...(op.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: true,
      })
      let terminate: (() => void) | undefined
      if (op.signal) {
        terminate = () => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }
        if (op.signal.aborted) terminate()
        else op.signal.addEventListener('abort', terminate, { once: true })
      }
      const cleanup = () => {
        if (terminate && op.signal) op.signal.removeEventListener('abort', terminate)
        terminate = undefined
      }
      const completed = new Promise<{
        exitCode: number
        failed: boolean
        signalCode?: string
      }>((settle) => {
        // 'error' MUST be handled, and not only so `completed` settles: an unhandled 'error' on a
        // ChildProcess is an uncaught exception that terminates the HOST process. A missing wrapper
        // binary or an unusable `cwd` would therefore kill the agent instead of failing one command.
        // Both listeners are `once` and the promise settles first-write-wins, so the pair is safe:
        // a spawn failure emits 'error' then 'close', and the later 'close' is discarded.
        child.once('error', () => {
          cleanup()
          // No `signalCode`: a spawn failure is not a signal kill.
          settle({ exitCode: 1, failed: true })
        })
        // `close` carries the REAL terminating signal (`signal`), which Node derives from the wait
        // status — the one source of truth for whether the child was signalled and by which signal,
        // rather than inferring it from what we asked for. The field is OMITTED on a normal exit so
        // the settlement of an exiting child stays byte-identical to its previous shape.
        child.once('close', (code, signal) => {
          cleanup()
          settle({
            exitCode: code ?? 1,
            failed: (code ?? 1) !== 0,
            ...(signal ? { signalCode: signal } : {}),
          })
        })
      })
      return {
        stdout: toWeb(child.stdout!),
        stderr: toWeb(child.stderr!),
        completed,
      }
    },
    // THE SRT-BRIDGE CAPABILITY. Not part of the `SandboxPolicyEnforcer` contract — a hidden
    // carrier field {@link srtBinarySandbox} probes for (structurally, so a duck-typed enforcer of
    // the same shape but SRT-free origin is refused, not silently misused). It shares the closure
    // state above, which is what makes the two execution routes one policy.
    wrapInvocation: admitAndWrap,
    sessionPolicy: options.policy,
    hostEnv,
    // Owned sessions are immutable from this adapter's perspective and retain the cheap cached
    // snapshot. An adopted session must re-read SRT on every call: a foreign updateConfig() can widen
    // the live sandbox between invocations, and drift() must compare against that live state.
    effectivePolicy: () => (adopted ? derive() : derived),
    diagnosticsFor: (id) =>
      manager.getSandboxViolationStore().getViolationsForCommand(id).map(String),
    dispose: async () => {
      // Adoption is reported as a no-op. Resetting here would tear down ACEs owned by the host
      // application; only the manager we initialized may be reset.
      // ADOPTION IS A REPORTED NO-OP: resetting here would tear down ACEs owned by the host
      // application. Only a session we established may be reset.
      //
      // `selfInitialized` is deliberately NOT cleared. `reset()` leaves upstream's `config` set, so
      // `isSandboxingEnabled()` stays `true` forever after the first initialise — and clearing our
      // marker would make the NEXT construction see "enabled, not ours" and adopt a dead session,
      // silently enforcing the disposed policy. Ownership is a property of this process having
      // initialised at all, not of a session still being live.
      if (!adopted && manager.isSandboxingEnabled()) {
        await manager.reset()
        // Release the claim so a later construction may establish a new session. `selfInitialized`
        // deliberately stays true: upstream's `config` survives `reset()`, so clearing it would make
        // the next construction see "enabled, not ours" and adopt a dead session.
        selfSessionClaimed = false
      }
    },
  }
  return enforcer
}

/**
 * Options for {@link srtBinarySandbox}.
 */
export type SrtBinarySandboxOptions = {
  /**
   * The per-invocation policy this wrapper applies. Defaults to the enforcer's own session policy.
   *
   * @remarks
   * This is the SAME per-call policy contract {@link SandboxPolicyEnforcer.run} takes, so it is
   * admitted identically: the FILESYSTEM section is baked into this child's profile (and replaces
   * the session baseline for it, exactly as `run()` does), while a NETWORK section that differs
   * from the live session is refused with `E_SANDBOX_NETWORK_GRANT_UNSUPPORTED`. Omitted means the
   * enforcer's established session policy, which is the only policy that can never diverge from
   * the session's network state.
   */
  policy?: SandboxPolicy
  /**
   * The DEFAULT working directory, used when the invocation carries none — the invocation's own
   * `cwd` wins. Falls back to the current process directory when neither names one.
   *
   * @remarks
   * ONE effective directory is computed from those layers and used for BOTH the SRT profile and the
   * returned invocation's `cwd`, so the profile and the spawn can never disagree. That matters
   * because SRT derives its git `safe.directory` injection and (on Linux) its mandatory-deny scan
   * from this directory: a profile generated for one directory while the executor spawns in
   * another is a sandbox that does not describe the process it is supposedly enforcing.
   */
  cwd?: string
}

/**
 * Expose an existing {@link SandboxPolicyEnforcer} as a {@link BinarySandbox} for the media
 * pipeline — the bridge between the sandbox battery and {@link sandboxedExecutor}.
 *
 * @remarks
 * DELIBERATELY DERIVED FROM {@link srtEnforcer}, NOT A SECOND SRT ADAPTER. It holds no state of its
 * own: the wrapper closes over the enforcer's single live `SandboxManager` session, its validated
 * `binShell`, its `mapPolicy` translation, its network-divergence admission gate and its host-env
 * allow-list. One process-global session, one translation point, one admission policy — the two
 * execution routes (`run()` for streaming tools, this for settled media invocations) share the
 * internal admission+wrapping step so they cannot drift.
 *
 * The wrapped invocation is what the inner executor spawns: `cmd` is the wrapper binary
 * (`bwrap`/`sandbox-exec`), `args` are the rest of the generated argv, and the caller's own argv is
 * already inside that generated command. The adapter therefore must not re-append the original args.
 *
 * THE ENVIRONMENT SPLITS IN TWO, AND ONLY ONE HALF INHERITS FROM THE HOST. The host-env allow-list is
 * what decides which HOST variables a child may inherit from `process.env`; it is the adapter's
 * decision, taken at construction. The caller's `env` is its own EXPLICIT values, applied last, and
 * may add names or override allow-listed ones. The wrap composes the two into
 * `{ ...hostEnv, ...(invocation.env ?? {}) }` and sets `extendEnv: false`, so the executor hands the
 * child EXACTLY those variables. This is load-bearing: execa's default `extendEnv: true` would merge
 * the full `process.env` back in, which would silently hand the model every host secret whenever it
 * ran `env` — the exact leak the allow-list exists to prevent. So the invariant this adapter
 * enforces is the contract's: `env` may add or override, but NOTHING from the host beyond the
 * allow-list reaches the child, and `env` is never a reason to inherit more from the host.
 *
 * REFUSES rather than degrades in the same places `run()` does: the network gate throws
 * `E_SANDBOX_NETWORK_GRANT_UNSUPPORTED` before anything runs, and an unavailable platform throws
 * `E_SANDBOX_UNSUPPORTED_ENV` (surfaced by `srtEnforcer`'s construction). After the enforcer is
 * disposed the process-global session is gone, so a wrap still generates argv but the child is
 * refused by the OS — the same honest failure mode `run()` presents. Prefer disposing the
 * executor alongside the enforcer.
 *
 * POSIX-only, like the session it wraps: there is no `process.kill(-pid, signal)` equivalent on
 * Windows, which is why `srtEnforcer` never constructs there.
 *
 * @param enforcer - The live enforcer whose session, shell, policy mapping and env allow-list this
 * wrapper reuses. Construct it with {@link srtEnforcer} and dispose it when the executor goes away.
 * @param opts - The per-invocation policy and the DEFAULT working directory (the invocation's own
 * `cwd` wins); the same directory is used for the SRT profile and for the returned invocation.
 * @returns A {@link BinarySandbox} whose `wrap` returns the sandboxed argv the inner executor runs.
 */
export const srtBinarySandbox = (
  enforcer: SandboxPolicyEnforcer,
  opts: SrtBinarySandboxOptions = {}
): BinarySandbox => ({
  async wrap(invocation) {
    // The factory can only reuse state it can actually reach. A BYO enforcer of the same interface
    // has no SRT session behind it, so wrapping through one would either do nothing (and read as
    // sandboxed) or throw somewhere unhelpful; refuse at the seam that knows the answer.
    const carrier = enforcer as SrtCarrier
    if (typeof carrier.wrapInvocation !== 'function')
      throw new E_INVALID_SANDBOX_CONFIG([
        'srtBinarySandbox requires an enforcer constructed by srtEnforcer: this adapter only ' +
          "forwards to the enforcer's own SRT session, and the supplied enforcer exposes none",
      ])
    const policyForCall = opts.policy ?? carrier.sessionPolicy
    if (!policyForCall)
      throw new E_INVALID_SANDBOX_CONFIG([
        'srtBinarySandbox requires a policy: the supplied enforcer was adopted (it holds no ' +
          'ADK policy of its own), so name the session policy explicitly in the wrap options',
      ])
    // ONE effective directory for both the SRT profile and the spawn — never two that can drift.
    // Precedence is the documented one: the invocation's own cwd wins, then this factory's default,
    // then the current process directory (what execa would spawn in with no cwd set at all).
    const cwd = invocation.cwd ?? opts.cwd ?? process.cwd()
    const wrapped = await carrier.wrapInvocation(
      [invocation.cmd, ...invocation.args],
      policyForCall,
      invocation.signal,
      cwd,
      undefined
    )
    return {
      ...invocation,
      cmd: wrapped.argv[0]!,
      args: wrapped.argv.slice(1),
      // THE SAME directory the profile was generated for: SRT's profile is derived from this and
      // the executor then spawns in it, so the two cannot disagree.
      cwd,
      // `wrapped.env` is `admitAndWrap`'s host-env allow-list (never SRT's unchanged host
      // environment); the caller's explicit values are applied last, exactly as in `run()`.
      env: { ...wrapped.env, ...(invocation.env ?? {}) },
      // The executor must not merge `process.env` back in — see the factory docs above.
      extendEnv: false,
    }
  },
})

export { mapPolicy }
