/**
 * Doc-coverage audit for the public API surface.
 *
 * Bootstraps TypeDoc read-only (`emit: 'none'`) over the same `@module` entrypoints the published
 * docs use (via {@link getEntries}), runs the `notDocumented` validation step, and reports every
 * public symbol/member that lacks a TSDoc comment — grouped by the submodule TypeDoc documents it
 * under (the deepest `@module` that exposes it, honouring `@primaryExport`).
 *
 * It also audits `@primaryExport` placement: for symbols re-exported by 2+ submodules, the tag must
 * sit on the most-specific (longest-path) submodule.
 *
 * Modes:
 *   (default)  human-readable report grouped by submodule, with raw + distinct-declaration counts.
 *   --json     machine-readable JSON of the findings.
 *   --ci       exit non-zero if any non-allowlisted undocumented symbol remains (zero-tolerance).
 *   --hook     always exit 0; print a Claude Code `hookSpecificOutput.additionalContext` envelope.
 *
 * Run: `npx jiti bin/doc_coverage.ts [--json|--ci|--hook]`
 */

import * as td from 'typedoc'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import { getEntries, BLOCK_TAGS } from './utils/index'

const LIB_NAME = '@nhtio/adk'
const cwd = resolve(__dirname, '..')

/**
 * Reflection kinds we require documentation on — author-written declarations only. Inherited
 * intrinsics and anonymous inline `__type` members are filtered separately (see `isActionable`).
 */
const REQUIRED_KINDS: td.ReflectionKind.KindString[] = [
  'Class',
  'Function',
  'Variable',
  'TypeAlias',
  'Interface',
  'Enum',
  'EnumMember',
  'Method',
  'Property',
  'Accessor',
]

/** Member leaf-names that are inherited/intrinsic and never authored by us. */
const INTRINSIC_MEMBERS = new Set(['toJSON', 'valueOf', 'toString', 'toLocaleString'])

/**
 * Full reflection names that are intentionally exempt from the doc-coverage requirement. TypeDoc
 * consumes this natively via `intentionallyNotDocumented`; keep it small and justified.
 */
const INTENTIONALLY_NOT_DOCUMENTED: string[] = []

interface Finding {
  qualifiedName: string
  submodule: string
  kind: string
  file: string
  line: number
}

/** Parse one TypeDoc notDocumented warning line into a structured finding. */
const parseWarning = (msg: string): Finding | null => {
  // Shape: "<qualified.name> (<Kind>), defined in <file>:<line>, does not have any documentation"
  // (the file may or may not carry a :line suffix depending on TypeDoc version)
  const m = /^(.+?) \((\w+)\), defined in (.+?)(?::(\d+))?, does not have any documentation/.exec(
    msg
  )
  if (!m) return null
  const qualifiedName = m[1]
  const submodule = qualifiedName.split('.')[0]
  return {
    qualifiedName,
    submodule,
    kind: m[2],
    file: m[3],
    line: m[4] ? Number(m[4]) : 0,
  }
}

/** Author-written, in-`src/`, non-intrinsic — the actionable surface. */
const isActionable = (f: Finding): boolean => {
  if (!f.file.includes('/src/')) return false
  if (f.qualifiedName.includes('__type')) return false
  const leaf = f.qualifiedName.split('.').pop() ?? ''
  if (INTRINSIC_MEMBERS.has(leaf)) return false
  return true
}

const buildApp = async (): Promise<{ app: td.Application; entries: Record<string, string> }> => {
  const entries = await getEntries(join(cwd, 'src'), LIB_NAME)
  const app = await td.Application.bootstrapWithPlugins(
    {
      entryPoints: Object.values(entries),
      emit: 'none',
      skipErrorChecking: true,
      excludeExternals: true,
      excludePrivate: true,
      excludeProtected: true,
      readme: 'none',
      name: LIB_NAME,
      blockTags: BLOCK_TAGS,
      validation: { notDocumented: true, invalidLink: false, notExported: false },
      requiredToBeDocumented: REQUIRED_KINDS,
      intentionallyNotDocumented: INTENTIONALLY_NOT_DOCUMENTED,
      logLevel: 'Error',
    },
    [new td.TSConfigReader()]
  )
  return { app, entries }
}

