import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { DerivedRules } from '../types'

/**
 * Load upstream's own glob matcher.
 *
 * @remarks
 * Deep-imported rather than ported, so this evaluator CANNOT drift from the profile SRT actually
 * generates — a hand-copied `globToRegex` would make parity a maintenance promise instead of a
 * property. The specifier is deliberately PACKAGE-RELATIVE and resolved through the optional peer,
 * matching `escape.ts`'s deep import of `quote()`: an absolute path would resolve only on the
 * machine that wrote it and would fail at runtime for every consumer of the published package.
 *
 * The module is safe to reach into — `sandbox-utils.js` imports only `os`/`path`/`fs`, so this
 * cannot pull upstream's bundled zod into a repo that has never depended on it.
 *
 * @returns Upstream's `globToRegex`.
 */
export const loadGlobToRegex = async (): Promise<(glob: string) => string> => {
  const moduleName = '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'
  const mod = (await import(moduleName)) as {
    globToRegex: (glob: string) => string
  }
  return mod.globToRegex
}

/**
 * The in-process policy decision procedure.
 *
 * @remarks
 * BESPOKE POLICY CODE, not a thin wrapper: SRT exports rule LISTS
 * (`getFsReadConfig()`/`getFsWriteConfig()`) but **no authorization predicate**, so the decision is
 * ours to make and ours to get wrong. It backs the tools that run OUR code — `open_file*`,
 * `stage_file`, `save_media`, `list_directory` — where there is no untrusted binary between the check
 * and the `open()`, so applying the same derived rules in-process is the same path without a
 * subprocess rather than a weaker one.
 *
 * The residuals are real and unmitigated: a TOCTOU race between check and open, and any bug in this
 * evaluator. There is no OS backstop on this path — SRT restricts spawned children only. The
 * compensating controls are the mandatory gate and a narrow `writeRoot`.
 */
export type FsNode = {
  /** Whether a read of `path` is permitted. Reads default to ALLOW; `allowRead` wins inside `denyRead`. */
  canRead(path: string): boolean
  /** Whether a write to `path` is permitted. Writes default to DENY; `denyWrite` wins inside `allowWrite`, and the mandatory-deny set applies on top. */
  canWrite(path: string): boolean
}

const under = (path: string, rule: string): boolean =>
  rule === '/' ? path.startsWith('/') : path === rule || path.startsWith(`${rule}/`)
/**
 * Compiled-glob cache, keyed by the raw rule.
 *
 * @remarks
 * `canRead`/`canWrite` are synchronous and run per path, so upstream's matcher is compiled once per
 * rule by {@link primeGlobMatcher} and read from here. A rule whose regex does not COMPILE is stored
 * as `null` and fails closed — that is `undecidableGlobs`' real producer (`[z-a]` → *"Range out of
 * order in character class"*).
 */
const globCache = new Map<string, RegExp | null>()

/**
 * Compile every glob-bearing rule through upstream's own `globToRegex`.
 *
 * @remarks
 * MUST be awaited before the evaluator is consulted, because the deep import is async while the
 * evaluator is not. {@link srtEnforcer} does this for every rule in the derived lists immediately
 * after capturing them — NOT {@link createFsNode}, which is synchronous and therefore cannot. An
 * earlier comment here named `createFsNode`, which was simply false: nothing primed, so the
 * synchronous fallback was the only path production ever took.
 *
 * @param rules - Raw rule strings from the derived lists.
 */
export const primeGlobMatcher = async (rules: Iterable<string>): Promise<void> => {
  const globToRegex = await loadGlobToRegex()
  for (const rule of rules) {
    if (!containsGlobChars(rule) || globCache.has(rule)) continue
    try {
      globCache.set(rule, new RegExp(globToRegex(rule)))
    } catch {
      globCache.set(rule, null)
    }
  }
}

/**
 * Synchronous fallback translation, used only when a rule was never primed.
 *
 * @remarks
 * REPLICATES UPSTREAM'S REPLACEMENT ORDER, WHICH IS THE WHOLE DIFFICULTY. The order is
 * load-bearing: escape the regex specials, then substitute the `**` + separator form via a
 * PLACEHOLDER, then bare `**`, then `*`, then `?`, and only then restore the placeholders. Expanding
 * bare `**` first is what broke the previous implementation — the subtree form then requires a
 * separator and stops matching zero directories, silently disabling every subtree deny.
 *
 * This exists so an unprimed rule is evaluated CORRECTLY rather than failing closed on a legitimate
 * path: `createFsNode` is synchronous by contract (it is consulted per path) while the upstream
 * import is async, so a caller that has not primed would otherwise get a boundary that refuses
 * everything glob-shaped. {@link primeGlobMatcher} remains preferred — it uses upstream's own
 * function, so it cannot drift at all — and the parity test pins the two against each other.
 *
 * @param rule - A glob-bearing rule.
 * @returns The compiled pattern, or `null` when the pattern does not compile.
 */
