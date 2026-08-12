import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { quoteShellArgs, validateBinShell } from '../escape'
import { derivedRulesFromSrt, primeGlobMatcher, reproduceMandatoryDeny } from './fs_node'
import {
  E_INVALID_SANDBOX_CONFIG,
  E_SANDBOX_UNSUPPORTED_ENV,
  E_SANDBOX_POLICY_CONFLICT,
} from '../exceptions'
import type { SandboxPolicy, DerivedRules } from '../types'
import type { SandboxPolicyEnforcer } from '../contracts/policy_enforcer'

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
  getNetworkRestrictionConfig(): { allowedHosts?: string[]; deniedHosts?: string[] }
  getConfig(): SrtConfig | undefined
  getSandboxViolationStore(): { getViolationsForCommand(command: string): unknown[] }
  reset(): Promise<void>
}
type SrtConfig = {
  filesystem: Record<string, unknown>
  network: Record<string, unknown>
  /** SRT's Linux mandatory-deny scan depth is session-level. */
  mandatoryDenySearchDepth?: number
  git?: { safeDirectories: string[] }
}

const unsupported = (): never => {
  throw new E_SANDBOX_UNSUPPORTED_ENV([
    `SRT sandbox is unavailable on ${process.platform}; use WSL2 or the SES browser path`,
  ])
}
const nonEmpty = (v: readonly string[] | undefined): string[] => [...(v ?? [])]

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

/** The sole ADK-to-SRT translation point. Keep the upstream type behind this local firewall. */
const mapPolicy = (policy: SandboxPolicy): SrtConfig => {
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
    filesystem: {
      ...(fs.disabled ? { disabled: true } : {}),
      denyRead: nonEmpty(fs.denyRead),
      allowRead: nonEmpty(fs.allowRead),
      allowWrite: nonEmpty(fs.allowWrite),
      denyWrite: nonEmpty(fs.denyWrite),
      allowGitConfig: fs.allowGitConfig ?? false,
    },
    network: {
      allowedDomains,
      deniedDomains,
      deniedDomainReasons,
      strictAllowlist: true,
      allowLocalBinding: false,
      allowUnixSockets: [],
      allowMachLookup: [],
    },
    git: { safeDirectories: nonEmpty(fs.gitSafeDirectories ?? [process.cwd()]) },
  }
}

const toWeb = (stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> =>
  (ReadableStream as unknown as { from?: (x: unknown) => ReadableStream<Uint8Array> }).from
    ? (ReadableStream as unknown as { from: (x: unknown) => ReadableStream<Uint8Array> }).from(
        stream
      )
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
      await manager.initialize(mapPolicy(options.policy))
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
            ? ['*']
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
  const enforcer: SandboxPolicyEnforcer = {
    isSupported: () => manager.isSupportedPlatform(),
    adopted,
    checkDependencies: async () => manager.checkDependenciesAsync(),
    run: async (op) => {
      const mapped = mapPolicy(op.policy)
      const command = await quoteShellArgs(op.argv)
      const wrapped = await manager.wrapWithSandboxArgv(
        command,
        binShell,
        mapped,
        op.signal,
        op.cwd,
        { commandId: op.correlationId }
      )
      const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
        cwd: op.cwd,
        env: { ...process.env, ...wrapped.env, ...(op.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
      const completed = new Promise<{ exitCode: number; failed: boolean }>((settle) => {
        // 'error' MUST be handled, and not only so `completed` settles: an unhandled 'error' on a
        // ChildProcess is an uncaught exception that terminates the HOST process. A missing wrapper
        // binary or an unusable `cwd` would therefore kill the agent instead of failing one command.
        // Both listeners are `once` and the promise settles first-write-wins, so the pair is safe:
        // a spawn failure emits 'error' then 'close', and the later 'close' is discarded.
        child.once('error', () => settle({ exitCode: 1, failed: true }))
        child.once('close', (code) => settle({ exitCode: code ?? 1, failed: (code ?? 1) !== 0 }))
      })
      return { stdout: toWeb(child.stdout!), stderr: toWeb(child.stderr!), completed }
    },
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

export { mapPolicy }
