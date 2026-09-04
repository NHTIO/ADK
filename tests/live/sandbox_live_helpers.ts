import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { srtEnforcer } from '../../src/batteries/sandbox/node/srt_enforcer'
import {
  createFsNode,
  primeGlobMatcher,
  derivedRulesFromSrt,
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
} from '../../src/batteries/sandbox/node/fs_node'
import type { SandboxPolicy } from '../../src/batteries/sandbox/types'

/**
 * Whether the live sandbox suite can actually assert anything here.
 *
 * @remarks
 * `TEST_SANDBOX_LIVE=1` is the opt-in, but the flag alone is not sufficient. Every one of these
 * specs drives `@anthropic-ai/sandbox-runtime`, which shells out to `bubblewrap`, which must
 * `unshare` a user namespace. Where the host forbids that, bwrap exits before doing anything and
 * EVERY command comes back non-zero — so the suite does not measure the sandbox, it measures the
 * host's refusal, and reports it as seven assertion failures.
 *
 * That is this project's shared CI runner. Its kernel advertises the capability
 * (`max_user_namespaces` is non-zero) while its seccomp/AppArmor profile denies it, and the
 * restriction cannot be lifted from inside a job — the `dind` job's own probe has recorded
 * `No permissions to create new namespace` since 2026-08-15 (MR !9), for both the fresh-/proc and
 * bind-/proc strategies. A suite that cannot pass anywhere it runs is not a gate; it is a standing
 * red that trains everyone to ignore a red.
 *
 * So the precondition is PROBED rather than assumed, which is stricter than a second opt-in flag:
 * it arms exactly where bwrap works and skips exactly where it cannot, with no environment to keep
 * in sync. The day the runner's profile changes, this suite starts running again on its own — and
 * the `dind` job's probe still prints the namespace verdict either way, so the evidence survives
 * even while the assertions are skipped.
 *
 * Set `TEST_SANDBOX_LIVE_FORCE=1` to skip the probe and demand the suite run, which is how you
 * prove the probe itself is not lying to you.
 */
const canUnshareUserNamespace = (): boolean => {
  if (process.platform !== 'linux') return true // darwin uses Seatbelt, not bwrap
  try {
    // `bwrap --unshare-user … /bin/true` is the cheapest possible instance of the exact syscall the
    // enforcer needs. Exit 0 means the sandbox can be built; anything else means it cannot.
    const { status } = require('node:child_process').spawnSync(
      'bwrap',
      [
        '--unshare-user',
        '--unshare-all',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--ro-bind',
        '/',
        '/',
        '/bin/true',
      ],
      { stdio: 'ignore', timeout: 10_000 }
    )
    return status === 0
  } catch {
    return false // bwrap absent or unrunnable — same practical outcome
  }
}

export const RUN =
  process.env.TEST_SANDBOX_LIVE === '1' &&
  (process.env.TEST_SANDBOX_LIVE_FORCE === '1' || canUnshareUserNamespace())
export const root = resolve(process.cwd())
export const platform = process.platform === 'linux' ? 'linux' : 'darwin'

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nhtio-sandbox-live-'))
}
export async function disposeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
export async function makeFile(path: string, text = 'x'): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, text)
}

export async function makeEnforcer(policy: SandboxPolicy) {
  return srtEnforcer({ policy })
}

export async function run(
  enforcer: Awaited<ReturnType<typeof makeEnforcer>>,
  policy: SandboxPolicy,
  argv: string[],
  cwd = root
) {
  const id = `${crypto.randomUUID()}-live`
  const child = await enforcer.run({ argv, cwd, policy, correlationId: id })
  const read = async (s: ReadableStream<Uint8Array>) =>
    new TextDecoder().decode(await new Response(s).arrayBuffer())
  const [stdout, stderr, completed] = await Promise.all([
    read(child.stdout),
    read(child.stderr),
    child.completed,
  ])
  return {
    stdout,
    stderr,
    ...completed,
    diagnostics: enforcer.diagnosticsFor(id),
  }
}