const compileGlobFallback = (rule: string): RegExp | null => {
  // Placeholders are chosen to be un-forgeable rather than merely unlikely. NUL cannot appear in a
  // POSIX path, and a NUL-bearing rule is refused outright below rather than trusted. Built via
  // fromCharCode so this source file holds no raw control characters.
  //
  // ONE DELIBERATE DIVERGENCE FROM UPSTREAM, and it is upstream's bug rather than a parity gap we
  // can close: `globToRegex` uses PRINTABLE sentinels (`__GLOBSTAR__`), so a rule whose literal text
  // contains one collides — verified, `globToRegex('__GLOBSTAR__')` returns `^.*$`, a rule that
  // matches EVERY path. Reproducing that would mean turning a narrow rule into an allow-everything
  // (or deny-everything) pattern, so this fallback matches such a rule literally instead. The
  // divergence is unreachable in practice: these sentinels do not appear in SRT's own derived lists
  // or in the mandatory-deny set, so it can only surface for a hand-written policy entry containing
  // that exact text. Stated rather than hidden, because the agreement test's whole premise is that
  // the two evaluators agree.
  const nul = String.fromCharCode(0)
  if (rule.includes(nul)) return null
  const DOUBLE_SEP = `${nul}S${nul}`
  const DOUBLE = `${nul}D${nul}`
  try {
    const source = rule
      // Upstream's exact escape set — NOT a superset. It deliberately leaves `* ? [ ]` alone (they
      // are glob syntax) and does NOT escape `-`; escaping more here would make a literal `-` in a
      // character class behave differently from the profile.
      .replace(/[.^$+{}()|\\]/g, '\\$&')
      // Escape an UNCLOSED `[` so it matches literally, exactly as upstream does. Without this a
      // rule like `/x/[` compiles upstream (to a literal match) but throws here, and the polarity
      // fail-closed would then deny a path the real profile permits — stricter than the sandbox,
      // which the agreement test correctly rejects.
      .replace(/\[([^\]]*?)$/g, '\\[$1')
      .split('**/')
      .join(DOUBLE_SEP)
      .split('**')
      .join(DOUBLE)
      .split('*')
      .join('[^/]*')
      .split('?')
      .join('[^/]')
      .split(DOUBLE_SEP)
      .join('(?:.*/)?')
      .split(DOUBLE)
      .join('.*')
    return new RegExp(`^${source}$`)
  } catch {
    return null
  }
}

const containsGlobChars = (rule: string): boolean =>
  rule.includes('*') || rule.includes('?') || rule.includes('[') || rule.includes(']')

/**
 * Match one path against one rule.
 *
 * @remarks
 * A literal rule is a prefix match. A glob rule is matched by UPSTREAM'S OWN compiled pattern,
 * never by a local translation. A hand-rolled port was wrong in a way that silently disabled the
 * subtree denies entirely: it expanded the double-star before the double-star-slash form, which
 * produced a pattern requiring exactly one intermediate segment and therefore matched NOTHING,
 * where upstream's equivalent makes the directory prefix optional and matches at any depth. That is
 * the replacement-ORDER trap the plan documents, and it is why the rule is to deep-import the
 * matcher rather than reimplement it: a port makes parity a promise, an import makes it a property.
 * An uncompilable rule fails CLOSED - a rule we cannot evaluate is one we must refuse to permit
 * around.
 *
 * FAIL-CLOSED IS NOT ONE VALUE — IT DEPENDS ON THE AXIS, and a blanket answer is wrong half the
 * time. On a RESTRICTIVE list (`denyOnly`, `denyWithinAllow`, `mandatoryDeny`) an unusable rule must
 * count as MATCHING, so the path is refused. On a PERMISSIVE list (`allowWithinDeny`, `allowOnly`)
 * the same `true` would GRANT access on a rule we cannot evaluate — fail-open, the inverse of the
 * intent — so it must count as NOT matching. Hence the explicit `polarity`.
 *
 * @param path - Canonicalised absolute path.
 * @param rule - A literal prefix or a glob from the derived lists.
 * @param polarity - Which direction an unusable rule must fail in.
 * @returns `true` when the rule covers the path.
 */