/** Collect the notDocumented findings by intercepting the validator's warnings. */
const collectFindings = async (): Promise<Finding[]> => {
  const { app } = await buildApp()
  const findings: Finding[] = []
  const logger = app.logger as unknown as { warn: (msg: string) => void }
  const originalWarn = logger.warn.bind(logger)
  logger.warn = (msg: string) => {
    if (typeof msg === 'string' && msg.includes('does not have any documentation')) {
      const f = parseWarning(msg)
      if (f && isActionable(f)) findings.push(f)
      return
    }
    originalWarn(msg)
  }
  const project = await app.convert()
  if (project) app.validate(project)
  logger.warn = originalWarn
  return findings.sort(
    (a, b) =>
      a.submodule.localeCompare(b.submodule) || a.qualifiedName.localeCompare(b.qualifiedName)
  )
}

/** Group findings by submodule. */
const groupBySubmodule = (findings: Finding[]): Map<string, Finding[]> => {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    const arr = groups.get(f.submodule) ?? []
    arr.push(f)
    groups.set(f.submodule, arr)
  }
  return groups
}

/**
 * Distinct hand-written declarations (collapsing members onto their owning top-level symbol so the
 * count reflects "places a human writes a comment", not raw reflections — many of which are
 * signatures mirroring a parent).
 */
const distinctDeclarations = (findings: Finding[]): number => {
  const owners = new Set(findings.map((f) => f.qualifiedName.split('.').slice(0, 2).join('.')))
  return owners.size
}

/**
 * `@primaryExport` placement audit. For every symbol exposed by ≥2 submodules, TypeDoc converts the
 * primary declaration under exactly one submodule (driven by `@primaryExport`) and records the rest
 * as references (re-exports). The placement rule is: the primary must sit on the DEEPEST (longest
 * `@module` path) submodule that exposes the symbol. This walks the reflection graph and flags any
 * symbol whose primary submodule is shallower than a submodule that merely references it.
 */
interface PlacementIssue {
  name: string
  primarySubmodule: string
  deeperSubmodules: string[]
}

const auditPrimaryExport = async (): Promise<PlacementIssue[]> => {
  const { app } = await buildApp()
  const project = await app.convert()
  if (!project) return []

  // symbol name -> { primary: submodule|null, references: submodule[] }
  const seen = new Map<string, { primary: string | null; references: string[] }>()
  const visit = (reflection: td.Reflection, moduleName: string) => {
    const mod = reflection.kindOf(td.ReflectionKind.Module) ? reflection.name : moduleName
    const children = reflection instanceof td.ContainerReflection ? (reflection.children ?? []) : []
    for (const child of children) {
      if (
        child.kindOf(
          td.ReflectionKind.Class |
            td.ReflectionKind.Interface |
            td.ReflectionKind.TypeAlias |
            td.ReflectionKind.Function |
            td.ReflectionKind.Variable |
            td.ReflectionKind.Enum
        )
      ) {
        const entry = seen.get(child.name) ?? { primary: null, references: [] }
        if (child instanceof td.ReferenceReflection) entry.references.push(mod)
        else entry.primary = mod
        seen.set(child.name, entry)
      }
      visit(child, mod)
    }
  }
  visit(project, LIB_NAME)

  // "deeper" = more path segments in the @module name (e.g. .../spooled_artifact deeper than common)
  const depth = (sub: string): number => sub.split('/').length
  const issues: PlacementIssue[] = []
  for (const [name, { primary, references }] of seen) {
    if (!primary) continue
    const deeper = references.filter((r) => depth(r) > depth(primary))
    if (deeper.length > 0) {
      issues.push({
        name,
        primarySubmodule: primary,
        deeperSubmodules: [...new Set(deeper)].sort(),
      })
    }
  }
  return issues.sort((a, b) => a.name.localeCompare(b.name))
}