/** Build the in-process view from the exact lists exposed by SRT. */
export async function nodeFor(
  _enforcer: Awaited<ReturnType<typeof makeEnforcer>>,
  policy: SandboxPolicy,
  mandatory: readonly string[] = []
) {
  // Prefer the enforcer's OWN admission snapshot — that is the shipped code path, and building a
  // parallel one would test the harness rather than the battery.
  const derived = _enforcer.effectivePolicy()
  if (derived) {
    // Compile the glob rules through upstream's matcher before the (synchronous) evaluator runs.
    await primeGlobMatcher([
      ...derived.read.denyOnly,
      ...derived.read.allowWithinDeny,
      ...derived.write.allowOnly,
      ...derived.write.denyWithinAllow,
      ...mandatory,
    ])
    // BUT the snapshot cannot carry the mandatory-deny set: SRT exposes no function for it (it is
    // injected at PROFILE GENERATION, `linuxGetMandatoryDenyPaths` is not exported, and
    // `macGetMandatoryDenyPatterns` is not re-exported from the package index), so it is OUR
    // reproduction and the caller supplies it. An earlier revision returned here and silently
    // DISCARDED the `mandatory` argument, which made every mandatory-deny assertion evaluate
    // against an empty set — `canWrite('.gitconfig')` came back `true` while the real child was
    // denied, the exact "save_media out-permits the shell" divergence this suite exists to catch.
    return createFsNode({
      ...derived,
      mandatoryDeny: {
        ...derived.mandatoryDeny,
        form: platform === 'linux' ? 'expanded-paths' : 'glob',
        entries: mandatory,
        allowGitConfig: policy.filesystem.allowGitConfig ?? false,
        searchDepth: policy.filesystem.mandatoryDenySearchDepth ?? 3,
      },
    })
  }
  // Fallback: read the initialized singleton directly (never before initialization).
  const { SandboxManager } = (await import('@anthropic-ai/sandbox-runtime')) as any
  return createFsNode(
    derivedRulesFromSrt({
      platform,
      read: SandboxManager.getFsReadConfig(),
      write: SandboxManager.getFsWriteConfig(),
      filesystemDisabled: policy.filesystem.disabled,
      mandatoryDeny: {
        form: platform === 'linux' ? 'expanded-paths' : 'glob',
        entries: mandatory,
        allowGitConfig: policy.filesystem.allowGitConfig ?? false,
        searchDepth: policy.filesystem.mandatoryDenySearchDepth ?? 3,
      },
      network: policy.network,
    })
  )
}

export function hasEffectivePolicy(enforcer: Awaited<ReturnType<typeof makeEnforcer>>): boolean {
  return enforcer.effectivePolicy() !== undefined
}

export function mandatoryNames(): string[] {
  return [...DANGEROUS_FILES, ...DANGEROUS_DIRECTORIES]
}
export function mandatoryFor(cwd: string, policy: SandboxPolicy): string[] {
  const names = mandatoryNames()
  // FORM DIFFERS BY PLATFORM, and getting it wrong makes the agreement test assert against a deny
  // set the real profile never installed:
  //  · macOS ships GLOBS the seatbelt profile matches natively — the cwd-resolved entry plus a
  //    `**/<name>` subtree pattern, which matches at ANY depth.
  //  · Linux ships CONCRETE PATHS discovered by a bounded `rg` scan
  //    (`linuxGetMandatoryDenyPaths` pushes `absolutePath`, never a bare name — verified in
  //    `linux-sandbox-utils.js:240-267`). A BARE `.bashrc` entry is therefore a FABRICATION: our
  //    evaluator treats it as an any-depth suffix match, which is stricter than the profile and
  //    contradicts the depth-bound the same suite asserts.
  // So on Linux the caller must supply the paths that actually EXIST, and the depth bound is a
  // property of what the scan found rather than of the rule form.
  const entries = names.flatMap((name) =>
    platform === 'linux' ? [join(cwd, name)] : [join(cwd, name), `**/${name}`]
  )
  if (platform === 'darwin' || policy.filesystem.allowGitConfig === false)
    entries.push(
      join(cwd, '.git/hooks'),
      join(cwd, '.git/config'),
      ...(platform === 'darwin' ? ['**/.git/hooks/**', '**/.git/config'] : [])
    )
  return entries
}