const matches = (path: string, rule: string, polarity: RuleListPolarity): boolean => {
  if (!containsGlobChars(rule)) return under(path, rule)
  let compiled = globCache.get(rule)
  if (compiled === undefined) {
    // Never primed: translate synchronously, preserving upstream's replacement ORDER, and memoise.
    compiled = compileGlobFallback(rule)
    globCache.set(rule, compiled)
  }
  // Uncompilable (e.g. the out-of-order class `[z-a]`): refuse on a deny list, do not grant on an
  // allow list. A rule we cannot evaluate is one we must refuse to permit around.
  if (compiled === null) return polarity === 'restrictive'
  return compiled.test(path)
}

/** Which way an unevaluable rule must fail. See {@link matches}. */
type RuleListPolarity = 'restrictive' | 'permissive'
const listMatch = (path: string, rules: readonly string[], polarity: RuleListPolarity): boolean =>
  rules.some((rule) => matches(path, rule, polarity))

/** In-process counterpart of SRT's two derived restriction lists. */
export const createFsNode = (rules: DerivedRules): FsNode => {
  const canonical = (value: string): string => {
    try {
      return realpathSync(resolve(value)).replaceAll('\\', '/')
    } catch {
      return resolve(value).replaceAll('\\', '/')
    }
  }
  const mandatory = (path: string): boolean => {
    if (rules.filesystemDisabled) return false
    if (rules.mandatoryDeny.form === 'glob')
      return listMatch(path, rules.mandatoryDeny.entries, 'restrictive')
    return rules.mandatoryDeny.entries.some((entry) => {
      const lowerEntry = entry.toLowerCase()
      if (DANGEROUS_FILES.some((file) => file === lowerEntry))
        return path.toLowerCase().endsWith(`/${lowerEntry}`) || path.toLowerCase() === lowerEntry
      if (lowerEntry === '.git/hooks' || lowerEntry === '.git/config') {
        const suffix = entry
        return path.includes(`/${suffix}/`) || path.endsWith(`/${suffix}`)
      }
      const foldedPath = path.toLowerCase()
      return under(foldedPath, lowerEntry)
    })
  }
  return {
    canRead: (raw) => {
      if (rules.filesystemDisabled) return true
      const path = canonical(raw)
      return (
        !listMatch(path, rules.read.denyOnly, 'restrictive') ||
        listMatch(path, rules.read.allowWithinDeny, 'permissive')
      )
    },
    canWrite: (raw) => {
      if (rules.filesystemDisabled) return true
      const path = canonical(raw)
      if (
        !listMatch(path, rules.write.allowOnly, 'permissive') ||
        listMatch(path, rules.write.denyWithinAllow, 'restrictive')
      )
        return false
      return !mandatory(path)
    },
  }
}

/** Construct a derived snapshot from the shapes returned by SRT. */
export const derivedRulesFromSrt = (input: {
  platform: 'darwin' | 'linux'
  read: { denyOnly: readonly string[]; allowWithinDeny?: readonly string[] }
  write: { allowOnly: readonly string[]; denyWithinAllow: readonly string[] }
  filesystemDisabled?: boolean
  network?: {
    /** OURS, not upstream's: `true` only when WE constructed the session in disabled mode. */
    disabled?: boolean
    allowedDomains?: readonly string[]
    deniedDomains?: readonly string[]
  }
  mandatoryDeny?: {
    form: 'glob' | 'expanded-paths'
    entries: readonly string[]
    allowGitConfig: boolean
    searchDepth: number
    dotGitWasDirectory?: boolean
  }
}): DerivedRules => ({
  matcher: {
    platform: input.platform,
    caseInsensitive: input.platform === 'linux',
    readGlobs: input.platform === 'linux' ? 'expanded' : 'native',
    writeGlobs: input.platform === 'linux' ? 'dropped' : 'native',
  },
  read: {
    denyOnly: [...input.read.denyOnly],
    allowWithinDeny: [...(input.read.allowWithinDeny ?? [])],
  },
  write: {
    allowOnly: [...input.write.allowOnly],
    denyWithinAllow: [...input.write.denyWithinAllow],
  },
  mandatoryDeny: input.mandatoryDeny ?? {
    form: input.platform === 'linux' ? 'expanded-paths' : 'glob',
    entries: [],
    allowGitConfig: false,
    searchDepth: 3,
  },
  filesystemDisabled: input.filesystemDisabled ?? false,
  network: {
    // PROVENANCE IS PER MODE, and this field must NOT be hardcoded. It is OURS — upstream has no such
    // flag — and it records *"we were constructed in disabled mode"*:
    //   · WE INITIALIZED ⇒ the constructing ADK policy's value. Pinning it to `false` here silently
    //     disables the drift SKIP branch, so a handle built in disabled mode would have its domain
    //     axes compared against `['*']` instead of being skipped-and-logged.
    //   · WE ADOPTED ⇒ always `false`, because we were not constructed at all. The caller passes
    //     `false` explicitly in that mode; a foreign `['*']` is an ordinary allow-everything list.
    disabled: input.network?.disabled ?? false,
    allowedDomains: [...(input.network?.allowedDomains ?? [])],
    deniedDomains: [...(input.network?.deniedDomains ?? [])],
    strictAllowlist: true,
  },
  unknownKeys: [],
  undecidableGlobs: [],
})