const run = async () => {
  if (process.argv.includes('--primary')) {
    const issues = await auditPrimaryExport()
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ placementIssues: issues }, null, 2) + '\n')
    } else {
      process.stdout.write(`@primaryExport placement audit — ${LIB_NAME}\n\n`)
      if (issues.length === 0) {
        process.stdout.write(
          'No placement issues: every symbol is primary at its deepest submodule.\n'
        )
      } else {
        process.stdout.write(
          `${issues.length} symbol(s) whose @primaryExport is NOT on the deepest submodule:\n\n`
        )
        for (const i of issues) {
          process.stdout.write(
            `  ${i.name}: primary at ${i.primarySubmodule}, but also re-exported (deeper) from ${i.deeperSubmodules.join(', ')}\n`
          )
        }
      }
    }
    if (process.argv.includes('--ci') && issues.length > 0) process.exit(1)
    return
  }

  const mode = process.argv.includes('--json')
    ? 'json'
    : process.argv.includes('--hook')
      ? 'hook'
      : process.argv.includes('--ci')
        ? 'ci'
        : 'human'

  // Hook mode fires after EVERY turn (Stop event). Before paying the ~3s TypeDoc bootstrap, skip
  // silently unless this turn plausibly touched the public source (uncommitted changes under src/).
  if (mode === 'hook') {
    try {
      const changed = execSync('git status --porcelain -- src/', { cwd, encoding: 'utf8' }).trim()
      if (!changed) process.exit(0)
    } catch {
      // not a git checkout / git unavailable — fall through and report
    }
  }

  const findings = await collectFindings()
  const groups = groupBySubmodule(findings)
  const distinct = distinctDeclarations(findings)

  if (mode === 'json') {
    process.stdout.write(
      JSON.stringify({ total: findings.length, distinct, findings }, null, 2) + '\n'
    )
    return
  }

  if (mode === 'hook') {
    if (findings.length === 0) {
      process.exit(0)
    }
    const lines = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([sub, fs]) => `  ${sub} (${fs.length})`)
      .join('\n')
    const context = [
      `Doc-coverage check: ${findings.length} public reflection(s) across ${groups.size} submodule(s) lack a TSDoc comment`,
      `(~${distinct} distinct declarations). Heaviest submodules:`,
      lines,
      '',
      'Run `pnpm doc:coverage` for the full per-symbol list. Add TSDoc comments to public API',
      'symbols you touched; the canonical home for a symbol is its deepest @module submodule.',
    ].join('\n')
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context },
      }) + '\n'
    )
    process.exit(0)
  }

  // human + ci share the report; ci additionally sets the exit code.
  const out: string[] = []
  out.push(`Doc-coverage audit — ${LIB_NAME}`)
  out.push('')
  out.push(
    `Undocumented public reflections: ${findings.length}  (≈${distinct} distinct declarations) across ${groups.size} submodules`
  )
  out.push('')
  for (const [sub, fs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`${sub}  (${fs.length})`)
    for (const f of fs) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file
      out.push(`  - ${f.qualifiedName}  [${f.kind}]  ${loc}`)
    }
    out.push('')
  }
  process.stdout.write(out.join('\n') + '\n')

  if (mode === 'ci' && findings.length > 0) {
    process.stderr.write(
      `\nFAIL: ${findings.length} undocumented public reflection(s). ` +
        `Document them or add to INTENTIONALLY_NOT_DOCUMENTED in bin/doc_coverage.ts.\n`
    )
    process.exit(1)
  }
}

run().catch((err: unknown) => {
  // eslint-disable-next-line adk/prefer-is-error -- bin/ tooling; avoid importing src/ runtime guards into a build script
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`doc_coverage error: ${message}\n`)
  process.exit(1)
})