/** The exact upstream dangerous file names, retained for parity tests. */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
] as const
/**
 * Directories SRT mandatory-denies, reproduced from upstream.
 *
 * @remarks
 * `.git` is deliberately ABSENT: upstream filters it out of its own list and handles it separately,
 * because the rules differ per platform and per `.git` being a directory rather than a worktree file.
 * Reproducing it here would deny what the profile permits.
 */
export const DANGEROUS_DIRECTORIES = [
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
] as const

/**
 * Reproduce SRT's profile-injected mandatory-deny set for the CURRENT platform.
 *
 * @remarks
 * THIS IS OUR REPRODUCTION, NOT SRT'S OUTPUT, and the distinction bounds what any check built on it
 * can prove. SRT exposes no function for this set: it is injected at PROFILE GENERATION,
 * `linuxGetMandatoryDenyPaths` is a non-exported local, and `macGetMandatoryDenyPatterns` is not
 * re-exported from the package index. So the entries are re-derived here with the same lists upstream
 * uses — which is why the constant-parity test diffs those lists directly, and why a drift check over
 * this axis proves only "our inputs did not change", never "our reproduction still matches SRT".
 *
 * Without it the in-process evaluator has NO mandatory denies at all, and `save_media` writes
 * `.bashrc` or `.mcp.json` where the spawned shell is refused — the "one boundary, two answers"
 * failure this reproduction exists to prevent.
 *
 * FORM DIFFERS BY PLATFORM and the two are not comparable:
 *  · macOS emits GLOBS the seatbelt profile matches natively — each name resolved against the cwd
 *    plus a the subtree form subtree pattern, so it matches at any depth.
 *  · Linux emits CONCRETE PATHS from a bounded `rg` scan, so it is point-in-time and depth-limited;
 *    a file created afterwards, or nested deeper than `mandatoryDenySearchDepth`, is NOT covered
 *    there. We reproduce the cwd-rooted entries; the scan's discoveries are the profile's own.
 *
 * `.git/hooks` and `.git/config` are PLATFORM-CONDITIONAL: macOS pushes `hooks` unconditionally and
 * `config` unless `allowGitConfig`, while Linux pushes neither for the workspace root unless `.git`
 * is a real DIRECTORY (in a worktree it is a file, and denying it would break bwrap).
 *
 * @param options - The cwd the profile was built against, and the inputs that change the set.
 * @returns The reproduced entries, in the platform's own form.
 */
export const reproduceMandatoryDeny = (options: {
  cwd: string
  allowGitConfig: boolean
  platform?: 'darwin' | 'linux'
  dotGitIsDirectory?: boolean
}): string[] => {
  const platform = options.platform ?? (process.platform === 'linux' ? 'linux' : 'darwin')
  const entries: string[] = []
  // FILES: the cwd-resolved path, plus a bare a subtree subtree glob on macOS.
  for (const name of DANGEROUS_FILES) {
    entries.push(resolve(options.cwd, name))
    if (platform === 'darwin') entries.push(`**/${name}`)
  }
  // DIRECTORIES: upstream's subtree glob ends in `/**` — the directory's CONTENTS, not the directory
  // name. Emitting a bare `**/.vscode` (as an earlier revision did) fails to cover anything inside it
  // while adding an entry upstream never had, so the reproduction was both over- and under-inclusive.
  for (const name of DANGEROUS_DIRECTORIES) {
    entries.push(resolve(options.cwd, name))
    if (platform === 'darwin') entries.push(`**/${name}/**`)
  }
  // `.git/hooks` is denied unconditionally; `.git/config` only when `allowGitConfig` is false. Their
  // subtree forms DIFFER, verified against upstream: hooks takes `/**` (a directory of scripts),
  // config does not (a single file).
  const gitEntries: Array<[string, boolean]> = [
    ['.git/hooks', true],
    ['.git/config', false],
  ]
  for (const [suffix, isDirectory] of gitEntries) {
    if (suffix === '.git/config' && options.allowGitConfig) continue
    // On Linux the workspace-ROOT entry exists only when `.git` is a real directory: in a worktree it
    // is a FILE, and denying it would make bubblewrap fail.
    if (platform === 'darwin' || options.dotGitIsDirectory === true)
      entries.push(resolve(options.cwd, suffix))
    if (platform === 'darwin') entries.push(isDirectory ? `**/${suffix}/**` : `**/${suffix}`)
  }
  return entries
}
